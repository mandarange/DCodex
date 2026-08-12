/**
 * AI context mode, answered from the compact Context Retrieval Kernel (CRK2).
 *
 * Four rules shape it. Freshness is established before anything is answered. A
 * missing, stale or corrupt index returns `ok: false` with the matching
 * `context_graph_*` code, the reasons and the repair command, and **zero
 * matches** — there is no branch here that degrades to text search, and none
 * that falls back to the retired JSON snapshot. Everything reported back is a
 * graph node the kernel reached, carrying its own confidence, reason path,
 * provenance, trust, freshness and token cost.
 *
 * ## What this file stopped doing
 *
 * It used to acquire its own seeds. `context-graph-seeds.ts` resolved paths,
 * symbols and text candidates here, and the engine resolved seeds again on the
 * way in — two seed engines, which is the duplication CRK2 exists to remove. The
 * kernel's anchor lane owns seed resolution now, so this file *resolves* nothing.
 *
 * It does still **forward** what the caller resolved: `options.changedPaths`
 * become caller-verified `file_path` seeds. Removing the second resolver was
 * correct; dropping the caller's own evidence with it was not, and measured as
 * 57.7% of the v1→v2 must-include recall gap. The distinction is the whole rule:
 * a path the caller supplied verbatim may claim exact confidence, and nothing
 * this file derives ever may.
 *
 * ## The one filesystem probe, and why it is still here
 *
 * `context.hydrated`, `scanned.files` and `meta.provenance_resolved` have always
 * meant "a provenance record named a file that is really on disk". ADR §7 gives
 * `hydrated` a *different* meaning on the kernel's own output — fresh index plus
 * compile-verified hash, no syscall — so serving that value under the old field
 * would silently redefine three published fields at once. Instead the v1 claim is
 * preserved by calling `verifyHydrationOnDisk`, imported from `hydrate-verify.js`
 * **directly**: `hydrate.ts` deliberately does not re-export it, and that
 * non-re-export is what keeps the query path free of filesystem modules. The
 * probe is deduped by unique path and batched, so it is strictly cheaper than the
 * per-node loop it replaces, and `meta.grounding` now says which of the two
 * claims each row is making.
 *
 * `processSpawns` is 0. The freshness preflight delegates to
 * `contextGraphStatus()`, whose git-derived cache key is the one place a child
 * process can appear; its verdict is memoized per workspace for a short window so
 * a burst of queries pays for it at most once.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { cacheGet, cacheSet } from './cache.js';
import {
  contextGraphMetaOf,
  emptyGraphMeta,
  firstProvenanceHash,
  omissionReasonsOf,
  overallConfidence,
  projectMatches
} from './context-projection.js';
import {
  defaultSearchLimits,
  emptySkipped,
  SEARCH_PROVIDER_SCHEMA,
  SEARCH_SCHEMA_VERSION,
  type SearchContextGraphMeta,
  type SearchContextMeta,
  type SearchLimits,
  type SearchMatch,
  type SearchRequest,
  type SearchResponse
} from './types.js';
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphStatus
} from '../triwiki/context-graph/contracts.js';
import { contextGraphExtractors } from '../triwiki/context-graph/extractors/index.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import {
  CONTEXT_GRAPH_TRAVERSAL_CAPS,
  DEFAULT_CONTEXT_GRAPH_QUERY_PROFILE,
  isContextGraphQueryProfileName,
  type ContextGraphQueryProfileName
} from '../triwiki/context-graph/profiles.js';
import {
  changedPathKernelSeeds,
  changedPathSeeds,
  openWorkspaceContextIndex,
  queryWorkspaceContext,
  sharedContextIndexCache,
  workspaceContextFailureOf,
  type KernelRequest,
  type WorkspaceContextAnswer
} from '../triwiki/context-graph/query/index.js';
// Imported from the module that owns it, never through the facade barrel: the
// query path must not link `node:fs`, and the cheapest guarantee is that nothing
// on it can reach this symbol by importing `query/index.js`.
import { verifyHydrationOnDisk } from '../triwiki/context-graph/query/hydrate-verify.js';
import { contextIndexFreshness } from '../triwiki/context-graph/store/index-freshness.js';

const CONTEXT_ENGINE = 'triwiki+context-graph' as const;
const CONTEXT_METHOD = 'context_graph_query' as const;
const STATUS_MEMO_TTL_MS = 2_000;

/** Patterns that are filters, not locations. A focus path has to name a real place. */
const GLOB_META = /[*?[\]{}]/;

