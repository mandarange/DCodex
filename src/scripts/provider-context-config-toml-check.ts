#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BridgeProviderId, DesktopBridgeStatusV3 } from '../core/codex-lb/bridge-contracts.js'
import { resolveProviderContext } from '../core/provider/provider-context.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-context-'))
const codexHome = path.join(root, '.codex')
await fs.mkdir(codexHome, { recursive: true })
await fs.writeFile(path.join(codexHome, 'auth.json'), '{"account_id":"acct_fixture"}\n')
// Historical direct-provider config is test input only. Current context must
// ignore it and report the Desktop Bridge status contract instead.
await fs.writeFile(path.join(codexHome, 'config.toml'), [
  'model_provider = "codex-lb"',
  '[model_providers.codex-lb]',
  'env_key = "CODEX_LB_API_KEY"',
  ''
].join('\n'))

const bridge = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root, OPENAI_API_KEY: 'openai-fixture', CODEX_LB_API_KEY: 'lb-fixture' } as any,
  route: '$Naruto',
  serviceTier: 'fast',
  desktopBridgeStatus: bridgeStatus({ managed: true, ready: true, provider: 'codex-lb' })
})
const openai = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root, OPENAI_API_KEY: 'openai-fixture' } as any,
  desktopBridgeStatus: bridgeStatus({ managed: false, ready: false, provider: null })
})
const oauth = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root } as any,
  desktopBridgeStatus: bridgeStatus({ managed: false, ready: false, provider: null })
})
const blocked = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root } as any,
  desktopBridgeStatus: bridgeStatus({ managed: true, ready: false, provider: 'openrouter', blockers: ['bridge_service_not_running'] })
})

const checks = {
  bridge_runtime_not_direct_provider: bridge.provider === 'desktop-bridge' && bridge.source === 'desktop_bridge',
  bridge_route_provider_reported: bridge.signals.desktop_bridge_provider === 'codex-lb',
  oauth_identity_preserved: bridge.auth_mode === 'chatgpt_oauth' && bridge.signals.desktop_bridge_native_identity_configured,
  coexisting_keys_not_conflict: bridge.conflict === false,
  openai_api_identity_preserved: openai.provider === 'openai' && openai.auth_mode === 'api_key',
  codex_app_oauth_identity_preserved: oauth.provider === 'codex-app' && oauth.auth_mode === 'chatgpt_oauth',
  bridge_blocker_propagated: blocked.provider === 'desktop-bridge' && blocked.warnings.includes('bridge_service_not_running')
}
const ok = Object.values(checks).every(Boolean)

emit({
  schema: 'sks.provider-context-config-toml-check.v2',
  ok,
  checks,
  cases: { bridge, openai, oauth, blocked },
  blockers: ok ? [] : Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name)
})

function bridgeStatus(input: {
  managed: boolean
  ready: boolean
  provider: BridgeProviderId | null
  blockers?: string[]
}): DesktopBridgeStatusV3 {
  const profile = (providerId: BridgeProviderId) => ({
    credential: { state: input.provider === providerId ? 'ready' : 'not_configured' }
  })
  return {
    schema: 'sks.desktop-bridge-status.v3',
    management: input.managed
      ? { managed: true, runtime: 'desktop-bridge', state: input.ready ? 'ready' : 'blocked', reason: null }
      : { managed: false, runtime: null, state: 'not_installed', reason: 'never_configured' },
    native_identity: { configured: true },
    providers: { 'codex-lb': profile('codex-lb'), openrouter: profile('openrouter') },
    routing: {
      policy: input.provider ? { default_provider_id: input.provider } : null,
      selected_route: null,
      session_pin: null,
      blockers: []
    },
    readiness: { ready: input.ready, blockers: input.blockers || [] }
  } as unknown as DesktopBridgeStatusV3
}

function emit(report: Record<string, unknown>) {
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}
