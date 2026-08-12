/**
 * Freshness for the compact index, established **without reading the JSON
 * snapshot**.
 *
 * `contextGraphStatus()` answers the same question by parsing
 * `context-graph.json` as its first act — 58 MB on the measured baseline, on a
 * path whose whole purpose is to avoid parsing it. That parse was not
 * gratuitous: it is where git-derived staleness comes from, and an index whose
 * sources changed underneath it must not be allowed to answer. Removing the
 * check in favour of pointer/meta integrity alone would produce a workspace
 * that answers from a stale index with **no error at all**, which is a worse
 * outcome than the byte cost — ADR §1 forbids exactly that silent downgrade.
 *
 * So nothing here is relaxed. The snapshot is replaced as an *input*, not as a
 * check:
 *
 * | JSON path reads from the snapshot | this module reads instead |
 * | --- | --- |
 * | the file exists / parses | the index pointer's presence, and the meta |
 * | `snapshotHash`, `nodeCount`, `edgeCount` | the same three fields on the meta |
 * | `schemaRevision` | `meta.schemaRevision`, written from the same constant |
 * | `extractors`, as a fallback identity list | the caller's, or none — see below |
 *
 * Everything after that — `computeContextGraphCacheKey`,
 * `compareCacheKeyParts`, the HEAD-freshness rescue and the recorded-input
 * re-hash — never touched the snapshot in the first place and is reproduced
 * here unchanged, so the two paths agree by construction rather than by
 * intention. `index-freshness.test.ts` runs both against the same workspaces
 * and asserts the verdicts match, because "same verdicts" is a property to
 * check, not a comment to write.
 *
 * ## Failing closed
 *
 * Every branch that cannot establish freshness produces a status with an error
 * code and `CONTEXT_GRAPH_REPAIR_COMMAND`. There is no branch that returns
 * `fresh` because a check could not be run, and no fallback to the previous
 * generation — the ADR forbids one, and a fallback is what makes a correctness
 * floor unprovable.
 *
 * An unexpected IO failure is deliberately **allowed to propagate** rather than
 * being caught and folded into a verdict. A `catch` around this derivation is
 * precisely how a workspace starts reporting `fresh` because a read failed, and
 * no verdict at all is safer than a confident one nobody computed.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  CONTEXT_GRAPH_STALE_ERROR,
  CONTEXT_GRAPH_STALE_REASONS,
  type ContextGraphMeta,
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
import { inspectCodePackHeadFreshness } from '../../code-pack-head-freshness.js';
import { inspectCodeNavigationSources } from '../../code-navigation-policy.js';
import { readContextGraphMeta } from './snapshot-store.js';
import { readContextIndexPointerLenient } from './generation-pointer.js';

const STATUS_SCHEMA = 'sks.context-graph-status.v1' as const;
const METADATA_ONLY_HEAD_CHECK_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_VERIFIED_SOURCES = 4000;

export interface ContextIndexFreshnessOptions {
  /** Extractor identities in play. Without them the schema-revision comparison is skipped rather than guessed. */
  extractors?: readonly ExtractorIdentity[] | undefined;
  /** Pre-computed cache key, to avoid recomputing it in a caller that already has one. */
  cacheKey?: ContextGraphCacheKeyResult | null | undefined;
  /** Re-hash the recorded inputs on disk. Defaults to true. */
  verifySources?: boolean | undefined;
  /** Cap on how many recorded inputs are re-hashed; the rest are trusted from the cache key. */
  maxVerifiedSources?: number | undefined;
}

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
 * Whether a graph exists at all, and which of `missing` / `corrupt` it is.
 *
 * The JSON path answers both from the snapshot: absent is `missing`,
 * present-without-meta is `corrupt`. The v2 analogue of "a graph exists" is the
 * index pointer, which is small and already parsed defensively, so the same
 * distinction survives without the snapshot. Collapsing both to `missing` would
 * tell a user to build a graph that is already there, and collapsing both to
 * `corrupt` would tell a user to rebuild one that was never built.
 *
 * This is the *only* evidence either path has that the artifact a verdict is
 * about is on disk. The freshness record cannot supply it: a meta describes a
 * generation, and describing one is not publishing one.
 */
interface ArtifactPresence {
  readonly published: boolean;
  readonly damaged: boolean;
  readonly snapshotHash: string | null;
}

/** Read once: two reads could straddle a compile and disagree with each other. */
async function indexPresence(root: string): Promise<ArtifactPresence> {
  const lenient = await readContextIndexPointerLenient(root);
  return {
    published: lenient.present,
    // Present but unparseable: something published a generation and its pointer
    // no longer describes it. That is damage, not absence.
    damaged: lenient.present && lenient.pointer === null,
    snapshotHash: lenient.pointer?.snapshotHash ?? null
  };
}

/**
 * Freshness verdict for the stored graph, derived from the index meta.
 *
 * Returns the same `ContextGraphStatus` shape `contextGraphStatus()` returns,
 * so a caller adopts it by changing which function it calls and nothing else.
 */
