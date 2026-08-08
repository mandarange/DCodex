import assert from 'node:assert/strict'
import test from 'node:test'
import type { BridgeCatalogModel } from '../../bridge-contracts.js'
import {
  MAX_SELECTED_OPENROUTER_MODELS,
  applyBridgeModelSelection,
  availableModelRows,
  emptyBridgeModelSelection,
  normalizeBridgeModelSelection,
  pruneSelection
} from '../model-selection.js'

const NOW = '2026-08-08T00:00:00.000Z'

function model(publicId: string, providerId: BridgeCatalogModel['provider_id']): BridgeCatalogModel {
  return {
    public_id: publicId,
    slug: publicId,
    provider_id: providerId,
    upstream_model: publicId,
    display_name: publicId.toUpperCase(),
    supported_in_api: true,
    capabilities: [],
    source_catalog_generation: 'generation',
    route_key: `${providerId}:${publicId}`,
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'list',
    priority: providerId === 'codex-lb' ? 100 : 1,
    base_instructions: '',
    supports_reasoning_summary_parameter: true,
    support_verbosity: false,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: false,
    experimental_supported_tools: []
  }
}

const CATALOG = [
  model('gpt-5.6-sol', 'codex-lb'),
  model('gpt-5.4', 'codex-lb'),
  model('z-ai/glm-5.2', 'openrouter'),
  model('ai21/jamba-large-1.7', 'openrouter')
]

test('every codex-lb model stays exposed while OpenRouter is curated', () => {
  const none = emptyBridgeModelSelection(NOW)
  const withoutPicks = applyBridgeModelSelection(CATALOG, none)
  assert.deepEqual(withoutPicks.map((row) => row.public_id).sort(), ['gpt-5.4', 'gpt-5.6-sol'])

  const picked = { ...none, openrouter: { mode: 'selected' as const, public_ids: ['z-ai/glm-5.2'] } }
  const withPick = applyBridgeModelSelection(CATALOG, picked)
  assert.deepEqual(withPick.map((row) => row.public_id).sort(), ['gpt-5.4', 'gpt-5.6-sol', 'z-ai/glm-5.2'])
  assert.equal(withPick.some((row) => row.public_id === 'ai21/jamba-large-1.7'), false)
})

test('available rows report the full OpenRouter surface with selection state', () => {
  const selection = { ...emptyBridgeModelSelection(NOW), openrouter: { mode: 'selected' as const, public_ids: ['z-ai/glm-5.2'] } }
  const rows = availableModelRows(CATALOG, selection)
  assert.deepEqual(rows.map((row) => row.public_id), ['ai21/jamba-large-1.7', 'z-ai/glm-5.2'])
  assert.deepEqual(rows.map((row) => row.selected), [false, true])
  assert.equal(rows.some((row) => row.public_id.startsWith('gpt-')), false)
})

test('selection input is normalized, deduplicated, and bounded', () => {
  const normalized = normalizeBridgeModelSelection({
    schema: 'sks.bridge-model-selection.v1',
    updated_at: NOW,
    openrouter: { mode: 'selected', public_ids: [' b ', 'a', 'a', ''] }
  }, NOW)
  assert.deepEqual(normalized.openrouter.public_ids, ['a', 'b'])

  const oversized = normalizeBridgeModelSelection({
    schema: 'sks.bridge-model-selection.v1',
    updated_at: NOW,
    openrouter: { mode: 'selected', public_ids: Array.from({ length: 200 }, (_, index) => `model-${String(index).padStart(3, '0')}`) }
  }, NOW)
  assert.equal(oversized.openrouter.public_ids.length, MAX_SELECTED_OPENROUTER_MODELS)

  // An unknown or retired schema must never be read as a real selection.
  assert.deepEqual(normalizeBridgeModelSelection({ schema: 'sks.bridge-model-selection.v0' }, NOW).openrouter.public_ids, [])
  assert.deepEqual(normalizeBridgeModelSelection(null, NOW).openrouter.public_ids, [])
})

test('picks for models the provider no longer serves are pruned', () => {
  const selection = {
    ...emptyBridgeModelSelection(NOW),
    openrouter: { mode: 'selected' as const, public_ids: ['z-ai/glm-5.2', 'retired/model'] }
  }
  const pruned = pruneSelection(selection, availableModelRows(CATALOG, selection))
  assert.deepEqual(pruned.openrouter.public_ids, ['z-ai/glm-5.2'])
  // Unchanged selections keep object identity so callers can skip a rewrite.
  assert.equal(pruneSelection(pruned, availableModelRows(CATALOG, pruned)), pruned)
})

test('gateway ModelInfo metadata survives catalog normalization', async () => {
  const { normalizeProviderCatalog } = await import('../normalize.js')
  const gatewayRow = {
    slug: 'gpt-5.6-sol',
    display_name: 'GPT-5.6-Sol',
    supported_reasoning_levels: [{ effort: 'low', description: 'Fast responses' }, { effort: 'high', description: 'Deep' }],
    default_reasoning_level: 'low',
    service_tiers: [{ id: 'priority', name: 'Fast', description: '1.5x speed' }],
    additional_speed_tiers: ['fast'],
    multi_agent_version: 'v2',
    tool_mode: 'code_mode_only',
    context_window: 272_000,
    supported_in_api: true,
    priority: 1,
    visibility: 'list',
    shell_type: 'shell_command',
    base_instructions: '',
    support_verbosity: true,
    supports_parallel_tool_calls: true,
    truncation_policy: { mode: 'tokens', limit: 10_000 },
    experimental_supported_tools: []
  }
  const normalized = normalizeProviderCatalog({
    provider_id: 'codex-lb',
    state: 'verified',
    generation: 'gateway-generation',
    models: { models: [gatewayRow] },
    checked_at: '2026-08-08T00:00:00.000Z',
    expires_at: null,
    blockers: [],
    warnings: []
  } as never)

  const model = normalized.models[0] as Record<string, unknown>
  assert.ok(model, 'gateway row must normalize into a catalog model')
  // Codex Desktop reads these straight from model_catalog_json; dropping them
  // empties the reasoning selector and hides Fast mode.
  assert.deepEqual(model.supported_reasoning_levels, gatewayRow.supported_reasoning_levels)
  assert.equal(model.default_reasoning_level, 'low')
  assert.deepEqual(model.service_tiers, gatewayRow.service_tiers)
  assert.deepEqual(model.additional_speed_tiers, ['fast'])
  assert.equal(model.multi_agent_version, 'v2')
  assert.equal(model.tool_mode, 'code_mode_only')
  assert.equal(model.context_window, 272_000)
  // SKS routing identity is still layered on top of the preserved row.
  assert.equal(model.provider_id, 'codex-lb')
  assert.equal(model.route_key, 'codex-lb:gpt-5.6-sol')
})

test('a gateway payload carrying both ModelInfo and OpenAI rows prefers ModelInfo', async () => {
  const { codexLbModelCatalogRows } = await import('../../codex-lb-env.js')
  const rows = codexLbModelCatalogRows({
    models: [{ slug: 'gpt-5.6-sol', supported_reasoning_levels: [{ effort: 'low' }] }],
    data: [{ id: 'gpt-5.6-sol', object: 'model' }]
  })
  assert.equal(rows.length, 1)
  assert.ok(Array.isArray(rows[0]?.supported_reasoning_levels))
})
