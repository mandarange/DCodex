/**
 * The reader contract, frozen in ADR §3 and work-order §5.5.
 *
 * Two consequences are stated as types rather than left implicit, because an
 * implementation that leaves them implicit gets them wrong:
 *
 * - `EdgeCursor` iterates index/target/type/confidence **without allocating** a
 *   per-edge object or an intermediate array. Its fields are scalars that a
 *   single cursor overwrites in place.
 * - There is **no `getNode()`**. Whole-node materialization exists only as
 *   `hydrateNode`, and only selected nodes reach it. Everything the ranking
 *   path needs is reachable as an integer.
 */
import type {
  ContextGraphEdgeConfidence,
  ContextGraphEdgeType,
  ContextGraphFreshness,
  ContextGraphNodeKind,
  ContextGraphRisk,
} from '../contracts.js';

/** All profiles / all fields. A zero mask selects nothing — it is never "unset". */
export const CONTEXT_INDEX_PROFILE_MASK_ALL = 0xffff;
export const CONTEXT_INDEX_FIELD_MASK_ALL = 0xffff;

/**
 * The slice of `QueryPlan` the reader actually consumes.
 *
 * Typed structurally rather than as `QueryPlan` so the reader does not depend
 * on the kernel's profile and shape enums: the index knows about budgets, and
 * knows nothing about why they were chosen. A full `QueryPlan` satisfies this.
 */
export interface ContextIndexQueryBounds {
  readonly postingCapPerTerm: number;
  readonly candidateBudget: number;
}

/** A view over a posting run. Reading a posting costs one indexed load. */
export interface PostingSlice {
  readonly length: number;
  node(index: number): number;
}

export interface ScoredPostingSlice extends PostingSlice {
  /** Fixed-point, integer. Ordering must not depend on platform float rounding. */
  score(index: number): number;
  /** Terms that resolved to a posting run; a query can match fewer terms than it asked for. */
  readonly matchedTerms: number;
  /** True when a posting cap or the candidate budget cut the answer short. */
  readonly truncated: boolean;
}

/**
 * Iterates a node's edges without allocating per edge.
 *
 * One cursor is allocated per `outgoing`/`incoming` call — per visited node,
 * not per traversed edge. `next()` advances and overwrites the scalar fields;
 * nothing is retained, so a caller that wants to keep an edge must copy the
 * integers it cares about. That is deliberate: the v1 traversal's per-edge
 * object is the allocation this card exists to remove.
 */
export interface EdgeCursor {
  /** The node the cursor was opened on. */
  readonly source: number;
  /** Edge row index; -1 before the first `next()` and after exhaustion. */
  readonly edge: number;
  /** The neighbour — the edge's target when outgoing, its source when incoming. */
  readonly target: number;
  readonly type: number;
  readonly confidence: number;
  readonly flags: number;
  readonly provenance: number;
  /** Rows examined, including those the profile mask rejected. Feeds edge-visit budgets. */
  readonly visited: number;
  next(): boolean;
}

/** Integers only: the ranking path must never hold a node object. */
export interface CompactNodeScoreFields {
  readonly kind: number;
  readonly freshness: number;
  readonly risk: number;
  readonly flags: number;
  /** Quantized 0..65535, not a float. */
  readonly trust: number;
  readonly tokenCost: number;
  readonly group: number;
  readonly outDegree: number;
  readonly inDegree: number;
}

export interface ContextGraphNodeView {
  readonly node: number;
  readonly id: string;
  readonly kind: ContextGraphNodeKind;
  readonly label: string;
  readonly path?: string;
  readonly line?: number;
  readonly column?: number;
  readonly contentHash?: string;
  readonly trust: number;
  readonly freshness: ContextGraphFreshness;
  readonly risk: ContextGraphRisk;
  readonly tokenCost: number;
  readonly flags: number;
  readonly group: number;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface ContextGraphEdgeView {
  readonly edge: number;
  readonly target: number;
  readonly type: ContextGraphEdgeType;
  readonly confidence: ContextGraphEdgeConfidence;
  readonly flags: number;
  readonly profileMask: number;
  readonly provenance: ProvenanceView;
}

export interface ProvenanceView {
  readonly path: string;
  readonly line?: number;
  readonly hash: string;
  /** Absent on a node's own source record: the source table carries no extractor. */
  readonly extractor?: string;
}

export interface ContextIndexSourceHash {
  readonly path: string;
  readonly hash: string;
}

export interface ContextIndexReader {
  readonly snapshotHash: string;
  readonly configHash: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly termCount: number;
  readonly stringCount: number;
  /** Real resident byte length of the backing buffer; the cache budgets on this. */
  readonly byteLength: number;

  /**
   * Resolves a normalized term to the id `lexical`/`coarse` take, or -1 when
   * the term is not interned.
   *
   * The lexical lanes deal in integers so a query never carries a string into
   * the merge loop, which means something has to cross that boundary once. It
   * is this, and it is the reader's job rather than the caller's: the id space
   * is the index's string table, so a caller that derived ids any other way
   * would be guessing at the file's interning order.
   */
  termId(term: string): number;

  exact(term: string, fieldMask?: number): PostingSlice;
  basename(term: string): PostingSlice;
  lexical(termIds: readonly number[], plan: ContextIndexQueryBounds): ScoredPostingSlice;
  coarse(termIds: readonly number[], plan: ContextIndexQueryBounds): ScoredPostingSlice;

  outgoing(node: number, profileMask: number): EdgeCursor;
  incoming(node: number, profileMask: number): EdgeCursor;

  nodeFlags(node: number): number;
  nodeScoreFields(node: number): CompactNodeScoreFields;
  nodeTokenCost(node: number): number;
  nodeGroup(node: number): number;
  nodeTrust(node: number): number;
  nodeKind(node: number): number;
  outDegree(node: number): number;
  inDegree(node: number): number;

  hydrateNode(node: number): ContextGraphNodeView;
  hydrateEdge(edge: number): ContextGraphEdgeView;
  provenance(node: number, parentEdges: readonly number[]): readonly ProvenanceView[];

  /**
   * Compile-time source hashes. This is the one whole-section materialization
   * the reader offers, and it exists for the validation path in §7; the query
   * path must never call it.
   *
   * A list rather than a map: one path can carry more than one hash — a file
   * node and a symbol node in it are hashed separately — and a map would drop
   * all but the last, which on a validation path means silently not checking
   * the evidence it was asked to check.
   */
  sourceHashes(): readonly ContextIndexSourceHash[];
}

export interface OpenContextIndexOptions {
  /**
   * The snapshot hash the pointer claims. A disagreement is `context_index_stale`:
   * the index is intact but describes a workspace state that no longer holds.
   */
  readonly expectedSnapshotHash?: string;
  /**
   * The config fingerprint the meta claims. A disagreement is
   * `context_index_pointer_meta_divergent` — not a preference for one of them.
   */
  readonly expectedConfigHash?: string;
}