/**
 * Injection seam. `SearchRequest` cannot carry these, and a caller that already
 * ran a freshness preflight must not be forced to pay for a second one.
 */
export interface SearchContextOptions {
  readonly status?: ContextGraphStatus | undefined;
  readonly profile?: ContextGraphQueryProfileName | undefined;
  readonly tokenBudget?: number | undefined;
  readonly maxSelected?: number | undefined;
  /** Use the generation-scoped response cache. Defaults to true. */
  readonly cache?: boolean | undefined;
  readonly risk?: 'normal' | 'high' | undefined;
  /**
   * Workspace-relative paths the caller has already resolved — the files in the
   * diff, the slice's write scope, the paths a fix is about. They enter the
   * kernel as caller-verified `file_path` seeds and nothing here derives,
   * completes or guesses one: a path this caller did not supply verbatim must
   * not claim exact confidence (§4).
   */
  readonly changedPaths?: readonly string[] | undefined;
}

export async function searchContext(req: SearchRequest, options: SearchContextOptions = {}): Promise<SearchResponse> {
  const started = Date.now();
  const limits = defaultSearchLimits(req.limits);
  const root = path.resolve(req.root);
  const query = (req.query || req.pattern || '').trim();
  const why = req.why || 'ai_context';
  const profile = resolveProfile(req, options);
  const tokenBudget = resolveTokenBudget(req, options);

  if (!query) {
    return failure({ started, limits, why, errors: ['missing_context_query'], warnings: [], repair: false });
  }

  const status = await preflightStatus(root, options);
  if (status.status !== 'fresh' || status.errorCode) {
    return failure({
      started,
      limits,
      why,
      errors: [status.errorCode ?? 'context_graph_unusable'],
      warnings: [...status.reasons],
      repair: true,
      generatedAt: status.generatedAt,
      ...(status.snapshotHash === null ? {} : { graph: emptyGraphMeta(status.snapshotHash, profile, tokenBudget) })
    });
  }

  const cacheKey = responseCacheKey({ root, query, profile, tokenBudget, status, limits, req, options });
  const store = sharedContextIndexCache();
  const useCache = options.cache !== false;

  let answer: WorkspaceContextAnswer;
  let snapshotHash: string;
  try {
    const handle = await openWorkspaceContextIndex(root);
    snapshotHash = handle.snapshotHash;
    if (useCache) {
      const cached = store.getResponse<SearchResponse>(root, snapshotHash, cacheKey);
      if (cached) return { ...cached, cacheHit: true, durationMs: Date.now() - started };
    }
    answer = await queryWorkspaceContext(root, kernelRequestOf({ query, profile, tokenBudget, limits, req, options }), {
      index: handle
    });
  } catch (error) {
    return indexFailure({ started, limits, why, error, profile, tokenBudget, generatedAt: status.generatedAt });
  }

  // The only syscalls on this path, and they are the ones the published
  // `hydrated` field has always been a claim about.
  const verified = await verifyHydrationOnDisk(answer.hydration, { root });
  const grounded = new Set<string>();
  for (const node of verified.nodes) if (node.hydrated) grounded.add(node.nodeId);

  const matches = projectMatches(verified.nodes, snapshotHash, answer.kernel.plan.profile, grounded);
  const response = buildResponse({
    started,
    limits,
    why,
    answer,
    matches,
    snapshotHash,
    verifiedPaths: verified.verifiedPaths,
    generatedAt: status.generatedAt
  });
  if (useCache) store.setResponse(root, snapshotHash, cacheKey, response, responseBytesOf(matches));
  return response;
}

