import assert from 'node:assert/strict'
import test from 'node:test'
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js'

const context = {
  requestedLevel: 'transport' as const,
  checkedAt: '2026-08-05T16:00:00.000Z',
  reportId: 'report-text-001',
  correlationId: 'correlation-text-001',
  sessionId: 'session-text-001'
}

test('live response-chain evidence verifies only its provider-scoped text capability', () => {
  const evidence = capabilityProbeResultV3({
    ...context,
    scope: 'provider:codex-lb',
    capability: 'text_responses',
    stage: 'feature_response',
    state: 'verified',
    source: 'transport',
    evidence: { response_chain_completed: true, status_code: 200 }
  })
  assert.equal(evidence.state, 'verified')
  assert.equal(evidence.scope, 'provider:codex-lb')
  assert.equal(evidence.capability, 'text_responses')
  assert.equal(evidence.evidence.response_chain_completed, true)
})

test('a config-only skipped chain is represented as not attempted', () => {
  const evidence = capabilityProbeResultV3({
    ...context,
    scope: 'provider:codex-lb',
    capability: 'text_responses',
    stage: 'preflight',
    state: 'not_attempted',
    source: 'config',
    evidence: { reason: 'model_unselected' }
  })
  assert.equal(evidence.state, 'not_attempted')
  assert.equal(evidence.source, 'config')
})
