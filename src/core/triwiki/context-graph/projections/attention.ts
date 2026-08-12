/**
 * Bounded attention as a graph query.
 *
 * Anchors are whatever the retrieval kernel selected for the caller's goal under
 * the requested profile — ranked by graph structure, grounded in provenance,
 * bounded by a token budget. There is no lexical scorer here and no path that
 * reconstructs one: a missing, corrupt or stale index returns `available: false`
 * with the matching `context_graph_*` code and the repair command. The retrieval
 * path is the CG2-13 facade end to end — pointer, bytes, reader, cache, kernel,
 * hydration — so `indexFresh` is the facade's verdict rather than a second
 * opinion formed here (ADR §7).
 */
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../contracts.js';
import { contextGraphQueryProfile, type ContextGraphQueryProfileName } from '../profiles.js';
import {
  HydrationCursor,
  changedPathKernelSeeds,
  openWorkspaceContextIndex,
  queryWorkspaceContext,
  workspaceContextFailureOf,
  type WorkspaceContextQueryOptions
} from '../query/index.js';
import { projectionFailureCode, projectionFailureErrors, type ProjectionFailureCode } from './graph-facts.js';
import { projectContextGraphAnchors, type ProjectedAttentionAnchor } from './anchors.js';

/** Attention is a preface, not a briefing: the anchor set stays inside this budget. */
export const CONTEXT_GRAPH_ATTENTION_TOKEN_BUDGET = 2000;

/** Why no anchors are available. Never `lexical_fallback` — that path does not exist. */
export type ContextGraphAttentionReason = ProjectionFailureCode | 'context_graph_no_match' | 'empty_query';

/** Residency and clock knobs, passed straight through to the facade. */
export type ContextGraphAttentionOptions = Omit<WorkspaceContextQueryOptions, 'index'>;

export interface ContextGraphAttentionRequest {
  readonly root: string;
  readonly query: string;
  readonly limit: number;
  readonly profile?: ContextGraphQueryProfileName | undefined;
  readonly tokenBudget?: number | undefined;
  readonly risk?: 'normal' | 'high' | undefined;
  /**
   * Workspace-relative paths the caller already resolved — a mission's declared
   * write scope, the files in a diff. A goal sentence rarely names them, and the
   * kernel cannot infer them from one, so they enter as caller-verified
   * `file_path` seeds. Nothing here derives a path: §4 gives exact confidence to
   * what the caller identified, never to what this projection guessed.
   */
  readonly changedPaths?: readonly string[] | undefined;
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

/**
 * The refused answer. Every field the available answer carries is present and
 * emptied rather than omitted: a consumer reading `tokenCost` off a refusal must
 * get `0`, not `undefined`, or the failure surfaces as a `NaN` two layers up.
 */
function unavailable(
  reason: ContextGraphAttentionReason,
  profile: ContextGraphQueryProfileName,
  tokenBudget: number,
  warnings: readonly string[],
  snapshotHash: string | null
): ContextGraphAttentionResult {
  return {
    available: false, reason, anchors: [], profile, snapshotHash, snapshotFreshness: null,
    tokenCost: 0, tokenBudget, provenanceCoverage: 0,
    warnings: [...warnings], repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}

/**
 * Resolve bounded attention anchors for `root`. Spawn-free by construction: the
 * facade resolves the generation (pointer read plus one index read, through the
 * byte-budgeted cache) and neither the kernel nor hydration leaves memory.
 */
export async function readContextGraphAttention(
  request: ContextGraphAttentionRequest,
  options: ContextGraphAttentionOptions = {}
): Promise<ContextGraphAttentionResult> {
  const profile = contextGraphQueryProfile(request.profile).name;
  const tokenBudget = Math.max(0, request.tokenBudget ?? CONTEXT_GRAPH_ATTENTION_TOKEN_BUDGET);
  const limit = Math.max(0, Math.trunc(request.limit));
  const question = String(request.query ?? '').trim();
  if (!question || limit === 0) return unavailable('empty_query', profile, tokenBudget, [], null);

  // The handle is opened here rather than left to `queryWorkspaceContext` so the
  // anchor projection reads the same reader the answer came from. A second open
  // could resolve a different generation between the two calls, and an anchor's
  // `claim_hash` would then describe a node the query never saw.
  let answer;
  let cursor;
  try {
    const handle = await openWorkspaceContextIndex(request.root, options);
    cursor = new HydrationCursor(handle.reader);
    const risk = request.risk === undefined ? {} : { risk: request.risk };
    const provided = changedPathKernelSeeds(request.changedPaths);
    const seeds = provided.length === 0 ? {} : { seeds: provided };
    const kernelRequest = { query: question, profile, tokenBudget, maxSelected: limit, ...risk, ...seeds };
    answer = await queryWorkspaceContext(request.root, kernelRequest, { ...options, index: handle });
  } catch (error: unknown) {
    const failure = workspaceContextFailureOf(error);
    if (failure === null) throw error;
    const errors = projectionFailureErrors(failure.code, failure.repairCommand);
    return unavailable(projectionFailureCode(failure.code), profile, tokenBudget, errors, null);
  }

  const anchors = projectContextGraphAnchors(cursor, answer.hydration.nodes, limit);
  const warnings = [...answer.kernel.warnings];
  if (anchors.length === 0) {
    return unavailable('context_graph_no_match', profile, tokenBudget, warnings, answer.snapshotHash);
  }

  return {
    available: true, reason: null, anchors, profile,
    snapshotHash: answer.snapshotHash,
    snapshotFreshness: answer.indexFresh ? 'fresh' : 'stale',
    tokenCost: anchors.reduce((sum, anchor) => sum + anchor.token_cost, 0),
    tokenBudget, provenanceCoverage: answer.hydration.provenanceCoverage,
    warnings, repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}
