/**
 * Naruto scope advisory over the TriWiki Context Graph.
 *
 * ADVISORY ONLY. Nothing here spawns an agent, selects a model, merges a patch,
 * allocates a worktree, or relaxes a gate. It reports which candidate slices
 * would collide and which verifiers a change needs, and every answer carries the
 * hop chain and the repository provenance that produced it.
 *
 * Conflict detection reads the *write closure* built in
 * `context-graph-advisor-scope.ts`: slices collide when their closures intersect,
 * either directly (both write the same file) or indirectly (both stand on the
 * same dependency). A shared test suite is not a collision — a test is a
 * dependent, so it never enters a write closure.
 *
 * When the graph is missing, corrupt or stale the answer is conservative by
 * construction: no slice is called parallel-safe, the recommended fan-out drops
 * to one, and the repair command is surfaced. There is no lexical fallback.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphStatusCode
} from '../triwiki/context-graph/contracts.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../triwiki/context-graph/query-types.js';
import { ERROR_BY_STATUS, forEachPair, pairKey, parallelWidth } from './context-graph-advisor-pairs.js';
import {
  HydrationCursor, isMissingWorkspaceContextIndex, openWorkspaceContextIndex,
  workspaceContextFailureOf, type ContextIndexReader
} from '../triwiki/context-graph/query/index.js';
import {
  NARUTO_ADVISOR_CAPS,
  buildNarutoSliceState,
  emptyNarutoScope,
  narutoAdvisorProvenance,
  narutoAdvisorTaskTokens,
  type NarutoAdvisorSliceInput,
  type NarutoContextGraphRecommendation,
  type NarutoContextGraphScope,
  type SliceState
} from './context-graph-advisor-scope.js';

export const NARUTO_CONTEXT_GRAPH_ADVISOR_SCHEMA = 'sks.naruto-context-graph-advisor.v1' as const;
/** This module decides nothing; the caller keeps every authority it already had. */
export const NARUTO_CONTEXT_GRAPH_ADVISOR_AUTHORITY = 'advisory_only' as const;

/** Machine-checkable statement of what this advisory refuses to do. */
export const NARUTO_ADVISOR_GUARANTEES = {
  spawns_agents: false,
  selects_models: false,
  merges_patches: false,
  skips_gates: false,
  overrides_explicit_agents: false,
  process_spawns: 0
} as const;

export {
  NARUTO_ADVISOR_CAPS,
  narutoAdvisorTaskTokens,
  type NarutoContextGraphRecommendation,
  type NarutoContextGraphScope
} from './context-graph-advisor-scope.js';

export type NarutoContextGraphSliceInput = NarutoAdvisorSliceInput;

export interface NarutoContextGraphAdvisorRequest {
  readonly root: string;
  readonly task?: string;
  readonly slices: readonly NarutoContextGraphSliceInput[];
  readonly seedPaths?: readonly string[];
  readonly seedSymbols?: readonly string[];
  readonly maxDepth?: number;
  /** Open compact index. Supplying it makes the whole call pure and I/O-free. */
  readonly reader?: ContextIndexReader;
  /** Freshness verdict from the caller's preflight; computing it here would spawn git. */
  readonly graphStatus?: ContextGraphStatusCode;
}

export interface NarutoContextGraphReason {
  readonly slice_id: string;
  readonly path: string;
  /** Hop chain; a reverse hop is prefixed with `<-`. */
  readonly reason_path: string[];
  readonly explanation: ContextGraphExplanationStep[];
  readonly provenance: ContextGraphProvenanceRef[];
}

export type NarutoContextGraphConflictKind =
  | 'direct_write_overlap'
  | 'shared_dependency'
  | 'undeclared_write_scope'
  | 'graph_not_usable';

export interface NarutoContextGraphPair {
  readonly left_slice_id: string;
  readonly right_slice_id: string;
  readonly parallel_safe: boolean;
  readonly kind: NarutoContextGraphConflictKind | null;
  readonly shared_paths: string[];
  readonly reasons: NarutoContextGraphReason[];
}

