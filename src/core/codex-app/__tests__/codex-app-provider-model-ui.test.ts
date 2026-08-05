import assert from 'node:assert/strict'
import test from 'node:test'
import type { DesktopBridgeStatusV3 } from '../../codex-lb/bridge-contracts.js'
import { codexProviderModelUiStatus } from '../../codex-app.js'

test('provider UI consumes injected DesktopBridgeStatusV3 without inferring Codex config', async () => {
  const bridgeStatus = fixtureBridgeStatus({ selectedProvider: 'openrouter', ready: true })
  const status = await codexProviderModelUiStatus({
    desktopBridgeStatus: bridgeStatus,
    configPath: '/does/not/exist/config.toml',
    env: { CODEX_LB_API_KEY: 'must-not-be-read', OPENROUTER_API_KEY: 'must-not-be-read' }
  })

  assert.equal(status.schema, 'sks.codex-app-provider-model-ui.v2')
  assert.equal(status.verification_scope, 'desktop_bridge_status_v3')
  assert.equal(status.selected_provider, 'openrouter')
  assert.equal(status.effective_ready, true)
  assert.equal(status.providers, bridgeStatus.providers)
  assert.equal('glm' in status, false)
  assert.equal('codex_lb' in status, false)
  assert.deepEqual(status.ui_actions, [
    'sks bridge provider configure',
    'sks bridge provider validate',
    'sks bridge provider enable',
    'sks bridge catalog sync',
    'sks bridge route set-default'
  ])
})

test('provider UI reports only V3 bridge readiness and active-route blockers', async () => {
  const bridgeStatus = fixtureBridgeStatus({ selectedProvider: 'codex-lb', ready: false })
  bridgeStatus.readiness.blockers = ['bridge_service_not_running']
  bridgeStatus.routing.blockers = ['catalog_model_route_missing']
  bridgeStatus.providers['codex-lb'].credential.blockers = ['codex_lb_credential_unavailable']

  const status = await codexProviderModelUiStatus({ desktopBridgeStatus: bridgeStatus })

  assert.equal(status.selected_provider, 'codex-lb')
  assert.equal(status.effective_ready, false)
  assert.equal(status.readiness_state, 'blocked')
  assert.deepEqual(status.selected_provider_blockers, [
    'bridge_service_not_running',
    'catalog_model_route_missing',
    'codex_lb_credential_unavailable'
  ])
})

test('provider UI fails closed when the current bridge status is unavailable', async () => {
  const status = await codexProviderModelUiStatus({
    desktopBridgeStatusImpl: async () => {
      throw new Error('fixture unavailable')
    }
  })

  assert.equal(status.checked, false)
  assert.equal(status.effective_ready, false)
  assert.deepEqual(status.blockers, ['desktop_bridge_status_unavailable'])
})

function fixtureBridgeStatus(input: {
  selectedProvider: 'codex-lb' | 'openrouter'
  ready: boolean
}): DesktopBridgeStatusV3 {
  const checkedAt = '2026-08-06T00:00:00.000Z'
  const catalog = (providerId: 'codex-lb' | 'openrouter') => ({
    schema: 'sks.catalog-sync-state.v2' as const,
    provider_id: providerId,
    state: input.ready ? 'verified' as const : 'not_started' as const,
    source: providerId === 'codex-lb' ? 'gateway' as const : 'openrouter' as const,
    generation: input.ready ? 'catalog-test' : null,
    digest: input.ready ? 'digest-test' : null,
    model_count: input.ready ? 1 : null,
    checked_at: checkedAt,
    expires_at: null,
    blockers: [],
    warnings: [],
    recovery_action: null
  })
  const capability = (scope: 'provider:codex-lb' | 'provider:openrouter') => ({
    schema: 'sks.scope-capability-summary.v1' as const,
    scope,
    state: input.ready ? 'verified' as const : 'not_attempted' as const,
    checked_at: checkedAt,
    capabilities: {},
    blockers: [],
    warnings: []
  })
  const profile = (providerId: 'codex-lb' | 'openrouter') => ({
    schema: 'sks.bridge-provider-profile-status.v1' as const,
    provider_id: providerId,
    enabled: providerId === input.selectedProvider,
    credential: { state: input.ready ? 'ready' as const : 'configured_unverified' as const, source: 'fixture', fingerprint: 'sha256:fixture', checked_at: checkedAt, blockers: [], warnings: [] },
    endpoint: { configured: true, origin_redacted: 'https://example.test', auth_transport: providerId === 'codex-lb' ? 'authorization-bearer' as const : 'openrouter-bearer' as const },
    catalog: catalog(providerId),
    capabilities: capability(`provider:${providerId}`)
  })
  const policy = {
    schema: 'sks.bridge-routing-policy.v1' as const,
    default_provider_id: input.selectedProvider,
    fallback: 'none' as const,
    model_routes: { 'model-test': { provider_id: input.selectedProvider, upstream_model: 'model-test' } },
    catalog_generation: 'catalog-test',
    policy_generation: 'policy-test',
    changed_at: checkedAt
  }
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: checkedAt,
    correlation_id: 'status-test',
    management: { managed: true, runtime: 'desktop-bridge', state: input.ready ? 'ready' : 'blocked', reason: null },
    service: { state: input.ready ? 'ready' : 'blocked', installed: true, loaded: true, running: input.ready, loopback_origin: 'http://127.0.0.1:18765', pid: input.ready ? 123 : null, checked_at: checkedAt, blockers: [], warnings: [] },
    http_probe: null,
    websocket_probe: null,
    native_identity: { state: 'verified', configured: true, semantic_identity_preserved: null, checked_at: checkedAt, blockers: [], warnings: [] },
    providers: { 'codex-lb': profile('codex-lb'), openrouter: profile('openrouter') },
    routing: { policy, selected_model: null, selected_route: null, session_pin: null, fallback: 'none', blockers: [], warnings: [] },
    catalog_sync: {
      schema: 'sks.combined-catalog-sync.v1', state: input.ready ? 'verified' : 'not_started', generation: input.ready ? 'catalog-test' : null,
      digest: input.ready ? 'digest-test' : null, model_count: input.ready ? 1 : null, route_count: input.ready ? 1 : null,
      conflict_count: 0, checked_at: checkedAt, providers: { 'codex-lb': catalog('codex-lb'), openrouter: catalog('openrouter') },
      blockers: [], warnings: [], recovery_action: null
    },
    capabilities: null,
    readiness: { ready: input.ready, state: input.ready ? 'ready' : 'blocked', bridge_ready: input.ready, active_routes_ready: input.ready, combined_catalog_ready: input.ready, blockers: [], warnings: [] },
    recovery_actions: []
  }
}
