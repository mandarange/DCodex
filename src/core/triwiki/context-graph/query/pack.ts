/**
 * Token packer.
 *
 * This replaces module-order packing with an explicit priority discipline. In
 * order, the packer guarantees:
 *   1. at least one exact seed is selected when one survived ranking;
 *   2. every selected node carries at least one provenance record (enforced
 *      upstream in `explain.ts`, which never hands an ungrounded node to the packer);
 *   3. an implementation query includes a test or a gate when one is reachable;
 *   4. a high-risk query never omits a reachable protected gate;
 *   5. no single structural group may monopolize the selection;
 *   6. every selected node carries a reason path (also enforced in `explain.ts`);
 *   7. the token budget is never exceeded.
 *
 * Anything the packer leaves out is counted under an omission reason. `truncated`
 * is reserved for omissions that mean "there was more to say and it did not fit"
 * — budget and selection caps — rather than for the shaping the profile always
 * applies (depth limit, structural diversity), which would make the flag useless.
 */
import type { ContextGraphOmissionReason } from '../query-types.js';
import type { ContextGraphQueryProfileName } from '../profiles.js';
import { compareContextGraphIds } from '../ids.js';
import type { ContextGraphExplainedCandidate } from './explain.js';
import type { ContextGraphRankingConfig } from './ranking-config.js';

export interface PackContextGraphInput {
  /** Ranked, explained, provenance-grounded candidates in presentation order. */
  readonly explained: readonly ContextGraphExplainedCandidate[];
  readonly tokenBudget: number;
  readonly maxSelected: number;
  readonly profile: ContextGraphQueryProfileName;
  readonly highRisk: boolean;
  readonly config: ContextGraphRankingConfig;
}

export interface ContextGraphPackGuarantees {
  readonly exactSeedSelected: boolean;
  readonly exactSeedAvailable: boolean;
  readonly protectedGatesReachable: number;
  readonly protectedGatesSelected: number;
  readonly implementationEvidenceReachable: boolean;
  readonly implementationEvidenceSelected: boolean;
}

export interface ContextGraphPackResult {
  readonly selected: ContextGraphExplainedCandidate[];
  readonly tokenCost: number;
  readonly omissions: Partial<Record<ContextGraphOmissionReason, number>>;
  readonly truncated: boolean;
  readonly warnings: string[];
  readonly guarantees: ContextGraphPackGuarantees;
}

function bump(into: Partial<Record<ContextGraphOmissionReason, number>>, reason: ContextGraphOmissionReason): void {
  into[reason] = (into[reason] ?? 0) + 1;
}

function isProtectedGate(entry: ContextGraphExplainedCandidate): boolean {
  return entry.candidate.node.risk === 'protected';
}

function isImplementationEvidence(entry: ContextGraphExplainedCandidate): boolean {
  const kind = entry.candidate.node.kind;
  return kind === 'test' || kind === 'gate';
}

function byScoreThenId(left: ContextGraphExplainedCandidate, right: ContextGraphExplainedCandidate): number {
  if (left.candidate.score !== right.candidate.score) return right.candidate.score - left.candidate.score;
  return compareContextGraphIds(left.candidate.node.id, right.candidate.node.id);
}

class Packer {
  readonly chosen = new Map<string, ContextGraphExplainedCandidate>();
  readonly perGroup = new Map<string, number>();
  readonly omissions: Partial<Record<ContextGraphOmissionReason, number>> = {};
  spent = 0;

  constructor(
    private readonly budget: number,
    private readonly limit: number
  ) {}

  has(entry: ContextGraphExplainedCandidate): boolean {
    return this.chosen.has(entry.candidate.node.id);
  }

  /** Take the entry when it fits both the budget and the selection cap; otherwise record why not. */
  take(entry: ContextGraphExplainedCandidate): boolean {
    if (this.chosen.size >= this.limit) {
      bump(this.omissions, 'max_selected');
      return false;
    }
    const cost = entry.candidate.tokenCost;
    if (this.spent + cost > this.budget) {
      bump(this.omissions, 'token_budget');
      return false;
    }
    this.chosen.set(entry.candidate.node.id, entry);
    this.spent += cost;
    const group = entry.candidate.groupKey;
    this.perGroup.set(group, (this.perGroup.get(group) ?? 0) + 1);
    return true;
  }

