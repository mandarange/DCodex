import test from 'node:test'
import assert from 'node:assert/strict'
import { codexLbResponseChainCapabilityEvidence } from '../../../cli/install-helpers-codex-lb-chain.js'

test('response-chain success verifies only the text_responses sub-probe', () => {
  const evidence = codexLbResponseChainCapabilityEvidence({
    ok: true,
    status: 'chain_ok',
    http_status: 200,
    service_tier_evidence: {
      requested_service_tier: 'fast',
      actual_service_tier: 'priority'
    }
  }, { checkedAt: '2026-07-28T00:00:00.000Z' })

  assert.equal(evidence.state, 'verified')
  assert.equal(evidence.evidence.probe, 'text_responses')
  assert.equal(evidence.evidence.response_chain_completed, true)
})

test('a skipped/config-only chain check cannot become verified readiness', () => {
  const evidence = codexLbResponseChainCapabilityEvidence({
    ok: true,
    status: 'skipped',
    skipped: true,
    reason: 'model_unselected'
  }, { checkedAt: '2026-07-28T00:00:00.000Z' })

  assert.equal(evidence.state, 'skipped')
  assert.equal(evidence.source, 'config')
})
