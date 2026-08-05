import assert from 'node:assert/strict'
import test from 'node:test'
import type { HttpProbeResult, WebSocketProbeResult } from '../bridge-contracts.js'
import { runBridgeProbeV3 } from '../probes/bridge-probe.js'

const context = {
  requestedLevel: 'transport' as const,
  checkedAt: '2026-08-05T12:00:00.000Z',
  reportId: 'report-ws-001',
  correlationId: 'correlation-ws-001',
  sessionId: 'session-ws-001',
  configured: true,
  processRunning: true
}

const httpOk: HttpProbeResult = {
  schema: 'sks.desktop-bridge-http-probe.v1',
  state: 'verified',
  terminal_stage: 'complete',
  root_cause: null,
  status_code: 200,
  latency_ms: 2,
  blockers: [],
  warnings: []
}

function websocketFailure(
  terminalStage: WebSocketProbeResult['terminal_stage'],
  rootCause: string
): WebSocketProbeResult {
  return {
    schema: 'sks.desktop-bridge-websocket-probe.v2',
    state: 'blocked',
    terminal_stage: terminalStage,
    root_cause: rootCause,
    status_code: terminalStage === 'tcp_connect' ? null : 400,
    negotiated_protocol: null,
    upgrade_verified: terminalStage !== 'tcp_connect' && terminalStage !== 'websocket_upgrade',
    protocol_verified: false,
    frame_round_trip_verified: false,
    clean_close_verified: false,
    latency_ms: 3,
    blockers: [rootCause, 'desktop_bridge_websocket_transport_failed'],
    warnings: []
  }
}

test('structured WebSocket failures preserve exactly the original terminal cause', () => {
  const rows: Array<[WebSocketProbeResult['terminal_stage'], string, string]> = [
    ['tcp_connect', 'desktop_bridge_tcp_connect_failed', 'tcp_connect'],
    ['websocket_upgrade', 'desktop_bridge_websocket_upgrade_failed', 'websocket_upgrade'],
    ['websocket_upgrade', 'desktop_bridge_websocket_accept_invalid', 'websocket_upgrade'],
    ['websocket_protocol', 'desktop_bridge_websocket_protocol_mismatch', 'websocket_protocol'],
    ['frame_round_trip', 'desktop_bridge_websocket_frame_receive_failed', 'frame_round_trip'],
    ['clean_close', 'desktop_bridge_websocket_close_failed', 'clean_close']
  ]
  for (const [terminalStage, rootCause, expectedStage] of rows) {
    const result = runBridgeProbeV3({
      ...context,
      httpProbe: httpOk,
      websocketProbe: websocketFailure(terminalStage, rootCause)
    }).find((entry) => entry.capability === 'websocket_transport')!
    assert.equal(result.stage, expectedStage, rootCause)
    assert.equal(result.root_cause, rootCause, rootCause)
    assert.deepEqual(result.blockers, [rootCause], rootCause)
    assert.equal(result.blockers.includes('desktop_bridge_websocket_transport_failed'), false, rootCause)
  }
})

test('structured HTTP failure keeps its one source-owned health root cause', () => {
  const results = runBridgeProbeV3({
    ...context,
    httpProbe: {
      schema: 'sks.desktop-bridge-http-probe.v1',
      state: 'blocked',
      terminal_stage: 'http_health',
      root_cause: 'desktop_bridge_http_health_failed',
      status_code: 503,
      latency_ms: 5,
      blockers: ['desktop_bridge_http_health_failed', 'generic_http_transport_failed'],
      warnings: []
    }
  })
  const http = results.find((entry) => entry.capability === 'http_health')!
  assert.equal(http.stage, 'http_health')
  assert.equal(http.root_cause, 'desktop_bridge_http_health_failed')
  assert.deepEqual(http.blockers, ['desktop_bridge_http_health_failed'])
})

test('a running process without structured transport remains unverified', () => {
  const results = runBridgeProbeV3(context)
  const runtime = results.find((entry) => entry.capability === 'runtime')!
  const http = results.find((entry) => entry.capability === 'http_health')!
  const websocket = results.find((entry) => entry.capability === 'websocket_transport')!
  assert.equal(runtime.state, 'verified')
  assert.ok(runtime.warnings.includes('bridge_process_running_without_transport_evidence'))
  assert.equal(http.state, 'not_attempted')
  assert.equal(websocket.state, 'not_attempted')
})

test('upgrade-only structured evidence remains degraded and cannot claim frame round trip', () => {
  const result = runBridgeProbeV3({
    ...context,
    httpProbe: httpOk,
    websocketProbe: {
      schema: 'sks.desktop-bridge-websocket-probe.v2',
      state: 'degraded',
      terminal_stage: 'websocket_protocol',
      root_cause: null,
      status_code: 101,
      negotiated_protocol: 'sks-diagnostic.v1',
      upgrade_verified: true,
      protocol_verified: true,
      frame_round_trip_verified: false,
      clean_close_verified: false,
      latency_ms: 4,
      blockers: [],
      warnings: ['websocket_frame_round_trip_not_attempted']
    }
  }).find((entry) => entry.capability === 'websocket_transport')!
  assert.equal(result.state, 'degraded')
  assert.equal(result.evidence.frame_round_trip_verified, false)
  assert.ok(result.warnings.includes('websocket_frame_round_trip_not_attempted'))
})

test('structured not-attempted WebSocket evidence stays nonblocking', () => {
  const result = runBridgeProbeV3({
    ...context,
    httpProbe: httpOk,
    websocketProbe: {
      schema: 'sks.desktop-bridge-websocket-probe.v2',
      state: 'not_attempted',
      terminal_stage: 'websocket_protocol',
      root_cause: null,
      status_code: 101,
      negotiated_protocol: null,
      upgrade_verified: true,
      protocol_verified: false,
      frame_round_trip_verified: false,
      clean_close_verified: false,
      latency_ms: 2,
      blockers: [],
      warnings: ['websocket_protocol_probe_not_run']
    }
  }).find((entry) => entry.capability === 'websocket_transport')!
  assert.equal(result.state, 'not_attempted')
  assert.equal(result.root_cause, null)
  assert.deepEqual(result.blockers, [])
})

test('full structured WebSocket round trip is verified without inferred causes', () => {
  const result = runBridgeProbeV3({
    ...context,
    httpProbe: httpOk,
    websocketProbe: {
      schema: 'sks.desktop-bridge-websocket-probe.v2',
      state: 'verified',
      terminal_stage: 'complete',
      root_cause: null,
      status_code: 101,
      negotiated_protocol: 'sks-diagnostic.v1',
      upgrade_verified: true,
      protocol_verified: true,
      frame_round_trip_verified: true,
      clean_close_verified: true,
      latency_ms: 4,
      blockers: [],
      warnings: []
    }
  }).find((entry) => entry.capability === 'websocket_transport')!
  assert.equal(result.state, 'verified')
  assert.equal(result.stage, 'complete')
  assert.equal(result.root_cause, null)
  assert.deepEqual(result.blockers, [])
})
