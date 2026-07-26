/**
 * The parameter space, derived rather than transcribed.
 *
 * The set of tunable pointers is walked out of the live `CONTEXT_GRAPH_RANKING_CONFIG`,
 * `CONTEXT_GRAPH_QUERY_PROFILES` and `CONTEXT_GRAPH_TRAVERSAL_CAPS` objects, so a
 * new weight added to either tuning file becomes tunable automatically and a
 * removed one stops being addressable. Only the *bounds* are declared here, as a
 * short ordered rule list, and every live pointer must match a rule.
 *
 * A profile edge weight may be driven to zero: the traversal skips any edge whose
 * profile weight is not positive, so zero is how a candidate removes an edge from
 * a profile's edge set, and a positive value on an edge the profile does not
 * currently carry is how it adds one.
 */
import { CONTEXT_GRAPH_EDGE_TYPES, isContextGraphEdgeType } from '../contracts.js';
import {
  CONTEXT_GRAPH_QUERY_PROFILES,
  CONTEXT_GRAPH_QUERY_PROFILE_NAMES,
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  isContextGraphQueryProfileName
} from '../profiles.js';
import { CONTEXT_GRAPH_RANKING_CONFIG } from '../query/ranking-config.js';
import type { ContextGraphTunableParameter, ContextGraphTuningTarget } from './types.js';

/** Ranking fields whose value is a count, not a weight. */
const INTEGER_COUNT_POINTERS: ReadonlySet<string> = new Set([
  'minExactSeeds',
  'maxLexicalSeeds',
  'lexicalScanBudget',
  'lexicalMinTokenLength',
  'maxQueryTokens',
  'maxSeedsPerToken',
  'timeoutCheckInterval',
  'minGroupSlots',
  'maxRedundancyGroupMembers',
  'protectedGateReserveSlots',
  'testOrGateReserveSlots',
  'maxProvenancePerNode',
  'minTokenCost'
]);

/** Counts for which zero is degenerate rather than merely aggressive. */
const POSITIVE_COUNT_POINTERS: ReadonlySet<string> = new Set([
  'lexicalScanBudget',
  'lexicalMinTokenLength',
  'maxQueryTokens',
  'maxSeedsPerToken',
  'timeoutCheckInterval',
  'minGroupSlots',
  'maxRedundancyGroupMembers',
  'maxProvenancePerNode',
  'minTokenCost'
]);

/** Ranking fields that are fractions of something and cannot exceed one. */
const UNIT_INTERVAL_POINTERS: ReadonlySet<string> = new Set(['depthDecay', 'reverseEdgeMultiplier', 'moduleShareCap']);

export const CONTEXT_GRAPH_MIN_PROFILE_DEPTH = 1;
export const CONTEXT_GRAPH_MAX_PROFILE_DEPTH = 4;
export const CONTEXT_GRAPH_MAX_EDGE_WEIGHT = 8;
export const CONTEXT_GRAPH_MIN_UNIT_INTERVAL = 0.05;

interface BoundRule {
  readonly id: string;
  matches(pointer: string, baseline: number): boolean;
  bounds(baseline: number): { kind: 'integer' | 'real'; min: number; max: number };
}

function profileSegment(pointer: string, index: number): string | null {
  const parts = pointer.split('.');
  if (parts[0] !== 'profiles') return null;
  return parts[index] ?? null;
}

const RULES: readonly BoundRule[] = [
  {
    id: 'profile_depth',
    matches: (pointer) => {
      const field = profileSegment(pointer, 2);
      return (
        isContextGraphQueryProfileName(profileSegment(pointer, 1)) &&
        (field === 'maxDepth' || field === 'maxDepthHighRisk') &&
        pointer.split('.').length === 3
      );
    },
    bounds: () => ({ kind: 'integer', min: CONTEXT_GRAPH_MIN_PROFILE_DEPTH, max: CONTEXT_GRAPH_MAX_PROFILE_DEPTH })
  },
  {
    id: 'profile_edge_weight',
    matches: (pointer) => {
      const parts = pointer.split('.');
      return (
        parts.length === 4 &&
        parts[0] === 'profiles' &&
        isContextGraphQueryProfileName(parts[1]) &&
        parts[2] === 'edgeWeights' &&
        isContextGraphEdgeType(parts[3])
      );
    },
    bounds: () => ({ kind: 'real', min: 0, max: CONTEXT_GRAPH_MAX_EDGE_WEIGHT })
  },
  {
    id: 'traversal_cap',
    matches: (pointer) => pointer.startsWith('traversalCaps.') && pointer.split('.').length === 2,
    bounds: (baseline) => ({
      kind: 'integer',
      min: Math.max(1, Math.ceil(baseline / 8)),
      max: Math.max(2, Math.trunc(baseline * 4))
    })
  },
  {
    id: 'unit_interval',
    matches: (pointer) => UNIT_INTERVAL_POINTERS.has(pointer) || pointer.startsWith('edgeConfidenceMultiplier.'),
    bounds: () => ({ kind: 'real', min: CONTEXT_GRAPH_MIN_UNIT_INTERVAL, max: 1 })
  },
  {
    id: 'count',
    matches: (pointer) => INTEGER_COUNT_POINTERS.has(pointer),
    // `resolveRule` lifts the floor to 1 for the pointers where zero is degenerate.
    bounds: (baseline) => ({ kind: 'integer', min: 0, max: Math.max(2, Math.trunc(Math.abs(baseline) * 4 + 8)) })
  },
  {
    id: 'negative_bonus',
    matches: (_pointer, baseline) => baseline < 0,
    bounds: (baseline) => ({ kind: 'real', min: -(Math.abs(baseline) * 4 + 1), max: 0 })
  },
  {
    id: 'weight',
    matches: () => true,
    bounds: (baseline) => ({ kind: 'real', min: 0, max: Math.abs(baseline) * 4 + 4 })
  }
];

