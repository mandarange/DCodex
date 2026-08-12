/**
 * Bounded TriWiki attention for official subagents.
 *
 * Anchors are now the answer to a Context Graph query: seeds resolved from the
 * goal, a profile-bounded traversal, deterministic ranking, and a token-packed
 * selection where every anchor carries a reason path and provenance back to a
 * repository path. The token-overlap scorer this module used to run is gone —
 * not renamed, not kept behind a flag, and not reachable from a catch handler.
 *
 * When the stored graph is missing, corrupt or stale the result is
 * `available: false` with the matching `context_graph_*` reason and the repair
 * command. A subagent preface that quietly degrades to text matching is worse
 * than one that says it has no anchors, because the caller cannot tell the
 * difference from the output.
 */
import { CONTEXT_GRAPH_REPAIR_COMMAND } from '../triwiki/context-graph/contracts.js'
import type { ContextGraphFreshness } from '../triwiki/context-graph/contracts.js'
import type { ContextGraphQueryProfileName } from '../triwiki/context-graph/profiles.js'
import {
  readContextGraphAttention,
  type ContextGraphAttentionOptions,
  type ContextGraphAttentionReason
} from '../triwiki/context-graph/projections/attention.js'
import type { ProjectedAttentionAnchor } from '../triwiki/context-graph/projections/anchors.js'
import { asRecordOrEmpty as asRecord } from '../json/records.js'

export const BOUNDED_TRIWIKI_ATTENTION_SCHEMA = 'sks.subagent-triwiki-attention.v1'
export const DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT = 8
export const MAX_TRIWIKI_ATTENTION_ANCHOR_LIMIT = 16
/** Anchors are a preface, not a briefing. */
export const DEFAULT_TRIWIKI_ATTENTION_TOKEN_BUDGET = 2000

export const TRIWIKI_ATTENTION_GRAPH_SOURCE = '.sneakoscope/wiki/context-graph.json'
export const TRIWIKI_ATTENTION_PACK_SOURCE = '.sneakoscope/wiki/context-pack.json'

export type BoundedTriwikiAttentionSource =
  | typeof TRIWIKI_ATTENTION_GRAPH_SOURCE
  | typeof TRIWIKI_ATTENTION_PACK_SOURCE

export interface BoundedTriwikiAttentionProvenance {
  path: string
  line?: number
  hash: string
}

export interface BoundedTriwikiAttentionAnchor {
  id: string
  claim_hash: string | null
  source_hash: string | null
  hydrate_hint: string | null
  /** Hop chain the query walked to reach this anchor; empty when it was declared, not traversed. */
  reason_path: string[]
  trust_score: number
  freshness: ContextGraphFreshness
  token_cost: number
  provenance: BoundedTriwikiAttentionProvenance[]
}

export interface BoundedTriwikiAttention {
  schema: typeof BOUNDED_TRIWIKI_ATTENTION_SCHEMA
  source: BoundedTriwikiAttentionSource
  available: boolean
  attention_mode: string | null
  anchor_limit: number
  anchors: BoundedTriwikiAttentionAnchor[]
  hydration_policy: 'on_demand_only'
  full_pack_injected: false
  /** Explicit unavailability reason; never a silent empty set. */
  reason: ContextGraphAttentionReason | null
  repair_command: typeof CONTEXT_GRAPH_REPAIR_COMMAND
  snapshot_hash: string | null
  snapshot_freshness: 'fresh' | 'stale' | null
  profile: ContextGraphQueryProfileName | null
  token_cost: number
  token_budget: number
}

export interface ReadBoundedTriwikiAttentionOptions extends ContextGraphAttentionOptions {
  /** `implementation` (default) for build work, `answer` for knowledge retrieval. */
  readonly profile?: ContextGraphQueryProfileName | undefined
  readonly tokenBudget?: number | undefined
  readonly risk?: 'normal' | 'high' | undefined
}

/**
 * Resolve bounded attention anchors for `root` from the Context Graph.
 *
 * The signature is unchanged; the selection mechanism is not. `query` is the
 * subagent goal and is used as the graph query, so relevance comes from the
 * repository's own structure rather than from words shared with an anchor id.
 */
export async function readBoundedTriwikiAttention(
  root: string,
  limit: number = DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT,
  query: string = '',
  options: ReadBoundedTriwikiAttentionOptions = {}
): Promise<BoundedTriwikiAttention> {
  const anchorLimit = normalizeLimit(limit)
  const tokenBudget = Math.max(0, options.tokenBudget ?? DEFAULT_TRIWIKI_ATTENTION_TOKEN_BUDGET)
  const result = await readContextGraphAttention(
    {
      root,
      query,
      limit: anchorLimit,
      profile: options.profile ?? 'implementation',
      tokenBudget,
      risk: options.risk
    },
    options
  )

  return {
    schema: BOUNDED_TRIWIKI_ATTENTION_SCHEMA,
    source: TRIWIKI_ATTENTION_GRAPH_SOURCE,
    available: result.available,
    attention_mode: result.available ? `context_graph:${result.profile}` : null,
    anchor_limit: anchorLimit,
    anchors: result.anchors.map(toAnchor),
    hydration_policy: 'on_demand_only',
    full_pack_injected: false,
    reason: result.reason,
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND,
    snapshot_hash: result.snapshotHash,
    snapshot_freshness: result.snapshotFreshness,
    profile: result.available ? result.profile : null,
    token_cost: result.tokenCost,
    token_budget: result.tokenBudget
  }
}

