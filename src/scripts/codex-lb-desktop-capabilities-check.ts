#!/usr/bin/env node
import type {
  BridgeProviderId,
  CapabilityEvidenceSource,
  CapabilityProbeResultV3,
  CapabilityScope,
  CombinedCatalogSyncStatus
} from '../core/codex-lb/bridge-contracts.js'
import { runDesktopCapabilityReportV3 } from '../core/codex-lb/capability-runner.js'
import { capabilityProbeResultV3 } from '../core/codex-lb/probes/probe-evidence.js'
import { assertGate, emitGate } from './gate-lib.js'

const checkedAt = '2026-08-05T16:00:00.000Z'
const context = {
  requestedLevel: 'transport' as const,
  checkedAt,
  reportId: 'release-capability-check-001',
  correlationId: 'release-capability-correlation-001',
  sessionId: 'release-capability-session-001'
}

function result(
  scope: CapabilityScope,
  capability: string,
  source: CapabilityEvidenceSource = 'transport',
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

function routingResults(provider: BridgeProviderId): CapabilityProbeResultV3[] {
  return [
    result('bridge', 'runtime', 'config'),
    result('bridge', 'http_health'),
    result('bridge', 'websocket_transport'),
    result('native-identity', 'oauth_identity', 'config'),
    result('catalog:combined', 'route_policy', 'config'),
    result('catalog:combined', 'model_route'),
    result(`provider:${provider}`, 'credential', 'config'),
    result(`provider:${provider}`, 'provider_auth'),
    result(`provider:${provider}`, 'model_route'),
    result(`provider:${provider}`, 'text_responses')
  ]
}

function catalog(openRouterState: 'verified' | 'failed' = 'verified'): CombinedCatalogSyncStatus {
  const provider = (providerId: BridgeProviderId, state: 'verified' | 'failed') => ({
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
    state: openRouterState === 'failed' ? 'degraded' : 'verified',
    generation: 'generation-combined',
    digest: 'b'.repeat(64),
    model_count: 4,
    route_count: 4,
    conflict_count: 0,
    checked_at: checkedAt,
    providers: {
      'codex-lb': provider('codex-lb', 'verified'),
      openrouter: provider('openrouter', openRouterState)
    },
    blockers: [],
    warnings: [],
    recovery_action: null
  }
}

const advertisedRows = routingResults('codex-lb').filter((entry) => entry.capability !== 'provider_auth')
advertisedRows.push(result('provider:codex-lb', 'provider_auth', 'manifest', { advertised: true }))
const advertised = runDesktopCapabilityReportV3({
  ...context,
  activeProviderIds: ['codex-lb'],
  catalogSync: catalog(),
  results: advertisedRows
})

const fixtureRows = routingResults('codex-lb').filter((entry) => entry.capability !== 'text_responses')
fixtureRows.push(result('provider:codex-lb', 'text_responses', 'transport', { fixture: true }))
const fixture = runDesktopCapabilityReportV3({
  ...context,
  activeProviderIds: ['codex-lb'],
  catalogSync: catalog(),
  results: fixtureRows
})

const transport = runDesktopCapabilityReportV3({
  ...context,
  activeProviderIds: ['codex-lb'],
  enabledProviderIds: ['codex-lb', 'openrouter'],
  catalogSync: catalog('failed'),
  results: routingResults('codex-lb')
})

const invalidCatalog = runDesktopCapabilityReportV3({
  ...context,
  activeProviderIds: ['codex-lb'],
  catalogSync: undefined as unknown as CombinedCatalogSyncStatus,
  results: routingResults('codex-lb')
})

const advertisedNotVerified = advertised.providers['codex-lb'].capabilities.provider_auth?.state === 'not_attempted'
const fixtureNotVerified = fixture.providers['codex-lb'].capabilities.text_responses?.state === 'not_attempted'
const transportSatisfied = transport.summary.transport_level_satisfied
  && transport.summary.deep_level_satisfied === false
const inactiveProviderIsolated = transport.summary.active_routes_ready
  && transport.summary.inactive_provider_failures.includes('openrouter:openrouter_catalog_failed')
  && transport.summary.blockers.length === 0
const invalidCatalogFailsExecution = invalidCatalog.execution.status === 'failed'
  && invalidCatalog.execution.blockers.includes('capability_schema_invalid:catalog_sync_missing')

const report = {
  schema: 'sks.desktop-capabilities-check.v3',
  ok: advertisedNotVerified
    && fixtureNotVerified
    && transportSatisfied
    && inactiveProviderIsolated
    && invalidCatalogFailsExecution,
  advertised_not_verified: advertisedNotVerified,
  fixture_not_verified: fixtureNotVerified,
  transport_satisfied_without_deep: transportSatisfied,
  inactive_provider_isolated: inactiveProviderIsolated,
  invalid_catalog_fails_execution: invalidCatalogFailsExecution
}

assertGate(report.ok, 'desktop capability v3 evidence gate failed', report)
emitGate('desktop-capabilities:v3', report)
