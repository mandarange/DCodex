/**
 * Weighted integer RRF fusion and the hard exclusions (CG2-09, §8.1).
 *
 * Lane scores are not commensurable — an anchor hit's priority, a BM25F rarity
 * weight and a decayed graph weight measure three different things — so they are
 * never added. Fusion is reciprocal rank: each lane contributes
 * `laneWeight * 1/(k + rank)`, which uses only a lane's *ordering*, the one
 * thing every lane genuinely agrees on.
 *
 *   fused = exactPriority
 *         + Σ laneWeight(profile, lane) * RRF[rank]
 *         + graphFeature + trust/freshness/risk/evidence
 *         - tokenPenalty
 *
 * `exactPriority` is not a large weight, it is a separate term four orders of
 * magnitude above anything RRF can produce. §8.1 calls it a hard priority, and a
 * hard priority that a long enough tail of text ranks can overtake is a soft one.
 *
 * Nothing here sorts the candidate set. The best `poolCapacity` candidates are
 * kept in a fixed-size min-heap and drained in order; draining a heap is not a
 * sort, and the card's floor is "full candidate sort 0".
 *
 * The redundancy *penalty* deliberately has no term. Group crowding is enforced
 * by the share cap during selection (§8.3 step 7), where the group counts
 * actually exist; scoring it here would make a candidate's score depend on how
 * many of its siblings were scored first.
 */
import { CONTEXT_INDEX_FIXED_POINT_SCALE, CONTEXT_INDEX_TRUST_SCALE, toFixedPoint } from '../runtime-index/format.js';
import { CONTEXT_INDEX_NODE_FLAG } from '../runtime-index/writer.js';
import { FRESHNESS_CODES, RISK_CODES } from '../runtime-index/reader-layout.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';
import { CANDIDATE_FLAG, LANE_SLOT, RETRIEVAL_LANES, addOmission, mulFixed } from './kernel-types.js';
import { CandidateTable } from './kernel-candidates.js';
import type { KernelPlanContext } from './kernel-plan.js';

const SCALE = CONTEXT_INDEX_FIXED_POINT_SCALE;

/**
 * The reserved picks, drawn from the *whole* admissible set rather than from the
 * fill pool. A protected gate that scored below the pool cut would otherwise be
 * unreservable, and `protectedGateRecall = 1.0` is an equality, not a target.
 */
export interface FusionReserves {
  readonly protectedGates: readonly number[];
  readonly conflicts: readonly number[];
  readonly exactSeeds: readonly number[];
  readonly testOrGates: readonly number[];
  /** Best slot per `LANE_SLOT`; `-1` when the lane produced nothing admissible. */
  readonly laneLeaders: Int32Array;
}

export interface FusionResult {
  /** Admissible slots, best first. Produced by draining a heap, never by sorting. */
  readonly order: Int32Array;
  readonly reserves: FusionReserves;
  /** Fused score by slot. Slots outside `order` were excluded and are meaningless. */
  readonly fused: Int32Array;
  readonly staleExcluded: number;
  readonly invalidatedExcluded: number;
  readonly ungroundableExcluded: number;
  readonly focusExcluded: number;
  readonly protectedReachable: number;
  readonly conflictsReachable: number;
  readonly testOrGateReachable: boolean;
  readonly exactSeedReachable: boolean;
}

/**
 * A reserve list: at most a handful of entries, kept in rank order by linear
 * insertion. §8.2 asks for "a separate small array, collected once"; a heap here
 * would be machinery for four elements.
 */
class Reserve {
  readonly slots: number[] = [];
  private readonly score: number[] = [];
  private readonly node: number[] = [];

  constructor(private readonly capacity: number) {}

  offer(slot: number, score: number, node: number): void {
    if (this.capacity <= 0) return;
    let at = 0;
    while (at < this.slots.length) {
      const other = this.score[at] as number;
      if (score > other || (score === other && node < (this.node[at] as number))) break;
      at += 1;
    }
    if (at >= this.capacity) return;
    this.slots.splice(at, 0, slot);
    this.score.splice(at, 0, score);
    this.node.splice(at, 0, node);
    if (this.slots.length > this.capacity) {
      this.slots.length = this.capacity;
      this.score.length = this.capacity;
      this.node.length = this.capacity;
    }
  }
}

/**
 * The best `capacity` candidates, as a min-heap keyed by (fused ASC, node DESC)
 * so the *worst* member is the root and eviction is O(1) to find.
 */
