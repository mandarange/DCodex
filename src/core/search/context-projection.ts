/**
 * `SearchResponse` projection for the graph-backed `context` mode (CG2-13).
 *
 * Split out of `context.ts` so that file can shrink while gaining the CRK2 call
 * sequence: this module knows what an answer *looks like* to a caller, that one
 * knows how to get one. The split is also where the migration's only public
 * behaviour change lives, and it is worth stating where a reader will find it.
 *
 * ## Confidence is now the kernel's claim, not a re-reading of the last hop
 *
 * v1 derived a match's confidence by inspecting the final explanation step: a
 * `defines` hop produced `exact_definition`, an `exact`/`manifest` hop produced
 * `exact_reference`. That labelled a *traversed neighbour* with the confidence of
 * the edge that reached it, which ADR §4 says is wrong — a neighbour of an exact
 * seed is a candidate, not an exact match, and only the anchor lane may claim
 * exactness at all. The kernel already computes this correctly and demotes by hop
 * count, so the projection reports `seedConfidence` rather than re-deriving a
 * weaker rule from the hop. Nodes reached by traversal therefore read as
 * `syntactic_reference` / `text_candidate` where v1 said `exact_*`.
 *
 * `graph_relation` and `graph_relation_confidence` still carry the last hop, so
 * nothing that was visible before has been removed — it stopped being laundered
 * into the match's own confidence.
 */
import { compareContextGraphIds } from '../triwiki/context-graph/ids.js';
import type {
  ContextGraphSeedConfidence,
  ContextGraphSelectedNode
} from '../triwiki/context-graph/query-types.js';
import type {
  ContextKernelResult,
  HydratedNode,
  HydrationResult
} from '../triwiki/context-graph/query/index.js';
import {
  compareMatches,
  type SearchConfidence,
  type SearchContextGraphMeta,
  type SearchMatch
} from './types.js';

/** Graph node kinds whose content is curated evidence rather than resolved code. */
const EVIDENCE_KINDS: ReadonlySet<string> = new Set(['wiki_claim', 'proof', 'source', 'risk_domain']);

/** A seed's confidence maps straight through; `manifest` is a declared, exact relation. */
const SEED_CONFIDENCE: Readonly<Record<ContextGraphSeedConfidence, SearchConfidence>> = {
  exact_definition: 'exact_definition',
  exact_reference: 'exact_reference',
  manifest: 'exact_reference',
  syntactic_reference: 'syntactic_reference',
  file_path: 'file_path',
  text_candidate: 'text_candidate'
};

/**
 * Per-node confidence. Evidence nodes are context; everything else carries the
 * claim the kernel's lane assignment already made for it (ADR §4).
 */
export function matchConfidence(node: HydratedNode): SearchConfidence {
  if (EVIDENCE_KINDS.has(node.kind)) return 'context_pack';
  return SEED_CONFIDENCE[node.seedConfidence] ?? 'context_pack';
}

/** Nodes whose provenance was found on disk, by node id. Empty when nothing was verified. */
export type GroundedNodes = ReadonlySet<string>;

export function projectMatches(
  nodes: readonly HydratedNode[],
  snapshotHash: string,
  profile: string,
  grounded: GroundedNodes
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const node of nodes) {
    const last = node.explanation[node.explanation.length - 1];
    matches.push({
      path: node.path ?? node.provenance[0]?.path ?? '',
      ...(node.line === undefined ? {} : { line: node.line }),
      ...(node.kind === 'symbol' ? { symbol: node.label } : {}),
      confidence: matchConfidence(node),
      meta: {
        node_id: node.nodeId,
        node_kind: node.kind,
        label: node.label,
        graph_relation: last ? last.type : 'seed',
        graph_relation_confidence: last ? last.confidence : 'seed',
        reason_path: [...node.reasonPath],
        explanation_steps: node.explanation.length,
        depth: node.depth,
        // The kernel scores in `bigint` so ordering cannot depend on float
        // rounding. The published field has always been a `number`, and the
        // response is JSON — a `bigint` here would throw on serialization.
        score: Number(node.score),
        trust: node.trust,
        freshness: node.freshness,
        risk: node.risk,
        token_cost: node.tokenCost,
        seed: node.seed,
        // Only a seed carries one, which is the v1 rule: a traversed node's
        // confidence is the match's own field, not a claim about a seed.
        ...(node.seed ? { seed_confidence: node.seedConfidence } : {}),
        provenance: node.provenance.map((ref) => ({
          path: ref.path,
          ...(ref.line === undefined ? {} : { line: ref.line }),
          hash: ref.hash
        })),
        provenance_resolved: grounded.has(node.nodeId),
        // §7 made `hydrated` ambiguous across versions; this says which claim
        // the row is making instead of leaving a caller to guess.
        grounding: node.grounding,
        snapshot_hash: snapshotHash,
        profile
      }
    });
  }
  // `path_line_column` first, then the stable node id, so two nodes sharing a
  // location still land in one order across processes.
  matches.sort((left, right) => {
    const byLocation = compareMatches(left, right);
    if (byLocation !== 0) return byLocation;
    return compareContextGraphIds(String(left.meta?.node_id ?? ''), String(right.meta?.node_id ?? ''));
  });
  return matches;
}

