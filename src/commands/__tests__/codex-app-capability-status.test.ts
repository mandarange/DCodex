import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesktopBridgeStatusV3 } from '../../core/codex-lb/bridge-contracts.js'
import { codexAppStatusWithCodexLbCapabilities } from '../codex-app.js'

test('ordinary Codex App status injects the current DesktopBridgeStatusV3', async () => {
  let integrationInput: Record<string, unknown> | null = null
  const bridgeStatus = fixtureBridgeStatus()
  const result = await codexAppStatusWithCodexLbCapabilities({
    codexLbStatusImpl: async () => bridgeStatus,
    codexAppStatusImpl: async (input: Record<string, unknown>) => {
      integrationInput = input
      return {
        ok: true,
        desktopBridgeStatus: input.desktopBridgeStatus,
        features: { codex_lb_capabilities: input.codexLbCapabilityReport }
      }
    }
  })

  assert.equal(result.desktopBridgeStatus, bridgeStatus)
  assert.equal((integrationInput as unknown as Record<string, unknown>).desktopBridgeStatus, bridgeStatus)
  const report = (result.features as Record<string, unknown>).codex_lb_capabilities as Record<string, unknown>
  assert.equal(report.availability, 'reported')
  assert.equal(report.runtime, 'desktop-bridge')
  assert.equal(report.overall, 'verified')
  assert.equal(report.full_capability_verified, true)
})

test('ordinary Codex App status clearly reports bridge evidence as unavailable', async () => {
  const result = await codexAppStatusWithCodexLbCapabilities({
    codexLbStatusImpl: async () => {
      throw new Error('status unavailable')
    },
    codexAppStatusImpl: async (input: Record<string, unknown>) => input
  })
  const report = result.codexLbCapabilityReport as Record<string, unknown>
  assert.equal(result.desktopBridgeStatus, null)
  assert.equal(report.availability, 'unavailable')
  assert.deepEqual(report.blockers, ['codex_lb_capability_report_unavailable'])
})

function fixtureBridgeStatus(): DesktopBridgeStatusV3 {
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: '2026-08-06T00:00:00.000Z',
    correlation_id: 'status-test',
    management: { managed: true, runtime: 'desktop-bridge', state: 'ready', reason: null },
    service: { state: 'ready', installed: true, loaded: true, running: true, loopback_origin: 'http://127.0.0.1:18765', pid: 123, checked_at: '2026-08-06T00:00:00.000Z', blockers: [], warnings: [] },
    http_probe: null,
    websocket_probe: null,
    native_identity: { state: 'verified', configured: true, semantic_identity_preserved: null, checked_at: '2026-08-06T00:00:00.000Z', blockers: [], warnings: [] },
    providers: {} as DesktopBridgeStatusV3['providers'],
    routing: { policy: null, selected_model: null, selected_route: null, session_pin: null, fallback: 'none', blockers: [], warnings: [] },
    catalog_sync: {} as DesktopBridgeStatusV3['catalog_sync'],
    capabilities: {
      schema: 'sks.desktop-capabilities.v3',
      report_id: 'report-test',
      correlation_id: 'status-test',
      session_id: 'session-test',
      requested_level: 'transport',
      checked_at: '2026-08-06T00:00:00.000Z',
      catalog_generation: 'catalog-test',
      execution: { ok: true, status: 'completed', blockers: [] },
      bridge: {} as DesktopBridgeStatusV3['capabilities'] extends infer T ? any : never,
      native_identity: {} as any,
      providers: {} as any,
      combined_catalog: {} as any,
      summary: { bridge_ready: true, active_routes_ready: true, level_satisfied: true, transport_level_satisfied: true, deep_level_satisfied: false, full_feature_verified: true, inactive_provider_failures: [], blockers: [], warnings: [] },
      catalog_sync: {} as any
    },
    readiness: { ready: true, state: 'ready', bridge_ready: true, active_routes_ready: true, combined_catalog_ready: true, blockers: [], warnings: [] },
    recovery_actions: []
  }
}
