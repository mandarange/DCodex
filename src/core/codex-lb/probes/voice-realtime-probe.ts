import type { CapabilityEvidence, CapabilityProbeLevel } from '../capability-types.js'
import { probeEvidence } from './probe-evidence.js'

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
