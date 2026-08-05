#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  codexFastModeDesktopStatus,
  codexLbConfigPath,
  configureCodexLb,
  configureCodexLbDesktopRouting,
  ensureGlobalCodexFastModeDuringInstall,
  repairCodexLbAuth
} from '../cli/install-helpers.js'
import { repairCodexConfigStructure, splitCodexProjectConfigPolicy } from '../core/codex/codex-project-config-policy.js'
import { parseCodexConfigToml, validateCodexConfigRoundTrip } from '../core/codex/codex-config-toml.js'
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../core/codex-lb/codex-lb-tool-output-recovery.js'
import { normalizeCodexLbToolCatalog } from '../core/codex-lb/codex-lb-tool-catalog.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-gpt56-fast-'))
const home = path.join(tmp, 'home')
const root = path.join(tmp, 'project')
const codexHome = path.join(home, '.codex')
const configPath = codexLbConfigPath(home)
const envPath = path.join(codexHome, 'sks-codex-lb.env')
const authPath = path.join(codexHome, 'auth.json')
const projectConfig = path.join(root, '.codex', 'config.toml')
const remoteBaseUrl = 'https://lb.example.test/backend-api/codex'
const bridgeBaseUrl = 'http://127.0.0.1:54321/backend-api/codex'
await fs.mkdir(path.dirname(projectConfig), { recursive: true })
await fs.mkdir(codexHome, { recursive: true })
const oauth = `${JSON.stringify({
  auth_mode: 'chatgpt',
  account_id: 'acct-fast-profile',
  tokens: {
    access_token: 'oauth-access',
    refresh_token: 'oauth-refresh'
  }
}, null, 2)}\n`
await fs.writeFile(authPath, oauth)

const setup = await configureCodexLb({
  home,
  configPath,
  envPath,
  host: remoteBaseUrl,
  apiKey: 'fixture-codex-lb-fast-key',
  writeEnvFile: true,
  shellProfile: 'skip',
  gatewayAuthTransport: 'x-codex-lb-api-key',
  toolOutputRecoveryFetch
})
const native = await configureCodexLbDesktopRouting({
  mode: 'desktop-native-bridge',
  home,
  configPath,
  authPath,
  bridgeBaseUrl,
  remoteBaseUrl,
  gatewayAuthTransport: 'x-codex-lb-api-key'
})
const fastOn = await ensureGlobalCodexFastModeDuringInstall({
  home,
  configPath,
  forceFastMode: true
})
const first = assertFastProfile(await fs.readFile(configPath, 'utf8'), 'native_fast_on')

const disabled = await configureCodexLbDesktopRouting({
  mode: 'disabled',
  home,
  configPath,
  authPath
})
const afterDisable = assertFastProfile(
  await fs.readFile(configPath, 'utf8'),
  'routing_disabled',
  false
)
const reenabled = await configureCodexLbDesktopRouting({
  mode: 'desktop-native-bridge',
  home,
  configPath,
  authPath,
  bridgeBaseUrl,
  remoteBaseUrl,
  gatewayAuthTransport: 'x-codex-lb-api-key'
})
const repair = await repairCodexLbAuth({
  home,
  configPath,
  envPath,
  forceCodexLbApiKeyAuth: true,
  forceFastMode: true,
  authMode: 'codex-lb'
})
await fs.writeFile(projectConfig, [
  '# SKS managed fixture',
  'default_profile = "sks-fast-high"',
  'service_tier = "fast"',
  '',
  '[user.fast_mode]',
  'visible = true',
  'enabled = true',
  '',
  '[profiles.sks-fast-high]',
  'model = "future-codex-model"',
  'service_tier = "fast"',
  ''
].join('\n'))
const split = await splitCodexProjectConfigPolicy(root, {
  apply: true,
  codexHome,
  configPath: projectConfig,
  writeReport: false
})
const structure = await repairCodexConfigStructure(configPath, { apply: true })
const final = assertFastProfile(await fs.readFile(configPath, 'utf8'), 'after_rewriters')
const toolCatalog = assertGpt56ToolCatalogContract()
const authPreserved = await fs.readFile(authPath, 'utf8') === oauth

const ok = setup.ok === true
  && native.ok === true
  && disabled.ok === true
  && reenabled.ok === true
  && !['failed', 'skipped_unsafe_rewrite', 'unparseable_config_preserved'].includes(String(fastOn.status))
  && repair.ok === true
  && split.ok === true
  && structure.ok === true
  && authPreserved
  && first.ok
  && afterDisable.ok
  && final.ok
  && toolCatalog.ok

