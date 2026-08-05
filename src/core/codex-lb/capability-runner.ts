import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  CapabilitySignal,
  CodexLbCapabilityKey,
  CodexLbDesktopCapabilityReport,
  CodexLbDesktopMode,
  DesktopCapabilityRequirement,
  DesktopCapabilityRunnerInputV3,
  DesktopCapabilityV2AdapterOptions,
  GatewayAuthTransport
} from './capability-types.js'
import type {
  BridgeProviderId,
  CapabilityProbeResultV3,
  CapabilityProbeState,
  CapabilityRequestedLevel,
  CapabilityScope,
  CombinedCatalogSyncStatus,
  DesktopCapabilityReportV3,
  ScopeCapabilitySummary
} from './bridge-contracts.js'
import { runAuxiliarySurfacesProbe, type AuxiliarySurfacesProbeInput } from './probes/auxiliary-surfaces-probe.js'
import { runBridgeProbe, gatewayAuthTransportEvidence, type BridgeProbeInput } from './probes/bridge-probe.js'
import { runCatalogProbe, type CatalogProbeInput } from './probes/catalog-probe.js'
import { runComputerUseProbe, type ComputerUseProbeInput } from './probes/computer-use-probe.js'
import { runImageGenerationProbe, type ImageGenerationProbeInput } from './probes/image-generation-probe.js'
import { probeEvidence, uniqueStrings } from './probes/probe-evidence.js'
import { runVoiceRealtimeProbe, type VoiceRealtimeProbeInput } from './probes/voice-realtime-probe.js'
import {
  CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
  redactCapabilityEvidence,
  type CodexLbDeepEvidenceValidation
} from './trusted-deep-evidence.js'

const REQUIRED_FOR_FULL = [
  'gateway_auth_transport',
  'provider_identity',
  'bridge',
  'catalog',
  'model_picker',
  'fast_mode',
  'image_generation',
  'computer_use',
  'browser_use',
  'voice_mode',
  'plugins',
  'auxiliary_surfaces'
] as const satisfies readonly CodexLbCapabilityKey[]

// cli-provider routes the Codex CLI through the gateway: its verified ceiling
// is the CLI request plane (auth, identity, catalog, picker, fast tier, text
// and image transport). Desktop-plane surfaces stay reported but do not gate
// the CLI routing verdict.
const REQUIRED_FOR_CLI_PROVIDER = [
  'gateway_auth_transport',
  'provider_identity',
  'catalog',
  'model_picker',
  'fast_mode',
  'text_responses',
  'image_generation'
] as const satisfies readonly CodexLbCapabilityKey[]

export interface CodexLbDesktopCapabilityRunnerInput {
  mode: CodexLbDesktopMode
  level?: CapabilityProbeLevel
  configured?: boolean
  oauthPreserved?: boolean
  checkedAt?: string
  manifest?: Record<string, unknown> | null
  gatewayAuth?: {
    transport?: GatewayAuthTransport
    configured?: boolean
    observed?: boolean
    fixture?: boolean
    legacyCompatibilityExplicit?: boolean
    blockers?: string[]
  }
  providerIdentity?: CapabilitySignal & { requiresOauth?: boolean }
  catalog?: Omit<CatalogProbeInput, 'mode' | 'level' | 'checkedAt' | 'manifest'>
  bridge?: Omit<BridgeProbeInput, 'mode' | 'level' | 'checkedAt' | 'manifest'>
  textResponses?: CapabilitySignal
  imageGeneration?: Omit<ImageGenerationProbeInput, 'level' | 'checkedAt'>
  computerUse?: Omit<ComputerUseProbeInput, 'level' | 'checkedAt'>
  browserUse?: CapabilitySignal
  voiceMode?: Omit<VoiceRealtimeProbeInput, 'level' | 'checkedAt'>
  plugins?: CapabilitySignal
  auxiliarySurfaces?: Omit<AuxiliarySurfacesProbeInput, 'level' | 'checkedAt'>
  deepEvidenceValidation?: CodexLbDeepEvidenceValidation
}

export interface CodexLbDesktopCapabilityStatus {
  schema: 'sks.codex-lb-desktop-capability-status.v2'
  ready: boolean
  state: import('./capability-types.js').LegacyCapabilityProbeState
  configured: boolean
  oauth_preserved: boolean
  gateway_auth_transport: GatewayAuthTransport
  model_picker: CapabilityEvidence
  verified: string[]
  available_unverified: string[]
  blocked: Record<string, string[]>
  unsupported: string[]
  skipped: string[]
}

