import { sha256 } from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'
import type { BridgeProviderId, CapabilityProbeState } from './bridge-contracts.js'
import type { CodexLbDesktopMode } from './desktop-mode.js'

export const CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA = 'sks.codex-lb-trusted-deep-evidence.v1' as const
export const CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA = 'sks.codex-lb-deep-evidence-trust-anchor.v1' as const
export const CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA = 'sks.codex-lb-deep-evidence-trust-anchor-set.v1' as const
export const CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA = 'sks.codex-lb-deep-evidence-validation.v1' as const
export const DEFAULT_CODEX_LB_DEEP_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000
export const CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA = 'sks.capability-trusted-deep-evidence.v2' as const
export const CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA = 'sks.capability-deep-evidence-trust-anchor.v2' as const
export const CAPABILITY_DEEP_EVIDENCE_VALIDATION_SCHEMA = 'sks.capability-deep-evidence-validation.v2' as const
const DEFAULT_FUTURE_SKEW_MS = 60 * 1000
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,127}$/i

const PAYLOAD_KEYS = new Set([
  'fixture',
  'provider_identity_verified',
  'picker_control_visible',
  'picker_selected_model',
  'configured_service_tier',
  'request_service_tier',
  'response_actual_service_tier',
  'bridge_websocket_round_trip',
  'image_route',
  'image_request_tools_present',
  'image_events',
  'image_artifact_materialized',
  'computer_events',
  'computer_executor_completed',
  'computer_output_submitted',
  'computer_follow_up_completed',
  'computer_session_affinity_preserved',
  'browser_use_verified',
  'voice_create_verified',
  'voice_location_received',
  'voice_location_rewritten',
  'voice_websocket_upgraded',
  'voice_server_event_seen',
  'voice_clean_close',
  'voice_owner_binding_verified',
  'plugins_verified',
  'auxiliary_routes_observed',
  'auxiliary_events',
  'auxiliary_output_events',
  'auxiliary_request_body_hash_preserved',
  'auxiliary_owner_affinity_verified',
  'desktop_adoption_verified',
  'desktop_adoption_source',
  'oauth_bytes_unchanged_before_restart',
  'oauth_semantic_identity_verified_after_restart',
  'built_in_openai_provider_retained',
  'fast_selector_visible',
  'fast_effective_verified',
  'text_response_verified',
  'code_mcp_search_verified',
  'files_transcribe_verified',
  'memory_thread_goal_routes_verified',
  'existing_thread_resumed',
  'new_thread_created',
  'disable_routing_verified',
  'rollback_byte_exact_verified',
  'app_restart_recovery_verified',
  'mac_reboot_recovery_verified',
  'remote_other_mac_runtime_verified',
  'auth_mode_independence_verified',
  'source_surface',
  'desktop_build',
  'codex_core_version',
  'protocol_fixture_schema_hash',
  'app_origin_observed'
])

const BOOLEAN_PAYLOAD_KEYS = new Set([
  'fixture',
  'provider_identity_verified',
  'picker_control_visible',
  'bridge_websocket_round_trip',
  'image_request_tools_present',
  'image_artifact_materialized',
  'computer_executor_completed',
  'computer_output_submitted',
  'computer_follow_up_completed',
  'computer_session_affinity_preserved',
  'browser_use_verified',
  'voice_create_verified',
  'voice_location_received',
  'voice_location_rewritten',
  'voice_websocket_upgraded',
  'voice_server_event_seen',
  'voice_clean_close',
  'voice_owner_binding_verified',
  'plugins_verified',
  'auxiliary_request_body_hash_preserved',
  'auxiliary_owner_affinity_verified',
  'desktop_adoption_verified',
  'oauth_bytes_unchanged_before_restart',
  'oauth_semantic_identity_verified_after_restart',
  'built_in_openai_provider_retained',
  'fast_selector_visible',
  'fast_effective_verified',
  'text_response_verified',
  'code_mcp_search_verified',
  'files_transcribe_verified',
  'memory_thread_goal_routes_verified',
  'existing_thread_resumed',
  'new_thread_created',
  'disable_routing_verified',
  'rollback_byte_exact_verified',
  'app_restart_recovery_verified',
  'mac_reboot_recovery_verified',
  'remote_other_mac_runtime_verified',
  'auth_mode_independence_verified'
])

