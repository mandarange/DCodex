import type { CodexTaskInput } from '../codex-control/codex-control-plane.js'
import { capabilityCost, DEFAULT_CAPABILITY_CARDS, type CapabilityCard } from './capability-card.js'
import { classifyCodexTask, scoreCapabilityCard } from './task-classifier.js'
import { codexRouteCacheKey, readRouteCache, writeRouteCache } from './route-cache.js'

export interface UltraRouterDecision {
  schema: 'sks.ultra-router-decision.v1'
  selected_profile: string
  reason: string
  scores: Record<string, number>
  costs: Record<string, number>
  cache_hit: boolean
  tier: 'orchestrator' | 'worker'
  threshold: number
  hard_filters: string[]
  classification: ReturnType<typeof classifyCodexTask>
}

export function routeCodexTask(input: CodexTaskInput, cards: CapabilityCard[] = DEFAULT_CAPABILITY_CARDS): UltraRouterDecision {
  const key = codexRouteCacheKey(input)
  const cached = readRouteCache<UltraRouterDecision>(key)
  if (cached) return { ...cached, cache_hit: true }

  const classification = classifyCodexTask(input)
  const hardFilters: string[] = []
  const availableCards = cards
  const scored = availableCards.map((card) => {
    const score = scoreCapabilityCard(card, classification)
    if (score === 0) hardFilters.push(card.id)
    return { card, score, cost: capabilityCost(card) }
  })
  const viable = scored
    .filter((row) => row.score >= classification.threshold)
    .sort((a, b) => a.cost - b.cost || b.score - a.score)
  const fallback = scored
    .filter((row) => row.card.tier === classification.tier && row.score > 0)
    .sort((a, b) => b.score - a.score || a.cost - b.cost)[0]
  const selected = viable[0] || fallback || scored.find((row) => row.card.id === 'fast-worker') || scored[0]
  if (!selected) throw new Error('UltraRouter requires at least one capability card')
  const decision: UltraRouterDecision = {
    schema: 'sks.ultra-router-decision.v1',
    selected_profile: selected.card.id,
    reason: viable[0] ? 'score>=threshold cheapest-good-enough' : 'deterministic-default-after-classifier-shortfall',
    scores: Object.fromEntries(scored.map((row) => [row.card.id, row.score])),
    costs: Object.fromEntries(scored.map((row) => [row.card.id, row.cost])),
    cache_hit: false,
    tier: classification.tier,
    threshold: classification.threshold,
    hard_filters: [...new Set(hardFilters)],
    classification
  }
  return writeRouteCache(key, decision)
}
