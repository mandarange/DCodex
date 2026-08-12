/**
 * CRK2 retrieval metrics.
 *
 * Percentile and set-recall math is shared with the v1 benchmark (`metrics.ts`)
 * so the two harnesses cannot disagree about what recall means while claiming to
 * compare each other. What is new here is per-node gold matching, derived
 * provenance coverage, and a confidence check that reads ADR §4 literally: a
 * BM25F match never becomes `exact`, at any score.
 *
 * Latency is only ever produced inside a record that also carries recall
 * (`Crk2CategoryStat`). The v1 baseline's fastest cases were its emptiest ones,
 * and a report that can quote milliseconds without recall beside them invites
 * exactly that misreading.
 */
import { percentile, uniqueOrdered } from './metrics.js';
import {
  type Crk2Case,
  type Crk2CaseMetrics,
  type Crk2CategoryStat,
  type Crk2Conflict,
  type Crk2Engine,
  type Crk2EngineResult,
  type Crk2EngineSummary,
  type Crk2GoldMatcher,
  type Crk2LatencyProfile,
  type Crk2QueryCategory
} from './crk2-types.js';
import type { ContextGraphSeedConfidence } from '../query-types.js';

export const CRK2_EMPTY_LATENCY: Crk2LatencyProfile = {
  samples: 0,
  p50: 0,
  p95: 0,
  p99: 0,
  min: 0,
  max: 0,
  mean: 0
};

/**
 * Confidence strength, strongest first. ADR §4 makes the mapping total and
 * exclusive, so a ceiling comparison is a rank comparison and never a guess.
 */
export const CRK2_CONFIDENCE_RANK: Readonly<Record<ContextGraphSeedConfidence, number>> = {
  exact_definition: 0,
  exact_reference: 1,
  manifest: 2,
  syntactic_reference: 3,
  file_path: 4,
  text_candidate: 5
};

export function crk2LatencyProfile(samples: readonly number[]): Crk2LatencyProfile {
  if (!samples.length) return CRK2_EMPTY_LATENCY;
  const total = samples.reduce((sum, value) => sum + value, 0);
  return {
    samples: samples.length,
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    p99: percentile(samples, 0.99),
    min: Math.min(...samples),
    max: Math.max(...samples),
    mean: total / samples.length
  };
}

/** Stable, human-readable key for a matcher; used in `missingMustInclude` detail. */
export function crk2MatcherKey(matcher: Crk2GoldMatcher): string {
  if (matcher.kind === 'symbol') return `symbol:${matcher.path}#${matcher.name}`;
  if (matcher.kind === 'path_prefix') return `path_prefix:${matcher.prefix}`;
  return `id_prefix:${matcher.prefix}`;
}

/**
 * A symbol id is `symbol:<path>#<symbolKind>:<name>@<offset>`; the offset is
 * decided by the compiler, so the matcher checks path and name and deliberately
 * ignores everything a corpus author cannot know.
 */
export function crk2MatcherMatches(matcher: Crk2GoldMatcher, nodeId: string): boolean {
  if (matcher.kind === 'id_prefix') return nodeId.startsWith(matcher.prefix);
  if (matcher.kind === 'path_prefix') {
    const separator = nodeId.indexOf(':');
    if (separator < 0) return false;
    return nodeId.slice(separator + 1).startsWith(matcher.prefix);
  }
  if (!nodeId.startsWith(`symbol:${matcher.path}#`)) return false;
  const fragment = nodeId.slice(nodeId.indexOf('#') + 1);
  const kindSeparator = fragment.indexOf(':');
  if (kindSeparator < 0) return false;
  const nameAndOffset = fragment.slice(kindSeparator + 1);
  const at = nameAndOffset.lastIndexOf('@');
  return (at < 0 ? nameAndOffset : nameAndOffset.slice(0, at)) === matcher.name;
}

export function conflictKeyOf(conflict: Crk2Conflict): string {
  return `${conflict.path}|${[...conflict.slices].sort().join('+')}`;
}

