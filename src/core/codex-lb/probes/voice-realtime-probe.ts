import type {
  ProviderCapabilityProbeContextV3
} from '../capability-types.js'
import type { CapabilityProbeResultV3, CapabilityProbeStage } from '../bridge-contracts.js'
import { capabilityProbeResultV3 } from './probe-evidence.js'

export interface VoiceRealtimeProbeInputV3 extends ProviderCapabilityProbeContextV3 {
  advertised?: boolean
  attempted?: boolean
  fixture?: boolean
  createRouteVerified?: boolean
  locationReceived?: boolean
  locationRewritten?: boolean
  websocketUpgraded?: boolean
  serverEventSeen?: boolean
  cleanClose?: boolean
  ownerBindingVerified?: boolean
}

export function runVoiceRealtimeProbeV3(input: VoiceRealtimeProbeInputV3): CapabilityProbeResultV3 {
  if (input.requestedLevel !== 'deep' || input.attempted !== true || input.fixture === true) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'voice_mode',
      scope: `provider:${input.providerId}`,
      stage: 'preflight',
      state: 'not_attempted',
      source: input.advertised ? 'manifest' : 'config',
      warnings: input.fixture ? ['voice_fixture_not_live_evidence'] : [],
      recoveryAction: 'run_deep_verification',
      evidence: { advertised: input.advertised === true, fixture: input.fixture === true }
    })
  }
  const failure = firstVoiceFailure(input)
  if (failure) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'voice_mode',
      scope: `provider:${input.providerId}`,
      stage: failure.stage,
      state: 'blocked',
      terminal: true,
      rootCause: failure.blocker,
      blockers: [failure.blocker],
      retryable: true,
      recoveryAction: 'run_deep_verification',
      source: 'deep_probe',
      evidence: voiceEvidence(input)
    })
  }
  return capabilityProbeResultV3({
    ...input,
    capability: 'voice_mode',
    scope: `provider:${input.providerId}`,
    stage: 'complete',
    state: 'verified',
    source: 'deep_probe',
    evidence: voiceEvidence(input)
  })
}

function firstVoiceFailure(
  input: VoiceRealtimeProbeInputV3
): { stage: CapabilityProbeStage; blocker: string } | null {
  if (input.createRouteVerified !== true) return { stage: 'feature_request', blocker: 'realtime_create_unauthorized' }
  if (input.locationReceived !== true) return { stage: 'feature_response', blocker: 'realtime_location_missing' }
  if (input.locationRewritten !== true) return { stage: 'feature_response', blocker: 'realtime_location_not_rewritten' }
  if (input.websocketUpgraded !== true) return { stage: 'websocket_upgrade', blocker: 'realtime_websocket_upgrade_failed' }
  if (input.serverEventSeen !== true) return { stage: 'websocket_protocol', blocker: 'realtime_sideband_event_missing' }
  if (input.cleanClose !== true) return { stage: 'websocket_protocol', blocker: 'realtime_clean_close_failed' }
  if (input.ownerBindingVerified !== true) return { stage: 'feature_response', blocker: 'realtime_call_owner_binding_failed' }
  return null
}

function voiceEvidence(input: VoiceRealtimeProbeInputV3): Record<string, unknown> {
  return {
    create_route_verified: input.createRouteVerified === true,
    location_received: input.locationReceived === true,
    location_rewritten: input.locationRewritten === true,
    websocket_upgraded: input.websocketUpgraded === true,
    server_event_seen: input.serverEventSeen === true,
    clean_close: input.cleanClose === true,
    owner_binding_verified: input.ownerBindingVerified === true
  }
}
