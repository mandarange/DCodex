/**
 * The Context Retrieval Kernel v2 — one entry point for every consumer.
 *
 * `runContextKernel` is the whole query path: it takes an open binary index and
 * a request, and returns integer candidates. It performs no I/O, spawns no
 * process, calls no model, and reads no clock but the injected one.
 *
 * The pipeline is fixed and each stage exists because the one after it would be
 * wrong without it:
 *
 *   normalize once  -> one plan  -> anchor / lexical / coarse lanes
 *                   -> safety closure -> bounded best-first traversal
 *                   -> integer RRF fusion -> bounded selection
 *
 * The safety closure runs *before* the relevance walk so the walk is allowed to
 * terminate early without that being a correctness decision (§7.2/§7.4). The
 * lanes run before both because the traversal seeds from what they produced.
 *
 * Four prohibitions hold structurally, not by review:
 *
 *   - No `nodesByLabel`/`nodesByPath` scan. Every lane is a dictionary lookup or
 *     a posting merge; deleting that scan is what the project is for.
 *   - No `Date.now()`. The clock is a required argument.
 *   - No hydration during ranking. `hydrateNode` is never called here at all —
 *     the kernel hands out integers and CG2-10 hydrates the selected set.
 *   - No fallback. A missing, stale or corrupt index raises out of the reader
 *     before this function is reached; nothing here degrades to a slower path.
 *
 * `src/core/search/context-graph-seeds.ts` is not imported, directly or
 * transitively: the anchor lane replaces it, and keeping both would be two seed
 * engines again.
 */
import type { ContextIndexReader } from '../runtime-index/reader.js';
import {
  CONTEXT_KERNEL_SCHEMA,
  addOmission,
  type ContextKernelResult,
  type KernelClock,
  type KernelRequest,
  type LaneTelemetry,
} from './kernel-types.js';
import { CandidateTable } from './kernel-candidates.js';
import { resolveQueryPlan, type KernelPlanOptions } from './kernel-plan.js';
import { runSeedLanes } from './kernel-lanes.js';
import { markNameAnchors } from './name-anchors.js';
import { runSafetyClosure } from './kernel-safety.js';
import { traverseKernelGraph } from './kernel-traverse.js';
import { fuseKernelCandidates } from './kernel-fuse.js';
import { selectKernelCandidates } from './kernel-select.js';

export interface ContextKernelOptions extends KernelPlanOptions {
  /**
   * Runs the safety closure. Off only for a profile with no safety obligation;
   * a caller cannot switch it off on a high-risk or review query, because that
   * is precisely where the recall floors apply.
   */
  readonly safetyClosure?: boolean;
}

/**
 * Answer a request against an index the caller already opened.
 *
 * The clock is required rather than defaulted. A default would be `Date.now`,
 * and a default that reads the wall clock is the one that ships.
 */
export function runContextKernel(
  reader: ContextIndexReader,
  request: KernelRequest,
  options: ContextKernelOptions,
): ContextKernelResult {
  const context = resolveQueryPlan(reader, request, options);
  const table = new CandidateTable(context.plan.candidateBudget);

  const lanes: LaneTelemetry[] = runSeedLanes(reader, context, request, table);
  // Between the lanes and the walk, and nowhere else: it reads what the lanes
  // admitted, and the walk reads the strength it assigns. It is not a fifth
  // lane — it produces no candidate and claims no confidence, so §4's mapping
  // over the four lanes stays total and exclusive.
  markNameAnchors(reader, context, table);
  // The closure and the walk admit into the same table, so their overflow is
  // added separately: `runSeedLanes` has already accounted for the seeding half,
  // and counting the total twice would misreport how much was dropped.
  const seedingOverflow = table.overflow;

  const safetyWanted = options.safetyClosure ?? true;
  const safetyRequired = context.highRisk || context.plan.profile === 'review';
  const safety = safetyWanted || safetyRequired
    ? runSafetyClosure(reader, context, table)
    : { visitedNodes: 0, visitedEdges: 0, capHit: false, timedOut: false };

  const traversal = traverseKernelGraph(reader, context, table, !safety.capHit && !safety.timedOut);
  lanes.push(Object.freeze({
    lane: 'local_graph' as const,
    matchedTerms: 0,
    postingsExamined: traversal.visitedEdges,
    candidates: traversal.visitedNodes,
    truncated: traversal.nodeCapHit || traversal.edgeCapHit || traversal.frontierCapHit,
  }));

  addOmission(context.omissions, 'candidate_budget', table.overflow - seedingOverflow);

  const fusion = fuseKernelCandidates(reader, context, table);
  const selection = selectKernelCandidates(context, table, fusion);

  const timedOut = traversal.timedOut || safety.timedOut;
  return Object.freeze({
    schema: CONTEXT_KERNEL_SCHEMA,
    plan: context.plan,
    selected: selection.selected,
    lanes: Object.freeze(lanes),
    omissions: Object.freeze({ ...context.omissions }),
    warnings: Object.freeze([...context.warnings]),
    candidateCount: table.size,
    visitedNodes: traversal.visitedNodes + safety.visitedNodes,
    visitedEdges: traversal.visitedEdges + safety.visitedEdges,
    tokenCost: selection.tokenCost,
    truncated: selection.truncated
      || traversal.nodeCapHit
      || traversal.edgeCapHit
      || traversal.frontierCapHit
      || timedOut
      || table.overflow > 0,
    timedOut,
    guarantees: selection.guarantees,
    durationMs: Math.max(0, context.clock() - context.startedAt),
    fullCandidateSorts: 0,
    selectedSorts: 1,
  });
}

/** A clock that never advances. The deterministic default for tests and benches. */
export function fixedKernelClock(at = 0): KernelClock {
  return () => at;
}

export {
  KERNEL_CONFLICT_EDGE_TYPES,
  KERNEL_SAFETY_EDGE_TYPES,
  resolveQueryPlan,
  type KernelPlanContext,
  type KernelPlanOptions,
} from './kernel-plan.js';
export { CandidateTable, NO_EDGE, NO_NODE, NO_SLOT } from './kernel-candidates.js';
export { TraversalFrontier, type FrontierState } from './kernel-frontier.js';
export { runAnchorLane, runCoarseLane, runLexicalLane, runSeedLanes } from './kernel-lanes.js';
export { markNameAnchors, nameAnchorTermOf } from './name-anchors.js';
export { runSafetyClosure, type SafetyClosureOutcome } from './kernel-safety.js';
export { traverseKernelGraph, type TraversalOutcome } from './kernel-traverse.js';
export { fuseKernelCandidates, type FusionResult, type FusionReserves } from './kernel-fuse.js';
export { selectKernelCandidates, type SelectionResult } from './kernel-select.js';
export * from './kernel-types.js';