/** Set recall with no rank cutoff. An empty gold set scores 1: nothing was asked for, nothing was missed. */
export function crk2SetRecall(gold: readonly string[], observed: readonly string[]): number {
  const wanted = new Set(gold);
  if (!wanted.size) return 1;
  const pool = new Set(observed);
  let hits = 0;
  for (const item of wanted) if (pool.has(item)) hits += 1;
  return hits / wanted.size;
}

export function crk2ConflictRecall(gold: readonly Crk2Conflict[], observed: readonly Crk2Conflict[]): number {
  return crk2SetRecall(gold.map(conflictKeyOf), observed.map(conflictKeyOf));
}

interface GoldHitReport {
  readonly satisfied: number;
  readonly total: number;
  readonly missing: readonly string[];
}

function evaluateGoldTargets(
  literalIds: readonly string[],
  matchers: readonly Crk2GoldMatcher[],
  ranked: readonly string[]
): GoldHitReport {
  const pool = new Set(ranked);
  const missing: string[] = [];
  let satisfied = 0;
  for (const nodeId of new Set(literalIds)) {
    if (pool.has(nodeId)) satisfied += 1;
    else missing.push(nodeId);
  }
  for (const matcher of matchers) {
    if (ranked.some((nodeId) => crk2MatcherMatches(matcher, nodeId))) satisfied += 1;
    else missing.push(crk2MatcherKey(matcher));
  }
  const total = new Set(literalIds).size + matchers.length;
  return { satisfied, total, missing: missing.sort() };
}

/**
 * Nodes whose claimed confidence is stronger than the case allows.
 *
 * Two rules, both from ADR §4: a per-node `requiredConfidence` must be met
 * exactly, and a case-level ceiling caps every returned node. The ceiling is
 * what stops a `korean` or `jargon` case from being "fixed" by relabelling a
 * text hit as an exact relation.
 */
export function crk2ConfidenceViolations(testCase: Crk2Case, result: Crk2EngineResult): readonly string[] {
  const violations = new Set<string>();
  const ceiling = testCase.gold.confidenceCeiling;
  if (ceiling) {
    const limit = CRK2_CONFIDENCE_RANK[ceiling];
    for (const nodeId of result.nodeIds) {
      const claimed = result.confidenceByNodeId[nodeId];
      if (claimed && CRK2_CONFIDENCE_RANK[claimed] < limit) {
        violations.add(`${nodeId}:above_ceiling_${ceiling}`);
      }
    }
  }
  for (const [nodeId, required] of Object.entries(testCase.gold.requiredConfidence ?? {})) {
    const claimed = result.confidenceByNodeId[nodeId];
    if (!result.nodeIds.includes(nodeId)) continue;
    if (claimed !== required) violations.add(`${nodeId}:expected_${required}`);
  }
  return [...violations].sort();
}

/**
 * Fraction of returned nodes carrying provenance, derived by the harness from
 * the returned sets rather than trusted from a self-reported number. A run that
 * returned nothing has nothing to attest to, so it scores 1 and the recall
 * metrics carry the failure instead.
 */
export function crk2ProvenanceCoverage(result: Crk2EngineResult): number {
  const returned = uniqueOrdered([...result.nodeIds]);
  if (!returned.length) return 1;
  const withProvenance = new Set(result.provenanceNodeIds);
  let covered = 0;
  for (const nodeId of returned) if (withProvenance.has(nodeId)) covered += 1;
  return covered / returned.length;
}

/** Stable signature of an answer, used to detect a non-deterministic engine across repeats. */
export function crk2ResultSignature(result: Crk2EngineResult): string {
  return JSON.stringify([
    result.ok,
    result.errorCode,
    result.nodeIds,
    [...result.provenanceNodeIds].sort(),
    Object.keys(result.confidenceByNodeId)
      .sort()
      .map((nodeId) => [nodeId, result.confidenceByNodeId[nodeId]]),
    [...result.selectedGateIds].sort(),
    [...result.droppedGateIds].sort(),
    result.conflicts.map(conflictKeyOf).sort(),
    result.tokenCost
  ]);
}

