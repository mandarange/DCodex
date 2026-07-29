import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  CapabilityProbeState,
  CapabilitySignal,
  CodexLbCapabilityKey,
  CodexLbDesktopCapabilityReport,
  CodexLbDesktopMode,
  GatewayAuthTransport
} from './capability-types.js'
import { runAuxiliarySurfacesProbe, type AuxiliarySurfacesProbeInput } from './probes/auxiliary-surfaces-probe.js'
import { runBridgeProbe, gatewayAuthTransportEvidence, type BridgeProbeInput } from './probes/bridge-probe.js'
import { runCatalogProbe, type CatalogProbeInput } from './probes/catalog-probe.js'
import { runComputerUseProbe, type ComputerUseProbeInput } from './probes/computer-use-probe.js'
import { runImageGenerationProbe, type ImageGenerationProbeInput } from './probes/image-generation-probe.js'
import { probeEvidence } from './probes/probe-evidence.js'
import { runVoiceRealtimeProbe, type VoiceRealtimeProbeInput } from './probes/voice-realtime-probe.js'
import {
  CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
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
  state: CapabilityProbeState
  configured: boolean
  oauth_preserved: boolean
  gateway_auth_transport: GatewayAuthTransport
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
      blockers: ['codex_lb_deep_evidence_missing'],
      warnings: []
    },
    overall: overallCapabilityState(reportWithoutOverall)
  }
}

export function overallCapabilityState(
  report: Omit<CodexLbDesktopCapabilityReport, 'overall' | 'deep_evidence_validation'>
): CapabilityProbeState {
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
