import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  ProviderCapabilityProbeContextV3
} from '../capability-types.js'
import type { CapabilityProbeResultV3, CapabilityProbeStage } from '../bridge-contracts.js'
import { capabilityProbeResultV3, probeEvidence } from './probe-evidence.js'

export interface VoiceRealtimeProbeInput {
  level: CapabilityProbeLevel
  checkedAt: string
  routeAdvertised?: boolean | undefined
  createRouteVerified?: boolean | undefined
  locationReceived?: boolean | undefined
  locationRewritten?: boolean | undefined
  websocketUpgraded?: boolean | undefined
  serverEventSeen?: boolean | undefined
  cleanClose?: boolean | undefined
  ownerBindingVerified?: boolean | undefined
  attempted?: boolean | undefined
  fixture?: boolean | undefined
  blockers?: string[]
}

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

export function runVoiceRealtimeProbe(input: VoiceRealtimeProbeInput): CapabilityEvidence {
  const attempted = input.attempted === true
    || input.createRouteVerified !== undefined
    || input.websocketUpgraded !== undefined
  const transportComplete = input.createRouteVerified === true
    && input.locationReceived === true
    && input.locationRewritten === true
    && input.websocketUpgraded === true
    && input.serverEventSeen === true
    && input.cleanClose === true
    && input.ownerBindingVerified === true
  const blockers = [
    ...(input.blockers || []),
    ...(attempted && input.createRouteVerified !== true ? ['realtime_create_unauthorized'] : []),
    ...(attempted && input.locationReceived !== true ? ['realtime_location_missing'] : []),
    ...(attempted && input.locationReceived === true && input.locationRewritten !== true ? ['realtime_location_not_rewritten'] : []),
    ...(attempted && input.websocketUpgraded !== true ? ['realtime_websocket_upgrade_failed'] : []),
    ...(attempted && input.websocketUpgraded === true && input.serverEventSeen !== true ? ['realtime_sideband_event_missing'] : []),
    ...(attempted && input.ownerBindingVerified !== true ? ['realtime_call_owner_binding_failed'] : [])
  ]
  return probeEvidence({
    advertised: input.routeAdvertised === true,
    attempted,
    verified: input.level === 'deep' && transportComplete,
    fixture: input.fixture,
    source: input.level === 'deep' ? 'deep_probe' : attempted ? 'transport' : 'manifest',
    unsupported: input.routeAdvertised === false && !attempted,
    blockers,
    warnings: transportComplete && input.level !== 'deep'
      ? ['realtime_transport_verified_without_real_voice_session']
      : [],
    evidence: {
      create_route_verified: input.createRouteVerified === true,
      location_received: input.locationReceived === true,
      location_rewritten: input.locationRewritten === true,
      websocket_upgraded: input.websocketUpgraded === true,
      server_event_seen: input.serverEventSeen === true,
      clean_close: input.cleanClose === true,
      owner_binding_verified: input.ownerBindingVerified === true,
      fixture: input.fixture === true
    }
  }, input.checkedAt)
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
