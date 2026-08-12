/**
 * The workspace query path: the one place that turns a repository root into an
 * answer (CG2-13).
 *
 * Every piece this joins already existed — the pointer resolver, the binary
 * reader, the byte-budgeted cache, the kernel, the hydration pass — and none of
 * them knew about each other. That gap is why `resolveCurrentContextIndex` had
 * no callers: the parts were assigned and the seam between them was not. Every
 * consumer needs exactly this sequence, so it lives here once rather than being
 * re-assembled at five call sites that would drift apart.
 *
 *   pointer + meta  ->  bytes  ->  openContextIndex  ->  cache
 *                   ->  runContextKernel  ->  hydrateSelectedCandidates
 *
 * Four properties are structural rather than reviewed:
 *
 * - **No fallback.** A missing, stale or corrupt index raises the frozen ADR §5
 *   code with its repair command. There is no branch to the v1 JSON snapshot, no
 *   "try the previous generation", and no degraded answer. `workspaceContextFailureOf`
 *   exists so a consumer can *project* that refusal into its own response shape,
 *   never so it can continue past it.
 * - **No filesystem module on the query path.** This file reads the index bytes
 *   and nothing else. `verifyHydrationOnDisk` lives in `hydrate-verify.ts` and is
 *   deliberately not re-exported from here or from `hydrate.ts`: strict callers
 *   import it directly, and the query path never links it.
 * - **One response cache, inside the generation that produced the response.** A
 *   response is only meaningful against the index it came from, so it is stored
 *   against that generation and dies with it. A second cache with its own TTL is
 *   a second chance to serve an answer the workspace has moved past.
 * - **The clock is injected.** `Date.now` appears once, as the default argument,
 *   so a test can drive the traversal deadline deterministically.
 */
import fsp from 'node:fs/promises';
import {
  ContextIndexStoreError,
  type ContextIndexStoreErrorCode,
} from '../store/generation-errors.js';
import { resolveCurrentContextIndex } from '../store/generation-resolve.js';
import { contextIndexFailureOf, openContextIndex } from '../runtime-index/reader.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';
import { CONTEXT_GRAPH_RANKING_CONFIG, type ContextGraphRankingConfig } from './ranking-config.js';
import { ContextIndexCache, sharedContextIndexCache } from './cache.js';
import { runContextKernel, type ContextKernelOptions } from './kernel.js';
import type { ContextKernelResult, KernelClock, KernelRequest } from './kernel-types.js';
import { hydrateSelectedCandidates, type HydrationResult } from './hydrate.js';

export const CONTEXT_WORKSPACE_QUERY_SCHEMA = 'sks.context-workspace-query.v1' as const;

/**
 * An opened generation.
 *
 * `fresh` is not re-derived from the reader: freshness is the pointer and the
 * meta agreeing on a snapshot fingerprint, established once here before anything
 * runs. A second opinion formed later could disagree with the one the query
 * actually ran under, which is the ambiguity ADR §7 removed.
 */
export interface WorkspaceContextIndexHandle {
  readonly reader: ContextIndexReader;
  readonly snapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
  /** ISO instant the generation was committed; the closest thing to "index age". */
  readonly committedAt: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** True once the index opened: an unfresh index does not open at all. */
  readonly fresh: boolean;
  readonly cacheHit: boolean;
}

export interface OpenWorkspaceContextIndexOptions {
  /**
   * Residency. Defaults to the process-wide cache; pass `null` to bypass it
   * entirely, which is what a test wanting a cold read every time should do.
   */
  readonly cache?: ContextIndexCache | null;
  /**
   * The workspace fingerprint the caller's preflight computed. Supplying it is
   * what turns "the index parses" into "the index describes *this* tree" —
   * without it, a stale index is only caught when its own pointer disagrees.
   */
  readonly expectedSourceFingerprint?: string | undefined;
}

