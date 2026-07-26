/**
 * Contracts for the bounded, benchmark-driven tuning loop.
 *
 * The loop is an *experiment* runner, not an autonomous code editor. A candidate
 * is a structured set of numeric parameter overrides applied in memory; nothing
 * in this module can produce, apply, or stage a source edit. The only thing a
 * winning experiment yields is a proposed-patch artifact under the workspace
 * report directory, which a human still has to read and apply by hand.
 *
 * `v1` in the schema constants is a machine schema revision for these records,
 * not a product version.
 */
import type { ContextGraphQueryProfile, ContextGraphQueryProfileName, ContextGraphTraversalCaps } from '../profiles.js';
import type { ContextGraphRankingConfig } from '../query/ranking-config.js';
import type { ContextGraphBenchmarkAdapter, ContextGraphBenchmarkReport } from '../benchmark/types.js';
import type { ContextGraphBenchmarkOptions } from '../benchmark/runner.js';

export const CONTEXT_GRAPH_OPTIMIZER_SCHEMA = 'sks.context-graph-optimizer.v1' as const;
export const CONTEXT_GRAPH_EXPERIMENT_LOG_SCHEMA = 'sks.context-graph-experiment.v1' as const;
export const CONTEXT_GRAPH_PATCH_ARTIFACT_SCHEMA = 'sks.context-graph-tuning-patch.v1' as const;

/**
 * The two files a candidate is allowed to propose a change to, and the symbolic
 * name each one is addressed by. Nothing else in the repository is reachable
 * from an override.
 */
export const CONTEXT_GRAPH_TUNING_TARGETS = ['ranking-config', 'profiles'] as const;

export type ContextGraphTuningTarget = (typeof CONTEXT_GRAPH_TUNING_TARGETS)[number];

export function isContextGraphTuningTarget(value: unknown): value is ContextGraphTuningTarget {
  return typeof value === 'string' && (CONTEXT_GRAPH_TUNING_TARGETS as readonly string[]).includes(value);
}

/**
 * How a file a candidate names is classified.
 * - `tunable`: one of the two allowlisted tuning surfaces.
 * - `measurement`: the benchmark corpus, its fixtures, or its scoring code.
 *   Naming one of these is an integrity violation, not an ordinary rejection.
 * - `forbidden`: everything else.
 */
export type ContextGraphPatchTargetClass = 'tunable' | 'measurement' | 'forbidden';

export type ContextGraphTunableKind = 'integer' | 'real';

/** A single tunable number: where it lives, what it is today, and how far it may move. */
export interface ContextGraphTunableParameter {
  readonly target: ContextGraphTuningTarget;
  /** Dot path inside the target's own namespace, e.g. `depthDecay` or `profiles.review.edgeWeights.tests`. */
  readonly pointer: string;
  readonly baseline: number;
  readonly kind: ContextGraphTunableKind;
  readonly min: number;
  readonly max: number;
  /** Why this bound exists, for the artifact a reviewer reads. */
  readonly rule: string;
}

export interface ContextGraphParameterOverride {
  readonly target: ContextGraphTuningTarget;
  readonly pointer: string;
  readonly value: number;
}

export interface ContextGraphExperimentCandidate {
  readonly id: string;
  readonly label: string;
  readonly rationale: string;
  readonly overrides: readonly ContextGraphParameterOverride[];
}

export type ContextGraphCandidateRejectionCode =
  | 'invalid_candidate_id'
  | 'empty_candidate'
  | 'too_many_overrides'
  | 'unknown_target'
  | 'file_not_allowlisted'
  | 'benchmark_integrity_violation'
  | 'unknown_parameter'
  | 'value_not_finite'
  | 'value_not_integer'
  | 'value_out_of_bounds'
  | 'duplicate_parameter'
  | 'no_op_candidate';

/** Rejection detail carries ids, pointers and numbers only — never file contents or raw text. */
export interface ContextGraphCandidateRejection {
  readonly code: ContextGraphCandidateRejectionCode;
  readonly target: string | null;
  readonly pointer: string | null;
  readonly detail: string;
}

export type ContextGraphCandidateVerdictKind = 'accepted' | 'rejected' | 'integrity_violation';

/** Fully materialized tuning values for one experiment. Held in memory only. */
export interface ContextGraphResolvedTuning {
  readonly ranking: ContextGraphRankingConfig;
  readonly profiles: Readonly<Record<ContextGraphQueryProfileName, ContextGraphQueryProfile>>;
  readonly traversalCaps: ContextGraphTraversalCaps;
  /** `target:pointer` for every override that actually changed a value, sorted. */
  readonly appliedPointers: readonly string[];
}

export interface ContextGraphCandidateVerdict {
  readonly candidateId: string;
  readonly kind: ContextGraphCandidateVerdictKind;
  readonly rejections: readonly ContextGraphCandidateRejection[];
  /** Present only when `kind === 'accepted'`. */
  readonly tuning: ContextGraphResolvedTuning | null;
}

export type ContextGraphExperimentOutcome =
  | 'baseline'
  | 'kept'
  | 'discarded_no_gain'
  | 'discarded_floor'
  | 'discarded_integrity'
  | 'discarded_error'
  | 'rejected'
  | 'integrity_violation'
  | 'skipped_budget';

