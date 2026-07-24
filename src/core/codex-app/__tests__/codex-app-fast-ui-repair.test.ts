import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { repairCodexAppFastUi } from '../codex-app-fast-ui-repair.js'
import { scanTomlSignals, snapshotCodexAppUiState } from '../codex-app-ui-state-snapshot.js'

async function fixture(t: TestContext, config: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-fast-ui-root-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-fast-ui-home-'))
  const codexHome = path.join(home, '.codex')
  const configPath = path.join(codexHome, 'config.toml')
  await fs.mkdir(codexHome, { recursive: true })
  await fs.writeFile(configPath, config)
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })
  return { root, codexHome, configPath }
}

test('Codex App Fast UI repair removes blank-separated SKS model locks but preserves active codex-lb selection', async (t) => {
  const input = [
    'suppress_unstable_features_warning = true',
    '# SKS moved machine-local Codex config from .codex/config.toml',
    '',
    'model_provider = "codex-lb"',
    'service_tier = "fast"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "ultra"',
    '[features]',
    'fast_mode = true',
    '',
    '[model_providers.codex-lb]',
    'name = "openai"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)
  const oldBackup = `${configPath}.sks-old-fixture.bak`
  await fs.writeFile(oldBackup, input, { mode: 0o644 })
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'), { mode: 0o600 })

  const repaired = await repairCodexAppFastUi(root, {
    codexHome,
    apply: true,
    env: { HOME: path.dirname(codexHome) },
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    }
  } as any)
  const after = await fs.readFile(configPath, 'utf8')
  const globalAction = repaired.actions.find((action) => action.scope === 'codex_home')

  assert.equal(repaired.ok, true)
  assert.equal(repaired.fast_selector, 'repaired')
  assert.equal(repaired.before_fast_selector, 'maybe_hidden_or_locked')
  assert.equal(repaired.after_fast_selector, 'available')
  assert.deepEqual(globalAction?.removed_keys, ['model', 'model_reasoning_effort'])
  assert.match(after, /^model_provider = "codex-lb"$/m)
  assert.match(after, /^service_tier = "fast"$/m)
  assert.doesNotMatch(after, /^model =/m)
  assert.doesNotMatch(after, /^model_reasoning_effort =/m)
  assert.match(after, /^fast_mode = true$/m)
  assert.match(after, /^\[model_providers\.codex-lb\]$/m)
  assert.ok(globalAction?.backup_path)
  assert.equal((await fs.stat(configPath)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(oldBackup)).mode & 0o777, 0o600)
  assert.equal((await fs.stat(String(globalAction?.backup_path))).mode & 0o777, 0o600)
  assert.ok(repaired.permissions_hardened >= 2)

  const second = await repairCodexAppFastUi(root, {
    codexHome,
    apply: true,
    env: { HOME: path.dirname(codexHome) },
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    }
  } as any)
  assert.equal(second.actions.some((action) => action.changed), false)
})

test('Codex App Fast UI repair follows SKS provenance past unrelated managed comments and notify', async (t) => {
  const input = [
    '# SKS moved machine-local Codex config from .codex/config.toml',
    '',
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    'notify = ["/tmp/turn-ended"]',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "max"',
    '',
    '[features]',
    'fast_mode = true',
    '',
    '[model_providers.codex-lb]',
    'name = "openai"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'), { mode: 0o600 })

  const repaired = await repairCodexAppFastUi(root, {
    codexHome,
    apply: true,
    env: { HOME: path.dirname(codexHome) },
    codexLbModelCatalog: { ok: true, models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'], blockers: [] }
  } as any)
  const after = await fs.readFile(configPath, 'utf8')

  assert.equal(repaired.ok, true)
  assert.deepEqual(repaired.actions.find((action) => action.scope === 'codex_home')?.removed_keys, ['model', 'model_reasoning_effort'])
  assert.match(after, /^model_provider = "codex-lb"$/m)
  assert.match(after, /^notify = /m)
  assert.doesNotMatch(after, /^model =/m)
  assert.doesNotMatch(after, /^model_reasoning_effort =/m)
})