export interface Crk2CaseObservation {
  /** The answer every repeat agreed on; by construction the first one. */
  readonly result: Crk2EngineResult;
  readonly latencySamples: readonly number[];
  /** Repeats whose signature differed from the first. Work order §12.1 requires 0. */
  readonly determinismMismatches: number;
}

export function evaluateCrk2Case(
  testCase: Crk2Case,
  engine: Pick<Crk2Engine, 'id' | 'version'>,
  observation: Crk2CaseObservation
): Crk2CaseMetrics {
  const { result } = observation;
  const gold = testCase.gold;
  const ranked = uniqueOrdered([...result.nodeIds]);
  const top = ranked.slice(0, Math.max(0, testCase.k));

  const mustHits = evaluateGoldTargets(gold.mustIncludeNodeIds, gold.mustIncludeMatchers, top);
  const relevantHits = evaluateGoldTargets(
    [...gold.mustIncludeNodeIds, ...gold.relevantNodeIds],
    gold.mustIncludeMatchers,
    top
  );

  // Checked against the whole answer, not the top k: a forbidden node at rank 40
  // was still handed to the caller.
  const forbiddenViolations = gold.forbiddenNodeIds.filter((nodeId) => ranked.includes(nodeId)).sort();

  const relevantPool = new Set([...gold.mustIncludeNodeIds, ...gold.relevantNodeIds]);
  const precisionHits = top.filter(
    (nodeId) => relevantPool.has(nodeId) || gold.mustIncludeMatchers.some((matcher) => crk2MatcherMatches(matcher, nodeId))
  ).length;
  // An empty answer to a case that wanted nothing is perfectly precise; an empty
  // answer to a case that wanted something is not precise, it is absent.
  const wantsSomething = relevantPool.size > 0 || gold.mustIncludeMatchers.length > 0;
  const precisionAtK = top.length ? precisionHits / top.length : wantsSomething ? 0 : 1;

  const expectedErrorCode = gold.expectedErrorCode ?? null;
  const rejectionCorrect = expectedErrorCode === null
    ? null
    : !result.ok && result.errorCode === expectedErrorCode && ranked.length === 0;

  const budgetCap = gold.maxTokenCost ?? testCase.tokenBudget;
  // A protected gate lost to a token budget has to be named in `droppedGateIds`.
  // Silence about it is the failure the work order §12.3 warning exists to stop.
  const missingProtected = gold.protectedGateIds.filter((gateId) => !result.selectedGateIds.includes(gateId));

  return {
    caseId: testCase.id,
    category: testCase.category,
    engineId: engine.id,
    engineVersion: engine.version,
    k: testCase.k,
    ok: result.ok,
    errorCode: result.errorCode,
    expectedErrorCode,
    rejectionCorrect,
    mustIncludeRecall: mustHits.total ? mustHits.satisfied / mustHits.total : 1,
    missingMustInclude: mustHits.missing,
    recallAtK: relevantHits.total ? relevantHits.satisfied / relevantHits.total : 1,
    precisionAtK,
    provenanceCoverage: crk2ProvenanceCoverage(result),
    protectedGateRecall: crk2SetRecall(gold.protectedGateIds, result.selectedGateIds),
    gateRecall: crk2SetRecall(gold.gateIds, result.selectedGateIds),
    conflictRecall: crk2ConflictRecall(gold.conflicts, result.conflicts),
    declaredMustIncludeCount: mustHits.total,
    declaredGateCount: new Set(gold.gateIds).size,
    declaredProtectedGateCount: new Set(gold.protectedGateIds).size,
    declaredConflictCount: gold.conflicts.length,
    forbiddenViolations,
    confidenceViolations: crk2ConfidenceViolations(testCase, result),
    tokenCost: Math.max(0, result.tokenCost),
    tokenBudgetRespected: result.tokenCost <= budgetCap,
    droppedGateWarned: missingProtected.every((gateId) => result.droppedGateIds.includes(gateId)),
    latency: crk2LatencyProfile(observation.latencySamples),
    determinismMismatches: Math.max(0, observation.determinismMismatches)
  };
}

