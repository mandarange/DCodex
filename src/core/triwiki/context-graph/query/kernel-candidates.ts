/**
 * The candidate table: integer columns, one row per distinct node.
 *
 * This is the structure that keeps the ranking path free of node objects. Every
 * fact the fusion and selection passes need is a `number` in a typed array
 * indexed by slot, and a node is admitted at most once — deduped on its integer
 * id, which is also the tie-break the contract fixes, because the writer assigns
 * integers in sorted node-id order.
 *
 * The table is sized by `candidateBudget` and never grows. Overflow is counted,
 * not accommodated: a budget that quietly expands is a budget that stops
 * bounding anything, and the count is what tells a caller its answer was cut.
 */
import type { ContextGraphSeedConfidence } from '../query-types.js';
import {
  LANE_COUNT,
  LANE_SLOT,
  RETRIEVAL_LANES,
  kernelConfidenceAt,
  kernelConfidenceCode,
  type RetrievalLane,
} from './kernel-types.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';

export const NO_SLOT = -1;
export const NO_NODE = -1;
export const NO_EDGE = -1;

/** `text_candidate`: the floor every candidate starts at until a lane claims better. */
const WEAKEST_CONFIDENCE_CODE = kernelConfidenceCode('text_candidate');

export class CandidateTable {
  readonly capacity: number;
  size = 0;
  /** Nodes a lane produced after the table was full. Reported, never absorbed. */
  overflow = 0;

  readonly node: Int32Array;
  readonly seed: Int32Array;
  readonly parentNode: Int32Array;
  readonly parentEdge: Int32Array;
  readonly depth: Int32Array;
  readonly flags: Int32Array;
  readonly group: Int32Array;
  readonly tokenCost: Int32Array;
  readonly nodeFlags: Int32Array;
  /** Fixed-point traversal score; the graph lane's own contribution. */
  readonly graphScore: Int32Array;
  /** Term id that produced an anchor hit, for the receipt. `-1` when none. */
  readonly anchorTerm: Int32Array;
  /** `KERNEL_CONFIDENCE_CODES` index — the candidate's §4 claim, as an integer. */
  readonly confidence: Int32Array;
  /** `LANE_SLOT` of the lane that owns the confidence claim; `-1` until one does. */
  readonly originLane: Int32Array;
  /** Rank + 1 per lane, so `0` means "this lane did not produce it". */
  readonly laneRank: Int32Array;
  readonly laneScore: Int32Array;

  private readonly slots = new Map<number, number>();

  constructor(capacity: number) {
    this.capacity = Math.max(0, Math.trunc(capacity));
    this.node = new Int32Array(this.capacity);
    this.seed = new Int32Array(this.capacity);
    this.parentNode = new Int32Array(this.capacity);
    this.parentEdge = new Int32Array(this.capacity);
    this.depth = new Int32Array(this.capacity);
    this.flags = new Int32Array(this.capacity);
    this.group = new Int32Array(this.capacity);
    this.tokenCost = new Int32Array(this.capacity);
    this.nodeFlags = new Int32Array(this.capacity);
    this.graphScore = new Int32Array(this.capacity);
    this.anchorTerm = new Int32Array(this.capacity);
    this.confidence = new Int32Array(this.capacity);
    this.originLane = new Int32Array(this.capacity);
    this.laneRank = new Int32Array(this.capacity * LANE_COUNT);
    this.laneScore = new Int32Array(this.capacity * LANE_COUNT);
  }

  slotOf(node: number): number {
    return this.slots.get(node) ?? NO_SLOT;
  }

