/**
 * The bounded selector (CG2-09, §8.3).
 *
 * The order of the seven steps is the contract, not a suggestion, because each
 * one exists to survive the step after it:
 *
 *   1. hard exclusion            (done in fusion; nothing may reserve past it)
 *   2. protected gate + conflict reserve
 *   3. exact seed reserve
 *   4. implementation test/gate reserve
 *   5. minimum lane diversity
 *   6. token-budget fill
 *   7. group share cap
 *   8. one presentation sort
 *
 * Reserves take the budget *before* the greedy fill sees it. On a budget too
 * small for everything, that is what decides which guarantee survives: the
 * safety item is kept and the exact seed is the one reported as omitted, never
 * the other way round.
 *
 * The budget is never exceeded to fit a safety node. §8.3 is explicit about
 * this: the answer comes back with a warning and an omission instead, because a
 * silently over-budget context pack is a failure the caller cannot see.
 *
 * Exactly one sort runs here, over the selected set — at most `maxSelected`
 * entries. Nothing sorts the candidate set at any point.
 */
import { CANDIDATE_FLAG, LANE_SLOT, RETRIEVAL_LANES, addOmission } from './kernel-types.js';
import type { KernelGuarantees, LaneContribution, SelectedCandidate } from './kernel-types.js';
import { CandidateTable } from './kernel-candidates.js';
import type { FusionResult } from './kernel-fuse.js';
import type { KernelPlanContext } from './kernel-plan.js';

export interface SelectionResult {
  readonly selected: readonly SelectedCandidate[];
  readonly tokenCost: number;
  readonly truncated: boolean;
  readonly guarantees: KernelGuarantees;
}

class Selector {
  readonly chosen: number[] = [];
  private readonly taken = new Set<number>();
  private readonly perGroup = new Map<number, number>();
  spent = 0;

  constructor(
    private readonly context: KernelPlanContext,
    private readonly table: CandidateTable,
    private readonly limit: number,
  ) {}

  has(slot: number): boolean {
    return this.taken.has(slot);
  }

  costOf(slot: number): number {
    return Math.max(this.context.config.minTokenCost, this.table.tokenCost[slot] as number);
  }

  groupCount(slot: number): number {
    return this.perGroup.get(this.table.group[slot] as number) ?? 0;
  }

  take(slot: number): boolean {
    if (this.taken.has(slot)) return true;
    if (this.chosen.length >= this.limit) {
      addOmission(this.context.omissions, 'max_selected', 1);
      return false;
    }
    const cost = this.costOf(slot);
    if (this.spent + cost > this.context.plan.tokenBudget) {
      addOmission(this.context.omissions, 'token_budget', 1);
      return false;
    }
    this.taken.add(slot);
    this.chosen.push(slot);
    this.spent += cost;
    const group = this.table.group[slot] as number;
    this.perGroup.set(group, (this.perGroup.get(group) ?? 0) + 1);
    return true;
  }
}

function contributionsFor(
  context: KernelPlanContext,
  table: CandidateTable,
  slot: number,
): LaneContribution[] {
  const out: LaneContribution[] = [];
  for (const lane of RETRIEVAL_LANES) {
    const rank = table.rankIn(slot, lane);
    if (rank < 0) continue;
    const anchorTerm = table.anchorTerm[slot] as number;
    // Anchor names the one term that resolved it; the BM25F lanes name the whole
    // plan, because a merged posting is a fact about the term set, not one term.
    //
    // These ids share one space but not one meaning, so they must never be
    // compared across lanes. Every lane resolves through the same string table,
    // which makes the ids look interchangeable — but the basename lane is keyed
    // by a node's full workspace-relative path, so its id denotes
    // `src/core/query.ts` while a lexical hit on the token `query.ts` is a
    // different id entirely. Equal ids across lanes would mean the same interned
    // string, never the same query term.
    const termIds = lane === 'anchor'
      ? (anchorTerm >= 0 ? Object.freeze([anchorTerm]) : Object.freeze([]))
      : lane === 'local_graph'
        ? Object.freeze([])
        : context.plan.termIds;
    out.push(Object.freeze({
      lane,
      rank,
      score: BigInt(table.scoreIn(slot, lane)),
      termIds,
    }));
  }
  return out;
}

