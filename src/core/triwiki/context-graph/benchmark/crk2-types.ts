/**
 * Contracts for the Context Retrieval Kernel v2 benchmark.
 *
 * These types extend the existing benchmark framework rather than replacing it:
 * the CRK2 corpus needs a gold shape (ADR work order §13) that the v1 corpus
 * never carried — per-node must/relevant/forbidden sets, an expected error code,
 * and a confidence expectation — while recall, percentile and leak-scanning math
 * stay shared with `metrics.ts` and `floors.ts`.
 *
 * The engine arrives as an argument on every entry point here. Nothing in this
 * module reads an environment variable or a config file to decide which engine
 * answers, because a seam reachable from configuration is a fallback, and ADR §1
 * forbids fallbacks.
 */
import type { ContextGraphQueryProfileName } from '../profiles.js';
import type { ContextGraphSeedConfidence } from '../query-types.js';

export const CRK2_BENCHMARK_CORPUS_SCHEMA = 'sks.context-graph-crk2-corpus.v1' as const;
export const CRK2_BENCHMARK_COMPARISON_SCHEMA = 'sks.context-graph-crk2-comparison.v1' as const;

/**
 * Query shapes the corpus must cover. The list is the measurement contract:
 * `validateCrk2Corpus` fails when a category has no case, so a category cannot
 * quietly disappear by deleting the only case that exercised it.
 */
export const CRK2_QUERY_CATEGORIES = [
  'exact_symbol',
  'exact_node_id',
  'exact_path',
  'basename',
  'acronym',
  'camel_case_fragment',
  'snake_case_fragment',
  'jargon',
  'korean',
  'mixed_korean_english',
  'planning_nl',
  'review_nl',
  'protected_gate',
  'conflict',
  'graph_shape',
  'freshness',
  'focus_path',
  'unsupported_language',
  'corrupt_input',
  'index_state',
  'budget',
  'lifecycle',
  'determinism',
  'cache'
] as const;

export type Crk2QueryCategory = (typeof CRK2_QUERY_CATEGORIES)[number];

