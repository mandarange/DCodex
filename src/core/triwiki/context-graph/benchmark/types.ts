/**
 * Contracts for the locked Context Graph benchmark.
 *
 * The benchmark never imports the query engine or an extractor: retrieval
 * implementations arrive as injected adapters so the harness can measure a
 * lexical baseline and a graph candidate through one identical interface.
 *
 * `v1` here is a machine schema revision, not a product version.
 */
import type { ContextGraphQueryProfileName } from '../profiles.js';

export const CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA = 'sks.context-graph-benchmark-corpus.v1' as const;
export const CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA = 'sks.context-graph-benchmark.v1' as const;
export const CONTEXT_GRAPH_BENCHMARK_CORPUS_FILE = 'config/context-graph-benchmark.json' as const;

/** Hermetic fixture repositories the corpus is allowed to reference. */
export const CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES = [
  'ts-path-alias',
  'reexport-chain',
  'dynamic-import-literal',
  'cyclic-modules',
  'command-route-pipeline-gate',
  'test-production-binding',
  'proof-invalidation',
  'stale-wiki-claim',
  'parallel-write-conflict',
  'secret-and-path-redaction',
  'dirty-and-untracked',
  'large-repo-incremental',
  'malformed-manifest',
  'symlink-escape'
] as const;

export type ContextGraphBenchmarkFixtureFamily = (typeof CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES)[number];

export function isContextGraphBenchmarkFixtureFamily(value: unknown): value is ContextGraphBenchmarkFixtureFamily {
  return typeof value === 'string' && (CONTEXT_GRAPH_BENCHMARK_FIXTURE_FAMILIES as readonly string[]).includes(value);
}

/** Cold and warm runs are collected and reported separately; they are never averaged together. */
export type ContextGraphBenchmarkMode = 'cold' | 'warm';

export type ContextGraphBenchmarkAdapterKind = 'baseline' | 'candidate';

/** A parallel-write collision: one file two independent slices both intend to write. */
export interface ContextGraphBenchmarkConflict {
  readonly path: string;
  readonly slices: readonly string[];
}

/**
 * Machine-verifiable expected answer. Every field is a set of identifiers that
 * can be checked mechanically; there is deliberately no free-text or
 * model-judged field anywhere in the corpus.
 */
export interface ContextGraphBenchmarkGold {
  readonly paths: readonly string[];
  readonly nodeIds: readonly string[];
  readonly gateIds: readonly string[];
  readonly protectedGateIds: readonly string[];
  readonly testPaths: readonly string[];
  readonly conflicts: readonly ContextGraphBenchmarkConflict[];
  /** Paths a correct answer must NOT return (stale claims, redacted files, escaped symlinks). */
  readonly mustExcludePaths: readonly string[];
  readonly stalePaths: readonly string[];
  readonly invalidatedPaths: readonly string[];
  /** Seeds that entered as exact symbol hits and must still be exact in the answer. */
  readonly exactSeedPaths: readonly string[];
}

export interface ContextGraphBenchmarkCase {
  readonly id: string;
  readonly title: string;
  readonly query: string;
  readonly profile: ContextGraphQueryProfileName;
  readonly fixture: ContextGraphBenchmarkFixtureFamily;
  readonly changedPaths: readonly string[];
  readonly focusPaths: readonly string[];
  readonly tokenBudget: number;
  readonly risk: 'normal' | 'high';
  readonly k: number;
  readonly gold: ContextGraphBenchmarkGold;
}

export const CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS = [
  'secret_leak_zero',
  'path_leak_zero',
  'dangling_edge_zero',
  'edge_without_provenance_zero',
  'deterministic_snapshot_zero_mismatch',
  'protected_gate_recall_full',
  'write_scope_conflict_recall_full',
  'stale_graph_silent_fallback_zero',
  'unsupported_language_exact_mislabel_zero',
  'project_code_execution_zero',
  'unbounded_hot_path_scan_zero'
] as const;

export type ContextGraphBenchmarkFloorId = (typeof CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS)[number];

export function isContextGraphBenchmarkFloorId(value: unknown): value is ContextGraphBenchmarkFloorId {
  return typeof value === 'string' && (CONTEXT_GRAPH_BENCHMARK_FLOOR_IDS as readonly string[]).includes(value);
}

/** Fixture families that exist to prove a safety floor rather than to score retrieval. */
export interface ContextGraphBenchmarkSafetyProbe {
  readonly id: string;
  readonly fixture: ContextGraphBenchmarkFixtureFamily;
  readonly floor: ContextGraphBenchmarkFloorId;
  readonly expectation: string;
}

export interface ContextGraphBenchmarkScoreWeights {
  readonly taskContextSuccess: number;
  readonly retrievalRecall: number;
  readonly precision: number;
  readonly evidencePerKiloToken: number;
  readonly latencyImprovement: number;
  readonly tokenImprovement: number;
}

