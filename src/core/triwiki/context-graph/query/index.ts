/**
 * The Context Graph query kernel.
 *
 * `queryContextGraphSnapshot` is the whole engine: it takes an already-built
 * index and does no I/O and no process spawning at all. `queryContextGraph` is
 * the convenience wrapper that resolves the snapshot for a workspace — through
 * the in-process cache, so a repeated query in one process re-uses the parsed
 * snapshot and its adjacency instead of paying for either again.
 *
 * The pipeline is fixed: normalize -> exact seeds -> (lexical seeds only if the
 * exact ones are insufficient) -> profile-bounded bidirectional traversal ->
 * deterministic scoring -> redundancy suppression -> token packing -> explanation.
 * There is no branch anywhere in it that falls back to text search when the graph
 * is unusable; that case returns an explicit error and the repair command.
 */
import {
  CONTEXT_GRAPH_QUERY_SCHEMA,
  emptyContextGraphQueryResult,
  type ContextGraphOmissionReason,
  type ContextGraphQueryRequest,
  type ContextGraphQueryResult,
  type ContextGraphSearchMeta
} from '../query-types.js';
import {
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  contextGraphQueryProfile,
  type ContextGraphQueryProfileName
} from '../profiles.js';
import type { ContextGraphIndex } from '../graph-index.js';
import { isWorkspaceRelativePosixPath } from '../paths.js';
import { explainContextGraphCandidates, toContextGraphSelectedNode, contextGraphProvenanceCoverage } from './explain.js';
import { loadContextGraphIndex, type LoadContextGraphIndexOptions } from './load.js';
import { packContextGraphSelection } from './pack.js';
import { isHighRiskScope, rankContextGraphCandidates } from './rank.js';
import { CONTEXT_GRAPH_RANKING_CONFIG, type ContextGraphRankingConfig } from './ranking-config.js';
import { resolveContextGraphSeeds } from './seeds.js';
import { traverseContextGraph } from './traverse.js';

export interface ContextGraphQuerySnapshotOptions {
  /** Tuning surface. Defaults to the checked-in ranking configuration. */
  readonly config?: ContextGraphRankingConfig | undefined;
  readonly snapshotFreshness?: 'fresh' | 'stale' | undefined;
  /** Injected wall clock, so a test can drive the traversal deadline deterministically. */
  readonly clock?: (() => number) | undefined;
  readonly warnings?: readonly string[] | undefined;
}

export interface ContextGraphQueryOptions extends LoadContextGraphIndexOptions, ContextGraphQuerySnapshotOptions {
  /** Pre-built index. Supplying it skips every file read and every cache lookup. */
  readonly index?: ContextGraphIndex | undefined;
}

function add(into: Partial<Record<ContextGraphOmissionReason, number>>, reason: ContextGraphOmissionReason, count: number): void {
  if (count <= 0) return;
  into[reason] = (into[reason] ?? 0) + count;
}

