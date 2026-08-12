/**
 * The `local_graph` lane: bounded best-first traversal (CG2-08).
 *
 * v1 visited the whole depth-bounded neighbourhood and ranked afterwards. This
 * walk pops in score order, so the first time a node is popped it is at its best
 * discovery — which is what lets the walk stop while the frontier still has
 * states in it, and what removes the "visit everything, then sort" pass.
 *
 * Four rules make the result reproducible rather than merely fast:
 *
 *   - The frontier key is total (see `kernel-frontier.ts`), so no two states can
 *     tie into insertion order.
 *   - Arithmetic is fixed-point integer. A float weight would let the same query
 *     rank differently on two machines, and the ordering *is* the answer.
 *   - The deadline is read through the injected clock, never `Date.now`. A cap
 *     that depends on how fast the machine is, is not a cap anything can test.
 *   - Early exit is gated on the safety closure having finished. Stopping a
 *     relevance walk early is a performance decision; stopping it before the
 *     safety closure ran would make it a correctness decision.
 *
 * A profile-excluded edge is skipped on an integer mask test against the cursor's
 * own scalar fields. No edge object is built for it, because none is built for
 * any edge.
 */
import { CONTEXT_GRAPH_TRAVERSAL_CAPS } from '../profiles.js';
import { CONTEXT_INDEX_FIXED_POINT_SCALE, toFixedPoint } from '../runtime-index/format.js';
import { CONTEXT_INDEX_NODE_FLAG } from '../runtime-index/writer.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';
import {
  CANDIDATE_FLAG,
  addOmission,
  demoteKernelConfidence,
  mulFixed,
} from './kernel-types.js';
import { CandidateTable, NO_SLOT } from './kernel-candidates.js';
import { TraversalFrontier } from './kernel-frontier.js';
import { contextGraphSeedConfidenceScore } from './ranking-config.js';
import type { KernelPlanContext } from './kernel-plan.js';

const SCALE = CONTEXT_INDEX_FIXED_POINT_SCALE;

export interface TraversalOutcome {
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly depthLimited: number;
  readonly nodeCapHit: boolean;
  readonly edgeCapHit: boolean;
  readonly frontierCapHit: boolean;
  readonly timedOut: boolean;
  /** The frontier still held states whose upper bound could not reach the top-K. */
  readonly earlyExit: boolean;
}

/** `depthDecay^depth`, resolved once. A `Math.pow` per edge is the same number, slower. */
function decayLadder(depthDecay: number, maxDepth: number): Int32Array {
  const ladder = new Int32Array(maxDepth + 2);
  ladder[0] = SCALE;
  const step = toFixedPoint(depthDecay, SCALE);
  for (let depth = 1; depth < ladder.length; depth += 1) {
    ladder[depth] = mulFixed(ladder[depth - 1] as number, step, SCALE);
  }
  return ladder;
}

/**
 * The K best graph scores seen so far, as a fixed-size ascending buffer.
 *
 * Fixed-size and inserted into linearly: K is at most 64, and §8.2 asks for a
 * bounded buffer precisely so nothing ever sorts the reachable set. `floor` is
 * the current worst member, which is the early-exit threshold.
 */
class TopScores {
  private readonly values: Int32Array;
  private count = 0;

  constructor(capacity: number) {
    this.values = new Int32Array(Math.max(1, capacity));
  }

  get full(): boolean {
    return this.count >= this.values.length;
  }

  get floor(): number {
    return this.count === 0 ? Number.NEGATIVE_INFINITY : (this.values[0] as number);
  }

  offer(score: number): void {
    if (!this.full) {
      let at = this.count;
      this.count += 1;
      while (at > 0 && (this.values[at - 1] as number) > score) {
        this.values[at] = this.values[at - 1] as number;
        at -= 1;
      }
      this.values[at] = score;
      return;
    }
    if (score <= (this.values[0] as number)) return;
    let at = 0;
    while (at + 1 < this.values.length && (this.values[at + 1] as number) < score) {
      this.values[at] = this.values[at + 1] as number;
      at += 1;
    }
    this.values[at] = score;
  }
}

