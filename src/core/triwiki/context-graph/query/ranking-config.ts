/**
 * The single tuning surface for Context Graph retrieval.
 *
 * Every bonus, penalty, decay, cap and packing constant the query engine uses
 * lives here. No other file under `query/` is allowed to write a tuning number:
 * the bounded optimizer is only permitted to edit this file and `profiles.ts`,
 * so a weight copied into a call site would be invisible to it and would drift.
 *
 * `v1` is a machine schema revision for the tuning surface, not a product
 * version recommendation.
 */
import type {
  ContextGraphEdgeConfidence,
  ContextGraphFreshness,
  ContextGraphRisk
} from '../contracts.js';
import type { ContextGraphSeedConfidence } from '../query-types.js';
import { CONTEXT_LEXICON_SCHEMA, type ContextLexiconConfig } from '../runtime-index/lexicon.js';

export const CONTEXT_GRAPH_RANKING_SCHEMA = 'sks.context-graph-ranking.v1' as const;

/**
 * Seed confidences that count as an *exact* reference. A text hit never appears
 * here, which is what keeps a lexical candidate from being reported as exact.
 */
export const CONTEXT_GRAPH_EXACT_SEED_CONFIDENCES: readonly ContextGraphSeedConfidence[] = [
  'exact_definition',
  'exact_reference',
  'manifest',
  'file_path'
];

export interface ContextGraphRankingConfig {
  readonly schema: typeof CONTEXT_GRAPH_RANKING_SCHEMA;

  /** Base score a seed contributes, by how it was resolved. */
  readonly seedConfidenceScore: Readonly<Record<ContextGraphSeedConfidence, number>>;
  /** Flat bonus added to a node that entered as an exact seed. */
  readonly exactSeedBonus: number;
  /** Flat bonus added to a node that entered as a lexical (text) seed. */
  readonly lexicalSeedBonus: number;
  /** Upper bound applied to a caller-supplied `seed.score`, so an outside caller cannot dominate ranking. */
  readonly providedSeedScoreCeiling: number;

  /** Multiplier applied to a profile edge weight, by how the relation was observed. */
  readonly edgeConfidenceMultiplier: Readonly<Record<ContextGraphEdgeConfidence, number>>;
  /** Per-hop decay applied to accumulated edge weight. */
  readonly depthDecay: number;
  /** Reverse (incoming) hops are worth this fraction of a forward hop. */
  readonly reverseEdgeMultiplier: number;

  readonly trustBonus: number;
  readonly freshnessBonus: Readonly<Record<ContextGraphFreshness, number>>;
  readonly riskRelevanceBonus: Readonly<Record<ContextGraphRisk, number>>;
  /** Applied to `riskRelevanceBonus` when the request is high risk. */
  readonly highRiskRelevanceMultiplier: number;

  /** Bonus per distinct provenance record, capped by `evidenceCoverageCap`. */
  readonly evidenceCoverageBonus: number;
  readonly evidenceCoverageCap: number;

  readonly stalePenalty: number;
  readonly invalidatedPenalty: number;
  /** Penalty per prior sibling already ranked in the same structural group. */
  readonly redundancyPenalty: number;
  readonly redundancyPenaltyCap: number;
  readonly tokenCostPenaltyPerToken: number;
  readonly tokenCostPenaltyCap: number;

  /** Exact seeds required before lexical seeding is even attempted. */
  readonly minExactSeeds: number;
  readonly maxLexicalSeeds: number;
  /** Hard ceiling on label/path keys inspected during lexical seeding. */
  readonly lexicalScanBudget: number;
  readonly lexicalMinTokenLength: number;
  readonly lexicalMatchScore: number;
  readonly maxQueryTokens: number;
  readonly maxSeedsPerToken: number;

  /** Edges examined between two wall-clock deadline checks. */
  readonly timeoutCheckInterval: number;

  /** Fraction of the selection any single structural group may occupy. */
  readonly moduleShareCap: number;
  /** Floor for the per-group slot allowance, so a tiny budget is not fully serialized. */
  readonly minGroupSlots: number;
  /** Candidates kept per structural group before ranking drops the rest as redundant. */
  readonly maxRedundancyGroupMembers: number;
  /** Protected gates reserved before the greedy fill on a high-risk query. */
  readonly protectedGateReserveSlots: number;
  /** Test/gate nodes reserved before the greedy fill on an implementation query. */
  readonly testOrGateReserveSlots: number;
  readonly maxProvenancePerNode: number;
  /** Floor charged for a node whose extractor recorded no token cost. */
  readonly minTokenCost: number;
}