export function selectKernelCandidates(
  context: KernelPlanContext,
  table: CandidateTable,
  fusion: FusionResult,
): SelectionResult {
  const config = context.config;
  const plan = context.plan;
  const selector = new Selector(context, table, context.maxSelected);
  const safetyProfile = context.highRisk || plan.profile === 'review';

  // 2 and 3. A conflict is reserved on the same footing as a protected gate:
  // `conflictRecall = 1.0` is stated as an equality, and a conflict that lost a
  // greedy fill is a review that did not mention the thing it exists to catch.
  if (safetyProfile) {
    for (const slot of fusion.reserves.protectedGates) selector.take(slot);
    for (const slot of fusion.reserves.conflicts) selector.take(slot);
  }
  for (const slot of fusion.reserves.exactSeeds) selector.take(slot);
  if (plan.profile === 'implementation') {
    for (const slot of fusion.reserves.testOrGates) selector.take(slot);
  }

  // 5. One candidate per lane that produced anything, so a profile's weakest
  // lane still reaches the answer when its top candidate would be crowded out.
  for (const lane of RETRIEVAL_LANES) {
    const leader = fusion.reserves.laneLeaders[LANE_SLOT[lane]] as number;
    if (leader >= 0) selector.take(leader);
  }

  // 6 and 7. `fusion.order` is already best-first, so the fill is a single walk.
  const allowance = Math.max(config.minGroupSlots, Math.ceil(context.maxSelected * config.moduleShareCap));
  const groups = new Set<number>();
  for (const slot of fusion.order) groups.add(table.group[slot] as number);
  const diversityApplies = groups.size > 1;
  for (const slot of fusion.order) {
    if (selector.has(slot)) continue;
    if (diversityApplies
      && (selector.groupCount(slot) >= allowance || selector.groupCount(slot) >= config.maxRedundancyGroupMembers)) {
      addOmission(context.omissions, 'redundant_sibling', 1);
      continue;
    }
    selector.take(slot);
  }

  const selectedSet = new Set(selector.chosen);
  const protectedSelected = fusion.reserves.protectedGates.filter((slot) => selectedSet.has(slot)).length;
  const conflictsSelected = fusion.reserves.conflicts.filter((slot) => selectedSet.has(slot)).length;
  const guarantees: KernelGuarantees = Object.freeze({
    exactSeedAvailable: fusion.exactSeedReachable,
    exactSeedSelected: selector.chosen.some((slot) => table.has(slot, CANDIDATE_FLAG.EXACT_SEED)),
    protectedGatesReachable: fusion.protectedReachable,
    protectedGatesSelected: protectedSelected,
    conflictsReachable: fusion.conflictsReachable,
    conflictsSelected,
    testOrGateReachable: fusion.testOrGateReachable,
    testOrGateSelected: selector.chosen.some((slot) => table.has(slot, CANDIDATE_FLAG.TEST_OR_GATE)),
  });

  if (guarantees.exactSeedAvailable && !guarantees.exactSeedSelected) {
    context.warnings.push('an exact seed did not fit the token budget; widen tokenBudget or narrow the query');
  }
  if (safetyProfile && guarantees.protectedGatesReachable > guarantees.protectedGatesSelected) {
    context.warnings.push('a reachable protected gate did not fit the token budget on a safety-relevant query');
  }
  if (safetyProfile && guarantees.conflictsReachable > guarantees.conflictsSelected) {
    context.warnings.push('a reachable conflict did not fit the token budget on a safety-relevant query');
  }
  if (plan.profile === 'implementation' && guarantees.testOrGateReachable && !guarantees.testOrGateSelected) {
    context.warnings.push('no reachable test or gate fit the token budget on an implementation query');
  }

  // 8. The one sort. Its input is the selected set, bounded by `maxSelected`.
  const selected = selector.chosen
    .map((slot) => Object.freeze({
      candidate: Object.freeze({
        node: table.node[slot] as number,
        score: BigInt(fusion.fused[slot] as number),
        seed: table.seed[slot] as number,
        parentNode: table.parentNode[slot] as number,
        parentEdge: table.parentEdge[slot] as number,
        depth: table.depth[slot] as number,
        flags: table.flags[slot] as number,
      }),
      lane: table.laneOf(slot),
      confidence: table.confidenceOf(slot),
      contributions: Object.freeze(contributionsFor(context, table, slot)),
      tokenCost: selector.costOf(slot),
      group: table.group[slot] as number,
      parentEdges: Object.freeze(table.parentChain(slot, plan.maxDepth)),
    }) as SelectedCandidate)
    .sort((left, right) => {
      if (left.candidate.score !== right.candidate.score) {
        return right.candidate.score > left.candidate.score ? 1 : -1;
      }
      return left.candidate.node - right.candidate.node;
    });

  const truncated = (context.omissions.token_budget ?? 0) > 0 || (context.omissions.max_selected ?? 0) > 0;
  return { selected, tokenCost: selector.spent, truncated, guarantees };
}