const NULLABLE_STRING_PAYLOAD_KEYS = new Set([
  'picker_selected_model',
  'configured_service_tier',
  'request_service_tier',
  'response_actual_service_tier',
  'desktop_adoption_source',
  'source_surface',
  'desktop_build',
  'codex_core_version',
  'protocol_fixture_schema_hash',
  'app_origin_observed'
])

const ARRAY_PAYLOAD_KEYS = new Set([
  'image_events',
  'computer_events',
  'auxiliary_routes_observed',
  'auxiliary_events',
  'auxiliary_output_events'
])

export interface CodexLbDeepEvidenceProducer {
  id: string
  version: string
  run_id: string
}

export interface CodexLbDeepEvidenceTarget {
  mode: CodexLbDesktopMode
  endpoint: string
}

export interface CodexLbDeepEvidenceIntegrity {
  algorithm: 'sha256'
  content_sha256: string
  trust_anchor_id: string
}

export interface CodexLbTrustedDeepEvidenceEnvelope {
  schema: typeof CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA
  producer: CodexLbDeepEvidenceProducer
  created_at: string
  target: CodexLbDeepEvidenceTarget
  payload: Record<string, unknown>
  integrity: CodexLbDeepEvidenceIntegrity
}

export interface CodexLbDeepEvidenceTrustAnchor {
  schema: typeof CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA
  anchor_id: string
  producer: CodexLbDeepEvidenceProducer
  target: CodexLbDeepEvidenceTarget
  content_sha256: string
}

export interface CodexLbDeepEvidenceTrustAnchorSet {
  schema: typeof CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA
  anchors: CodexLbDeepEvidenceTrustAnchor[]
}

export interface CodexLbDeepEvidenceTrustAnchorSetValidation {
  schema: typeof CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA
  ok: boolean
  anchors: CodexLbDeepEvidenceTrustAnchor[]
  blockers: string[]
}

export interface ValidateCodexLbDeepEvidenceOptions {
  expectedMode: CodexLbDesktopMode
  expectedEndpoint: string
  trustAnchors?: readonly CodexLbDeepEvidenceTrustAnchor[]
  now?: Date | number | string
  maxAgeMs?: number
  maxFutureSkewMs?: number
}

export interface CodexLbDeepEvidenceValidation {
  schema: typeof CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA
  state: 'verified' | 'available_unverified' | 'blocked'
  trusted: boolean
  evidence: Record<string, unknown> | null
  producer_id: string | null
  created_at: string | null
  content_sha256: string | null
  trust_anchor_id: string | null
  blockers: string[]
  warnings: string[]
}

export interface CapabilityDeepEvidenceTargetV2 {
  provider_id: BridgeProviderId
  capability: string
  report_id: string
}

export interface CapabilityTrustedDeepEvidenceEnvelopeV2 {
  schema: typeof CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA
  producer: CodexLbDeepEvidenceProducer
  created_at: string
  target: CapabilityDeepEvidenceTargetV2
  payload: Record<string, unknown>
  integrity: CodexLbDeepEvidenceIntegrity
}

export interface CapabilityDeepEvidenceTrustAnchorV2 {
  schema: typeof CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA
  anchor_id: string
  producer: CodexLbDeepEvidenceProducer
  target: CapabilityDeepEvidenceTargetV2
  content_sha256: string
}

export interface ValidateCapabilityDeepEvidenceOptionsV2 {
  expectedProviderId: BridgeProviderId
  expectedCapability: string
  expectedReportId: string
  trustAnchors?: readonly CapabilityDeepEvidenceTrustAnchorV2[]
  now?: Date | number | string
  maxAgeMs?: number
  maxFutureSkewMs?: number
}

export interface CapabilityDeepEvidenceValidationV2 {
  schema: typeof CAPABILITY_DEEP_EVIDENCE_VALIDATION_SCHEMA
  state: Extract<CapabilityProbeState, 'not_attempted' | 'verified' | 'blocked' | 'stale'>
  trusted: boolean
  provider_id: BridgeProviderId
  capability: string
  report_id: string
  evidence: Record<string, unknown> | null
  producer_id: string | null
  created_at: string | null
  content_sha256: string | null
  trust_anchor_id: string | null
  blockers: string[]
  warnings: string[]
}

