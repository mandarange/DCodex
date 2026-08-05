import assert from 'node:assert/strict'
import test from 'node:test'
import { runVoiceRealtimeProbeV3 } from '../probes/voice-realtime-probe.js'

const context = {
  requestedLevel: 'deep' as const,
  checkedAt: '2026-08-05T16:00:00.000Z',
  reportId: 'report-voice-001',
  correlationId: 'correlation-voice-001',
  sessionId: 'session-voice-001',
  providerId: 'codex-lb' as const
}

test('voice deep verification requires create, redirect, websocket, event, close, and owner binding', () => {
  const result = runVoiceRealtimeProbeV3({
    ...context,
    attempted: true,
    createRouteVerified: true,
    locationReceived: true,
    locationRewritten: true,
    websocketUpgraded: true,
    serverEventSeen: true,
    cleanClose: true,
    ownerBindingVerified: true
  })
  assert.equal(result.state, 'verified')
  assert.equal(result.stage, 'complete')
})

test('voice deep verification classifies websocket protocol failure precisely', () => {
  const result = runVoiceRealtimeProbeV3({
    ...context,
    attempted: true,
    createRouteVerified: true,
    locationReceived: true,
    locationRewritten: true,
    websocketUpgraded: true,
    serverEventSeen: false
  })
  assert.equal(result.state, 'blocked')
  assert.equal(result.stage, 'websocket_protocol')
  assert.equal(result.root_cause, 'realtime_sideband_event_missing')
})
