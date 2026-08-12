/**
 * Merging reused and re-extracted source fragments into one graph.
 *
 * The output must be a function of the fragment *set* alone. Whether a fragment
 * came out of the cache or out of a fresh extraction cannot reach the merged
 * nodes and edges, because the merged graph is hashed, encoded, and named by its
 * own content address — an incremental build and a full rebuild of the same
 * workspace have to land on the same generation file or the store's identity
 * checks are meaningless.
 *
 * The other job here is the one that silently corrupts a graph: **no dangling
 * edge ever leaves this function.** When a source is deleted or renamed, the
 * nodes it defined vanish, and edges other fragments recorded into them lose
 * their target. An edge whose target is missing is worse than a missing edge,
 * because a reader cannot tell it apart from a real relation and will follow it.
 *
 * Which does not mean pruning quietly. The two cases carry different meanings:
 *
 * - A **reused** fragment losing an endpoint is the expected shape of a deletion
 *   or rename. It is recorded as a fact and the build continues.
 * - A **freshly extracted** fragment losing an endpoint means an extractor that
 *   just looked at the current workspace emitted a relation into nothing. The
 *   edge is still pruned, and a `dangling_edge` lint error blocks the write, so
 *   the bug surfaces instead of shipping.
 */
import {
  lintError,
  type ContextGraphEdge,
  type ContextGraphEdgeConfidence,
  type ContextGraphExtractorStat,
  type ContextGraphFreshness,
  type ContextGraphLintIssue,
  type ContextGraphMetadata,
  type ContextGraphNode,
  type ContextGraphRisk,
} from '../contracts.js';
import { compareContextGraphIds } from '../ids.js';
import { kWayMerge } from './k-way-merge.js';
import { sourceFragmentKey } from './fragment-manifest-schema.js';
import { sortSourceFragments, type ContextGraphSourceFragment } from './source-fragment.js';

/** Mirrors the v1 merge so an incremental graph and a v1 graph agree on edge policy. */
const CONFIDENCE_RANK: Readonly<Record<ContextGraphEdgeConfidence, number>> = {
  exact: 4,
  manifest: 3,
  syntactic: 2,
  observed: 1,
  derived: 0,
};

/** Lower is more pessimistic; merging takes the minimum. */
const FRESHNESS_RANK: Readonly<Record<ContextGraphFreshness, number>> = { stale: 0, unknown: 1, fresh: 2 };

/** Higher is more dangerous; merging takes the maximum. */
const RISK_RANK: Readonly<Record<ContextGraphRisk, number>> = { low: 0, medium: 1, high: 2, protected: 3 };

/** Enough dangling edges to diagnose the extractor, not enough to fill a log with them. */
const MAX_DANGLING_ISSUES = 50;

export type PrunedEdgeReason =
  | 'reused_endpoint_missing'
  | 'fresh_endpoint_missing'
  | 'derived_without_support';

export interface PrunedFragmentEdge {
  readonly edgeId: string;
  readonly from: string;
  readonly to: string;
  readonly extractor: string;
  readonly sourcePath: string;
  readonly reason: PrunedEdgeReason;
}

export interface MergeSourceFragmentsInput {
  readonly fragments: readonly ContextGraphSourceFragment[];
  /** `sourceFragmentKey` values that were loaded from the cache rather than re-extracted. */
  readonly reusedKeys?: ReadonlySet<string> | undefined;
}

export interface MergeSourceFragmentsResult {
  readonly nodes: ContextGraphNode[];
  readonly edges: ContextGraphEdge[];
  readonly issues: ContextGraphLintIssue[];
  readonly pruned: PrunedFragmentEdge[];
  readonly extractors: ContextGraphExtractorStat[];
  readonly inputHashes: Record<string, string>;
  readonly reusedFragmentCount: number;
}

interface FoldedNode {
  node: ContextGraphNode;
  /** Extractors whose contribution was accepted into this node; the basis for reuse-invariant stats. */
  contributors: Set<string>;
}

interface FoldedEdge {
  edge: ContextGraphEdge;
  origin: number;
}