export interface NarutoContextGraphAdvice {
  readonly schema: typeof NARUTO_CONTEXT_GRAPH_ADVISOR_SCHEMA;
  readonly authority: typeof NARUTO_CONTEXT_GRAPH_ADVISOR_AUTHORITY;
  readonly ok: boolean;
  readonly graph_status: ContextGraphStatusCode;
  readonly snapshot_hash: string;
  readonly error_code: typeof CONTEXT_GRAPH_MISSING_ERROR | typeof CONTEXT_GRAPH_STALE_ERROR | typeof CONTEXT_GRAPH_CORRUPT_ERROR | null;
  readonly repair_command: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
  readonly conservative: boolean;
  readonly conservative_reasons: string[];
  readonly task_scope: NarutoContextGraphScope;
  readonly scopes: NarutoContextGraphScope[];
  readonly pairs: NarutoContextGraphPair[];
  readonly parallel_safe: boolean;
  readonly recommended_max_parallel_slices: number;
  readonly recommended_tests: NarutoContextGraphRecommendation[];
  readonly recommended_gates: NarutoContextGraphRecommendation[];
  readonly protected_domains: string[];
  readonly guarantees: typeof NARUTO_ADVISOR_GUARANTEES;
  readonly warnings: string[];
  readonly errors: string[];
}

function pairFor(reader: ContextIndexReader, cursor: HydrationCursor, left: SliceState, right: SliceState): NarutoContextGraphPair {
  const base = { left_slice_id: left.scope.slice_id, right_slice_id: right.scope.slice_id };
  // A slice whose scope resolved to nothing cannot be proven disjoint from anything.
  if (!left.scope.seed_node_ids.length || !right.scope.seed_node_ids.length) {
    return { ...base, parallel_safe: false, kind: 'undeclared_write_scope', shared_paths: [], reasons: [] };
  }
  const direct = [...left.writeSet].filter((value) => right.writeSet.has(value)).sort();
  const indirect = [...left.closure.keys()].filter((value) => right.closure.has(value) && !direct.includes(value)).sort();
  const shared = [...direct, ...indirect].slice(0, NARUTO_ADVISOR_CAPS.maxSharedPathsPerPair);
  if (!shared.length) return { ...base, parallel_safe: true, kind: null, shared_paths: [], reasons: [] };
  const reasons: NarutoContextGraphReason[] = [];
  for (const sharedPath of shared) {
    for (const side of [left, right]) {
      const hit = side.closure.get(sharedPath);
      if (!hit) continue;
      reasons.push({
        slice_id: side.scope.slice_id,
        path: sharedPath,
        reason_path: [...hit.reasonPath],
        explanation: [...hit.explanation],
        provenance: narutoAdvisorProvenance(reader, cursor, hit)
      });
    }
  }
  return { ...base, parallel_safe: false, kind: direct.length ? 'direct_write_overlap' : 'shared_dependency', shared_paths: shared, reasons };
}

interface AdviceDraft {
  readonly status: ContextGraphStatusCode;
  readonly snapshotHash: string;
  readonly conservativeReasons: string[];
  readonly taskScope: NarutoContextGraphScope;
  readonly scopes: NarutoContextGraphScope[];
  readonly pairs: NarutoContextGraphPair[];
  readonly recommendations: NarutoContextGraphRecommendation[];
  readonly width: number;
  readonly warnings: string[];
}

function finalize(draft: AdviceDraft): NarutoContextGraphAdvice {
  const errorCode = ERROR_BY_STATUS[draft.status];
  const usable = errorCode === null;
  const recommendations = usable ? draft.recommendations : [];
  const gates = recommendations.filter((row) => row.kind === 'gate');
  const domains = [...new Set(gates.filter((row) => row.protected).map((row) => row.risk_domain ?? row.id))].sort();
  return {
    schema: NARUTO_CONTEXT_GRAPH_ADVISOR_SCHEMA,
    authority: NARUTO_CONTEXT_GRAPH_ADVISOR_AUTHORITY,
    ok: usable,
    graph_status: draft.status,
    snapshot_hash: draft.snapshotHash,
    error_code: errorCode,
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND,
    conservative: !usable || draft.conservativeReasons.length > 0,
    conservative_reasons: usable ? draft.conservativeReasons : [errorCode, ...draft.conservativeReasons],
    task_scope: draft.taskScope,
    scopes: draft.scopes,
    pairs: draft.pairs,
    parallel_safe: usable && draft.pairs.every((pair) => pair.parallel_safe),
    recommended_max_parallel_slices: usable ? draft.width : 1,
    recommended_tests: recommendations.filter((row) => row.kind === 'test'),
    recommended_gates: gates,
    protected_domains: domains,
    guarantees: NARUTO_ADVISOR_GUARANTEES,
    warnings: draft.warnings,
    errors: usable
      ? []
      : [errorCode, `the stored context graph is ${draft.status}; no slice may be called parallel-safe on this evidence`, `Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild the context graph.`]
  };
}

