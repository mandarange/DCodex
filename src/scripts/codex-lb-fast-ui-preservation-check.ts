#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  codexLbConfigPath,
  codexLbEnvPath,
  ensureGlobalCodexFastModeDuringInstall,
  releaseCodexLbAuthHold,
  repairCodexLbAuth
} from '../cli/install-helpers.js'
import { escapeRegExp } from '../core/text/regex.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-fast-ui-'))
const home = path.join(tmp, 'home')
const codexHome = path.join(home, '.codex')
const configPath = codexLbConfigPath(home)
const envPath = codexLbEnvPath(home)
const authPath = path.join(codexHome, 'auth.json')
const oauthBackupPath = path.join(codexHome, 'auth.chatgpt-backup.json')
await fs.mkdir(codexHome, { recursive: true })

const oauthAuth = JSON.stringify({
  auth_mode: 'chatgpt',
  tokens: { id_token: 'oauth-id', access_token: 'oauth-access', refresh_token: 'oauth-refresh' },
  account_id: 'acct-fast-ui-fixture'
}, null, 2)

await fs.writeFile(configPath, [
  'model = "future-codex-model"',
  'model_reasoning_effort = "low"',
  'model_provider = "codex-lb"',
  'service_tier = "fast"',
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
  'name = "openai"',
  'base_url = "https://lb.example.test/backend-api/codex"',
  'wire_api = "responses"',
  'env_key = "CODEX_LB_API_KEY"',
  'supports_websockets = true',
  'requires_openai_auth = false',
  ''
].join('\n'))
await fs.writeFile(envPath, 'export CODEX_LB_BASE_URL="https://lb.example.test/backend-api/codex"\nexport CODEX_LB_API_KEY="sk-test-fast-ui"\n')
await fs.writeFile(authPath, `${oauthAuth}\n`)
const toolOutputRecoveryFetch = async () => new Response('{}', {
  status: 200,
  headers: {
    'content-type': 'application/json',
    'x-app-version': '1.21.0-beta.3'
  }
})

const install = await ensureGlobalCodexFastModeDuringInstall({ home, configPath, forceFastMode: true })
const firstRepair = await repairCodexLbAuth({ home, configPath, envPath, forceCodexLbApiKeyAuth: true, forceFastMode: true, authMode: 'codex-lb', toolOutputRecoveryFetch })
const firstConfig = await fs.readFile(configPath, 'utf8')
const firstAssert = assertConfig(firstConfig, 'first_use_codex_lb')

const release = await releaseCodexLbAuthHold({ home, configPath, authPath, backupPath: oauthBackupPath })
const releasedConfig = await fs.readFile(configPath, 'utf8')
const releaseAssert = {
  label: 'use_oauth',
  ok: !topLevelKey(releasedConfig, 'model_provider') && !hasLegacyFastModeTables(releasedConfig),
  blockers: [
    ...(topLevelKey(releasedConfig, 'model_provider') ? ['model_provider_still_selected_after_use_oauth'] : []),
    ...(hasLegacyFastModeTables(releasedConfig) ? ['legacy_fast_mode_tables_survived_use_oauth'] : [])
  ]
}

const secondRepair = await repairCodexLbAuth({ home, configPath, envPath, forceCodexLbApiKeyAuth: true, forceFastMode: true, authMode: 'codex-lb', toolOutputRecoveryFetch })
const secondConfig = await fs.readFile(configPath, 'utf8')
const secondAssert = assertConfig(secondConfig, 'second_use_codex_lb')

const report = {
  schema: 'sks.codex-lb-fast-ui-preservation-check.v1',
  ok: firstAssert.ok && releaseAssert.ok && secondAssert.ok,
  install_status: install.status,
  first_repair_status: firstRepair.status,
  release_status: release.status,
  second_repair_status: secondRepair.status,
  assertions: [firstAssert, releaseAssert, secondAssert],
  config_path: configPath,
  blockers: [...firstAssert.blockers, ...releaseAssert.blockers, ...secondAssert.blockers]
}
console.log(JSON.stringify(report, null, 2))
if (!report.ok) process.exitCode = 1

function assertConfig(text: string, label: string) {
  const blockers = [
    ...(hasLegacyFastModeTables(text) ? ['legacy_fast_mode_tables_present'] : []),
    ...(tableKey(text, 'features', 'fast_mode') === 'true' ? [] : ['features_fast_mode_not_true']),
    ...(tableKey(text, 'features', 'fast_mode_ui') ? ['features_fast_mode_ui_legacy_flag_present'] : []),
    ...(hasTable(text, 'model_providers.codex-lb') ? [] : ['codex_lb_provider_table_missing']),
    ...(tableKey(text, 'model_providers.codex-lb', 'requires_openai_auth') === 'true' ? [] : ['requires_openai_auth_not_true']),
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
