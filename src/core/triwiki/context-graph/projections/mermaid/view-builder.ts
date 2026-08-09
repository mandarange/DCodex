/**
 * Shared Mermaid view builder: filter → reduce(global budget) → AST → serialize.
 */
import type { ArchitectureMapViewId } from '../../architecture/contracts.js';
import { byCodePoint } from '../../architecture/contracts.js';
import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import type {
  ContextGraphEdge,
  ContextGraphNode,
  ContextGraphNodeKind,
  ContextGraphSnapshot
} from '../../contracts.js';
import * as ast from './ast.js';
import type { MermaidDirection, MermaidProjectionV1 } from './contracts.js';
import { assertInjective, mermaidEdgeId, mermaidNodeId, mermaidSubgraphId } from './ids.js';
import { reduceForBudget } from './reduce.js';
import { serializeMermaidDocument, toMermaidProjection } from './serializer.js';
import { viewSpecFor } from './view-specs.js';

export interface ViewFilter {
  readonly kinds: readonly ContextGraphNodeKind[];
  readonly edgeTypes: readonly string[];
}

export interface BuildMermaidViewInput {
  readonly snapshot: ContextGraphSnapshot;
  readonly policy: ArchitectureMapPolicy;
  readonly viewId: ArchitectureMapViewId;
  readonly filter: ViewFilter;
  readonly protectedNodeIds?: readonly string[];
  readonly groupByLayer?: boolean;
  readonly layerOf?: (node: ContextGraphNode, policy: ArchitectureMapPolicy) => string | null;
  /** Override profile budget; defaults to policy.profiles.global. */
  readonly profile?: keyof ArchitectureMapPolicy['profiles'];
}

export interface MermaidViewBuildResult {
  readonly text: string;
  readonly projection: MermaidProjectionV1;
}

function labelFor(node: ContextGraphNode): string {
  return node.label || node.path || node.id;
}

function filterGraph(
  snapshot: ContextGraphSnapshot,
  filter: ViewFilter
): { nodes: ContextGraphNode[]; edges: ContextGraphEdge[] } {
  const kindSet = new Set(filter.kinds);
  const edgeSet = new Set(filter.edgeTypes);
  const nodes = snapshot.nodes
    .filter((node) => kindSet.has(node.kind))
    .sort((left, right) => byCodePoint(left.id, right.id));
  const candidateIds = new Set(nodes.map((node) => node.id));
  const edges = snapshot.edges
    .filter((edge) => edgeSet.has(edge.type) && candidateIds.has(edge.from) && candidateIds.has(edge.to))
    .sort((left, right) => byCodePoint(left.id, right.id));
  return { nodes, edges };
}

/**
 * Build one Mermaid projection from a ContextGraphSnapshot + policy + kind/edge filter.
 * Always reduces with a policy profile budget (default: global).
 */