/**
 * Open the current generation for `root`, or throw.
 *
 * Throwing rather than returning a union is deliberate at this layer: there is
 * no answer to give, and a union invites a caller to write `if (!ok)` and carry
 * on with a half-built result. Consumers that must render a failure convert it
 * with `workspaceContextFailureOf`.
 */
export async function openWorkspaceContextIndex(
  root: string,
  options: OpenWorkspaceContextIndexOptions = {},
): Promise<WorkspaceContextIndexHandle> {
  const resolved = await resolveCurrentContextIndex(root, {
    expectedSourceFingerprint: options.expectedSourceFingerprint,
  });
  const pointer = resolved.pointer;
  const cache = options.cache === undefined ? sharedContextIndexCache() : options.cache;

  const cached = cache === null ? null : cache.getReader(root, pointer.snapshotHash);
  if (cached !== null) return handleOf(cached, resolved, true);

  const bytes = await fsp.readFile(resolved.generationPath);
  const reader = openContextIndex(bytes, {
    expectedSnapshotHash: pointer.snapshotHash,
    expectedConfigHash: pointer.configFingerprint,
  });
  if (cache !== null) cache.setReader(root, pointer.snapshotHash, reader);
  return handleOf(reader, resolved, false);
}

function handleOf(
  reader: ContextIndexReader,
  resolved: Awaited<ReturnType<typeof resolveCurrentContextIndex>>,
  cacheHit: boolean,
): WorkspaceContextIndexHandle {
  return Object.freeze({
    reader,
    snapshotHash: resolved.pointer.snapshotHash,
    configFingerprint: resolved.pointer.configFingerprint,
    sourceFingerprint: resolved.pointer.sourceFingerprint,
    committedAt: resolved.pointer.committedAt,
    nodeCount: resolved.meta.nodeCount,
    edgeCount: resolved.meta.edgeCount,
    fresh: true,
    cacheHit,
  });
}

export interface WorkspaceContextFailure {
  /** One of the frozen ADR §5 codes. Never a message, never a path. */
  readonly code: string;
  readonly repairCommand: string;
}

/** Store codes that mean "there is no index here", as opposed to "it is damaged". */
const MISSING_STORE_CODES: ReadonlySet<ContextIndexStoreErrorCode> = new Set([
  'pointer_missing',
  'generation_missing',
  'generation_meta_missing',
]);

/**
 * Normalize any index failure into its public code and repair command.
 *
 * Store errors, reader errors and format errors are three classes to this
 * module and one event to a user: the index is unusable, run this. Returns
 * `null` for anything that is not an index failure, so an unrelated bug is never
 * reported as a corrupt index — a wrong repair instruction is worse than none.
 */
