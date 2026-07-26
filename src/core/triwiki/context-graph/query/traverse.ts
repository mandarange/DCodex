/**
 * Bounded bidirectional traversal.
 *
 * Forward hops answer "what does this reach"; reverse hops answer "what reaches
 * this", which is the whole point of the review and planning profiles — a change
 * to a file matters because of its dependents, not its dependencies.
 *
 * The walk is breadth-first, so the first time a node is discovered it is at its
 * minimum depth. Expansion order is fully determined by the sorted seed list and
 * the sorted adjacency lists in the index, and ties are broken on edge id, so
 * three runs over the same snapshot produce the same parent chains. Every cap is
 * reported rather than silently applied.
 */
import type { ContextGraphEdge } from '../contracts.js';
import { incomingEdges, outgoingEdges, type ContextGraphIndex } from '../graph-index.js';
import { compareContextGraphIds, contextGraphPathFromId } from '../ids.js';
import { profileEdgeWeight, type ContextGraphQueryProfile } from '../profiles.js';
import type { ContextGraphSeed } from '../query-types.js';
import { contextGraphSeedConfidenceScore, type ContextGraphRankingConfig } from './ranking-config.js';

export interface ContextGraphTraversalState {
  readonly nodeId: string;
  depth: number;
  weight: number;
  seedNodeId: string;
  parentNodeId: string | null;
  parentEdgeId: string | null;
  parentReverse: boolean;
  /** True when the node itself, or something on its discovery chain, sits under a requested focus path. */
  focusMatched: boolean;
}

export interface ContextGraphTraversalResult {
  readonly states: Map<string, ContextGraphTraversalState>;
  readonly visitedNodes: number;
  readonly visitedEdges: number;
  readonly nodeCapHit: boolean;
  readonly edgeCapHit: boolean;
  /** Nodes reached at the depth limit and therefore never expanded. */
  readonly depthLimited: number;
  readonly timedOut: boolean;
}

export interface TraverseContextGraphInput {
  readonly index: ContextGraphIndex;
  readonly seeds: readonly ContextGraphSeed[];
  readonly profile: ContextGraphQueryProfile;
  readonly maxDepth: number;
  readonly maxVisitedNodes: number;
  readonly maxVisitedEdges: number;
  readonly config: ContextGraphRankingConfig;
  readonly focusPaths: readonly string[];
  /** Epoch milliseconds after which the walk stops and reports `timedOut`. */
  readonly deadline: number | null;
}

export function contextGraphNodePath(index: ContextGraphIndex, nodeId: string): string | null {
  const node = index.nodesById.get(nodeId);
  if (node?.path) return node.path;
  return contextGraphPathFromId(nodeId);
}

export function isUnderFocusPath(nodePath: string | null, focusPaths: readonly string[]): boolean {
  if (!nodePath) return false;
  for (const focus of focusPaths) {
    if (!focus) continue;
    if (nodePath === focus || nodePath.startsWith(`${focus}/`)) return true;
  }
  return false;
}

function decayLadder(config: ContextGraphRankingConfig, maxDepth: number): number[] {
  const ladder: number[] = [1];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    ladder.push((ladder[depth - 1] ?? 1) * config.depthDecay);
  }
  return ladder;
}

interface Candidate {
  edge: ContextGraphEdge;
  neighbourId: string;
  reverse: boolean;
}

function neighbours(index: ContextGraphIndex, nodeId: string): Candidate[] {
  const out: Candidate[] = [];
  for (const edge of outgoingEdges(index, nodeId)) out.push({ edge, neighbourId: edge.to, reverse: false });
  for (const edge of incomingEdges(index, nodeId)) out.push({ edge, neighbourId: edge.from, reverse: true });
  return out;
}

/**
 * Replace an existing discovery only when the new one is strictly better at the
 * same depth. Comparing on (weight, edge id) keeps the chosen parent chain — and
 * therefore the rendered explanation — identical across runs.
 *
 * Already-expanded children are deliberately not re-relaxed: the weight is a
 * ranking signal over a depth-bounded neighbourhood, not a shortest-path metric,
 * and re-relaxation would cost a second pass for a difference the packer cannot
 * observe at these depths.
 */