class BoundedTopK {
  private readonly slots: Int32Array;
  private readonly score: Int32Array;
  private readonly node: Int32Array;
  private size = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Int32Array(Math.max(1, capacity));
    this.score = new Int32Array(Math.max(1, capacity));
    this.node = new Int32Array(Math.max(1, capacity));
  }

  offer(slot: number, score: number, node: number): void {
    if (this.size < this.capacity) {
      this.slots[this.size] = slot;
      this.score[this.size] = score;
      this.node[this.size] = node;
      this.size += 1;
      this.siftUp(this.size - 1);
      return;
    }
    if (!this.worse(this.score[0] as number, this.node[0] as number, score, node)) return;
    this.slots[0] = slot;
    this.score[0] = score;
    this.node[0] = node;
    this.siftDown(0);
  }

  /** Ascending drain, reversed in place. Reversal is not a comparison sort. */
  drain(): Int32Array {
    const out = new Int32Array(this.size);
    for (let at = this.size - 1; at >= 0; at -= 1) {
      out[at] = this.slots[0] as number;
      this.size -= 1;
      if (this.size > 0) {
        this.slots[0] = this.slots[this.size] as number;
        this.score[0] = this.score[this.size] as number;
        this.node[0] = this.node[this.size] as number;
        this.siftDown(0);
      }
    }
    return out;
  }

  /** True when `(scoreA, nodeA)` ranks below `(scoreB, nodeB)` under the fixed order. */
  private worse(scoreA: number, nodeA: number, scoreB: number, nodeB: number): boolean {
    if (scoreA !== scoreB) return scoreA < scoreB;
    return nodeA > nodeB;
  }

  private siftUp(from: number): void {
    let child = from;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!this.worse(
        this.score[child] as number,
        this.node[child] as number,
        this.score[parent] as number,
        this.node[parent] as number,
      )) break;
      this.swap(child, parent);
      child = parent;
    }
  }

  private siftDown(from: number): void {
    let parent = from;
    for (;;) {
      const left = parent * 2 + 1;
      if (left >= this.size) break;
      const right = left + 1;
      let best = left;
      if (right < this.size && this.worse(
        this.score[right] as number,
        this.node[right] as number,
        this.score[left] as number,
        this.node[left] as number,
      )) best = right;
      if (!this.worse(
        this.score[best] as number,
        this.node[best] as number,
        this.score[parent] as number,
        this.node[parent] as number,
      )) break;
      this.swap(best, parent);
      parent = best;
    }
  }

  private swap(left: number, right: number): void {
    const slot = this.slots[left] as number;
    const score = this.score[left] as number;
    const node = this.node[left] as number;
    this.slots[left] = this.slots[right] as number;
    this.score[left] = this.score[right] as number;
    this.node[left] = this.node[right] as number;
    this.slots[right] = slot;
    this.score[right] = score;
    this.node[right] = node;
  }
}

