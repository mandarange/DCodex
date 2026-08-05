import assert from 'node:assert/strict'
import test from 'node:test'
import {
  passthroughCodexDesktopEvent,
  runAuxiliarySurfacesProbeV3
} from '../probes/auxiliary-surfaces-probe.js'

const context = {
  requestedLevel: 'deep' as const,
  checkedAt: '2026-08-05T16:00:00.000Z',
  reportId: 'report-auxiliary-001',
  correlationId: 'correlation-auxiliary-001',
  sessionId: 'session-auxiliary-001',
  providerId: 'codex-lb' as const
}

test('auxiliary event passthrough preserves the exact payload and verifies bound deep evidence', () => {
  const event = { type: 'future.event', nested: { value: 1 }, extra: ['preserve'] }
  assert.equal(passthroughCodexDesktopEvent(event), event)
  const result = runAuxiliarySurfacesProbeV3({
    ...context,
    attempted: true,
    eventPayloadsPreserved: true,
    requestBodyHashPreserved: true,
    ownerAffinityPreserved: true
  })
  assert.equal(result.state, 'verified')
  assert.equal(result.evidence.event_payloads_preserved, true)
})

test('auxiliary fixture evidence cannot verify a deep capability', () => {
  const result = runAuxiliarySurfacesProbeV3({
    ...context,
    attempted: true,
    fixture: true,
    eventPayloadsPreserved: true,
    requestBodyHashPreserved: true,
    ownerAffinityPreserved: true
  })
  assert.equal(result.state, 'not_attempted')
  assert.ok(result.warnings.includes('auxiliary_fixture_not_live_evidence'))
})