/**
 * Validate one provider/feature/report-bound evidence bundle. Missing evidence
 * is not a transport blocker, and a failure can affect only the named target.
 */
export function validateCapabilityDeepEvidenceV2(
  value: unknown,
  options: ValidateCapabilityDeepEvidenceOptionsV2
): CapabilityDeepEvidenceValidationV2 {
  if (value == null) return capabilityValidation(options, 'not_attempted', [], [])
  const blockers: string[] = []
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'producer', 'created_at', 'target', 'payload', 'integrity'])) {
    return capabilityValidation(options, 'blocked', ['capability_deep_evidence_schema_invalid'], [])
  }
  if (value.schema !== CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA) blockers.push('capability_deep_evidence_schema_invalid')
  const producer = parseProducer(value.producer, blockers, 'evidence')
  const target = parseCapabilityTarget(value.target, blockers)
  const integrity = parseIntegrity(value.integrity, blockers)
  const payload = isRecord(value.payload) ? value.payload : null
  if (!payload) blockers.push('capability_deep_evidence_payload_invalid')
  const createdAt = typeof value.created_at === 'string' ? value.created_at : ''
  const createdAtMs = Date.parse(createdAt)
  if (!createdAt || !Number.isFinite(createdAtMs)) blockers.push('capability_deep_evidence_created_at_invalid')

  if (target?.provider_id !== options.expectedProviderId) blockers.push('capability_deep_evidence_provider_mismatch')
  if (target?.capability !== options.expectedCapability) blockers.push('capability_deep_evidence_capability_mismatch')
  if (target?.report_id !== options.expectedReportId) blockers.push('capability_deep_evidence_report_mismatch')

  const nowMs = normalizeNow(options.now)
  const maxAgeMs = positiveFinite(options.maxAgeMs, DEFAULT_CODEX_LB_DEEP_EVIDENCE_MAX_AGE_MS)
  const futureSkewMs = positiveFinite(options.maxFutureSkewMs, DEFAULT_FUTURE_SKEW_MS)
  const stale = Number.isFinite(createdAtMs) && createdAtMs < nowMs - maxAgeMs
  if (Number.isFinite(createdAtMs) && createdAtMs > nowMs + futureSkewMs) {
    blockers.push('capability_deep_evidence_created_at_in_future')
  }

  let contentSha256: string | null = null
  if (producer && target && payload && createdAt && integrity) {
    contentSha256 = capabilityDeepEvidenceContentSha256V2({
      schema: CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA,
      producer,
      created_at: createdAt,
      target,
      payload
    })
    if (integrity.content_sha256 !== contentSha256) blockers.push('capability_deep_evidence_content_sha256_mismatch')
  }
  const anchor = integrity
    ? (options.trustAnchors || []).find((candidate) => candidate.anchor_id === integrity.trust_anchor_id)
    : null
  if (!anchor) blockers.push('capability_deep_evidence_trust_anchor_missing')
  else validateCapabilityAnchor(anchor, producer, target, contentSha256, blockers)

  const fixture = payload?.fixture === true
  const common = {
    producer_id: producer?.id || null,
    created_at: createdAt || null,
    content_sha256: contentSha256,
    trust_anchor_id: integrity?.trust_anchor_id || null
  }
  if (fixture) {
    return {
      ...capabilityValidation(options, 'not_attempted', [], ['capability_deep_evidence_fixture_unverified']),
      ...common
    }
  }
  if (blockers.length > 0 || !payload) {
    return {
      ...capabilityValidation(options, 'blocked', unique(blockers), []),
      ...common
    }
  }
  if (stale) {
    return {
      ...capabilityValidation(options, 'stale', ['capability_deep_evidence_stale'], []),
      ...common
    }
  }
  return {
    ...capabilityValidation(options, 'verified', [], []),
    ...common,
    trusted: true,
    evidence: redactCapabilityEvidence(payload)
  }
}

export function capabilityDeepEvidenceContentSha256V2(
  content: Omit<CapabilityTrustedDeepEvidenceEnvelopeV2, 'integrity'>
): string {
  return sha256(canonicalJson(content))
}