export interface ContextGraphBenchmarkCorpus {
  readonly schema: typeof CONTEXT_GRAPH_BENCHMARK_CORPUS_SCHEMA;
  readonly corpusRevision: string;
  readonly corpusHash: string;
  readonly hashAlgorithm: 'sha256';
  readonly improvementThreshold: number;
  readonly defaultK: number;
  readonly scoreWeights: ContextGraphBenchmarkScoreWeights;
  readonly cases: readonly ContextGraphBenchmarkCase[];
  readonly safetyProbes: readonly ContextGraphBenchmarkSafetyProbe[];
}

/** What an adapter is asked to answer. `root` is a materialized hermetic fixture, never the real repository. */
export interface ContextGraphBenchmarkQuery {
  readonly caseId: string;
  readonly root: string;
  readonly fixture: ContextGraphBenchmarkFixtureFamily;
  readonly query: string;
  readonly profile: ContextGraphQueryProfileName;
  readonly changedPaths: readonly string[];
  readonly focusPaths: readonly string[];
  readonly tokenBudget: number;
  readonly risk: 'normal' | 'high';
  readonly k: number;
  readonly mode: ContextGraphBenchmarkMode;
  readonly iteration: number;
  /** Injected clock so an adapter can stay deterministic under test. */
  readonly now: string;
}

/**
 * Safety observations an adapter must self-report. These are evaluated as hard
 * floors before any score is computed; an adapter that cannot observe a field
 * should leave the conservative default from `emptyBenchmarkSafety()`.
 */
export interface ContextGraphBenchmarkSafety {
  /** Redaction rule ids only. Never the matched text. */
  readonly secretLeaks: readonly string[];
  readonly pathLeaks: readonly string[];
  readonly danglingEdges: number;
  readonly edgesWithoutProvenance: number;
  readonly snapshotHash: string | null;
  /** Hash of an independent recompile of the same input; must equal `snapshotHash`. */
  readonly determinismHash: string | null;
  /** True when a missing/stale graph was silently answered from text search instead of surfacing an error. */
  readonly silentTextFallback: boolean;
  /** Results claimed as `exact` that came from a language the extractor does not support. */
  readonly unsupportedLanguageExactClaims: readonly string[];
  readonly projectCodeExecutions: number;
  readonly processSpawns: number;
  readonly scannedFiles: number;
  readonly scanBudget: number;
}

export function emptyBenchmarkSafety(overrides: Partial<ContextGraphBenchmarkSafety> = {}): ContextGraphBenchmarkSafety {
  return {
    secretLeaks: [],
    pathLeaks: [],
    danglingEdges: 0,
    edgesWithoutProvenance: 0,
    snapshotHash: null,
    determinismHash: null,
    silentTextFallback: false,
    unsupportedLanguageExactClaims: [],
    projectCodeExecutions: 0,
    processSpawns: 0,
    scannedFiles: 0,
    scanBudget: Number.MAX_SAFE_INTEGER,
    ...overrides
  };
}

export interface ContextGraphBenchmarkRun {
  readonly caseId: string;
  readonly adapterId: string;
  readonly mode: ContextGraphBenchmarkMode;
  readonly iteration: number;
  readonly ok: boolean;
  /** `context_graph_missing` / `context_graph_stale` / `context_graph_corrupt` / `adapter_error`. */
  readonly errorCode: string | null;
  /** Workspace-relative POSIX paths in rank order. */
  readonly matchedPaths: readonly string[];
  /** Graph node ids in rank order. */
  readonly matchedNodeIds: readonly string[];
  readonly selectedGateIds: readonly string[];
  readonly selectedTestPaths: readonly string[];
  readonly writeScopeConflicts: readonly ContextGraphBenchmarkConflict[];
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
  /** 0..1 fraction of returned items carrying at least one provenance record. */
  readonly provenanceCoverage: number;
  readonly staleIncluded: readonly string[];
  readonly invalidatedIncluded: readonly string[];
  readonly exactSeedsPreserved: readonly string[];
  readonly safety: ContextGraphBenchmarkSafety;
}

export interface ContextGraphBenchmarkAdapter {
  readonly id: string;
  readonly kind: ContextGraphBenchmarkAdapterKind;
  run(query: ContextGraphBenchmarkQuery): Promise<ContextGraphBenchmarkRun>;
}

export interface ContextGraphBenchmarkLatency {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly min: number;
  readonly max: number;
}

export interface ContextGraphBenchmarkCaseMetrics {
  readonly caseId: string;
  readonly adapterId: string;
  readonly adapterKind: ContextGraphBenchmarkAdapterKind;
  readonly ok: boolean;
  readonly k: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly nodeRecallAtK: number;
  readonly gateRecall: number;
  readonly protectedGateRecall: number;
  readonly testRecall: number;
  readonly conflictRecall: number;
  readonly provenanceCoverage: number;
  readonly exclusionCorrect: boolean;
  readonly mustExcludeViolations: readonly string[];
  readonly exactSeedPreservation: number;
  readonly usefulEvidence: number;
  readonly tokenCost: number;
  readonly taskContextSuccess: boolean;
  readonly coldLatency: ContextGraphBenchmarkLatency;
  readonly warmLatency: ContextGraphBenchmarkLatency;
  readonly coldRuns: number;
  readonly warmRuns: number;
  readonly coldCacheHits: number;
  readonly warmCacheHits: number;
}

