import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { codexProviderModelUiStatus } from '../../codex-app.js'

test('native provider model controls preserve pending selections and persisted per-role overrides', async () => {
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources')
  const viewController = await fs.readFile(path.join(sourceRoot, 'ProvidersViewController.swift'), 'utf8')
  const openRouter = await fs.readFile(path.join(sourceRoot, 'ProvidersOpenRouter.swift'), 'utf8')
  const roleModels = await fs.readFile(path.join(sourceRoot, 'ProvidersRoleModels.swift'), 'utf8')
  const multiProvider = await fs.readFile(path.join(sourceRoot, 'ProvidersMultiProvider.swift'), 'utf8')
  const openRouterStatusRefresh = openRouter.slice(
    openRouter.indexOf('func refreshOpenRouterStatus()'),
    openRouter.indexOf('func describeOpenRouterStatus')
  )

  assert.doesNotMatch(viewController, /field\.stringValue = "z-ai\/glm-5\.2"/)
  assert.match(viewController, /var openRouterModelSelectionPending = false/)
  assert.match(openRouterStatusRefresh, /!self\.openRouterModelSelectionPending,\s*current\.isEmpty/)
  assert.doesNotMatch(openRouterStatusRefresh, /current == "z-ai\/glm-5\.2"/)
  assert.match(openRouter, /openRouterModelSelectionPending = true[\s\S]{0,160}openRouterModelField\.stringValue = model/)
  assert.match(roleModels, /if !controls\.model\.itemTitles\.contains\(model\) \{[\s\S]{0,120}controls\.model\.addItem\(withTitle: model\)/)
  assert.match(roleModels, /!efforts\.contains\(preferred\)[\s\S]{0,100}efforts\.append\(preferred\)/)
  assert.match(roleModels, /effectiveSource == "selected-main-model" \? effectiveModel : \(defaultModel \?\? effectiveModel\)/)
  assert.match(roleModels, /effectiveSource == "selected-main-model" \? effectiveReasoning : \(defaultReasoning \?\? effectiveReasoning\)/)
  assert.match(roleModels, /effectiveSource == "selected-main-model" \? " · inherits active main model"/)
  assert.match(multiProvider, /var modelSelectionPending = false/)
  assert.match(multiProvider, /!self\.multiProvider\.modelSelectionPending,[\s\S]{0,420}self\.synchronizeMultiProviderPopupSelection\(\)/)
  assert.doesNotMatch(multiProvider, /models\.firstIndex\(of: activeModel\)/)
})

test('native provider model controls compile with the AppKit control flow', async (t) => {
  if (process.platform !== 'darwin') return t.skip('AppKit compile check is macOS-only')
  const sourceRoot = path.join(process.cwd(), 'native', 'sks-menubar', 'Sources')
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-swift-'))
  t.after(() => fs.rm(temp, { recursive: true, force: true }))
  const mainTemplate = await fs.readFile(path.join(sourceRoot, 'main.swift'), 'utf8')
  const materializedMain = mainTemplate
    .replace('__SKS_ACTION_SCRIPT__', '"/tmp/sks-action"')
    .replace('__SKS_PROJECT_ROOT__', '"/tmp/project"')
    .replace('__SKS_BUILD_STAMP__', '"/tmp/build-stamp.json"')
    .replace('__SKS_CONFIG_PATH__', '"/tmp/config.json"')
    .replace('__SKS_LAST_LOG__', '"/tmp/action.log"')
    .replace('__SKS_OPERATION_DIR__', '"/tmp/operations"')
    .replace('__SKS_CODEX_BUNDLE_ID__', 'nil')
    .replace('__SKS_PACKAGE_VERSION__', '"test"')
  const main = path.join(temp, 'main.swift')
  await fs.writeFile(main, materializedMain)
  const sources = (await fs.readdir(sourceRoot))
    .filter((name) => name.endsWith('.swift') && name !== 'main.swift')
    .sort()
    .map((name) => path.join(sourceRoot, name))
  const compiled = await run('swiftc', ['-typecheck', ...sources, main])
  assert.equal(compiled.code, 0, `${compiled.stdout}\n${compiled.stderr}`)
})

test('selected codex-lb readiness is not blocked by optional GLM/OpenRouter setup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-root-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-home-'))
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'))

  const status = await codexProviderModelUiStatus({
    home,
    cwd: root,
    env: { HOME: home },
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    },
    desktopPickerEvidence: {
      state: 'verified',
      verified: true,
      selected_model: 'gpt-5.6-sol'
    }
  })

  assert.equal(status.selected_provider, 'codex-lb')
  assert.equal(status.selected_provider_ok, true)
  assert.deepEqual(status.selected_provider_blockers, [])
  assert.equal(status.ok, true)
  assert.equal(status.configured, true)
  assert.equal(status.advertised, true)
  assert.equal(status.effective_ready, true)
  assert.equal(status.status, 'ready')
  assert.deepEqual(status.blockers, [])
  assert.equal(status.optional_provider_status, 'setup_available')
  assert.ok(status.optional_provider_blockers.includes('glm_openrouter_provider_missing'))
  assert.ok(status.optional_provider_blockers.includes('openrouter_key_missing'))
})

