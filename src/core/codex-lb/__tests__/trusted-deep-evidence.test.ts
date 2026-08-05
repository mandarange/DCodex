import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
  CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA,
  capabilityDeepEvidenceContentSha256V2,
  validateCapabilityDeepEvidenceV2,
  type CapabilityDeepEvidenceTrustAnchorV2,
  type CapabilityTrustedDeepEvidenceEnvelopeV2,
  type ValidateCapabilityDeepEvidenceOptionsV2
} from '../trusted-deep-evidence.js'

const createdAt = '2026-08-05T14:00:00.000Z'
const target = {
  provider_id: 'codex-lb' as const,
  scope: 'provider:codex-lb' as const,
  capability: 'image_generation',
  report_id: 'report-trust-001',
  catalog_generation: 'generation-001',
  endpoint: 'https://gateway.example.test/v1'
}
const producer = { id: 'sks.deep-probe', version: '1.0.0', run_id: 'run-trust-001' }

function signed(payload: Record<string, unknown> = { artifact_validated: true }): {
  envelope: CapabilityTrustedDeepEvidenceEnvelopeV2
  anchor: CapabilityDeepEvidenceTrustAnchorV2
} {
  const content = {
    schema: CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA,
    producer,
    created_at: createdAt,
    target,
    payload
  }
  const digest = capabilityDeepEvidenceContentSha256V2(content)
  const envelope: CapabilityTrustedDeepEvidenceEnvelopeV2 = {
    ...content,
    integrity: {
      algorithm: 'sha256',
      content_sha256: digest,
      trust_anchor_id: 'anchor.trust-001'
    }
  }
  return {
    envelope,
    anchor: {
      schema: CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
      anchor_id: envelope.integrity.trust_anchor_id,
      producer,
      target,
      content_sha256: digest
    }
  }
}

function options(anchor?: CapabilityDeepEvidenceTrustAnchorV2): ValidateCapabilityDeepEvidenceOptionsV2 {
  return {
    expectedProviderId: 'codex-lb',
    expectedScope: 'provider:codex-lb',
    expectedCapability: 'image_generation',
    expectedReportId: target.report_id,
    expectedCatalogGeneration: target.catalog_generation,
    expectedEndpoint: target.endpoint,
    trustAnchors: anchor ? [anchor] : [],
    now: createdAt
  }
}

test('trusted evidence verifies only for its current provider scope, generation, endpoint, and report', () => {
  const { envelope, anchor } = signed({
    artifact_validated: true,
    authorization: 'Bearer sk-sensitive-value-12345678'
  })
  const result = validateCapabilityDeepEvidenceV2(envelope, options(anchor))
  assert.equal(result.state, 'verified')
  assert.equal(result.trusted, true)
  assert.equal(result.scope, target.scope)
  assert.equal(result.catalog_generation, target.catalog_generation)
  assert.equal(result.endpoint, target.endpoint)
  assert.equal(result.evidence?.authorization, '[REDACTED]')
})

test('each current-target binding rejects evidence from another execution target', () => {
  const { envelope, anchor } = signed()
  const cases: Array<[Partial<ValidateCapabilityDeepEvidenceOptionsV2>, string]> = [
    [{ expectedProviderId: 'openrouter', expectedScope: 'provider:openrouter' }, 'capability_deep_evidence_provider_mismatch'],
    [{ expectedScope: 'provider:openrouter' }, 'capability_deep_evidence_scope_mismatch'],
    [{ expectedReportId: 'report-trust-002' }, 'capability_deep_evidence_report_mismatch'],
    [{ expectedCatalogGeneration: 'generation-002' }, 'capability_deep_evidence_generation_mismatch'],
    [{ expectedEndpoint: 'https://other.example.test/v1' }, 'capability_deep_evidence_endpoint_mismatch']
  ]
  for (const [override, blocker] of cases) {
    const result = validateCapabilityDeepEvidenceV2(envelope, { ...options(anchor), ...override })
    assert.equal(result.state, 'blocked')
    assert.ok(result.blockers.includes(blocker), blocker)
  }
})

test('tampering, missing trust, stale evidence, and fixtures never verify', () => {
  const { envelope, anchor } = signed()
  const tampered = structuredClone(envelope)
  tampered.payload.artifact_validated = false
  const badDigest = validateCapabilityDeepEvidenceV2(tampered, options(anchor))
  const missingAnchor = validateCapabilityDeepEvidenceV2(envelope, options())
  const stale = validateCapabilityDeepEvidenceV2(envelope, {
    ...options(anchor),
    now: '2026-08-05T15:00:01.000Z'
  })
  const fixtureBundle = signed({ fixture: true, artifact_validated: true })
  const fixture = validateCapabilityDeepEvidenceV2(
    fixtureBundle.envelope,
    options(fixtureBundle.anchor)
  )
  const missing = validateCapabilityDeepEvidenceV2(null, options(anchor))

  assert.equal(badDigest.state, 'blocked')
  assert.ok(badDigest.blockers.includes('capability_deep_evidence_content_sha256_mismatch'))
  assert.equal(missingAnchor.state, 'blocked')
  assert.ok(missingAnchor.blockers.includes('capability_deep_evidence_trust_anchor_missing'))
  assert.equal(stale.state, 'stale')
  assert.equal(fixture.state, 'not_attempted')
  assert.ok(fixture.warnings.includes('capability_deep_evidence_fixture_unverified'))
  assert.equal(missing.state, 'not_attempted')
})