/** Redact key-like fields and token-shaped strings before evidence reaches UI/logs. */
export function redactCapabilityEvidence(value: Record<string, unknown>): Record<string, unknown> {
  return redactRecord(value)
}

/**
 * Root integration API:
 *   const validation = validateCodexLbDesktopDeepEvidence(raw, {
 *     expectedMode: context.mode,
 *     expectedEndpoint: target.baseUrl,
 *     trustAnchors
 *   })
 *   const deep = validation.evidence ?? {}
 *
 * Any capability fed by `deep` must also receive validation.blockers when
 * validation.state === "blocked". Never pass the raw envelope to a probe.
 */
export function validateCodexLbDesktopDeepEvidence(
  value: unknown,
  options: ValidateCodexLbDeepEvidenceOptions
): CodexLbDeepEvidenceValidation {
  if (value == null) return validation('available_unverified', ['codex_lb_deep_evidence_missing'])
  const blockers: string[] = []
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'producer', 'created_at', 'target', 'payload', 'integrity'])) {
    return validation('blocked', ['codex_lb_deep_evidence_schema_invalid'])
  }
  if (value.schema !== CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA) blockers.push('codex_lb_deep_evidence_schema_invalid')
  const producer = parseProducer(value.producer, blockers, 'evidence')
  const target = parseTarget(value.target, blockers, 'evidence')
  const integrity = parseIntegrity(value.integrity, blockers)
  const payload = parsePayload(value.payload, blockers)
  const createdAt = typeof value.created_at === 'string' ? value.created_at : ''
  const createdAtMs = Date.parse(createdAt)
  if (!createdAt || !Number.isFinite(createdAtMs)) blockers.push('codex_lb_deep_evidence_created_at_invalid')

  const expectedEndpoint = normalizeEndpoint(options.expectedEndpoint)
  const evidenceEndpoint = target ? normalizeEndpoint(target.endpoint) : null
  if (!expectedEndpoint) blockers.push('codex_lb_deep_evidence_expected_endpoint_invalid')
  if (target && target.mode !== options.expectedMode) blockers.push('codex_lb_deep_evidence_target_mode_mismatch')
  if (target && (!evidenceEndpoint || evidenceEndpoint !== expectedEndpoint)) blockers.push('codex_lb_deep_evidence_target_endpoint_mismatch')

  const nowMs = normalizeNow(options.now)
  const maxAgeMs = positiveFinite(options.maxAgeMs, DEFAULT_CODEX_LB_DEEP_EVIDENCE_MAX_AGE_MS)
  const futureSkewMs = positiveFinite(options.maxFutureSkewMs, DEFAULT_FUTURE_SKEW_MS)
  if (Number.isFinite(createdAtMs) && createdAtMs < nowMs - maxAgeMs) blockers.push('codex_lb_deep_evidence_stale')
  if (Number.isFinite(createdAtMs) && createdAtMs > nowMs + futureSkewMs) blockers.push('codex_lb_deep_evidence_created_at_in_future')

  let contentSha256: string | null = null
  if (producer && target && payload && createdAt && integrity) {
    contentSha256 = codexLbDeepEvidenceContentSha256({
      schema: CODEX_LB_TRUSTED_DEEP_EVIDENCE_SCHEMA,
      producer,
      created_at: createdAt,
      target,
      payload
    })
    if (integrity.content_sha256 !== contentSha256) blockers.push('codex_lb_deep_evidence_content_sha256_mismatch')
  }

  const anchor = integrity
    ? (options.trustAnchors || []).find((candidate) => candidate.anchor_id === integrity.trust_anchor_id)
    : null
  if (!anchor) {
    blockers.push('codex_lb_deep_evidence_trust_anchor_missing')
  } else {
    validateAnchor(anchor, producer, target, contentSha256, blockers)
  }

  if (payload?.fixture === true) {
    return {
      ...validation('available_unverified', unique([...blockers, 'codex_lb_deep_evidence_fixture_unverified'])),
      producer_id: producer?.id || null,
      created_at: createdAt || null,
      content_sha256: contentSha256,
      trust_anchor_id: integrity?.trust_anchor_id || null
    }
  }
  if (blockers.length || !payload) {
    return {
      ...validation('blocked', unique(blockers.length ? blockers : ['codex_lb_deep_evidence_invalid'])),
      producer_id: producer?.id || null,
      created_at: createdAt || null,
      content_sha256: contentSha256,
      trust_anchor_id: integrity?.trust_anchor_id || null
    }
  }
  return {
    schema: CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
    state: 'verified',
    trusted: true,
    evidence: payload,
    producer_id: producer!.id,
    created_at: createdAt,
    content_sha256: contentSha256,
    trust_anchor_id: integrity!.trust_anchor_id,
    blockers: [],
    warnings: []
  }
}