export function runCodexLbDesktopCapabilityReport(
  input: CodexLbDesktopCapabilityRunnerInput
): CodexLbDesktopCapabilityReport {
  const level = input.level || 'shallow'
  const checkedAt = input.checkedAt || new Date().toISOString()
  const manifest = input.manifest || null
  const catalog = runCatalogProbe({
    mode: input.mode,
    level,
    checkedAt,
    manifest,
    ...(input.catalog || {})
  })
  const providerIdentityBlockers = [
    ...(input.providerIdentity?.blockers || []),
    ...(input.providerIdentity?.requiresOauth === true && input.oauthPreserved !== true
      ? ['chatgpt_oauth_identity_not_preserved']
      : [])
  ]
  const providerIdentity = probeEvidence({
    ...(input.providerIdentity || {}),
    blockers: providerIdentityBlockers,
    evidence: {
      ...(input.providerIdentity?.evidence || {}),
      oauth_required: input.providerIdentity?.requiresOauth === true,
      oauth_preserved: input.oauthPreserved === true
    }
  }, checkedAt)
  const bridge = runBridgeProbe({
    mode: input.mode,
    level,
    checkedAt,
    manifest,
    ...(input.bridge || {})
  })
  const reportWithoutOverall = {
    schema: 'sks.codex-lb-desktop-capabilities.v2' as const,
    mode: input.mode,
    configured: input.configured === true,
    oauth_preserved: input.oauthPreserved === true,
    gateway_auth_transport: gatewayAuthTransportEvidence({
      checkedAt,
      ...(input.gatewayAuth || {})
    }),
    provider_identity: providerIdentity,
    bridge,
    catalog: catalog.catalog,
    model_picker: catalog.model_picker,
    fast_mode: catalog.fast_mode,
    text_responses: probeEvidence(input.textResponses || {
      skipped: true,
      evidence: { reason: 'text_responses_probe_not_run' }
    }, checkedAt),
    image_generation: runImageGenerationProbe({
      level,
      checkedAt,
      manifestRouteAdvertised: manifestFlag(manifest, 'routes', 'images_generations')
        ?? manifestFlag(manifest, 'routes', 'responses_http')
        ?? undefined,
      toolAdvertised: manifestFlag(manifest, 'tools', 'image_generation') ?? undefined,
      ...(input.imageGeneration || {})
    }),
    computer_use: runComputerUseProbe({
      level,
      checkedAt,
      toolAdvertised: manifestFlag(manifest, 'tools', 'computer_use_passthrough') ?? undefined,
      ...(input.computerUse || {})
    }),
    browser_use: probeEvidence(input.browserUse || {
      source: 'config',
      evidence: {
        independent_from_computer_use: true,
        independent_from_auth_mode: true,
        reason: 'browser_use_probe_not_run'
      }
    }, checkedAt),
    voice_mode: runVoiceRealtimeProbe({
      level,
      checkedAt,
      routeAdvertised: manifestFlag(manifest, 'routes', 'realtime_calls') ?? undefined,
      ...(input.voiceMode || {})
    }),
    plugins: probeEvidence(input.plugins || {
      source: 'config',
      evidence: {
        independent_from_auth_mode: true
      }
    }, checkedAt),
    auxiliary_surfaces: runAuxiliarySurfacesProbe({
      level,
      checkedAt,
      routesAdvertised: auxiliaryRoutesAdvertised(manifest),
      ...(input.auxiliarySurfaces || {})
    })
  }
  return {
    ...reportWithoutOverall,
    deep_evidence_validation: input.deepEvidenceValidation || {
      schema: CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
      state: 'available_unverified',
      trusted: false,
      evidence: null,
      producer_id: null,
      created_at: null,
      content_sha256: null,
      trust_anchor_id: null,
      blockers: level === 'deep' ? ['codex_lb_deep_evidence_missing'] : [],
      warnings: level === 'deep' ? [] : ['deep_verification_not_requested']
    },
    overall: overallCapabilityState(reportWithoutOverall)
  }
}

export function overallCapabilityState(
  report: Omit<CodexLbDesktopCapabilityReport, 'overall' | 'deep_evidence_validation'>
): import('./capability-types.js').LegacyCapabilityProbeState {
  if (report.mode === 'disabled') return 'available_unverified'
  const required = report.mode === 'cli-provider'
    ? REQUIRED_FOR_CLI_PROVIDER
    : report.mode === 'desktop-native-bridge'
      ? REQUIRED_FOR_FULL
      : REQUIRED_FOR_FULL.filter((key) => key !== 'bridge')
  const states = required.map((key) => report[key].state)
  if (states.some((state) => state === 'blocked')) return 'blocked'
  if (states.some((state) => state === 'unsupported')) return 'unsupported'
  if (report.configured && states.every((state) => state === 'verified')) return 'verified'
  return 'available_unverified'
}

export function shapeCodexLbDesktopCapabilityStatus(
  report: CodexLbDesktopCapabilityReport
): CodexLbDesktopCapabilityStatus {
  const entries = capabilityEntries(report)
  return {
    schema: 'sks.codex-lb-desktop-capability-status.v2',
    ready: report.overall === 'verified',
    state: report.overall,
    configured: report.configured,
    oauth_preserved: report.oauth_preserved,
    gateway_auth_transport: String(
      report.gateway_auth_transport.evidence.configured_gateway_auth_transport || 'unknown'
    ) as GatewayAuthTransport,
    model_picker: report.model_picker,
    verified: entries.filter(([, value]) => value.state === 'verified').map(([key]) => key),
    available_unverified: entries.filter(([, value]) => value.state === 'available_unverified').map(([key]) => key),
    blocked: Object.fromEntries(entries
      .filter(([, value]) => value.state === 'blocked')
      .map(([key, value]) => [key, value.blockers])),
    unsupported: entries.filter(([, value]) => value.state === 'unsupported').map(([key]) => key),
    skipped: entries.filter(([, value]) => value.state === 'skipped').map(([key]) => key)
  }
}