function resolveRule(pointer: string, baseline: number): { rule: BoundRule; kind: 'integer' | 'real'; min: number; max: number } {
  for (const rule of RULES) {
    if (!rule.matches(pointer, baseline)) continue;
    const bounds = rule.bounds(baseline);
    const min = rule.id === 'count' && POSITIVE_COUNT_POINTERS.has(pointer) ? Math.max(1, bounds.min) : bounds.min;
    return { rule, kind: bounds.kind, min, max: bounds.max };
  }
  // `weight` matches everything, so this is unreachable; kept total for the type.
  return { rule: RULES[RULES.length - 1] as BoundRule, kind: 'real', min: 0, max: Math.abs(baseline) * 4 + 4 };
}

function parameterFor(target: ContextGraphTuningTarget, pointer: string, baseline: number): ContextGraphTunableParameter {
  const resolved = resolveRule(pointer, baseline);
  return {
    target,
    pointer,
    baseline,
    kind: resolved.kind,
    min: Math.min(resolved.min, baseline),
    max: Math.max(resolved.max, baseline),
    rule: resolved.rule.id
  };
}

function collectNumbers(source: unknown, prefix: string, into: Map<string, number>): void {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return;
  for (const key of Object.keys(source as Record<string, unknown>).sort()) {
    const value = (source as Record<string, unknown>)[key];
    const pointer = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'number' && Number.isFinite(value)) {
      into.set(pointer, value);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) collectNumbers(value, pointer, into);
  }
}

function buildSpace(): ReadonlyMap<string, ContextGraphTunableParameter> {
  const out = new Map<string, ContextGraphTunableParameter>();
  const ranking = new Map<string, number>();
  collectNumbers(CONTEXT_GRAPH_RANKING_CONFIG, '', ranking);
  for (const [pointer, baseline] of ranking) {
    out.set(`ranking-config:${pointer}`, parameterFor('ranking-config', pointer, baseline));
  }
  const profiles = new Map<string, number>();
  collectNumbers({ profiles: CONTEXT_GRAPH_QUERY_PROFILES, traversalCaps: CONTEXT_GRAPH_TRAVERSAL_CAPS }, '', profiles);
  for (const [pointer, baseline] of profiles) {
    out.set(`profiles:${pointer}`, parameterFor('profiles', pointer, baseline));
  }
  return out;
}

const SPACE = buildSpace();

export function contextGraphParameterKey(target: ContextGraphTuningTarget, pointer: string): string {
  return `${target}:${pointer}`;
}

/** Every pointer that exists in the checked-in tuning files, sorted by key. */
export function contextGraphTunableParameters(): readonly ContextGraphTunableParameter[] {
  return [...SPACE.values()].sort((left, right) =>
    contextGraphParameterKey(left.target, left.pointer) < contextGraphParameterKey(right.target, right.pointer) ? -1 : 1
  );
}

/**
 * Resolve one addressable parameter. A profile edge weight for an edge the
 * profile does not currently carry resolves with a baseline of zero, which is how
 * a candidate proposes adding that edge to the profile's edge set.
 */
export function resolveContextGraphTunableParameter(
  target: ContextGraphTuningTarget,
  pointer: string
): ContextGraphTunableParameter | null {
  const known = SPACE.get(contextGraphParameterKey(target, pointer));
  if (known) return known;
  if (target !== 'profiles') return null;
  const parts = pointer.split('.');
  if (parts.length !== 4 || parts[0] !== 'profiles' || parts[2] !== 'edgeWeights') return null;
  if (!isContextGraphQueryProfileName(parts[1]) || !isContextGraphEdgeType(parts[3])) return null;
  return parameterFor('profiles', pointer, 0);
}

/** Every profile edge weight pointer, including the edges a profile does not carry today. */
export function contextGraphProfileEdgePointers(): readonly string[] {
  const out: string[] = [];
  for (const name of CONTEXT_GRAPH_QUERY_PROFILE_NAMES) {
    for (const edge of CONTEXT_GRAPH_EDGE_TYPES) out.push(`profiles.${name}.edgeWeights.${edge}`);
  }
  return out;
}
