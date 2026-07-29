import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CODEX_LB_DESKTOP_REAL_EVIDENCE_REQUIRED_TRUE_FIELDS,
  validateCodexLbDesktopRealEvidence
} from '../desktop-real-evidence.js'
import {
  CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA,
  CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA,
  codexLbDeepEvidenceContentSha256,
  type CodexLbDeepEvidenceTrustAnchor,
  type CodexLbTrustedDeepEvidenceEnvelope
} from '../trusted-deep-evidence.js'

const now = '2026-07-28T12:00:00.000Z'
const endpoint = 'http://127.0.0.1:8877/backend-api/codex'

function trustedReleaseEvidence(
  payloadOverrides: Record<string, unknown> = {}
): { envelope: CodexLbTrustedDeepEvidenceEnvelope; anchor: CodexLbDeepEvidenceTrustAnchor } {
  const requiredTrue = Object.fromEntries(
    CODEX_LB_DESKTOP_REAL_EVIDENCE_REQUIRED_TRUE_FIELDS.map((field) => [field, true])
  )
  const auxiliaryEvents = [{ type: 'web_search_call', id: 'event-1' }]
  const content = {
    schema: CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA,
    producer: {
      id: 'sks.codex-lb-desktop-blackbox',
      version: '1.0.0',
      run_id: 'run-release-001'
    },
    created_at: now,
    target: {
      mode: 'desktop-native-bridge' as const,
      endpoint
    },
    payload: {
      ...requiredTrue,
      desktop_adoption_source: 'codex_desktop_runtime',
      picker_selected_model: 'gpt-5.6-codex',
      configured_service_tier: 'fast',
      request_service_tier: 'priority',
      response_actual_service_tier: 'priority',
      source_surface: 'codex_desktop_runtime',
      desktop_build: '2026.07.28',
      codex_core_version: '0.145.0',
      protocol_fixture_schema_hash: 'a'.repeat(64),
      app_origin_observed: 'app://codex',
      image_route: 'responses_tool',
      image_events: [{ type: 'response.output_image.completed' }],
      computer_events: [{ type: 'response.computer_call.created' }],
      auxiliary_routes_observed: ['/files'],
      auxiliary_events: auxiliaryEvents,
      auxiliary_output_events: auxiliaryEvents,
      ...payloadOverrides
    }
  }
  const contentSha256 = codexLbDeepEvidenceContentSha256(content)
  const envelope: CodexLbTrustedDeepEvidenceEnvelope = {
    ...content,
    integrity: {
      algorithm: 'sha256',
      content_sha256: contentSha256,
      trust_anchor_id: 'anchor.release-001'
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

test('trusted complete real Desktop evidence is release-authorizing', () => {
  const { envelope, anchor } = trustedReleaseEvidence()
  const result = validateCodexLbDesktopRealEvidence(envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [anchor],
    now
  })
  assert.equal(result.ok, true)
  assert.equal(result.status, 'passed')
  assert.equal(result.release_authorizing, true)
  assert.deepEqual(result.blockers, [])
})

test('missing native capability or lifecycle evidence fails closed', () => {
  const { envelope, anchor } = trustedReleaseEvidence({
    auth_mode_independence_verified: false,
    mac_reboot_recovery_verified: false
  })
  const result = validateCodexLbDesktopRealEvidence(envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [anchor],
    now
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'real_required_missing')
  assert.ok(result.blockers.includes('codex_lb_desktop_real_evidence_required_true:auth_mode_independence_verified'))
  assert.ok(result.blockers.includes('codex_lb_desktop_real_evidence_required_true:mac_reboot_recovery_verified'))
})

test('fixture evidence cannot authorize release even when every flag is true', () => {
  const { envelope, anchor } = trustedReleaseEvidence({ fixture: true })
  const result = validateCodexLbDesktopRealEvidence(envelope, {
    expectedMode: 'desktop-native-bridge',
    expectedEndpoint: endpoint,
    trustAnchors: [anchor],
    now
  })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'real_required_missing')
  assert.ok(result.blockers.includes('codex_lb_deep_evidence_fixture_unverified'))
})