export function fuseKernelCandidates(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
): FusionResult {
  const config = context.config;
  const kernelConfig = context.kernelConfig;
  const focusActive = context.focusPaths.length > 0;
  const fused = new Int32Array(table.size);
  // Four times the presentation cap: the group share cap and the token budget
  // both reject candidates during the fill, and a pool the size of the answer
  // would under-fill whenever they do.
  const pool = new BoundedTopK(Math.min(table.size, Math.max(1, context.maxSelected) * 4));

  const exactPriority = toFixedPoint(kernelConfig.exactAnchorPriority, SCALE);
  const trustBonus = toFixedPoint(config.trustBonus, SCALE);
  const riskMultiplier = context.highRisk ? toFixedPoint(config.highRiskRelevanceMultiplier, SCALE) : SCALE;
  const evidenceBonus = toFixedPoint(config.evidenceCoverageBonus, SCALE);
  const evidenceCap = toFixedPoint(config.evidenceCoverageCap, SCALE);
  const tokenPenaltyCap = toFixedPoint(config.tokenCostPenaltyCap, SCALE);

  let staleExcluded = 0;
  let invalidatedExcluded = 0;
  let ungroundableExcluded = 0;
  let focusExcluded = 0;
  let protectedReachable = 0;
  let conflictsReachable = 0;
  let testOrGateReachable = false;
  let exactSeedReachable = false;

  const protectedGates = new Reserve(config.protectedGateReserveSlots);
  const conflicts = new Reserve(config.protectedGateReserveSlots);
  const exactSeeds = new Reserve(kernelConfig.exactSeedReserveSlots);
  const testOrGates = new Reserve(config.testOrGateReserveSlots);
  const laneLeaders = RETRIEVAL_LANES.map(() => new Reserve(1));

  for (let slot = 0; slot < table.size; slot += 1) {
    const nodeFlags = table.nodeFlags[slot] as number;
    // §8.3 step 1, and it runs before every reserve: an invalidated proof that
    // a safety reserve pulled back in would be the exact failure the exclusion
    // exists to prevent.
    if ((nodeFlags & CONTEXT_INDEX_NODE_FLAG.INVALIDATED) !== 0) {
      invalidatedExcluded += 1;
      continue;
    }
    const fields = reader.nodeScoreFields(table.node[slot] as number);
    if ((nodeFlags & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE) === 0) {
      if (FRESHNESS_CODES[fields.freshness] === 'stale') staleExcluded += 1;
      else ungroundableExcluded += 1;
      continue;
    }
    if (focusActive && !table.has(slot, CANDIDATE_FLAG.FOCUS)) {
      focusExcluded += 1;
      continue;
    }

    if (table.has(slot, CANDIDATE_FLAG.PROTECTED)) protectedReachable += 1;
    if (table.has(slot, CANDIDATE_FLAG.CONFLICT)) conflictsReachable += 1;
    if (table.has(slot, CANDIDATE_FLAG.TEST_OR_GATE)) testOrGateReachable = true;
    if (table.has(slot, CANDIDATE_FLAG.EXACT_SEED)) exactSeedReachable = true;

    let score = table.has(slot, CANDIDATE_FLAG.EXACT_SEED) ? exactPriority : 0;
    for (const lane of RETRIEVAL_LANES) {
      const rank = table.rankIn(slot, lane);
      if (rank < 0 || rank >= kernelConfig.rrfRankCap) continue;
      score += mulFixed(context.laneWeights[LANE_SLOT[lane]] as number, context.rrf[rank] as number, SCALE);
    }
    score += table.graphScore[slot] as number;
    score += mulFixed(Math.round((fields.trust * SCALE) / CONTEXT_INDEX_TRUST_SCALE), trustBonus, SCALE);
    score += toFixedPoint(config.freshnessBonus[FRESHNESS_CODES[fields.freshness] ?? 'unknown'], SCALE);
    score += mulFixed(
      toFixedPoint(config.riskRelevanceBonus[RISK_CODES[fields.risk] ?? 'low'], SCALE),
      riskMultiplier,
      SCALE,
    );
    // Provenance without hydrating: a node with its own path and content hash
    // carries one record, and each parent edge on its chain carries another.
    const evidenceCount = ((nodeFlags & CONTEXT_INDEX_NODE_FLAG.HAS_PATH) !== 0
      && (nodeFlags & CONTEXT_INDEX_NODE_FLAG.HAS_CONTENT_HASH) !== 0 ? 1 : 0)
      + Math.min(table.depth[slot] as number, config.maxProvenancePerNode);
    score += Math.min(evidenceBonus * evidenceCount, evidenceCap);
    // Converted to fixed point after the multiply, not before: this per-token
    // rate is smaller than one fixed-point unit, so rounding it on its own would
    // turn 0.0015 into 0.002 and inflate the penalty by a third.
    score -= Math.min(
      toFixedPoint(config.tokenCostPenaltyPerToken * (table.tokenCost[slot] as number), SCALE),
      tokenPenaltyCap,
    );

    fused[slot] = score;
    const node = table.node[slot] as number;
    pool.offer(slot, score, node);
    if (table.has(slot, CANDIDATE_FLAG.PROTECTED)) protectedGates.offer(slot, score, node);
    if (table.has(slot, CANDIDATE_FLAG.CONFLICT)) conflicts.offer(slot, score, node);
    if (table.has(slot, CANDIDATE_FLAG.EXACT_SEED)) exactSeeds.offer(slot, score, node);
    if (table.has(slot, CANDIDATE_FLAG.TEST_OR_GATE)) testOrGates.offer(slot, score, node);
    for (const lane of RETRIEVAL_LANES) {
      if (table.rankIn(slot, lane) >= 0) (laneLeaders[LANE_SLOT[lane]] as Reserve).offer(slot, score, node);
    }
  }

  addOmission(context.omissions, 'stale_node', staleExcluded);
  addOmission(context.omissions, 'invalidated_proof', invalidatedExcluded);
  addOmission(context.omissions, 'no_provenance', ungroundableExcluded);
  addOmission(context.omissions, 'focus_filtered', focusExcluded);
  if (focusExcluded > 0) {
    context.warnings.push(`${focusExcluded} candidate(s) were outside the requested focus paths`);
  }

  const leaders = new Int32Array(RETRIEVAL_LANES.length).fill(-1);
  RETRIEVAL_LANES.forEach((_, at) => {
    const best = (laneLeaders[at] as Reserve).slots[0];
    if (best !== undefined) leaders[at] = best;
  });

  return {
    order: pool.drain(),
    reserves: {
      protectedGates: protectedGates.slots,
      conflicts: conflicts.slots,
      exactSeeds: exactSeeds.slots,
      testOrGates: testOrGates.slots,
      laneLeaders: leaders,
    },
    fused,
    staleExcluded,
    invalidatedExcluded,
    ungroundableExcluded,
    focusExcluded,
    protectedReachable,
    conflictsReachable,
    testOrGateReachable,
    exactSeedReachable,
  };
}
