/**
 * Deterministic weighted scoring and redundancy suppression.
 *
 * The score is the sum named in the design:
 *   exact_seed_bonus + edge_profile_weight + trust_bonus + freshness_bonus
 *   + risk_relevance_bonus + evidence_coverage_bonus
 *   - stale_penalty - invalidated_penalty - redundancy_penalty - token_cost_penalty
 *
 * There is no embedding, no vector store, no learned reranker and no PageRank:
 * every term is a lookup on data the compiler already grounded in repository
 * truth, so the same snapshot always produces the same order. Ties break on the
 * stable node id through the one shared comparator.
 */
import type { ContextGraphNode } from '../contracts.js';
import type { ContextGraphIndex } from '../graph-index.js';
import { compareContextGraphIds, contextGraphPathFromId } from '../ids.js';
import type { ContextGraphQueryRequest, ContextGraphSeed } from '../query-types.js';
import { isExactContextGraphSeedConfidence, type ContextGraphRankingConfig } from './ranking-config.js';
import type { ContextGraphTraversalState } from './traverse.js';

export interface ContextGraphRankedCandidate {
  readonly node: ContextGraphNode;
  readonly state: ContextGraphTraversalState;
  readonly seed: ContextGraphSeed | null;
  readonly exactSeed: boolean;
  readonly groupKey: string;
  readonly tokenCost: number;
  readonly evidenceSources: number;
  score: number;
  redundancyPenalty: number;
}

export interface ContextGraphRankResult {
  readonly candidates: ContextGraphRankedCandidate[];
  readonly staleExcluded: number;
  readonly invalidatedExcluded: number;
  readonly redundantExcluded: number;
  readonly focusExcluded: number;
  /** Node ids excluded for staleness or invalidation, so the caller can explain the omission. */
  readonly excludedNodeIds: string[];
}

export interface RankContextGraphInput {
  readonly index: ContextGraphIndex;
  readonly states: ReadonlyMap<string, ContextGraphTraversalState>;
  readonly seedsByNode: ReadonlyMap<string, ContextGraphSeed>;
  readonly request: ContextGraphQueryRequest;
  readonly config: ContextGraphRankingConfig;
  readonly focusActive: boolean;
}

export function contextGraphGroupKey(node: ContextGraphNode): string {
  const nodePath = node.path ?? contextGraphPathFromId(node.id);
  if (nodePath) {
    const cut = nodePath.lastIndexOf('/');
    return cut > 0 ? nodePath.slice(0, cut) : '.';
  }
  const module = node.metadata.module;
  if (typeof module === 'string' && module) return `module/${module}`;
  return `kind/${node.kind}`;
}

/**
 * A proof is invalidated when the evidence extractor recorded it as unusable, or
 * when the node is the source of an `invalidates` relation. Such a node is never
 * selected; it is counted and explained instead.
 */
export function isInvalidatedContextGraphNode(index: ContextGraphIndex, node: ContextGraphNode): boolean {
  const metadata = node.metadata;
  if (node.kind === 'proof') {
    if (metadata.reusable === false) return true;
    if (metadata.corrupt === true) return true;
    if (metadata.expired === true) return true;
    const reasons = metadata.invalidation_reason_count;
    if (typeof reasons === 'number' && reasons > 0) return true;
  }
  for (const edgeId of index.outgoing.get(node.id) ?? []) {
    if (index.edgesById.get(edgeId)?.type === 'invalidates') return true;
  }
  return false;
}

/** Grounding records available without building the full provenance list yet. */
function evidenceSourceCount(index: ContextGraphIndex, node: ContextGraphNode, state: ContextGraphTraversalState): number {
  let count = 0;
  if (node.path && node.contentHash) count += 1;
  if (state.parentEdgeId) count += 1;
  if ((index.outgoing.get(node.id)?.length ?? 0) > 0 || (index.incoming.get(node.id)?.length ?? 0) > 0) count += 1;
  return count;
}

/** High risk is declared by the caller or implied by a protected node already in scope. */
export function isHighRiskScope(
  index: ContextGraphIndex,
  seeds: readonly ContextGraphSeed[],
  request: ContextGraphQueryRequest
): boolean {
  if (request.risk === 'high') return true;
  for (const seed of seeds) {
    if (index.nodesById.get(seed.nodeId)?.risk === 'protected') return true;
  }
  return false;
}

