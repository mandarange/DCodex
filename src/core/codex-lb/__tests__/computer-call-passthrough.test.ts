import test from 'node:test'
import assert from 'node:assert/strict'
import { runComputerUseProbe } from '../probes/computer-use-probe.js'

test('computer call transport does not prove the local executor feedback loop', () => {
  const result = runComputerUseProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    toolAdvertised: true,
    attempted: true,
    fixture: true,
    events: [{
      type: 'response.computer_call.created',
      call_id: 'call_fixture',
      future_event_field: true
    }]
  })

  assert.equal(result.state, 'available_unverified')
  assert.equal(result.evidence.call_event_seen, true)
  assert.equal(result.evidence.local_executor_completed, false)
  assert.ok(result.warnings.includes('computer_call_transport_seen_without_real_executor_loop'))
})

test('deep computer probe requires output submission, follow-up, and session affinity', () => {
  const result = runComputerUseProbe({
    level: 'deep',
    checkedAt: '2026-07-28T00:00:00.000Z',
    toolAdvertised: true,
    attempted: true,
    events: [{ type: 'response.computer_call.created', call_id: 'call_fixture' }],
    localExecutorCompleted: true,
    outputSubmitted: true,
    followUpCompleted: true,
    sessionAffinityPreserved: false
  })

  assert.equal(result.state, 'blocked')
  assert.ok(result.blockers.includes('computer_session_affinity_lost'))
})
