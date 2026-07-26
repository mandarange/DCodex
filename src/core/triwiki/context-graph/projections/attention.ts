/**
 * Bounded attention as a graph query.
 *
 * Anchors are whatever the query engine selected for the caller's goal under the
 * requested profile — ranked by graph structure, grounded in provenance, and
 * bounded by a token budget. There is no lexical scorer here and no path that
 * reconstructs one: when the stored graph is missing, corrupt or stale this
 * returns `available: false` with the matching `context_graph_*` code and the
 * repair command, and the caller is expected to say so rather than to guess.
 */
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../contracts.js';
import { contextGraphQueryProfile, type ContextGraphQueryProfileName } from '../profiles.js';
import { queryContextGraphSnapshot } from '../query/index.js';
import { loadContextGraphIndex, type ContextGraphLoadErrorCode, type LoadContextGraphIndexOptions } from '../query/load.js';
import { projectContextGraphAnchors, type ProjectedAttentionAnchor } from './anchors.js';

/** Attention is a preface, not a briefing: the anchor set stays inside this budget. */
export const CONTEXT_GRAPH_ATTENTION_TOKEN_BUDGET = 2000;

/** Why no anchors are available. Never `lexical_fallback` — that path does not exist. */
export type ContextGraphAttentionReason = ContextGraphLoadErrorCode | 'context_graph_no_match' | 'empty_query';

export interface ContextGraphAttentionRequest {
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly profile?: ContextGraphQueryProfileName | undefined;
  readonly tokenBudget?: number | undefined;
  readonly risk?: 'normal' | 'high' | undefined;
}

export interface ContextGraphAttentionResult {
  readonly available: boolean;
  readonly reason: ContextGraphAttentionReason | null;
  readonly anchors: ProjectedAttentionAnchor[];
  readonly profile: ContextGraphQueryProfileName;
  readonly snapshotHash: string | null;
  readonly snapshotFreshness: 'fresh' | 'stale' | null;
  readonly tokenCost: number;
  readonly tokenBudget: number;
  readonly provenanceCoverage: number;
  readonly warnings: string[];
  readonly repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
}

function unavailable(
  reason: ContextGraphAttentionReason,
  profile: ContextGraphQueryProfileName,
  tokenBudget: number,
  warnings: readonly string[],
  snapshotHash: string | null
): ContextGraphAttentionResult {
  return {
    available: false,
    reason,
    anchors: [],
    profile,
    snapshotHash,
    snapshotFreshness: null,
    tokenCost: 0,
    tokenBudget,
    provenanceCoverage: 0,
    warnings: [...warnings],
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}

/**
 * Resolve bounded attention anchors for `root`.
 *
 * Spawn-free by construction: the snapshot is resolved through the query
 * engine's loader (pure file I/O plus the in-process cache) and the traversal
 * itself never leaves memory.
 */
export async function readContextGraphAttention(
  request: ContextGraphAttentionRequest,
  options: LoadContextGraphIndexOptions = {}
): Promise<ContextGraphAttentionResult> {
  const profile = contextGraphQueryProfile(request.profile).name;
  const tokenBudget = Math.max(0, request.tokenBudget ?? CONTEXT_GRAPH_ATTENTION_TOKEN_BUDGET);
  const limit = Math.max(0, Math.trunc(request.limit));
  const question = String(request.query ?? '').trim();
  if (!question || limit === 0) return unavailable('empty_query', profile, tokenBudget, [], null);

  const load = await loadContextGraphIndex(request.root, options);
  if (!load.ok || !load.index) {
    return unavailable(
      load.errorCode ?? 'context_graph_missing',
      profile,
      tokenBudget,
      load.errors,
      load.snapshotHash || null
    );
  }

  const result = queryContextGraphSnapshot(
    load.index,
    {
      root: request.root,
      query: question,
      profile,
      tokenBudget,
      maxSelected: limit,
      ...(request.risk === undefined ? {} : { risk: request.risk })
    },
    { snapshotFreshness: load.freshness, warnings: load.warnings }
  );
  const anchors = projectContextGraphAnchors(load.index, result.selected, limit);
  if (anchors.length === 0) {
    return unavailable('context_graph_no_match', profile, tokenBudget, result.warnings, result.snapshotHash);
  }

  return {
    available: true,
    reason: null,
    anchors,
    profile: result.profile,
    snapshotHash: result.snapshotHash,
    snapshotFreshness: result.snapshotFreshness,
    tokenCost: anchors.reduce((sum, anchor) => sum + anchor.token_cost, 0),
    tokenBudget,
    provenanceCoverage: result.provenanceCoverage,
    warnings: result.warnings,
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}
