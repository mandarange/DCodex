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
 * disk.
 */
import { sha256 } from '../../../fsx.js';
import type { ContextGraphFreshness, ContextGraphNode, ContextGraphSnapshot } from '../contracts.js';
import { buildContextGraphIndex, type ContextGraphIndex } from '../graph-index.js';
import { contextGraphQueryProfile, type ContextGraphQueryProfileName } from '../profiles.js';
import type { ContextGraphQueryResult, ContextGraphSelectedNode } from '../query-types.js';
import { queryContextGraphSnapshot } from '../query/index.js';
import {
  DEFAULT_CODE_PACK_TOKEN_BUDGET,
  normalizeCodePackTokenBudget,
  CODE_PACK_SCHEMA,
  type CodePack,
  type CodePackCitation,
  type CodePackEntry
} from './pack-contract.js';
import {
  codePackEntryId,
  describeContextGraphNode,
  estimateEntryTokenCost,
  projectedFreshness,
  projectedTrustScore
} from './node-summary.js';
import { rankModuleCandidates, sortCandidates, type ProjectionCandidate } from './module-view.js';

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
  /** Present when the pack was produced for a specific question. */
  readonly query: ContextGraphQueryResult | null;
  readonly candidateCount: number;
  readonly omittedForBudget: number;
}

const MAX_PACK_ENTRIES = 64;

function isIndex(value: ContextGraphSnapshot | ContextGraphIndex): value is ContextGraphIndex {
  return typeof (value as ContextGraphIndex).nodesById?.get === 'function';
}

function citationsFromProvenance(selected: ContextGraphSelectedNode): CodePackCitation[] {
  const citations: CodePackCitation[] = [];
  const seen = new Set<string>();
  for (const ref of selected.provenance) {
    if (!ref.path || seen.has(ref.path)) continue;
    seen.add(ref.path);
    citations.push(ref.line === undefined ? { path: ref.path } : { path: ref.path, line: ref.line });
  }
  return citations;
}

function candidatesFromQuery(index: ContextGraphIndex, result: ContextGraphQueryResult): ProjectionCandidate[] {
  const candidates: ProjectionCandidate[] = [];
  for (const selected of result.selected) {
    const node = index.nodesById.get(selected.nodeId);
    if (!node) continue;
    const citations = citationsFromProvenance(selected);
    if (citations.length === 0) continue;
    candidates.push({
      node,
      text: describeContextGraphNode(index, node),
      citations,
      members: [node],
      reasonPath: selected.reasonPath,
      score: selected.score
    });
  }
  return sortCandidates(candidates);
}

/**
 * Weakest verdict across the nodes whose bytes the entry rests on.
 *
 * A member without a recorded content hash was never read from file bytes — a
 * module node addresses a directory, not a file — so it is not evidence about
 * freshness and is skipped. Only when nothing in the entry is byte-backed does
 * the recorded verdict of the entry's own node stand in.
 */
function combineFreshness(
  members: readonly ContextGraphNode[],
  snapshotFreshness: 'fresh' | 'stale',
  observed: Readonly<Record<string, string>> | undefined
): ContextGraphFreshness {
  let verdict: ContextGraphFreshness | null = null;
  for (const member of members) {
    if (!member.contentHash) continue;
    const memberVerdict = projectedFreshness(member, 'fresh', observed);
    if (memberVerdict === 'stale') {
      verdict = 'stale';
      break;
    }
    if (memberVerdict === 'unknown') verdict = 'unknown';
    else if (verdict === null) verdict = 'fresh';
  }
  const resolved = verdict ?? members[0]?.freshness ?? 'unknown';
  return snapshotFreshness === 'stale' && resolved === 'fresh' ? 'stale' : resolved;
}

