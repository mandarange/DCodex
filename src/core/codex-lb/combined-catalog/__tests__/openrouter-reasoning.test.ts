import assert from 'node:assert/strict'
import test from 'node:test'
import type { BridgeCatalogModel } from '../../bridge-contracts.js'
import {
  OPENROUTER_DEFAULT_REASONING_LEVEL,
  OPENROUTER_REASONING_LEVELS,
  normalizeProviderCatalog
} from '../normalize.js'

// OpenRouter never serves Codex ModelInfo, so SKS synthesizes the reasoning
// ladder from OpenRouter's own capability flag. A live round trip through the
// desktop bridge against z-ai/glm-5.2 answered 200 for every rung, echoed the
// requested effort back in `response.created`, and scaled
// `response.reasoning_text.delta` with it, so these rows drive a control that is
// wired end to end rather than a selector that renders and does nothing.
function openRouterCatalog(rows: unknown[]) {
  return {
    provider_id: 'openrouter' as const,
    state: 'verified' as const,
    generation: 'generation',
    models: rows
  }
}

function row(id: string, features: Record<string, boolean>) {
  return { id, name: id, features }
}

function at(models: readonly BridgeCatalogModel[], index: number): Record<string, unknown> {
  assert.ok(index < models.length, `expected a model at index ${index}`)
  return models[index] as unknown as Record<string, unknown>
}

function efforts(model: Record<string, unknown>): string[] {
  return (model.supported_reasoning_levels as { effort: string }[]).map((level) => level.effort)
}

test('reasoning-capable OpenRouter models expose the full effort ladder', () => {
  const normalized = normalizeProviderCatalog(openRouterCatalog([
    row('z-ai/glm-5.2', { reasoning: true, tools: true })
  ]))
  assert.equal(normalized.models.length, 1)
  const model = at(normalized.models, 0)
  assert.deepEqual(
    model.supported_reasoning_levels,
    OPENROUTER_REASONING_LEVELS.map((level) => ({ ...level }))
  )
  assert.deepEqual(efforts(model), ['low', 'medium', 'high', 'xhigh'])
  assert.equal(model.default_reasoning_level, OPENROUTER_DEFAULT_REASONING_LEVEL)
  assert.equal(model.supports_reasoning_summary_parameter, true)
  assert.ok((model.capabilities as string[]).includes('reasoning'))
})

test('OpenRouter models without reasoning expose no levels and no summary parameter', () => {
  const normalized = normalizeProviderCatalog(openRouterCatalog([
    row('openai/gpt-4o-mini', { reasoning: false, tools: true })
  ]))
  const model = at(normalized.models, 0)
  assert.deepEqual(model.supported_reasoning_levels, [])
  assert.equal(model.default_reasoning_level, undefined)
  // A model with no reasoning must not advertise the summary parameter, or
  // Codex sends `reasoning.summary` to an upstream that cannot honour it.
  assert.equal(model.supports_reasoning_summary_parameter, false)
  assert.ok(!(model.capabilities as string[]).includes('reasoning'))
})

test('each row owns its reasoning level objects', () => {
  const normalized = normalizeProviderCatalog(openRouterCatalog([
    row('z-ai/glm-5.2', { reasoning: true }),
    row('anthropic/claude-sonnet-4.5', { reasoning: true })
  ]))
  assert.equal(normalized.models.length, 2)
  const firstLevels = at(normalized.models, 0).supported_reasoning_levels as Record<string, string>[]
  const secondLevels = at(normalized.models, 1).supported_reasoning_levels as Record<string, string>[]
  const firstHead = firstLevels[0] as Record<string, string>
  const secondHead = secondLevels[0] as Record<string, string>
  assert.notEqual(firstHead, secondHead)
  firstHead.effort = 'mutated'
  assert.equal(secondHead.effort, 'low')
  assert.equal(OPENROUTER_REASONING_LEVELS[0]?.effort, 'low')
})

test('codex-lb rows keep the gateway ladder instead of the OpenRouter one', () => {
  const normalized = normalizeProviderCatalog({
    provider_id: 'codex-lb',
    state: 'verified',
    generation: 'generation',
    models: {
      models: [{
        id: 'gpt-5.6-sol',
        slug: 'gpt-5.6-sol',
        display_name: 'GPT-5.6 Sol',
        supported_in_api: true,
        supported_reasoning_levels: [
          { effort: 'none', description: 'No reasoning' },
          { effort: 'high', description: 'Greater reasoning depth for complex problems' }
        ],
        service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }]
      }]
    }
  })
  const model = at(normalized.models, 0)
  assert.deepEqual(model.supported_reasoning_levels, [
    { effort: 'none', description: 'No reasoning' },
    { effort: 'high', description: 'Greater reasoning depth for complex problems' }
  ])
  assert.deepEqual(model.service_tiers, [{ id: 'priority', name: 'Fast', description: '1.5x speed' }])
})
