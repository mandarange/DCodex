import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  CodexLbDesktopMode,
  GatewayAuthTransport
} from '../capability-types.js'
import { probeEvidence } from './probe-evidence.js'

export interface BridgeProbeInput {
  mode: CodexLbDesktopMode
  level: CapabilityProbeLevel
  checkedAt: string
  configured?: boolean | undefined
  processRunning?: boolean | undefined
  manifest?: Record<string, unknown> | null
  transportAttempted?: boolean | undefined
  httpRoundTrip?: boolean | undefined
  websocketRoundTrip?: boolean | undefined
  fixture?: boolean | undefined
  blockers?: string[]
}

export function runBridgeProbe(input: BridgeProbeInput): CapabilityEvidence {
  if (input.mode !== 'desktop-native-bridge') {
    return probeEvidence({
      skipped: true,
      source: 'config',
      evidence: {
        required: false,
        mode: input.mode,
        reason: 'local_bridge_not_selected'
      }
    }, input.checkedAt)
  }
  const manifestSchema = String(input.manifest?.schema_version || '')
  const manifestAvailable = manifestSchema === 'codex-lb.desktop-capabilities.v1'
  const verified = input.transportAttempted === true
    && input.httpRoundTrip === true
    && input.websocketRoundTrip === true
  const blockers = [
    ...(input.blockers || []),
    ...(input.level !== 'shallow' && input.transportAttempted === true && input.httpRoundTrip !== true
      ? ['desktop_bridge_http_transport_failed']
      : []),
    ...(input.level !== 'shallow' && input.transportAttempted === true && input.websocketRoundTrip !== true
      ? ['desktop_bridge_websocket_transport_failed']
      : [])
  ]
  return probeEvidence({
    configured: input.configured,
    advertised: manifestAvailable,
    attempted: input.transportAttempted,
    verified,
    fixture: input.fixture,
    source: verified ? 'transport' : manifestAvailable ? 'manifest' : 'config',
    blockers,
    warnings: input.processRunning && !input.transportAttempted
      ? ['bridge_process_running_without_transport_evidence']
      : [],
    evidence: {
      mode: input.mode,
      configured: input.configured === true,
      process_running: input.processRunning === true,
      capability_manifest_seen: manifestAvailable,
      http_round_trip: input.httpRoundTrip === true,
      websocket_round_trip: input.websocketRoundTrip === true
    }
  }, input.checkedAt)
}

export function gatewayAuthTransportEvidence(input: {
  checkedAt: string
  transport?: GatewayAuthTransport
  configured?: boolean
  observed?: boolean
  fixture?: boolean
  legacyCompatibilityExplicit?: boolean
  blockers?: string[]
}): CapabilityEvidence {
  const transport = input.transport || 'unknown'
  // Product default is Authorization: Bearer (authorization-bearer-compat).
  // Custom X-Codex-LB-API-Key remains available for rare gateways only.
  const preferredBearer = transport === 'authorization-bearer-compat'
    || transport === 'authorization-bearer'
  const customHeader = transport === 'x-codex-lb-api-key'
  return probeEvidence({
    configured: input.configured,
    attempted: input.observed,
    verified: input.observed === true && (preferredBearer || customHeader),
    fixture: input.fixture,
    source: input.observed ? 'transport' : 'config',
    blockers: [...(input.blockers || [])],
    warnings: customHeader ? ['custom_x_codex_lb_api_key_transport_active'] : [],
    evidence: {
      configured_gateway_auth_transport: transport,
      preferred_custom_header: customHeader,
      preferred_authorization_bearer: preferredBearer,
      standard_authorization_bearer: transport === 'authorization-bearer',
      legacy_authorization_bearer_compatibility: false,
      silent_fallback: false,
      observed: input.observed === true
    }
  }, input.checkedAt)
}
