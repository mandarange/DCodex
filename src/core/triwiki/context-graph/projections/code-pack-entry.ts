/**
 * How a candidate becomes a `sks.code-pack.v1` entry, and how the pack stays
 * bound to the graph it came from.
 *
 * Split out of `code-pack.ts` by role: that file decides *which* nodes earn the
 * token budget, this one decides what a chosen node says and whether the pack
 * still describes the index it was projected from. The digest lives here with the
 * entry it hashes — an entry field added without being added to `stable` below
 * would silently stop moving the digest, and `index_digest` would go on claiming
 * the content had not changed.
 */
import { sha256 } from '../../../fsx.js';
import type { ContextGraphFreshness } from '../contracts.js';
import type { ContextGraphNodeView, ContextIndexReader, HydratedNode, HydrationCursor } from '../query/index.js';
import type { CodePack, CodePackCitation, CodePackEntry } from './pack-contract.js';
import {
  codePackEntryId,
  describeContextGraphNode,
  estimateEntryTokenCost,
  projectedFreshness,
  projectedTrustScore
} from './node-summary.js';
import { sortCandidates, type ProjectionCandidate } from './projection-candidate.js';

function citationsFromProvenance(selected: HydratedNode): CodePackCitation[] {
  const citations: CodePackCitation[] = [];
  const seen = new Set<string>();
  for (const ref of selected.provenance) {
    if (!ref.path || seen.has(ref.path)) continue;
    seen.add(ref.path);
    citations.push(ref.line === undefined ? { path: ref.path } : { path: ref.path, line: ref.line });
  }
  return citations;
}

/**
 * Hydrated kernel selection -> candidates.
 *
 * Provenance comes from hydration rather than being re-derived: the hydration
 * pass already refused every record that was not a workspace-relative POSIX path,
 * and a second grounding attempt here could admit one it rejected.
 */
export function candidatesFromQuery(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  nodes: readonly HydratedNode[]
): ProjectionCandidate[] {
  const candidates: ProjectionCandidate[] = [];
  for (const selected of nodes) {
    const view = cursor.node(selected.node);
    if (view === null) continue;
    const citations = citationsFromProvenance(selected);
    if (citations.length === 0) continue;
    candidates.push({
      node: view,
      text: describeContextGraphNode(reader, cursor, view),
      citations,
      members: [view],
      reasonPath: [...selected.reasonPath],
      score: Number(selected.score)
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
  members: readonly ContextGraphNodeView[],
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

export function codePackEntryOf(
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

/** Upper bound on how many cited sources are re-hashed for the freshness verdict. */
const MAX_FRESHNESS_SOURCES = 512;

/**
 * The distinct paths a pack's entries rest on, capped.
 *
 * The cap is on the *set*, not on the entry list, so a pack whose entries all
 * cite the same file still re-hashes it once and a wide pack is bounded by the
 * number of real sources rather than by how the citations happened to be split.
 */
export function codePackFreshnessSources(pack: CodePack): string[] {
  const paths = new Set<string>();
  for (const entry of pack.entries) {
    for (const citation of entry.citations) {
      if (citation.path) paths.add(citation.path);
      if (paths.size >= MAX_FRESHNESS_SOURCES) return [...paths];
    }
  }
  return [...paths];
}
