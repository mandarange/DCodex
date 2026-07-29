import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
  CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
  CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA,
  codexLbDeepEvidenceContentSha256,
  parseCodexLbDeepEvidenceTrustAnchorSet,
  validateCodexLbDesktopDeepEvidence,
  type CodexLbDeepEvidenceTrustAnchor,
  type CodexLbTrustedDeepEvidenceEnvelope
} from '../trusted-deep-evidence.js'

const now = '2026-07-28T12:00:00.000Z'
const endpoint = 'https://lb.example.test/backend-api/codex'

function trustedFixture(overrides: Partial<CodexLbTrustedDeepEvidenceEnvelope> = {}) {
  const content = {
    schema: CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA,
    producer: {
      id: 'sks.codex-lb-desktop-blackbox',
      version: '1.0.0',
      run_id: 'run-verified-001'
    },
    created_at: now,
    target: {
      mode: 'desktop-native-bridge' as const,
      endpoint
    },
    payload: {
      image_artifact_materialized: true,
      computer_executor_completed: true,
      browser_use_verified: true,
      voice_clean_close: true,
      plugins_verified: true,
      auxiliary_owner_affinity_verified: true
    },
    ...overrides
  }
  const contentSha256 = codexLbDeepEvidenceContentSha256(content)
  const envelope: CodexLbTrustedDeepEvidenceEnvelope = {
    ...content,
    integrity: {
      algorithm: 'sha256',
      content_sha256: contentSha256,
      trust_anchor_id: 'anchor.desktop-run-001'
    }
  }
  const anchor: CodexLbDeepEvidenceTrustAnchor = {
    schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
    anchor_id: envelope.integrity.trust_anchor_id,
    producer: envelope.producer,
    target: envelope.target,
    content_sha256: contentSha256
  }
  return { envelope, anchor }
}

test('a parseable fabricated JSON object cannot verify deep capabilities', () => {
  const fabricated = {
    image_artifact_materialized: true,
    computer_executor_completed: true,
    browser_use_verified: true,
    voice_clean_close: true,
    plugins_verified: true,
    auxiliary_owner_affinity_verified: true
  }
  const result = validateCodexLbDesktopDeepEvidence(fabricated, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    now
  })
  assert.equal(result.trusted, false)
  assert.equal(result.state, 'blocked')
  assert.equal(result.evidence, null)
  assert.ok(result.blockers.includes('codex_lb_deep_evidence_schema_invalid'))
})

test('a self-hashed envelope cannot verify without its out-of-band trust anchor', () => {
  const { envelope } = trustedFixture()
  const result = validateCodexLbDesktopDeepEvidence(envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    now
  })
  assert.equal(result.trusted, false)
  assert.equal(result.evidence, null)
  assert.ok(result.blockers.includes('codex_lb_deep_evidence_trust_anchor_missing'))
})

test('trusted evidence verifies only when producer, hash, mode, endpoint, and freshness bind', () => {
  const { envelope, anchor } = trustedFixture()
  const result = validateCodexLbDesktopDeepEvidence(envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: `${endpoint}/`,
    trustAnchors: [anchor],
    now
  })
  assert.equal(result.state, 'verified')
  assert.equal(result.trusted, true)
  assert.deepEqual(result.evidence, envelope.payload)
  assert.deepEqual(result.blockers, [])
})

test('tampered, stale, and target-mismatched evidence is rejected', () => {
  const { envelope, anchor } = trustedFixture()
  const tampered = structuredClone(envelope)
  tampered.payload.browser_use_verified = false
  const tamperedResult = validateCodexLbDesktopDeepEvidence(tampered, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [anchor],
    now
  })
  assert.equal(tamperedResult.evidence, null)
  assert.ok(tamperedResult.blockers.includes('codex_lb_deep_evidence_content_sha256_mismatch'))

  const stale = trustedFixture({ created_at: '2026-07-28T11:00:00.000Z' })
  const staleResult = validateCodexLbDesktopDeepEvidence(stale.envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [stale.anchor],
    now
  })
  assert.ok(staleResult.blockers.includes('codex_lb_deep_evidence_stale'))

  const mismatchResult = validateCodexLbDesktopDeepEvidence(envelope, {
    expectedMode: 'desktop-dual-auth-compat',
    expectedEndpoint: 'https://other.example.test/backend-api/codex',
    trustAnchors: [anchor],
    now
  })
  assert.ok(mismatchResult.blockers.includes('codex_lb_deep_evidence_target_mode_mismatch'))
  assert.ok(mismatchResult.blockers.includes('codex_lb_deep_evidence_target_endpoint_mismatch'))
})

test('trusted fixture evidence remains available_unverified and cannot promote capabilities', () => {
  const fixture = trustedFixture({
    payload: {
      fixture: true,
      image_artifact_materialized: true,
      computer_executor_completed: true,
      browser_use_verified: true,
      voice_clean_close: true,
      plugins_verified: true,
      auxiliary_owner_affinity_verified: true
    }
  })
  const result = validateCodexLbDesktopDeepEvidence(fixture.envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [fixture.anchor],
    now
  })
  assert.equal(result.state, 'available_unverified')
  assert.equal(result.trusted, false)
  assert.equal(result.evidence, null)
  assert.ok(result.blockers.includes('codex_lb_deep_evidence_fixture_unverified'))
})

test('trust-anchor sets reject malformed and duplicate anchors', () => {
  const { anchor } = trustedFixture()
  const valid = parseCodexLbDeepEvidenceTrustAnchorSet({
    schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
    anchors: [anchor]
  })
  assert.equal(valid.ok, true)
  assert.deepEqual(valid.anchors, [anchor])

  const duplicate = parseCodexLbDeepEvidenceTrustAnchorSet({
    schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
    anchors: [anchor, anchor]
  })
  assert.equal(duplicate.ok, false)
  assert.deepEqual(duplicate.anchors, [])
  assert.ok(duplicate.blockers.some((blocker) => blocker.startsWith('codex_lb_deep_evidence_trust_anchor_duplicate')))
})