function capabilityEntries(
  report: CodexLbDesktopCapabilityReport
): Array<[CodexLbCapabilityKey, CapabilityEvidence]> {
  const keys: CodexLbCapabilityKey[] = [
    'gateway_auth_transport',
    'provider_identity',
    'bridge',
    'catalog',
    'model_picker',
    'fast_mode',
    'text_responses',
    'image_generation',
    'computer_use',
    'browser_use',
    'voice_mode',
    'plugins',
    'auxiliary_surfaces'
  ]
  return keys.map((key) => [key, report[key]])
}

function manifestFlag(
  manifest: Record<string, unknown> | null,
  section: string,
  key: string
): boolean | null {
  const row = manifest?.[section]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

function auxiliaryRoutesAdvertised(manifest: Record<string, unknown> | null): boolean | undefined {
  if (!manifest) return undefined
  const flags = [
    manifestFlag(manifest, 'routes', 'files'),
    manifestFlag(manifest, 'routes', 'transcribe'),
    manifestFlag(manifest, 'routes', 'images_edits'),
    manifestFlag(manifest, 'routes', 'thread_goal'),
    manifestFlag(manifest, 'routes', 'memories_trace_summarize'),
    manifestFlag(manifest, 'routes', 'safety_arc'),
    manifestFlag(manifest, 'routes', 'agent_identities_jwks')
  ]
  return flags.some((flag) => flag === true)
}

/**
 * The v3 requirement matrix is intentionally scope and level aware.  It is the
 * only readiness matrix used by the v3 runner; legacy mode-wide arrays above
 * exist solely for the v2 compatibility facade.
 */
export const DESKTOP_CAPABILITY_REQUIREMENTS_V3 = [
  { scope: 'bridge', capability: 'runtime', minimum_level: 'shallow', readiness: 'routing' },
  { scope: 'bridge', capability: 'http_health', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'bridge', capability: 'websocket_transport', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'native-identity', capability: 'oauth_identity', minimum_level: 'shallow', readiness: 'routing' },
  { scope: 'provider:*', capability: 'credential', minimum_level: 'shallow', readiness: 'routing' },
  { scope: 'provider:*', capability: 'provider_auth', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'provider:*', capability: 'catalog_sync', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'provider:*', capability: 'model_route', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'provider:*', capability: 'text_responses', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'catalog:combined', capability: 'route_policy', minimum_level: 'shallow', readiness: 'routing' },
  { scope: 'catalog:combined', capability: 'catalog_sync', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'catalog:combined', capability: 'model_route', minimum_level: 'transport', readiness: 'routing' },
  { scope: 'provider:*', capability: 'fast_mode', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'image_generation', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'computer_use', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'browser_use', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'voice_mode', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'plugins', minimum_level: 'deep', readiness: 'full_feature' },
  { scope: 'provider:*', capability: 'auxiliary_surfaces', minimum_level: 'deep', readiness: 'full_feature' }
] as const satisfies readonly DesktopCapabilityRequirement[]

const V3_SCOPES = [
  'bridge',
  'native-identity',
  'provider:codex-lb',
  'provider:openrouter',
  'catalog:combined'
] as const satisfies readonly CapabilityScope[]

const LEVEL_ORDER: Record<CapabilityRequestedLevel, number> = {
  shallow: 0,
  transport: 1,
  deep: 2
}

/** Build one deterministic v3 report without re-inferring low-level failures. */
export function runDesktopCapabilityReportV3(
  input: DesktopCapabilityRunnerInputV3
): DesktopCapabilityReportV3 {
  const checkedAt = input.checkedAt || new Date().toISOString()
  const executionBlockers = uniqueStrings(input.executionBlockers)
  const executionWarnings = uniqueStrings(input.executionWarnings)
  const catalogSync = validCatalogSync(input.catalogSync)
    ? input.catalogSync
    : invalidCatalogSync(checkedAt)
  if (!validCatalogSync(input.catalogSync)) executionBlockers.push('capability_schema_invalid:catalog_sync_missing')

  const activeProviders = providerSet(input.activeProviderIds)
  const enabledProviders = providerSet(input.enabledProviderIds || input.activeProviderIds)
  const candidates = [
    ...(input.results || []),
    ...catalogSyncResults(input, catalogSync, checkedAt)
  ].map((result) => normalizeV3Result(result, input, checkedAt))
  let selected = selectCurrentResults(candidates, input)
  selected = addMissingRequirementResults(selected, input, checkedAt)

  const initial = summariesFromResults(selected, checkedAt)
  const bridgeReady = scopeRequirementsSatisfied(initial.bridge, input.requestedLevel, 'routing')
  const withDependencies = bridgeReady
    ? selected
    : addBridgeDependencies(
      selected,
      input,
      checkedAt,
      bridgeTerminalCause(initial.bridge),
      new Set([...enabledProviders, ...activeProviders])
    )
  const scopes = summariesFromResults(withDependencies, checkedAt)

  const activeProviderSummaries = [...activeProviders].map((provider) => scopes.providers[provider])
  const activeProvidersReady = activeProviderSummaries.length > 0
    && activeProviderSummaries.every((summary) => scopeRequirementsSatisfied(summary, input.requestedLevel, 'routing'))
  const nativeReady = scopeRequirementsSatisfied(scopes.native_identity, input.requestedLevel, 'routing')
  const catalogReady = scopeRequirementsSatisfied(scopes.combined_catalog, input.requestedLevel, 'routing')
  const activeRoutesReady = bridgeReady && nativeReady && catalogReady && activeProvidersReady
  const transportSatisfied = LEVEL_ORDER[input.requestedLevel] >= LEVEL_ORDER.transport
    && activeRoutesReady
    && requiredScopesSatisfied(scopes, activeProviders, 'transport', 'routing')
  const deepSatisfied = input.requestedLevel === 'deep'
    && transportSatisfied
    && activeProviderSummaries.every((summary) => scopeRequirementsSatisfied(summary, 'deep', 'full_feature'))
  const levelSatisfied = input.requestedLevel === 'shallow'
    ? activeRoutesReady
    : input.requestedLevel === 'transport'
      ? transportSatisfied
      : deepSatisfied

  const inactiveProviderFailures: string[] = []
  for (const provider of ['codex-lb', 'openrouter'] as const) {
    if (activeProviders.has(provider) || !enabledProviders.has(provider)) continue
    const summary = scopes.providers[provider]
    const failures = uniqueStrings([...summary.blockers, ...scopeRootCauses(summary)])
    inactiveProviderFailures.push(...failures.map((failure) => `${provider}:${failure}`))
  }
  const routingBlockers = activeRoutesReady
    ? []
    : uniqueStrings([
      ...withoutDependencyBlocker(scopes.bridge.blockers),
      ...scopes.native_identity.blockers,
      ...scopes.combined_catalog.blockers,
      ...activeProviderSummaries.flatMap((summary) => withoutDependencyBlocker(summary.blockers))
    ])
  const pendingRequired = missingRequiredCapabilityWarnings(scopes, activeProviders, input.requestedLevel)
  const partial = pendingRequired.length > 0

  return {
    schema: 'sks.desktop-capabilities.v3',
    report_id: input.reportId,
    correlation_id: input.correlationId,
    session_id: input.sessionId,
    requested_level: input.requestedLevel,
    checked_at: checkedAt,
    catalog_generation: catalogSync.generation,
    execution: {
      ok: executionBlockers.length === 0,
      status: executionBlockers.length > 0 ? 'failed' : partial ? 'partial' : 'completed',
      blockers: uniqueStrings(executionBlockers)
    },
    ...scopes,
    summary: {
      bridge_ready: bridgeReady,
      active_routes_ready: activeRoutesReady,
      level_satisfied: levelSatisfied,
      transport_level_satisfied: transportSatisfied,
      deep_level_satisfied: deepSatisfied,
      full_feature_verified: deepSatisfied,
      inactive_provider_failures: uniqueStrings(inactiveProviderFailures).sort(),
      blockers: routingBlockers,
      warnings: uniqueStrings([
        ...executionWarnings,
        ...pendingRequired,
        ...inactiveProviderFailures.map((failure) => `inactive_provider_failure:${failure}`),
        ...scopes.bridge.warnings,
        ...scopes.native_identity.warnings,
        ...scopes.combined_catalog.warnings,
        ...Object.values(scopes.providers).flatMap((summary) => summary.warnings)
      ]).sort()
    },
    catalog_sync: catalogSync
  }
}

/**
 * One-patch compatibility adapter. Only v3 verified results become v2
 * verified; degraded, stale, running, and not-attempted facts cannot overclaim.
 */
export function adaptDesktopCapabilityReportV3ToV2(
  report: DesktopCapabilityReportV3,
  options: DesktopCapabilityV2AdapterOptions = {}
): CodexLbDesktopCapabilityReport {
  const codex = report.providers['codex-lb']
  const pick = (summary: ScopeCapabilitySummary, capability: string): CapabilityEvidence => {
    const result = summary.capabilities[capability]
    if (!result) return unverifiedV2(report.checked_at, 'v3_capability_not_reported')
    return {
      state: result.state === 'verified'
        ? 'verified'
        : result.state === 'blocked' || result.state === 'failed'
          ? 'blocked'
          : result.state === 'unsupported'
            ? 'unsupported'
            : 'available_unverified',
      checked_at: result.checked_at,
      source: result.source === 'artifact' ? 'deep_probe' : result.source,
      evidence: { ...result.evidence, v3_stage: result.stage, v3_scope: result.scope },
      blockers: result.state === 'failed' && result.blockers.length === 0
        ? uniqueStrings([result.root_cause || 'v3_probe_failed'])
        : [...result.blockers],
      warnings: [...result.warnings]
    }
  }
  const mapped = {
    gateway_auth_transport: pick(codex, 'provider_auth'),
    provider_identity: pick(report.native_identity, 'oauth_identity'),
    bridge: pick(report.bridge, 'websocket_transport'),
    catalog: pick(codex, 'catalog_sync'),
    model_picker: pick(report.combined_catalog, 'model_route'),
    fast_mode: pick(codex, 'fast_mode'),
    text_responses: pick(codex, 'text_responses'),
    image_generation: pick(codex, 'image_generation'),
    computer_use: pick(codex, 'computer_use'),
    browser_use: pick(codex, 'browser_use'),
    voice_mode: pick(codex, 'voice_mode'),
    plugins: pick(codex, 'plugins'),
    auxiliary_surfaces: pick(codex, 'auxiliary_surfaces')
  }
  const reportWithoutOverall = {
    schema: 'sks.codex-lb-desktop-capabilities.v2' as const,
    mode: options.mode || 'desktop-native-bridge',
    configured: options.configured === true,
    oauth_preserved: options.oauthPreserved === true,
    ...mapped
  }
  return {
    ...reportWithoutOverall,
    deep_evidence_validation: {
      schema: CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
      state: 'available_unverified',
      trusted: false,
      evidence: null,
      producer_id: null,
      created_at: null,
      content_sha256: null,
      trust_anchor_id: null,
      blockers: [],
      warnings: ['v3_scope_evidence_not_a_legacy_trust_envelope']
    },
    overall: overallCapabilityState(reportWithoutOverall)
  }
}

function catalogSyncResults(
  input: DesktopCapabilityRunnerInputV3,
  catalog: CombinedCatalogSyncStatus,
  checkedAt: string
): CapabilityProbeResultV3[] {
  const results = [catalogResult(
    input,
    'catalog:combined',
    activeCatalogCapabilityState(input, catalog),
    catalog.blockers,
    catalog.warnings,
    catalog.recovery_action,
    {
      aggregate_state: catalog.state,
      generation: catalog.generation,
      digest: catalog.digest,
      model_count: catalog.model_count,
      route_count: catalog.route_count,
      conflict_count: catalog.conflict_count
    },
    checkedAt
  )]
  for (const provider of ['codex-lb', 'openrouter'] as const) {
    const row = catalog.providers[provider]
    results.push(catalogResult(
      input,
      `provider:${provider}`,
      row.state,
      row.blockers,
      row.warnings,
      row.recovery_action,
      {
        generation: row.generation,
        digest: row.digest,
        model_count: row.model_count,
        expires_at: row.expires_at
      },
      checkedAt
    ))
  }
  return results
}

function activeCatalogCapabilityState(
  input: DesktopCapabilityRunnerInputV3,
  catalog: CombinedCatalogSyncStatus
): CombinedCatalogSyncStatus['state'] {
  if (catalog.state !== 'degraded' || catalog.conflict_count > 0) return catalog.state
  const active = providerSet(input.activeProviderIds)
  if (active.size === 0) return catalog.state
  const activeProvidersVerified = [...active].every((provider) =>
    catalog.providers[provider]?.state === 'verified')
  return activeProvidersVerified && Number(catalog.route_count || 0) > 0
    ? 'verified'
    : catalog.state
}

function catalogResult(
  input: DesktopCapabilityRunnerInputV3,
  scope: CapabilityScope,
  state: CombinedCatalogSyncStatus['state'],
  blockers: string[],
  warnings: string[],
  recoveryAction: string | null,
  evidence: Record<string, unknown>,
  checkedAt: string
): CapabilityProbeResultV3 {
  const probeState: CapabilityProbeState = state === 'verified'
    ? 'verified'
    : state === 'failed'
      ? 'blocked'
      : state === 'degraded'
        ? 'degraded'
        : state === 'stale'
          ? 'stale'
          : state === 'syncing'
            ? 'running'
            : 'not_attempted'
  const rootCause = probeState === 'blocked' ? uniqueStrings(blockers)[0] || 'catalog_sync_failed' : null
  return {
    schema: 'sks.capability-probe.v3',
    capability: 'catalog_sync',
    scope,
    requested_level: input.requestedLevel,
    stage: probeState === 'verified' ? 'complete' : 'catalog_sync',
    state: probeState,
    checked_at: checkedAt,
    report_id: input.reportId,
    correlation_id: input.correlationId,
    session_id: input.sessionId,
    attempt_id: 1,
    terminal: probeState === 'blocked',
    root_cause: rootCause,
    blockers: probeState === 'not_attempted'
      ? []
      : rootCause
        ? [rootCause]
        : uniqueStrings(blockers),
    warnings: uniqueStrings(warnings),
    retryable: probeState === 'blocked' || probeState === 'stale',
    recovery_action: recoveryAction,
    source: 'transport',
    evidence
  }
}

function normalizeV3Result(
  value: CapabilityProbeResultV3,
  input: DesktopCapabilityRunnerInputV3,
  checkedAt: string
): CapabilityProbeResultV3 {
  const bindingMatches = value.schema === 'sks.capability-probe.v3'
    && V3_SCOPES.includes(value.scope)
    && value.requested_level === input.requestedLevel
    && value.report_id === input.reportId
    && value.correlation_id === input.correlationId
    && value.session_id === input.sessionId
  if (!bindingMatches) {
    return {
      ...value,
      schema: 'sks.capability-probe.v3',
      requested_level: input.requestedLevel,
      checked_at: checkedAt,
      report_id: input.reportId,
      correlation_id: input.correlationId,
      session_id: input.sessionId,
      state: 'stale',
      terminal: false,
      root_cause: null,
      blockers: ['capability_result_binding_mismatch'],
      warnings: uniqueStrings(value.warnings),
      retryable: true,
      recovery_action: 'rerun_capability_verification',
      evidence: { ...redactCapabilityEvidence(value.evidence), stale_result_rejected: true }
    }
  }
  const requirement = requirementsForScope(value.scope)
    .find((candidate) => candidate.capability === value.capability)
  const sourceCannotVerify = value.source === 'manifest'
    || (value.source === 'config' && requirement?.minimum_level !== 'shallow')
    || value.evidence.fixture === true
  const requestedBelowCapability = requirement
    ? LEVEL_ORDER[input.requestedLevel] < LEVEL_ORDER[requirement.minimum_level]
    : false
  if (requestedBelowCapability) {
    return {
      ...value,
      state: 'not_attempted',
      terminal: false,
      root_cause: null,
      blockers: [],
      warnings: uniqueStrings([
        ...value.warnings,
        'capability_level_not_requested',
        ...(sourceCannotVerify ? ['non_live_evidence_cannot_verify'] : [])
      ]),
      retryable: false,
      recovery_action: requirement?.minimum_level === 'deep' ? 'run_deep_verification' : value.recovery_action,
      evidence: redactCapabilityEvidence(value.evidence)
    }
  }
  if (value.state === 'verified' && sourceCannotVerify) {
    return {
      ...value,
      state: 'not_attempted',
      terminal: false,
      root_cause: null,
      blockers: [],
      warnings: uniqueStrings([...value.warnings, 'non_live_evidence_cannot_verify']),
      retryable: false,
      recovery_action: requirement?.minimum_level === 'deep' ? 'run_deep_verification' : value.recovery_action,
      evidence: redactCapabilityEvidence(value.evidence)
    }
  }
  const rootCause = value.root_cause ? String(value.root_cause) : null
  const rawBlockers = uniqueStrings(value.blockers)
    .filter((blocker) => blocker !== 'desktop_bridge_websocket_transport_failed')
  const secondary = value.terminal && rootCause
    ? rawBlockers.filter((blocker) => blocker !== rootCause)
    : []
  return {
    ...value,
    root_cause: rootCause,
    blockers: value.terminal && rootCause ? [rootCause] : rawBlockers,
    warnings: uniqueStrings([
      ...value.warnings,
      ...secondary.map((blocker) => `secondary_diagnostic:${blocker}`)
    ]),
    evidence: redactCapabilityEvidence(value.evidence)
  }
}

function selectCurrentResults(
  results: CapabilityProbeResultV3[],
  input: DesktopCapabilityRunnerInputV3
): CapabilityProbeResultV3[] {
  const byKey = new Map<string, CapabilityProbeResultV3[]>()
  for (const result of results) {
    const key = `${result.scope}\u0000${result.capability}`
    const rows = byKey.get(key) || []
    rows.push(result)
    byKey.set(key, rows)
  }
  return [...byKey.values()].map((rows) => rows.sort((left, right) => {
    const currentLeft = resultBindingCurrent(left, input) ? 1 : 0
    const currentRight = resultBindingCurrent(right, input) ? 1 : 0
    return currentRight - currentLeft
      || Number(right.state !== 'stale') - Number(left.state !== 'stale')
      || right.attempt_id - left.attempt_id
      || right.checked_at.localeCompare(left.checked_at)
      || canonicalResult(left).localeCompare(canonicalResult(right))
  })[0]!).sort(resultOrder)
}

function addMissingRequirementResults(
  results: CapabilityProbeResultV3[],
  input: DesktopCapabilityRunnerInputV3,
  checkedAt: string
): CapabilityProbeResultV3[] {
  const seen = new Set(results.map((result) => `${result.scope}\u0000${result.capability}`))
  const scopes: CapabilityScope[] = ['bridge', 'native-identity', 'catalog:combined']
  for (const provider of ['codex-lb', 'openrouter'] as const) scopes.push(`provider:${provider}`)
  for (const scope of scopes) {
    for (const requirement of requirementsForScope(scope)) {
      const key = `${scope}\u0000${requirement.capability}`
      if (seen.has(key)) continue
      results.push(notAttemptedResult(input, scope, requirement.capability, checkedAt))
      seen.add(key)
    }
  }
  return results.sort(resultOrder)
}

function addBridgeDependencies(
  results: CapabilityProbeResultV3[],
  input: DesktopCapabilityRunnerInputV3,
  checkedAt: string,
  upstreamRootCause: string | null,
  providers: ReadonlySet<BridgeProviderId>
): CapabilityProbeResultV3[] {
  const existing = new Set(results.map((result) => `${result.scope}\u0000${result.capability}`))
  for (const provider of providers) {
    const key = `provider:${provider}\u0000bridge_dependency`
    if (existing.has(key)) continue
    results.push({
      schema: 'sks.capability-probe.v3',
      capability: 'bridge_dependency',
      scope: `provider:${provider}`,
      requested_level: input.requestedLevel,
      stage: 'preflight',
      state: 'blocked',
      checked_at: checkedAt,
      report_id: input.reportId,
      correlation_id: input.correlationId,
      session_id: input.sessionId,
      attempt_id: 1,
      terminal: false,
      root_cause: null,
      blockers: ['bridge_dependency_unavailable'],
      warnings: [],
      retryable: true,
      recovery_action: 'repair_bridge_service',
      source: 'transport',
      evidence: { upstream_root_cause: upstreamRootCause }
    })
  }
  return results.sort(resultOrder)
}

function summariesFromResults(
  results: readonly CapabilityProbeResultV3[],
  checkedAt: string
): DesktopCapabilityReportV3 extends infer _T ? {
  bridge: ScopeCapabilitySummary
  native_identity: ScopeCapabilitySummary
  providers: Record<BridgeProviderId, ScopeCapabilitySummary>
  combined_catalog: ScopeCapabilitySummary
} : never {
  const summary = (scope: CapabilityScope): ScopeCapabilitySummary => scopeSummary(
    scope,
    results.filter((result) => result.scope === scope),
    checkedAt
  )
  return {
    bridge: summary('bridge'),
    native_identity: summary('native-identity'),
    providers: {
      'codex-lb': summary('provider:codex-lb'),
      openrouter: summary('provider:openrouter')
    },
    combined_catalog: summary('catalog:combined')
  }
}

function scopeSummary(
  scope: CapabilityScope,
  results: readonly CapabilityProbeResultV3[],
  checkedAt: string
): ScopeCapabilitySummary {
  const ordered = [...results].sort(resultOrder)
  const capabilities = Object.fromEntries(ordered.map((result) => [result.capability, result]))
  return {
    schema: 'sks.scope-capability-summary.v1',
    scope,
    state: aggregateScopeState(scope, ordered),
    checked_at: ordered.map((result) => result.checked_at).sort().at(-1) || checkedAt,
    capabilities,
    blockers: uniqueStrings(ordered.flatMap((result) => result.blockers)).sort(),
    warnings: uniqueStrings(ordered.flatMap((result) => result.warnings)).sort()
  }
}

function aggregateScopeState(
  scope: CapabilityScope,
  results: readonly CapabilityProbeResultV3[]
): CapabilityProbeState {
  const requestedLevel = results[0]?.requested_level || 'shallow'
  const relevantCapabilities = new Set(requirementsForScope(scope)
    .filter((requirement) => LEVEL_ORDER[requirement.minimum_level] <= LEVEL_ORDER[requestedLevel])
    .map((requirement) => requirement.capability))
  const relevant = results.filter((result) => (
    relevantCapabilities.has(result.capability)
    || !requirementsForScope(scope).some((requirement) => requirement.capability === result.capability)
  ))
  const states = relevant.map((result) => result.state)
  if (states.includes('failed')) return 'failed'
  if (states.includes('blocked')) return 'blocked'
  if (states.includes('stale')) return 'stale'
  if (states.includes('degraded')) return 'degraded'
  if (states.includes('running')) return 'running'
  if (states.length > 0 && states.every((state) => state === 'verified' || state === 'unsupported')) return 'verified'
  if (states.includes('not_attempted')) return 'not_attempted'
  if (states.includes('unsupported')) return 'unsupported'
  return 'not_attempted'
}

function scopeRequirementsSatisfied(
  summary: ScopeCapabilitySummary,
  requestedLevel: CapabilityRequestedLevel,
  readiness: DesktopCapabilityRequirement['readiness']
): boolean {
  const requirements = requirementsForScope(summary.scope)
    .filter((requirement) => requirement.readiness === readiness)
    .filter((requirement) => LEVEL_ORDER[requirement.minimum_level] <= LEVEL_ORDER[requestedLevel])
  return requirements.length > 0
    && requirements.every((requirement) => summary.capabilities[requirement.capability]?.state === 'verified')
}

function requiredScopesSatisfied(
  scopes: ReturnType<typeof summariesFromResults>,
  activeProviders: ReadonlySet<BridgeProviderId>,
  requestedLevel: CapabilityRequestedLevel,
  readiness: DesktopCapabilityRequirement['readiness']
): boolean {
  return scopeRequirementsSatisfied(scopes.bridge, requestedLevel, readiness)
    && scopeRequirementsSatisfied(scopes.native_identity, requestedLevel, readiness)
    && scopeRequirementsSatisfied(scopes.combined_catalog, requestedLevel, readiness)
    && [...activeProviders].every((provider) => scopeRequirementsSatisfied(scopes.providers[provider], requestedLevel, readiness))
}

function requirementsForScope(scope: CapabilityScope): readonly DesktopCapabilityRequirement[] {
  return DESKTOP_CAPABILITY_REQUIREMENTS_V3.filter((requirement) => (
    requirement.scope === scope
    || (requirement.scope === 'provider:*' && scope.startsWith('provider:'))
  ))
}

function missingRequiredCapabilityWarnings(
  scopes: ReturnType<typeof summariesFromResults>,
  activeProviders: ReadonlySet<BridgeProviderId>,
  level: CapabilityRequestedLevel
): string[] {
  const summaries = [scopes.bridge, scopes.native_identity, scopes.combined_catalog]
  summaries.push(...[...activeProviders].map((provider) => scopes.providers[provider]))
  const warnings: string[] = []
  for (const summary of summaries) {
    for (const requirement of requirementsForScope(summary.scope)) {
      if (LEVEL_ORDER[requirement.minimum_level] > LEVEL_ORDER[level]) continue
      const state = summary.capabilities[requirement.capability]?.state
      if (state === 'not_attempted' || state === 'running' || state == null) {
        warnings.push(`required_capability_not_attempted:${summary.scope}:${requirement.capability}`)
      }
    }
  }
  return uniqueStrings(warnings).sort()
}

function bridgeTerminalCause(summary: ScopeCapabilitySummary): string | null {
  return Object.values(summary.capabilities)
    .sort(resultOrder)
    .find((result) => result.terminal && result.root_cause)?.root_cause || null
}

function scopeRootCauses(summary: ScopeCapabilitySummary): string[] {
  return Object.values(summary.capabilities)
    .map((result) => result.root_cause)
    .filter((value): value is string => Boolean(value))
}

function withoutDependencyBlocker(blockers: readonly string[]): string[] {
  return blockers.filter((blocker) => blocker !== 'bridge_dependency_unavailable')
}

function notAttemptedResult(
  input: DesktopCapabilityRunnerInputV3,
  scope: CapabilityScope,
  capability: string,
  checkedAt: string
): CapabilityProbeResultV3 {
  const deepOnly = DESKTOP_CAPABILITY_REQUIREMENTS_V3.some((requirement) => (
    (requirement.scope === scope || (requirement.scope === 'provider:*' && scope.startsWith('provider:')))
    && requirement.capability === capability
    && requirement.minimum_level === 'deep'
  ))
  return {
    schema: 'sks.capability-probe.v3',
    capability,
    scope,
    requested_level: input.requestedLevel,
    stage: 'preflight',
    state: 'not_attempted',
    checked_at: checkedAt,
    report_id: input.reportId,
    correlation_id: input.correlationId,
    session_id: input.sessionId,
    attempt_id: 0,
    terminal: false,
    root_cause: null,
    blockers: [],
    warnings: [],
    retryable: false,
    recovery_action: deepOnly ? 'run_deep_verification' : null,
    source: 'config',
    evidence: { reason: deepOnly ? 'deep_verification_not_run' : 'probe_not_run' }
  }
}

function resultBindingCurrent(
  result: CapabilityProbeResultV3,
  input: DesktopCapabilityRunnerInputV3
): boolean {
  return result.report_id === input.reportId
    && result.correlation_id === input.correlationId
    && result.session_id === input.sessionId
    && result.requested_level === input.requestedLevel
}

function resultOrder(left: CapabilityProbeResultV3, right: CapabilityProbeResultV3): number {
  return left.scope.localeCompare(right.scope)
    || left.capability.localeCompare(right.capability)
    || right.attempt_id - left.attempt_id
    || right.checked_at.localeCompare(left.checked_at)
}

function canonicalResult(value: CapabilityProbeResultV3): string {
  return JSON.stringify(value, Object.keys(value).sort())
}

function providerSet(values: readonly BridgeProviderId[]): Set<BridgeProviderId> {
  return new Set(values.filter((value): value is BridgeProviderId => value === 'codex-lb' || value === 'openrouter'))
}

function validCatalogSync(value: CombinedCatalogSyncStatus | undefined): value is CombinedCatalogSyncStatus {
  return value?.schema === 'sks.combined-catalog-sync.v1'
    && value.providers?.['codex-lb']?.schema === 'sks.catalog-sync-state.v2'
    && value.providers?.openrouter?.schema === 'sks.catalog-sync-state.v2'
}

function invalidCatalogSync(checkedAt: string): CombinedCatalogSyncStatus {
  const provider = (providerId: BridgeProviderId) => ({
    schema: 'sks.catalog-sync-state.v2' as const,
    provider_id: providerId,
    state: 'failed' as const,
    source: providerId === 'codex-lb' ? 'gateway' as const : 'openrouter' as const,
    generation: null,
    digest: null,
    model_count: null,
    checked_at: checkedAt,
    expires_at: null,
    blockers: ['capability_schema_invalid:catalog_sync_missing'],
    warnings: [],
    recovery_action: 'update_sks_and_rebuild_menubar'
  })
  return {
    schema: 'sks.combined-catalog-sync.v1',
    state: 'failed',
    generation: null,
    digest: null,
    model_count: null,
    route_count: null,
    conflict_count: 0,
    checked_at: checkedAt,
    providers: { 'codex-lb': provider('codex-lb'), openrouter: provider('openrouter') },
    blockers: ['capability_schema_invalid:catalog_sync_missing'],
    warnings: [],
    recovery_action: 'update_sks_and_rebuild_menubar'
  }
}

function unverifiedV2(checkedAt: string, reason: string): CapabilityEvidence {
  return {
    state: 'available_unverified',
    checked_at: checkedAt,
    source: 'config',
    evidence: { reason },
    blockers: [],
    warnings: []
  }
}
