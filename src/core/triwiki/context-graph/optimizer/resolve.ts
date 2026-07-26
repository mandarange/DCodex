/**
 * In-memory application of a candidate's overrides.
 *
 * Nothing here writes a file. The checked-in configuration objects are cloned,
 * the overrides are set on the clones, and the clones are handed to the adapter
 * factory for the duration of one experiment. When the experiment ends the clones
 * are garbage; the repository never saw them.
 *
 * The clones are addressed through an untyped record view because the tuning
 * objects are deeply readonly by design. That cast is confined to this file and
 * every value written through it is a validated finite number.
 */
import { CONTEXT_GRAPH_EDGE_TYPES, type ContextGraphEdgeType } from '../contracts.js';
import {
  CONTEXT_GRAPH_QUERY_PROFILES,
  CONTEXT_GRAPH_QUERY_PROFILE_NAMES,
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  type ContextGraphQueryProfile,
  type ContextGraphQueryProfileName,
  type ContextGraphTraversalCaps
} from '../profiles.js';
import { CONTEXT_GRAPH_RANKING_CONFIG, type ContextGraphRankingConfig } from '../query/ranking-config.js';
import type { ContextGraphParameterOverride, ContextGraphResolvedTuning } from './types.js';

type MutableRecord = Record<string, unknown>;

/** Reads the number a pointer currently addresses, or `null` when the path is absent. */
export function readNumberAtPointer(source: unknown, pointer: string): number | null {
  const parts = pointer.split('.');
  let cursor: unknown = source;
  for (const part of parts) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return null;
    cursor = (cursor as MutableRecord)[part];
  }
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : null;
}

/**
 * Writes `value` at `pointer`, creating no intermediate objects except the last
 * container when it is a known record (an absent profile edge weight). Returns
 * false when the path does not lead to a writable slot.
 */
function writeNumberAtPointer(target: MutableRecord, pointer: string, value: number): boolean {
  const parts = pointer.split('.');
  const leaf = parts[parts.length - 1];
  if (leaf === undefined) return false;
  let cursor: MutableRecord = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part === undefined) return false;
    const next = cursor[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    cursor = next as MutableRecord;
  }
  cursor[leaf] = value;
  return true;
}

function cloneRanking(): ContextGraphRankingConfig {
  return structuredClone(CONTEXT_GRAPH_RANKING_CONFIG);
}

function cloneCaps(): ContextGraphTraversalCaps {
  return structuredClone(CONTEXT_GRAPH_TRAVERSAL_CAPS);
}

function cloneProfiles(): Record<ContextGraphQueryProfileName, ContextGraphQueryProfile> {
  const out = {} as Record<ContextGraphQueryProfileName, ContextGraphQueryProfile>;
  for (const name of CONTEXT_GRAPH_QUERY_PROFILE_NAMES) {
    out[name] = structuredClone(CONTEXT_GRAPH_QUERY_PROFILES[name]);
  }
  return out;
}

/**
 * Rebuild `edges` from `edgeWeights` so the declared edge set and the traversed
 * edge set never disagree. Edges the profile already listed keep their relative
 * order; a newly weighted edge is appended in the frozen edge-type order, so the
 * result is a pure function of the weights.
 */
function realignProfileEdges(profile: ContextGraphQueryProfile): ContextGraphQueryProfile {
  const weights = profile.edgeWeights;
  const kept: ContextGraphEdgeType[] = [];
  for (const edge of profile.edges) {
    if ((weights[edge] ?? 0) > 0) kept.push(edge);
  }
  const seen = new Set<string>(kept);
  for (const edge of CONTEXT_GRAPH_EDGE_TYPES) {
    if (seen.has(edge)) continue;
    if ((weights[edge] ?? 0) > 0) kept.push(edge);
  }
  return { ...profile, edges: kept };
}

export interface ContextGraphResolveTuningResult {
  readonly tuning: ContextGraphResolvedTuning;
  /** `target:pointer` entries whose write failed because the path does not exist. */
  readonly unresolved: readonly string[];
}

/**
 * Materialize the tuning for one experiment. Passing no overrides yields the
 * checked-in values, which is exactly what the baseline experiment measures.
 */
export function resolveContextGraphTuning(
  overrides: readonly ContextGraphParameterOverride[] = []
): ContextGraphResolveTuningResult {
  const ranking = cloneRanking();
  const profiles = cloneProfiles();
  const traversalCaps = cloneCaps();
  const profileView: MutableRecord = { profiles, traversalCaps };
  const applied = new Set<string>();
  const unresolved: string[] = [];

  for (const override of overrides) {
    const key = `${override.target}:${override.pointer}`;
    const before =
      override.target === 'ranking-config'
        ? readNumberAtPointer(ranking, override.pointer)
        : readNumberAtPointer(profileView, override.pointer);
    const ok =
      override.target === 'ranking-config'
        ? writeNumberAtPointer(ranking as unknown as MutableRecord, override.pointer, override.value)
        : writeNumberAtPointer(profileView, override.pointer, override.value);
    if (!ok) {
      unresolved.push(key);
      continue;
    }
    if (before !== override.value) applied.add(key);
  }

  for (const name of CONTEXT_GRAPH_QUERY_PROFILE_NAMES) {
    const profile = profiles[name];
    profiles[name] = realignProfileEdges(profile);
  }

  return {
    tuning: {
      ranking,
      profiles,
      traversalCaps,
      appliedPointers: [...applied].sort()
    },
    unresolved: unresolved.sort()
  };
}

/** The checked-in tuning, cloned. Used for the baseline experiment. */
export function baselineContextGraphTuning(): ContextGraphResolvedTuning {
  return resolveContextGraphTuning([]).tuning;
}