function mergeMetadata(base: ContextGraphMetadata, incoming: ContextGraphMetadata): ContextGraphMetadata {
  const out: ContextGraphMetadata = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = out[key];
    if (existing === undefined || existing === null || existing === '') out[key] = value;
  }
  return out;
}

function mergeNode(existing: ContextGraphNode, incoming: ContextGraphNode): ContextGraphNode {
  const nodePath = existing.path ?? incoming.path;
  const locator = existing.locator ?? incoming.locator;
  const contentHash = existing.contentHash ?? incoming.contentHash;
  return {
    id: existing.id,
    kind: existing.kind,
    label: existing.label || incoming.label,
    ...(nodePath === undefined ? {} : { path: nodePath }),
    ...(locator === undefined ? {} : { locator }),
    ...(contentHash === undefined ? {} : { contentHash }),
    trust: Math.max(existing.trust, incoming.trust),
    freshness:
      FRESHNESS_RANK[existing.freshness] <= FRESHNESS_RANK[incoming.freshness] ? existing.freshness : incoming.freshness,
    risk: RISK_RANK[existing.risk] >= RISK_RANK[incoming.risk] ? existing.risk : incoming.risk,
    tokenCost: Math.max(existing.tokenCost, incoming.tokenCost),
    metadata: mergeMetadata(existing.metadata ?? {}, incoming.metadata ?? {}),
  };
}

function nodeConflict(
  existing: ContextGraphNode,
  incoming: ContextGraphNode,
  extractor: string,
): ContextGraphLintIssue | null {
  if (existing.kind !== incoming.kind) {
    return lintError('duplicate_node_conflict', `node ${existing.id} is declared as both ${existing.kind} and ${incoming.kind}`, {
      nodeId: existing.id,
      extractor,
    });
  }
  if (existing.contentHash && incoming.contentHash && existing.contentHash !== incoming.contentHash) {
    return lintError('duplicate_node_conflict', `node ${existing.id} has two different content hashes for the same path`, {
      nodeId: existing.id,
      extractor,
    });
  }
  return null;
}

/** NUL joined: a node id can carry a workspace path, and a path can carry a space. */
function pairKey(edge: ContextGraphEdge): string {
  return `${edge.from}\u0000${edge.to}`;
}

/**
 * Counted from the merged graph, never from the raw fragments.
 *
 * A reused fragment can still carry a relation the current workspace no longer
 * supports — an import into a file that was deleted since — which the prune
 * below removes. Summing the fragments instead would put that pruned edge in the
 * stats, the stats are hashed into the snapshot, and an incremental build would
 * land on a different content address than a full rebuild of the same workspace.
 * That is the reuse leaking into the index identity, which is exactly what may
 * not happen.
 */
function extractorStats(
  fragments: readonly ContextGraphSourceFragment[],
  nodes: readonly FoldedNode[],
  edges: readonly FoldedEdge[],
): ContextGraphExtractorStat[] {
  const stats = new Map<string, ContextGraphExtractorStat>();
  for (const fragment of fragments) {
    if (stats.has(fragment.extractor)) continue;
    stats.set(fragment.extractor, {
      id: fragment.extractor,
      revision: fragment.extractorRevision,
      nodeCount: 0,
      edgeCount: 0,
      issueCount: 0,
      skippedCount: 0,
    });
  }
  for (const folded of nodes) {
    for (const extractor of folded.contributors) {
      const stat = stats.get(extractor);
      if (stat) stat.nodeCount += 1;
    }
  }
  for (const folded of edges) {
    const stat = stats.get((fragments[folded.origin] as ContextGraphSourceFragment).extractor);
    if (stat) stat.edgeCount += 1;
  }
  return [...stats.values()].sort((left, right) => compareContextGraphIds(left.id, right.id));
}

