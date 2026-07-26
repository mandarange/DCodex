/**
 * Query profiles and the central traversal caps.
 *
 * This file plus `query/ranking-config.ts` are the only two surfaces the bounded
 * optimizer in `optimizer/` is allowed to mutate, so every profile weight and
 * every traversal bound lives here rather than being copied into call sites.
 */
import type { ContextGraphEdgeType } from './contracts.js';

export const CONTEXT_GRAPH_QUERY_PROFILE_NAMES = ['implementation', 'review', 'planning', 'answer'] as const;

export type ContextGraphQueryProfileName = (typeof CONTEXT_GRAPH_QUERY_PROFILE_NAMES)[number];

export interface ContextGraphQueryProfile {
  name: ContextGraphQueryProfileName;
  /** Edges traversed by this profile, in priority order. */
  edges: readonly ContextGraphEdgeType[];
  /** Per-edge weight contribution; edges absent from `edges` are never traversed. */
  edgeWeights: Readonly<Record<string, number>>;
  /** Traversal depth for an ordinary query. */
  maxDepth: number;
  /** Traversal depth allowed when the query touches a protected/high-risk domain. */
  maxDepthHighRisk: number;
}

export interface ContextGraphTraversalCaps {
  maxVisitedNodes: number;
  maxVisitedEdges: number;
  maxSeeds: number;
  maxSelectedNodes: number;
  defaultTokenBudget: number;
  queryTimeoutMs: number;
}

/** Central caps. A traversal that hits one of these reports `truncated`, never a silently trimmed success. */
export const CONTEXT_GRAPH_TRAVERSAL_CAPS: ContextGraphTraversalCaps = {
  maxVisitedNodes: 4000,
  maxVisitedEdges: 20000,
  maxSeeds: 24,
  maxSelectedNodes: 64,
  defaultTokenBudget: 6000,
  queryTimeoutMs: 1500
};

function weights(entries: ReadonlyArray<readonly [ContextGraphEdgeType, number]>): {
  edges: ContextGraphEdgeType[];
  edgeWeights: Record<string, number>;
} {
  const edges: ContextGraphEdgeType[] = [];
  const edgeWeights: Record<string, number> = {};
  for (const [edge, weight] of entries) {
    edges.push(edge);
    edgeWeights[edge] = weight;
  }
  return { edges, edgeWeights };
}

// `routes_to` appears in three profiles on purpose: it is the only edge that
// leaves a `command`/`route` node, so a profile without it compiles those nodes
// into the graph and can never return them. "Which handler, route, pipeline and
// gate does this command reach?" is a first-class query in the locked corpus.
const IMPLEMENTATION = weights([
  ['defines', 3.0],
  ['contains', 2.2],
  ['imports', 2.0],
  ['routes_to', 2.0],
  ['reexports', 1.8],
  ['references', 1.6],
  ['calls', 1.6],
  ['tests', 1.4],
  ['verified_by', 1.2]
]);

const REVIEW = weights([
  ['affected_by', 3.0],
  ['tests', 2.4],
  ['gated_by', 2.4],
  ['verified_by', 2.0],
  ['invalidates', 1.8],
  ['conflicts_with', 1.6],
  ['routes_to', 1.4],
  ['contains', 1.2],
  ['defines', 1.0]
]);

const PLANNING = weights([
  ['depends_on', 2.8],
  ['owns', 2.2],
  ['affected_by', 2.0],
  ['conflicts_with', 1.8],
  ['routes_to', 1.6],
  ['cochanged_with', 1.4],
  ['gated_by', 1.4],
  ['contains', 1.0],
  ['imports', 1.0]
]);

const ANSWER = weights([
  ['derived_from', 2.8],
  ['cites', 2.6],
  ['supports', 2.0],
  ['contradicts', 1.8],
  ['supersedes', 1.6],
  ['contains', 0.8]
]);

export const CONTEXT_GRAPH_QUERY_PROFILES: Readonly<Record<ContextGraphQueryProfileName, ContextGraphQueryProfile>> = {
  implementation: { name: 'implementation', ...IMPLEMENTATION, maxDepth: 2, maxDepthHighRisk: 3 },
  review: { name: 'review', ...REVIEW, maxDepth: 2, maxDepthHighRisk: 3 },
  planning: { name: 'planning', ...PLANNING, maxDepth: 2, maxDepthHighRisk: 3 },
  answer: { name: 'answer', ...ANSWER, maxDepth: 2, maxDepthHighRisk: 3 }
};

export const DEFAULT_CONTEXT_GRAPH_QUERY_PROFILE: ContextGraphQueryProfileName = 'implementation';

export function isContextGraphQueryProfileName(value: unknown): value is ContextGraphQueryProfileName {
  return typeof value === 'string' && (CONTEXT_GRAPH_QUERY_PROFILE_NAMES as readonly string[]).includes(value);
}

export function contextGraphQueryProfile(name: unknown): ContextGraphQueryProfile {
  return CONTEXT_GRAPH_QUERY_PROFILES[isContextGraphQueryProfileName(name) ? name : DEFAULT_CONTEXT_GRAPH_QUERY_PROFILE];
}

export function profileEdgeWeight(profile: ContextGraphQueryProfile, edge: ContextGraphEdgeType): number {
  return profile.edgeWeights[edge] ?? 0;
}

export function profileTraversesEdge(profile: ContextGraphQueryProfile, edge: ContextGraphEdgeType): boolean {
  return profileEdgeWeight(profile, edge) > 0;
}