test('selected codex-lb readiness prefers persisted model_catalog_json over a failing live /models probe', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-persisted-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-persisted-home-'))
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  const catalogPath = path.join(codexHome, 'sks-codex-lb-tool-catalog.json')
  const catalog = {
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((slug) => ({
      slug,
      display_name: slug,
      supported_reasoning_levels: [{ effort: 'medium', description: 'Balanced' }],
      shell_type: 'shell_command',
      visibility: 'list',
      supported_in_api: true,
      priority: 1,
      base_instructions: 'You are Codex.',
      supports_reasoning_summaries: true,
      support_verbosity: true,
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      supports_parallel_tool_calls: true,
      experimental_supported_tools: [],
      tool_mode: 'code_mode_only',
      use_responses_lite: false,
      minimal_client_version: '0.144.5'
    }))
  }
  await fs.writeFile(catalogPath, `${JSON.stringify(catalog)}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    `model_catalog_json = "${catalogPath}"`,
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'))

  const status = await codexProviderModelUiStatus({
    home,
    cwd: root,
    env: { HOME: home },
    // Intentionally omit live catalog injection so readiness must use the Desktop file.
  })

  assert.equal(status.ok, false)
  assert.equal(status.configured, true)
  assert.equal(status.advertised, true)
  assert.equal(status.effective_ready, false)
  assert.equal(status.desktop_picker_verified, false)
  assert.equal(status.status, 'available_unverified')
  assert.equal(status.codex_lb.model_catalog_source, 'persisted_model_catalog_json')
  assert.equal(status.codex_lb.model_catalog_json_configured, true)
  assert.equal(status.codex_lb.expected_models_present, true)
  assert.equal(status.codex_lb.tools_transport, 'full_responses')
  assert.deepEqual(status.selected_provider_blockers, [])
})

test('unmarked user model_reasoning_effort does not fail Fast UI readiness under codex-lb', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-fast-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-fast-home-'))
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    'model_provider = "codex-lb"',
    'model_reasoning_effort = "high"',
    'service_tier = "fast"',
    '[features]',
    'fast_mode = true',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'))

  const status = await codexProviderModelUiStatus({
    home,
    cwd: root,
    env: { HOME: home },
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    }
  })
  const appStatus = await (await import('../../codex-app.js')).codexAppIntegrationStatus({
    home,
    cwd: root,
    env: { HOME: home },
    codex: { bin: null },
    runProcess: async () => ({ code: 1, stdout: '', stderr: 'fixture' }),
    codexLbModelCatalog: {
      ok: true,
      models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
      blockers: []
    }
  })

  assert.equal(status.ok, false)
  assert.equal(status.configured, true)
  assert.equal(status.readiness_state, 'available_unverified')
  assert.equal(appStatus.features?.fast_mode_config?.ok, true)
  assert.deepEqual(appStatus.features?.fast_mode_config?.blockers || [], [])
})

test('native bridge mode does not require or bind the local replacement catalog', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-native-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-native-home-'))
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    '# sks-codex-lb-managed-desktop-bridge',
    'openai_base_url = "http://127.0.0.1:18765/backend-api/codex"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='http://127.0.0.1:18765/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'))

  const status = await codexProviderModelUiStatus({
    home,
    cwd: root,
    env: { HOME: home },
    codexLbDesktopMode: 'desktop-native-bridge',
    codexLbModelCatalog: {
      ok: true,
      models: ['future-codex-model'],
      blockers: []
    }
  })

  assert.equal(status.codex_lb.local_catalog_binding_allowed, false)
  assert.equal(status.codex_lb.model_catalog_json_configured, false)
  assert.equal(status.codex_lb.advertised_models_present, true)
  assert.equal(status.codex_lb.provider_contract_ok, true)
  assert.equal(status.codex_lb.provider_contract, 'cli-provider')
  assert.ok(!status.codex_lb.blockers.includes('codex_lb_model_catalog_json_unselected'))
})

test('compat provider status requires exact OpenAI identity and separate gateway header', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-compat-'))
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-ui-compat-home-'))
  const codexHome = path.join(home, '.codex')
  await fs.mkdir(codexHome, { recursive: true })
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(home, { recursive: true, force: true })
  })

  await fs.writeFile(path.join(codexHome, 'config.toml'), [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = true',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
    ''
  ].join('\n'))
  await fs.writeFile(path.join(codexHome, 'sks-codex-lb.env'), [
    "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'",
    "export CODEX_LB_API_KEY='fixture-secret'",
    ''
  ].join('\n'))

  const status = await codexProviderModelUiStatus({
    home,
    cwd: root,
    env: { HOME: home },
    codexLbModelCatalog: {
      ok: true,
      models: ['future-codex-model'],
      blockers: []
    }
  })

  assert.equal(status.codex_lb.desktop_mode, 'desktop-dual-auth-compat')
  assert.equal(status.codex_lb.provider_contract, 'desktop-dual-auth-compat')
  assert.equal(status.codex_lb.provider_contract_ok, true)
  assert.equal(status.codex_lb.gateway_auth_transport, 'x-codex-lb-api-key')
  assert.deepEqual(status.codex_lb.blockers, [])
})

function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