export const CONTEXT_GRAPH_RANKING_CONFIG: ContextGraphRankingConfig = {
  schema: CONTEXT_GRAPH_RANKING_SCHEMA,

  seedConfidenceScore: {
    exact_definition: 6,
    exact_reference: 5,
    manifest: 5,
    syntactic_reference: 3.5,
    file_path: 4,
    text_candidate: 1.5
  },
  exactSeedBonus: 4,
  lexicalSeedBonus: 0.5,
  providedSeedScoreCeiling: 8,

  edgeConfidenceMultiplier: {
    exact: 1,
    manifest: 0.95,
    syntactic: 0.85,
    observed: 0.7,
    derived: 0.5
  },
  depthDecay: 0.6,
  reverseEdgeMultiplier: 0.85,

  trustBonus: 1.5,
  freshnessBonus: { fresh: 0.75, unknown: 0, stale: -0.5 },
  riskRelevanceBonus: { low: 0, medium: 0.25, high: 0.75, protected: 1.5 },
  highRiskRelevanceMultiplier: 2,

  evidenceCoverageBonus: 0.35,
  evidenceCoverageCap: 1.05,

  stalePenalty: 2.5,
  invalidatedPenalty: 4,
  redundancyPenalty: 0.6,
  redundancyPenaltyCap: 3,
  tokenCostPenaltyPerToken: 0.0015,
  tokenCostPenaltyCap: 1.5,

  minExactSeeds: 3,
  maxLexicalSeeds: 8,
  lexicalScanBudget: 50000,
  lexicalMinTokenLength: 4,
  lexicalMatchScore: 1.5,
  maxQueryTokens: 24,
  maxSeedsPerToken: 6,

  timeoutCheckInterval: 512,

  moduleShareCap: 0.4,
  minGroupSlots: 2,
  maxRedundancyGroupMembers: 12,
  protectedGateReserveSlots: 8,
  testOrGateReserveSlots: 1,
  maxProvenancePerNode: 6,
  minTokenCost: 1
};

/**
 * BM25F tuning for the identifier-aware lexicon.
 *
 * These numbers live here rather than beside the tokenizer for the reason
 * stated at the top of this file: the bounded optimizer may only edit this file
 * and `profiles.ts`, so a retrieval weight defined anywhere else is a weight
 * that can never be tuned. The tokenizer owns the *type* and takes the config
 * as an argument; the import below is type-only, so `runtime-index` keeps no
 * runtime dependency on `query`.
 *
 * Weights follow §6.2 of the work order. Identifier-shaped fields get a low `b`
 * because a label is not less relevant for being long; prose fields get 0.75.
 */
export const CONTEXT_GRAPH_LEXICON_CONFIG: ContextLexiconConfig = Object.freeze({
  schema: CONTEXT_LEXICON_SCHEMA,
  fields: Object.freeze([
    // CANONICAL_ID is deliberately not lexical: §4 of the frozen contract gives
    // exact confidence to the anchor lane only, and a canonical id reachable by
    // a fuzzy word overlap is precisely that violation. Weight 0 makes it
    // structurally unreachable rather than merely discouraged.
    { weight: 0, lengthNormalization: 0, lexical: false, keepWholeValue: false, pathLike: false },
    { weight: 4, lengthNormalization: 0.3, lexical: true, keepWholeValue: true, pathLike: false },
    { weight: 3, lengthNormalization: 0.3, lexical: true, keepWholeValue: false, pathLike: false },
    { weight: 4, lengthNormalization: 0.3, lexical: true, keepWholeValue: true, pathLike: false },
    { weight: 3, lengthNormalization: 0.3, lexical: true, keepWholeValue: true, pathLike: true },
    { weight: 2, lengthNormalization: 0.4, lexical: true, keepWholeValue: false, pathLike: true },
    { weight: 1.2, lengthNormalization: 0.75, lexical: true, keepWholeValue: false, pathLike: false },
    { weight: 1, lengthNormalization: 0.75, lexical: true, keepWholeValue: false, pathLike: false },
    { weight: 0.8, lengthNormalization: 0.5, lexical: true, keepWholeValue: false, pathLike: false }
  ]),
  k1: 1.2,

  minSegmentLength: 2,
  minAcronymLength: 2,
  maxAcronymSegments: 8,
  maxExtensionLength: 5,
  maxTokenLength: 64,
  maxTokensPerField: 512,
  preserveExactCase: true,

  cjkNgramSizes: Object.freeze([2, 3]),
  maxCjkRunLength: 8,
  maxCjkNgramsPerRun: 64,

  minSecretTokenLength: 20,
  minHexSecretLength: 32,

  postingCapPerTerm: 4_096,
  maxTerms: 1 << 20,
  maxQueryTerms: 64
});

const EXACT_SEED_CONFIDENCE_SET: ReadonlySet<string> = new Set<string>(CONTEXT_GRAPH_EXACT_SEED_CONFIDENCES);

/** True when a seed confidence denotes a real reference rather than a text guess. */
export function isExactContextGraphSeedConfidence(value: ContextGraphSeedConfidence): boolean {
  return EXACT_SEED_CONFIDENCE_SET.has(value);
}

export function contextGraphSeedConfidenceScore(
  config: ContextGraphRankingConfig,
  confidence: ContextGraphSeedConfidence
): number {
  return config.seedConfidenceScore[confidence];
}
