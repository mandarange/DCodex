/**
 * Read-only topology overlay: command/route/gate/schema control relations.
 * Never persisted as a second graph SSOT.
 */
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from '../contracts.js';
import type { ArchitectureExtractionIssue, TopologyOverlay } from './contracts.js';
import { byCodePoint } from './contracts.js';
import { hashCanonical } from './fingerprint.js';

const TOPOLOGY_NODE_KINDS = new Set([
  'command',
  'route',
  'pipeline',
  'gate',
  'schema',
  'config'
]);

const TOPOLOGY_EDGE_TYPES = new Set([
  'routes_to',
  'depends_on',
  'owns',
  'gated_by',
  'affected_by',
  'derived_from'
]);

export function emptyTopologyOverlay(): TopologyOverlay {
  return Object.freeze({
    nodes: Object.freeze([]),
    edges: Object.freeze([]),
    sourceManifestHashes: Object.freeze({}),
    extractionErrors: Object.freeze([])
  });
}

export function buildTopologyOverlayFromSnapshot(snapshot: ContextGraphSnapshot): TopologyOverlay {
  const nodes = snapshot.nodes
    .filter((node) => TOPOLOGY_NODE_KINDS.has(node.kind))
    .slice()
    .sort((a, b) => byCodePoint(a.id, b.id));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges
    .filter(
      (edge) =>
        TOPOLOGY_EDGE_TYPES.has(edge.type) &&
        (nodeIds.has(edge.from) || nodeIds.has(edge.to) || TOPOLOGY_EDGE_TYPES.has(edge.type))
    )
    .slice()
    .sort((a, b) => byCodePoint(a.id, b.id));
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    sourceManifestHashes: Object.freeze({
      snapshot: snapshot.snapshotHash
    }),
    extractionErrors: Object.freeze([])
  });
}

export function mergeTopologyOntoGraph(
  graph: ContextGraphSnapshot,
  overlay: TopologyOverlay
): { nodes: ContextGraphNode[]; edges: ContextGraphEdge[]; issues: ArchitectureExtractionIssue[] } {
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const issues: ArchitectureExtractionIssue[] = [...overlay.extractionErrors];
  for (const node of overlay.nodes) {
    const existing = nodesById.get(node.id);
    if (!existing) {
      nodesById.set(node.id, node);
      continue;
    }
    // Code graph wins on conflict; record ambiguity without overwrite.
    if (existing.kind !== node.kind) {
      const issue: ArchitectureExtractionIssue =
        typeof existing.path === 'string'
          ? {
              code: 'topology_node_kind_conflict',
              message: `overlay kind ${node.kind} ignored for ${node.id}; code graph has ${existing.kind}`,
              path: existing.path
            }
          : {
              code: 'topology_node_kind_conflict',
              message: `overlay kind ${node.kind} ignored for ${node.id}; code graph has ${existing.kind}`
            };
      issues.push(issue);
    }
  }
  const edgeIds = new Set(graph.edges.map((edge) => edge.id));
  const edges = [...graph.edges];
  for (const edge of overlay.edges) {
    if (edgeIds.has(edge.id)) continue;
    if (!nodesById.has(edge.from) || !nodesById.has(edge.to)) {
      issues.push({
        code: 'topology_dangling_edge',
        message: `overlay edge ${edge.id} skipped; missing endpoint`,
        path: edge.provenance.path
      });
      continue;
    }
    edgeIds.add(edge.id);
    edges.push(edge);
  }
  return {
    nodes: [...nodesById.values()].sort((a, b) => byCodePoint(a.id, b.id)),
    edges: edges.sort((a, b) => byCodePoint(a.id, b.id)),
    issues
  };
}

/** Alias kept for analyzer/view call sites. */
export function mergeGraphWithTopology(
  graph: ContextGraphSnapshot,
  overlay: TopologyOverlay
): { nodes: readonly ContextGraphNode[]; edges: readonly ContextGraphEdge[] } {
  const merged = mergeTopologyOntoGraph(graph, overlay);
  return {
    nodes: Object.freeze(merged.nodes),
    edges: Object.freeze(merged.edges)
  };
}

export function topologyOverlayHash(overlay: TopologyOverlay): string {
  return hashCanonical({
    nodes: overlay.nodes.map((node) => node.id),
    edges: overlay.edges.map((edge) => edge.id),
    sourceManifestHashes: overlay.sourceManifestHashes,
    extractionErrors: overlay.extractionErrors
  });
}