export async function contextIndexFreshness(
  root: string,
  options: ContextIndexFreshnessOptions = {}
): Promise<ContextGraphStatus> {
  const metaLoad = await readContextGraphMeta(root);
  const presence = await indexPresence(root);

  // Ordering, taken from `graph-status.ts`: missing beats corrupt beats stale.
  // The JSON path answers `missing` from the snapshot's absence alone, before it
  // has looked at the meta at all, and the pointer is this path's "a graph
  // exists". So an unpublished index is `missing` whatever the meta says.
  //
  // A meta on its own is a *description* of an index, not one: the freshness
  // record can be perfectly current, its cache key can match the working tree to
  // the byte, and there are still no bytes for a caller to read. Reporting that
  // as `fresh` is the silent downgrade ADR §1 forbids, and it is not a corner —
  // every workspace upgrading from a build that predates the generation store
  // starts with exactly this pair of artifacts.
  if (!presence.published) return statusOf('missing', [], null, null, 0, 0);

  if (metaLoad.status === 'missing') {
    // A generation is published and nothing records what it contains: built and
    // then damaged, which is a rebuild rather than a first build.
    return statusOf('corrupt', ['meta_mismatch'], null, null, 0, 0);
  }
  if (metaLoad.status !== 'ok' || !metaLoad.meta) {
    return statusOf('corrupt', ['meta_mismatch'], null, null, 0, 0);
  }
  const meta = metaLoad.meta;

  if (presence.damaged) {
    return statusOf('corrupt', ['meta_mismatch'], meta.snapshotHash, meta.generatedAt ?? null, meta.nodeCount, meta.edgeCount);
  }
  // ADR §6: pointer and meta must agree, and a disagreement is an error rather
  // than a tie to break. Preferring either side would attest a snapshot hash
  // that nothing verified.
  const pointed = presence.snapshotHash;
  if (pointed !== null && pointed !== meta.snapshotHash) {
    return statusOf('corrupt', ['meta_mismatch'], meta.snapshotHash, meta.generatedAt ?? null, meta.nodeCount, meta.edgeCount);
  }

  const reasons = await staleReasonsFor(root, meta, options);
  const deduped = orderReasons(reasons);
  return statusOf(
    deduped.length === 0 ? 'fresh' : 'stale',
    deduped,
    meta.snapshotHash,
    meta.generatedAt ?? null,
    meta.nodeCount,
    meta.edgeCount
  );
}

/**
 * The git-derived half. Reproduced from `graph-status.ts` step for step,
 * because "the same verdicts" is the requirement — the only substitution is
 * `meta.schemaRevision` for `snapshot.schemaRevision`, which the compiler
 * writes from the same `CONTEXT_GRAPH_SCHEMA_REVISION` constant.
 */
async function staleReasonsFor(
  root: string,
  meta: ContextGraphMeta,
  options: ContextIndexFreshnessOptions
): Promise<ContextGraphStaleReason[]> {
  const reasons: ContextGraphStaleReason[] = [];
  if (meta.schemaRevision !== CONTEXT_GRAPH_SCHEMA_REVISION) reasons.push('schema_revision_changed');

  const codeOnly = meta.cacheKeyParts?.sourcePolicy === 'repository_code_only';
  // A caller-supplied/neutral key cannot prove a code-only inventory. Always
  // rescan the accepted current source bytes for this policy so additions,
  // deletions, and edits cannot be hidden behind artifact-only freshness.
  //
  // The JSON path falls back to `snapshot.extractors` here. There is no
  // snapshot to fall back to, and an empty list is *not* a guess: it changes
  // only the recomputed `schemaRevision`, and the reason that would produce is
  // dropped below for exactly the case where the caller supplied nothing.
  const sourceInspection = codeOnly
    ? await inspectCodeNavigationSources(root, options.extractors ?? [])
    : null;
  if (sourceInspection?.fatalSkips.length) reasons.push('source_inventory_incomplete');

  const current = sourceInspection?.cacheKey
    ?? options.cacheKey
    ?? (await computeContextGraphCacheKey({ root, extractors: options.extractors ?? [] }));
  if (!current.reusable && !codeOnly) reasons.push('git_state_unknown');

  const cacheReasons = compareCacheKeyParts(meta.cacheKeyParts, current.parts);
  if (!codeOnly && cacheReasons.includes('head_changed') && meta.cacheKeyParts?.head) {
    const headFreshness = await inspectCodePackHeadFreshness(root, meta.cacheKeyParts.head, {
      timeoutMs: METADATA_ONLY_HEAD_CHECK_TIMEOUT_MS
    });
    if (headFreshness.fresh) {
      cacheReasons.splice(cacheReasons.indexOf('head_changed'), 1);
    }
  }
  for (const reason of cacheReasons) {
    // Without a caller-supplied extractor list the recomputed schema revision is
    // not comparable, so that single reason is dropped instead of faked.
    if (reason === 'schema_revision_changed' && !options.extractors && !options.cacheKey) continue;
    reasons.push(reason);
  }

  if (options.verifySources !== false && !codeOnly) {
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

  return reasons;
}
