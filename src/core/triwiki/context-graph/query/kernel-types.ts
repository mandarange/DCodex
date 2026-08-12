/**
 * The frozen CRK2 query contract, expressed as types.
 *
 * ADR §3 fixes `QueryPlan`, `CompactCandidate`, `LaneContribution` and
 * `RetrievalLane` field by field; §4 fixes the confidence mapping. Both live
 * here rather than beside the code that uses them because three cards
 * (CG2-07/08/09) and every future consumer must agree on them, and a shape
 * copied into a call site is a shape that drifts.
 *
 * Two properties are encoded structurally rather than left to discipline:
 *
 *   - **Integers only until the API boundary.** Scores decide result order, and
 *     a float score would let the same query rank differently on two machines.
 *     Internal arithmetic is fixed-point `number` (always an integer, always
 *     inside 2^53); `CompactCandidate.score` is the `bigint` the contract names,
 *     converted once at the boundary.
 *   - **A text match can never claim `exact`.** The demotion ladder below has
 *     three rungs, not six, because demoting `exact_definition` to
 *     `exact_reference` would be "one step" that left the candidate inside the
 *     exact family — which is exactly the §4 violation the rule exists to stop.
 */
import type { ContextGraphSeedConfidence } from '../query-types.js';
import type { ContextGraphOmissionReason } from '../query-types.js';
import type { ContextGraphQueryProfileName } from '../profiles.js';

export const CONTEXT_KERNEL_SCHEMA = 'sks.context-kernel.v1' as const;

/** The external profile set is unchanged by CRK2 (ADR §9); lanes are internal. */
export type ContextRetrievalProfile = ContextGraphQueryProfileName;

/**
 * How the plan reads the query. The user never picks a lane mix (§4.2): the
 * shape plus the profile decide it.
 */
export type QueryShape = 'anchored' | 'mixed' | 'natural';

export type RetrievalLane = 'anchor' | 'lexical' | 'coarse' | 'local_graph';

/**
 * Lane order is a contract, not a listing: every per-lane array in the kernel is
 * indexed by these slots, so reordering them silently reassigns telemetry and
 * fusion weights.
 */
export const LANE_SLOT = Object.freeze({ anchor: 0, lexical: 1, coarse: 2, local_graph: 3 });
export const RETRIEVAL_LANES: readonly RetrievalLane[] =
  Object.freeze(['anchor', 'lexical', 'coarse', 'local_graph'] as const);
export const LANE_COUNT = 4;

// ---------------------------------------------------------------------------
// Frozen types (ADR §3)
// ---------------------------------------------------------------------------

/** Resolved before any lane runs; lanes never re-derive it. */
export interface QueryPlan {
  readonly profile: ContextRetrievalProfile;
  readonly shape: QueryShape;
  readonly termIds: readonly number[];
  readonly fieldMask: number;
  readonly profileMask: number;
  readonly maxDepth: number;
  readonly frontierBudget: number;
  readonly postingCapPerTerm: number;
  readonly candidateBudget: number;
  readonly tokenBudget: number;
}

/** Integer-only until the final API boundary. No node objects in the hot path. */
export interface CompactCandidate {
  readonly node: number;
  readonly score: bigint;
  readonly seed: number;
  readonly parentNode: number;
  readonly parentEdge: number;
  readonly depth: number;
  readonly flags: number;
}

/** One lane's contribution to a fused candidate, kept for the receipt. */
export interface LaneContribution {
  readonly lane: RetrievalLane;
  readonly rank: number;
  readonly score: bigint;
  readonly termIds: readonly number[];
}

// ---------------------------------------------------------------------------
// Confidence (ADR §4)
// ---------------------------------------------------------------------------

/**
 * Rungs, not values. §4 demotes a graph neighbour of an exact seed "one step",
 * and the step has to cross the exact/non-exact boundary or it does nothing the
 * rule was written to do.
 */