function improves(existing: ContextGraphTraversalState, depth: number, weight: number, edgeId: string): boolean {
  if (depth !== existing.depth) return false;
  if (weight !== existing.weight) return weight > existing.weight;
  if (existing.parentEdgeId === null) return false;
  return compareContextGraphIds(edgeId, existing.parentEdgeId) < 0;
}

export function traverseContextGraph(input: TraverseContextGraphInput): ContextGraphTraversalResult {
  const { index, seeds, profile, maxDepth, maxVisitedNodes, maxVisitedEdges, config, focusPaths, deadline } = input;
  const states = new Map<string, ContextGraphTraversalState>();
  const decay = decayLadder(config, maxDepth);
  const focusActive = focusPaths.length > 0;
  const queue: string[] = [];

  for (const seed of seeds) {
    if (!index.nodesById.has(seed.nodeId) || states.has(seed.nodeId)) continue;
    if (states.size >= maxVisitedNodes) break;
    const path = contextGraphNodePath(index, seed.nodeId);
    states.set(seed.nodeId, {
      nodeId: seed.nodeId,
      depth: 0,
      weight: seed.score ?? contextGraphSeedConfidenceScore(config, seed.confidence),
      seedNodeId: seed.nodeId,
      parentNodeId: null,
      parentEdgeId: null,
      parentReverse: false,
      focusMatched: !focusActive || isUnderFocusPath(path, focusPaths)
    });
    queue.push(seed.nodeId);
  }

  let visitedEdges = 0;
  let depthLimited = 0;
  let nodeCapHit = false;
  let edgeCapHit = false;
  let timedOut = false;
  let sinceClockCheck = 0;
  let head = 0;

  while (head < queue.length) {
    const nodeId = queue[head];
    head += 1;
    if (nodeId === undefined) continue;
    const state = states.get(nodeId);
    if (!state) continue;
    if (state.depth >= maxDepth) {
      depthLimited += 1;
      continue;
    }

    const childDepth = state.depth + 1;
    const childDecay = decay[childDepth] ?? 0;
    for (const candidate of neighbours(index, nodeId)) {
      if (visitedEdges >= maxVisitedEdges) {
        edgeCapHit = true;
        break;
      }
      visitedEdges += 1;
      sinceClockCheck += 1;
      if (sinceClockCheck >= config.timeoutCheckInterval) {
        sinceClockCheck = 0;
        if (deadline !== null && Date.now() > deadline) {
          timedOut = true;
          break;
        }
      }

      const base = profileEdgeWeight(profile, candidate.edge.type);
      if (base <= 0) continue;
      const neighbour = index.nodesById.get(candidate.neighbourId);
      if (!neighbour) continue;

      const multiplier = config.edgeConfidenceMultiplier[candidate.edge.confidence] ?? 0;
      const direction = candidate.reverse ? config.reverseEdgeMultiplier : 1;
      const weight = state.weight * config.depthDecay + base * multiplier * direction * childDecay;
      const existing = states.get(candidate.neighbourId);

      if (existing) {
        if (!improves(existing, childDepth, weight, candidate.edge.id)) continue;
        existing.weight = weight;
        existing.seedNodeId = state.seedNodeId;
        existing.parentNodeId = nodeId;
        existing.parentEdgeId = candidate.edge.id;
        existing.parentReverse = candidate.reverse;
        existing.focusMatched = state.focusMatched || isUnderFocusPath(neighbour.path ?? contextGraphPathFromId(neighbour.id), focusPaths);
        continue;
      }

      if (states.size >= maxVisitedNodes) {
        nodeCapHit = true;
        break;
      }
      states.set(candidate.neighbourId, {
        nodeId: candidate.neighbourId,
        depth: childDepth,
        weight,
        seedNodeId: state.seedNodeId,
        parentNodeId: nodeId,
        parentEdgeId: candidate.edge.id,
        parentReverse: candidate.reverse,
        focusMatched:
          state.focusMatched || isUnderFocusPath(neighbour.path ?? contextGraphPathFromId(neighbour.id), focusPaths)
      });
      queue.push(candidate.neighbourId);
    }

    if (timedOut || edgeCapHit || nodeCapHit) break;
  }

  return {
    states,
    visitedNodes: states.size,
    visitedEdges,
    nodeCapHit,
    edgeCapHit,
    depthLimited,
    timedOut
  };
}
