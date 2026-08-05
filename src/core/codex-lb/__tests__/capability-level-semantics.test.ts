import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { sha256 } from '../../fsx.js'
import type {
  BridgeProviderId,
  CapabilityProbeResultV3,
  CapabilityScope,
  CombinedCatalogSyncStatus
} from '../bridge-contracts.js'
import {
  adaptDesktopCapabilityReportV3ToV2,
  runDesktopCapabilityReportV3
} from '../capability-runner.js'
import { runImageGenerationProbeV3 } from '../probes/image-generation-probe.js'
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js'
import {
  CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
  CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA,
  capabilityDeepEvidenceContentSha256V2,
  validateCapabilityDeepEvidenceV2,
  type CapabilityDeepEvidenceTrustAnchorV2,
  type CapabilityTrustedDeepEvidenceEnvelopeV2
} from '../trusted-deep-evidence.js'

const checkedAt = '2026-08-05T14:00:00.000Z'
const ids = {
  requestedLevel: 'transport' as const,
  checkedAt,
  reportId: 'report-level-001',
  correlationId: 'correlation-level-001',
  sessionId: 'session-level-001'
}

function probe(
  scope: CapabilityScope,
  capability: string,
  source: CapabilityProbeResultV3['source'] = 'transport',
  evidence: Record<string, unknown> = {}
): CapabilityProbeResultV3 {
  return capabilityProbeResultV3({
    ...ids,
    scope,
    capability,
    stage: source === 'config' ? 'preflight' : 'complete',
    state: 'verified',
    source,
    evidence
  })
}

function transportResults(provider: BridgeProviderId): CapabilityProbeResultV3[] {
  return [
    probe('bridge', 'runtime', 'config'),
    probe('bridge', 'http_health'),
    probe('bridge', 'websocket_transport'),
    probe('native-identity', 'oauth_identity', 'config'),
    probe('catalog:combined', 'route_policy', 'config'),
    probe('catalog:combined', 'model_route'),
    probe(`provider:${provider}`, 'credential', 'config'),
    probe(`provider:${provider}`, 'provider_auth'),
    probe(`provider:${provider}`, 'model_route'),
    probe(`provider:${provider}`, 'text_responses')
  ]
}

function verifiedCatalog(): CombinedCatalogSyncStatus {
  const provider = (providerId: BridgeProviderId) => ({
    schema: 'sks.catalog-sync-state.v2' as const,
    provider_id: providerId,
    state: 'verified' as const,
    source: providerId === 'codex-lb' ? 'gateway' as const : 'openrouter' as const,
    generation: `generation-${providerId}`,
    digest: 'a'.repeat(64),
    model_count: 2,
    checked_at: checkedAt,
    expires_at: '2026-08-05T15:00:00.000Z',
    blockers: [],
    warnings: [],
    recovery_action: null
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
    providers: { 'codex-lb': provider('codex-lb'), openrouter: provider('openrouter') },
    blockers: [],
    warnings: [],
    recovery_action: null
  }
}

test('transport can be satisfied while deep-only capabilities remain not attempted', () => {
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results: transportResults('codex-lb')
  })
  assert.equal(report.execution.ok, true)
  assert.equal(report.execution.status, 'completed')
  assert.equal(report.summary.transport_level_satisfied, true)
  assert.equal(report.summary.level_satisfied, true)
  assert.equal(report.summary.deep_level_satisfied, false)
  assert.equal(report.summary.full_feature_verified, false)
  assert.equal(report.correlation_id, ids.correlationId)
  assert.equal(report.session_id, ids.sessionId)
  assert.equal(report.catalog_generation, 'combined-generation')
  assert.equal(report.providers['codex-lb'].state, 'verified')
  assert.equal(report.providers['codex-lb'].capabilities.image_generation!.state, 'not_attempted')
  assert.equal(report.providers['codex-lb'].capabilities.image_generation!.recovery_action, 'run_deep_verification')
  assert.equal(report.summary.blockers.includes('codex_lb_deep_evidence_missing'), false)
})