const CONFIDENCE_RUNG: Readonly<Record<ContextGraphSeedConfidence, number>> = Object.freeze({
  exact_definition: 0,
  exact_reference: 0,
  manifest: 0,
  file_path: 0,
  syntactic_reference: 1,
  text_candidate: 2,
});

const RUNG_FLOOR: readonly ContextGraphSeedConfidence[] =
  Object.freeze(['exact_definition', 'syntactic_reference', 'text_candidate'] as const);

/** True only for the anchor lane's own confidences. A BM25F score never lands here. */
export function isExactKernelConfidence(confidence: ContextGraphSeedConfidence): boolean {
  return CONFIDENCE_RUNG[confidence] === 0;
}

/**
 * `steps` is the hop count, so a depth-2 neighbour is demoted twice. Demoting by
 * depth is a strict tightening of §4's depth-1 rule, never a loosening.
 */
export function demoteKernelConfidence(
  confidence: ContextGraphSeedConfidence,
  steps: number,
): ContextGraphSeedConfidence {
  if (steps <= 0) return confidence;
  const rung = Math.min(CONFIDENCE_RUNG[confidence] + steps, RUNG_FLOOR.length - 1);
  return RUNG_FLOOR[rung] as ContextGraphSeedConfidence;
}

/** The confidence a lane may assign before demotion. Lexical and coarse have one option. */
export function laneCeilingConfidence(lane: RetrievalLane): ContextGraphSeedConfidence {
  return lane === 'anchor' ? 'exact_reference' : 'text_candidate';
}

/**
 * Confidence as an integer, so a candidate's claim lives in the same typed
 * arrays as the rest of it. The order is strongest first and is this module's
 * own; nothing on disk depends on it.
 */
export const KERNEL_CONFIDENCE_CODES: readonly ContextGraphSeedConfidence[] = Object.freeze([
  'exact_definition',
  'exact_reference',
  'manifest',
  'file_path',
  'syntactic_reference',
  'text_candidate',
] as const);

export function kernelConfidenceCode(confidence: ContextGraphSeedConfidence): number {
  return KERNEL_CONFIDENCE_CODES.indexOf(confidence);
}

export function kernelConfidenceAt(code: number): ContextGraphSeedConfidence {
  return (KERNEL_CONFIDENCE_CODES[code] ?? 'text_candidate') as ContextGraphSeedConfidence;
}

// ---------------------------------------------------------------------------
// Candidate flags
// ---------------------------------------------------------------------------

/**
 * One bit per fact the selector needs. They are bits rather than booleans on an
 * object because the ranking path holds candidates in typed arrays — the whole
 * point of `CompactCandidate` is that nothing is materialized until selection.
 */
export const CANDIDATE_FLAG = Object.freeze({
  SEED: 1 << 0,
  EXACT_SEED: 1 << 1,
  PROTECTED: 1 << 2,
  TEST_OR_GATE: 1 << 3,
  EVIDENCE: 1 << 4,
  SAFETY: 1 << 5,
  CONFLICT: 1 << 6,
  FOCUS: 1 << 7,
  REVERSE_HOP: 1 << 8,
  PROVIDED: 1 << 9,
  /**
   * One of the node's own names — label, basename, or basename stem — is
   * exactly the query. A ranking fact, never a confidence claim: see
   * `name-anchors.ts` for why it is a flag rather than a lane.
   */
  NAME_MATCH: 1 << 10,
});

export function hasFlag(flags: number, bit: number): boolean {
  return (flags & bit) !== 0;
}

// ---------------------------------------------------------------------------
// Clock, request, telemetry
// ---------------------------------------------------------------------------

/**
 * The only clock the kernel is allowed to read. `Date.now` is never called
 * directly: a deadline cap that reads the wall clock is untestable, and a
 * traversal whose cut-off depends on machine speed is not deterministic.
 */
export type KernelClock = () => number;

export interface KernelProvidedSeed {
  readonly nodeId: string;
  readonly confidence: ContextGraphSeedConfidence;
  /**
   * The caller proved this node by resolution, not by text overlap. Only a
   * verified seed reaches the anchor lane; an unverified one is a text
   * candidate no matter what confidence the caller attached to it.
   */
  readonly verified?: boolean;
}