export interface ContextGraphBenchmarkAdapterSummary {
  readonly adapterId: string;
  readonly adapterKind: ContextGraphBenchmarkAdapterKind;
  readonly caseCount: number;
  readonly okRate: number;
  readonly taskContextSuccess: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly nodeRecallAtK: number;
  readonly gateRecall: number;
  readonly protectedGateRecall: number;
  readonly testRecall: number;
  readonly conflictRecall: number;
  readonly provenanceCoverage: number;
  readonly exclusionCorrectRate: number;
  readonly exactSeedPreservation: number;
  readonly meanTokenCost: number;
  readonly usefulEvidencePerKiloToken: number;
  readonly coldLatency: ContextGraphBenchmarkLatency;
  readonly warmLatency: ContextGraphBenchmarkLatency;
  readonly warmCacheHitRate: number;
  readonly coldCacheHits: number;
}

export interface ContextGraphBenchmarkFloorResult {
  readonly id: ContextGraphBenchmarkFloorId;
  readonly label: string;
  readonly appliesTo: 'all' | 'candidate';
  readonly adapterId: string;
  readonly adapterKind: ContextGraphBenchmarkAdapterKind;
  readonly passed: boolean;
  readonly observed: number;
  readonly limit: number;
  readonly comparison: 'lte' | 'gte';
  /** Rule ids / case ids only. Never raw text, paths outside the workspace, or tool output. */
  readonly detail: readonly string[];
}

export interface ContextGraphBenchmarkFloorReport {
  readonly ok: boolean;
  readonly evaluated: number;
  readonly failed: number;
  readonly results: readonly ContextGraphBenchmarkFloorResult[];
}

export interface ContextGraphBenchmarkScoreComponents {
  readonly taskContextSuccess: number;
  readonly retrievalRecall: number;
  readonly precision: number;
  readonly evidencePerKiloToken: number;
  readonly latencyImprovement: number;
  readonly tokenImprovement: number;
}

export interface ContextGraphBenchmarkSideScore {
  readonly adapterId: string;
  readonly adapterKind: ContextGraphBenchmarkAdapterKind;
  readonly components: ContextGraphBenchmarkScoreComponents;
  readonly weighted: ContextGraphBenchmarkScoreComponents;
  readonly composite: number;
}

export interface ContextGraphBenchmarkScore {
  readonly weights: ContextGraphBenchmarkScoreWeights;
  readonly baseline: ContextGraphBenchmarkSideScore;
  readonly candidate: ContextGraphBenchmarkSideScore;
  readonly improvement: number;
  readonly threshold: number;
  readonly passed: boolean;
  readonly latencyImprovementRatio: number;
  readonly tokenImprovementRatio: number;
}

export interface ContextGraphBenchmarkMachineProfile {
  readonly platform: string;
  readonly arch: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly totalMemoryMb: number;
  readonly nodeMajor: number;
}

export interface ContextGraphBenchmarkEnvironment {
  readonly gitSha: string | null;
  readonly gitBranch: string | null;
  readonly gitState: 'clean' | 'dirty' | 'unknown';
  /** sha256 of the porcelain status; the status text itself is never stored. */
  readonly dirtyFingerprint: string;
  readonly dirtyEntryCount: number;
  readonly machine: ContextGraphBenchmarkMachineProfile;
}

export interface ContextGraphBenchmarkCapabilities {
  readonly adapters: readonly string[];
  readonly gitAvailable: boolean;
  readonly symlinkSupported: boolean;
  readonly fixtureFamilies: readonly string[];
  readonly coldIterations: number;
  readonly warmIterations: number;
}

export interface ContextGraphBenchmarkIntegrity {
  readonly corpusHash: string;
  readonly expectedCorpusHash: string;
  readonly corpusHashOk: boolean;
  readonly scoringCodeHash: string | null;
  readonly expectedScoringCodeHash: string | null;
  readonly scoringCodeHashOk: boolean;
  readonly reportLeakRules: readonly string[];
  readonly ok: boolean;
}

export interface ContextGraphBenchmarkReport {
  readonly schema: typeof CONTEXT_GRAPH_BENCHMARK_REPORT_SCHEMA;
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly corpusRevision: string;
  readonly integrity: ContextGraphBenchmarkIntegrity;
  readonly environment: ContextGraphBenchmarkEnvironment;
  readonly capabilities: ContextGraphBenchmarkCapabilities;
  readonly adapters: readonly { readonly id: string; readonly kind: ContextGraphBenchmarkAdapterKind }[];
  readonly cases: readonly ContextGraphBenchmarkCaseMetrics[];
  readonly summaries: readonly ContextGraphBenchmarkAdapterSummary[];
  readonly floors: ContextGraphBenchmarkFloorReport;
  readonly score: ContextGraphBenchmarkScore | null;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
  readonly durationMs: number;
}