function baseScore(
  node: ContextGraphNode,
  state: ContextGraphTraversalState,
  seed: ContextGraphSeed | null,
  input: RankContextGraphInput,
  invalidated: boolean,
  tokenCost: number,
  evidence: number
): number {
  const config = input.config;
  const exact = seed !== null && isExactContextGraphSeedConfidence(seed.confidence);
  const seedBonus = seed === null ? 0 : exact ? config.exactSeedBonus : config.lexicalSeedBonus;
  const riskScale = input.request.risk === 'high' ? config.highRiskRelevanceMultiplier : 1;
  const evidenceBonus = Math.min(config.evidenceCoverageCap, config.evidenceCoverageBonus * evidence);
  const stalePenalty = node.freshness === 'stale' ? config.stalePenalty : 0;
  const invalidatedPenalty = invalidated ? config.invalidatedPenalty : 0;
  const tokenPenalty = Math.min(config.tokenCostPenaltyCap, config.tokenCostPenaltyPerToken * tokenCost);
  return (
    seedBonus
    + state.weight
    + config.trustBonus * node.trust
    + config.freshnessBonus[node.freshness]
    + config.riskRelevanceBonus[node.risk] * riskScale
    + evidenceBonus
    - stalePenalty
    - invalidatedPenalty
    - tokenPenalty
  );
}

function byScoreThenId(left: ContextGraphRankedCandidate, right: ContextGraphRankedCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  return compareContextGraphIds(left.node.id, right.node.id);
}

export function rankContextGraphCandidates(input: RankContextGraphInput): ContextGraphRankResult {
  const { index, states, seedsByNode, config, focusActive } = input;
  const candidates: ContextGraphRankedCandidate[] = [];
  const excludedNodeIds: string[] = [];
  let staleExcluded = 0;
  let invalidatedExcluded = 0;
  let focusExcluded = 0;

  for (const state of states.values()) {
    const node = index.nodesById.get(state.nodeId);
    if (!node) continue;
    if (focusActive && !state.focusMatched) {
      focusExcluded += 1;
      continue;
    }
    // Staleness and invalidation are hard exclusions rather than soft penalties:
    // the penalty terms stay in the formula, but a node that trips either one is
    // counted and reported instead of being ranked down and quietly surviving.
    const invalidated = isInvalidatedContextGraphNode(index, node);
    if (node.freshness === 'stale') {
      staleExcluded += 1;
      excludedNodeIds.push(node.id);
      continue;
    }
    if (invalidated) {
      invalidatedExcluded += 1;
      excludedNodeIds.push(node.id);
      continue;
    }
    const seed = seedsByNode.get(state.nodeId) ?? null;
    const tokenCost = Math.max(config.minTokenCost, node.tokenCost);
    const evidence = evidenceSourceCount(index, node, state);
    candidates.push({
      node,
      state,
      seed,
      exactSeed: seed !== null && isExactContextGraphSeedConfidence(seed.confidence),
      groupKey: contextGraphGroupKey(node),
      tokenCost,
      evidenceSources: evidence,
      score: baseScore(node, state, seed, input, invalidated, tokenCost, evidence),
      redundancyPenalty: 0
    });
  }

  candidates.sort(byScoreThenId);

  const perGroup = new Map<string, number>();
  const kept: ContextGraphRankedCandidate[] = [];
  let redundantExcluded = 0;
  for (const candidate of candidates) {
    const prior = perGroup.get(candidate.groupKey) ?? 0;
    if (prior >= config.maxRedundancyGroupMembers && !candidate.exactSeed) {
      redundantExcluded += 1;
      continue;
    }
    perGroup.set(candidate.groupKey, prior + 1);
    const penalty = Math.min(config.redundancyPenaltyCap, config.redundancyPenalty * prior);
    candidate.redundancyPenalty = penalty;
    candidate.score -= penalty;
    kept.push(candidate);
  }
  kept.sort(byScoreThenId);

  return {
    candidates: kept,
    staleExcluded,
    invalidatedExcluded,
    redundantExcluded,
    focusExcluded,
    excludedNodeIds: excludedNodeIds.sort(compareContextGraphIds)
  };
}
