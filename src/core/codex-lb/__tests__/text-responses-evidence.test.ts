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

test('text response validity accepts a completed Codex SSE stream and rejects failed or truncated streams', async () => {
  const { textResponsePayloadValid } = await import('../desktop-controller-v3/live-probes.js')
  const sse = 'text/event-stream; charset=utf-8'
  const completed = [
    'event: response.created',
    'data: {"type":"response.created","response":{"id":"resp_1"}}',
    '',
    'data: {"type":"response.output_text.done","text":"OK"}',
    '',
    'data: {"type":"response.completed","response":{"id":"resp_1"}}',
    '',
    'data: [DONE]',
    ''
  ].join('\n')
  assert.equal(textResponsePayloadValid(sse, completed), true)
  assert.equal(textResponsePayloadValid(sse, completed.replace('response.completed', 'response.in_progress')), false)
  assert.equal(textResponsePayloadValid(sse, `${completed}\ndata: {"type":"response.failed"}\n`), false)
  assert.equal(textResponsePayloadValid(sse, 'data: not-json\n\n'), false)
  assert.equal(textResponsePayloadValid('application/json', '{"object":"response","id":"resp_2"}'), true)
  assert.equal(textResponsePayloadValid('application/json', 'OK'), false)
  assert.equal(textResponsePayloadValid(null, ''), false)
})