test('Codex App UI snapshot reports API-key auth with an OAuth backup as Chat/Pro inactive without exposing secrets', async (t) => {
  const secret = 'sk-secret-that-must-never-appear'
  const oauthAccess = 'oauth-access-that-must-never-appear'
  const { root, codexHome } = await fixture(t, '[features]\nfast_mode = true\n')
  await fs.writeFile(path.join(codexHome, 'auth.json'), `${JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: secret })}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(codexHome, 'auth.chatgpt-backup.json'), `${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: oauthAccess, refresh_token: 'refresh-secret' } })}\n`, { mode: 0o600 })

  const snapshot = await snapshotCodexAppUiState(root, { codexHome })
  const serialized = JSON.stringify(snapshot)

  assert.equal(snapshot.indicators.auth_mode, 'apikey')
  assert.equal(snapshot.indicators.chatgpt_oauth_backup_available, true)
  assert.equal(snapshot.indicators.chat_surface, 'chatgpt_oauth_inactive')
  assert.doesNotMatch(serialized, new RegExp(secret))
  assert.doesNotMatch(serialized, new RegExp(oauthAccess))
})

test('Codex App Fast UI repair still removes SKS-marked non-lb provider locks after migration', async (t) => {
  const input = [
    '# SKS moved machine-local Codex config from .codex/config.toml',
    '',
    'model_provider = "openai"',
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "high"',
    'service_tier = "fast"',
    '[features]',
    'fast_mode = true',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)
  const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true })
  const after = await fs.readFile(configPath, 'utf8')
  assert.deepEqual(repaired.actions.find((action) => action.scope === 'codex_home')?.removed_keys, [
    'model_provider',
    'model',
    'model_reasoning_effort'
  ])
  assert.doesNotMatch(after, /^model_provider =/m)
  assert.doesNotMatch(after, /^model =/m)
  assert.doesNotMatch(after, /^model_reasoning_effort =/m)
  assert.match(after, /^service_tier = "fast"$/m)
})

test('Codex App Fast UI repair preserves unmarked user model and effort choices', async (t) => {
  const input = [
    'model_provider = "user-provider"',
    'service_tier = "fast"',
    'model = "user-model"',
    'model_reasoning_effort = "high"',
    '[features]',
    'fast_mode = true',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)

  const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true })

  assert.equal(repaired.actions.some((action) => action.changed), false)
  assert.equal(await fs.readFile(configPath, 'utf8'), input)
})

test('Codex App Fast UI repair preserves unmarked codex-lb selection and provider credentials', async (t) => {
  const input = [
    'model_provider = "codex-lb"',
    'service_tier = "fast"',
    '[features]',
    'fast_mode = true # SKS Fast capability',
    '[model_providers.codex-lb]',
    'name = "openai"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'env_key = "CODEX_LB_API_KEY"',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)

  await repairCodexAppFastUi(root, { codexHome, apply: true, env: {} })

  assert.equal(await fs.readFile(configPath, 'utf8'), input)
})

test('documented SKS Fast service tier is an available selector signal, not a lock', async (t) => {
  const input = 'service_tier = "fast" # SKS Fast default\n[features]\nfast_mode = true # SKS Fast capability\n'
  const { root, codexHome } = await fixture(t, input)

  const snapshot = await snapshotCodexAppUiState(root, { codexHome })
  const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true })

  assert.equal(snapshot.indicators.fast_selector, 'available')
  assert.equal(repaired.actions.some((action) => action.changed), false)
})

test('automatic Fast UI repair never rewrites an unparseable Codex config', async (t) => {
  const input = '# SKS legacy model lock\nmodel = "unterminated\n[features]\nfast_mode = true\n'
  const { root, codexHome, configPath } = await fixture(t, input)

  const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true })

  assert.equal(repaired.ok, false)
  assert.equal(repaired.requires_confirmation, true)
  assert.equal(repaired.fast_selector, 'manual_action_required')
  assert.ok(repaired.blockers.includes('codex_app_fast_ui_repair_requires_confirmation'))
  assert.equal(await fs.readFile(configPath, 'utf8'), input)
  assert.equal(repaired.actions.find((action) => action.scope === 'codex_home')?.backup_path, null)
})

test('Codex App snapshots never expose inline header, environment, or collection values', () => {
  const secret = 'opaque-secret-that-must-not-leak'
  const { signals } = scanTomlSignals([
    `[model_providers.codex-lb]`,
    `http_headers = { X-Custom-Auth = "${secret}" }`,
    `env = { CODEX_LB_API_KEY = "${secret}" }`,
    `safe_list = ["${secret}"]`,
    `base_url = "https://alice:${secret}@provider.example/v1"`,
    ''
  ].join('\n'))

  assert.deepEqual(signals.map((signal) => signal.value_preview), [
    '<redacted>',
    '<redacted>',
    '<redacted-array>',
    '<redacted-url-credentials>'
  ])
  assert.doesNotMatch(JSON.stringify(signals), new RegExp(secret))
})

test('Fast UI repair fails closed when codex-lb is selected but its runtime credentials are missing', async (t) => {
  const input = [
    'model_provider = "codex-lb"',
    'service_tier = "fast"',
    '[features]',
    'fast_mode = true',
    '[model_providers.codex-lb]',
    'name = "openai"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].join('\n')
  const { root, codexHome } = await fixture(t, input)

  const repaired = await repairCodexAppFastUi(root, { codexHome, apply: true, env: {} })

  assert.equal(repaired.ok, false)
  assert.equal(repaired.provider_selector, 'manual_action_required')
  assert.ok(repaired.selected_provider_blockers.includes('codex_lb_api_key_missing'))
  assert.ok(repaired.selected_provider_blockers.includes('codex_lb_base_url_missing'))
  assert.ok(repaired.blockers.includes('selected_provider:codex_lb_api_key_missing'))
})

test('Codex App Fast UI repair preserves an active OpenRouter selection under migration markers', async (t) => {
  const input = [
    '# SKS moved machine-local Codex config from .codex/config.toml at 2026-07-24T07:04:58.256Z',
    '',
    'model_provider = "openrouter"',
    'model_catalog_json = "/tmp/sks-openrouter-catalog.json"',
    'model = "moonshotai/kimi-k3"',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    ''
  ].join('\n')
  const { root, codexHome, configPath } = await fixture(t, input)
  const repaired = await repairCodexAppFastUi(root, {
    codexHome,
    apply: true,
    env: { HOME: path.dirname(codexHome) },
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    }
  } as any)
  const after = await fs.readFile(configPath, 'utf8')
  const globalAction = repaired.actions.find((action) => action.scope === 'codex_home')
  assert.equal(globalAction?.changed, false)
  assert.match(after, /^model_provider = "openrouter"$/m)
  assert.match(after, /^model = "moonshotai\/kimi-k3"$/m)
  assert.match(after, /^model_catalog_json = /m)
})
