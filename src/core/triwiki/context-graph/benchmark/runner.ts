/**
 * Benchmark driver.
 *
 * Order matters and is not configurable: corpus integrity, then execution, then
 * hard safety floors, and only then the composite score. A run that trips
 * integrity or a floor produces a report with `score: null` — there is no code
 * path that scores an unsafe or unverified candidate.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  defaultCorpusPath,
  loadContextGraphBenchmarkCorpus,
  parseContextGraphBenchmarkCorpus,
  type ParsedContextGraphBenchmarkCorpus
} from './corpus.js';
import { evaluateBenchmarkFloors, type BenchmarkFloorInput } from './floors.js';
import {
  contextGraphBenchmarkFixtureFamilies,
  gitAvailable,
  materializeFixture,
  missingFixtureDefinitions,
  type FixtureHandle
} from './fixtures/index.js';
import { evaluateCase, summarizeAdapter } from './metrics.js';
import { captureEnvironment, computeScoringCodeHash, writeBenchmarkReport } from './report.js';
import { computeBenchmarkScore } from './score.js';
import {
  CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA,
  emptyBenchmarkSafety,
  type ContextGraphBenchmarkAdapter,
  type ContextGraphBenchmarkAdapterSummary,
  type ContextGraphBenchmarkCase,
  type ContextGraphBenchmarkCaseMetrics,
  type ContextGraphBenchmarkFloorReport,
  type ContextGraphBenchmarkMode,
  type ContextGraphBenchmarkQuery,
  type ContextGraphBenchmarkReport,
  type ContextGraphBenchmarkRun,
  type ContextGraphBenchmarkSafety
} from './types.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_COLD_ITERATIONS = 1;
export const DEFAULT_WARM_ITERATIONS = 3;

export interface ContextGraphBenchmarkOptions {
  /** Repository root used for the git/machine report and for the report artifact location. */
  readonly root: string;
  /** Raw corpus object; when omitted the corpus is read from `config/context-graph-benchmark.json`. */
  readonly corpus?: unknown;
  readonly corpusPath?: string;
  readonly caseIds?: readonly string[];
  readonly coldIterations?: number;
  readonly warmIterations?: number;
  readonly now?: string;
  readonly expectedScoringCodeHash?: string;
  readonly scoringCodeDir?: string;
  readonly writeReport?: boolean;
  readonly reportPath?: string;
  readonly tmpDir?: string;
  readonly keepFixtures?: boolean;
  readonly skipGitFixtures?: boolean;
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback;
  return Math.trunc(value);
}