const report = {
  schema: 'sks.codex-lb-gpt56-fast-profile-check.v2',
  ok,
  setup_status: setup.status,
  native_status: native.status,
  fast_on_status: fastOn.status,
  disable_status: disabled.status,
  reenable_status: reenabled.status,
  repair_status: repair.status,
  split_status: (split as any).status || null,
  structure_status: structure.status,
  oauth_preserved: authPreserved,
  assertions: [first, afterDisable, final],
  tool_catalog: toolCatalog,
  blockers: [
    ...(authPreserved ? [] : ['chatgpt_oauth_changed']),
    ...[first, afterDisable, final].flatMap((item) => item.blockers),
    ...toolCatalog.blockers
  ]
}

console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1

function assertFastProfile(
  text: string,
  label: string,
  expectBridge = true
) {
  const validation = validateCodexConfigRoundTrip(text)
  const parsed = validation.ok ? parseCodexConfigToml(text) : {}
  const provider = parsed.model_providers?.['codex-lb'] || {}
  const desktop = codexFastModeDesktopStatus(text)
  const blockers = [
    ...validation.blockers,
    ...(parsed.default_profile === undefined ? [] : ['default_profile_legacy_key_present']),
    ...(parsed.user?.fast_mode === undefined ? [] : ['user_fast_mode_legacy_table_present']),
    ...(parsed.profiles?.['sks-fast-high'] === undefined ? [] : ['sks_fast_high_legacy_profile_present']),
    ...(parsed.model === undefined ? [] : ['codex_app_model_was_injected']),
    ...(parsed.model_provider === 'openai' ? [] : ['desktop_model_provider_must_be_openai']),
    ...(provider.name === 'codex-lb' ? [] : ['codex_lb_cli_provider_name_mismatch']),
    ...(provider.requires_openai_auth === false ? [] : ['codex_lb_cli_requires_openai_auth_not_false']),
    ...(provider.env_key === 'CODEX_LB_API_KEY'
      ? []
      : ['codex_lb_cli_env_key_missing']),
    ...(provider.wire_api === 'responses' ? [] : ['codex_lb_wire_api_not_responses']),
    ...(expectBridge && parsed.openai_base_url === bridgeBaseUrl ? [] : expectBridge ? ['native_bridge_base_url_missing'] : []),
    ...(!expectBridge && parsed.openai_base_url !== undefined ? ['disabled_routing_still_has_openai_base_url'] : []),
    ...(parsed.model_catalog_json === undefined ? [] : ['native_local_catalog_must_not_be_bound']),
    ...(desktop.on ? [] : ['desktop_fast_status_off'])
  ]
  return {
    label,
    ok: blockers.length === 0,
    default_profile: parsed.default_profile || null,
    model: parsed.model || null,
    model_provider: parsed.model_provider || null,
    openai_base_url: parsed.openai_base_url || null,
    legacy_keys: validation.legacy_keys,
    service_tier: parsed.service_tier || null,
    provider_name: provider.name || null,
    provider_wire_api: provider.wire_api || null,
    provider_requires_openai_auth: provider.requires_openai_auth ?? null,
    blockers
  }
}

function assertGpt56ToolCatalogContract() {
  const normalized = normalizeCodexLbToolCatalog({
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map(codexModel)
  })
  const models = normalized.catalog.models.filter((model: any) => String(model.slug).startsWith('gpt-5.6-'))
  const blockers = [
    ...normalized.blockers,
    ...(normalized.schema === 'sks.codex-lb-tool-catalog.v1' ? [] : ['codex_lb_gpt56_catalog_schema_mismatch']),
    ...(normalized.contract === 'codex-model-catalog-pass-through.v2' ? [] : ['codex_lb_catalog_contract_not_v2']),
    ...(normalized.tools_transport === 'full_responses' ? [] : ['codex_lb_gpt56_native_tool_transport_not_full_responses']),
    ...(normalized.patched_models.join(',') === 'gpt-5.6-luna,gpt-5.6-sol,gpt-5.6-terra' ? [] : ['codex_lb_gpt56_catalog_patch_set_incomplete']),
    ...(models.length === 3 ? [] : ['codex_lb_gpt56_catalog_model_set_incomplete']),
    ...(models.every((model: any) => model.use_responses_lite === false) ? [] : ['codex_lb_gpt56_responses_lite_not_disabled']),
    ...(models.every((model: any) => model.future_unknown_field === 'preserved') ? [] : ['codex_lb_unknown_catalog_field_lost'])
  ]
  return {
    ok: blockers.length === 0,
    contract: normalized.contract,
    tools_transport: normalized.tools_transport,
    patched_models: normalized.patched_models,
    blockers
  }
}

function codexModel(slug: string) {
  return {
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
    use_responses_lite: true,
    minimal_client_version: 'runtime',
    future_unknown_field: 'preserved'
  }
}

async function toolOutputRecoveryFetch() {
  return new Response('{}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
    }
  })
}