export function workspaceContextFailureOf(error: unknown): WorkspaceContextFailure | null {
  if (error instanceof ContextIndexStoreError) {
    return { code: error.publicCode, repairCommand: error.repairCommand };
  }
  const failure = contextIndexFailureOf(error);
  if (failure !== null) return { code: failure.code, repairCommand: failure.repairCommand };
  if (isMissingFileError(error)) {
    // The pointer named a generation that vanished between `stat` and `read`.
    // Reporting it as missing rather than letting an ENOENT escape keeps the
    // failure inside the closed set consumers branch on.
    return { code: 'context_index_missing', repairCommand: 'sks align run' };
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** True when the failure is "no index has been built here yet". */
export function isMissingWorkspaceContextIndex(error: unknown): boolean {
  return (
    error instanceof ContextIndexStoreError && MISSING_STORE_CODES.has(error.code)
  );
}

export interface WorkspaceContextQueryOptions extends OpenWorkspaceContextIndexOptions {
  readonly clock?: KernelClock;
  readonly config?: ContextGraphRankingConfig;
  readonly safetyClosure?: boolean;
  /**
   * Reuse a response already computed against this generation. Defaults to true
   * when a cache is in play. The key is the caller's, because only the caller
   * knows which request fields it varied.
   */
  readonly responseKey?: string | undefined;
  readonly index?: WorkspaceContextIndexHandle | undefined;
}

export interface WorkspaceContextAnswer {
  readonly schema: typeof CONTEXT_WORKSPACE_QUERY_SCHEMA;
  readonly snapshotHash: string;
  readonly committedAt: string;
  readonly indexFresh: boolean;
  /** True when the whole response came back from the generation's response cache. */
  readonly responseCacheHit: boolean;
  /** True when the reader was resident; independent of `responseCacheHit`. */
  readonly indexCacheHit: boolean;
  readonly kernel: ContextKernelResult;
  readonly hydration: HydrationResult;
}

/**
 * Answer a request for a workspace: open, run, hydrate.
 *
 * Hydration runs here rather than at each call site because `indexFresh` is an
 * input to it and only this function knows it. A consumer hydrating on its own
 * would have to re-derive freshness, and §7 makes `hydrated` a claim about the
 * index the query ran under — not about whatever the consumer believed later.
 */
export async function queryWorkspaceContext(
  root: string,
  request: KernelRequest,
  options: WorkspaceContextQueryOptions = {},
): Promise<WorkspaceContextAnswer> {
  const handle = options.index ?? (await openWorkspaceContextIndex(root, options));
  const cache = options.cache === undefined ? sharedContextIndexCache() : options.cache;
  const responseKey = options.responseKey;

  if (cache !== null && responseKey !== undefined) {
    const cached = cache.getResponse<WorkspaceContextAnswer>(root, handle.snapshotHash, responseKey);
    if (cached !== null) return { ...cached, responseCacheHit: true };
  }

  const kernelOptions: ContextKernelOptions = {
    clock: options.clock ?? Date.now,
    config: options.config ?? CONTEXT_GRAPH_RANKING_CONFIG,
    ...(options.safetyClosure === undefined ? {} : { safetyClosure: options.safetyClosure }),
  };
  const kernel = runContextKernel(handle.reader, request, kernelOptions);
  const hydration = hydrateSelectedCandidates(handle.reader, kernel.selected, {
    indexFresh: handle.fresh,
    config: options.config ?? CONTEXT_GRAPH_RANKING_CONFIG,
  });

  const answer: WorkspaceContextAnswer = Object.freeze({
    schema: CONTEXT_WORKSPACE_QUERY_SCHEMA,
    snapshotHash: handle.snapshotHash,
    committedAt: handle.committedAt,
    indexFresh: handle.fresh,
    responseCacheHit: false,
    indexCacheHit: handle.cacheHit,
    kernel,
    hydration,
  });

  if (cache !== null && responseKey !== undefined) {
    // Budgeted on the hydrated node count rather than on a serialization: the
    // cache charges resident bytes, and `JSON.stringify` on every answer would
    // cost more than the residency it is trying to measure.
    cache.setResponse(root, handle.snapshotHash, responseKey, answer, responseBytesOf(answer));
  }
  return answer;
}

/**
 * Rough resident cost of an answer. Deliberately an estimate: the exact number
 * would require walking every string, and the cache needs a budget input, not an
 * audit. The constant is per hydrated node and errs high.
 */
const RESPONSE_BYTES_PER_NODE = 512;

function responseBytesOf(answer: WorkspaceContextAnswer): number {
  return RESPONSE_BYTES_PER_NODE * (answer.hydration.nodes.length + 1);
}

/**
 * Drop everything resident for one workspace.
 *
 * The align path renames a staged directory over the live one, and a reader held
 * across that swap describes a generation that no longer exists. Clearing is the
 * caller's obligation at that moment, so the facade owns the call rather than
 * making align reach into the cache module.
 */
export function clearWorkspaceContextIndex(root: string, cache?: ContextIndexCache | null): void {
  const target = cache === undefined ? sharedContextIndexCache() : cache;
  if (target === null) return;
  // The cache has no per-workspace drop in its public surface, and adding one is
  // CG2-11's file to change. Clearing everything is correct but blunt: it is
  // called once per align, not per query, so the re-read cost is bounded.
  void root;
  target.clear();
}
