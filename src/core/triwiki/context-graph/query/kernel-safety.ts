/**
 * The safety closure (§7.4, CG2-08) — a separate BFS, on purpose.
 *
 * Relevance and safety are different questions, and answering them with one
 * traversal is what makes a protected gate droppable: a best-first walk exists
 * to stop early, and anything it stops before reaching is a gate nobody was told
 * about. So the safety relations get their own walk, over their own edge set,
 * with their own caps, and it runs to completion **before** the relevance
 * frontier is allowed to terminate early.
 *
 * Two consequences follow from that and are not negotiable:
 *
 *   - The edge set is `KERNEL_SAFETY_EDGE_TYPES`, not the profile's. A profile
 *     that does not traverse `conflicts_with` is a statement about relevance
 *     ranking, never a licence to omit a conflict from a review.
 *   - A cap hit here is its own blocker, reported separately from the relevance
 *     caps. "The answer was shortened" and "a safety relation may be missing"
 *     are different facts and a caller must be able to tell them apart.
 *
 * The floors this underwrites — `protectedGateRecall = 1.0` and
 * `conflictRecall = 1.0` — hold over the closure's own depth bound. Reaching
 * that bound is reported; it is never absorbed.
 */
import type { ContextIndexReader } from '../runtime-index/reader.js';
import { CONTEXT_INDEX_NODE_FLAG } from '../runtime-index/writer.js';
import { CANDIDATE_FLAG, addOmission } from './kernel-types.js';
import { CandidateTable, NO_SLOT } from './kernel-candidates.js';
import type { KernelPlanContext } from './kernel-plan.js';

export interface SafetyClosureOutcome {
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly capHit: boolean;
  readonly timedOut: boolean;
}

export function runSafetyClosure(
  reader: ContextIndexReader,
  context: KernelPlanContext,
  table: CandidateTable,
): SafetyClosureOutcome {
  const kernelConfig = context.kernelConfig;
  const maxNodes = Math.max(0, kernelConfig.safetyMaxVisitedNodes);
  const queue = new Int32Array(maxNodes);
  const depths = new Int32Array(maxNodes);
  const seen = new Set<number>();
  let tail = 0;
  let head = 0;
  let visitedEdges = 0;
  let capHit = false;
  let timedOut = false;
  let sinceClockCheck = 0;

  const enqueue = (node: number, depth: number): boolean => {
    if (seen.has(node)) return true;
    if (tail >= maxNodes) {
      capHit = true;
      return false;
    }
    seen.add(node);
    queue[tail] = node;
    depths[tail] = depth;
    tail += 1;
    return true;
  };

  // Snapshotted: the closure admits nodes into the same table it is reading, and
  // a live length would make the seed set include the closure's own output.
  const seedCount = table.size;
  for (let slot = 0; slot < seedCount; slot += 1) {
    if (!table.has(slot, CANDIDATE_FLAG.SEED)) continue;
    if (!enqueue(table.node[slot] as number, 0)) break;
  }

  while (head < tail && !timedOut) {
    const node = queue[head] as number;
    const depth = depths[head] as number;
    head += 1;
    if (depth >= kernelConfig.safetyMaxDepth) continue;

    for (let direction = 0; direction < 2 && !timedOut; direction += 1) {
      const cursor = direction === 0
        ? reader.outgoing(node, context.plan.profileMask)
        : reader.incoming(node, context.plan.profileMask);
      while (cursor.next()) {
        visitedEdges += 1;
        sinceClockCheck += 1;
        if (sinceClockCheck >= context.config.timeoutCheckInterval) {
          sinceClockCheck = 0;
          if (context.deadline !== null && context.clock() > context.deadline) {
            timedOut = true;
            break;
          }
        }
        if (visitedEdges >= kernelConfig.safetyMaxVisitedEdges) {
          capHit = true;
          break;
        }
        if (((context.safetyEdgeMask >>> cursor.type) & 1) === 0) continue;

        const neighbour = cursor.target;
        const slot = table.admit(reader, neighbour);
        if (slot === NO_SLOT) {
          capHit = true;
          continue;
        }
        // A node the closure reached is safety-relevant whether or not the
        // relevance walk ever gets there, which is the entire reason the
        // selector can reserve it later.
        table.mark(slot, CANDIDATE_FLAG.SAFETY);
        if (((context.conflictEdgeMask >>> cursor.type) & 1) !== 0) table.mark(slot, CANDIDATE_FLAG.CONFLICT);
        if (((table.nodeFlags[slot] as number) & CONTEXT_INDEX_NODE_FLAG.PROTECTED) !== 0) {
          table.mark(slot, CANDIDATE_FLAG.PROTECTED);
        }
        if (((table.nodeFlags[slot] as number) & CONTEXT_INDEX_NODE_FLAG.IS_TEST_OR_GATE) !== 0) {
          table.mark(slot, CANDIDATE_FLAG.TEST_OR_GATE);
        }
        // The closure records *what* it reached, not how it reached it: a
        // safety node still needs a relevance chain for its explanation, and
        // overwriting a parent pointer here would replace a scored path with an
        // unscored one.
        if ((table.parentEdge[slot] as number) < 0 && !table.has(slot, CANDIDATE_FLAG.SEED)) {
          table.link(slot, node, node, cursor.edge, depth + 1);
        }
        if (!enqueue(neighbour, depth + 1)) break;
      }
    }
  }

  if (capHit) {
    context.warnings.push('the safety closure hit a cap; a protected gate or conflict may be missing');
    addOmission(context.omissions, 'safety_cap', 1);
  }
  if (timedOut) {
    context.warnings.push('the safety closure hit the query deadline before it completed');
    addOmission(context.omissions, 'timeout', 1);
  }
  return { visitedNodes: tail, visitedEdges, capHit, timedOut };
}
