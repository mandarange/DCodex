/**
 * Attention anchors as a projection of the graph.
 *
 * An anchor is a graph node plus the evidence needed to decide whether it may be
 * used as a fact right now: how the query reached it (`reason_path`), where the
 * claim comes from (`provenance`), what it costs to hold (`token_cost`), and how
 * much it can be trusted before its source is hydrated.
 *
 * The trust rule is preserved from the pre-graph attention contract: an anchor
 * that is not both fresh and above the trust floor keeps no identity hashes and
 * carries an explicit hydrate hint, so a consumer cannot mistake a low-trust
 * summary for a verified fact before opening the cited source.
 */
import type { ContextGraphFreshness, ContextGraphNode } from '../contracts.js';
import type { ContextGraphIndex } from '../graph-index.js';
import type { ContextGraphProvenanceRef, ContextGraphSelectedNode } from '../query-types.js';
import { CONTEXT_GRAPH_RANKING_CONFIG, groundContextGraphNode } from '../query/index.js';

/** Below this, or when the source is not verified fresh, an anchor is hydrate-only. */
export const ATTENTION_FACT_TRUST_FLOOR = 0.6;
const MAX_HINT_LENGTH = 240;
const MAX_HINT_CITATIONS = 4;

export interface ProjectedAttentionAnchor {
  id: string;
  claim_hash: string | null;
  source_hash: string | null;
  hydrate_hint: string | null;
  reason_path: string[];
  trust_score: number;
  freshness: ContextGraphFreshness;
  token_cost: number;
  provenance: ContextGraphProvenanceRef[];
}

export function isFactGradeAnchor(trust: number, freshness: ContextGraphFreshness): boolean {
  return freshness === 'fresh' && trust >= ATTENTION_FACT_TRUST_FLOOR;
}

/**
 * Hint text is assembled only from graph facts: cited workspace-relative paths
 * plus the reasons the anchor is not fact-grade. No prompt text, no tool output.
 */
export function attentionHydrateHint(
  provenance: readonly ContextGraphProvenanceRef[],
  trust: number,
  freshness: ContextGraphFreshness,
  risk: string,
  factGrade: boolean
): string | null {
  const reasons: string[] = [];
  if (!factGrade) reasons.push('trust_action:hydrate_first');
  if (freshness !== 'fresh') reasons.push(`freshness:${freshness}`);
  if (risk === 'protected' || risk === 'high') reasons.push(`risk:${risk}`);
  if (trust < ATTENTION_FACT_TRUST_FLOOR) reasons.push(`trust:${trust.toFixed(2)}`);
  const paths = [...new Set(provenance.map((ref) => ref.path).filter(Boolean))].slice(0, MAX_HINT_CITATIONS);
  if (paths.length > 0) reasons.push(`code_citations:${paths.join(',')}`);
  const hint = reasons.join(';');
  return hint ? hint.slice(0, MAX_HINT_LENGTH) : null;
}

function anchorOf(
  id: string,
  node: ContextGraphNode | undefined,
  trust: number,
  freshness: ContextGraphFreshness,
  risk: string,
  tokenCost: number,
  reasonPath: string[],
  provenance: ContextGraphProvenanceRef[]
): ProjectedAttentionAnchor {
  const factGrade = isFactGradeAnchor(trust, freshness);
  const firstHash = provenance[0]?.hash ?? null;
  return {
    id,
    claim_hash: factGrade ? node?.contentHash ?? firstHash : null,
    source_hash: factGrade ? firstHash : null,
    hydrate_hint: attentionHydrateHint(provenance, trust, freshness, risk, factGrade),
    reason_path: reasonPath,
    trust_score: Number(trust.toFixed(2)),
    freshness,
    token_cost: Math.max(0, Math.trunc(tokenCost)),
    provenance
  };
}

/**
 * Project the query engine's selection into attention anchors. Selection order is
 * the query's ranking; this adds no second opinion about relevance.
 */
export function projectContextGraphAnchors(
  index: ContextGraphIndex,
  selected: readonly ContextGraphSelectedNode[],
  limit: number
): ProjectedAttentionAnchor[] {
  const anchors: ProjectedAttentionAnchor[] = [];
  const seen = new Set<string>();
  for (const node of selected) {
    if (anchors.length >= limit) break;
    if (seen.has(node.nodeId) || node.provenance.length === 0) continue;
    seen.add(node.nodeId);
    anchors.push(
      anchorOf(
        node.nodeId,
        index.nodesById.get(node.nodeId),
        node.trust,
        node.freshness,
        node.risk,
        node.tokenCost,
        [...node.reasonPath],
        [...node.provenance]
      )
    );
  }
  return anchors;
}

/**
 * Resolve a context-pack anchor id back to the node it names. Code pack entries
 * are `code:<module-label>` or `code:<node-id>`; wiki anchors are already node ids.
 */
export function resolveContextGraphAnchorNode(index: ContextGraphIndex, anchorId: string): ContextGraphNode | null {
  const direct = index.nodesById.get(anchorId);
  if (direct) return direct;
  if (!anchorId.startsWith('code:')) return null;
  const rest = anchorId.slice('code:'.length);
  const byId = index.nodesById.get(rest);
  if (byId) return byId;
  for (const candidate of index.nodesByLabel.get(rest.toLowerCase()) ?? []) {
    const node = index.nodesById.get(candidate);
    if (node?.kind === 'module') return node;
  }
  return null;
}

export interface ContextPackAnchorInput {
  readonly id: string;
  readonly claim_hash?: string | null;
  readonly source_hash?: string | null;
  readonly hydrate_hint?: string | null;
}

/**
 * Enrich context-pack anchors with graph facts. An anchor the graph cannot
 * resolve keeps its declared fields and reports no provenance rather than
 * borrowing someone else's — an unresolvable anchor is never fact-grade.
 */
export function projectContextPackAnchors(
  index: ContextGraphIndex,
  anchors: readonly ContextPackAnchorInput[]
): ProjectedAttentionAnchor[] {
  const out: ProjectedAttentionAnchor[] = [];
  for (const anchor of anchors) {
    const node = resolveContextGraphAnchorNode(index, anchor.id);
    if (!node) {
      out.push({
        id: anchor.id,
        claim_hash: null,
        source_hash: null,
        hydrate_hint: anchor.hydrate_hint ?? 'trust_action:hydrate_first;graph:unresolved_anchor',
        reason_path: [],
        trust_score: 0,
        freshness: 'unknown',
        token_cost: 0,
        provenance: []
      });
      continue;
    }
    const provenance = groundContextGraphNode(index, node, [], CONTEXT_GRAPH_RANKING_CONFIG);
    out.push(
      anchorOf(anchor.id, node, node.trust, node.freshness, node.risk, node.tokenCost, [node.id], provenance)
    );
  }
  return out;
}
