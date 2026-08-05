import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BridgeProviderId,
  CapabilityProbeResultV3,
  CapabilityProbeState,
  CapabilityScope,
  CapabilityProbeStage,
  CombinedCatalogSyncStatus
} from '../bridge-contracts.js'
import { runDesktopCapabilityReportV3 } from '../capability-runner.js'
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js'

const checkedAt = '2026-08-05T13:00:00.000Z'
const ids = {
  requestedLevel: 'transport' as const,
  checkedAt,
  reportId: 'report-scope-001',
  correlationId: 'correlation-scope-001',
  sessionId: 'session-scope-001'
}

function result(
  scope: CapabilityScope,
  capability: string,
  state: CapabilityProbeState = 'verified',
  blocker: string | null = null,
  stage: CapabilityProbeStage = 'complete'
): CapabilityProbeResultV3 {
  return capabilityProbeResultV3({
    ...ids,
    scope,
    capability,
    stage,
    state,
    terminal: Boolean(blocker),
    rootCause: blocker,
    blockers: blocker ? [blocker] : [],
    source: stage === 'preflight' ? 'config' : 'transport',
    evidence: {}
  })
}

function happyResults(provider: BridgeProviderId): CapabilityProbeResultV3[] {
  return [
    result('bridge', 'runtime', 'verified', null, 'process'),
    result('bridge', 'http_health'),
    result('bridge', 'websocket_transport'),
    result('native-identity', 'oauth_identity', 'verified', null, 'preflight'),
    result('catalog:combined', 'route_policy', 'verified', null, 'preflight'),
    result('catalog:combined', 'model_route', 'verified', null, 'model_route'),
    result(`provider:${provider}`, 'credential', 'verified', null, 'preflight'),
    result(`provider:${provider}`, 'provider_auth', 'verified', null, 'provider_auth'),
    result(`provider:${provider}`, 'model_route', 'verified', null, 'model_route'),
    result(`provider:${provider}`, 'text_responses', 'verified', null, 'feature_response')
  ]
}

function catalogSync(
  codexState: CombinedCatalogSyncStatus['state'] = 'verified',
  openRouterState: CombinedCatalogSyncStatus['state'] = 'verified'
): CombinedCatalogSyncStatus {
  const provider = (providerId: BridgeProviderId, state: CombinedCatalogSyncStatus['state']) => ({
    schema: 'sks.catalog-sync-state.v2' as const,
    provider_id: providerId,
    state,
    source: providerId === 'codex-lb' ? 'gateway' as const : 'openrouter' as const,
    generation: state === 'verified' ? `generation-${providerId}` : null,
    digest: state === 'verified' ? 'a'.repeat(64) : null,
    model_count: state === 'verified' ? 2 : null,
    checked_at: checkedAt,
    expires_at: null,
    blockers: state === 'failed' ? [`${providerId}_catalog_failed`] : [],
    warnings: [],
    recovery_action: state === 'failed' ? 'retry_catalog_sync' : null
  })
  return {
    schema: 'sks.combined-catalog-sync.v1',
    state: 'verified',
    generation: 'combined-generation',
    digest: 'b'.repeat(64),
    model_count: 4,
    route_count: 4,
    conflict_count: 0,
    checked_at: checkedAt,
    providers: {
      'codex-lb': provider('codex-lb', codexState),
      openrouter: provider('openrouter', openRouterState)
    },
    blockers: [],
    warnings: [],
    recovery_action: null
  }
}

test('inactive OpenRouter failure is a warning while the active Codex-LB route remains ready', () => {
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    enabledProviderIds: ['codex-lb', 'openrouter'],
    catalogSync: catalogSync('verified', 'failed'),
    results: happyResults('codex-lb')
  })
  assert.equal(report.execution.ok, true)
  assert.equal(report.summary.active_routes_ready, true)
  assert.equal(report.summary.transport_level_satisfied, true)
  assert.deepEqual(report.summary.blockers, [])
  assert.ok(report.summary.inactive_provider_failures.includes('openrouter:openrouter_catalog_failed'))
})

