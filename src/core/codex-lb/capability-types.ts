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

export type DesktopCapabilityScopeMap = Pick<
  DesktopCapabilityReportV3,
  'bridge' | 'native_identity' | 'providers' | 'combined_catalog'
>

export type DesktopCapabilityScopeSummary = ScopeCapabilitySummary