function meanOf(values: readonly number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** No case asked for this metric, so nothing was missed. Averaging to 0 would invent a failure. */
function meanOrOne(values: readonly number[]): number {
  return values.length ? meanOf(values) : 1;
}

function categoryStats(
  rows: readonly Crk2CaseMetrics[],
  samplesByCaseId: ReadonlyMap<string, readonly number[]>
): readonly Crk2CategoryStat[] {
  const byCategory = new Map<Crk2QueryCategory, Crk2CaseMetrics[]>();
  for (const row of rows) {
    const bucket = byCategory.get(row.category);
    if (bucket) bucket.push(row);
    else byCategory.set(row.category, [row]);
  }
  const stats: Crk2CategoryStat[] = [];
  for (const [category, bucket] of byCategory) {
    const pooled = bucket.flatMap((row) => [...(samplesByCaseId.get(row.caseId) ?? [])]);
    stats.push({
      category,
      caseCount: bucket.length,
      mustIncludeRecall: meanOf(bucket.map((row) => row.mustIncludeRecall)),
      recallAtK: meanOf(bucket.map((row) => row.recallAtK)),
      latency: crk2LatencyProfile(pooled)
    });
  }
  return stats.sort((left, right) => left.category.localeCompare(right.category));
}

/**
 * Aggregate one engine's run.
 *
 * Recall averages are taken over the cases that actually declared the thing
 * being measured, and rejection cases are excluded from retrieval averages —
 * an engine that correctly refuses a corrupt index has not "achieved" recall.
 */
export function summarizeCrk2Engine(
  engine: Pick<Crk2Engine, 'id' | 'version'>,
  rows: readonly Crk2CaseMetrics[],
  samplesByCaseId: ReadonlyMap<string, readonly number[]>
): Crk2EngineSummary {
  const retrievalRows = rows.filter((row) => row.expectedErrorCode === null);
  const rejectionRows = rows.filter((row) => row.rejectionCorrect !== null);
  const rejectionCorrect = rejectionRows.filter((row) => row.rejectionCorrect === true).length;
  const pooled = rows.flatMap((row) => [...(samplesByCaseId.get(row.caseId) ?? [])]);
  return {
    engineId: engine.id,
    engineVersion: engine.version,
    caseCount: rows.length,
    okRate: rows.length ? rows.filter((row) => row.ok).length / rows.length : 0,
    mustIncludeRecall: meanOrOne(retrievalRows.map((row) => row.mustIncludeRecall)),
    recallAtK: meanOrOne(retrievalRows.map((row) => row.recallAtK)),
    precisionAtK: meanOf(retrievalRows.map((row) => row.precisionAtK)),
    provenanceCoverage: meanOrOne(retrievalRows.map((row) => row.provenanceCoverage)),
    protectedGateRecall: meanOrOne(
      rows.filter((row) => row.declaredProtectedGateCount > 0).map((row) => row.protectedGateRecall)
    ),
    gateRecall: meanOrOne(rows.filter((row) => row.declaredGateCount > 0).map((row) => row.gateRecall)),
    conflictRecall: meanOrOne(rows.filter((row) => row.declaredConflictCount > 0).map((row) => row.conflictRecall)),
    forbiddenViolations: rows.reduce((sum, row) => sum + row.forbiddenViolations.length, 0),
    confidenceViolations: rows.reduce((sum, row) => sum + row.confidenceViolations.length, 0),
    determinismMismatches: rows.reduce((sum, row) => sum + row.determinismMismatches, 0),
    rejectionCases: rejectionRows.length,
    rejectionCorrect,
    rejectionRate: rejectionRows.length ? rejectionCorrect / rejectionRows.length : 1,
    droppedGateWarnings: rows.filter((row) => !row.droppedGateWarned).length,
    meanTokenCost: meanOf(rows.map((row) => row.tokenCost)),
    latency: crk2LatencyProfile(pooled),
    categories: categoryStats(rows, samplesByCaseId)
  };
}