function resolveProfile(req: SearchRequest, options: SearchContextOptions): ContextGraphQueryProfileName {
  if (isContextGraphQueryProfileName(options.profile)) return options.profile;
  // `--profile` reaches the provider as an additive request field; reading it
  // structurally keeps the published `sks.search-provider.v1` request shape intact.
  const carried = (req as { profile?: unknown }).profile;
  if (isContextGraphQueryProfileName(carried)) return carried;
  return DEFAULT_CONTEXT_GRAPH_QUERY_PROFILE;
}

/**
 * `SearchRequest.tokenBudget` is published as "`context` mode only: token budget
 * for the packed context" and was read by nothing: this mode took the injected
 * option or the default, so a caller setting the documented field silently got
 * the default budget. Same precedence as `profile` — the injection seam wins,
 * then the request, then the cap — because a caller holding both is the one that
 * ran the preflight.
 */
function resolveTokenBudget(req: SearchRequest, options: SearchContextOptions): number {
  const carried = options.tokenBudget ?? req.tokenBudget;
  if (typeof carried !== 'number' || !Number.isFinite(carried)) {
    return CONTEXT_GRAPH_TRAVERSAL_CAPS.defaultTokenBudget;
  }
  return Math.max(0, carried);
}

/**
 * Changed paths from the injection seam, else from the request.
 *
 * Both are the caller's own claim about which files this question is about, so
 * neither is trusted further than the other: whichever arrives, the kernel
 * checks that the id exists before the seed can anchor anything, and a path that
 * resolves to no node is reported as an unknown seed rather than approximated.
 */
function resolveChangedPaths(req: SearchRequest, options: SearchContextOptions): readonly string[] {
  if (options.changedPaths !== undefined) return options.changedPaths;
  return Array.isArray(req.changedPaths) ? req.changedPaths : [];
}