function loadCorpus(options: ContextGraphBenchmarkOptions): ParsedContextGraphBenchmarkCorpus {
  if (options.corpus !== undefined) return parseContextGraphBenchmarkCorpus(options.corpus);
  return loadContextGraphBenchmarkCorpus(options.corpusPath ?? defaultCorpusPath(MODULE_DIR));
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

/**
 * Rebuilds the adapter answer under the runner's own identity fields so an
 * adapter cannot relabel which case or which mode it just answered.
 */
function normalizeRun(
  raw: ContextGraphBenchmarkRun,
  query: ContextGraphBenchmarkQuery,
  adapterId: string,
  measuredMs: number
): ContextGraphBenchmarkRun {
  const reported = raw.latencyMs;
  const latencyMs = typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 ? reported : measuredMs;
  return {
    caseId: query.caseId,
    adapterId,
    mode: query.mode,
    iteration: query.iteration,
    ok: Boolean(raw.ok),
    errorCode: typeof raw.errorCode === 'string' && raw.errorCode ? raw.errorCode : null,
    matchedPaths: stringArray(raw.matchedPaths),
    matchedNodeIds: stringArray(raw.matchedNodeIds),
    selectedGateIds: stringArray(raw.selectedGateIds),
    selectedTestPaths: stringArray(raw.selectedTestPaths),
    writeScopeConflicts: Array.isArray(raw.writeScopeConflicts)
      ? raw.writeScopeConflicts
          .filter((item) => item && typeof item.path === 'string')
          .map((item) => ({ path: item.path, slices: [...stringArray(item.slices)].sort() }))
      : [],
    tokenCost: finiteNonNegative(raw.tokenCost),
    latencyMs,
    cacheHit: Boolean(raw.cacheHit),
    provenanceCoverage: Math.min(1, finiteNonNegative(raw.provenanceCoverage)),
    staleIncluded: stringArray(raw.staleIncluded),
    invalidatedIncluded: stringArray(raw.invalidatedIncluded),
    exactSeedsPreserved: stringArray(raw.exactSeedsPreserved),
    safety: emptyBenchmarkSafety((raw.safety ?? {}) as Partial<ContextGraphBenchmarkSafety>)
  };
}

function failedRun(query: ContextGraphBenchmarkQuery, adapterId: string, measuredMs: number, errorName: string): ContextGraphBenchmarkRun {
  return {
    caseId: query.caseId,
    adapterId,
    mode: query.mode,
    iteration: query.iteration,
    ok: false,
    errorCode: `adapter_error:${errorName}`,
    matchedPaths: [],
    matchedNodeIds: [],
    selectedGateIds: [],
    selectedTestPaths: [],
    writeScopeConflicts: [],
    tokenCost: 0,
    latencyMs: measuredMs,
    cacheHit: false,
    provenanceCoverage: 0,
    staleIncluded: [],
    invalidatedIncluded: [],
    exactSeedsPreserved: [],
    safety: emptyBenchmarkSafety()
  };
}

function buildQuery(
  testCase: ContextGraphBenchmarkCase,
  root: string,
  mode: ContextGraphBenchmarkMode,
  iteration: number,
  now: string
): ContextGraphBenchmarkQuery {
  return {
    caseId: testCase.id,
    root,
    fixture: testCase.fixture,
    query: testCase.query,
    profile: testCase.profile,
    changedPaths: testCase.changedPaths,
    focusPaths: testCase.focusPaths,
    tokenBudget: testCase.tokenBudget,
    risk: testCase.risk,
    k: testCase.k,
    mode,
    iteration,
    now
  };
}

async function invoke(
  adapter: ContextGraphBenchmarkAdapter,
  query: ContextGraphBenchmarkQuery,
  warnings: string[]
): Promise<ContextGraphBenchmarkRun> {
  const started = Date.now();
  try {
    const raw = await adapter.run(query);
    const measured = Date.now() - started;
    const run = normalizeRun(raw, query, adapter.id, measured);
    if (run.latencyMs > measured * 3 + 50) {
      warnings.push(`${adapter.id}:${query.caseId}:reported_latency_exceeds_measured`);
    }
    if (query.mode === 'cold' && run.cacheHit) {
      warnings.push(`${adapter.id}:${query.caseId}:cold_run_reported_cache_hit`);
    }
    return run;
  } catch (error) {
    const name = error instanceof Error ? error.name : 'UnknownError';
    warnings.push(`${adapter.id}:${query.caseId}:adapter_threw:${name}`);
    return failedRun(query, adapter.id, Date.now() - started, name);
  }
}

interface CaseExecution {
  readonly runs: ContextGraphBenchmarkRun[];
  readonly symlinkSupported: boolean;
  readonly gitInitialized: boolean;
}

async function executeCase(
  adapter: ContextGraphBenchmarkAdapter,
  testCase: ContextGraphBenchmarkCase,
  options: ContextGraphBenchmarkOptions,
  coldIterations: number,
  warmIterations: number,
  now: string,
  warnings: string[]
): Promise<CaseExecution> {
  const runs: ContextGraphBenchmarkRun[] = [];
  const materializeOptions = {
    ...(options.tmpDir === undefined ? {} : { tmpDir: options.tmpDir }),
    ...(options.skipGitFixtures === undefined ? {} : { skipGit: options.skipGitFixtures })
  };
  let current: FixtureHandle | null = null;
  let symlinkSupported = true;
  let gitInitialized = false;
  const release = (handle: FixtureHandle | null): void => {
    if (handle && !options.keepFixtures) handle.dispose();
  };
  try {
    for (let iteration = 0; iteration < coldIterations; iteration += 1) {
      release(current);
      current = materializeFixture(testCase.fixture, materializeOptions);
      symlinkSupported = symlinkSupported && current.symlinkSupported;
      gitInitialized = gitInitialized || current.gitInitialized;
      runs.push(await invoke(adapter, buildQuery(testCase, current.root, 'cold', iteration, now), warnings));
    }
    if (warmIterations > 0) {
      if (!current) {
        current = materializeFixture(testCase.fixture, materializeOptions);
        symlinkSupported = symlinkSupported && current.symlinkSupported;
        gitInitialized = gitInitialized || current.gitInitialized;
      }
      const warmRoot = current.root;
      for (let iteration = 0; iteration < warmIterations; iteration += 1) {
        runs.push(await invoke(adapter, buildQuery(testCase, warmRoot, 'warm', iteration, now), warnings));
      }
    }
  } finally {
    release(current);
  }
  return { runs, symlinkSupported, gitInitialized };
}

function selectCases(
  corpus: ParsedContextGraphBenchmarkCorpus,
  caseIds: readonly string[] | undefined
): readonly ContextGraphBenchmarkCase[] {
  if (!caseIds || !caseIds.length) return corpus.corpus.cases;
  const wanted = new Set(caseIds);
  return corpus.corpus.cases.filter((item) => wanted.has(item.id));
}

function emptyFloorReport(): ContextGraphBenchmarkFloorReport {
  return { ok: false, evaluated: 0, failed: 0, results: [] };
}

export async function runContextGraphBenchmark(
  adapters: readonly ContextGraphBenchmarkAdapter[],
  options: ContextGraphBenchmarkOptions
): Promise<ContextGraphBenchmarkReport> {
  const startedAt = Date.now();
  const warnings: string[] = [];
  const notes: string[] = [];
  const now = options.now ?? new Date(startedAt).toISOString();
  const coldIterations = positive(options.coldIterations, DEFAULT_COLD_ITERATIONS);
  const warmIterations = positive(options.warmIterations, DEFAULT_WARM_ITERATIONS);

  const parsed = loadCorpus(options);
  const scoringCodeHash = computeScoringCodeHash(options.scoringCodeDir ?? MODULE_DIR);
  const expectedScoringCodeHash = options.expectedScoringCodeHash ?? null;
  const scoringCodeHashOk = expectedScoringCodeHash === null || expectedScoringCodeHash === scoringCodeHash;
  const environment = captureEnvironment(options.root);
  const missingFixtures = missingFixtureDefinitions();
  if (missingFixtures.length) notes.push(`missing_fixture_definitions:${missingFixtures.join(',')}`);

  const integrityBase = {
    corpusHash: parsed.corpus.corpusHash,
    expectedCorpusHash: parsed.computedHash,
    corpusHashOk: parsed.hashOk,
    scoringCodeHash,
    expectedScoringCodeHash,
    scoringCodeHashOk,
    reportLeakRules: [] as string[],
    ok: parsed.hashOk && scoringCodeHashOk
  };

  const cases = selectCases(parsed, options.caseIds);
  const adapterList = adapters.map((adapter) => ({ id: adapter.id, kind: adapter.kind }));
  const capabilities = {
    adapters: adapterList.map((adapter) => adapter.id),
    gitAvailable: gitAvailable(),
    symlinkSupported: true,
    fixtureFamilies: [...contextGraphBenchmarkFixtureFamilies()],
    coldIterations,
    warmIterations
  };

  if (!integrityBase.ok) {
    notes.push(parsed.hashOk ? 'scoring_code_hash_mismatch' : 'corpus_hash_mismatch');
    return finalize({
      startedAt,
      now,
      corpusRevision: parsed.corpus.corpusRevision,
      integrity: integrityBase,
      environment,
      capabilities,
      adapters: adapterList,
      cases: [],
      summaries: [],
      floors: emptyFloorReport(),
      score: null,
      warnings,
      notes,
      options
    });
  }

  const rowsByAdapter = new Map<string, ContextGraphBenchmarkCaseMetrics[]>();
  const runsByAdapter = new Map<string, ContextGraphBenchmarkRun[]>();
  let symlinkSupported = true;

  for (const adapter of adapters) {
    const rows: ContextGraphBenchmarkCaseMetrics[] = [];
    const runs: ContextGraphBenchmarkRun[] = [];
    for (const testCase of cases) {
      const execution = await executeCase(adapter, testCase, options, coldIterations, warmIterations, now, warnings);
      symlinkSupported = symlinkSupported && execution.symlinkSupported;
      runs.push(...execution.runs);
      rows.push(evaluateCase(testCase, adapter.id, adapter.kind, execution.runs));
    }
    rowsByAdapter.set(adapter.id, rows);
    runsByAdapter.set(adapter.id, runs);
  }

  const floorInputs: BenchmarkFloorInput[] = adapters.map((adapter) => ({
    adapterId: adapter.id,
    adapterKind: adapter.kind,
    runs: runsByAdapter.get(adapter.id) ?? [],
    rows: rowsByAdapter.get(adapter.id) ?? []
  }));
  const floors = evaluateBenchmarkFloors(floorInputs);

  const summaries: ContextGraphBenchmarkAdapterSummary[] = adapters.map((adapter) => {
    const rows = rowsByAdapter.get(adapter.id) ?? [];
    const runs = runsByAdapter.get(adapter.id) ?? [];
    return summarizeAdapter(
      adapter.id,
      adapter.kind,
      rows,
      runs.filter((run) => run.mode === 'cold').map((run) => run.latencyMs),
      runs.filter((run) => run.mode === 'warm').map((run) => run.latencyMs)
    );
  });

  const baseline = summaries.find((summary) => summary.adapterKind === 'baseline') ?? null;
  const candidate = summaries.find((summary) => summary.adapterKind === 'candidate') ?? null;
  let score: ContextGraphBenchmarkReport['score'] = null;
  if (!floors.ok) {
    notes.push('composite_score_withheld:hard_floor_failed');
  } else if (!baseline || !candidate) {
    notes.push('composite_score_withheld:needs_one_baseline_and_one_candidate');
  } else {
    score = computeBenchmarkScore(baseline, candidate, parsed.corpus.scoreWeights, parsed.corpus.improvementThreshold);
  }

  const allCases = adapters.flatMap((adapter) => rowsByAdapter.get(adapter.id) ?? []);
  return finalize({
    startedAt,
    now,
    corpusRevision: parsed.corpus.corpusRevision,
    integrity: integrityBase,
    environment,
    capabilities: { ...capabilities, symlinkSupported },
    adapters: adapterList,
    cases: allCases,
    summaries,
    floors,
    score,
    warnings,
    notes,
    options
  });
}

interface FinalizeInput {
  readonly startedAt: number;
  readonly now: string;
  readonly corpusRevision: string;
  readonly integrity: ContextGraphBenchmarkReport['integrity'];
  readonly environment: ContextGraphBenchmarkReport['environment'];
  readonly capabilities: ContextGraphBenchmarkReport['capabilities'];
  readonly adapters: ContextGraphBenchmarkReport['adapters'];
  readonly cases: readonly ContextGraphBenchmarkCaseMetrics[];
  readonly summaries: readonly ContextGraphBenchmarkAdapterSummary[];
  readonly floors: ContextGraphBenchmarkFloorReport;
  readonly score: ContextGraphBenchmarkReport['score'];
  readonly warnings: string[];
  readonly notes: string[];
  readonly options: ContextGraphBenchmarkOptions;
}

function finalize(input: FinalizeInput): ContextGraphBenchmarkReport {
  const draft: ContextGraphBenchmarkReport = {
    schema: CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA,
    ok: input.integrity.ok && input.floors.ok && input.score !== null && input.score.passed,
    generatedAt: input.now,
    corpusRevision: input.corpusRevision,
    integrity: input.integrity,
    environment: input.environment,
    capabilities: input.capabilities,
    adapters: input.adapters,
    cases: [...input.cases].sort((left, right) =>
      left.caseId === right.caseId ? left.adapterId.localeCompare(right.adapterId) : left.caseId.localeCompare(right.caseId)
    ),
    summaries: input.summaries,
    floors: input.floors,
    score: input.score,
    warnings: [...input.warnings].sort(),
    notes: [...input.notes].sort(),
    durationMs: Date.now() - input.startedAt
  };
  if (!input.options.writeReport) return draft;
  const written = writeBenchmarkReport(input.options.root, draft, input.options.reportPath);
  if (written.leakRules.length) {
    return {
      ...draft,
      ok: false,
      integrity: { ...draft.integrity, reportLeakRules: written.leakRules, ok: false },
      score: null,
      notes: [...draft.notes, 'report_not_written:leak_rule_tripped'].sort()
    };
  }
  return { ...draft, notes: [...draft.notes, `report_written:${written.relativePath}`].sort() };
}