  groupCount(entry: ContextGraphExplainedCandidate): number {
    return this.perGroup.get(entry.candidate.groupKey) ?? 0;
  }
}

export function packContextGraphSelection(input: PackContextGraphInput): ContextGraphPackResult {
  const { explained, tokenBudget, maxSelected, profile, highRisk, config } = input;
  const ordered = [...explained].sort(byScoreThenId);
  const packer = new Packer(Math.max(0, tokenBudget), Math.max(0, maxSelected));
  const warnings: string[] = [];

  const exactSeeds = ordered.filter((entry) => entry.candidate.exactSeed);
  const protectedGates = ordered.filter(isProtectedGate);
  const implementationEvidence = ordered.filter(isImplementationEvidence);

  // Reserved picks get the budget before the greedy fill sees it. On a high-risk
  // query the protected gates go first: guarantee 4 is stated as an absolute, so
  // when a budget is too small for everything the safety item is the one that
  // survives and the exact seed is the one reported as omitted.
  const reserved: ContextGraphExplainedCandidate[] = [];
  if (highRisk) {
    for (const gate of protectedGates.slice(0, config.protectedGateReserveSlots)) reserved.push(gate);
  }
  const firstExactSeed = exactSeeds[0];
  if (firstExactSeed) reserved.push(firstExactSeed);
  if (profile === 'implementation') {
    for (const evidence of implementationEvidence.slice(0, config.testOrGateReserveSlots)) reserved.push(evidence);
  }

  for (const entry of reserved) {
    if (packer.has(entry)) continue;
    packer.take(entry);
  }

  // 5: structural diversity. A single group may never take more than its share.
  // With only one group there is nothing to diversify against, so the cap is not
  // applied — otherwise a single-module repository would under-fill its budget.
  const slotAllowance = Math.max(config.minGroupSlots, Math.ceil(Math.max(0, maxSelected) * config.moduleShareCap));
  const distinctGroups = new Set(ordered.map((entry) => entry.candidate.groupKey)).size;
  const diversityApplies = distinctGroups > 1;

  for (const entry of ordered) {
    if (packer.has(entry)) continue;
    if (diversityApplies && packer.groupCount(entry) >= slotAllowance) {
      bump(packer.omissions, 'redundant_sibling');
      continue;
    }
    packer.take(entry);
  }

  const selected = [...packer.chosen.values()].sort(byScoreThenId);
  const selectedIds = new Set(selected.map((entry) => entry.candidate.node.id));
  const protectedSelected = protectedGates.filter((entry) => selectedIds.has(entry.candidate.node.id)).length;
  const guarantees: ContextGraphPackGuarantees = {
    exactSeedSelected: selected.some((entry) => entry.candidate.exactSeed),
    exactSeedAvailable: exactSeeds.length > 0,
    protectedGatesReachable: protectedGates.length,
    protectedGatesSelected: protectedSelected,
    implementationEvidenceReachable: implementationEvidence.length > 0,
    implementationEvidenceSelected: implementationEvidence.some((entry) => selectedIds.has(entry.candidate.node.id))
  };

  if (guarantees.exactSeedAvailable && !guarantees.exactSeedSelected) {
    warnings.push('exact seed did not fit the token budget; widen tokenBudget or narrow the query');
  }
  if (highRisk && guarantees.protectedGatesReachable > guarantees.protectedGatesSelected) {
    warnings.push('a reachable protected gate did not fit the token budget on a high-risk query');
  }
  if (profile === 'implementation' && guarantees.implementationEvidenceReachable && !guarantees.implementationEvidenceSelected) {
    warnings.push('no reachable test or gate fit the token budget on an implementation query');
  }

  const truncated = (packer.omissions.token_budget ?? 0) > 0 || (packer.omissions.max_selected ?? 0) > 0;
  return {
    selected,
    tokenCost: packer.spent,
    omissions: packer.omissions,
    truncated,
    warnings,
    guarantees
  };
}
