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
 */
import type { ContextGraphNode } from '../contracts.js';
import { compareContextGraphIds } from '../ids.js';
import { outgoingEdges, type ContextGraphIndex } from '../graph-index.js';
import { profileEdgeWeight, type ContextGraphQueryProfile } from '../profiles.js';
import type { CodePackCitation } from './pack-contract.js';
import { describeContextGraphNode } from './node-summary.js';

export interface ProjectionCandidate {
  readonly node: ContextGraphNode;
  readonly text: string;
  readonly citations: CodePackCitation[];
  /** Nodes whose source bytes decide this entry's freshness. */
  readonly members: ContextGraphNode[];
  readonly reasonPath: string[];
  readonly score: number;
}

const RISK_RANK: Readonly<Record<string, number>> = { low: 0, medium: 1, high: 2, protected: 3 };
const MAX_CITATIONS = 8;

function riskBonus(node: ContextGraphNode, risk: 'normal' | 'high'): number {
  const rank = RISK_RANK[node.risk] ?? 0;
  return risk === 'high' ? rank * 2 : rank * 0.75;
}

function metaNumber(node: ContextGraphNode, key: string): number {
  const value = node.metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isExportedSymbol(node: ContextGraphNode): boolean {
  return node.kind === 'symbol' && node.metadata.exported === true;
}

function pushCitation(into: CodePackCitation[], seen: Set<string>, node: ContextGraphNode): void {
  if (into.length >= MAX_CITATIONS) return;
  if (!node.path || seen.has(node.path)) return;
  seen.add(node.path);
  into.push(
    node.locator?.line === undefined ? { path: node.path } : { path: node.path, line: node.locator.line }
  );
}

interface ModuleAccumulator {
  readonly module: ContextGraphNode;
  readonly members: ContextGraphNode[];
  readonly exports: string[];
  readonly dependsOn: string[];
  relationScore: number;
  fanIn: number;
}

/** file node id -> owning module node id, built from the module `contains` edges only. */
function ownerIndex(index: ContextGraphIndex, modules: readonly ContextGraphNode[]): Map<string, string> {
  const owner = new Map<string, string>();
  for (const module of modules) {
    for (const edge of outgoingEdges(index, module.id)) {
      if (edge.type !== 'contains') continue;
      if (!owner.has(edge.to)) owner.set(edge.to, module.id);
    }
  }
  return owner;
}

function accumulateFile(
  index: ContextGraphIndex,
  accumulator: ModuleAccumulator,
  file: ContextGraphNode,
  owner: ReadonlyMap<string, string>,
  profile: ContextGraphQueryProfile
): void {
  accumulator.members.push(file);
  accumulator.fanIn += metaNumber(file, 'fanIn');
  for (const edge of outgoingEdges(index, file.id)) {
    const weight = profileEdgeWeight(profile, edge.type);
    if (weight > 0) accumulator.relationScore += weight;
    const target = index.nodesById.get(edge.to);
    if (!target) continue;
    if (isExportedSymbol(target)) accumulator.exports.push(target.label);
    if (edge.type !== 'imports' && edge.type !== 'depends_on') continue;
    const ownerId = owner.get(target.id);
    if (!ownerId || ownerId === accumulator.module.id) continue;
    const ownerNode = index.nodesById.get(ownerId);
    if (ownerNode) accumulator.dependsOn.push(ownerNode.label);
  }
}

function candidateOf(index: ContextGraphIndex, accumulator: ModuleAccumulator, risk: 'normal' | 'high'): ProjectionCandidate {
  const files = accumulator.members.filter((member) => member.id !== accumulator.module.id);
  const citations: CodePackCitation[] = [];
  const seen = new Set<string>();
  for (const file of files) pushCitation(citations, seen, file);
  if (citations.length === 0) pushCitation(citations, seen, accumulator.module);
  const text = describeContextGraphNode(index, accumulator.module, {
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
 * Rank every module in the snapshot. One pass over the module `contains` edges
 * and one pass over the contained files' outgoing edges — no full node scan per
 * candidate, and no process spawn.
 */
export function rankModuleCandidates(
  index: ContextGraphIndex,
  profile: ContextGraphQueryProfile,
  risk: 'normal' | 'high'
): ProjectionCandidate[] {
  const modules: ContextGraphNode[] = [];
  for (const node of index.snapshot.nodes) if (node.kind === 'module') modules.push(node);
  if (modules.length === 0) return rankFileCandidates(index, profile, risk);

  const owner = ownerIndex(index, modules);
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
    for (const edge of outgoingEdges(index, module.id)) {
      if (edge.type !== 'contains') continue;
      const file = index.nodesById.get(edge.to);
      if (file) accumulateFile(index, accumulator, file, owner, profile);
    }
    candidates.push(candidateOf(index, accumulator, risk));
  }
  return sortCandidates(candidates);
}

/** Fallback corpus shape for a snapshot that carries no module boundaries. */
function rankFileCandidates(
  index: ContextGraphIndex,
  profile: ContextGraphQueryProfile,
  risk: 'normal' | 'high'
): ProjectionCandidate[] {
  const candidates: ProjectionCandidate[] = [];
  for (const node of index.snapshot.nodes) {
    if (node.kind !== 'file' || !node.path) continue;
    let relationScore = 0;
    for (const edge of outgoingEdges(index, node.id)) relationScore += profileEdgeWeight(profile, edge.type);
    const citations: CodePackCitation[] = [];
    pushCitation(citations, new Set<string>(), node);
    if (citations.length === 0) continue;
    candidates.push({
      node,
      text: describeContextGraphNode(index, node),
      citations,
      members: [node],
      reasonPath: [node.id],
      score: Number((relationScore + 3 * Math.log2(1 + metaNumber(node, 'fanIn')) + riskBonus(node, risk)).toFixed(4))
    });
  }
  return sortCandidates(candidates);
}

export function sortCandidates(candidates: ProjectionCandidate[]): ProjectionCandidate[] {
  return candidates.sort(
    (left, right) => right.score - left.score || compareContextGraphIds(left.node.id, right.node.id)
  );
}
