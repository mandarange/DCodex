/**
 * Snapshot resolution for the query engine.
 *
 * Two rules shape this file.
 *
 * First, it spawns nothing. `contextGraphStatus()` is the full freshness verdict,
 * but computing a cache key means asking git for HEAD and the dirty fingerprint,
 * and a query hot path is not allowed to spawn a process. So the caller's
 * preflight verdict is accepted through `status`, and everything this file does
 * on its own — reading meta, reading the snapshot, optionally re-hashing recorded
 * inputs — is pure file I/O.
 *
 * Second, it never substitutes. A missing, corrupt or stale artifact produces an
 * explicit error code plus the repair command; it never silently degrades to the
 * previous generation, and it never hands the caller a text-search fallback.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphStatus
} from '../contracts.js';
import { readSourceHashes } from '../compiler/freshness.js';
import { buildContextGraphIndex, type ContextGraphIndex } from '../graph-index.js';
import { readContextGraphMeta, readContextGraphSnapshot } from '../store/snapshot-store.js';
import { cacheContextGraphIndex, getCachedContextGraphIndex } from './snapshot-cache.js';

/**
 * The freshness verdict this engine consumes. A full `ContextGraphStatus`
 * satisfies it, and so does a two-field object built from a preflight projection,
 * so a caller never has to synthesize fields it does not have.
 */
export type ContextGraphFreshnessVerdict = Pick<ContextGraphStatus, 'status'>
  & Partial<Pick<ContextGraphStatus, 'reasons' | 'snapshotHash'>>;

export type ContextGraphLoadErrorCode =
  | typeof CONTEXT_GRAPH_MISSING_ERROR
  | typeof CONTEXT_GRAPH_STALE_ERROR
  | typeof CONTEXT_GRAPH_CORRUPT_ERROR;

export interface ContextGraphIndexLoad {
  readonly ok: boolean;
  readonly index: ContextGraphIndex | null;
  readonly snapshotHash: string;
  readonly errorCode: ContextGraphLoadErrorCode | null;
  readonly errors: string[];
  readonly warnings: string[];
  readonly cacheHit: boolean;
  readonly freshness: 'fresh' | 'stale';
}

export interface LoadContextGraphIndexOptions {
  /** Freshness verdict from the caller's preflight. Supplying it is what keeps the path spawn-free *and* complete. */
  readonly status?: ContextGraphFreshnessVerdict | undefined;
  /** Answer over a stale graph on purpose. The result still reports `stale` and still names the repair command. */
  readonly allowStale?: boolean | undefined;
  /** Use the in-process snapshot cache. Defaults to true. */
  readonly cache?: boolean | undefined;
  /** Re-hash the inputs recorded in meta. Spawn-free, but O(recorded files) of file I/O. Defaults to false. */
  readonly verifySources?: boolean | undefined;
  readonly maxVerifiedSources?: number | undefined;
}

const DEFAULT_MAX_VERIFIED_SOURCES = 4000;

export function contextGraphRepairHint(): string {
  return `Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild the context graph.`;
}

function failure(code: ContextGraphLoadErrorCode, detail: string, snapshotHash = ''): ContextGraphIndexLoad {
  return {
    ok: false,
    index: null,
    snapshotHash,
    errorCode: code,
    errors: [code, detail, contextGraphRepairHint()],
    warnings: [],
    cacheHit: false,
    freshness: 'stale'
  };
}

function statusFailure(status: ContextGraphFreshnessVerdict): ContextGraphIndexLoad | null {
  if (status.status === 'fresh') return null;
  const code =
    status.status === 'missing'
      ? CONTEXT_GRAPH_MISSING_ERROR
      : status.status === 'corrupt'
        ? CONTEXT_GRAPH_CORRUPT_ERROR
        : CONTEXT_GRAPH_STALE_ERROR;
  const declared = status.reasons ?? [];
  const reasons = declared.length > 0 ? ` (${declared.join(', ')})` : '';
  return failure(code, `the stored context graph is ${status.status}${reasons}`, status.snapshotHash ?? '');
}