export interface KernelRequest {
  readonly query: string;
  readonly profile?: ContextRetrievalProfile;
  readonly risk?: 'normal' | 'high';
  readonly seeds?: readonly KernelProvidedSeed[];
  readonly focusPaths?: readonly string[];
  readonly tokenBudget?: number;
  readonly maxSelected?: number;
  readonly timeoutMs?: number;
}

/**
 * Kernel-local omission reasons, added to the shared set rather than replacing
 * it: `query-types.ts` is a shared contract this card does not own, and a lane
 * that hit its posting cap is a distinct fact from a traversal that hit a visit
 * cap. A bound that is not reported is a recall regression nothing can
 * attribute later.
 */
export type KernelOmissionReason =
  | ContextGraphOmissionReason
  | 'posting_cap'
  | 'candidate_budget'
  | 'focus_filtered'
  | 'frontier_budget'
  | 'safety_cap'
  | 'unknown_seed';

export type KernelOmissions = Partial<Record<KernelOmissionReason, number>>;

export interface LaneTelemetry {
  readonly lane: RetrievalLane;
  /** Terms that resolved to a posting run. Fewer than `termIds.length` is normal. */
  readonly matchedTerms: number;
  /**
   * Postings examined, which is what replaced v1's label/path key scan as the
   * scan-budget unit. Counting keys again would measure a structure that no
   * longer exists.
   */
  readonly postingsExamined: number;
  readonly candidates: number;
  readonly truncated: boolean;
}

export interface KernelGuarantees {
  readonly exactSeedAvailable: boolean;
  readonly exactSeedSelected: boolean;
  readonly protectedGatesReachable: number;
  readonly protectedGatesSelected: number;
  readonly conflictsReachable: number;
  readonly conflictsSelected: number;
  readonly testOrGateReachable: boolean;
  readonly testOrGateSelected: boolean;
}

export interface SelectedCandidate {
  readonly candidate: CompactCandidate;
  /** The lane that owns this candidate's confidence claim. */
  readonly lane: RetrievalLane;
  readonly confidence: ContextGraphSeedConfidence;
  readonly contributions: readonly LaneContribution[];
  readonly tokenCost: number;
  readonly group: number;
  /** Parent-edge chain, walked from parent pointers for the selected set only. */
  readonly parentEdges: readonly number[];
}

export interface ContextKernelResult {
  readonly schema: typeof CONTEXT_KERNEL_SCHEMA;
  readonly plan: QueryPlan;
  readonly selected: readonly SelectedCandidate[];
  readonly lanes: readonly LaneTelemetry[];
  readonly omissions: KernelOmissions;
  readonly warnings: readonly string[];
  readonly candidateCount: number;
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly tokenCost: number;
  readonly truncated: boolean;
  readonly timedOut: boolean;
  readonly guarantees: KernelGuarantees;
  readonly durationMs: number;
  /**
   * Structural, not aspirational: the selector keeps its top-K in a bounded heap
   * and sorts the selected set exactly once. The card's floor is "full candidate
   * sort 0", so the count is reported rather than asserted in a comment.
   */
  readonly fullCandidateSorts: 0;
  readonly selectedSorts: 1;
}

// ---------------------------------------------------------------------------
// Fixed-point helpers
// ---------------------------------------------------------------------------

/** Accumulates an omission count. A zero is not recorded: absence means none. */
export function addOmission(into: KernelOmissions, reason: KernelOmissionReason, count: number): void {
  if (count <= 0) return;
  into[reason] = (into[reason] ?? 0) + count;
}

/**
 * `a * b / scale`, rounded once. Two fixed-point factors multiply to `scale^2`,
 * so the division is what keeps the result in the same units; rounding here
 * rather than at the end is what makes a traversal chain reproducible.
 */
export function mulFixed(a: number, b: number, scale: number): number {
  return Math.round((a * b) / scale);
}
