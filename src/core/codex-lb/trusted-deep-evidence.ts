import { sha256 } from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'
import type {
  BridgeProviderId,
  CapabilityProbeState,
  CapabilityScope
} from './bridge-contracts.js'

export const CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA = 'sks.capability-trusted-deep-evidence.v2' as const
export const CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA = 'sks.capability-deep-evidence-trust-anchor.v2' as const
export const CAPABILITY_DEEP_EVIDENCE_VALIDATION_SCHEMA = 'sks.capability-deep-evidence-validation.v2' as const
export const DEFAULT_CAPABILITY_DEEP_EVIDENCE_MAX_AGE_MS = 15 * 60 * 1000

const DEFAULT_FUTURE_SKEW_MS = 60 * 1000
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,127}$/i

export interface CapabilityDeepEvidenceProducerV2 {
  id: string
  version: string
  run_id: string
}

export interface CapabilityDeepEvidenceIntegrityV2 {
  algorithm: 'sha256'
  content_sha256: string
  trust_anchor_id: string
}

export interface CapabilityDeepEvidenceTargetV2 {
  provider_id: BridgeProviderId
  scope: CapabilityScope
  capability: string
  report_id: string
  catalog_generation: string
  endpoint: string
}

export interface CapabilityTrustedDeepEvidenceEnvelopeV2 {
  schema: typeof CAPABILITY_TRUSTED_DEEP_EVIDENCE_SCHEMA
  producer: CapabilityDeepEvidenceProducerV2
  created_at: string
  target: CapabilityDeepEvidenceTargetV2
  payload: Record<string, unknown>
  integrity: CapabilityDeepEvidenceIntegrityV2
}

export interface CapabilityDeepEvidenceTrustAnchorV2 {
  schema: typeof CAPABILITY_DEEP_EVIDENCE_TRUST_ANCHOR_SCHEMA
  anchor_id: string
  producer: CapabilityDeepEvidenceProducerV2
  target: CapabilityDeepEvidenceTargetV2
  content_sha256: string
}

export interface ValidateCapabilityDeepEvidenceOptionsV2 {
  expectedProviderId: BridgeProviderId
  expectedScope: CapabilityScope
  expectedCapability: string
  expectedReportId: string
  expectedCatalogGeneration: string
  expectedEndpoint: string
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
  scope: CapabilityScope
  capability: string
  report_id: string
  catalog_generation: string
  endpoint: string
  evidence: Record<string, unknown> | null
  producer_id: string | null
  created_at: string | null
  content_sha256: string | null
  trust_anchor_id: string | null
  blockers: string[]
  warnings: string[]
}

/** Validate one provider/scope/generation/endpoint-bound evidence bundle. */
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

  const expectedEndpoint = normalizeEndpoint(options.expectedEndpoint)
  const evidenceEndpoint = target ? normalizeEndpoint(target.endpoint) : null
  if (!expectedEndpoint) blockers.push('capability_deep_evidence_expected_endpoint_invalid')
  if (target?.provider_id !== options.expectedProviderId) blockers.push('capability_deep_evidence_provider_mismatch')
  if (target?.scope !== options.expectedScope) blockers.push('capability_deep_evidence_scope_mismatch')
  if (target?.capability !== options.expectedCapability) blockers.push('capability_deep_evidence_capability_mismatch')
  if (target?.report_id !== options.expectedReportId) blockers.push('capability_deep_evidence_report_mismatch')
  if (target?.catalog_generation !== options.expectedCatalogGeneration) blockers.push('capability_deep_evidence_generation_mismatch')
  if (target && evidenceEndpoint !== expectedEndpoint) blockers.push('capability_deep_evidence_endpoint_mismatch')

  const nowMs = normalizeNow(options.now)
  const maxAgeMs = positiveFinite(options.maxAgeMs, DEFAULT_CAPABILITY_DEEP_EVIDENCE_MAX_AGE_MS)
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

  const common = {
    producer_id: producer?.id || null,
    created_at: createdAt || null,
    content_sha256: contentSha256,
    trust_anchor_id: integrity?.trust_anchor_id || null
  }
  if (payload?.fixture === true) {
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

export function redactCapabilityText(value: string): string {
  return redactString(value)
}

function parseProducer(
  value: unknown,
  blockers: string[],
  scope: 'evidence' | 'anchor'
): CapabilityDeepEvidenceProducerV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'version', 'run_id'])) {
    blockers.push(`capability_deep_evidence_${scope}_producer_invalid`)
    return null
  }
  for (const key of ['id', 'version', 'run_id'] as const) {
    if (typeof value[key] !== 'string' || !ID_PATTERN.test(value[key])) {
      blockers.push(`capability_deep_evidence_${scope}_producer_invalid`)
      return null
    }
  }
  return value as unknown as CapabilityDeepEvidenceProducerV2
}

function parseIntegrity(value: unknown, blockers: string[]): CapabilityDeepEvidenceIntegrityV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, ['algorithm', 'content_sha256', 'trust_anchor_id'])) {
    blockers.push('capability_deep_evidence_integrity_invalid')
    return null
  }
  if (
    value.algorithm !== 'sha256'
    || typeof value.content_sha256 !== 'string'
    || !SHA256_PATTERN.test(value.content_sha256)
    || typeof value.trust_anchor_id !== 'string'
    || !ID_PATTERN.test(value.trust_anchor_id)
  ) {
    blockers.push('capability_deep_evidence_integrity_invalid')
    return null
  }
  return value as unknown as CapabilityDeepEvidenceIntegrityV2
}

function parseCapabilityTarget(value: unknown, blockers: string[]): CapabilityDeepEvidenceTargetV2 | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    'provider_id',
    'scope',
    'capability',
    'report_id',
    'catalog_generation',
    'endpoint'
  ])) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  const providerId = value.provider_id
  if (providerId !== 'codex-lb' && providerId !== 'openrouter') {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  if (value.scope !== `provider:${providerId}`) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  for (const key of ['capability', 'report_id', 'catalog_generation'] as const) {
    if (typeof value[key] !== 'string' || !ID_PATTERN.test(value[key])) {
      blockers.push('capability_deep_evidence_target_invalid')
      return null
    }
  }
  if (typeof value.endpoint !== 'string' || !normalizeEndpoint(value.endpoint)) {
    blockers.push('capability_deep_evidence_target_invalid')
    return null
  }
  return value as unknown as CapabilityDeepEvidenceTargetV2
}

function validateCapabilityAnchor(
  anchor: CapabilityDeepEvidenceTrustAnchorV2,
  producer: CapabilityDeepEvidenceProducerV2 | null,
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
    scope: options.expectedScope,
    capability: options.expectedCapability,
    report_id: options.expectedReportId,
    catalog_generation: options.expectedCatalogGeneration,
    endpoint: normalizeEndpoint(options.expectedEndpoint) || options.expectedEndpoint,
    evidence: null,
    producer_id: null,
    created_at: null,
    content_sha256: null,
    trust_anchor_id: null,
    blockers,
    warnings
  }
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
  const sortedExpected = [...expected].sort()
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
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
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|credential)\s*[=:]\s*["']?)[A-Za-z0-9._~+/-]{8,}/gi, '$1[REDACTED]')
}