test('active provider auth failure blocks only the selected route', () => {
  const results = happyResults('codex-lb').filter((entry) => entry.capability !== 'provider_auth')
  results.push(result(
    'provider:codex-lb',
    'provider_auth',
    'blocked',
    'codex_lb_credential_rejected',
    'provider_auth'
  ))
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: catalogSync(),
    results
  })
  assert.equal(report.execution.ok, true)
  assert.equal(report.execution.status, 'completed')
  assert.equal(report.summary.active_routes_ready, false)
  assert.equal(report.summary.level_satisfied, false)
  assert.ok(report.summary.blockers.includes('codex_lb_credential_rejected'))
})

test('inactive Codex-LB auth failure does not lower an active OpenRouter route', () => {
  const results = happyResults('openrouter')
  results.push(result(
    'provider:codex-lb',
    'provider_auth',
    'blocked',
    'codex_lb_credential_rejected',
    'provider_auth'
  ))
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['openrouter'],
    enabledProviderIds: ['codex-lb', 'openrouter'],
    catalogSync: catalogSync(),
    results
  })
  assert.equal(report.summary.active_routes_ready, true)
  assert.equal(report.summary.transport_level_satisfied, true)
  assert.deepEqual(report.summary.blockers, [])
  assert.ok(report.summary.inactive_provider_failures.includes('codex-lb:codex_lb_credential_rejected'))
})

test('bridge failure propagates as a dependency without duplicating its terminal root cause', () => {
  const results = happyResults('codex-lb').filter((entry) => entry.capability !== 'websocket_transport')
  results.push(result(
    'bridge',
    'websocket_transport',
    'blocked',
    'desktop_bridge_websocket_upgrade_failed',
    'websocket_upgrade'
  ))
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: catalogSync(),
    results
  })
  const dependency = report.providers['codex-lb'].capabilities.bridge_dependency!
  assert.equal(report.summary.active_routes_ready, false)
  assert.deepEqual(report.summary.blockers, ['desktop_bridge_websocket_upgrade_failed'])
  assert.equal(dependency.root_cause, null)
  assert.deepEqual(dependency.blockers, ['bridge_dependency_unavailable'])
  assert.equal(dependency.evidence.upstream_root_cause, 'desktop_bridge_websocket_upgrade_failed')
})

test('stale Codex-LB deep evidence stays local while active OpenRouter deep readiness remains verified', () => {
  const deepIds = { ...ids, requestedLevel: 'deep' as const }
  const results: CapabilityProbeResultV3[] = happyResults('openrouter')
    .map((entry) => ({ ...entry, requested_level: 'deep' as const }))
  for (const capability of [
    'fast_mode',
    'image_generation',
    'computer_use',
    'browser_use',
    'voice_mode',
    'plugins',
    'auxiliary_surfaces'
  ]) {
    results.push(capabilityProbeResultV3({
      ...deepIds,
      scope: 'provider:openrouter',
      capability,
      stage: 'complete',
      state: 'verified',
      source: capability === 'image_generation' ? 'artifact' : 'deep_probe',
      evidence: {}
    }))
  }
  results.push(capabilityProbeResultV3({
    ...deepIds,
    scope: 'provider:codex-lb',
    capability: 'image_generation',
    stage: 'artifact_validation',
    state: 'stale',
    blockers: ['capability_deep_evidence_stale'],
    recoveryAction: 'run_deep_verification',
    source: 'artifact',
    evidence: {}
  }))
  const report = runDesktopCapabilityReportV3({
    ...deepIds,
    activeProviderIds: ['openrouter'],
    enabledProviderIds: ['codex-lb', 'openrouter'],
    catalogSync: catalogSync(),
    results
  })
  assert.equal(report.summary.active_routes_ready, true)
  assert.equal(report.summary.deep_level_satisfied, true)
  assert.equal(report.summary.level_satisfied, true)
  assert.equal(report.providers['codex-lb'].capabilities.image_generation!.state, 'stale')
  assert.ok(report.summary.inactive_provider_failures.includes('codex-lb:capability_deep_evidence_stale'))
  assert.deepEqual(report.summary.blockers, [])
})