function usableFocusPaths(request: ContextGraphQueryRequest): string[] {
  const out: string[] = [];
  for (const focus of request.focusPaths ?? []) {
    const normalized = String(focus ?? '').replace(/^\.\//, '').replace(/\/+$/, '');
    if (normalized && isWorkspaceRelativePosixPath(normalized) && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/**
 * Answer a request against an index the caller already holds. Pure: no file
 * system access, no network, no child process — `processSpawns` is 0 by construction.
 */
export function queryContextGraphSnapshot(
  index: ContextGraphIndex,
  request: ContextGraphQueryRequest,
  options: ContextGraphQuerySnapshotOptions = {}
): ContextGraphQueryResult {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const config = options.config ?? CONTEXT_GRAPH_RANKING_CONFIG;
  const profile = contextGraphQueryProfile(request.profile);
  const caps = CONTEXT_GRAPH_TRAVERSAL_CAPS;
  const tokenBudget = Math.max(0, request.tokenBudget ?? caps.defaultTokenBudget);
  const maxSelected = Math.max(0, Math.min(request.maxSelected ?? caps.maxSelectedNodes, caps.maxSelectedNodes));
  const timeoutMs = Math.max(0, request.timeoutMs ?? caps.queryTimeoutMs);
  const deadline = timeoutMs > 0 ? startedAt + timeoutMs : null;
  const warnings: string[] = [...(options.warnings ?? [])];

  const resolution = resolveContextGraphSeeds({ index, request, config, maxSeeds: caps.maxSeeds });
  if (resolution.unknownProvidedSeeds > 0) {
    warnings.push(`${resolution.unknownProvidedSeeds} caller-supplied seed(s) are not present in this snapshot`);
  }
  if (resolution.scanBudgetExhausted) {
    warnings.push('lexical seeding stopped at its scan budget; results may be incomplete');
  }
  if (resolution.seeds.length === 0) {
    warnings.push('no graph node matched this query; nothing was selected and no text fallback was attempted');
  }

  const focusPaths = usableFocusPaths(request);
  const highRisk = isHighRiskScope(index, resolution.seeds, request);
  const maxDepth = highRisk ? profile.maxDepthHighRisk : profile.maxDepth;

  const traversal = traverseContextGraph({
    index,
    seeds: resolution.seeds,
    profile,
    maxDepth,
    maxVisitedNodes: caps.maxVisitedNodes,
    maxVisitedEdges: caps.maxVisitedEdges,
    config,
    focusPaths,
    deadline
  });

  const seedsByNode = new Map(resolution.seeds.map((seed) => [seed.nodeId, seed] as const));
  const ranked = rankContextGraphCandidates({
    index,
    states: traversal.states,
    seedsByNode,
    request,
    config,
    focusActive: focusPaths.length > 0
  });
  if (ranked.focusExcluded > 0) {
    warnings.push(`${ranked.focusExcluded} reachable node(s) were outside the requested focus paths`);
  }

  const explainResult = explainContextGraphCandidates({
    index,
    states: traversal.states,
    candidates: ranked.candidates,
    config
  });

  const packed = packContextGraphSelection({
    explained: explainResult.explained,
    tokenBudget,
    maxSelected,
    profile: profile.name,
    highRisk,
    config
  });
  warnings.push(...packed.warnings);

  // Omission accounting. `visit_cap` carries both the seeds that did not fit the
  // seed cap (a real count) and a single unit for "the visited-node cap stopped
  // the walk", because at that point the number of unreached nodes is by
  // definition unknown. `edge_cap` and `timeout` are counted the same way.
  const omissionReasons: Partial<Record<ContextGraphOmissionReason, number>> = { ...packed.omissions };
  add(omissionReasons, 'stale_node', ranked.staleExcluded);
  add(omissionReasons, 'invalidated_proof', ranked.invalidatedExcluded);
  add(omissionReasons, 'redundant_sibling', ranked.redundantExcluded);
  add(omissionReasons, 'no_provenance', explainResult.ungrounded);
  add(omissionReasons, 'depth_limit', traversal.depthLimited);
  add(omissionReasons, 'visit_cap', (traversal.nodeCapHit ? 1 : 0) + resolution.droppedSeeds);
  add(omissionReasons, 'edge_cap', traversal.edgeCapHit ? 1 : 0);
  add(omissionReasons, 'timeout', traversal.timedOut ? 1 : 0);

  const selected = packed.selected.map(toContextGraphSelectedNode);
  const truncated =
    packed.truncated || traversal.nodeCapHit || traversal.edgeCapHit || traversal.timedOut || resolution.droppedSeeds > 0;

  return {
    schema: CONTEXT_GRAPH_QUERY_SCHEMA,
    ok: true,
    snapshotHash: index.snapshot.snapshotHash,
    snapshotFreshness: options.snapshotFreshness ?? 'fresh',
    profile: profile.name,
    seeds: resolution.seeds,
    seedCount: resolution.seeds.length,
    visitedNodes: traversal.visitedNodes,
    visitedEdges: traversal.visitedEdges,
    selected,
    selectedNodes: selected.length,
    explanationPathCount: selected.filter((node) => node.explanation.length > 0).length,
    provenanceCoverage: contextGraphProvenanceCoverage(selected),
    staleExcluded: ranked.staleExcluded,
    invalidatedExcluded: ranked.invalidatedExcluded,
    tokenCost: packed.tokenCost,
    tokenBudget,
    truncated,
    timeout: traversal.timedOut,
    omissionReasons,
    warnings,
    errors: [],
    durationMs: Math.max(0, clock() - startedAt),
    processSpawns: 0
  };
}

function failedResult(
  profile: ContextGraphQueryProfileName,
  snapshotHash: string,
  errors: readonly string[],
  warnings: readonly string[],
  tokenBudget: number,
  durationMs: number
): ContextGraphQueryResult {
  const base = emptyContextGraphQueryResult(snapshotHash, profile, [...errors]);
  return { ...base, warnings: [...warnings], tokenBudget, durationMs };
}

/**
 * Resolve the workspace snapshot and answer. A missing, corrupt or stale graph
 * returns `ok: false` carrying the matching `context_graph_*` code and the repair
 * command — never a degraded answer produced some other way.
 */
export async function queryContextGraph(
  request: ContextGraphQueryRequest,
  options: ContextGraphQueryOptions = {}
): Promise<ContextGraphQueryResult> {
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const profileName = contextGraphQueryProfile(request.profile).name;
  const tokenBudget = Math.max(0, request.tokenBudget ?? CONTEXT_GRAPH_TRAVERSAL_CAPS.defaultTokenBudget);

  if (options.index) {
    return queryContextGraphSnapshot(options.index, request, options);
  }

  const load = await loadContextGraphIndex(request.root, options);
  if (!load.ok || !load.index) {
    return failedResult(profileName, load.snapshotHash, load.errors, load.warnings, tokenBudget, Math.max(0, clock() - startedAt));
  }

  const snapshotOptions: ContextGraphQuerySnapshotOptions = {
    ...(options.config === undefined ? {} : { config: options.config }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    snapshotFreshness: load.freshness,
    warnings: [...load.warnings, ...(options.warnings ?? [])]
  };
  return queryContextGraphSnapshot(load.index, request, snapshotOptions);
}

/** Additive projection for `SearchResponse.context`; carries no path outside the workspace. */
export function contextGraphSearchMeta(result: ContextGraphQueryResult): ContextGraphSearchMeta {
  const omissionReasons: Record<string, number> = {};
  for (const [reason, count] of Object.entries(result.omissionReasons)) {
    if (typeof count === 'number' && count > 0) omissionReasons[reason] = count;
  }
  return {
    snapshotHash: result.snapshotHash,
    snapshotFreshness: result.snapshotFreshness,
    profile: result.profile,
    seedCount: result.seedCount,
    visitedNodes: result.visitedNodes,
    selectedNodes: result.selectedNodes,
    explanationPathCount: result.explanationPathCount,
    provenanceCoverage: result.provenanceCoverage,
    staleExcluded: result.staleExcluded,
    invalidatedExcluded: result.invalidatedExcluded,
    tokenCost: result.tokenCost,
    tokenBudget: result.tokenBudget,
    omissionReasons
  };
}

export {
  CONTEXT_GRAPH_RANKING_CONFIG,
  CONTEXT_GRAPH_RANKING_SCHEMA,
  CONTEXT_GRAPH_EXACT_SEED_CONFIDENCES,
  isExactContextGraphSeedConfidence,
  type ContextGraphRankingConfig
} from './ranking-config.js';
export {
  normalizeContextGraphQuery,
  resolveContextGraphSeeds,
  seedConfidenceFor,
  type ContextGraphSeedResolution,
  type NormalizedContextGraphQuery
} from './seeds.js';
export {
  traverseContextGraph,
  contextGraphNodePath,
  isUnderFocusPath,
  type ContextGraphTraversalResult,
  type ContextGraphTraversalState
} from './traverse.js';
export {
  rankContextGraphCandidates,
  contextGraphGroupKey,
  isInvalidatedContextGraphNode,
  isHighRiskScope,
  type ContextGraphRankedCandidate,
  type ContextGraphRankResult
} from './rank.js';
export {
  explainContextGraphCandidates,
  groundContextGraphNode,
  toContextGraphSelectedNode,
  contextGraphProvenanceCoverage,
  type ContextGraphExplainedCandidate,
  type ContextGraphExplainResult
} from './explain.js';
export {
  packContextGraphSelection,
  type ContextGraphPackGuarantees,
  type ContextGraphPackResult
} from './pack.js';
export {
  loadContextGraphIndex,
  contextGraphRepairHint,
  type ContextGraphFreshnessVerdict,
  type ContextGraphIndexLoad,
  type ContextGraphLoadErrorCode,
  type LoadContextGraphIndexOptions
} from './load.js';
export {
  CONTEXT_GRAPH_SNAPSHOT_CACHE_MAX_ENTRIES,
  cacheContextGraphIndex,
  clearContextGraphSnapshotCache,
  contextGraphSnapshotCacheStats,
  contextGraphWorkspaceKey,
  getCachedContextGraphIndex,
  type ContextGraphSnapshotCacheStats
} from './snapshot-cache.js';

// ---------------------------------------------------------------------------
// CRK2 (CG2-13). The compact surface every consumer migrates onto.
//
// `verifyHydrationOnDisk` is deliberately absent. `hydrate.ts` does not
// re-export it either, and that pair of non-re-exports is the whole reason the
// query path links no filesystem module: strict callers import it from
// `hydrate-verify.js` directly, and routing it through this barrel would make
// every consumer of the facade pull `node:fs` in behind it.
// ---------------------------------------------------------------------------
export {
  CONTEXT_WORKSPACE_QUERY_SCHEMA,
  clearWorkspaceContextIndex,
  isMissingWorkspaceContextIndex,
  openWorkspaceContextIndex,
  queryWorkspaceContext,
  workspaceContextFailureOf,
  type OpenWorkspaceContextIndexOptions,
  type WorkspaceContextAnswer,
  type WorkspaceContextFailure,
  type WorkspaceContextIndexHandle,
  type WorkspaceContextQueryOptions
} from './workspace.js';
export {
  REVERSE_HOP_PREFIX,
  contextNodeFlag,
  contextWalkProvenance,
  contextWalkRoot,
  resolveContextSeeds,
  walkContextGraph,
  type ContextSeedResolution,
  type ContextWalkCaps,
  type ContextWalkHit,
  type ContextWalkRequest,
  type ContextWalkResult
} from './walk.js';
export {
  ContextIndexCache,
  CONTEXT_INDEX_CACHE_DEFAULT_BUDGET,
  contextIndexWorkspaceKey,
  setSharedContextIndexCache,
  sharedContextIndexCache,
  type ContextIndexCacheStats
} from './cache.js';
export {
  CONTEXT_HYDRATION_SCHEMA,
  contextHydrationCoverage,
  hydrateSelectedCandidates,
  withHydrationGrounding,
  HydrationCursor,
  type HydratedNode,
  type HydrationGrounding,
  type HydrationOmission,
  type HydrationResult
} from './hydrate.js';
export {
  fixedKernelClock,
  runContextKernel,
  type ContextKernelOptions
} from './kernel.js';
export type {
  ContextKernelResult,
  KernelClock,
  KernelProvidedSeed,
  KernelRequest,
  SelectedCandidate
} from './kernel-types.js';
/** Named so consumers have a type without naming a `runtime-index/**` module path. */
export type {
  ContextGraphEdgeView,
  ContextGraphNodeView,
  ContextIndexReader,
  EdgeCursor,
  ProvenanceView
} from '../runtime-index/reader.js';
