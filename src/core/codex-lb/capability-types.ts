import type { CodexLbDeepEvidenceValidation } from './trusted-deep-evidence.js'
import type {
  BridgeProviderId,
  CapabilityEvidenceSource as CapabilityEvidenceSourceV3,
  CapabilityProbeResultV3,
  CapabilityProbeState as CapabilityProbeStateV3,
  CapabilityRequestedLevel,
  CapabilityScope,
  CombinedCatalogSyncStatus,
  DesktopCapabilityReportV3,
  ScopeCapabilitySummary
} from './bridge-contracts.js'

export type {
  CapabilityEvidenceSource as CapabilityEvidenceSourceV3,
  CapabilityProbeResultV3,
  CapabilityProbeStage,
  CapabilityProbeState as CapabilityProbeStateV3,
  CapabilityRequestedLevel,
  CapabilityScope,
  DesktopCapabilityReportV3,
  ScopeCapabilitySummary
} from './bridge-contracts.js'

/** Legacy v2 adapter input only; never use this union for v3 routing truth. */
export type CodexLbDesktopMode =
  | 'desktop-native-bridge'
  | 'desktop-dual-auth-compat'
  | 'cli-provider'
  | 'disabled'

type CodexLbGatewayAuthTransport =
  | 'x-codex-lb-api-key'
  | 'authorization-bearer-compat'

export type CapabilityProbeLevel = 'shallow' | 'transport' | 'deep'

/** Legacy v2 state retained only for the one-release compatibility facade. */
export type LegacyCapabilityProbeState =
  | 'verified'
  | 'available_unverified'
  | 'blocked'
  | 'unsupported'
  | 'skipped'

/** Legacy v2 evidence source retained only for the one-release adapter. */
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
  state: LegacyCapabilityProbeState
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
  overall: LegacyCapabilityProbeState
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

export interface DesktopCapabilityRunnerInputV3 {
  requestedLevel: CapabilityRequestedLevel
  reportId: string
  correlationId: string
  sessionId: string
  checkedAt?: string
  activeProviderIds: readonly BridgeProviderId[]
  enabledProviderIds?: readonly BridgeProviderId[]
  catalogSync: CombinedCatalogSyncStatus
  results?: readonly CapabilityProbeResultV3[]
  executionBlockers?: readonly string[]
  executionWarnings?: readonly string[]
}

export interface DesktopCapabilityRequirement {
  scope: CapabilityScope | 'provider:*'
  capability: string
  minimum_level: CapabilityRequestedLevel
  readiness: 'routing' | 'full_feature'
}

export interface CapabilityProbeContextV3 {
  requestedLevel: CapabilityRequestedLevel
  checkedAt: string
  reportId: string
  correlationId: string
  sessionId: string
  attemptId?: number
}

export interface ProviderCapabilityProbeContextV3 extends CapabilityProbeContextV3 {
  providerId: BridgeProviderId
}

export interface CapabilityResultInputV3 extends CapabilityProbeContextV3 {
  capability: string
  scope: CapabilityScope
  stage: CapabilityProbeResultV3['stage']
  state: CapabilityProbeStateV3
  terminal?: boolean
  rootCause?: string | null
  blockers?: readonly string[]
  warnings?: readonly string[]
  retryable?: boolean
  recoveryAction?: string | null
  source: CapabilityEvidenceSourceV3
  evidence?: Record<string, unknown>
}

export interface DesktopCapabilityV2AdapterOptions {
  mode?: CodexLbDesktopMode
  configured?: boolean
  oauthPreserved?: boolean
}

export type DesktopCapabilityScopeMap = Pick<
  DesktopCapabilityReportV3,
  'bridge' | 'native_identity' | 'providers' | 'combined_catalog'
>

export type DesktopCapabilityScopeSummary = ScopeCapabilitySummary
