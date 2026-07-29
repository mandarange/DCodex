import type {
  CodexLbDesktopMode,
  CodexLbGatewayAuthTransport
} from './desktop-mode.js'
import type { CodexLbDeepEvidenceValidation } from './trusted-deep-evidence.js'

export type { CodexLbDesktopMode } from './desktop-mode.js'

export type CapabilityProbeLevel = 'shallow' | 'transport' | 'deep'

export type CapabilityProbeState =
  | 'verified'
  | 'available_unverified'
  | 'blocked'
  | 'unsupported'
  | 'skipped'

export type CapabilityEvidenceSource =
  | 'config'
  | 'manifest'
  | 'transport'
  | 'desktop_ui'
  | 'deep_probe'

// 'authorization-bearer' is the standard OpenAI-compatible bearer the Codex CLI
// uses on the codex-lb provider contract (env_key); it is the cli-provider
// plane's own auth, not the explicit desktop legacy compat transport.
export type GatewayAuthTransport =
  | CodexLbGatewayAuthTransport
  | 'authorization-bearer'
  | 'unknown'

export interface CapabilityEvidence {
  state: CapabilityProbeState
  checked_at: string
  source: CapabilityEvidenceSource
  evidence: Record<string, unknown>
  blockers: string[]
  warnings: string[]
}

export interface CodexLbDesktopCapabilityReport {
  schema: 'sks.codex-lb-desktop-capabilities.v2'
  mode: CodexLbDesktopMode
  configured: boolean
  oauth_preserved: boolean
  gateway_auth_transport: CapabilityEvidence
  provider_identity: CapabilityEvidence
  bridge: CapabilityEvidence
  catalog: CapabilityEvidence
  model_picker: CapabilityEvidence
  fast_mode: CapabilityEvidence
  text_responses: CapabilityEvidence
  image_generation: CapabilityEvidence
  computer_use: CapabilityEvidence
  browser_use: CapabilityEvidence
  voice_mode: CapabilityEvidence
  plugins: CapabilityEvidence
  auxiliary_surfaces: CapabilityEvidence
  deep_evidence_validation: CodexLbDeepEvidenceValidation
  overall: CapabilityProbeState
}

export type CodexLbCapabilityKey = Exclude<
  keyof CodexLbDesktopCapabilityReport,
  'schema' | 'mode' | 'configured' | 'oauth_preserved' | 'deep_evidence_validation' | 'overall'
>

export interface CapabilitySignal {
  configured?: boolean | undefined
  advertised?: boolean | undefined
  attempted?: boolean | undefined
  verified?: boolean | undefined
  fixture?: boolean | undefined
  unsupported?: boolean | undefined
  skipped?: boolean | undefined
  source?: CapabilityEvidenceSource | undefined
  blockers?: string[] | undefined
  warnings?: string[] | undefined
  evidence?: Record<string, unknown> | undefined
}