function entryOf(
  candidate: ProjectionCandidate,
  taken: ReadonlySet<string>,
  snapshotFreshness: 'fresh' | 'stale',
  observed: Readonly<Record<string, string>> | undefined
): CodePackEntry | null {
  // openwiki principle: an entry with no real repository citation is worse than no entry at all
  if (candidate.citations.length === 0) return null;
  const freshness = combineFreshness(candidate.members, snapshotFreshness, observed);
  return {
    id: codePackEntryId(candidate.node, taken),
    text: candidate.text,
    citations: candidate.citations,
    trust_score: projectedTrustScore(candidate.node, candidate.citations.length, freshness),
    freshness,
    token_cost: estimateEntryTokenCost(candidate.text)
  };
}

/**
 * Bind the pack to the graph it was projected from *and* to what it says. A
 * snapshot change moves the hash; so does an export or dependency change that
 * only shows up in the projected text.
 */
export function computeCodePackIndexDigest(snapshotHash: string, entries: readonly CodePackEntry[]): string {
  const stable = entries.map((entry) => [
    entry.id,
    entry.text,
    entry.citations.map((citation) => `${citation.path}${citation.line === undefined ? '' : `:${citation.line}`}`),
    entry.trust_score,
    entry.freshness,
    entry.token_cost
  ]);
  return sha256(JSON.stringify({ snapshotHash, entries: stable }));
}

export function isCodePackProjectionBoundToSnapshot(
  snapshotHash: string,
  pack: Pick<CodePack, 'index_digest' | 'entries'>
): boolean {
  return pack.index_digest === computeCodePackIndexDigest(snapshotHash, pack.entries);
}

function countFileNodes(snapshot: ContextGraphSnapshot): number {
  let count = 0;
  for (const node of snapshot.nodes) if (node.kind === 'file') count += 1;
  return count;
}

/**
 * Project a code pack out of a compiled snapshot.
 *
 * With `query` set the entries are whatever the graph query selected for that
 * question under the requested profile and risk. Without it the entries are the
 * repository's structurally most connected modules — in either case, ranked by
 * the graph, never by inventory order.
 */
export function projectCodePackFromGraph(
  root: string,
  source: ContextGraphSnapshot | ContextGraphIndex,
  options: BuildCodePackFromGraphOptions = {}
): CodePackProjection {
  const index = isIndex(source) ? source : buildContextGraphIndex(source);
  const tokenBudget = normalizeCodePackTokenBudget(options.tokenBudget ?? DEFAULT_CODE_PACK_TOKEN_BUDGET);
  const profile = contextGraphQueryProfile(options.profile);
  const risk = options.risk === 'high' ? 'high' : 'normal';
  const snapshotFreshness = options.snapshotFreshness ?? 'fresh';
  const maxEntries = Math.max(1, Math.min(options.maxEntries ?? MAX_PACK_ENTRIES, MAX_PACK_ENTRIES));
  const question = String(options.query ?? '').trim();

  let queryResult: ContextGraphQueryResult | null = null;
  let candidates: ProjectionCandidate[];
  if (question) {
    queryResult = queryContextGraphSnapshot(
      index,
      { root, query: question, profile: profile.name, tokenBudget, maxSelected: maxEntries, risk },
      { snapshotFreshness }
    );
    candidates = candidatesFromQuery(index, queryResult);
  } else {
    candidates = rankModuleCandidates(index, profile, risk);
  }

  const entries: CodePackEntry[] = [];
  const taken = new Set<string>();
  let totalTokenCost = 0;
  let omittedForBudget = 0;
  for (const candidate of candidates) {
    if (entries.length >= maxEntries) break;
    const entry = entryOf(candidate, taken, snapshotFreshness, options.observedSourceHashes);
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
    source_file_count: countFileNodes(index.snapshot),
    index_digest: computeCodePackIndexDigest(index.snapshot.snapshotHash, entries),
    entries,
    token_budget: tokenBudget,
    total_token_cost: totalTokenCost
  };
  return { pack, query: queryResult, candidateCount: candidates.length, omittedForBudget };
}

/** The pack itself, for callers that only want the `sks.code-pack.v1` document. */
export function buildCodePackFromGraph(
  root: string,
  source: ContextGraphSnapshot | ContextGraphIndex,
  options: BuildCodePackFromGraphOptions = {}
): CodePack {
  return projectCodePackFromGraph(root, source, options).pack;
}
