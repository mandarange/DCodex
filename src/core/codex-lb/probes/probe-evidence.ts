import type {
  CapabilityEvidence,
  CapabilityEvidenceSource,
  CapabilityResultInputV3,
  LegacyCapabilityProbeState,
  CapabilitySignal
} from '../capability-types.js'
import type { CapabilityProbeResultV3 } from '../bridge-contracts.js'

export function probeEvidence(input: CapabilitySignal, checkedAt: string): CapabilityEvidence {
  const blockers = uniqueStrings(input.blockers)
  const warnings = uniqueStrings(input.warnings)
  const source = input.source || inferSource(input)
  return {
    state: signalState(input, blockers),
    checked_at: checkedAt,
    source,
    evidence: { ...(input.evidence || {}) },
    blockers,
    warnings
  }
}

export function signalState(input: CapabilitySignal, blockers = uniqueStrings(input.blockers)): LegacyCapabilityProbeState {
  if (input.skipped === true) return 'skipped'
  if (input.unsupported === true) return 'unsupported'
  if (blockers.length > 0) return 'blocked'
  if (input.verified === true && input.fixture !== true && input.source !== 'config' && input.source !== 'manifest') {
    return 'verified'
  }
  return 'available_unverified'
}

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

function inferSource(input: CapabilitySignal): CapabilityEvidenceSource {
  if (input.verified === true) return 'deep_probe'
  if (input.attempted === true) return 'transport'
  if (input.advertised === true) return 'manifest'
  return 'config'
}