export function codexLbDeepEvidenceContentSha256(
  content: Omit<CodexLbTrustedDeepEvidenceEnvelope, 'integrity'>
): string {
  return sha256(canonicalJson(content))
}

export function parseCodexLbDeepEvidenceTrustAnchorSet(
  value: unknown
): CodexLbDeepEvidenceTrustAnchorSetValidation {
  if (!isRecord(value) || !hasExactKeys(value, ['schema', 'anchors'])) {
    return {
      schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
      ok: false,
      anchors: [],
      blockers: ['codex_lb_deep_evidence_trust_anchor_set_invalid']
    }
  }
  if (
    value.schema !== CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA
    || !Array.isArray(value.anchors)
    || value.anchors.length === 0
  ) {
    return {
      schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
      ok: false,
      anchors: [],
      blockers: ['codex_lb_deep_evidence_trust_anchor_set_invalid']
    }
  }
  const blockers: string[] = []
  const anchors: CodexLbDeepEvidenceTrustAnchor[] = []
  const seen = new Set<string>()
  for (const [index, candidate] of value.anchors.entries()) {
    const candidateBlockers: string[] = []
    validateAnchor(candidate as CodexLbDeepEvidenceTrustAnchor, null, null, null, candidateBlockers)
    const anchorId = isRecord(candidate) && typeof candidate.anchor_id === 'string'
      ? candidate.anchor_id
      : ''
    if (anchorId && seen.has(anchorId)) candidateBlockers.push('codex_lb_deep_evidence_trust_anchor_duplicate')
    if (anchorId) seen.add(anchorId)
    if (candidateBlockers.length) {
      blockers.push(...candidateBlockers.map((blocker) => `${blocker}:${index}`))
      continue
    }
    anchors.push(candidate as unknown as CodexLbDeepEvidenceTrustAnchor)
  }
  return {
    schema: CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SET_SCHEMA,
    ok: blockers.length === 0 && anchors.length === value.anchors.length,
    anchors: blockers.length === 0 ? anchors : [],
    blockers: unique(blockers)
  }
}

function validateAnchor(
  anchor: CodexLbDeepEvidenceTrustAnchor,
  producer: CodexLbDeepEvidenceProducer | null,
  target: CodexLbDeepEvidenceTarget | null,
  contentSha256: string | null,
  blockers: string[]
): void {
  if (!isRecord(anchor) || !hasExactKeys(anchor, ['schema', 'anchor_id', 'producer', 'target', 'content_sha256'])) {
    blockers.push('codex_lb_deep_evidence_trust_anchor_invalid')
    return
  }
  if (anchor.schema !== CODEX_LB_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA) blockers.push('codex_lb_deep_evidence_trust_anchor_invalid')
  if (typeof anchor.anchor_id !== 'string' || !ID_PATTERN.test(anchor.anchor_id)) blockers.push('codex_lb_deep_evidence_trust_anchor_invalid')
  const anchorProducer = parseProducer(anchor.producer, blockers, 'anchor')
  const anchorTarget = parseTarget(anchor.target, blockers, 'anchor')
  if (!SHA256_PATTERN.test(anchor.content_sha256)) blockers.push('codex_lb_deep_evidence_trust_anchor_hash_invalid')
  if (contentSha256 && anchor.content_sha256 !== contentSha256) blockers.push('codex_lb_deep_evidence_trust_anchor_hash_mismatch')
  if (producer && anchorProducer && canonicalJson(producer) !== canonicalJson(anchorProducer)) blockers.push('codex_lb_deep_evidence_trust_anchor_producer_mismatch')
  if (target && anchorTarget && (
    target.mode !== anchorTarget.mode
    || normalizeEndpoint(target.endpoint) !== normalizeEndpoint(anchorTarget.endpoint)
  )) blockers.push('codex_lb_deep_evidence_trust_anchor_target_mismatch')
}

