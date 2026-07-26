/**
 * In-memory adjacency over a compiled snapshot.
 *
 * The reverse index is rebuilt on load instead of being serialized: it doubles
 * the artifact size for information the snapshot already determines, and one
 * shared implementation keeps the compiler and the query engine from drifting.
 */
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from './contracts.js';
import { contextGraphPathFromId } from './ids.js';

export interface ContextGraphIndex {
  snapshot: ContextGraphSnapshot;
  nodesById: ReadonlyMap<string, ContextGraphNode>;
  edgesById: ReadonlyMap<string, ContextGraphEdge>;
  /** node id -> outgoing edge ids, sorted */
  outgoing: ReadonlyMap<string, readonly string[]>;
  /** node id -> incoming edge ids, sorted */
  incoming: ReadonlyMap<string, readonly string[]>;
  /** workspace-relative path -> node ids that live at that path, sorted */
  nodesByPath: ReadonlyMap<string, readonly string[]>;
  /** lowercased label -> node ids, sorted */
  nodesByLabel: ReadonlyMap<string, readonly string[]>;
  /** node id -> id of the strongly connected component it belongs to, when the component has more than one node */
  cycleByNode: ReadonlyMap<string, string>;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

function freeze(map: Map<string, string[]>): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [key, value] of map) out.set(key, value.sort());
  return out;
}

export function buildContextGraphIndex(snapshot: ContextGraphSnapshot): ContextGraphIndex {
  const nodesById = new Map<string, ContextGraphNode>();
  const edgesById = new Map<string, ContextGraphEdge>();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const nodesByPath = new Map<string, string[]>();
  const nodesByLabel = new Map<string, string[]>();
  const cycleByNode = new Map<string, string>();

  for (const node of snapshot.nodes) {
    nodesById.set(node.id, node);
    const nodePath = node.path ?? contextGraphPathFromId(node.id);
    if (nodePath) push(nodesByPath, nodePath, node.id);
    if (node.label) push(nodesByLabel, node.label.toLowerCase(), node.id);
  }
  for (const edge of snapshot.edges) {
    edgesById.set(edge.id, edge);
    push(outgoing, edge.from, edge.id);
    push(incoming, edge.to, edge.id);
  }
  for (const cycle of snapshot.cycles) {
    for (const nodeId of cycle.nodes) cycleByNode.set(nodeId, cycle.id);
  }

  return {
    snapshot,
    nodesById,
    edgesById,
    outgoing: freeze(outgoing),
    incoming: freeze(incoming),
    nodesByPath: freeze(nodesByPath),
    nodesByLabel: freeze(nodesByLabel),
    cycleByNode
  };
}

export function outgoingEdges(index: ContextGraphIndex, nodeId: string): ContextGraphEdge[] {
  const ids = index.outgoing.get(nodeId) ?? [];
  const out: ContextGraphEdge[] = [];
  for (const id of ids) {
    const edge = index.edgesById.get(id);
    if (edge) out.push(edge);
  }
  return out;
}

export function incomingEdges(index: ContextGraphIndex, nodeId: string): ContextGraphEdge[] {
  const ids = index.incoming.get(nodeId) ?? [];
  const out: ContextGraphEdge[] = [];
  for (const id of ids) {
    const edge = index.edgesById.get(id);
    if (edge) out.push(edge);
  }
  return out;
}

export function nodesAtPath(index: ContextGraphIndex, relativePath: string): ContextGraphNode[] {
  const ids = index.nodesByPath.get(relativePath) ?? [];
  const out: ContextGraphNode[] = [];
  for (const id of ids) {
    const node = index.nodesById.get(id);
    if (node) out.push(node);
  }
  return out;
}

/**
 * Tarjan strongly connected components over the whole snapshot. Components with
 * more than one node become `snapshot.cycles`; single-node components are not
 * cycles unless the node has a self edge.
 */
export function computeStronglyConnectedComponents(
  nodeIds: readonly string[],
  outgoingOf: (nodeId: string) => readonly { to: string }[]
): string[][] {
  const indexOf = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const start of nodeIds) {
    if (indexOf.has(start)) continue;
    // iterative Tarjan: a recursive walk overflows on repositories with deep import chains
    const work: Array<{ node: string; edgeIndex: number; edges: readonly { to: string }[] }> = [
      { node: start, edgeIndex: 0, edges: outgoingOf(start) }
    ];
    indexOf.set(start, counter);
    lowLink.set(start, counter);
    counter += 1;
    stack.push(start);
    onStack.add(start);

    while (work.length) {
      const frame = work[work.length - 1];
      if (!frame) break;
      if (frame.edgeIndex < frame.edges.length) {
        const next = frame.edges[frame.edgeIndex]?.to;
        frame.edgeIndex += 1;
        if (!next) continue;
        if (!indexOf.has(next)) {
          indexOf.set(next, counter);
          lowLink.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ node: next, edgeIndex: 0, edges: outgoingOf(next) });
        } else if (onStack.has(next)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? 0, indexOf.get(next) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) ?? 0, lowLink.get(frame.node) ?? 0));
      }
      if (lowLink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) components.push(component.sort());
      }
    }
  }
  return components.sort((left, right) => String(left[0]).localeCompare(String(right[0])));
}
