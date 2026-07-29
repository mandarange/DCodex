import type {
  CapabilityEvidence,
  CapabilityEvidenceSource,
  CapabilityProbeState,
  CapabilitySignal
} from '../capability-types.js'

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

export function signalState(input: CapabilitySignal, blockers = uniqueStrings(input.blockers)): CapabilityProbeState {
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

function inferSource(input: CapabilitySignal): CapabilityEvidenceSource {
  if (input.verified === true) return 'deep_probe'
  if (input.attempted === true) return 'transport'
  if (input.advertised === true) return 'manifest'
  return 'config'
}
