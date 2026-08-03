#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  codexLbConfigPath,
  codexLbEnvPath,
  configureCodexLbDesktopRouting,
  ensureGlobalCodexFastModeDuringInstall,
  repairCodexLbAuth
} from '../cli/install-helpers.js'
import { escapeRegExp } from '../core/text/regex.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-fast-ui-'))
const home = path.join(tmp, 'home')
const codexHome = path.join(home, '.codex')
const configPath = codexLbConfigPath(home)
const envPath = codexLbEnvPath(home)
const authPath = path.join(codexHome, 'auth.json')
const remoteBaseUrl = 'https://lb.example.test/backend-api/codex'
const bridgeBaseUrl = 'http://127.0.0.1:54321/backend-api/codex'
await fs.mkdir(codexHome, { recursive: true })

const oauthAuth = `${JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: {
    id_token: 'oauth-id',
    access_token: 'oauth-access',
    refresh_token: 'oauth-refresh'
  },
  account_id: 'acct-fast-ui-fixture'
}, null, 2)}\n`

await fs.writeFile(configPath, [
  'model = "future-codex-model"',
  'model_reasoning_effort = "low"',
  'service_tier = "fast"',
  '# sks-codex-lb-managed-desktop-bridge',
  `openai_base_url = "${bridgeBaseUrl}"`,
  '',
  '[features]',
  'fast_mode = true',
  'fast_mode_ui = true',
  '',
  '[user.fast_mode]',
  'visible = true',
  'enabled = true',
  '',
  '[model_providers.codex-lb]',
  'name = "codex-lb"',
  `base_url = "${remoteBaseUrl}"`,
  'wire_api = "responses"',
  'env_key = "CODEX_LB_API_KEY"',
  'supports_websockets = true',
  'requires_openai_auth = false',
  ''
].join('\n'))
await fs.writeFile(
  envPath,
  `export CODEX_LB_BASE_URL="${remoteBaseUrl}"\nexport CODEX_LB_API_KEY="sk-test-fast-ui"\n`,
  { mode: 0o600 }
)
await fs.writeFile(authPath, oauthAuth)

const install = await ensureGlobalCodexFastModeDuringInstall({
  home,
  configPath,
  forceFastMode: true
})
const firstRepair = await repairCodexLbAuth({
  home,
  configPath,
  envPath,
  // Retired flags are intentionally supplied to prove they cannot re-couple
  // gateway credentials, shared OAuth, or Fast/UI state.
  forceCodexLbApiKeyAuth: true,
  forceFastMode: true,
  authMode: 'codex-lb'
})
const firstConfig = await fs.readFile(configPath, 'utf8')
const firstAuth = await fs.readFile(authPath, 'utf8')
const firstAssert = assertConfig(firstConfig, 'native_repair')

const disabled = await configureCodexLbDesktopRouting({
  mode: 'disabled',
  home,
  configPath,
  authPath
})
const disabledConfig = await fs.readFile(configPath, 'utf8')
const disabledAuth = await fs.readFile(authPath, 'utf8')
const disableAssert = assertConfig(disabledConfig, 'routing_disabled', {
  expectBridge: false
})

const reenabled = await configureCodexLbDesktopRouting({
  mode: 'desktop-native-bridge',
  home,
  configPath,
  authPath,
  bridgeBaseUrl,
  remoteBaseUrl,
  gatewayAuthTransport: 'x-codex-lb-api-key'
})
const reenabledConfig = await fs.readFile(configPath, 'utf8')
const reenabledAuth = await fs.readFile(authPath, 'utf8')
const reenableAssert = assertConfig(reenabledConfig, 'native_reenabled')

const authPreserved = [firstAuth, disabledAuth, reenabledAuth]
  .every((value) => value === oauthAuth)
const report = {
  schema: 'sks.codex-lb-fast-ui-preservation-check.v2',
  ok: firstRepair.ok === true
    && disabled.ok === true
    && reenabled.ok === true
    && authPreserved
    && firstAssert.ok
    && disableAssert.ok
    && reenableAssert.ok,
  install_status: install.status,
  first_repair_status: firstRepair.status,
  disable_status: disabled.status,
  reenable_status: reenabled.status,
  oauth_preserved: authPreserved,
  assertions: [firstAssert, disableAssert, reenableAssert],
  config_path: configPath,
  blockers: [
    ...(authPreserved ? [] : ['chatgpt_oauth_changed_during_routing_or_fast_repair']),
    ...firstAssert.blockers,
    ...disableAssert.blockers,
    ...reenableAssert.blockers
  ]
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1

function assertConfig(
  text: string,
  label: string,
  options: { expectBridge?: boolean } = {}
) {
  const expectBridge = options.expectBridge !== false
  const blockers = [
    ...(hasLegacyFastModeTables(text) ? ['legacy_fast_mode_tables_present'] : []),
    ...(tableKey(text, 'features', 'fast_mode') === 'true' ? [] : ['features_fast_mode_not_true']),
    ...(tableKey(text, 'features', 'fast_mode_ui') ? ['features_fast_mode_ui_legacy_flag_present'] : []),
    ...(hasTable(text, 'model_providers.codex-lb') ? [] : ['codex_lb_provider_table_missing']),
    ...(tableKey(text, 'model_providers.codex-lb', 'name') === 'codex-lb' ? [] : ['cli_provider_name_not_codex_lb']),
    ...(tableKey(text, 'model_providers.codex-lb', 'requires_openai_auth') === 'false' ? [] : ['cli_provider_requires_openai_auth_not_false']),
    ...(tableKey(text, 'model_providers.codex-lb', 'env_key') === 'CODEX_LB_API_KEY' ? [] : ['cli_provider_env_key_missing']),
    ...(topLevelKey(text, 'model_provider') === 'openai' ? [] : ['desktop_model_provider_must_be_openai']),
    ...(expectBridge && topLevelKey(text, 'openai_base_url') !== bridgeBaseUrl ? ['native_bridge_base_url_missing'] : []),
    ...(!expectBridge && topLevelKey(text, 'openai_base_url') ? ['disabled_routing_still_has_openai_base_url'] : []),
    ...(topLevelKey(text, 'model') === 'future-codex-model' ? [] : ['user_model_not_preserved']),
    ...(topLevelKey(text, 'model_reasoning_effort') === 'low' ? [] : ['user_reasoning_effort_not_preserved'])
  ]
  return { label, ok: blockers.length === 0, blockers }
}

function hasLegacyFastModeTables(text: string) {
  return hasTable(text, 'user.fast_mode') || hasTable(text, 'profiles.sks-fast-high')
}

function hasTable(text: string, table: string) {
  return new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\](?=\\n|$)`).test(text)
}

function tableKey(text: string, table: string, key: string) {
  const match = text.match(new RegExp(`(^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`))
  const block = match?.[2] || ''
  return block.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*([^\\n#]+)`))?.[2]?.trim().replace(/^"|"$/g, '') || ''
}

function topLevelKey(text: string, key: string) {
  const top = text.split(/\n\s*\[/)[0] || ''
  return top.match(new RegExp(`(^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*([^\\n#]+)`))?.[2]?.trim().replace(/^"|"$/g, '') || ''
}