function parseProducer(value: unknown, blockers: string[], scope: 'evidence' | 'anchor'): CodexLbDeepEvidenceProducer | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'version', 'run_id'])) {
    blockers.push(`codex_lb_deep_evidence_${scope}_producer_invalid`)
    return null
  }
  for (const key of ['id', 'version', 'run_id'] as const) {
    if (typeof value[key] !== 'string' || !ID_PATTERN.test(value[key])) {
      blockers.push(`codex_lb_deep_evidence_${scope}_producer_invalid`)
      return null
    }
  }
  return value as unknown as CodexLbDeepEvidenceProducer
}

function parseTarget(value: unknown, blockers: string[], scope: 'evidence' | 'anchor'): CodexLbDeepEvidenceTarget | null {
  if (!isRecord(value) || !hasExactKeys(value, ['mode', 'endpoint'])) {
    blockers.push(`codex_lb_deep_evidence_${scope}_target_invalid`)
    return null
  }
  if (!['desktop-native-bridge', 'desktop-dual-auth-compat', 'cli-provider', 'disabled'].includes(String(value.mode))) {
    blockers.push(`codex_lb_deep_evidence_${scope}_target_invalid`)
    return null
  }
  if (typeof value.endpoint !== 'string' || !normalizeEndpoint(value.endpoint)) {
    blockers.push(`codex_lb_deep_evidence_${scope}_target_invalid`)
    return null
  }
  return value as unknown as CodexLbDeepEvidenceTarget
}

function parseIntegrity(value: unknown, blockers: string[]): CodexLbDeepEvidenceIntegrity | null {
  if (!isRecord(value) || !hasExactKeys(value, ['algorithm', 'content_sha256', 'trust_anchor_id'])) {
    blockers.push('codex_lb_deep_evidence_integrity_invalid')
    return null
  }
  if (
    value.algorithm !== 'sha256'
    || typeof value.content_sha256 !== 'string'
    || !SHA256_PATTERN.test(value.content_sha256)
    || typeof value.trust_anchor_id !== 'string'
    || !ID_PATTERN.test(value.trust_anchor_id)
  ) {
    blockers.push('codex_lb_deep_evidence_integrity_invalid')
    return null
  }
  return value as unknown as CodexLbDeepEvidenceIntegrity
}

function parsePayload(value: unknown, blockers: string[]): Record<string, unknown> | null {
  if (!isRecord(value)) {
    blockers.push('codex_lb_deep_evidence_payload_invalid')
    return null
  }
  const unknown = Object.keys(value).filter((key) => !PAYLOAD_KEYS.has(key))
  if (unknown.length) blockers.push('codex_lb_deep_evidence_payload_unknown_fields')
  for (const [key, entry] of Object.entries(value)) {
    if (BOOLEAN_PAYLOAD_KEYS.has(key) && typeof entry !== 'boolean') blockers.push(`codex_lb_deep_evidence_payload_type_invalid:${key}`)
    if (NULLABLE_STRING_PAYLOAD_KEYS.has(key) && entry !== null && typeof entry !== 'string') blockers.push(`codex_lb_deep_evidence_payload_type_invalid:${key}`)
    if (ARRAY_PAYLOAD_KEYS.has(key) && !Array.isArray(entry)) blockers.push(`codex_lb_deep_evidence_payload_type_invalid:${key}`)
    if (key === 'image_route' && entry !== null && !['responses_tool', 'images_api'].includes(String(entry))) {
      blockers.push('codex_lb_deep_evidence_payload_type_invalid:image_route')
    }
    if (key === 'auxiliary_routes_observed' && Array.isArray(entry) && entry.some((item) => typeof item !== 'string')) {
      blockers.push('codex_lb_deep_evidence_payload_type_invalid:auxiliary_routes_observed')
    }
  }
  return blockers.some((blocker) => blocker.startsWith('codex_lb_deep_evidence_payload_')) ? null : value
}

