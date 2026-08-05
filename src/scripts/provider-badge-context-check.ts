#!/usr/bin/env node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { DesktopBridgeStatusV3 } from '../core/codex-lb/bridge-contracts.js'
import { providerBadgeText, providerPaneLabel } from '../core/provider/provider-badge.js'
import { resolveProviderContext } from '../core/provider/provider-context.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-badge-'))
const codexHome = path.join(root, '.codex-home')
await fs.mkdir(codexHome, { recursive: true })
await fs.writeFile(path.join(codexHome, 'auth.json'), '{"account_id":"acct_fixture"}\n')

const bridge = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root, CODEX_LB_API_KEY: 'lb-fixture' } as any,
  route: '$Naruto',
  serviceTier: 'fast',
  desktopBridgeStatus: bridgeStatus('codex-lb')
})
const openai = await resolveProviderContext({
  root,
  codexHome,
  env: { OPENAI_API_KEY: 'sk-fixture', HOME: root } as any,
  serviceTier: 'fast',
  desktopBridgeStatus: unmanagedStatus()
})
const app = await resolveProviderContext({
  root,
  codexHome,
  env: { HOME: root } as any,
  serviceTier: 'standard',
  desktopBridgeStatus: unmanagedStatus()
})

const checks = {
  bridge_badge: providerBadgeText(bridge) === 'Provider: Desktop Bridge → codex-lb · Fast',
  bridge_pane: providerPaneLabel(bridge) === 'fast · desktop-bridge/codex-lb',
  openai_badge: providerBadgeText(openai) === 'Provider: OpenAI API · Fast',
  oauth_badge: providerBadgeText(app) === 'Provider: Codex App OAuth · Standard'
}
const ok = Object.values(checks).every(Boolean)
emit({ schema: 'sks.provider-badge-context-check.v2', ok, checks, bridge, openai, app, blockers: ok ? [] : ['provider_badge_context_check_failed'] })

function bridgeStatus(provider: 'codex-lb' | 'openrouter'): DesktopBridgeStatusV3 {
  return {
    schema: 'sks.desktop-bridge-status.v3',
    management: { managed: true, runtime: 'desktop-bridge', state: 'ready', reason: null },
    native_identity: { configured: true },
    providers: {
      'codex-lb': { credential: { state: provider === 'codex-lb' ? 'ready' : 'not_configured' } },
      openrouter: { credential: { state: provider === 'openrouter' ? 'ready' : 'not_configured' } }
    },
    routing: { policy: { default_provider_id: provider }, selected_route: null, session_pin: null, blockers: [] },
    readiness: { ready: true, blockers: [] }
  } as unknown as DesktopBridgeStatusV3
}

function unmanagedStatus(): DesktopBridgeStatusV3 {
  return {
    schema: 'sks.desktop-bridge-status.v3',
    management: { managed: false, runtime: null, state: 'not_installed', reason: 'never_configured' },
    native_identity: { configured: true },
    providers: {},
    routing: { policy: null, selected_route: null, session_pin: null, blockers: [] },
    readiness: { ready: false, blockers: [] }
  } as unknown as DesktopBridgeStatusV3
}

function emit(report: Record<string, unknown>) {
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}
