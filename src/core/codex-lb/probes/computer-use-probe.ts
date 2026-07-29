import type { CapabilityEvidence, CapabilityProbeLevel } from '../capability-types.js'
import { probeEvidence } from './probe-evidence.js'

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
