import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  ProviderCapabilityProbeContextV3
} from '../capability-types.js'
import type { CapabilityProbeResultV3, CapabilityProbeStage } from '../bridge-contracts.js'
import { capabilityProbeResultV3, probeEvidence } from './probe-evidence.js'

export interface ComputerUseProbeInput {
  level: CapabilityProbeLevel
  checkedAt: string
  toolAdvertised?: boolean | undefined
  events?: readonly unknown[]
  localExecutorCompleted?: boolean | undefined
  outputSubmitted?: boolean | undefined
  followUpCompleted?: boolean | undefined
  sessionAffinityPreserved?: boolean | undefined
  attempted?: boolean | undefined
  fixture?: boolean | undefined
  blockers?: string[]
}

export interface ComputerUseProbeInputV3 extends ProviderCapabilityProbeContextV3 {
  advertised?: boolean
  attempted?: boolean
  fixture?: boolean
  callEventSeen?: boolean
  localExecutorCompleted?: boolean
  outputSubmitted?: boolean
  followUpCompleted?: boolean
  sessionAffinityPreserved?: boolean
}

export function runComputerUseProbeV3(input: ComputerUseProbeInputV3): CapabilityProbeResultV3 {
  if (input.requestedLevel !== 'deep' || input.attempted !== true || input.fixture === true) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'computer_use',
      scope: `provider:${input.providerId}`,
      stage: 'preflight',
      state: 'not_attempted',
      source: input.advertised ? 'manifest' : 'config',
      warnings: input.fixture ? ['computer_fixture_not_live_evidence'] : [],
      recoveryAction: 'run_deep_verification',
      evidence: { advertised: input.advertised === true, fixture: input.fixture === true }
    })
  }
  const failure = firstComputerFailure(input)
  if (failure) {
    return capabilityProbeResultV3({
      ...input,
      capability: 'computer_use',
      scope: `provider:${input.providerId}`,
      stage: failure.stage,
      state: 'blocked',
      terminal: true,
      rootCause: failure.blocker,
      blockers: [failure.blocker],
      retryable: true,
      recoveryAction: 'run_deep_verification',
      source: 'deep_probe',
      evidence: computerEvidence(input)
    })
  }
  return capabilityProbeResultV3({
    ...input,
    capability: 'computer_use',
    scope: `provider:${input.providerId}`,
    stage: 'complete',
    state: 'verified',
    source: 'deep_probe',
    evidence: computerEvidence(input)
  })
}

export function runComputerUseProbe(input: ComputerUseProbeInput): CapabilityEvidence {
  const callEventSeen = (input.events || []).some(isComputerCallEvent)
  const attempted = input.attempted === true || Boolean(input.events?.length)
  const blockers = [
    ...(input.blockers || []),
    ...(attempted && input.toolAdvertised === false ? ['computer_tool_not_advertised'] : []),
    ...(attempted && !callEventSeen ? ['computer_call_event_filtered'] : []),
    ...(input.level === 'deep' && attempted && input.localExecutorCompleted !== true ? ['computer_executor_unavailable'] : []),
    ...(input.level === 'deep' && attempted && input.outputSubmitted !== true ? ['computer_output_rejected'] : []),
    ...(input.level === 'deep' && attempted && input.sessionAffinityPreserved !== true ? ['computer_session_affinity_lost'] : []),
    ...(input.level === 'deep' && attempted && input.followUpCompleted !== true ? ['computer_follow_up_incomplete'] : [])
  ]
  return probeEvidence({
    advertised: input.toolAdvertised === true,
    attempted,
    verified: input.level === 'deep'
      && callEventSeen
      && input.localExecutorCompleted === true
      && input.outputSubmitted === true
      && input.followUpCompleted === true
      && input.sessionAffinityPreserved === true,
    fixture: input.fixture,
    source: input.level === 'deep' ? 'deep_probe' : attempted ? 'transport' : 'manifest',
    unsupported: input.toolAdvertised === false && !attempted,
    blockers,
    warnings: callEventSeen && input.level !== 'deep'
      ? ['computer_call_transport_seen_without_real_executor_loop']
      : [],
    evidence: {
      tool_advertised: input.toolAdvertised === true,
      call_event_seen: callEventSeen,
      local_executor_completed: input.localExecutorCompleted === true,
      output_submitted: input.outputSubmitted === true,
      follow_up_completed: input.followUpCompleted === true,
      session_affinity_preserved: input.sessionAffinityPreserved === true,
      fixture: input.fixture === true
    }
  }, input.checkedAt)
}

export function isComputerCallEvent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const event = value as Record<string, unknown>
  if (/computer_call/i.test(String(event.type || ''))) return true
  const item = event.item
  return Boolean(item && typeof item === 'object' && !Array.isArray(item)
    && /computer_call/i.test(String((item as Record<string, unknown>).type || '')))
}

function firstComputerFailure(
  input: ComputerUseProbeInputV3
): { stage: CapabilityProbeStage; blocker: string } | null {
  if (input.callEventSeen !== true) return { stage: 'feature_response', blocker: 'computer_call_event_filtered' }
  if (input.localExecutorCompleted !== true) return { stage: 'feature_response', blocker: 'computer_executor_unavailable' }
  if (input.outputSubmitted !== true) return { stage: 'feature_request', blocker: 'computer_output_rejected' }
  if (input.followUpCompleted !== true) return { stage: 'feature_response', blocker: 'computer_follow_up_incomplete' }
  if (input.sessionAffinityPreserved !== true) return { stage: 'feature_response', blocker: 'computer_session_affinity_lost' }
  return null
}

function computerEvidence(input: ComputerUseProbeInputV3): Record<string, unknown> {
  return {
    call_event_seen: input.callEventSeen === true,
    local_executor_completed: input.localExecutorCompleted === true,
    output_submitted: input.outputSubmitted === true,
    follow_up_completed: input.followUpCompleted === true,
    session_affinity_preserved: input.sessionAffinityPreserved === true
  }
}
