import type {
  CapabilityProbeContextV3
} from '../capability-types.js'
import type {
  CapabilityProbeResultV3,
  CapabilityProbeStage,
  HttpProbeResult,
  WebSocketProbeResult
} from '../bridge-contracts.js'
import { capabilityProbeResultV3 } from './probe-evidence.js'

export interface BridgeProbeInputV3 extends CapabilityProbeContextV3 {
  configured?: boolean
  processRunning?: boolean
  httpProbe?: HttpProbeResult
  websocketProbe?: WebSocketProbeResult
}

/**
 * Structured v3 bridge facade. Low-level results own their terminal cause; this
 * adapter only maps the reported stage and never invents a second transport
 * failure.
 */
export function runBridgeProbeV3(input: BridgeProbeInputV3): CapabilityProbeResultV3[] {
  const runtime = capabilityProbeResultV3({
    ...input,
    capability: 'runtime',
    scope: 'bridge',
    stage: input.processRunning ? 'process' : 'preflight',
    state: input.configured && input.processRunning ? 'verified' : 'not_attempted',
    source: 'config',
    recoveryAction: input.processRunning ? null : 'repair_bridge_service',
    evidence: {
      configured: input.configured === true,
      process_running: input.processRunning === true,
      transport_verified: false
    }
  })
  if (input.requestedLevel === 'shallow') {
    return [
      runtime,
      notAttemptedBridgeTransport(input, 'http_health'),
      notAttemptedBridgeTransport(input, 'websocket_transport')
    ]
  }
  const http = input.httpProbe
    ? capabilityProbeResultV3({
      ...input,
      capability: 'http_health',
      scope: 'bridge',
      stage: mapHttpStage(input.httpProbe.terminal_stage),
      state: input.httpProbe.state,
      terminal: Boolean(input.httpProbe.root_cause),
      rootCause: input.httpProbe.root_cause,
      blockers: input.httpProbe.blockers,
      warnings: input.httpProbe.warnings,
      retryable: input.httpProbe.state === 'blocked' || input.httpProbe.state === 'failed',
      recoveryAction: recoveryFor(input.httpProbe.root_cause),
      source: 'transport',
      evidence: {
        structured_probe_schema: input.httpProbe.schema,
        terminal_stage: input.httpProbe.terminal_stage,
        status_code: input.httpProbe.status_code,
        latency_ms: input.httpProbe.latency_ms
      }
    })
    : notAttemptedBridgeTransport(input, 'http_health')
  const websocket = input.websocketProbe
    ? websocketCapabilityResult(input, input.websocketProbe)
    : notAttemptedBridgeTransport(input, 'websocket_transport')
  if (input.processRunning && !input.httpProbe && !input.websocketProbe) {
    runtime.warnings.push('bridge_process_running_without_transport_evidence')
  }
  return [runtime, http, websocket]
}

function websocketCapabilityResult(
  input: BridgeProbeInputV3,
  probe: WebSocketProbeResult
): CapabilityProbeResultV3 {
  const complete = probe.upgrade_verified
    && probe.protocol_verified
    && probe.frame_round_trip_verified
    && probe.clean_close_verified
  const inconsistentVerified = probe.state === 'verified' && !complete
  return capabilityProbeResultV3({
    ...input,
    capability: 'websocket_transport',
    scope: 'bridge',
    stage: mapWebSocketStage(probe.terminal_stage),
    state: inconsistentVerified ? 'degraded' : probe.state,
    terminal: Boolean(probe.root_cause),
    rootCause: probe.root_cause,
    blockers: probe.blockers,
    warnings: [
      ...probe.warnings,
      ...(inconsistentVerified ? ['websocket_structured_result_incomplete'] : [])
    ],
    retryable: probe.state === 'blocked' || probe.state === 'failed',
    recoveryAction: recoveryFor(probe.root_cause),
    source: 'transport',
    evidence: {
      structured_probe_schema: probe.schema,
      terminal_stage: probe.terminal_stage,
      status_code: probe.status_code,
      negotiated_protocol: probe.negotiated_protocol,
      upgrade_verified: probe.upgrade_verified,
      protocol_verified: probe.protocol_verified,
      frame_round_trip_verified: probe.frame_round_trip_verified,
      clean_close_verified: probe.clean_close_verified,
      latency_ms: probe.latency_ms
    }
  })
}

function notAttemptedBridgeTransport(
  input: BridgeProbeInputV3,
  capability: 'http_health' | 'websocket_transport'
): CapabilityProbeResultV3 {
  return capabilityProbeResultV3({
    ...input,
    capability,
    scope: 'bridge',
    stage: 'preflight',
    state: 'not_attempted',
    source: 'config',
    recoveryAction: input.requestedLevel === 'shallow' ? null : 'retry_transport_probe',
    evidence: { reason: input.requestedLevel === 'shallow' ? 'transport_not_requested' : 'transport_probe_not_run' }
  })
}

function mapHttpStage(stage: HttpProbeResult['terminal_stage']): CapabilityProbeStage {
  if (stage === 'tcp_connect') return 'tcp_connect'
  if (stage === 'http_health') return 'http_health'
  return 'complete'
}

function mapWebSocketStage(stage: WebSocketProbeResult['terminal_stage']): CapabilityProbeStage {
  if (stage === 'tcp_connect') return 'tcp_connect'
  if (stage === 'websocket_upgrade') return 'websocket_upgrade'
  if (stage === 'frame_round_trip') return 'frame_round_trip'
  if (stage === 'clean_close') return 'clean_close'
  if (stage === 'complete') return 'complete'
  return 'websocket_protocol'
}

function recoveryFor(rootCause: string | null): string | null {
  if (!rootCause) return null
  if (rootCause === 'desktop_bridge_not_running') return 'repair_bridge_service'
  if (rootCause === 'desktop_bridge_tcp_connect_failed') return 'restart_bridge_and_retry'
  if (rootCause === 'desktop_bridge_websocket_upgrade_failed') return 'inspect_bridge_logs_and_retry_transport'
  if (rootCause === 'desktop_bridge_websocket_protocol_mismatch') return 'update_bridge_or_codex_protocol'
  return 'retry_transport_probe'
}
