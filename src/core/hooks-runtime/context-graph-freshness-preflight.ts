/**
 * Runtime preflight for the compiled Context Graph.
 *
 * Answers one question — "is the stored graph usable right now?" — without
 * rebuilding anything, without touching a source file, and without spawning a
 * process on the normal path. The verdict itself is not re-derived here: it is
 * `contextIndexFreshness()`, delegated to and reported verbatim — the v2
 * preflight, so the 58 MB JSON snapshot is never parsed to answer this.
 *
 * Spawn discipline. `contextIndexFreshness()` computes a cache key when the
 * caller does not supply one, and that shells out to git. So one is always given:
 *
 *  - Caller-supplied (`cacheKey`): git-derived staleness is evaluated in full.
 *  - Otherwise: a neutral key built from the stored meta's own parts, so the
 *    cache-key comparison contributes nothing. The reasons that comparison would
 *    have produced are listed in `unverified_reasons` — the preflight never
 *    claims to have checked something it did not.
 *
 * A non-fresh graph is reported with its error code and
 * `CONTEXT_GRAPH_REPAIR_COMMAND`. Nothing here substitutes a text search or an
 * older generation for the answer.
 */
import {
  CONTEXT_GRAPH_REPAIR_COMMAND,
  type ContextGraphCacheKeyParts,
  type ContextGraphStaleReason,
  type ContextGraphStatus,
  type ContextGraphStatusCode
} from '../triwiki/context-graph/contracts.js';
import {
  contextGraphCacheKey,
  type ContextGraphCacheKeyResult,
  type ExtractorIdentity
} from '../triwiki/context-graph/compiler/cache-key.js';
import { contextIndexFreshness } from '../triwiki/context-graph/store/index-freshness.js';
import { readContextGraphMeta } from '../triwiki/context-graph/store/snapshot-store.js';
import { alignGraphExtractors } from '../triwiki/context-graph/extractors/index.js';

export const CONTEXT_GRAPH_FRESHNESS_PREFLIGHT_SCHEMA = 'sks.context-graph-freshness-preflight.v1';

/** Stale reasons that only a git-derived cache-key comparison can produce. */
const CACHE_KEY_DERIVED_REASONS: readonly ContextGraphStaleReason[] = [
  'head_changed',
  'dirty_fingerprint_changed',
  'schema_revision_changed',
  'tsconfig_changed',
  'command_manifest_changed',
  'gate_manifest_changed',
  'proof_index_changed',
  'wiki_context_changed',
  'git_state_unknown',
  'cache_key_changed'
];

const PLACEHOLDER_CACHE_KEY_PARTS: ContextGraphCacheKeyParts = {
  workspaceIdentity: 'unevaluated',
  head: null,
  gitState: 'unknown',
  trackedDirtyFingerprint: 'unevaluated',
  untrackedFingerprint: 'unevaluated',
  schemaRevision: 'unevaluated',
  tsconfigHash: 'unevaluated',
  commandManifestHash: 'unevaluated',
  gateManifestHash: 'unevaluated',
  proofIndexHash: 'unevaluated',
  wikiContextHash: 'unevaluated'
};

export type ContextGraphPreflightCoverage = 'artifacts_and_sources' | 'artifacts_only' | 'full';

export interface ContextGraphFreshnessPreflightOptions {
  /**
   * A cache key the caller already paid for. Supplying it is the only way the
   * preflight evaluates git-derived staleness; it never computes one itself,
   * because computing one spawns `git`.
   */
  cacheKey?: ContextGraphCacheKeyResult | null | undefined;
  /** Extractor identities; defaults to the live registry so schema comparisons stay comparable. */
  extractors?: readonly ExtractorIdentity[] | undefined;
  /** Re-hash the recorded inputs (filesystem only, no spawn). Defaults to true. */
  verifySources?: boolean | undefined;
  /** Cap on how many recorded inputs are re-hashed. Exceeding it marks sources unverified. */
  maxVerifiedSources?: number | undefined;
}

export interface ContextGraphFreshnessPreflight {
  schema: typeof CONTEXT_GRAPH_FRESHNESS_PREFLIGHT_SCHEMA;
  /** `true` only for a fully fresh graph; a caller must refuse to answer otherwise. */
  usable: boolean;
  status: ContextGraphStatusCode;
  reasons: ContextGraphStaleReason[];
  /** Reasons this run could not evaluate, so "fresh" is never read as more than it is. */
  unverified_reasons: ContextGraphStaleReason[];
  coverage: ContextGraphPreflightCoverage;
  snapshot_hash: string | null;
  generated_at: string | null;
  node_count: number;
  edge_count: number;
  error_code: ContextGraphStatus['errorCode'];
  repair_command: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
}