/** Locations only. A glob is a filter and cannot anchor a lane (§7.1). */
function focusPathsOf(patterns: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of patterns ?? []) {
    const candidate = String(raw ?? '').trim().replace(/^\.\//, '').replace(/\/+$/, '');
    if (!candidate || GLOB_META.test(candidate)) continue;
    if (!isWorkspaceRelativePosixPath(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

interface KernelRequestInput {
  query: string;
  profile: ContextGraphQueryProfileName;
  tokenBudget: number;
  limits: Required<SearchLimits>;
  req: SearchRequest;
  options: SearchContextOptions;
}

/**
 * The kernel still resolves every seed the *query* implies — this file does not
 * re-run the v1 resolver, and that duplication stays removed.
 *
 * `seeds` carries only what the query cannot express: paths the caller already
 * resolved. They are the caller's own evidence, so dropping them is not
 * simplification but data loss, and it measured as 57.7% of the v1→v2
 * must-include recall gap.
 */
function kernelRequestOf(input: KernelRequestInput): KernelRequest {
  const focusPaths = focusPathsOf(input.req.include);
  const seeds = changedPathKernelSeeds(resolveChangedPaths(input.req, input.options));
  const caps = CONTEXT_GRAPH_TRAVERSAL_CAPS;
  return {
    query: input.query,
    profile: input.profile,
    tokenBudget: input.tokenBudget,
    maxSelected: Math.max(1, Math.min(input.limits.maxMatches, input.options.maxSelected ?? caps.maxSelectedNodes)),
    ...(input.options.risk === undefined ? {} : { risk: input.options.risk }),
    ...(focusPaths.length === 0 ? {} : { focusPaths }),
    ...(seeds.length === 0 ? {} : { seeds })
  };
}

/**
 * Freshness verdict, memoized per workspace for a short window. The memo exists so
 * repeated queries in one process do not re-run the git-derived cache key; it is
 * deliberately short-lived, because serving a stale verdict is the failure mode
 * this whole mode is built to refuse.
 */
async function preflightStatus(root: string, options: SearchContextOptions): Promise<ContextGraphStatus> {
  if (options.status) return options.status;
  const key = `sks.search.context-graph.status ${root}`;
  const cached = cacheGet<ContextGraphStatus>(key);
  if (cached) return cached;
  // `verifySources` is off: the cache key already fingerprints the bytes of every
  // dirty tracked file and every relevant untracked one, so a source edit still
  // lands as `cache_key_changed` without re-hashing thousands of recorded inputs.
  // Freshness without the 58 MB parse. `contextGraphStatus` reads the whole JSON
  // snapshot as its first act; this reads the small meta file and compares cache
  // keys instead. The two are asserted to return the same verdict across fresh,
  // cache-key-stale, source-edited, corrupt-meta and code-only workspaces — the
  // git-derived staleness check that made the snapshot read load-bearing is
  // preserved, not dropped.
  const status = await contextIndexFreshness(root, { extractors: contextGraphExtractors(), verifySources: false });
  cacheSet(key, status, STATUS_MEMO_TTL_MS);
  return status;
}

interface ResponseCacheKeyInput {
  root: string;
  query: string;
  profile: ContextGraphQueryProfileName;
  tokenBudget: number;
  status: ContextGraphStatus;
  limits: Required<SearchLimits>;
  req: SearchRequest;
  options: SearchContextOptions;
}

/** Keyed on the profile and the request; the generation supplies the snapshot identity. */
function responseCacheKey(input: ResponseCacheKeyInput): string {
  const payload = JSON.stringify({
    kind: 'sks.search.context-graph.v1',
    root: input.root,
    query: input.query,
    profile: input.profile,
    snapshotHash: input.status.snapshotHash ?? '',
    tokenBudget: input.tokenBudget,
    maxMatches: input.limits.maxMatches,
    maxSelected: input.options.maxSelected ?? null,
    risk: input.options.risk ?? 'normal',
    include: input.req.include ?? [],
    exclude: input.req.exclude ?? [],
    // Seeds change the answer, so they have to change the key. Keyed on the
    // resolved seed set rather than the raw option, so two callers who differ
    // only in an unusable path still share one cached answer.
    changedPaths: changedPathSeeds(resolveChangedPaths(input.req, input.options)).map((seed) => seed.path)
  });
  return `sks.search.context-graph ${crypto.createHash('sha256').update(payload).digest('hex')}`;
}

/** Rough resident cost, so the cache can budget without serializing every answer. */
function responseBytesOf(matches: readonly SearchMatch[]): number {
  return 512 * (matches.length + 1);
}

interface RespondInput {
  started: number;
  limits: Required<SearchLimits>;
  ok: boolean;
  matches: SearchMatch[];
  truncated: boolean;
  timeout: boolean;
  scanned: SearchResponse['scanned'];
  skipped: SearchResponse['skipped'];
  warnings: string[];
  errors: string[];
  context: SearchContextMeta;
}

/** The one response shape. `processSpawns` is 0 on every path through this mode. */
function respond(input: RespondInput): SearchResponse {
  return {
    schemaVersion: SEARCH_SCHEMA_VERSION,
    schema: SEARCH_PROVIDER_SCHEMA,
    ok: input.ok,
    mode: 'context',
    provider: 'triwiki',
    engine: CONTEXT_ENGINE,
    matches: input.matches,
    confidence: overallConfidence(input.matches),
    truncated: input.truncated,
    timeout: input.timeout,
    limits: input.limits,
    scanned: input.scanned,
    skipped: input.skipped,
    cacheHit: false,
    warnings: input.warnings,
    errors: input.errors,
    durationMs: Date.now() - input.started,
    processSpawns: 0,
    context: input.context,
    deterministicOrder: 'path_line_column'
  };
}

interface BuildResponseInput {
  started: number;
  limits: Required<SearchLimits>;
  why: string;
  answer: WorkspaceContextAnswer;
  matches: SearchMatch[];
  snapshotHash: string;
  verifiedPaths: number;
  generatedAt: string | null;
}

function buildResponse(input: BuildResponseInput): SearchResponse {
  const { answer, matches, limits } = input;
  const kept = matches.slice(0, limits.maxMatches);
  const graph: SearchContextGraphMeta = contextGraphMetaOf({
    kernel: answer.kernel,
    hydration: answer.hydration,
    snapshotHash: input.snapshotHash
  });
  const truncated = answer.kernel.truncated || matches.length > limits.maxMatches;
  const omissions = omissionReasonsOf(answer.kernel, answer.hydration);
  let omitted = 0;
  for (const count of Object.values(omissions)) omitted += count;

  const warnings = [...answer.kernel.warnings];
  // The v1 seed scanner reported its own budget under this token; the posting cap
  // is its CRK2 counterpart, so callers matching on the string keep working.
  if ((omissions.posting_cap ?? 0) > 0) warnings.push('context_graph_seed_scan_budget_exhausted');

  return respond({
    started: input.started,
    limits,
    ok: true,
    matches: kept,
    truncated,
    timeout: answer.kernel.timedOut,
    scanned: { files: input.verifiedPaths, bytes: 0 },
    skipped: { files: omitted, reasons: { ...omissions } },
    warnings,
    errors: [],
    context: {
      whySearched: input.why,
      method: CONTEXT_METHOD,
      // Hydrated means the answer resolved to a source on disk, and nothing else.
      hydrated: kept.some((match) => match.meta?.provenance_resolved === true),
      indexFreshness: input.generatedAt,
      fileHash: firstProvenanceHash(kept[0]),
      truncation: truncated,
      excludedCount: graph.staleExcluded + graph.invalidatedExcluded,
      tokenBudgetOmissions: omissions.token_budget ?? 0,
      graph
    }
  });
}

interface IndexFailureInput {
  started: number;
  limits: Required<SearchLimits>;
  why: string;
  error: unknown;
  profile: ContextGraphQueryProfileName;
  tokenBudget: number;
  generatedAt: string | null;
}

/**
 * The frozen ADR §5 codes, projected onto the three the search contract has
 * always published. The precise CRK2 code is carried through as a warning rather
 * than replacing the public one: callers branch on `errors[0]`, and a new string
 * there would be a breaking change dressed up as precision.
 */
function legacyErrorCodeOf(code: string): string {
  if (code === 'context_index_missing') return CONTEXT_GRAPH_MISSING_ERROR;
  if (code === 'context_index_stale') return CONTEXT_GRAPH_STALE_ERROR;
  return CONTEXT_GRAPH_CORRUPT_ERROR;
}

function indexFailure(input: IndexFailureInput): SearchResponse {
  const failed = workspaceContextFailureOf(input.error);
  // Not an index failure: a real bug must not be reported as a corrupt index,
  // because that tells the user to run a repair that cannot fix it.
  if (failed === null) throw input.error;
  return failure({
    started: input.started,
    limits: input.limits,
    why: input.why,
    errors: [legacyErrorCodeOf(failed.code)],
    warnings: [failed.code],
    repair: true,
    repairCommand: failed.repairCommand,
    generatedAt: input.generatedAt
  });
}

interface FailureInput {
  started: number;
  limits: Required<SearchLimits>;
  why: string;
  errors: string[];
  warnings: string[];
  /** Name the repair command. Only a graph fault earns it; a malformed request does not. */
  repair: boolean;
  repairCommand?: string;
  generatedAt?: string | null;
  graph?: SearchContextGraphMeta;
}

/** An explicit refusal. It carries no matches, by construction — never a lexical consolation prize. */
function failure(input: FailureInput): SearchResponse {
  return respond({
    started: input.started,
    limits: input.limits,
    ok: false,
    matches: [],
    truncated: false,
    timeout: false,
    scanned: { files: 0, bytes: 0 },
    skipped: emptySkipped(),
    warnings: input.warnings,
    errors: input.errors,
    context: {
      whySearched: input.why,
      method: CONTEXT_METHOD,
      hydrated: false,
      indexFreshness: input.generatedAt ?? null,
      fileHash: null,
      truncation: false,
      excludedCount: 0,
      tokenBudgetOmissions: 0,
      ...(input.graph === undefined ? {} : { graph: input.graph }),
      ...(input.repair ? { repairCommand: input.repairCommand ?? CONTEXT_GRAPH_REPAIR_COMMAND } : {})
    }
  });
}