  /**
   * Admits a node, or returns its existing slot. The three scalar reads happen
   * once per *node*, not once per lane hit, which is why admission owns them
   * rather than each lane doing its own.
   */
  admit(reader: ContextIndexReader, node: number): number {
    const existing = this.slots.get(node);
    if (existing !== undefined) return existing;
    if (this.size >= this.capacity) {
      this.overflow += 1;
      return NO_SLOT;
    }
    const slot = this.size;
    this.size += 1;
    this.slots.set(node, slot);
    this.node[slot] = node;
    this.seed[slot] = NO_NODE;
    this.parentNode[slot] = NO_NODE;
    this.parentEdge[slot] = NO_EDGE;
    this.depth[slot] = 0;
    this.nodeFlags[slot] = reader.nodeFlags(node);
    this.group[slot] = reader.nodeGroup(node);
    this.tokenCost[slot] = reader.nodeTokenCost(node);
    this.anchorTerm[slot] = -1;
    this.confidence[slot] = WEAKEST_CONFIDENCE_CODE;
    this.originLane[slot] = NO_SLOT;
    return slot;
  }

  /**
   * A claim only ever gets *stronger* through this method, and only the anchor
   * lane can offer an exact one. Letting a later lane overwrite a stronger
   * confidence would make the claim depend on lane execution order, which is
   * exactly how a text hit ends up reported as exact.
   */
  claim(slot: number, lane: RetrievalLane, confidence: ContextGraphSeedConfidence): void {
    const code = kernelConfidenceCode(confidence);
    if ((this.originLane[slot] as number) !== NO_SLOT && code >= (this.confidence[slot] as number)) return;
    this.confidence[slot] = code;
    this.originLane[slot] = LANE_SLOT[lane];
  }

  laneOf(slot: number): RetrievalLane {
    const at = this.originLane[slot] as number;
    return (RETRIEVAL_LANES[at] ?? 'lexical') as RetrievalLane;
  }

  confidenceOf(slot: number): ContextGraphSeedConfidence {
    return kernelConfidenceAt(this.confidence[slot] as number);
  }

  mark(slot: number, bits: number): void {
    this.flags[slot] = (this.flags[slot] as number) | bits;
  }

  has(slot: number, bits: number): boolean {
    return (((this.flags[slot] as number) & bits) !== 0);
  }

  /**
   * Records a lane's rank, score and resolving term as one record.
   *
   * The first contribution to a lane wins: ranks are emitted in ascending order,
   * so a later one is by definition worse. The term id is written here rather
   * than by the caller because the three fields are a single receipt — written
   * separately, the rank would name the term that resolved the node first and
   * the term id would name whichever one hit last, and the receipt would
   * describe a lookup that never happened.
   */
  contribute(slot: number, lane: RetrievalLane, rank: number, score: number, termId = -1): void {
    const at = slot * LANE_COUNT + LANE_SLOT[lane];
    if ((this.laneRank[at] as number) !== 0) return;
    this.laneRank[at] = rank + 1;
    this.laneScore[at] = score;
    if (termId >= 0) this.anchorTerm[slot] = termId;
  }

  rankIn(slot: number, lane: RetrievalLane): number {
    return (this.laneRank[slot * LANE_COUNT + LANE_SLOT[lane]] as number) - 1;
  }

  scoreIn(slot: number, lane: RetrievalLane): number {
    return this.laneScore[slot * LANE_COUNT + LANE_SLOT[lane]] as number;
  }

  /** Records where a candidate came from. Seeds point at themselves. */
  link(slot: number, seed: number, parentNode: number, parentEdge: number, depth: number): void {
    this.seed[slot] = seed;
    this.parentNode[slot] = parentNode;
    this.parentEdge[slot] = parentEdge;
    this.depth[slot] = depth;
  }

  /**
   * The parent-edge chain, walked backwards from a slot. Only the selected set
   * reaches this: a chain is an allocation, and building one per candidate is
   * the pre-selection explanation CRK2 exists to delete.
   */
  parentChain(slot: number, maxDepth: number): number[] {
    const chain: number[] = [];
    let cursor = slot;
    for (let step = 0; step <= maxDepth; step += 1) {
      const edge = this.parentEdge[cursor] as number;
      if (edge === NO_EDGE) break;
      chain.push(edge);
      const parent = this.slotOf(this.parentNode[cursor] as number);
      if (parent === NO_SLOT || parent === cursor) break;
      cursor = parent;
    }
    chain.reverse();
    return chain;
  }
}
