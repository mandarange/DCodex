import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BridgeProviderId,
  CapabilityEvidenceSource,
  CapabilityProbeResultV3,
  CapabilityScope,
  CombinedCatalogSyncStatus
} from '../bridge-contracts.js'
import { runDesktopCapabilityReportV3 } from '../capability-runner.js'
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js'

const checkedAt = '2026-08-05T16:00:00.000Z'
const context = {
  requestedLevel: 'transport' as const,
  checkedAt,
  reportId: 'report-matrix-001',
  correlationId: 'correlation-matrix-001',
  sessionId: 'session-matrix-001'
}

function result(
  scope: CapabilityScope,
  capability: string,
  source: CapabilityEvidenceSource,
  evidence: Record<string, unknown> = {}
): CapabilityProbeResultV3 {
  return capabilityProbeResultV3({
    ...context,
    scope,
    capability,
    stage: source === 'config' ? 'preflight' : 'complete',
    state: 'verified',
    source,
    evidence
  })
}

function routeResults(provider: BridgeProviderId): CapabilityProbeResultV3[] {
  return [
    result('bridge', 'runtime', 'config'),
    result('bridge', 'http_health', 'transport'),
    result('bridge', 'websocket_transport', 'transport'),
    result('native-identity', 'oauth_identity', 'config'),
    result('catalog:combined', 'route_policy', 'config'),
    result('catalog:combined', 'model_route', 'transport'),
    result(`provider:${provider}`, 'credential', 'config'),
    result(`provider:${provider}`, 'provider_auth', 'transport'),
    result(`provider:${provider}`, 'model_route', 'transport'),
    result(`provider:${provider}`, 'text_responses', 'transport')
  ]
}

function catalog(): CombinedCatalogSyncStatus {
  const provider = (providerId: BridgeProviderId) => ({
    schema: 'sks.catalog-sync-state.v2' as const,
    provider_id: providerId,
    state: 'verified' as const,
    source: providerId === 'codex-lb' ? 'gateway' as const : 'openrouter' as const,
    generation: `generation-${providerId}`,
    digest: 'a'.repeat(64),
    model_count: 2,
    checked_at: checkedAt,
    expires_at: null,
    blockers: [],
    warnings: [],
    recovery_action: null
  })
  return {
    schema: 'sks.combined-catalog-sync.v1',
    state: 'verified',
    generation: 'generation-combined',
    digest: 'b'.repeat(64),
    model_count: 4,
    route_count: 4,
    conflict_count: 0,
    checked_at: checkedAt,
    providers: { 'codex-lb': provider('codex-lb'), openrouter: provider('openrouter') },
    blockers: [],
    warnings: [],
    recovery_action: null
  }
}

test('transport evidence verifies routing while config and manifest cannot verify transport requirements', () => {
  const rows = routeResults('codex-lb').filter((entry) => entry.capability !== 'provider_auth')
  rows.push(result('provider:codex-lb', 'provider_auth', 'manifest', { advertised: true }))
  const report = runDesktopCapabilityReportV3({
    ...context,
    activeProviderIds: ['codex-lb'],
    catalogSync: catalog(),
    results: rows
  })
  const auth = report.providers['codex-lb'].capabilities.provider_auth!
  assert.equal(auth.state, 'not_attempted')
  assert.ok(auth.warnings.includes('non_live_evidence_cannot_verify'))
  assert.equal(report.summary.transport_level_satisfied, false)
})

test('fixture evidence remains not attempted even when the producer claims verified', () => {
  const rows = routeResults('codex-lb').filter((entry) => entry.capability !== 'text_responses')
  rows.push(result('provider:codex-lb', 'text_responses', 'transport', { fixture: true }))
  const report = runDesktopCapabilityReportV3({
    ...context,
    activeProviderIds: ['codex-lb'],
    catalogSync: catalog(),
    results: rows
  })
  const text = report.providers['codex-lb'].capabilities.text_responses!
  assert.equal(text.state, 'not_attempted')
  assert.ok(text.warnings.includes('non_live_evidence_cannot_verify'))
  assert.equal(report.summary.active_routes_ready, false)
})

test('binding mismatch makes otherwise verified evidence stale', () => {
  const rows = routeResults('codex-lb').filter((entry) => entry.capability !== 'provider_auth')
  rows.push({
    ...result('provider:codex-lb', 'provider_auth', 'transport'),
    report_id: 'report-matrix-stale'
  })
  const report = runDesktopCapabilityReportV3({
    ...context,
    activeProviderIds: ['codex-lb'],
    catalogSync: catalog(),
    results: rows
  })
  const auth = report.providers['codex-lb'].capabilities.provider_auth!
  assert.equal(auth.state, 'stale')
  assert.deepEqual(auth.blockers, ['capability_result_binding_mismatch'])
  assert.equal(auth.evidence.stale_result_rejected, true)
})

test('terminal probes expose one root cause and demote secondary diagnostics to warnings', () => {
  const failed = capabilityProbeResultV3({
    ...context,
    scope: 'bridge',
    capability: 'websocket_transport',
    stage: 'websocket_protocol',
    state: 'blocked',
    terminal: true,
    rootCause: 'desktop_bridge_websocket_protocol_failed',
    blockers: ['desktop_bridge_websocket_protocol_failed', 'secondary_socket_close_error'],
    source: 'transport',
    evidence: {}
  })
  assert.deepEqual(failed.blockers, ['desktop_bridge_websocket_protocol_failed'])
  assert.ok(failed.warnings.includes('secondary_diagnostic:secondary_socket_close_error'))
})

test('R43/catalog security: caller results cannot override authoritative catalog_sync truth', () => {
  const authoritative = catalog()
  authoritative.state = 'failed'
  authoritative.blockers = ['authoritative_catalog_failed']
  const forged = {
    ...result('catalog:combined', 'catalog_sync', 'transport'),
    attempt_id: 99
  }
  const report = runDesktopCapabilityReportV3({
    ...context,
    activeProviderIds: ['codex-lb'],
    catalogSync: authoritative,
    results: [...routeResults('codex-lb'), forged]
  })
  assert.equal(report.catalog_sync.state, 'failed')
  assert.equal(report.combined_catalog.capabilities.catalog_sync?.state, 'blocked')
  assert.deepEqual(report.combined_catalog.capabilities.catalog_sync?.blockers, ['authoritative_catalog_failed'])
})
