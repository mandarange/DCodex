/**
 * Retrieval, cost and latency math for the benchmark.
 *
 * Every metric is computed from set membership against a gold set that ships in
 * the locked corpus, so a score can never be improved by rewording an answer —
 * only by returning the right paths, gates, tests and conflicts.
 */
import type {
  ContextGraphBenchmarkAdapterKind,
  ContextGraphBenchmarkAdapterSummary,
  ContextGraphBenchmarkCase,
  ContextGraphBenchmarkCaseMetrics,
  ContextGraphBenchmarkConflict,
  ContextGraphBenchmarkLatency,
  ContextGraphBenchmarkRun
} from './types.js';

export const EMPTY_LATENCY: ContextGraphBenchmarkLatency = { samples: 0, p50: 0, p95: 0, min: 0, max: 0 };

export function uniqueOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function intersectionCount(gold: readonly string[], candidate: readonly string[]): number {
  if (!gold.length) return 0;
  const pool = new Set(candidate);
  let hits = 0;
  for (const item of new Set(gold)) if (pool.has(item)) hits += 1;
  return hits;
}

/** Fraction of the gold set present in the top `k` ranked results. Empty gold scores 1. */
export function recallAtK(gold: readonly string[], ranked: readonly string[], k: number): number {
  const goldSet = new Set(gold);
  if (!goldSet.size) return 1;
  const top = uniqueOrdered(ranked).slice(0, Math.max(0, k));
  return intersectionCount([...goldSet], top) / goldSet.size;
}

/** Fraction of the top `k` ranked results that are in the gold set. No results scores 0. */
export function precisionAtK(gold: readonly string[], ranked: readonly string[], k: number): number {
  const top = uniqueOrdered(ranked).slice(0, Math.max(0, k));
  if (!top.length) return 0;
  return intersectionCount(gold, top) / top.length;
}

/** Set recall without a rank cutoff, used for gates, tests and protected gates. */
export function setRecall(gold: readonly string[], selected: readonly string[]): number {
  const goldSet = new Set(gold);
  if (!goldSet.size) return 1;
  return intersectionCount([...goldSet], selected) / goldSet.size;
}

export function conflictKey(conflict: ContextGraphBenchmarkConflict): string {
  return `${conflict.path}|${[...conflict.slices].sort().join('+')}`;
}

export function conflictRecall(
  gold: readonly ContextGraphBenchmarkConflict[],
  detected: readonly ContextGraphBenchmarkConflict[]
): number {
  return setRecall(gold.map(conflictKey), detected.map(conflictKey));
}

/** Nearest-rank percentile over a sorted copy; `p` is 0..1. */
export function percentile(samples: readonly number[], p: number): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length)));
  return sorted[rank - 1] ?? 0;
}

export function latencyOf(samples: readonly number[]): ContextGraphBenchmarkLatency {
  if (!samples.length) return EMPTY_LATENCY;
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    min: Math.min(...samples),
    max: Math.max(...samples)
  };
}

