/**
 * Seed-prioritized graph slice for mission maps (WO §11).
 */
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from '../contracts.js';
import type { ArchitectureMapProfile, ArchitectureScope } from './contracts.js';
import { byCodePoint } from './contracts.js';
import type { ArchitectureMapPolicy } from './policy.js';

export const SELECTION_RULE_VERSION = 'architecture-slice.v1' as const;

export interface ArchitectureSlice {
  readonly scope: ArchitectureScope;
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
  readonly protectedNodeIds: readonly string[];
}

function ownerIndex(
  nodes: readonly ContextGraphNode[],
  edges: readonly ContextGraphEdge[]
): Map<string, string> {
  const modules = new Set(nodes.filter((node) => node.kind === 'module').map((node) => node.id));
  const owner = new Map<string, string>();
  for (const edge of edges) {
    if (edge.type !== 'contains' || !modules.has(edge.from)) continue;
    if (!owner.has(edge.to)) owner.set(edge.to, edge.from);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const edge of edges) {
      if (edge.type !== 'contains' && edge.type !== 'defines') continue;
      const parent = modules.has(edge.from) ? edge.from : owner.get(edge.from);
      if (!parent || owner.has(edge.to)) continue;
      owner.set(edge.to, parent);
      grew = true;
    }
  }
  return owner;
}

export function buildArchitectureScope(input: {
  profile: ArchitectureMapProfile;
  seedNodeIds?: readonly string[];
  seedPaths?: readonly string[];
}): ArchitectureScope {
  return Object.freeze({
    profile: input.profile,
    seedNodeIds: Object.freeze([...(input.seedNodeIds ?? [])].sort(byCodePoint)),
    seedPaths: Object.freeze([...(input.seedPaths ?? [])].sort(byCodePoint)),
    selectionRuleVersion: SELECTION_RULE_VERSION
  });
}

export function sliceArchitectureGraph(
  snapshot: ContextGraphSnapshot,
  policy: ArchitectureMapPolicy,
  scope: ArchitectureScope
): ArchitectureSlice {
  const budget = policy.profiles[scope.profile] ?? policy.profiles.global;
  const nodesById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const owner = ownerIndex(snapshot.nodes, snapshot.edges);
  const selected = new Set<string>();
  const protectedIds = new Set<string>();

  for (const id of scope.seedNodeIds) {
    if (nodesById.has(id)) {
      selected.add(id);
      protectedIds.add(id);
    }
  }
  for (const path of scope.seedPaths) {
    for (const node of snapshot.nodes) {
      if (node.path === path || (typeof node.metadata.dir === 'string' && node.metadata.dir === path)) {
        selected.add(node.id);
        protectedIds.add(node.id);
        const moduleId = node.kind === 'module' ? node.id : owner.get(node.id);
        if (moduleId) {
          selected.add(moduleId);
          protectedIds.add(moduleId);
        }
      }
    }
  }

  // S1: direct neighbors via contains/defines/imports/reexports/references
  const expandTypes = new Set(['contains', 'defines', 'imports', 'reexports', 'references']);
  for (const edge of snapshot.edges) {
    if (!expandTypes.has(edge.type)) continue;
    if (selected.has(edge.from) || selected.has(edge.to)) {
      selected.add(edge.from);
      selected.add(edge.to);
    }
  }

  // Fill with high-risk / module nodes until budget
  const ranked = [...snapshot.nodes]
    .filter((node) => node.kind === 'module' || node.risk === 'high' || node.risk === 'protected')
    .sort((a, b) => {
      const riskRank = (risk: string) =>
        risk === 'protected' ? 3 : risk === 'high' ? 2 : risk === 'medium' ? 1 : 0;
      return riskRank(b.risk) - riskRank(a.risk) || byCodePoint(a.id, b.id);
    });
  for (const node of ranked) {
    if (selected.size >= budget.maxNodes) break;
    selected.add(node.id);
    if (node.risk === 'protected') protectedIds.add(node.id);
  }

  if (selected.size === 0) {
    for (const node of snapshot.nodes.filter((n) => n.kind === 'module').sort((a, b) => byCodePoint(a.id, b.id))) {
      if (selected.size >= budget.maxNodes) break;
      selected.add(node.id);
    }
  }

  const edgeIds = snapshot.edges
    .filter((edge) => selected.has(edge.from) && selected.has(edge.to))
    .map((edge) => edge.id)
    .sort(byCodePoint)
    .slice(0, budget.maxEdges);

  return Object.freeze({
    scope,
    nodeIds: Object.freeze([...selected].sort(byCodePoint)),
    edgeIds: Object.freeze(edgeIds),
    protectedNodeIds: Object.freeze([...protectedIds].sort(byCodePoint))
  });
}