test('scope summaries are deterministic across probe arrival order', () => {
  const results = transportResults('codex-lb')
  const forward = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results
  })
  const reverse = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results: [...results].reverse()
  })
  assert.deepEqual(reverse.bridge, forward.bridge)
  assert.deepEqual(reverse.native_identity, forward.native_identity)
  assert.deepEqual(reverse.providers, forward.providers)
  assert.deepEqual(reverse.combined_catalog, forward.combined_catalog)
  assert.deepEqual(reverse.summary, forward.summary)
})

test('level_satisfied follows the requested shallow level without overclaiming transport', () => {
  const shallowIds = { ...ids, requestedLevel: 'shallow' as const }
  const report = runDesktopCapabilityReportV3({
    ...shallowIds,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results: transportResults('codex-lb').map((entry) => ({
      ...entry,
      requested_level: 'shallow' as const
    }))
  })
  assert.equal(report.summary.level_satisfied, true)
  assert.equal(report.summary.transport_level_satisfied, false)
  assert.equal(report.summary.deep_level_satisfied, false)
  assert.equal(report.bridge.capabilities.http_health!.state, 'not_attempted')
})

test('the v2 adapter preserves verified facts but never invents legacy deep trust', () => {
  const v3 = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results: transportResults('codex-lb')
  })
  const v2 = adaptDesktopCapabilityReportV3ToV2(v3, {
    mode: 'desktop-native-bridge',
    configured: true,
    oauthPreserved: true
  })
  assert.equal(v2.bridge.state, 'verified')
  assert.equal(v2.catalog.state, 'verified')
  assert.equal(v2.image_generation.state, 'available_unverified')
  assert.equal(v2.deep_evidence_validation.trusted, false)
  assert.equal(v2.deep_evidence_validation.state, 'available_unverified')
})

test('catalog_sync omission is an execution schema failure, not state-not-reported success', () => {
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: undefined as unknown as CombinedCatalogSyncStatus,
    results: transportResults('codex-lb')
  })
  assert.equal(report.execution.ok, false)
  assert.equal(report.execution.status, 'failed')
  assert.ok(report.execution.blockers.includes('capability_schema_invalid:catalog_sync_missing'))
  assert.equal(report.catalog_sync.state, 'failed')
})

test('manifest, fixture, and below-level claims cannot become verified', () => {
  const advertised = probe(
    'provider:codex-lb',
    'image_generation',
    'manifest',
    { advertised: true, fixture: true }
  )
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results: [...transportResults('codex-lb'), advertised]
  })
  const image = report.providers['codex-lb'].capabilities.image_generation!
  assert.equal(image.state, 'not_attempted')
  assert.equal(image.root_cause, null)
  assert.deepEqual(image.blockers, [])
  assert.ok(image.warnings.includes('non_live_evidence_cannot_verify'))
})

test('stale active route evidence is never current verified readiness', () => {
  const results = transportResults('codex-lb').filter((entry) => entry.capability !== 'model_route')
  results.push({
    ...probe('provider:codex-lb', 'model_route'),
    state: 'stale',
    blockers: ['route_receipt_stale'],
    recovery_action: 'refresh_catalog_or_select_supported_model'
  })
  const report = runDesktopCapabilityReportV3({
    ...ids,
    activeProviderIds: ['codex-lb'],
    catalogSync: verifiedCatalog(),
    results
  })
  assert.equal(report.providers['codex-lb'].capabilities.model_route!.state, 'stale')
  assert.equal(report.summary.active_routes_ready, false)
  assert.ok(report.summary.blockers.includes('route_receipt_stale'))
})

