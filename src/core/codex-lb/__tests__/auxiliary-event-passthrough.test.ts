import test from 'node:test'
import assert from 'node:assert/strict'
import {
  passthroughCodexDesktopEvent,
  runAuxiliarySurfacesProbe
} from '../probes/auxiliary-surfaces-probe.js'

test('unknown auxiliary events pass through without schema loss', () => {
  const event = {
    type: 'response.future_tool.delta',
    sequence_number: 7,
    future_payload: {
      nested: ['exact', { bytes: 'preserved' }]
    }
  }
  const output = passthroughCodexDesktopEvent(event)
  const result = runAuxiliarySurfacesProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    routesAdvertised: true,
    attempted: true,
    fixture: true,
    inputEvents: [event],
    outputEvents: [output],
    requestBodyHashPreserved: true
  })

  assert.equal(output, event)
  assert.equal(result.state, 'available_unverified')
  assert.equal(result.evidence.event_payloads_preserved, true)
  assert.deepEqual(result.evidence.unknown_event_types, ['response.future_tool.delta'])
  assert.deepEqual(result.warnings, ['unknown_event_type_observed'])
})

test('auxiliary probe blocks payload rewriting or field deletion', () => {
  const result = runAuxiliarySurfacesProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    attempted: true,
    inputEvents: [{ type: 'response.future_tool.delta', future: true }],
    outputEvents: [{ type: 'response.future_tool.delta' }],
    requestBodyHashPreserved: true
  })

  assert.equal(result.state, 'blocked')
  assert.ok(result.blockers.includes('auxiliary_event_payload_changed'))
})
