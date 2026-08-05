import type { CapabilityResultInputV3 } from '../capability-types.js'
import type { CapabilityProbeResultV3 } from '../bridge-contracts.js'

export function uniqueStrings(values: unknown = []): string[] {
  return [...new Set((Array.isArray(values) ? values : [values])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
}

/** Construct a v3 result while enforcing one terminal root cause. */
export function capabilityProbeResultV3(input: CapabilityResultInputV3): CapabilityProbeResultV3 {
  const rootCause = input.rootCause ? String(input.rootCause) : null
  const blockers = uniqueStrings(input.blockers)
    .filter((blocker) => blocker !== 'desktop_bridge_websocket_transport_failed')
  const terminalBlockers = input.terminal === true && rootCause ? [rootCause] : blockers
  const secondary = input.terminal === true && rootCause
    ? blockers.filter((blocker) => blocker !== rootCause)
    : []
  return {
    schema: 'sks.capability-probe.v3',
    capability: input.capability,
    scope: input.scope,
    requested_level: input.requestedLevel,
    stage: input.stage,
    state: input.state,
    checked_at: input.checkedAt,
    report_id: input.reportId,
    correlation_id: input.correlationId,
    session_id: input.sessionId,
    attempt_id: input.attemptId || 1,
    terminal: input.terminal === true,
    root_cause: rootCause,
    blockers: terminalBlockers,
    warnings: uniqueStrings([
      ...(input.warnings || []),
      ...secondary.map((blocker) => `secondary_diagnostic:${blocker}`)
    ]),
    retryable: input.retryable === true,
    recovery_action: input.recoveryAction || null,
    source: input.source,
    evidence: { ...(input.evidence || {}) }
  }
}
