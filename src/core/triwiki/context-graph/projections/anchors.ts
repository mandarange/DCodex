/**
 * Attention anchors as a projection of the graph.
 *
 * An anchor is a graph node plus the evidence needed to decide whether it may be
 * used as a fact right now: how the query reached it (`reason_path`), where the
 * claim comes from (`provenance`), what it costs to hold (`token_cost`), and how
 * much it can be trusted before its source is hydrated. The trust rule is
 * preserved from the pre-graph attention contract: an anchor
 * that is not both fresh and above the trust floor keeps no identity hashes and
 * carries an explicit hydrate hint, so a consumer cannot mistake a low-trust
 * summary for a verified fact before opening the cited source.
 *
 * Anchoring is exact-only against the compact index (CG2-13), which means
 * `code:<module-label>` no longer resolves — see `graph-facts.ts` for why that is
 * reported rather than guessed at.
 */
import type { ContextGraphFreshness } from '../contracts.js';
import type { ContextGraphProvenanceRef } from '../query-types.js';
import {
  CONTEXT_GRAPH_RANKING_CONFIG,
  type ContextGraphNodeView,
  type ContextIndexReader,
  type HydratedNode,
  type HydrationCursor
} from '../query/index.js';
import { contextGroundedProvenance } from './graph-facts.js';

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

/** Graph facts only: cited paths plus why the anchor is not fact-grade. No prompt text. */
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
  contentHash: string | undefined,
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
    claim_hash: factGrade ? contentHash ?? firstHash : null,
    source_hash: factGrade ? firstHash : null,
    hydrate_hint: attentionHydrateHint(provenance, trust, freshness, risk, factGrade),
    reason_path: reasonPath,
    trust_score: Number(trust.toFixed(2)),
    freshness,
    token_cost: Math.max(0, Math.trunc(tokenCost)),
    provenance
  };
}

/** Kernel-hydrated selection -> anchors. Order is the kernel's; no second opinion here. */
export function projectContextGraphAnchors(
  cursor: HydrationCursor,
  selected: readonly HydratedNode[],
  limit: number
): ProjectedAttentionAnchor[] {
  const anchors: ProjectedAttentionAnchor[] = [];
  const seen = new Set<string>();
  for (const node of selected) {
    if (anchors.length >= limit) break;
    if (seen.has(node.nodeId) || node.provenance.length === 0) continue;
    seen.add(node.nodeId);
    const contentHash = cursor.node(node.node)?.contentHash;
    const reasonPath = [...node.reasonPath];
    const provenance = [...node.provenance];
    anchors.push(anchorOf(node.nodeId, contentHash, node.trust, node.freshness, node.risk, node.tokenCost, reasonPath, provenance));
  }
  return anchors;
}

/**
 * Resolve a context-pack anchor id back to the node it names. Exact only: a
 * canonical node id, bare or under the historical `code:` prefix.
 */
export function resolveContextGraphAnchorNode(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  anchorId: string
): ContextGraphNodeView | null {
  const direct = firstExact(reader, cursor, anchorId);
  if (direct) return direct;
  if (!anchorId.startsWith('code:')) return null;
  return firstExact(reader, cursor, anchorId.slice('code:'.length));
}

function firstExact(reader: ContextIndexReader, cursor: HydrationCursor, term: string): ContextGraphNodeView | null {
  if (!term) return null;
  const postings = reader.exact(term);
  return postings.length === 0 ? null : cursor.node(postings.node(0));
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
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  anchors: readonly ContextPackAnchorInput[]
): ProjectedAttentionAnchor[] {
  const limit = Math.max(1, CONTEXT_GRAPH_RANKING_CONFIG.maxProvenancePerNode);
  const out: ProjectedAttentionAnchor[] = [];
  for (const anchor of anchors) {
    const node = resolveContextGraphAnchorNode(reader, cursor, anchor.id);
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
    const provenance = contextGroundedProvenance(reader, cursor, node, limit);
    out.push(anchorOf(anchor.id, node.contentHash, node.trust, node.freshness, node.risk, node.tokenCost, [node.id], provenance));
  }
  return out;
}