export interface ContextGraphExperimentBudget {
  readonly caseIds: readonly string[];
  readonly coldIterations: number;
  readonly warmIterations: number;
  readonly maxCandidates: number;
  readonly maxDurationMs: number;
}

/** One JSONL row. Every field is an id, a code, a pointer, or a number. */
export interface ContextGraphExperimentRecord {
  readonly schema: typeof CONTEXT_GRAPH_EXPERIMENT_LOG_SCHEMA;
  readonly ts: string;
  readonly runId: string;
  readonly experimentId: string;
  readonly candidateId: string | null;
  readonly label: string;
  readonly outcome: ContextGraphExperimentOutcome;
  readonly verdict: ContextGraphCandidateVerdictKind | null;
  readonly rejectionCodes: readonly string[];
  readonly overrides: readonly ContextGraphParameterOverride[];
  readonly appliedPointers: readonly string[];
  readonly corpusRevision: string | null;
  readonly corpusHash: string | null;
  readonly scoringCodeHash: string | null;
  readonly baselineComposite: number | null;
  readonly candidateComposite: number | null;
  readonly compositeDelta: number | null;
  readonly improvement: number | null;
  readonly floorsOk: boolean | null;
  readonly failedFloorIds: readonly string[];
  readonly budget: ContextGraphExperimentBudget;
  readonly surfaceDigest: string;
  readonly surfaceDrift: readonly string[];
  /** Workspace-relative POSIX path of the proposed-patch artifact, when one was emitted. */
  readonly artifactPath: string | null;
  readonly reviewRequired: boolean;
  readonly durationMs: number;
}

export interface ContextGraphPatchOverrideDetail {
  readonly target: ContextGraphTuningTarget;
  /** Workspace-relative POSIX path of the file a reviewer would edit. */
  readonly file: string;
  readonly pointer: string;
  readonly from: number;
  readonly to: number;
  readonly min: number;
  readonly max: number;
  readonly rule: string;
}

/** Everything needed to re-run this exact experiment and reach the same verdict. */
export interface ContextGraphPatchReceipt {
  readonly corpusRevision: string;
  readonly corpusHash: string;
  readonly scoringCodeHash: string | null;
  readonly budget: ContextGraphExperimentBudget;
  readonly generatedAt: string;
  readonly surfaceDigest: string;
  /** Exported function that reproduces this experiment, with the budget above. */
  readonly rerunEntryPoint: string;
}

export interface ContextGraphTuningPatchArtifact {
  readonly schema: typeof CONTEXT_GRAPH_PATCH_ARTIFACT_SCHEMA;
  readonly runId: string;
  readonly experimentId: string;
  readonly candidateId: string;
  readonly label: string;
  readonly rationale: string;
  readonly overrides: readonly ContextGraphPatchOverrideDetail[];
  readonly baselineComposite: number;
  readonly candidateComposite: number;
  readonly compositeDelta: number;
  readonly improvement: number;
  readonly floorsOk: boolean;
  readonly receipt: ContextGraphPatchReceipt;
  /** Always true. A winning experiment is a proposal, never an approval. */
  readonly reviewRequired: boolean;
  readonly applyInstructions: readonly string[];
}

export interface ContextGraphSurfaceFile {
  readonly path: string;
  readonly sha256: string;
}

export interface ContextGraphSurfaceFingerprint {
  readonly files: readonly ContextGraphSurfaceFile[];
  readonly digest: string;
}

export interface ContextGraphOptimizerAdapterInput {
  readonly experimentId: string;
  /** `null` for the baseline experiment, which runs the checked-in values. */
  readonly candidateId: string | null;
  readonly tuning: ContextGraphResolvedTuning;
}

/**
 * Supplies the pair of adapters the benchmark measures. The loop never
 * constructs a retrieval engine itself: it hands the resolved tuning to the
 * caller and measures whatever comes back, exactly as the benchmark does.
 */
export type ContextGraphOptimizerAdapterFactory = (
  input: ContextGraphOptimizerAdapterInput
) => readonly ContextGraphBenchmarkAdapter[] | Promise<readonly ContextGraphBenchmarkAdapter[]>;

export type ContextGraphBenchmarkRunner = (
  adapters: readonly ContextGraphBenchmarkAdapter[],
  options: ContextGraphBenchmarkOptions
) => Promise<ContextGraphBenchmarkReport>;

export interface ContextGraphOptimizerRunResult {
  readonly schema: typeof CONTEXT_GRAPH_OPTIMIZER_SCHEMA;
  readonly ok: boolean;
  readonly runId: string;
  readonly generatedAt: string;
  readonly budget: ContextGraphExperimentBudget;
  readonly baseline: ContextGraphExperimentRecord | null;
  readonly experiments: readonly ContextGraphExperimentRecord[];
  readonly kept: readonly ContextGraphTuningPatchArtifact[];
  readonly best: ContextGraphTuningPatchArtifact | null;
  readonly surfaceDigestBefore: string;
  readonly surfaceDigestAfter: string;
  readonly surfaceDrift: readonly string[];
  readonly abortReason: string | null;
  readonly reviewRequired: boolean;
  readonly notes: readonly string[];
  readonly durationMs: number;
}