export function buildMermaidView(input: BuildMermaidViewInput): MermaidViewBuildResult {
  const spec = viewSpecFor(input.viewId);
  const { nodes: candidateNodes, edges: candidateEdges } = filterGraph(input.snapshot, input.filter);
  const protectedIds = new Set<string>(input.protectedNodeIds ?? []);
  const profileKey = input.profile ?? 'global';
  const budget = input.policy.profiles[profileKey];
  const reduced = reduceForBudget({
    nodes: candidateNodes,
    edges: candidateEdges,
    budget,
    protectedNodeIds: protectedIds
  });

  const idMap = assertInjective(reduced.nodes.map((node) => node.id));
  const statements: ast.MermaidStatement[] = [ast.comment(`atlas-view: ${input.viewId}`)];

  if (input.groupByLayer && input.layerOf) {
    const byLayer = new Map<string, ContextGraphNode[]>();
    for (const node of reduced.nodes) {
      const layer = input.layerOf(node, input.policy) ?? 'unassigned';
      const list = byLayer.get(layer) ?? [];
      list.push(node);
      byLayer.set(layer, list);
    }
    for (const layer of [...byLayer.keys()].sort(byCodePoint)) {
      const nodes = byLayer.get(layer) ?? [];
      const subgraphNodes = nodes.map((node) =>
        ast.node({
          id: idMap.get(node.id)!,
          label: labelFor(node),
          canonicalNodeIds: [node.id]
        })
      );
      statements.push(
        ast.subgraph({
          id: mermaidSubgraphId(`layer:${layer}`),
          label: layer,
          canonicalId: `layer:${layer}`,
          statements: subgraphNodes
        })
      );
    }
  } else {
    for (const node of reduced.nodes) {
      statements.push(
        ast.node({
          id: idMap.get(node.id)!,
          label: labelFor(node),
          canonicalNodeIds: [node.id]
        })
      );
    }
  }

  for (const edge of reduced.edges) {
    const fromId = idMap.get(edge.from);
    const toId = idMap.get(edge.to);
    if (!fromId || !toId) continue;
    const style: 'solid' | 'dotted' = protectedIds.has(edge.from) || protectedIds.has(edge.to)
      ? 'dotted'
      : 'solid';
    statements.push(
      ast.edge({
        from: fromId,
        to: toId,
        relation: edge.type,
        style,
        canonicalEdgeIds: [edge.id],
        fromCanonicalId: edge.from,
        toCanonicalId: edge.to
      })
    );
    void mermaidEdgeId(edge.from, edge.to, edge.type);
  }

  for (const seed of protectedIds) {
    if (!idMap.has(seed)) void mermaidNodeId(seed);
  }

  reduced.ledger.assertBalanced();
  const doc = ast.document({
    direction: spec.direction,
    title: spec.title,
    statements
  });
  // Ensure serialize path is exercised for determinism (toMermaidProjection also serializes).
  void serializeMermaidDocument(doc);
  const built = toMermaidProjection({
    viewId: input.viewId,
    doc,
    accounting: reduced.ledger.toAccounting()
  });
  return Object.freeze({
    text: built.text,
    projection: Object.freeze({
      schema: built.schema,
      viewId: built.viewId,
      direction: built.direction,
      title: built.title,
      source: built.source,
      accounting: built.accounting,
      contentHash: built.contentHash,
      byteLength: built.byteLength
    })
  });
}

export function emptyMermaidView(input: {
  viewId: ArchitectureMapViewId;
  title: string;
  direction: MermaidDirection;
  reason: string;
}): MermaidViewBuildResult {
  const statements = [ast.comment(input.reason)];
  const reduced = reduceForBudget({
    nodes: [],
    edges: [],
    budget: { maxNodes: 1, maxEdges: 1, maxLabelChars: 56, tokenBudget: 0 }
  });
  const built = toMermaidProjection({
    viewId: input.viewId,
    doc: ast.document({
      direction: input.direction,
      title: input.title,
      statements
    }),
    accounting: reduced.ledger.toAccounting()
  });
  return Object.freeze({
    text: built.text,
    projection: Object.freeze({
      schema: built.schema,
      viewId: built.viewId,
      direction: built.direction,
      title: built.title,
      source: built.source,
      accounting: built.accounting,
      contentHash: built.contentHash,
      byteLength: built.byteLength
    })
  });
}

/** @deprecated Prefer buildMermaidView; kept for bundle-oriented callers. */
export interface ProjectionRequest {
  readonly profile?: keyof ArchitectureMapPolicy['profiles'];
  readonly seedNodeIds?: readonly string[];
  readonly seedPaths?: readonly string[];
  readonly findingSubjectIds?: readonly string[];
}

export function projectFilteredView(input: {
  viewId: ArchitectureMapViewId;
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
  filter: ViewFilter;
  request?: ProjectionRequest | undefined;
  groupByLayer?: boolean;
  layerOf?: ((node: ContextGraphNode, policy: ArchitectureMapPolicy) => string | null) | undefined;
}): MermaidProjectionV1 & { readonly text: string } {
  const protectedNodeIds = [
    ...(input.request?.seedNodeIds ?? []),
    ...(input.request?.findingSubjectIds ?? [])
  ];
  const built = buildMermaidView({
    snapshot: input.snapshot,
    policy: input.policy,
    viewId: input.viewId,
    filter: input.filter,
    ...(protectedNodeIds.length ? { protectedNodeIds } : {}),
    ...(input.groupByLayer === true ? { groupByLayer: true } : {}),
    ...(input.layerOf ? { layerOf: input.layerOf } : {}),
    ...(input.request?.profile ? { profile: input.request.profile } : {})
  });
  return Object.freeze({
    ...built.projection,
    text: built.text
  });
}

export function emptyProjection(
  viewId: ArchitectureMapViewId,
  title: string,
  direction: MermaidDirection,
  reason: string
): MermaidProjectionV1 & { readonly text: string } {
  const built = emptyMermaidView({ viewId, title, direction, reason });
  return Object.freeze({
    ...built.projection,
    text: built.text
  });
}