test('image deep verification requires a real artifact whose digest matches', () => {
  const root = mkdtempSync(join(tmpdir(), 'sks-capability-image-'))
  try {
    const artifactPath = join(root, 'image.png')
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4OQAAAAASUVORK5CYII=',
      'base64'
    )
    writeFileSync(artifactPath, bytes)
    const nonImagePath = join(root, 'not-an-image.bin')
    const nonImageBytes = Buffer.from('not-an-image')
    writeFileSync(nonImagePath, nonImageBytes)
    const deepIds = { ...ids, requestedLevel: 'deep' as const, providerId: 'codex-lb' as const }
    const fixture = runImageGenerationProbeV3({
      ...deepIds,
      attempted: true,
      fixture: true,
      outputEventSeen: true,
      artifactPath,
      artifactSha256: sha256(bytes)
    })
    const mismatch = runImageGenerationProbeV3({
      ...deepIds,
      attempted: true,
      outputEventSeen: true,
      artifactPath,
      artifactSha256: '0'.repeat(64)
    })
    const nonImage = runImageGenerationProbeV3({
      ...deepIds,
      attempted: true,
      outputEventSeen: true,
      artifactPath: nonImagePath,
      artifactSha256: sha256(nonImageBytes)
    })
    const verified = runImageGenerationProbeV3({
      ...deepIds,
      attempted: true,
      outputEventSeen: true,
      artifactPath,
      artifactSha256: sha256(bytes)
    })
    assert.equal(fixture.state, 'not_attempted')
    assert.equal(mismatch.state, 'blocked')
    assert.equal(mismatch.root_cause, 'image_artifact_digest_mismatch')
    assert.equal(nonImage.root_cause, 'image_artifact_format_invalid')
    assert.equal(verified.state, 'verified')
    assert.equal(verified.source, 'artifact')
    assert.equal(verified.evidence.artifact_sha256, sha256(bytes))
    assert.equal(verified.evidence.artifact_format, 'png')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deep trust binds provider, capability, report, freshness, and redacts key-like evidence', () => {
  const content = {
    schema: CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA,
    producer: { id: 'sks.deep-probe', version: '1.0.0', run_id: 'run-deep-001' },
    created_at: checkedAt,
    target: {
      provider_id: 'codex-lb' as const,
      capability: 'image_generation',
      report_id: ids.reportId
    },
    payload: {
      artifact_validated: true,
      api_key: 'sk-sensitive-value-12345678',
      error_preview: 'Authorization: Bearer sk-sensitive-value-12345678'
    }
  }
  const digest = capabilityDeepEvidenceContentSha256V2(content)
  const envelope: CapabilityTrustedDeepEvidenceEnvelopeV2 = {
    ...content,
    integrity: { algorithm: 'sha256', content_sha256: digest, trust_anchor_id: 'anchor.deep-001' }
  }
  const anchor: CapabilityDeepEvidenceTrustAnchorV2 = {
    schema: CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
    anchor_id: envelope.integrity.trust_anchor_id,
    producer: envelope.producer,
    target: envelope.target,
    content_sha256: digest
  }
  const verified = validateCapabilityDeepEvidenceV2(envelope, {
    expectedProviderId: 'codex-lb',
    expectedCapability: 'image_generation',
    expectedReportId: ids.reportId,
    trustAnchors: [anchor],
    now: checkedAt
  })
  const mismatched = validateCapabilityDeepEvidenceV2(envelope, {
    expectedProviderId: 'openrouter',
    expectedCapability: 'image_generation',
    expectedReportId: ids.reportId,
    trustAnchors: [anchor],
    now: checkedAt
  })
  const stale = validateCapabilityDeepEvidenceV2(envelope, {
    expectedProviderId: 'codex-lb',
    expectedCapability: 'image_generation',
    expectedReportId: ids.reportId,
    trustAnchors: [anchor],
    now: '2026-08-05T15:00:01.000Z'
  })
  assert.equal(verified.state, 'verified')
  assert.equal(verified.evidence?.api_key, '[REDACTED]')
  assert.equal(String(verified.evidence?.error_preview).includes('sensitive-value'), false)
  assert.equal(mismatched.state, 'blocked')
  assert.ok(mismatched.blockers.includes('capability_deep_evidence_provider_mismatch'))
  assert.equal(stale.state, 'stale')
  assert.ok(stale.blockers.includes('capability_deep_evidence_stale'))
})