function unusableAdvice(request: NarutoContextGraphAdvisorRequest, status: Exclude<ContextGraphStatusCode, 'fresh'>, snapshotHash: string): NarutoContextGraphAdvice {
  const slices = [...request.slices];
  const pairs: NarutoContextGraphPair[] = [];
  forEachPair(slices, (left, right) => {
    pairs.push({ left_slice_id: left.id, right_slice_id: right.id, parallel_safe: false, kind: 'graph_not_usable', shared_paths: [], reasons: [] });
  });
  return finalize({
    status,
    snapshotHash,
    conservativeReasons: [],
    taskScope: emptyNarutoScope('$task', undefined),
    scopes: slices.map((slice) => emptyNarutoScope(slice.id, slice)),
    pairs,
    recommendations: [],
    width: 1,
    warnings: []
  });
}

/** Answer against an index the caller already opened. Pure: no file system access, no process spawn. */
export function narutoContextGraphAdviceFromIndex(reader: ContextIndexReader, request: NarutoContextGraphAdvisorRequest): NarutoContextGraphAdvice {
  const status = request.graphStatus ?? 'fresh';
  if (status !== 'fresh') return unusableAdvice(request, status, reader.snapshotHash);
  // One cursor for the whole advisory: every closure shares it, so a hub node
  // reached by three slices is materialized once rather than once per walk.
  const cursor = new HydrationCursor(reader);

  const depth = Math.max(0, request.maxDepth ?? NARUTO_ADVISOR_CAPS.maxDepth);
  const warnings: string[] = [];
  const conservativeReasons: string[] = [];
  if (request.graphStatus === undefined) {
    warnings.push(`context graph freshness was not verified by this advisory; run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` if the answer looks stale`);
    conservativeReasons.push('graph_freshness_not_verified');
  }

  const taskTokens = narutoAdvisorTaskTokens(request.task ?? '');
  const taskState = buildNarutoSliceState(
    reader,
    cursor,
    {
      id: '$task',
      ...(request.seedPaths === undefined ? {} : { writePaths: request.seedPaths }),
      symbols: [...(request.seedSymbols ?? []), ...taskTokens]
    },
    taskTokens,
    depth
  );

  const states = request.slices.map((slice) => buildNarutoSliceState(reader, cursor, slice, taskTokens, depth));
  const pairs: NarutoContextGraphPair[] = [];
  const unsafe = new Set<string>();
  forEachPair(
    states.map((state) => ({ id: state.scope.slice_id, state })),
    (left, right) => {
      const pair = pairFor(reader, cursor, left.state, right.state);
      pairs.push(pair);
      if (!pair.parallel_safe) unsafe.add(pairKey(pair.left_slice_id, pair.right_slice_id));
    }
  );
  for (const state of states) {
    if (!state.scope.seed_node_ids.length && !conservativeReasons.includes('slice_scope_unresolved')) conservativeReasons.push('slice_scope_unresolved');
    if (state.scope.truncated && !conservativeReasons.includes('closure_truncated')) conservativeReasons.push('closure_truncated');
  }
  // `$task` is checked here and not in the loop above because its recommendations
  // *are* merged into the answer, unlike its scope, which is reported on its own
  // `task_scope.truncated` field. A short recommendation list has no such field.
  for (const state of [taskState, ...states]) {
    if (state.recommendationsTruncated && !conservativeReasons.includes('recommendations_truncated')) {
      conservativeReasons.push('recommendations_truncated');
    }
  }

  return finalize({
    status: 'fresh',
    snapshotHash: reader.snapshotHash,
    conservativeReasons,
    taskScope: taskState.scope,
    scopes: states.map((state) => state.scope),
    pairs,
    recommendations: [...taskState.recommendations, ...states.flatMap((state) => state.recommendations)],
    width: parallelWidth(states.map((state) => state.scope.slice_id), unsafe),
    warnings
  });
}

/**
 * Open the current index for `request.root` and answer.
 *
 * An unusable index is reported, not thrown: this is consulted while a caller
 * decides a fan-out, and the conservative answer (nothing parallel-safe, width 1,
 * repair named) is what that caller needs. It is still explicit — `ok: false`
 * with the code — never a quiet empty result reading as "no conflicts found".
 */
export async function narutoContextGraphAdvice(request: NarutoContextGraphAdvisorRequest): Promise<NarutoContextGraphAdvice> {
  if (request.reader) return narutoContextGraphAdviceFromIndex(request.reader, request);
  if (request.graphStatus && request.graphStatus !== 'fresh') return unusableAdvice(request, request.graphStatus, '');
  try {
    const handle = await openWorkspaceContextIndex(request.root);
    return narutoContextGraphAdviceFromIndex(handle.reader, request);
  } catch (error) {
    if (workspaceContextFailureOf(error) === null) throw error;
    return unusableAdvice(request, isMissingWorkspaceContextIndex(error) ? 'missing' : 'corrupt', '');
  }
}
