/**
 * Freshness verdict for the stored Context Graph.
 *
 * This is what `search context` and the freshness preflight call before they are
 * allowed to answer from the graph. Every non-fresh outcome carries an explicit
 * error code and a deterministic reason list, so a caller can refuse or repair —
 * silently degrading to text search is exactly the failure mode this prevents.
 */
import {
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  CONTEXT_GRAPH_STALE_ERROR,
  CONTEXT_GRAPH_STALE_REASONS,
  type ContextGraphStaleReason,
  type ContextGraphStatus
} from '../contracts.js';
import {
  compareCacheKeyParts,
  computeContextGraphCacheKey,
  type ContextGraphCacheKeyResult,
  type ExtractorIdentity
} from '../compiler/cache-key.js';
import { readSourceHashes } from '../compiler/freshness.js';
import { readContextGraphMeta, readContextGraphSnapshot } from './snapshot-store.js';

const STATUS_SCHEMA = 'sks.context-graph-status.v1' as const;

export interface ContextGraphStatusOptions {
  /** Extractor identities in play. Without them the schema-revision comparison is skipped rather than guessed. */
  extractors?: readonly ExtractorIdentity[] | undefined;
  /** Pre-computed cache key, to avoid recomputing it in a caller that already has one. */
  cacheKey?: ContextGraphCacheKeyResult | null | undefined;
  /** Re-hash the recorded inputs on disk. Defaults to true. */
  verifySources?: boolean | undefined;
  /** Cap on how many recorded inputs are re-hashed; the rest are trusted from the cache key. */
  maxVerifiedSources?: number | undefined;
}

const DEFAULT_MAX_VERIFIED_SOURCES = 4000;

function orderReasons(reasons: readonly ContextGraphStaleReason[]): ContextGraphStaleReason[] {
  const present = new Set(reasons);
  return CONTEXT_GRAPH_STALE_REASONS.filter((reason) => present.has(reason));
}

function statusOf(
  status: ContextGraphStatus['status'],
  reasons: ContextGraphStaleReason[],
  snapshotHash: string | null,
  generatedAt: string | null,
  nodeCount: number,
  edgeCount: number
): ContextGraphStatus {
  const errorCode =
    status === 'missing'
      ? CONTEXT_GRAPH_MISSING_ERROR
      : status === 'corrupt'
        ? CONTEXT_GRAPH_CORRUPT_ERROR
        : status === 'stale'
          ? CONTEXT_GRAPH_STALE_ERROR
          : null;
  return {
    schema: STATUS_SCHEMA,
    status,
    snapshotHash,
    generatedAt,
    reasons: orderReasons(reasons),
    repairCommand: CONTEXT_GRAPH_REPAIR_COMMAND,
    errorCode,
    nodeCount,
    edgeCount
  };
}

/**
 * Resolve the stored graph's status. Ordering matters: missing beats corrupt
 * beats stale, and a snapshot/meta disagreement is corrupt (not stale) because
 * the two artifacts no longer describe the same graph.
 */
export async function contextGraphStatus(
  root: string,
  options: ContextGraphStatusOptions = {}
): Promise<ContextGraphStatus> {
  const snapshotLoad = await readContextGraphSnapshot(root);
  if (snapshotLoad.status === 'missing') return statusOf('missing', [], null, null, 0, 0);
  if (snapshotLoad.status === 'corrupt' || !snapshotLoad.snapshot) {
    return statusOf('corrupt', [], null, null, 0, 0);
  }
  const snapshot = snapshotLoad.snapshot;

  const metaLoad = await readContextGraphMeta(root);
  if (metaLoad.status !== 'ok' || !metaLoad.meta) {
    return statusOf('corrupt', ['meta_mismatch'], snapshot.snapshotHash, null, snapshot.nodeCount, snapshot.edgeCount);
  }
  const meta = metaLoad.meta;
  if (
    meta.snapshotHash !== snapshot.snapshotHash
    || meta.nodeCount !== snapshot.nodeCount
    || meta.edgeCount !== snapshot.edgeCount
  ) {
    return statusOf(
      'corrupt',
      ['meta_mismatch'],
      snapshot.snapshotHash,
      meta.generatedAt ?? null,
      snapshot.nodeCount,
      snapshot.edgeCount
    );
  }

  const reasons: ContextGraphStaleReason[] = [];
  if (snapshot.schemaRevision !== CONTEXT_GRAPH_SCHEMA_REVISION) reasons.push('schema_revision_changed');

  const current =
    options.cacheKey
    ?? (await computeContextGraphCacheKey({ root, extractors: options.extractors ?? [] }));
  if (!current.reusable) reasons.push('git_state_unknown');
  for (const reason of compareCacheKeyParts(meta.cacheKeyParts, current.parts)) {
    // Without a caller-supplied extractor list the recomputed schema revision is
    // not comparable, so that single reason is dropped instead of faked.
    if (reason === 'schema_revision_changed' && !options.extractors && !options.cacheKey) continue;
    reasons.push(reason);
  }

  if (options.verifySources !== false) {
    const recorded = Object.keys(meta.inputHashes ?? {}).sort();
    const limit = Math.max(0, options.maxVerifiedSources ?? DEFAULT_MAX_VERIFIED_SOURCES);
    const observed = await readSourceHashes(root, recorded.slice(0, limit));
    for (const file of recorded.slice(0, limit)) {
      if (observed[file] !== meta.inputHashes[file]) {
        reasons.push('source_hash_mismatch');
        break;
      }
    }
  }

  const deduped = orderReasons(reasons);
  return statusOf(
    deduped.length === 0 ? 'fresh' : 'stale',
    deduped,
    snapshot.snapshotHash,
    meta.generatedAt ?? null,
    snapshot.nodeCount,
    snapshot.edgeCount
  );
}