/**
 * Deterministic freshness verdict for the stored graph. Read-only: it opens the
 * index meta and (optionally) the recorded inputs, and writes nothing.
 */
export async function contextGraphFreshnessPreflight(
  root: string,
  options: ContextGraphFreshnessPreflightOptions = {}
): Promise<ContextGraphFreshnessPreflight> {
  const verifySources = options.verifySources !== false;
  const extractors = options.extractors ?? alignGraphExtractors();
  const supplied = options.cacheKey ?? null;
  const metaLoad = await readContextGraphMeta(root);
  const meta = metaLoad.status === 'ok' ? metaLoad.meta : null;
  const cacheKey = supplied ?? neutralCacheKey(meta?.cacheKeyParts ?? PLACEHOLDER_CACHE_KEY_PARTS);

  const recordedSources = meta ? Object.keys(meta.inputHashes ?? {}).length : 0;
  const status = await contextIndexFreshness(root, {
    extractors,
    cacheKey,
    verifySources,
    ...(options.maxVerifiedSources === undefined ? {} : { maxVerifiedSources: options.maxVerifiedSources })
  });

  const sourcesVerified =
    verifySources
    && (options.maxVerifiedSources === undefined || options.maxVerifiedSources >= recordedSources);
  const unverified = collectUnverifiedReasons(status.reasons, Boolean(supplied), sourcesVerified);
  return {
    schema: CONTEXT_GRAPH_FRESHNESS_PREFLIGHT_SCHEMA,
    usable: status.status === 'fresh',
    status: status.status,
    reasons: status.reasons,
    unverified_reasons: unverified,
    coverage: supplied ? 'full' : sourcesVerified ? 'artifacts_and_sources' : 'artifacts_only',
    snapshot_hash: status.snapshotHash,
    generated_at: status.generatedAt,
    node_count: status.nodeCount,
    edge_count: status.edgeCount,
    error_code: status.errorCode,
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND
  };
}

/**
 * Bounded, non-blocking note for a prompt hook. Returns `null` when the graph is
 * fresh, when there is no graph to talk about yet, or when the budget runs out —
 * the structured preflight above is what a caller uses to decide whether it may
 * answer from the graph.
 */
export async function contextGraphFreshnessNote(
  root: string,
  options: ContextGraphFreshnessPreflightOptions & { budgetMs?: number | undefined } = {}
): Promise<string | null> {
  const budgetMs = Math.max(1, options.budgetMs ?? 750);
  const preflight = await raceWithTimeout(contextGraphFreshnessPreflight(root, options), budgetMs).catch(() => null);
  if (!preflight) return null;
  return contextGraphFreshnessNoteFor(preflight);
}

/** The user-facing line for a preflight result. Codes and the repair command only — no prose about versions. */
export function contextGraphFreshnessNoteFor(preflight: ContextGraphFreshnessPreflight): string | null {
  if (preflight.status === 'fresh') return null;
  if (preflight.status === 'missing') {
    return `SKS note: the codebase context graph has not been built (${preflight.error_code}). Run \`${preflight.repair_command}\` before relying on graph-cited context.`;
  }
  if (preflight.status === 'corrupt') {
    return `SKS note: the codebase context graph is unusable (${preflight.error_code}). Run \`${preflight.repair_command}\` to rebuild it; no older generation is substituted.`;
  }
  const reasons = preflight.reasons.join(', ');
  return `SKS note: the codebase context graph is stale (${preflight.error_code}: ${reasons}). Run \`${preflight.repair_command}\` to refresh graph-cited context.`;
}

function neutralCacheKey(parts: ContextGraphCacheKeyParts): ContextGraphCacheKeyResult {
  return { key: contextGraphCacheKey(parts), parts, reusable: true, reasons: [], dirtyPaths: [] };
}

/**
 * Reasons that were out of scope for this run, in the contract's declared order,
 * excluding any that fired anyway (a reason that fired was evaluated).
 */
function collectUnverifiedReasons(
  fired: readonly ContextGraphStaleReason[],
  cacheKeySupplied: boolean,
  sourcesVerified: boolean
): ContextGraphStaleReason[] {
  const firedSet = new Set(fired);
  const out: ContextGraphStaleReason[] = [];
  if (!cacheKeySupplied) {
    for (const reason of CACHE_KEY_DERIVED_REASONS) {
      if (!firedSet.has(reason)) out.push(reason);
    }
  }
  if (!sourcesVerified && !firedSet.has('source_hash_mismatch')) out.push('source_hash_mismatch');
  return out;
}

async function raceWithTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (timer.unref) timer.unref();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
