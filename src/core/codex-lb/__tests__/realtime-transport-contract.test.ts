import test from 'node:test'
import assert from 'node:assert/strict'
import { runVoiceRealtimeProbe } from '../probes/voice-realtime-probe.js'

test('mock realtime create, Location rewrite, and WebSocket signal remain unverified without a real voice session', () => {
  const result = runVoiceRealtimeProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    routeAdvertised: true,
    attempted: true,
    fixture: true,
    createRouteVerified: true,
    locationReceived: true,
    locationRewritten: true,
    websocketUpgraded: true,
    serverEventSeen: true,
    cleanClose: true,
    ownerBindingVerified: true
  })

  assert.equal(result.state, 'available_unverified')
  assert.equal(result.evidence.location_rewritten, true)
  assert.equal(result.evidence.websocket_upgraded, true)
  assert.ok(result.warnings.includes('realtime_transport_verified_without_real_voice_session'))
})

test('realtime probe blocks an absolute Location that bypasses the local bridge', () => {
  const result = runVoiceRealtimeProbe({
    level: 'transport',
    checkedAt: '2026-07-28T00:00:00.000Z',
    routeAdvertised: true,
    attempted: true,
    createRouteVerified: true,
    locationReceived: true,
    locationRewritten: false,
    websocketUpgraded: true,
    serverEventSeen: true,
    cleanClose: true,
    ownerBindingVerified: true
  })

  assert.equal(result.state, 'blocked')
  assert.ok(result.blockers.includes('realtime_location_not_rewritten'))
})