/**
 * Structural projection of an already-written context pack.
 *
 * This is *not* the production selection path — `readBoundedTriwikiAttention`
 * never calls it — and it does no ranking of its own: rows are taken in the order
 * the pack declares them, because the pack was itself built from the graph. Rows
 * may be legacy tuples or the enriched object form emitted by
 * `projectContextPackAnchors`, in which case reason path, provenance and token
 * cost are carried through.
 */
export function extractBoundedTriwikiAttention(
  value: unknown,
  limit: number = DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT,
  _retiredQueryHint?: unknown
): BoundedTriwikiAttention {
  const pack = asRecord(value)
  const attention = asRecord(pack.attention)
  const anchorLimit = normalizeLimit(limit)
  const hints = new Map<string, string>()

  for (const row of rowsOf(attention.hydrate_first)) {
    if (row.id && row.hydrate_hint) hints.set(row.id, row.hydrate_hint.slice(0, 240))
  }

  const anchors: BoundedTriwikiAttentionAnchor[] = []
  const seen = new Set<string>()
  for (const row of rowsOf(attention.use_first)) {
    if (anchors.length >= anchorLimit) break
    if (!row.id || seen.has(row.id)) continue
    seen.add(row.id)
    anchors.push({ ...row, hydrate_hint: row.hydrate_hint ?? hints.get(row.id) ?? null })
  }

  const tokenCost = anchors.reduce((sum, anchor) => sum + anchor.token_cost, 0)
  return {
    schema: BOUNDED_TRIWIKI_ATTENTION_SCHEMA,
    source: TRIWIKI_ATTENTION_PACK_SOURCE,
    available: anchors.length > 0,
    attention_mode: text(attention.mode) || null,
    anchor_limit: anchorLimit,
    anchors,
    hydration_policy: 'on_demand_only',
    full_pack_injected: false,
    reason: anchors.length > 0 ? null : 'context_graph_no_match',
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND,
    snapshot_hash: text(pack.snapshot_hash) || null,
    snapshot_freshness: null,
    profile: null,
    token_cost: tokenCost,
    token_budget: DEFAULT_TRIWIKI_ATTENTION_TOKEN_BUDGET
  }
}

function toAnchor(anchor: ProjectedAttentionAnchor): BoundedTriwikiAttentionAnchor {
  return {
    id: anchor.id,
    claim_hash: anchor.claim_hash,
    source_hash: anchor.source_hash,
    hydrate_hint: anchor.hydrate_hint,
    reason_path: anchor.reason_path,
    trust_score: anchor.trust_score,
    freshness: anchor.freshness,
    token_cost: anchor.token_cost,
    provenance: anchor.provenance.map((ref) => ({
      path: ref.path,
      ...(ref.line === undefined ? {} : { line: ref.line }),
      hash: ref.hash
    }))
  }
}

function rowsOf(value: unknown): BoundedTriwikiAttentionAnchor[] {
  if (!Array.isArray(value)) return []
  const out: BoundedTriwikiAttentionAnchor[] = []
  for (const raw of value) {
    const row = Array.isArray(raw) ? tupleRow(raw) : objectRow(raw)
    if (row) out.push(row)
  }
  return out
}

/** Legacy `[id, claim_hash, source_hash]` / `[id, hydrate_reason]` shapes. */
function tupleRow(row: readonly unknown[]): BoundedTriwikiAttentionAnchor | null {
  const id = text(row[0])
  if (!id) return null
  const second = text(row[1])
  const third = text(row[2])
  // A two-element row is a hydrate reason, not a claim hash; keeping them apart is
  // what stops a hydrate hint from being read as verified claim identity.
  const isHydrateRow = row.length <= 2
  return {
    id,
    claim_hash: isHydrateRow ? null : second || null,
    source_hash: isHydrateRow ? null : third || null,
    hydrate_hint: isHydrateRow ? second || null : null,
    reason_path: [],
    trust_score: 0,
    freshness: 'unknown',
    token_cost: 0,
    provenance: []
  }
}

/** Enriched object rows written by `projectContextPackAnchors`. */
function objectRow(raw: unknown): BoundedTriwikiAttentionAnchor | null {
  const row = asRecord(raw)
  const id = text(row.id)
  if (!id) return null
  return {
    id,
    claim_hash: text(row.claim_hash) || null,
    source_hash: text(row.source_hash) || null,
    hydrate_hint: text(row.hydrate_hint) || null,
    reason_path: Array.isArray(row.reason_path) ? row.reason_path.map(text).filter(Boolean) : [],
    trust_score: number(row.trust_score),
    freshness: freshnessOf(row.freshness),
    token_cost: Math.max(0, Math.trunc(number(row.token_cost))),
    provenance: provenanceOf(row.provenance)
  }
}

function provenanceOf(value: unknown): BoundedTriwikiAttentionProvenance[] {
  if (!Array.isArray(value)) return []
  const out: BoundedTriwikiAttentionProvenance[] = []
  for (const raw of value) {
    const ref = asRecord(raw)
    const refPath = text(ref.path)
    const hash = text(ref.hash)
    if (!refPath || !hash) continue
    const line = number(ref.line)
    out.push({ path: refPath, ...(line > 0 ? { line } : {}), hash })
  }
  return out
}

function freshnessOf(value: unknown): ContextGraphFreshness {
  return value === 'fresh' || value === 'stale' ? value : 'unknown'
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT
  return Math.max(1, Math.min(MAX_TRIWIKI_ATTENTION_ANCHOR_LIMIT, Math.floor(parsed)))
}

function number(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
