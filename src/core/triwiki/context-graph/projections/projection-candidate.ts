/**
 * What a corpus-mode candidate is, and the corpus shape for an index that has no
 * module boundaries.
 *
 * Split out of `module-view.ts` by role: that file knows how a *module* earns its
 * place in the pack, this one knows what a candidate looks like and how to build
 * one when there are no modules to rank. They were one file while both shapes
 * read a materialized adjacency map; after CG2-13 each does its own bounded walk,
 * and the file fallback is the one that walks every file in the index.
 *
 * Ordering is the whole point of both shapes, so `sortCandidates` lives here with
 * the type it orders: score descending, then canonical id. The id tie-break is
 * not decoration — two modules with identical structure must pack in the same
 * order on every machine, or `index_digest` stops meaning "the content changed".
 */
import { compareContextGraphIds } from '../ids.js';
import { profileEdgeWeight, type ContextGraphQueryProfile } from '../profiles.js';
import type { ContextGraphNodeView, ContextIndexReader, HydrationCursor } from '../query/index.js';
import { PROJECTION_ALL_EDGE_TYPES, contextNodeCount, contextNodesOfKind, contextOneHopNeighbours } from './graph-facts.js';
import type { CodePackCitation } from './pack-contract.js';
import { describeContextGraphNode } from './node-summary.js';

export interface ProjectionCandidate {
  readonly node: ContextGraphNodeView;
  readonly text: string;
  readonly citations: CodePackCitation[];
  /** Nodes whose source bytes decide this entry's freshness. */
  readonly members: ContextGraphNodeView[];
  readonly reasonPath: string[];
  readonly score: number;
}

const RISK_RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, protected: 3 };
const MAX_CITATIONS = 8;

export function riskBonus(node: ContextGraphNodeView, risk: 'normal' | 'high'): number {
  const rank = RISK_RANK[node.risk] ?? 0;
  return risk === 'high' ? rank * 2 : rank * 0.75;
}

/** Append a node's own path as a citation, deduplicated and capped. */
export function pushCitation(into: CodePackCitation[], seen: Set<string>, node: ContextGraphNodeView): void {
  if (into.length >= MAX_CITATIONS) return;
  if (!node.path || seen.has(node.path)) return;
  seen.add(node.path);
  into.push(node.line === undefined ? { path: node.path } : { path: node.path, line: node.line });
}

export function sortCandidates(candidates: ProjectionCandidate[]): ProjectionCandidate[] {
  return candidates.sort(
    (left, right) => right.score - left.score || compareContextGraphIds(left.node.id, right.node.id)
  );
}

/**
 * Fallback corpus shape for an index that carries no module boundaries.
 *
 * One bounded walk per file rather than a whole-graph edge scan: the walk reports
 * the relation type it crossed, which is what `profileEdgeWeight` needs, and the
 * caps stop a hub file from making this cost depend on the graph's degree
 * distribution.
 */
export function rankFileCandidates(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  profile: ContextGraphQueryProfile,
  risk: 'normal' | 'high'
): ProjectionCandidate[] {
  const candidates: ProjectionCandidate[] = [];
  for (const node of contextNodesOfKind(reader, 'file')) {
    const view = cursor.node(node);
    if (view === null || !view.path) continue;
    let relationScore = 0;
    // A truncated hop lowers this file's score; it does not make any sentence
    // this candidate carries false, and `ProjectionCandidate` has no field a
    // caller reads to learn it. See `graph-facts.ts`.
    for (const neighbour of contextOneHopNeighbours(reader, cursor, view.node, view.id, PROJECTION_ALL_EDGE_TYPES).neighbours) {
      relationScore += profileEdgeWeight(profile, neighbour.type);
    }
    const citations: CodePackCitation[] = [];
    pushCitation(citations, new Set<string>(), view);
    if (citations.length === 0) continue;
    const fanIn = contextNodeCount(view, 'fanIn') ?? 0;
    candidates.push({
      node: view,
      text: describeContextGraphNode(reader, cursor, view),
      citations,
      members: [view],
      reasonPath: [view.id],
      score: Number((relationScore + 3 * Math.log2(1 + fanIn) + riskBonus(view, risk)).toFixed(4))
    });
  }
  return sortCandidates(candidates);
}
