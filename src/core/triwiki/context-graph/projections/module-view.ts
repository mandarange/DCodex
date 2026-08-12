/**
 * Corpus-mode candidates: the repository-wide projection used when a refresh is
 * not answering a specific question.
 *
 * The ordering here is the whole point. The retired scanner emitted module cards
 * in inventory order, so whichever directory happened to sort first won the token
 * budget. This ranks modules by what the graph actually says about them —
 * profile-weighted incident relations, fan-in, and risk — so the budget is spent
 * on the modules the repository depends on rather than on the ones whose path
 * starts with `a`.
 *
 * ## This is a traversal, not a retrieval query (CG2-13)
 *
 * A module view is the `contains` closure of every module node plus one hop out
 * of each contained file. That is a question about graph *shape*, and the
 * retrieval kernel structurally cannot answer it: the kernel fuses lanes and
 * selects a bounded top-K, so asking it for "every module" would return the most
 * relevant few and silently shrink the corpus pack. So this runs on
 * `walkContextGraph` — no scoring, no selection, everything reachable inside the
 * caps — and does its own ranking afterwards on facts the walk reported.
 *
 * The two v1 behaviours that moved underneath it — string-interned metadata and
 * one-hop dedupe by target — are recorded in `graph-facts.ts`. The candidate
 * shape itself, and the corpus shape for an index with no modules, are in
 * `projection-candidate.ts`.
 */
import type { ContextGraphEdgeType } from '../contracts.js';
import { profileEdgeWeight, type ContextGraphQueryProfile } from '../profiles.js';
import {
  contextNodeFlag,
  type ContextGraphNodeView,
  type ContextIndexReader,
  type HydrationCursor
} from '../query/index.js';
import { PROJECTION_ALL_EDGE_TYPES, contextNodeCount, contextNodesOfKind, contextOneHopNeighbours } from './graph-facts.js';
import type { CodePackCitation } from './pack-contract.js';
import { describeContextGraphNode } from './node-summary.js';
import {
  pushCitation,
  rankFileCandidates,
  riskBonus,
  sortCandidates,
  type ProjectionCandidate
} from './projection-candidate.js';

export { sortCandidates, type ProjectionCandidate } from './projection-candidate.js';

const CONTAINS_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(['contains']);
const OWNERSHIP_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(['imports', 'depends_on']);

function isExportedSymbol(node: ContextGraphNodeView): boolean {
  return node.kind === 'symbol' && contextNodeFlag(node, 'exported');
}

interface ModuleAccumulator {
  readonly module: ContextGraphNodeView;
  readonly members: ContextGraphNodeView[];
  readonly exports: string[];
  readonly dependsOn: string[];
  relationScore: number;
  fanIn: number;
}

function accumulateFile(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  accumulator: ModuleAccumulator,
  file: ContextGraphNodeView,
  owner: ReadonlyMap<number, ContextGraphNodeView>,
  profile: ContextGraphQueryProfile
): void {
  accumulator.members.push(file);
  accumulator.fanIn += contextNodeCount(file, 'fanIn') ?? 0;
  for (const neighbour of contextOneHopNeighbours(reader, cursor, file.node, file.id, PROJECTION_ALL_EDGE_TYPES)) {
    const weight = profileEdgeWeight(profile, neighbour.type);
    if (weight > 0) accumulator.relationScore += weight;
    const target = neighbour.view;
    if (isExportedSymbol(target)) accumulator.exports.push(target.label);
    if (!OWNERSHIP_EDGE_TYPES.has(neighbour.type)) continue;
    const ownerNode = owner.get(target.node);
    if (ownerNode && ownerNode.node !== accumulator.module.node) accumulator.dependsOn.push(ownerNode.label);
  }
}

function candidateOf(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  accumulator: ModuleAccumulator,
  risk: 'normal' | 'high'
): ProjectionCandidate {
  const files = accumulator.members.filter((member) => member.node !== accumulator.module.node);
  const citations: CodePackCitation[] = [];
  const seen = new Set<string>();
  for (const file of files) pushCitation(citations, seen, file);
  if (citations.length === 0) pushCitation(citations, seen, accumulator.module);
  const text = describeContextGraphNode(reader, cursor, accumulator.module, {
    exports: accumulator.exports,
    dependsOn: accumulator.dependsOn,
    fileCount: files.length
  });
  const score =
    accumulator.relationScore
    + 3 * Math.log2(1 + accumulator.fanIn)
    + Math.log2(1 + accumulator.exports.length)
    + riskBonus(accumulator.module, risk);
  return {
    node: accumulator.module,
    text,
    citations,
    members: accumulator.members,
    reasonPath: [accumulator.module.id, 'contains', `${files.length} file(s)`],
    score: Number(score.toFixed(4))
  };
}

/**
 * Rank every module in the index. One `contains` walk per module, memoized so the
 * ownership map and the candidate pass share it, then one walk per contained
 * file — no full node scan per candidate, and no process spawn.
 */
export function rankModuleCandidates(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  profile: ContextGraphQueryProfile,
  risk: 'normal' | 'high'
): ProjectionCandidate[] {
  const modules: ContextGraphNodeView[] = [];
  for (const node of contextNodesOfKind(reader, 'module')) {
    const view = cursor.node(node);
    if (view !== null) modules.push(view);
  }
  if (modules.length === 0) return rankFileCandidates(reader, cursor, profile, risk);

  // file node -> owning module, built from the module `contains` edges only. The
  // walk is memoized so the ownership pass and the candidate pass share it.
  const owner = new Map<number, ContextGraphNodeView>();
  const contained = new Map<number, ContextGraphNodeView[]>();
  for (const module of modules) {
    const files = contextOneHopNeighbours(reader, cursor, module.node, module.id, CONTAINS_EDGE_TYPES)
      .map((neighbour) => neighbour.view);
    contained.set(module.node, files);
    for (const file of files) if (!owner.has(file.node)) owner.set(file.node, module);
  }

  const candidates: ProjectionCandidate[] = [];
  for (const module of modules) {
    const accumulator: ModuleAccumulator = {
      module,
      members: [module],
      exports: [],
      dependsOn: [],
      relationScore: 0,
      fanIn: 0
    };
    for (const file of contained.get(module.node) ?? []) {
      accumulateFile(reader, cursor, accumulator, file, owner, profile);
    }
    candidates.push(candidateOf(reader, cursor, accumulator, risk));
  }
  return sortCandidates(candidates);
}
