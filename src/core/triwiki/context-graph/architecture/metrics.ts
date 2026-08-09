/**
 * Deterministic architecture metrics (WO §13.1).
 */
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from '../contracts.js';
import { byCodePoint, type ArchitectureMetricsV1 } from './contracts.js';
import { mergeGraphWithTopology } from './topology-overlay.js';
import type { TopologyOverlay } from './contracts.js';

export interface ModuleGraph {
  readonly moduleIds: readonly string[];
  readonly adjacency: ReadonlyMap<string, readonly string[]>;
  readonly reverse: ReadonlyMap<string, readonly string[]>;
  readonly edgeKeys: readonly string[];
}

export function buildModuleDependencyGraph(
  nodes: readonly ContextGraphNode[],
  edges: readonly ContextGraphEdge[]
): ModuleGraph {
  const modules = nodes.filter((node) => node.kind === 'module').map((node) => node.id).sort(byCodePoint);
  const moduleSet = new Set(modules);
  const fileToModule = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type !== 'contains') continue;
    if (moduleSet.has(edge.from)) fileToModule.set(edge.to, edge.from);
  }
  const resolve = (id: string): string | null => {
    if (moduleSet.has(id)) return id;
    return fileToModule.get(id) ?? null;
  };
  const adj = new Map<string, Set<string>>();
  const rev = new Map<string, Set<string>>();
  for (const id of modules) {
    adj.set(id, new Set());
    rev.set(id, new Set());
  }
  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (edge.type !== 'imports' && edge.type !== 'reexports' && edge.type !== 'depends_on') continue;
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if (!from || !to || from === to) continue;
    adj.get(from)?.add(to);
    rev.get(to)?.add(from);
    edgeKeys.add(`${from}->${to}`);
  }
  return {
    moduleIds: Object.freeze(modules),
    adjacency: new Map([...adj.entries()].map(([key, value]) => [key, Object.freeze([...value].sort(byCodePoint))])),
    reverse: new Map([...rev.entries()].map(([key, value]) => [key, Object.freeze([...value].sort(byCodePoint))])),
    edgeKeys: Object.freeze([...edgeKeys].sort(byCodePoint))
  };
}

/** Tarjan SCC; returns only components with size >= 2, members sorted. */
export function computeSccs(graph: ModuleGraph): readonly (readonly string[])[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  const strongConnect = (node: string): void => {
    indices.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.adjacency.get(node) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, lowlink.get(next) ?? 0));
      } else if (onStack.has(next)) {
        lowlink.set(node, Math.min(lowlink.get(node) ?? 0, indices.get(next) ?? 0));
      }
    }
    if (lowlink.get(node) === indices.get(node)) {
      const component: string[] = [];
      while (true) {
        const item = stack.pop();
        if (item === undefined) break;
        onStack.delete(item);
        component.push(item);
        if (item === node) break;
      }
      component.sort(byCodePoint);
      if (component.length >= 2) sccs.push(component);
    }
  };

  for (const node of graph.moduleIds) {
    if (!indices.has(node)) strongConnect(node);
  }
  sccs.sort((left, right) => byCodePoint(left.join('\0'), right.join('\0')));
  return Object.freeze(sccs.map((component) => Object.freeze(component)));
}

function percentile(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank] ?? 0;
}

export function computeArchitectureMetrics(input: {
  graph: ContextGraphSnapshot;
  topology?: TopologyOverlay;
  layerViolationCount?: number;
  ssotCollisionCount?: number;
  authorityBypassCount?: number;
  protectedVerificationGapCount?: number;
  passthroughChainCount?: number;
  duplicateFacadeCount?: number;
  orphanEntrypointCount?: number;
  unknownDynamicRelationCount?: number;
}): ArchitectureMetricsV1 {
  const merged = mergeGraphWithTopology(input.graph, input.topology ?? {
    nodes: [],
    edges: [],
    sourceManifestHashes: {},
    extractionErrors: []
  });
  const moduleGraph = buildModuleDependencyGraph(merged.nodes, merged.edges);
  const sccs = computeSccs(moduleGraph);
  const cyclic = new Set(sccs.flatMap((component) => component));
  const fanOut = moduleGraph.moduleIds.map((id) => (moduleGraph.adjacency.get(id) ?? []).length).sort((a, b) => a - b);
  const fanIn = moduleGraph.moduleIds.map((id) => (moduleGraph.reverse.get(id) ?? []).length).sort((a, b) => a - b);
  const publicSurfaceCount = merged.nodes.filter((node) =>
    node.kind === 'command' || node.kind === 'route' || node.kind === 'schema' ||
    (typeof node.metadata.public === 'boolean' && node.metadata.public === true)
  ).length;
  return Object.freeze({
    nodeCount: merged.nodes.length,
    edgeCount: merged.edges.length,
    moduleCount: moduleGraph.moduleIds.length,
    publicSurfaceCount,
    sccCount: sccs.length,
    cyclicNodeCount: cyclic.size,
    largestSccSize: sccs.reduce((max, component) => Math.max(max, component.length), 0),
    maxFanIn: fanIn.length ? fanIn[fanIn.length - 1]! : 0,
    maxFanOut: fanOut.length ? fanOut[fanOut.length - 1]! : 0,
    p95FanIn: percentile(fanIn, 0.95),
    p95FanOut: percentile(fanOut, 0.95),
    layerViolationCount: input.layerViolationCount ?? 0,
    ssotCollisionCount: input.ssotCollisionCount ?? 0,
    authorityBypassCount: input.authorityBypassCount ?? 0,
    protectedVerificationGapCount: input.protectedVerificationGapCount ?? 0,
    passthroughChainCount: input.passthroughChainCount ?? 0,
    duplicateFacadeCount: input.duplicateFacadeCount ?? 0,
    orphanEntrypointCount: input.orphanEntrypointCount ?? 0,
    averageArchitectureDepth: null,
    maxArchitectureDepth: null,
    changedPathAccounting: null,
    projectionAccounting: null,
    eligibleExtractionSuccess: null,
    unknownDynamicRelationCount: input.unknownDynamicRelationCount ?? 0
  });
}

export function sccKey(members: readonly string[]): string {
  return [...members].sort(byCodePoint).join('|');
}