export function traverseKernelGraph(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
  safetyComplete: boolean,
): TraversalOutcome {
  const plan = context.plan;
  const config = context.config;
  const caps = CONTEXT_GRAPH_TRAVERSAL_CAPS;
  const decay = decayLadder(config.depthDecay, plan.maxDepth);
  const reverseMultiplier = toFixedPoint(config.reverseEdgeMultiplier, SCALE);
  const exactBonus = toFixedPoint(config.exactSeedBonus, SCALE);
  const lexicalBonus = toFixedPoint(config.lexicalSeedBonus, SCALE);

  const frontier = new TraversalFrontier(plan.frontierBudget);
  const top = new TopScores(context.maxSelected);
  const visited = new Set<number>();

  const seedCount = table.size;
  for (let slot = 0; slot < seedCount; slot += 1) {
    if (!table.has(slot, CANDIDATE_FLAG.SEED)) continue;
    const exact = table.has(slot, CANDIDATE_FLAG.EXACT_SEED);
    const base = toFixedPoint(contextGraphSeedConfidenceScore(config, table.confidenceOf(slot)), SCALE)
      + (exact ? exactBonus : lexicalBonus);
    table.graphScore[slot] = base;
    const node = table.node[slot] as number;
    frontier.push(node, base, 0, 0, node, -1, -1, (table.flags[slot] as number) & CANDIDATE_FLAG.FOCUS);
  }

  let visitedNodes = 0;
  let visitedEdges = 0;
  let depthLimited = 0;
  let nodeCapHit = false;
  let edgeCapHit = false;
  let timedOut = false;
  let earlyExit = false;
  let sinceClockCheck = 0;
  let graphRank = 0;

  while (frontier.pop()) {
    const node = frontier.node;
    if (visited.has(node)) continue;
    if (visitedNodes >= caps.maxVisitedNodes) {
      nodeCapHit = true;
      break;
    }
    visited.add(node);
    visitedNodes += 1;

    const slot = table.slotOf(node);
    if (slot === NO_SLOT) continue;
    const depth = frontier.depth;
    if (depth > 0) {
      // First pop is the best discovery, so the parent chain and the demoted
      // confidence are written once and never relaxed.
      table.graphScore[slot] = frontier.score;
      table.link(slot, frontier.seed, frontier.parentNode, frontier.parentEdge, depth);
      table.contribute(slot, 'local_graph', graphRank, frontier.score);
      graphRank += 1;
      const seedSlot = table.slotOf(frontier.seed);
      if (seedSlot !== NO_SLOT) {
        table.claim(slot, 'local_graph', demoteKernelConfidence(table.confidenceOf(seedSlot), depth));
      }
      if ((frontier.flags & CANDIDATE_FLAG.FOCUS) !== 0) table.mark(slot, CANDIDATE_FLAG.FOCUS);
      if (((table.nodeFlags[slot] as number) & CONTEXT_INDEX_NODE_FLAG.PROTECTED) !== 0) {
        table.mark(slot, CANDIDATE_FLAG.PROTECTED);
      }
      if (((table.nodeFlags[slot] as number) & CONTEXT_INDEX_NODE_FLAG.IS_TEST_OR_GATE) !== 0) {
        table.mark(slot, CANDIDATE_FLAG.TEST_OR_GATE);
      }
      if (((table.nodeFlags[slot] as number) & CONTEXT_INDEX_NODE_FLAG.IS_EVIDENCE) !== 0) {
        table.mark(slot, CANDIDATE_FLAG.EVIDENCE);
      }
    }
    top.offer(table.graphScore[slot] as number);

    // §7.2: allowed only once the closure is done. Before that, a low-scoring
    // protected gate is exactly the thing the frontier would discard.
    if (safetyComplete && top.full && frontier.peekScore() < top.floor) {
      earlyExit = true;
      break;
    }
    if (depth >= plan.maxDepth) {
      depthLimited += 1;
      continue;
    }

    const childDepth = depth + 1;
    const childDecay = decay[childDepth] ?? 0;
    for (let direction = 0; direction < 2; direction += 1) {
      const cursor = direction === 0
        ? reader.outgoing(node, plan.profileMask)
        : reader.incoming(node, plan.profileMask);
      const directionMultiplier = direction === 0 ? SCALE : reverseMultiplier;
      while (cursor.next()) {
        if (visitedEdges >= caps.maxVisitedEdges) {
          edgeCapHit = true;
          break;
        }
        visitedEdges += 1;
        sinceClockCheck += 1;
        if (sinceClockCheck >= config.timeoutCheckInterval) {
          sinceClockCheck = 0;
          if (context.deadline !== null && context.clock() > context.deadline) {
            timedOut = true;
            break;
          }
        }
        if (((context.edgeTypeMask >>> cursor.type) & 1) === 0) continue;
        const neighbour = cursor.target;
        if (visited.has(neighbour)) continue;

        const edgeWeight = context.edgeWeights[cursor.type] as number;
        const confidence = context.confidenceMultipliers[cursor.confidence] ?? 0;
        const hop = mulFixed(mulFixed(mulFixed(edgeWeight, confidence, SCALE), directionMultiplier, SCALE), childDecay, SCALE);
        const childScore = mulFixed(frontier.score, toFixedPoint(config.depthDecay, SCALE), SCALE) + hop;

        const childSlot = table.admit(reader, neighbour);
        if (childSlot === NO_SLOT) {
          nodeCapHit = true;
          continue;
        }
        const inheritedFocus = (frontier.flags & CANDIDATE_FLAG.FOCUS)
          | ((table.flags[childSlot] as number) & CANDIDATE_FLAG.FOCUS);
        if (!frontier.push(
          neighbour,
          childScore,
          childDepth,
          edgeWeight,
          frontier.seed,
          node,
          cursor.edge,
          inheritedFocus,
        )) {
          break;
        }
      }
      if (timedOut || edgeCapHit) break;
    }
    if (timedOut) break;
  }

  const frontierCapHit = frontier.rejected > 0;
  addOmission(context.omissions, 'depth_limit', depthLimited);
  addOmission(context.omissions, 'visit_cap', nodeCapHit ? 1 : 0);
  addOmission(context.omissions, 'edge_cap', edgeCapHit ? 1 : 0);
  addOmission(context.omissions, 'frontier_budget', frontier.rejected);
  addOmission(context.omissions, 'timeout', timedOut ? 1 : 0);
  if (timedOut) context.warnings.push('the traversal hit the query deadline; results may be incomplete');
  if (frontierCapHit) context.warnings.push('the traversal frontier hit its budget; results may be incomplete');

  return {
    visitedNodes,
    visitedEdges,
    depthLimited,
    nodeCapHit,
    edgeCapHit,
    frontierCapHit,
    timedOut,
    earlyExit,
  };
}
