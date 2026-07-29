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
  const preferred = transport === 'x-codex-lb-api-key'
  const standardBearer = transport === 'authorization-bearer'
  const legacyExplicit = transport === 'authorization-bearer-compat'
    && input.legacyCompatibilityExplicit === true
  return probeEvidence({
    configured: input.configured,
    attempted: input.observed,
    verified: input.observed === true && (preferred || standardBearer || legacyExplicit),
    fixture: input.fixture,
    source: input.observed ? 'transport' : 'config',
    blockers: [
      ...(input.blockers || []),
      ...(transport === 'authorization-bearer-compat' && !input.legacyCompatibilityExplicit
        ? ['legacy_gateway_auth_compatibility_not_explicit']
        : [])
    ],
    warnings: legacyExplicit ? ['legacy_authorization_bearer_compatibility_active'] : [],
    evidence: {
      configured_gateway_auth_transport: transport,
      preferred_custom_header: preferred,
      standard_authorization_bearer: standardBearer,
      legacy_authorization_bearer_compatibility: legacyExplicit,
      silent_fallback: false,
      observed: input.observed === true
    }
  }, input.checkedAt)
}
