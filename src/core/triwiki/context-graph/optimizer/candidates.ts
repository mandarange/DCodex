/**
 * Candidate generation.
 *
 * Candidates are enumerated, not invented: a plan names pointers and
 * multipliers, and the generator emits one structured override per (pointer,
 * multiplier) pair in a fixed order. There is no randomness, no search state and
 * no free-form patch text anywhere in this file, so the same plan always yields
 * the same candidate list with the same ids.
 *
 * A value that clamps back onto its own baseline is dropped rather than emitted:
 * an experiment that changes nothing would still consume a slot of the budget.
 */
import { shortDigest } from '../ids.js';
import { contextGraphTunableParameters, resolveContextGraphTunableParameter } from './parameter-space.js';
import type { ContextGraphExperimentCandidate, ContextGraphParameterOverride, ContextGraphTuningTarget } from './types.js';

export interface ContextGraphSweepPointer {
  readonly target: ContextGraphTuningTarget;
  readonly pointer: string;
}

/**
 * The pointers worth sweeping first: the traversal shape, the confidence
 * discount, the redundancy and token pressure, and the packing reserves. These
 * are the terms the design says dominate retrieval quality per token.
 */
export const CONTEXT_GRAPH_DEFAULT_SWEEP_POINTERS: readonly ContextGraphSweepPointer[] = [
  { target: 'ranking-config', pointer: 'depthDecay' },
  { target: 'ranking-config', pointer: 'reverseEdgeMultiplier' },
  { target: 'ranking-config', pointer: 'exactSeedBonus' },
  { target: 'ranking-config', pointer: 'evidenceCoverageBonus' },
  { target: 'ranking-config', pointer: 'redundancyPenalty' },
  { target: 'ranking-config', pointer: 'tokenCostPenaltyPerToken' },
  { target: 'ranking-config', pointer: 'moduleShareCap' },
  { target: 'ranking-config', pointer: 'maxRedundancyGroupMembers' },
  { target: 'profiles', pointer: 'profiles.implementation.edgeWeights.tests' },
  { target: 'profiles', pointer: 'profiles.review.edgeWeights.gated_by' }
];

export const CONTEXT_GRAPH_DEFAULT_MULTIPLIERS: readonly number[] = [0.75, 1.25];
export const CONTEXT_GRAPH_DEFAULT_MAX_CANDIDATES = 16;

export interface ContextGraphCandidatePlan {
  readonly pointers?: readonly ContextGraphSweepPointer[];
  readonly multipliers?: readonly number[];
  readonly maxCandidates?: number;
}

function quantize(value: number, kind: 'integer' | 'real'): number {
  if (kind === 'integer') return Math.round(value);
  return Math.round(value * 1e6) / 1e6;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function candidateId(index: number, override: ContextGraphParameterOverride): string {
  const ordinal = String(index + 1).padStart(3, '0');
  return `exp-${ordinal}-${shortDigest(`${override.target} ${override.pointer} ${override.value}`, 10)}`;
}

function describe(multiplier: number): string {
  return multiplier > 1 ? `raise by ${Math.round((multiplier - 1) * 100)}%` : `lower by ${Math.round((1 - multiplier) * 100)}%`;
}

/**
 * Enumerate single-parameter candidates. Single-parameter on purpose: a
 * one-pointer delta is the only kind a reviewer can attribute a score change to
 * without re-running the sweep themselves.
 */
export function generateContextGraphCandidates(plan: ContextGraphCandidatePlan = {}): readonly ContextGraphExperimentCandidate[] {
  const pointers = plan.pointers ?? CONTEXT_GRAPH_DEFAULT_SWEEP_POINTERS;
  const multipliers = plan.multipliers ?? CONTEXT_GRAPH_DEFAULT_MULTIPLIERS;
  const maxCandidates = Math.max(0, Math.trunc(plan.maxCandidates ?? CONTEXT_GRAPH_DEFAULT_MAX_CANDIDATES));
  const out: ContextGraphExperimentCandidate[] = [];
  const seen = new Set<string>();

  for (const entry of pointers) {
    const parameter = resolveContextGraphTunableParameter(entry.target, entry.pointer);
    if (!parameter) continue;
    for (const multiplier of multipliers) {
      if (out.length >= maxCandidates) return out;
      if (!Number.isFinite(multiplier) || multiplier <= 0) continue;
      const raw = parameter.baseline === 0 ? parameter.min + (parameter.max - parameter.min) / 8 : parameter.baseline * multiplier;
      const value = quantize(clamp(raw, parameter.min, parameter.max), parameter.kind);
      if (value === parameter.baseline) continue;
      const override: ContextGraphParameterOverride = { target: entry.target, pointer: entry.pointer, value };
      const key = `${override.target}:${override.pointer}:${override.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: candidateId(out.length, override),
        label: `${entry.pointer} ${describe(multiplier)}`,
        rationale: `single-parameter sweep of ${entry.pointer} from ${parameter.baseline} to ${value} (rule ${parameter.rule})`,
        overrides: [override]
      });
    }
  }
  return out;
}

/** Every sweepable pointer in the live space, for a caller that wants the full surface. */
export function contextGraphSweepablePointers(): readonly ContextGraphSweepPointer[] {
  return contextGraphTunableParameters().map((parameter) => ({ target: parameter.target, pointer: parameter.pointer }));
}
