import test from 'node:test'
import assert from 'node:assert/strict'
import { runImageGenerationProbe } from '../probes/image-generation-probe.js'

test('image output event transport is available_unverified until a real Desktop artifact exists', () => {
  const result = runImageGenerationProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    route: 'responses_tool',
    manifestRouteAdvertised: true,
    toolAdvertised: true,
    requestToolsPresent: true,
    attempted: true,
    fixture: true,
    events: [{
      type: 'response.image_generation_call.completed',
      future_event_field: { preserve: true }
    }]
  })

  assert.equal(result.state, 'available_unverified')
  assert.equal(result.evidence.output_image_event_seen, true)
  assert.equal(result.evidence.artifact_materialized, false)
  assert.ok(result.warnings.includes('image_event_transport_seen_without_real_desktop_artifact'))
})

test('image probe blocks text-only success when the output image event is absent', () => {
  const result = runImageGenerationProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    route: 'responses_tool',
    toolAdvertised: true,
    requestToolsPresent: true,
    attempted: true,
    events: [{ type: 'response.output_text.done', text: 'success' }]
  })

  assert.equal(result.state, 'blocked')
  assert.ok(result.blockers.includes('image_output_event_filtered'))
})
