import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  CODEX_MODELS_CACHE_STALE_FETCHED_AT,
  invalidateCodexModelsCache
} from '../codex-models-cache.js'
import {
  classifyCodexDesktopRouting,
  opencodexDesignBBlocksRouterActivation
} from '../codex-desktop-routing-ownership.js'
import { stampRoleModelCatalogPriorities } from '../role-model-catalog-priority.js'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../../codex-compat/codex-runtime-contract.js'

test('invalidateCodexModelsCache merges catalog rows into existing cache by slug', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-models-cache-'))
  const codexHome = path.join(home, '.codex')
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome }
  await fs.mkdir(codexHome, { recursive: true })
  const cachePath = path.join(codexHome, 'models_cache.json')
  await fs.writeFile(cachePath, JSON.stringify({
    fetched_at: '2026-07-23T21:57:52.157964Z',
    client_version: '9.9.9',
    models: [{ slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: true, priority: 1 }]
  }, null, 2))
  const catalogPath = path.join(codexHome, 'sks-openrouter-catalog.json')
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [
      { slug: 'openrouter/new-model', visibility: 'list', supported_in_api: true, multi_agent_version: 'v2', priority: 0 }
    ]
  }, null, 2))

  const result = await invalidateCodexModelsCache({ home, env, catalogPath, seedMode: 'merge' })
  assert.equal(result.ok, true)
  assert.equal(result.models_cache_invalidated, true)
  assert.equal(result.status, 'seeded_from_catalog')
  const rewritten = JSON.parse(await fs.readFile(cachePath, 'utf8'))
  assert.equal(rewritten.fetched_at, CODEX_MODELS_CACHE_STALE_FETCHED_AT)
  assert.equal(rewritten.client_version, '9.9.9')
  const slugs = rewritten.models.map((row: { slug: string }) => row.slug).sort()
  assert.deepEqual(slugs, ['gpt-5.6-sol', 'openrouter/new-model'])
})

test('invalidateCodexModelsCache replace mode still overwrites models when requested', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-models-cache-replace-'))
  const codexHome = path.join(home, '.codex')
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome }
  await fs.mkdir(codexHome, { recursive: true })
  const cachePath = path.join(codexHome, 'models_cache.json')
  await fs.writeFile(cachePath, JSON.stringify({
    fetched_at: '2026-07-23T21:57:52.157964Z',
    client_version: '9.9.9',
    models: [{ slug: 'openai/gpt-test', visibility: 'list', supported_in_api: true }]
  }, null, 2))
  const catalogPath = path.join(codexHome, 'sks-openrouter-catalog.json')
  await fs.writeFile(catalogPath, JSON.stringify({
    models: [
      { slug: 'openrouter/new-model', visibility: 'list', supported_in_api: true, multi_agent_version: 'v2', priority: 0 }
    ]
  }, null, 2))

  const result = await invalidateCodexModelsCache({ home, env, catalogPath, seedMode: 'replace' })
  assert.equal(result.ok, true)
  const rewritten = JSON.parse(await fs.readFile(cachePath, 'utf8'))
  assert.equal(rewritten.models.length, 1)
  assert.equal(rewritten.models[0].slug, 'openrouter/new-model')
})

test('invalidateCodexModelsCache derives a missing client version from package.json', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-models-cache-version-'))
  const codexHome = path.join(home, '.codex')
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome }
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(path.join(codexHome, 'models_cache.json'), JSON.stringify({
    fetched_at: '2026-07-23T21:57:52.157964Z',
    client_version: '0.0.0',
    models: [{ slug: 'gpt-test' }]
  }))

  const result = await invalidateCodexModelsCache({ home, env })
  assert.equal(result.ok, true)
  const rewritten = JSON.parse(await fs.readFile(path.join(codexHome, 'models_cache.json'), 'utf8'))
  assert.equal(rewritten.client_version, CURRENT_CODEX_RUNTIME_CONTRACT.sdkVersion)
})

test('classifyCodexDesktopRouting detects OpenCodex Design B and blocks router unless forced', () => {
  const config = [
    '# Auto-injected by opencodex',
    'openai_base_url = "http://127.0.0.1:10100/v1"',
    'model_provider = "openai"',
    'model = "anthropic/claude-sonnet"',
    `model_catalog_json = "${path.join(os.homedir(), '.codex', 'opencodex-catalog.json')}"`,
    ''
  ].join('\n')
  const ownership = classifyCodexDesktopRouting(config, { home: os.homedir() })
  assert.equal(ownership.classification, 'opencodex_design_b')
  assert.equal(ownership.opencodex_design_b, true)
  assert.equal(opencodexDesignBBlocksRouterActivation(ownership), 'opencodex_design_b_routing_owner')
  assert.equal(opencodexDesignBBlocksRouterActivation(ownership, { forceRoutingOverride: true }), null)
})

test('stampRoleModelCatalogPriorities elevates preferred models into spawn picker slots', () => {
  const stamped = stampRoleModelCatalogPriorities([
    { slug: 'other/a', priority: 1, visibility: 'list', supported_in_api: true },
    { slug: 'gpt-5.6-terra', priority: 50, visibility: 'list', supported_in_api: true, multi_agent_version: 'v2' },
    { slug: 'gpt-5.6-luna', priority: 40, visibility: 'hide', supported_in_api: false }
  ], {
    schema: 'sks.role-model-preferences.v2',
    version: 2,
    updated_at: 'now',
    roles: {
      worker: { provider: 'openai', model: 'gpt-5.6-luna', reasoning_effort: 'max', updated_at: 'now' },
      long_context_analyst: { provider: 'openai', model: 'gpt-5.6-terra', reasoning_effort: 'max', updated_at: 'now' }
    }
  })
  assert.equal(stamped.stamped, true)
  assert.deepEqual(stamped.stamped_models, ['gpt-5.6-luna', 'gpt-5.6-terra'])
  assert.equal(stamped.rows.length, 3)
  const luna = stamped.rows[0]!
  const terra = stamped.rows[1]!
  const other = stamped.rows[2]!
  assert.equal(luna.slug, 'gpt-5.6-luna')
  assert.equal(luna.priority, 0)
  assert.equal(luna.visibility, 'list')
  assert.equal(luna.supported_in_api, true)
  assert.equal(terra.slug, 'gpt-5.6-terra')
  assert.equal(terra.priority, 1)
  assert.ok(Number(other.priority) >= 5)
})
