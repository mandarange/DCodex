/**
 * `sks.code-pack.v1` as a projection of the Context Graph.
 *
 * The pack used to be a second, independent index built by a directory scanner.
 * It is now a view: entries are graph nodes, citations are the provenance the
 * graph already carries, freshness is the compiler's source-hash verdict, and
 * `index_digest` binds the pack to the snapshot hash *and* to the projected
 * content, so changing an export or a dependency moves the digest even when the
 * file list does not.
 *
 * This module is pure. It performs no file I/O and spawns no process; the
 * workspace wrapper in `code-pack-workspace.ts` owns everything that touches
 * disk. The source is now an open `ContextIndexReader` rather than a parsed JSON
 * snapshot (CG2-13), which is what makes "pure" survive the migration: the reader
 * is already resident, so nothing here has to decide whether to parse 55 MB again.
 *
 * Two modes, two surfaces, and they are not interchangeable:
 *
 * - **With `query`**, entries are the retrieval kernel's selection for that
 *   question — `runContextKernel` then `hydrateSelectedCandidates`, the same
 *   sequence every other CRK2 consumer runs.
 * - **Without it**, entries are the repository's structurally most connected
 *   modules, which is a *traversal* and runs on `walkContextGraph` in
 *   `module-view.ts`. Asking the kernel for "every module" would return the top-K
 *   most relevant and silently shrink the corpus pack.
 */
import { contextGraphQueryProfile, type ContextGraphQueryProfileName } from '../profiles.js';
import {
  CONTEXT_GRAPH_RANKING_CONFIG,
  HydrationCursor,
  hydrateSelectedCandidates,
  runContextKernel,
  type ContextIndexReader,
  type ContextKernelResult
} from '../query/index.js';
import { contextCountOfKind } from './graph-facts.js';
import {
  DEFAULT_CODE_PACK_TOKEN_BUDGET,
  normalizeCodePackTokenBudget,
  CODE_PACK_SCHEMA,
  type CodePack,
  type CodePackEntry
} from './pack-contract.js';
import { candidatesFromQuery, codePackEntryOf, computeCodePackIndexDigest } from './code-pack-entry.js';
import { rankModuleCandidates, type ProjectionCandidate } from './module-view.js';

export { computeCodePackIndexDigest, isCodePackProjectionBoundToSnapshot } from './code-pack-entry.js';

export interface BuildCodePackFromGraphOptions {
  readonly tokenBudget?: number | undefined;
  /** When set, entries are selected by graph relevance to this question instead of corpus importance. */
  readonly query?: string | undefined;
  readonly profile?: ContextGraphQueryProfileName | undefined;
  readonly risk?: 'normal' | 'high' | undefined;
  readonly maxEntries?: number | undefined;
  /** Injected clock so a pack built twice from the same graph is byte-identical. */
  readonly generatedAt?: string | undefined;
  /** HEAD recorded by the graph compiler. Supplied by the caller so this stays spawn-free. */
  readonly gitHeadSha?: string | null | undefined;
  readonly snapshotFreshness?: 'fresh' | 'stale' | undefined;
  /** workspace-relative path -> current sha256, read by the caller that owns file I/O. */
  readonly observedSourceHashes?: Readonly<Record<string, string>> | undefined;
}

export interface CodePackProjection {
  readonly pack: CodePack;
  /**
   * Present when the pack was produced for a specific question. Carries the
   * kernel receipt — plan, lane telemetry, omissions — rather than v1's query
   * result, because the engine that produced it changed.
   */
  readonly query: ContextKernelResult | null;
  readonly candidateCount: number;
  readonly omittedForBudget: number;
}

const MAX_PACK_ENTRIES = 64;

/**
 * The kernel reads no wall clock of its own (§3), so the pack fixes one. A pack
 * is content-addressed by `index_digest`, and a duration that varied per run
 * would put process timing inside a receipt that is supposed to describe bytes.
 */
const PACK_KERNEL_CLOCK = (): number => 0;

/**
 * Project a code pack out of an open compact index.
 *
 * With `query` set the entries are whatever the kernel selected for that question
 * under the requested profile and risk. Without it the entries are the
 * repository's structurally most connected modules — in either case, ranked by
 * the graph, never by inventory order.
 *
 * `root` is carried for signature compatibility with every caller and is
 * deliberately unused: the reader already names the workspace it was opened for,
 * and a second opinion about which root this is could disagree with it.
 */
export function projectCodePackFromGraph(
  root: string,
  reader: ContextIndexReader,
  options: BuildCodePackFromGraphOptions = {}
): CodePackProjection {
  void root;
  const cursor = new HydrationCursor(reader);
  const tokenBudget = normalizeCodePackTokenBudget(options.tokenBudget ?? DEFAULT_CODE_PACK_TOKEN_BUDGET);
  const profile = contextGraphQueryProfile(options.profile);
  const risk = options.risk === 'high' ? 'high' : 'normal';
  const snapshotFreshness = options.snapshotFreshness ?? 'fresh';
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? MAX_PACK_ENTRIES, MAX_PACK_ENTRIES));
  const question = String(options.query ?? '').trim();

  let queryResult: ContextKernelResult | null = null;
  let candidates: ProjectionCandidate[];
  if (question) {
    queryResult = runContextKernel(
      reader,
      { query: question, profile: profile.name, tokenBudget, maxSelected: maxEntries, risk },
      { clock: PACK_KERNEL_CLOCK, config: CONTEXT_GRAPH_RANKING_CONFIG }
    );
    const hydration = hydrateSelectedCandidates(reader, queryResult.selected, {
      indexFresh: snapshotFreshness === 'fresh',
      config: CONTEXT_GRAPH_RANKING_CONFIG
    });
    candidates = candidatesFromQuery(reader, cursor, hydration.nodes);
  } else {
    candidates = rankModuleCandidates(reader, cursor, profile, risk);
  }

  const entries: CodePackEntry[] = [];
  const taken = new Set<string>();
  let totalTokenCost = 0;
  let omittedForBudget = 0;
  for (const candidate of candidates) {
    if (entries.length >= maxEntries) break;
    const entry = codePackEntryOf(candidate, taken, snapshotFreshness, options.observedSourceHashes);
    if (!entry) continue;
    if (totalTokenCost + entry.token_cost > tokenBudget) {
      omittedForBudget += 1;
      continue;
    }
    taken.add(entry.id);
    entries.push(entry);
    totalTokenCost += entry.token_cost;
  }

  const pack: CodePack = {
    schema: CODE_PACK_SCHEMA,
    generated_at: options.generatedAt ?? new Date().toISOString(),
    git_head_sha: options.gitHeadSha ?? null,
    source_file_count: contextCountOfKind(reader, 'file'),
    index_digest: computeCodePackIndexDigest(reader.snapshotHash, entries),
    entries,
    token_budget: tokenBudget,
    total_token_cost: totalTokenCost
  };
  return { pack, query: queryResult, candidateCount: candidates.length, omittedForBudget };
}

/** The pack itself, for callers that only want the `sks.code-pack.v1` document. */
export function buildCodePackFromGraph(
  root: string,
  reader: ContextIndexReader,
  options: BuildCodePackFromGraphOptions = {}
): CodePack {
  return projectCodePackFromGraph(root, reader, options).pack;
}
