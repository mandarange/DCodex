import assert from 'node:assert/strict'
import test from 'node:test'
import { isComputerCallEvent, runComputerUseProbeV3 } from '../probes/computer-use-probe.js'

const context = {
  requestedLevel: 'deep' as const,
  checkedAt: '2026-08-05T16:00:00.000Z',
  reportId: 'report-computer-001',
  correlationId: 'correlation-computer-001',
  sessionId: 'session-computer-001',
  providerId: 'codex-lb' as const
}

test('computer-use deep evidence requires the full executor round trip', () => {
  assert.equal(isComputerCallEvent({ type: 'response.computer_call.created' }), true)
  const result = runComputerUseProbeV3({
    ...context,
    attempted: true,
    callEventSeen: true,
    localExecutorCompleted: true,
    outputSubmitted: true,
    followUpCompleted: true,
    sessionAffinityPreserved: true
  })
  assert.equal(result.state, 'verified')
  assert.equal(result.stage, 'complete')
})

test('computer-use reports the first terminal deep-probe failure', () => {
  const result = runComputerUseProbeV3({
    ...context,
    attempted: true,
    callEventSeen: true,
    localExecutorCompleted: false,
    outputSubmitted: false
  })
  assert.equal(result.state, 'blocked')
  assert.equal(result.root_cause, 'computer_executor_unavailable')
  assert.deepEqual(result.blockers, ['computer_executor_unavailable'])
})
