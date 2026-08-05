import type {
  ProviderCapabilityProbeContextV3
} from '../capability-types.js'
import type { CapabilityProbeResultV3 } from '../bridge-contracts.js'
import { capabilityProbeResultV3 } from './probe-evidence.js'

export interface AuxiliarySurfacesProbeInputV3 extends ProviderCapabilityProbeContextV3 {
  advertised?: boolean
  attempted?: boolean
  fixture?: boolean
  eventPayloadsPreserved?: boolean
  requestBodyHashPreserved?: boolean
  ownerAffinityPreserved?: boolean
}

export function runAuxiliarySurfacesProbeV3(input: AuxiliarySurfacesProbeInputV3): CapabilityProbeResultV3 {
  if (input.requestedLevel !== 'deep' || input.attempted !== true || input.fixture === true) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'auxiliary_surfaces',
      scope: `provider:${input.providerId}`,
      stage: 'preflight',
      state: 'not_attempted',
      source: input.advertised ? 'manifest' : 'config',
      warnings: input.fixture ? ['auxiliary_fixture_not_live_evidence'] : [],
      recoveryAction: 'run_deep_verification',
      evidence: { advertised: input.advertised === true, fixture: input.fixture === true }
    })
  }
  const blocker = input.eventPayloadsPreserved !== true
    ? 'auxiliary_event_payload_changed'
    : input.requestBodyHashPreserved !== true
      ? 'auxiliary_request_body_hash_changed'
      : input.ownerAffinityPreserved !== true
        ? 'auxiliary_session_affinity_unverified'
        : null
  return capabilityProbeResultV3({
    ...input,
    capability: 'auxiliary_surfaces',
    scope: `provider:${input.providerId}`,
    stage: blocker ? 'feature_response' : 'complete',
    state: blocker ? 'blocked' : 'verified',
    terminal: Boolean(blocker),
    rootCause: blocker,
    blockers: blocker ? [blocker] : [],
    retryable: Boolean(blocker),
    recoveryAction: blocker ? 'run_deep_verification' : null,
    source: 'deep_probe',
    evidence: {
      event_payloads_preserved: input.eventPayloadsPreserved === true,
      request_body_hash_preserved: input.requestBodyHashPreserved === true,
      owner_affinity_preserved: input.ownerAffinityPreserved === true
    }
  })
}

export function passthroughCodexDesktopEvent<T>(event: T): T {
  return event
}
