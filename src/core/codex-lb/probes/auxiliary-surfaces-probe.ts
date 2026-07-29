import type { CapabilityEvidence, CapabilityProbeLevel } from '../capability-types.js'
import { probeEvidence } from './probe-evidence.js'

const KNOWN_EVENT_TYPES = new Set([
  'web_search_call',
  'file_search_call',
  'code_interpreter_call',
  'mcp_list_tools',
  'mcp_approval_request',
  'response.completed',
  'response.failed'
])

export interface AuxiliarySurfacesProbeInput {
  level: CapabilityProbeLevel
  checkedAt: string
  routesAdvertised?: boolean | undefined
  inputEvents?: readonly unknown[]
  outputEvents?: readonly unknown[]
  requestBodyHashPreserved?: boolean | undefined
  sessionAffinityPreserved?: boolean | undefined
  attempted?: boolean | undefined
  fixture?: boolean | undefined
  blockers?: string[]
}

export function runAuxiliarySurfacesProbe(input: AuxiliarySurfacesProbeInput): CapabilityEvidence {
  const attempted = input.attempted === true || Boolean(input.inputEvents?.length)
  const inputBytes = stableEventBytes(input.inputEvents || [])
  const outputBytes = stableEventBytes(input.outputEvents || [])
  const eventsPreserved = inputBytes === outputBytes
  const unknownEventTypes = (input.inputEvents || [])
    .map(eventType)
    .filter((type): type is string => Boolean(type && !KNOWN_EVENT_TYPES.has(type)))
  const blockers = [
    ...(input.blockers || []),
    ...(attempted && !eventsPreserved ? ['auxiliary_event_payload_changed'] : []),
    ...(attempted && input.requestBodyHashPreserved === false ? ['auxiliary_request_body_hash_changed'] : []),
    ...(input.level === 'deep' && attempted && input.sessionAffinityPreserved !== true
      ? ['auxiliary_session_affinity_unverified']
      : [])
  ]
  return probeEvidence({
    advertised: input.routesAdvertised === true,
    attempted,
    verified: input.level === 'deep'
      && eventsPreserved
      && input.requestBodyHashPreserved === true
      && input.sessionAffinityPreserved === true,
    fixture: input.fixture,
    source: input.level === 'deep' ? 'deep_probe' : attempted ? 'transport' : 'manifest',
    unsupported: input.routesAdvertised === false && !attempted,
    blockers,
    warnings: unknownEventTypes.length > 0 ? ['unknown_event_type_observed'] : [],
    evidence: {
      event_payloads_preserved: eventsPreserved,
      unknown_event_types: [...new Set(unknownEventTypes)],
      unknown_event_count: unknownEventTypes.length,
      request_body_hash_preserved: input.requestBodyHashPreserved === true,
      session_affinity_preserved: input.sessionAffinityPreserved === true,
      fixture: input.fixture === true
    }
  }, input.checkedAt)
}

export function passthroughCodexDesktopEvent<T>(event: T): T {
  return event
}

function stableEventBytes(events: readonly unknown[]): string {
  return events.map((event) => JSON.stringify(event)).join('\n')
}

function eventType(event: unknown): string | null {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null
  const type = (event as Record<string, unknown>).type
  return typeof type === 'string' && type.trim() ? type.trim() : null
}