export function overallConfidence(matches: readonly SearchMatch[]): SearchConfidence | 'mixed' {
  const distinct = new Set(matches.map((match) => match.confidence));
  if (distinct.size === 0) return 'context_pack';
  if (distinct.size === 1) {
    const only = [...distinct][0];
    if (only) return only;
  }
  return 'mixed';
}

/**
 * Counts the seeding lanes admitted, which is what `seedCount` has always meant:
 * how many nodes the query resolved before the walk, not how many survived it.
 * The `local_graph` lane is the walk itself and is excluded by name rather than
 * by position, so reordering `kernel.lanes` cannot silently change the number.
 */
function seedCountOf(kernel: ContextKernelResult): number {
  let seeds = 0;
  for (const lane of kernel.lanes) {
    if (lane.lane !== 'local_graph') seeds += lane.candidates;
  }
  return seeds;
}

/** Positive counts only: absence means none, and a zero would read as a measured zero. */
export function omissionReasonsOf(kernel: ContextKernelResult, hydration: HydrationResult): Record<string, number> {
  const out: Record<string, number> = {};
  for (const source of [kernel.omissions, hydration.omissions]) {
    for (const [reason, count] of Object.entries(source)) {
      if (typeof count === 'number' && count > 0) out[reason] = (out[reason] ?? 0) + count;
    }
  }
  return out;
}

export interface GraphMetaInput {
  readonly kernel: ContextKernelResult;
  readonly hydration: HydrationResult;
  readonly snapshotHash: string;
}

/** Additive projection for `SearchResponse.context.graph`; carries no path outside the workspace. */
export function contextGraphMetaOf(input: GraphMetaInput): SearchContextGraphMeta {
  const { kernel, hydration } = input;
  return {
    snapshotHash: input.snapshotHash,
    // An index that is not fresh does not open at all, so a served answer is
    // always fresh. The field stays because callers read it.
    snapshotFreshness: 'fresh',
    profile: kernel.plan.profile,
    seedCount: seedCountOf(kernel),
    visitedNodes: kernel.visitedNodes,
    selectedNodes: hydration.nodes.length,
    explanationPathCount: hydration.explanationPathCount,
    provenanceCoverage: hydration.provenanceCoverage,
    staleExcluded: kernel.omissions.stale_node ?? 0,
    invalidatedExcluded: kernel.omissions.invalidated_proof ?? 0,
    tokenCost: kernel.tokenCost,
    tokenBudget: kernel.plan.tokenBudget,
    omissionReasons: omissionReasonsOf(kernel, hydration)
  };
}

export function emptyGraphMeta(
  snapshotHash: string,
  profile: string,
  tokenBudget: number
): SearchContextGraphMeta {
  return {
    snapshotHash,
    snapshotFreshness: 'stale',
    profile,
    seedCount: 0,
    visitedNodes: 0,
    selectedNodes: 0,
    explanationPathCount: 0,
    provenanceCoverage: 0,
    staleExcluded: 0,
    invalidatedExcluded: 0,
    tokenCost: 0,
    tokenBudget,
    omissionReasons: {}
  };
}

/** Content hash the top answer was read from, straight out of the index — no file is re-read. */
export function firstProvenanceHash(match: SearchMatch | undefined): string | null {
  const provenance = (match?.meta as { provenance?: Array<{ hash?: unknown }> } | undefined)?.provenance;
  const hash = provenance?.[0]?.hash;
  return typeof hash === 'string' && hash ? hash : null;
}

/** Retained so the v1 selected-node type stays referenced by exactly one module. */
export type LegacySelectedNode = ContextGraphSelectedNode;