export function mean(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Stable signature of the answer shape, used to detect a non-deterministic adapter. */
export function runSignature(run: ContextGraphBenchmarkRun): string {
  return JSON.stringify([
    run.matchedPaths,
    run.matchedNodeIds,
    [...run.selectedGateIds].sort(),
    [...run.selectedTestPaths].sort(),
    run.writeScopeConflicts.map(conflictKey).sort()
  ]);
}

function representative(runs: readonly ContextGraphBenchmarkRun[]): ContextGraphBenchmarkRun | null {
  return runs.find((run) => run.mode === 'cold') ?? runs[0] ?? null;
}

function emptyMetrics(
  testCase: ContextGraphBenchmarkCase,
  adapterId: string,
  adapterKind: ContextGraphBenchmarkAdapterKind
): ContextGraphBenchmarkCaseMetrics {
  return {
    caseId: testCase.id,
    adapterId,
    adapterKind,
    ok: false,
    k: testCase.k,
    recallAtK: 0,
    precisionAtK: 0,
    nodeRecallAtK: 0,
    gateRecall: 0,
    protectedGateRecall: 0,
    testRecall: 0,
    conflictRecall: 0,
    provenanceCoverage: 0,
    exclusionCorrect: true,
    mustExcludeViolations: [],
    exactSeedPreservation: 0,
    usefulEvidence: 0,
    tokenCost: 0,
    taskContextSuccess: false,
    coldLatency: EMPTY_LATENCY,
    warmLatency: EMPTY_LATENCY,
    coldRuns: 0,
    warmRuns: 0,
    coldCacheHits: 0,
    warmCacheHits: 0
  };
}

/**
 * `usefulEvidence` counts the distinct gold items an answer actually delivered.
 * It is the numerator of the evidence-density component, so padding an answer
 * with extra files raises token cost without raising evidence.
 */
function usefulEvidenceCount(testCase: ContextGraphBenchmarkCase, run: ContextGraphBenchmarkRun): number {
  const topPaths = uniqueOrdered(run.matchedPaths).slice(0, testCase.k);
  return (
    intersectionCount(testCase.gold.paths, topPaths) +
    intersectionCount(testCase.gold.gateIds, run.selectedGateIds) +
    intersectionCount(testCase.gold.testPaths, run.selectedTestPaths) +
    intersectionCount(testCase.gold.conflicts.map(conflictKey), run.writeScopeConflicts.map(conflictKey))
  );
}

export function evaluateCase(
  testCase: ContextGraphBenchmarkCase,
  adapterId: string,
  adapterKind: ContextGraphBenchmarkAdapterKind,
  runs: readonly ContextGraphBenchmarkRun[]
): ContextGraphBenchmarkCaseMetrics {
  const primary = representative(runs);
  if (!primary) return emptyMetrics(testCase, adapterId, adapterKind);

  const cold = runs.filter((run) => run.mode === 'cold');
  const warm = runs.filter((run) => run.mode === 'warm');
  const gold = testCase.gold;
  const returnedPaths = uniqueOrdered(primary.matchedPaths);

  // Checked against the whole answer, not just the top k: a redacted or stale
  // file that arrives at rank 40 has still been handed to the caller.
  const mustExcludeViolations = gold.mustExcludePaths.filter((item) => returnedPaths.includes(item));
  const staleViolations = primary.staleIncluded.filter((item) => item.length > 0);
  const invalidatedViolations = primary.invalidatedIncluded.filter((item) => item.length > 0);
  const exclusionCorrect =
    mustExcludeViolations.length === 0 && staleViolations.length === 0 && invalidatedViolations.length === 0;

  const recall = recallAtK(gold.paths, primary.matchedPaths, testCase.k);
  const precision = precisionAtK(gold.paths, primary.matchedPaths, testCase.k);
  const gateRecall = setRecall(gold.gateIds, primary.selectedGateIds);
  const protectedGateRecall = setRecall(gold.protectedGateIds, primary.selectedGateIds);
  const testRecall = setRecall(gold.testPaths, primary.selectedTestPaths);
  const conflicts = conflictRecall(gold.conflicts, primary.writeScopeConflicts);
  const exactSeedPreservation = setRecall(gold.exactSeedPaths, primary.exactSeedsPreserved);

  const taskContextSuccess =
    primary.ok &&
    recall === 1 &&
    gateRecall === 1 &&
    testRecall === 1 &&
    conflicts === 1 &&
    exactSeedPreservation === 1 &&
    exclusionCorrect;

  return {
    caseId: testCase.id,
    adapterId,
    adapterKind,
    ok: primary.ok,
    k: testCase.k,
    recallAtK: recall,
    precisionAtK: precision,
    nodeRecallAtK: recallAtK(gold.nodeIds, primary.matchedNodeIds, testCase.k),
    gateRecall,
    protectedGateRecall,
    testRecall,
    conflictRecall: conflicts,
    provenanceCoverage: Number.isFinite(primary.provenanceCoverage) ? primary.provenanceCoverage : 0,
    exclusionCorrect,
    mustExcludeViolations,
    exactSeedPreservation,
    usefulEvidence: usefulEvidenceCount(testCase, primary),
    tokenCost: Math.max(0, primary.tokenCost),
    taskContextSuccess,
    coldLatency: latencyOf(cold.map((run) => run.latencyMs)),
    warmLatency: latencyOf(warm.map((run) => run.latencyMs)),
    coldRuns: cold.length,
    warmRuns: warm.length,
    coldCacheHits: cold.filter((run) => run.cacheHit).length,
    warmCacheHits: warm.filter((run) => run.cacheHit).length
  };
}

export function summarizeAdapter(
  adapterId: string,
  adapterKind: ContextGraphBenchmarkAdapterKind,
  rows: readonly ContextGraphBenchmarkCaseMetrics[],
  coldSamples: readonly number[],
  warmSamples: readonly number[]
): ContextGraphBenchmarkAdapterSummary {
  const totalTokens = rows.reduce((sum, row) => sum + row.tokenCost, 0);
  const totalEvidence = rows.reduce((sum, row) => sum + row.usefulEvidence, 0);
  const warmRuns = rows.reduce((sum, row) => sum + row.warmRuns, 0);
  const warmHits = rows.reduce((sum, row) => sum + row.warmCacheHits, 0);
  return {
    adapterId,
    adapterKind,
    caseCount: rows.length,
    okRate: rows.length ? rows.filter((row) => row.ok).length / rows.length : 0,
    taskContextSuccess: rows.length ? rows.filter((row) => row.taskContextSuccess).length / rows.length : 0,
    recallAtK: mean(rows.map((row) => row.recallAtK)),
    precisionAtK: mean(rows.map((row) => row.precisionAtK)),
    nodeRecallAtK: mean(rows.map((row) => row.nodeRecallAtK)),
    gateRecall: mean(rows.map((row) => row.gateRecall)),
    protectedGateRecall: mean(rows.map((row) => row.protectedGateRecall)),
    testRecall: mean(rows.map((row) => row.testRecall)),
    conflictRecall: mean(rows.map((row) => row.conflictRecall)),
    provenanceCoverage: mean(rows.map((row) => row.provenanceCoverage)),
    exclusionCorrectRate: rows.length ? rows.filter((row) => row.exclusionCorrect).length / rows.length : 0,
    exactSeedPreservation: mean(rows.map((row) => row.exactSeedPreservation)),
    meanTokenCost: mean(rows.map((row) => row.tokenCost)),
    usefulEvidencePerKiloToken: totalTokens > 0 ? totalEvidence / (totalTokens / 1000) : 0,
    coldLatency: latencyOf(coldSamples),
    warmLatency: latencyOf(warmSamples),
    warmCacheHitRate: warmRuns ? warmHits / warmRuns : 0,
    coldCacheHits: rows.reduce((sum, row) => sum + row.coldCacheHits, 0)
  };
}