async function sourcesChanged(root: string, inputHashes: Record<string, string>, limit: number): Promise<boolean> {
  const recorded = Object.keys(inputHashes).sort().slice(0, Math.max(0, limit));
  if (recorded.length === 0) return false;
  const observed = await readSourceHashes(root, recorded);
  for (const file of recorded) {
    if (observed[file] !== inputHashes[file]) return true;
  }
  return false;
}

/**
 * Resolve a ready-to-query index for `root`, or an explicit failure. On a cache
 * hit the snapshot is never re-read: only the small meta file is touched, which
 * is what makes a repeated query in one process cheap.
 */
export async function loadContextGraphIndex(
  root: string,
  options: LoadContextGraphIndexOptions = {}
): Promise<ContextGraphIndexLoad> {
  const supplied = options.status;
  if (supplied) {
    const blocked = statusFailure(supplied);
    if (blocked && !(supplied.status === 'stale' && options.allowStale === true)) return blocked;
  }

  const metaLoad = await readContextGraphMeta(root);
  if (metaLoad.status === 'missing') return failure(CONTEXT_GRAPH_MISSING_ERROR, 'the context graph has not been built');
  if (metaLoad.status !== 'ok' || !metaLoad.meta) {
    return failure(CONTEXT_GRAPH_CORRUPT_ERROR, 'the context graph metadata is unreadable');
  }
  const meta = metaLoad.meta;
  const warnings: string[] = [];

  if (options.verifySources === true) {
    const changed = await sourcesChanged(
      root,
      meta.inputHashes ?? {},
      options.maxVerifiedSources ?? DEFAULT_MAX_VERIFIED_SOURCES
    );
    if (changed && options.allowStale !== true) {
      return failure(CONTEXT_GRAPH_STALE_ERROR, 'a recorded source no longer hashes to its stored value', meta.snapshotHash);
    }
    if (changed) warnings.push('answering over a stale context graph on request');
  } else if (!supplied) {
    // Full staleness needs the git-derived cache key, which this path is not
    // allowed to compute. Say so instead of implying a verified `fresh`.
    warnings.push(
      `context graph freshness was not verified by this query; ${contextGraphRepairHint()}`
    );
  }

  const useCache = options.cache !== false;
  if (useCache) {
    const cached = getCachedContextGraphIndex(root, meta.snapshotHash);
    if (cached) {
      return {
        ok: true,
        index: cached,
        snapshotHash: meta.snapshotHash,
        errorCode: null,
        errors: [],
        warnings,
        cacheHit: true,
        freshness: supplied?.status === 'stale' ? 'stale' : 'fresh'
      };
    }
  }

  const snapshotLoad = await readContextGraphSnapshot(root);
  if (snapshotLoad.status === 'missing') {
    return failure(CONTEXT_GRAPH_MISSING_ERROR, 'the context graph snapshot is absent while its metadata is present');
  }
  if (snapshotLoad.status !== 'ok' || !snapshotLoad.snapshot) {
    return failure(CONTEXT_GRAPH_CORRUPT_ERROR, 'the context graph snapshot failed structural validation');
  }
  const snapshot = snapshotLoad.snapshot;
  if (
    snapshot.snapshotHash !== meta.snapshotHash
    || snapshot.nodeCount !== meta.nodeCount
    || snapshot.edgeCount !== meta.edgeCount
  ) {
    return failure(CONTEXT_GRAPH_CORRUPT_ERROR, 'the snapshot and its metadata describe different graphs', snapshot.snapshotHash);
  }
  if (snapshot.schemaRevision !== CONTEXT_GRAPH_SCHEMA_REVISION) {
    return failure(CONTEXT_GRAPH_STALE_ERROR, 'the snapshot was written by a different graph schema revision', snapshot.snapshotHash);
  }

  const index = buildContextGraphIndex(snapshot);
  if (useCache) cacheContextGraphIndex(root, snapshot.snapshotHash, index);
  return {
    ok: true,
    index,
    snapshotHash: snapshot.snapshotHash,
    errorCode: null,
    errors: [],
    warnings,
    cacheHit: false,
    freshness: supplied?.status === 'stale' ? 'stale' : 'fresh'
  };
}