export function isCrk2QueryCategory(value: unknown): value is Crk2QueryCategory {
  return typeof value === 'string' && (CRK2_QUERY_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Which hermetic workspace a case is asked against.
 *
 * `crk2-retrieval` holds graph content; `crk2-fault` holds a deliberately broken
 * index. The split is an invariant, not a convenience: a case that expects an
 * error code must not be answerable from a healthy index, or "rejection" would
 * be indistinguishable from "found nothing".
 */
export const CRK2_WORKSPACES = ['crk2-retrieval', 'crk2-fault'] as const;

export type Crk2Workspace = (typeof CRK2_WORKSPACES)[number];

/**
 * A gold target that cannot be written as a literal node id.
 *
 * `symbol:` ids embed a byte offset (`ids.ts`), so a hand-written corpus can
 * never spell one; declaring the path and the symbol name instead keeps the gold
 * set authored from repository truth rather than copied from an engine's output.
 */
export type Crk2GoldMatcher =
  | { readonly kind: 'symbol'; readonly path: string; readonly name: string }
  | { readonly kind: 'path_prefix'; readonly prefix: string }
  | { readonly kind: 'id_prefix'; readonly prefix: string };

/**
 * Machine-verifiable expected answer for one case.
 *
 * `mustIncludeNodeIds` is the recall floor: every id here has to come back inside
 * the case's `k`. `relevantNodeIds` widens recall@k without being mandatory.
 * `forbiddenNodeIds` is checked against the whole answer, not the top k — a
 * forbidden node at rank 40 was still handed to the caller.
 */
export interface Crk2RetrievalGold {
  readonly mustIncludeNodeIds: readonly string[];
  readonly mustIncludeMatchers: readonly Crk2GoldMatcher[];
  readonly relevantNodeIds: readonly string[];
  readonly forbiddenNodeIds: readonly string[];
  readonly protectedGateIds: readonly string[];
  readonly gateIds: readonly string[];
  /** Parallel-write collisions the answer must surface; drives `conflictRecall`. */
  readonly conflicts: readonly Crk2Conflict[];
  /** Set when the case is a rejection case; the engine must fail closed with exactly this code. */
  readonly expectedErrorCode?: string;
  readonly maxTokenCost?: number;
  /** Per-node confidence the answer must carry, keyed by literal node id (work order §13). */
  readonly requiredConfidence?: Readonly<Record<string, ContextGraphSeedConfidence>>;
  /**
   * Strongest confidence any returned node may claim.
   *
   * ADR §4: a BM25F match never yields `exact` at any magnitude, and an
   * unsupported-language result is never promoted to an exact relation. The
   * `korean` and `jargon` cases carry this ceiling so "fixing" their recall by
   * mislabelling a text hit registers as a floor breach instead of a win.
   */
  readonly confidenceCeiling?: ContextGraphSeedConfidence;
}

export interface Crk2Conflict {
  readonly path: string;
  readonly slices: readonly string[];
}

export interface Crk2Case {
  readonly id: string;
  readonly title: string;
  readonly query: string;
  readonly category: Crk2QueryCategory;
  readonly workspace: Crk2Workspace;
  readonly profile: ContextGraphQueryProfileName;
  readonly changedPaths: readonly string[];
  readonly focusPaths: readonly string[];
  readonly tokenBudget: number;
  readonly risk: 'normal' | 'high';
  readonly k: number;
  readonly gold: Crk2RetrievalGold;
  /**
   * Why the case exists, in one line. Read by whoever is tempted to weaken the
   * gold set later; the reason has to survive the edit or the edit is wrong.
   */
  readonly rationale: string;
}

export interface Crk2Corpus {
  readonly schema: typeof CRK2_BENCHMARK_CORPUS_SCHEMA;
  readonly corpusRevision: string;
  readonly defaultK: number;
  readonly cases: readonly Crk2Case[];
}

/** What an engine is asked. Identical for v1 and v2 — the seam compares answers, not inputs. */
export interface Crk2EngineRequest {
  readonly caseId: string;
  /** Absolute path to a materialized hermetic workspace. Never written into a report. */
  readonly root: string;
  readonly workspace: Crk2Workspace;
  readonly query: string;
  readonly profile: ContextGraphQueryProfileName;
  readonly changedPaths: readonly string[];
  readonly focusPaths: readonly string[];
  readonly tokenBudget: number;
  readonly risk: 'normal' | 'high';
  readonly k: number;
  readonly iteration: number;
  /** Injected clock; an engine that calls `Date.now()` instead is non-deterministic by construction. */
  readonly now: string;
}

/**
 * One engine's answer.
 *
 * `provenanceNodeIds` is the subset of `nodeIds` that carries at least one
 * provenance record, so coverage is derived by the harness rather than reported
 * as a number the engine chose. A self-reported coverage figure proves nothing.
 */
export interface Crk2EngineResult {
  readonly ok: boolean;
  readonly errorCode: string | null;
  /** Ranked node ids, best first. */
  readonly nodeIds: readonly string[];
  readonly provenanceNodeIds: readonly string[];
  readonly confidenceByNodeId: Readonly<Record<string, ContextGraphSeedConfidence>>;
  readonly selectedGateIds: readonly string[];
  /** Gates dropped because the token budget could not fit them; ADR quality target requires a warning. */
  readonly droppedGateIds: readonly string[];
  readonly conflicts: readonly Crk2Conflict[];
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly cacheHit: boolean;
}

export interface Crk2Engine {
  readonly id: string;
  /**
   * Which side of the comparison this engine is. The seam takes both engines as
   * explicit arguments and checks these tags, so a caller cannot accidentally
   * compare an engine with itself and report a 0% regression.
   */
  readonly version: 'v1' | 'v2';
  run(request: Crk2EngineRequest): Promise<Crk2EngineResult>;
}

/** p99 is carried alongside p50/p95 because tail latency is where an unbounded scan shows up. */
export interface Crk2LatencyProfile {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}

export interface Crk2CaseMetrics {
  readonly caseId: string;
  readonly category: Crk2QueryCategory;
  readonly engineId: string;
  readonly engineVersion: 'v1' | 'v2';
  readonly k: number;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly expectedErrorCode: string | null;
  /** Null when the case is not a rejection case; true/false only where rejection is the answer. */
  readonly rejectionCorrect: boolean | null;
  readonly mustIncludeRecall: number;
  readonly missingMustInclude: readonly string[];
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly provenanceCoverage: number;
  readonly protectedGateRecall: number;
  readonly gateRecall: number;
  readonly conflictRecall: number;
  /**
   * How much this case actually asked for. Aggregates average a recall only over
   * the cases that declared it, so one missed protected gate cannot be diluted
   * into a rounding error by fifty cases that never mentioned a gate.
   */
  readonly declaredMustIncludeCount: number;
  readonly declaredGateCount: number;
  readonly declaredProtectedGateCount: number;
  readonly declaredConflictCount: number;
  readonly forbiddenViolations: readonly string[];
  readonly confidenceViolations: readonly string[];
  readonly tokenCost: number;
  readonly tokenBudgetRespected: boolean;
  /** True when a protected gate was dropped for budget and the engine said so. */
  readonly droppedGateWarned: boolean;
  readonly latency: Crk2LatencyProfile;
  readonly determinismMismatches: number;
}

export interface Crk2EngineSummary {
  readonly engineId: string;
  readonly engineVersion: 'v1' | 'v2';
  readonly caseCount: number;
  readonly okRate: number;
  readonly mustIncludeRecall: number;
  readonly recallAtK: number;
  readonly precisionAtK: number;
  readonly provenanceCoverage: number;
  readonly protectedGateRecall: number;
  readonly gateRecall: number;
  readonly conflictRecall: number;
  readonly forbiddenViolations: number;
  readonly confidenceViolations: number;
  readonly determinismMismatches: number;
  readonly rejectionCases: number;
  readonly rejectionCorrect: number;
  readonly rejectionRate: number;
  readonly droppedGateWarnings: number;
  readonly meanTokenCost: number;
  readonly latency: Crk2LatencyProfile;
  /** Recall and latency are only ever published per category together; see `Crk2CategoryStat`. */
  readonly categories: readonly Crk2CategoryStat[];
}

/**
 * Recall and latency for one category, in one record.
 *
 * The v1 baseline recorded `korean` and `jargon` as the fastest cases; they were
 * fast because they found nothing. Latency has no separate home in this report,
 * so a category's speed cannot be quoted without its recall beside it.
 */
export interface Crk2CategoryStat {
  readonly category: Crk2QueryCategory;
  readonly caseCount: number;
  readonly mustIncludeRecall: number;
  readonly recallAtK: number;
  readonly latency: Crk2LatencyProfile;
}

export const CRK2_FLOOR_IDS = [
  'provenance_coverage_exact',
  'protected_gate_recall_exact',
  'conflict_recall_exact',
  'determinism_zero_mismatch',
  'corrupt_input_rejection_exact',
  'forbidden_node_zero',
  'unsupported_language_exact_mislabel_zero'
] as const;

export type Crk2FloorId = (typeof CRK2_FLOOR_IDS)[number];

export interface Crk2FloorResult {
  readonly id: Crk2FloorId;
  readonly label: string;
  readonly engineId: string;
  readonly engineVersion: 'v1' | 'v2';
  readonly passed: boolean;
  readonly observed: number;
  readonly required: number;
  /** Every CRK2 floor is an equality. There is no `gte` variant to slide. */
  readonly comparison: 'eq';
  /** Case ids and rule ids only. Never a path outside the workspace, never matched text. */
  readonly detail: readonly string[];
}

export interface Crk2FloorReport {
  readonly ok: boolean;
  readonly evaluated: number;
  readonly failed: number;
  readonly results: readonly Crk2FloorResult[];
}

/**
 * Per-case verdict of the paired run.
 *
 * `fast_but_empty` is the reading the baseline warns about: v2 answered faster
 * while its must-include recall stayed at or below v1 and short of 1. That is a
 * regression wearing a latency win's clothes.
 */
export type Crk2CaseVerdict =
  | 'improved'
  | 'unchanged'
  | 'recall_regression'
  | 'fast_but_empty'
  | 'rejection_mismatch';

export interface Crk2CaseComparison {
  readonly caseId: string;
  readonly category: Crk2QueryCategory;
  readonly v1: Crk2CaseMetrics;
  readonly v2: Crk2CaseMetrics;
  readonly mustIncludeRecallDelta: number;
  readonly recallAtKDelta: number;
  readonly latencyP95Delta: number;
  readonly latencyP99Delta: number;
  readonly verdict: Crk2CaseVerdict;
}

export interface Crk2ComparisonReport {
  readonly schema: typeof CRK2_BENCHMARK_COMPARISON_SCHEMA;
  readonly ok: boolean;
  readonly generatedAt: string;
  readonly corpusRevision: string;
  readonly caseCount: number;
  readonly repeats: number;
  readonly warmups: number;
  readonly v1: Crk2EngineSummary;
  readonly v2: Crk2EngineSummary;
  readonly cases: readonly Crk2CaseComparison[];
  readonly floors: Crk2FloorReport;
  readonly regressions: readonly string[];
  readonly notes: readonly string[];
}