function normalizeEndpoint(value: string): string | null {
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null
    const pathname = url.pathname.replace(/\/+$/, '') || '/'
    return `${url.protocol}//${url.host}${pathname}`
  } catch {
    return null
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function normalizeNow(value: Date | number | string | undefined): number {
  if (value instanceof Date) return value.getTime()
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return Date.now()
}

function positiveFinite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === [...expected].sort()[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function parseCapabilityTarget(
  value: unknown,
  blockers: string[]
): CapabilityDeepEvidenceTargetV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['provider_id', 'capability', 'report_id'])) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  if (value.provider_id !== 'codex-lb' && value.provider_id !== 'openrouter') {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  if (typeof value.capability !== 'string' || !ID_PATTERN.test(value.capability)) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  if (typeof value.report_id !== 'string' || !ID_PATTERN.test(value.report_id)) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  return value as unknown as CapabilityDeepEvidenceTargetV2
}

function validateCapabilityAnchor(
  anchor: CapabilityDeepEvidenceTrustAnchorV2,
  producer: CodexLbDeepEvidenceProducer | null,
  target: CapabilityDeepEvidenceTargetV2 | null,
  contentSha256: string | null,
  blockers: string[]
): void {
  if (!isRecord(anchor) || !hasExactKeys(anchor, ['schema', 'anchor_id', 'producer', 'target', 'content_sha256'])) {
    blockers.push('capability_deep_evidence_trust_anchor_invalid')
    return
  }
  if (anchor.schema !== CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA) blockers.push('capability_deep_evidence_trust_anchor_invalid')
  if (!ID_PATTERN.test(anchor.anchor_id)) blockers.push('capability_deep_evidence_trust_anchor_invalid')
  const anchorProducer = parseProducer(anchor.producer, blockers, 'anchor')
  const anchorTarget = parseCapabilityTarget(anchor.target, blockers)
  if (!SHA256_PATTERN.test(anchor.content_sha256)) blockers.push('capability_deep_evidence_trust_anchor_hash_invalid')
  if (contentSha256 && anchor.content_sha256 !== contentSha256) blockers.push('capability_deep_evidence_trust_anchor_hash_mismatch')
  if (producer && anchorProducer && canonicalJson(producer) !== canonicalJson(anchorProducer)) {
    blockers.push('capability_deep_evidence_trust_anchor_producer_mismatch')
  }
  if (target && anchorTarget && canonicalJson(target) !== canonicalJson(anchorTarget)) {
    blockers.push('capability_deep_evidence_trust_anchor_target_mismatch')
  }
}

function capabilityValidation(
  options: ValidateCapabilityDeepEvidenceOptionsV2,
  state: CapabilityDeepEvidenceValidationV2['state'],
  blockers: string[],
  warnings: string[]
): CapabilityDeepEvidenceValidationV2 {
  return {
    schema: CAPABILITY_DEEP_EVIDENCE_VALIDATION_SCHEMA,
    state,
    trusted: false,
    provider_id: options.expectedProviderId,
    capability: options.expectedCapability,
    report_id: options.expectedReportId,
    evidence: null,
    producer_id: null,
    created_at: null,
    content_sha256: null,
    trust_anchor_id: null,
    blockers,
    warnings
  }
}

function redactRecord(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/(?:authorization|api[_-]?key|token|secret|credential)/i.test(key)) return [key, '[REDACTED]']
    if (typeof entry === 'string') return [key, redactString(entry)]
    if (Array.isArray(entry)) return [key, entry.map((item) => (
      isRecord(item) ? redactRecord(item) : typeof item === 'string' ? redactString(item) : item
    ))]
    if (isRecord(entry)) return [key, redactRecord(entry)]
    return [key, entry]
  }))
}

function redactString(value: string): string {
  return value
    .replace(/\b(?:sk|or|sess|key)-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}/gi, 'Bearer [REDACTED]')
}

function validation(
  state: CodexLbDeepEvidenceValidation['state'],
  blockers: string[]
): CodexLbDeepEvidenceValidation {
  return {
    schema: CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
    state,
    trusted: false,
    evidence: null,
    producer_id: null,
    created_at: null,
    content_sha256: null,
    trust_anchor_id: null,
    blockers,
    warnings: []
  }
}