export function mergeSourceFragments(input: MergeSourceFragmentsInput): MergeSourceFragmentsResult {
  const fragments = sortSourceFragments(input.fragments);
  const reusedKeys = input.reusedKeys ?? new Set<string>();
  const issues: ContextGraphLintIssue[] = [];
  const pruned: PrunedFragmentEdge[] = [];

  const merged = kWayMerge<ContextGraphNode, FoldedNode>({
    groups: fragments.map((fragment) => fragment.nodes),
    keyOf: (node) => node.id,
    seed: (node, origin) => ({
      node,
      contributors: new Set([(fragments[origin] as ContextGraphSourceFragment).extractor]),
    }),
    fold: (accumulated, node, origin) => {
      const extractor = (fragments[origin] as ContextGraphSourceFragment).extractor;
      const conflict = nodeConflict(accumulated.node, node, extractor);
      if (conflict) {
        issues.push(conflict);
        return accumulated;
      }
      accumulated.contributors.add(extractor);
      return { node: mergeNode(accumulated.node, node), contributors: accumulated.contributors };
    },
  });
  const nodes = merged.map((folded) => folded.node);
  const nodeIds = new Set(nodes.map((node) => node.id));

  const foldedEdges = kWayMerge<ContextGraphEdge, FoldedEdge>({
    groups: fragments.map((fragment) => fragment.edges),
    keyOf: (edge) => edge.id,
    seed: (edge, origin) => ({ edge, origin }),
    fold: (accumulated, edge, origin) =>
      CONFIDENCE_RANK[accumulated.edge.confidence] >= CONFIDENCE_RANK[edge.confidence]
        ? accumulated
        : { edge, origin },
  });

  const survivors: FoldedEdge[] = [];
  let danglingIssues = 0;
  for (const folded of foldedEdges) {
    const owner = fragments[folded.origin] as ContextGraphSourceFragment;
    if (nodeIds.has(folded.edge.from) && nodeIds.has(folded.edge.to)) {
      survivors.push(folded);
      continue;
    }
    const reused = reusedKeys.has(sourceFragmentKey(owner.extractor, owner.sourcePath));
    pruned.push({
      edgeId: folded.edge.id,
      from: folded.edge.from,
      to: folded.edge.to,
      extractor: owner.extractor,
      sourcePath: owner.sourcePath,
      reason: reused ? 'reused_endpoint_missing' : 'fresh_endpoint_missing',
    });
    if (reused || danglingIssues >= MAX_DANGLING_ISSUES) continue;
    danglingIssues += 1;
    issues.push(
      lintError('dangling_edge', `edge ${folded.edge.id} has no resolvable endpoint after extraction`, {
        edgeId: folded.edge.id,
        extractor: owner.extractor,
        path: owner.sourcePath,
      }),
    );
  }

  // Justification is recomputed over the surviving set, so a `derived` edge whose
  // supporting exact relation disappeared with a deleted file loses its licence
  // in the same pass rather than a build later.
  const justified = new Set<string>();
  for (const folded of survivors) {
    if (folded.edge.confidence === 'exact' || folded.edge.confidence === 'manifest') justified.add(pairKey(folded.edge));
  }
  const kept: FoldedEdge[] = [];
  for (const folded of survivors) {
    if (folded.edge.confidence === 'derived' && !justified.has(pairKey(folded.edge))) {
      const owner = fragments[folded.origin] as ContextGraphSourceFragment;
      pruned.push({
        edgeId: folded.edge.id,
        from: folded.edge.from,
        to: folded.edge.to,
        extractor: owner.extractor,
        sourcePath: owner.sourcePath,
        reason: 'derived_without_support',
      });
      continue;
    }
    kept.push(folded);
  }
  const edges = kept.map((folded) => folded.edge);

  const inputHashes: Record<string, string> = {};
  let reusedFragmentCount = 0;
  for (const fragment of fragments) {
    inputHashes[fragment.sourcePath] = fragment.sourceHash;
    if (reusedKeys.has(sourceFragmentKey(fragment.extractor, fragment.sourcePath))) reusedFragmentCount += 1;
  }

  return {
    nodes,
    edges,
    issues,
    pruned: pruned.sort((left, right) => compareContextGraphIds(left.edgeId, right.edgeId)),
    extractors: extractorStats(fragments, merged, kept),
    inputHashes,
    reusedFragmentCount,
  };
}

/** Zero by construction; asserted by the caller so the invariant is checked, not assumed. */
export function countDanglingEdges(nodes: readonly ContextGraphNode[], edges: readonly ContextGraphEdge[]): number {
  const ids = new Set(nodes.map((node) => node.id));
  let count = 0;
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) count += 1;
  }
  return count;
}
