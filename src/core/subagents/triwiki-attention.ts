import path from 'node:path'
import { readJson } from '../fsx.js'
import { asRecordOrEmpty as asRecord } from '../json/records.js'

export const BOUNDED_TRIWIKI_ATTENTION_SCHEMA = 'sks.subagent-triwiki-attention.v1'
export const DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT = 8

export interface BoundedTriwikiAttentionAnchor {
  id: string
  claim_hash: string | null
  source_hash: string | null
  hydrate_hint: string | null
}

export interface BoundedTriwikiAttention {
  schema: typeof BOUNDED_TRIWIKI_ATTENTION_SCHEMA
  source: '.sneakoscope/wiki/context-pack.json'
  available: boolean
  attention_mode: string | null
  anchor_limit: number
  anchors: BoundedTriwikiAttentionAnchor[]
  hydration_policy: 'on_demand_only'
  full_pack_injected: false
}

export async function readBoundedTriwikiAttention(
  root: string,
  limit: number = DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT,
  query: string = ''
): Promise<BoundedTriwikiAttention> {
  const pack = await readJson<unknown>(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), null)
  return extractBoundedTriwikiAttention(pack, limit, query)
}

export function extractBoundedTriwikiAttention(
  value: unknown,
  limit: number = DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT,
  query: string = ''
): BoundedTriwikiAttention {
  const pack = asRecord(value)
  const attention = asRecord(pack.attention)
  const anchorLimit = normalizeLimit(limit)
  const hydrateHints = new Map<string, string>()
  const hydrateOrder = new Map<string, number>()

  for (const [index, row] of (Array.isArray(attention.hydrate_first) ? attention.hydrate_first : []).entries()) {
    if (!Array.isArray(row)) continue
    const id = text(row[0])
    const hint = text(row[1])
    if (id && hint) {
      hydrateHints.set(id, hint.slice(0, 240))
      hydrateOrder.set(id, index)
    }
  }

  const useFirst: Array<BoundedTriwikiAttentionAnchor & { order: number }> = []
  for (const [index, row] of (Array.isArray(attention.use_first) ? attention.use_first : []).entries()) {
    if (!Array.isArray(row)) continue
    const id = text(row[0])
    if (!id || useFirst.some((anchor) => anchor.id === id)) continue
    useFirst.push({
      id,
      claim_hash: text(row[1]) || null,
      source_hash: text(row[2]) || null,
      hydrate_hint: hydrateHints.get(id) || null,
      order: index
    })
  }
  const anchors = selectAnchors(useFirst, hydrateHints, hydrateOrder, anchorLimit, query)

  return {
    schema: BOUNDED_TRIWIKI_ATTENTION_SCHEMA,
    source: '.sneakoscope/wiki/context-pack.json',
    available: anchors.length > 0,
    attention_mode: text(attention.mode) || null,
    anchor_limit: anchorLimit,
    anchors,
    hydration_policy: 'on_demand_only',
    full_pack_injected: false
  }
}

function selectAnchors(
  useFirst: Array<BoundedTriwikiAttentionAnchor & { order: number }>,
  hydrateHints: Map<string, string>,
  hydrateOrder: Map<string, number>,
  limit: number,
  query: string
): BoundedTriwikiAttentionAnchor[] {
  const tokens = attentionQueryTokens(query)
  if (!tokens.length) return useFirst.slice(0, limit).map(stripOrder)

  const selected: BoundedTriwikiAttentionAnchor[] = []
  const seen = new Set<string>()
  // Keep the leading high-trust policy anchors, then spend the remaining
  // budget on query-relevant use_first or hydrate-first candidates. Hydrate-
  // only rows stay hints: workers must open the cited source before relying on
  // them, so relevance improves without treating lower-trust summaries as fact.
  for (const anchor of useFirst.slice(0, Math.min(3, limit))) {
    selected.push(stripOrder(anchor))
    seen.add(anchor.id)
  }

  const candidates: Array<BoundedTriwikiAttentionAnchor & { score: number; order: number; priority: number }> = []
  for (const anchor of useFirst) {
    if (seen.has(anchor.id)) continue
    candidates.push({
      ...stripOrder(anchor),
      score: attentionRelevance(anchor.id, anchor.hydrate_hint, tokens),
      order: anchor.order,
      priority: 0
    })
  }
  for (const [id, hint] of hydrateHints.entries()) {
    if (seen.has(id) || useFirst.some((anchor) => anchor.id === id)) continue
    const score = attentionRelevance(id, hint, tokens)
    if (score <= 0) continue
    candidates.push({
      id,
      claim_hash: null,
      source_hash: null,
      hydrate_hint: hint,
      score,
      order: hydrateOrder.get(id) ?? Number.MAX_SAFE_INTEGER,
      priority: 1
    })
  }
  candidates.sort((left, right) => right.score - left.score || left.priority - right.priority || left.order - right.order)
  for (const candidate of candidates) {
    if (selected.length >= limit) break
    if (candidate.score <= 0 || seen.has(candidate.id)) continue
    selected.push(stripRank(candidate))
    seen.add(candidate.id)
  }
  for (const anchor of useFirst) {
    if (selected.length >= limit) break
    if (seen.has(anchor.id)) continue
    selected.push(stripOrder(anchor))
    seen.add(anchor.id)
  }
  return selected
}

function attentionQueryTokens(value: string): string[] {
  const stop = new Set([
    'and', 'the', 'for', 'with', 'from', 'into', 'this', 'that', 'sks', 'src', 'core',
    '작업', '구현', '개선', '추가', '변경', '기능', '모든', '최대한'
  ])
  return [...new Set(String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !stop.has(token)))]
    .slice(0, 64)
}

function attentionRelevance(id: string, hint: string | null, tokens: string[]): number {
  const haystack = `${id} ${hint || ''}`
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
  const compact = haystack.replace(/\s+/g, '')
  return tokens.reduce((score, token) => {
    if (haystack.includes(token)) return score + (token.length >= 5 ? 4 : 3)
    return compact.includes(token) ? score + 2 : score
  }, 0)
}

function stripOrder(anchor: BoundedTriwikiAttentionAnchor & { order: number }): BoundedTriwikiAttentionAnchor {
  return {
    id: anchor.id,
    claim_hash: anchor.claim_hash,
    source_hash: anchor.source_hash,
    hydrate_hint: anchor.hydrate_hint
  }
}

function stripRank(anchor: BoundedTriwikiAttentionAnchor & { score: number; order: number; priority: number }): BoundedTriwikiAttentionAnchor {
  return {
    id: anchor.id,
    claim_hash: anchor.claim_hash,
    source_hash: anchor.source_hash,
    hydrate_hint: anchor.hydrate_hint
  }
}

function normalizeLimit(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_TRIWIKI_ATTENTION_ANCHOR_LIMIT
  return Math.max(1, Math.min(16, Math.floor(parsed)))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}
