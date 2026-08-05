import assert from 'node:assert/strict'
import test from 'node:test'
import { isImageOutputEvent, runImageGenerationProbeV3 } from '../probes/image-generation-probe.js'

const context = {
  requestedLevel: 'deep' as const,
  checkedAt: '2026-08-05T16:00:00.000Z',
  reportId: 'report-image-001',
  correlationId: 'correlation-image-001',
  sessionId: 'session-image-001',
  providerId: 'codex-lb' as const
}

test('image output events are recognized without becoming artifact proof', () => {
  assert.equal(isImageOutputEvent({ type: 'response.image_generation_call.completed' }), true)
  const result = runImageGenerationProbeV3({
    ...context,
    attempted: true,
    outputEventSeen: true
  })
  assert.equal(result.state, 'blocked')
  assert.equal(result.stage, 'artifact_validation')
  assert.equal(result.root_cause, 'image_artifact_path_invalid')
})

test('image fixture events remain non-verifying', () => {
  const result = runImageGenerationProbeV3({
    ...context,
    attempted: true,
    fixture: true,
    outputEventSeen: true
  })
  assert.equal(result.state, 'not_attempted')
  assert.ok(result.warnings.includes('image_fixture_not_live_evidence'))
})
