import fs from 'node:fs/promises'
import path from 'node:path'
import { ensureDir, exists, nowIso, sha256, writeTextAtomic } from '../fsx.js'
import { codexLbBaseUrlSecurityBlocker, normalizeCodexLbBaseUrl } from './codex-lb-env.js'
import type { CodexLbDesktopMode } from './desktop-mode.js'

export const CODEX_LB_TOOL_CATALOG_FILENAME = 'sks-codex-lb-tool-catalog.json'
export const CODEX_LB_TOOL_CATALOG_SCHEMA = 'sks.codex-lb-tool-catalog.v1'
export const CODEX_LB_TOOL_CATALOG_METADATA_SCHEMA = 'sks.codex-lb-tool-catalog-metadata.v1'
export const CODEX_LB_TOOL_CATALOG_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
export const CODEX_LB_TOOL_CATALOG_MAX_MODELS = 128
const CODEX_LB_TOOL_CATALOG_MAX_METADATA_BYTES = 16 * 1024
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000
const GPT56_MODEL_RE = /^gpt-5\.6-(?:sol|terra|luna)$/
const ensureInflight = new Map<string, Promise<any>>()

const REQUIRED_MODEL_FIELDS: Record<string, readonly string[]> = {
  slug: ['string'],
  display_name: ['string'],
  supported_reasoning_levels: ['array'],
  truncation_policy: ['object']
}

type CatalogIdentity = {
  origin: string
  base_url_sha256: string
  api_key_sha256: string
  contract: 'codex-model-catalog-pass-through.v2'
}

export function isCodexLbGpt56Model(model: unknown): boolean {
  return GPT56_MODEL_RE.test(String(model || '').trim())
}

export function shouldBindLocalModelCatalog(mode: CodexLbDesktopMode): boolean {
  return mode === 'desktop-dual-auth-compat' || mode === 'cli-provider'
}

export function codexLbToolCatalogPath(codexHome: string): string {
  return path.join(path.resolve(codexHome), CODEX_LB_TOOL_CATALOG_FILENAME)
}

export function codexLbToolCatalogMetadataPath(catalogPath: string): string {
  return `${path.resolve(catalogPath)}.meta.json`
}

export function normalizeCodexLbToolCatalog(payload: any, opts: { maxModels?: number } = {}) {
  const rows = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload?.data)
      ? payload.data
      : []
  const maxModels = boundedPositiveInt(opts.maxModels, CODEX_LB_TOOL_CATALOG_MAX_MODELS)
  const limitedRows = rows.slice(0, maxModels)
  const patchedModels: string[] = []
  const gpt56Models: string[] = []
  const validationIssues: string[] = []
  const models = limitedRows.map((row: any, index: number) => {
    if (!isPlainObject(row)) {
      validationIssues.push(`codex_lb_model_catalog_row_invalid:${index}:object`)
      return {}
    }
    let normalized: Record<string, unknown>
    try {
      normalized = normalizeCodexLbModelRow(row, index)
    } catch (error) {
      validationIssues.push(error instanceof Error ? error.message : `codex_lb_model_catalog_row_invalid:${index}`)
      return {}
    }
    const model = String(normalized.slug || '').trim()
    if (isCodexLbGpt56Model(model)) gpt56Models.push(model)
    if (row.use_responses_lite !== false) patchedModels.push(model)
    validationIssues.push(...validateKnownModelFields(normalized, index))
    return normalized
  })
  const compatible = models.length > 0
    && validationIssues.length === 0
    && models.every((row: any) => row.use_responses_lite === false)
  const blockers = uniqueBounded([
    ...(rows.length ? [] : ['codex_lb_model_catalog_empty']),
    ...(rows.length > maxModels ? [`codex_lb_model_catalog_model_limit_exceeded:${rows.length}:${maxModels}`] : []),
    ...validationIssues,
    ...(compatible ? [] : ['codex_lb_model_catalog_tools_transport_incompatible'])
  ])
  return {
    schema: CODEX_LB_TOOL_CATALOG_SCHEMA,
    contract: 'codex-model-catalog-pass-through.v2',
    ok: blockers.length === 0,
    catalog: { models },
    model_count: models.length,
    gpt56_models: [...new Set(gpt56Models)].sort(),
    patched_models: [...new Set(patchedModels)].sort(),
    tools_transport: compatible ? 'full_responses' : 'unverified',
    blockers
  }
}

export async function inspectCodexLbToolCatalog(file: string, opts: {
  expectedIdentity?: CatalogIdentity | null
  maxBytes?: number
  maxModels?: number
} = {}) {
  const maxBytes = boundedPositiveInt(opts.maxBytes, CODEX_LB_TOOL_CATALOG_MAX_RESPONSE_BYTES)
  const fileSafety = await inspectSecureRegularFile(file, maxBytes, 'codex_lb_tool_catalog')
  if (!fileSafety.ok) return incompatibleInspection(file, fileSafety, fileSafety.blockers)

  let text = ''
  let payload: any = null
  try {
    text = await fs.readFile(file, 'utf8')
    payload = JSON.parse(text)
  } catch {
    return incompatibleInspection(file, fileSafety, ['codex_lb_tool_catalog_json_invalid'])
  }
  const normalized = normalizeCodexLbToolCatalog(payload, opts.maxModels === undefined ? {} : { maxModels: opts.maxModels })
  const { catalog: _catalog, ...status } = normalized
  const metadataPath = codexLbToolCatalogMetadataPath(file)
  const identityBlockers: string[] = []
  let identityVerified = false
  let cacheOrigin: string | null = null
  if (opts.expectedIdentity) {
    const metadataSafety = await inspectSecureRegularFile(metadataPath, CODEX_LB_TOOL_CATALOG_MAX_METADATA_BYTES, 'codex_lb_tool_catalog_metadata')
    if (!metadataSafety.ok) {
      identityBlockers.push(...metadataSafety.blockers)
    } else {
      try {
        const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
        cacheOrigin = typeof metadata?.identity?.origin === 'string' ? metadata.identity.origin : null
        if (metadata?.schema !== CODEX_LB_TOOL_CATALOG_METADATA_SCHEMA) identityBlockers.push('codex_lb_tool_catalog_metadata_schema_invalid')
        if (metadata?.catalog_sha256 !== sha256(text)) identityBlockers.push('codex_lb_tool_catalog_metadata_hash_mismatch')
        if (!sameCatalogIdentity(metadata?.identity, opts.expectedIdentity)) identityBlockers.push('codex_lb_tool_catalog_identity_mismatch')
        identityVerified = identityBlockers.length === 0
      } catch {
        identityBlockers.push('codex_lb_tool_catalog_metadata_json_invalid')
      }
    }
  }
  const blockers = uniqueBounded([...normalized.blockers, ...identityBlockers])
  return {
    ...status,
    ok: blockers.length === 0,
    path: file,
    exists: true,
    updated_at_ms: fileSafety.updated_at_ms,
    size_bytes: fileSafety.size_bytes,
    mode: fileSafety.mode,
    owner_uid: fileSafety.owner_uid,
    metadata_path: metadataPath,
    identity_verified: opts.expectedIdentity ? identityVerified : null,
    cache_origin: cacheOrigin,
    blockers
  }
}

export async function ensureCodexLbToolCatalog(input: {
  codexHome: string
  baseUrl: string
  apiKey: string
  outputPath?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
  maxAgeMs?: number
  maxResponseBytes?: number
  maxModels?: number
  force?: boolean
  now?: () => number
  clientVersion?: string
}) {
  const outputPath = path.resolve(input.outputPath || codexLbToolCatalogPath(input.codexHome))
  const baseUrl = normalizeCodexLbBaseUrl(input.baseUrl)
  const apiKey = String(input.apiKey || '').trim()
  const transportBlocker = catalogTransportBlocker(baseUrl)
  if (transportBlocker || !apiKey) {
    return blockedResult(outputPath, [transportBlocker || 'codex_lb_api_key_missing'])
  }

  const identity = catalogIdentity(baseUrl, apiKey)
  const inflightKey = [
    outputPath,
    identity.base_url_sha256,
    identity.api_key_sha256,
    input.force === true ? 'force' : 'normal',
    boundedPositiveInt(input.maxResponseBytes, CODEX_LB_TOOL_CATALOG_MAX_RESPONSE_BYTES),
    boundedPositiveInt(input.maxModels, CODEX_LB_TOOL_CATALOG_MAX_MODELS)
  ].join(':')
  const existing = ensureInflight.get(inflightKey)
  if (existing) return existing
  const promise = ensureValidatedCodexLbToolCatalog(input, outputPath, baseUrl, apiKey, identity)
    .finally(() => ensureInflight.delete(inflightKey))
  ensureInflight.set(inflightKey, promise)
  return promise
}

async function ensureValidatedCodexLbToolCatalog(
  input: Parameters<typeof ensureCodexLbToolCatalog>[0],
  outputPath: string,
  baseUrl: string,
  apiKey: string,
  identity: CatalogIdentity
) {
  const now = input.now ? input.now() : Date.now()
  const maxAgeMs = Math.max(0, Number(input.maxAgeMs ?? DEFAULT_MAX_AGE_MS))
  const inspectOpts = {
    expectedIdentity: identity,
    ...(input.maxResponseBytes === undefined ? {} : { maxBytes: input.maxResponseBytes }),
    ...(input.maxModels === undefined ? {} : { maxModels: input.maxModels })
  }
  const cached = await inspectCodexLbToolCatalog(outputPath, inspectOpts)
  if (!input.force && cached.ok && cacheIsFresh(cached.updated_at_ms, now, maxAgeMs)) {
    return { ...cached, generated_at: nowIso(), status: 'cached_compatible', fetched: false, required: true }
  }

  try {
    const response = await (input.fetchImpl || fetch)(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(Math.max(250, Number(input.timeoutMs || 5000)))
    })
    if (!response.ok) throw new CatalogFetchError(`codex_lb_models_http_${response.status}`)
    const payload = await readJsonResponseBounded(response, boundedPositiveInt(input.maxResponseBytes, CODEX_LB_TOOL_CATALOG_MAX_RESPONSE_BYTES))
    const normalized = normalizeCodexLbToolCatalog(payload, input.maxModels === undefined ? {} : { maxModels: input.maxModels })
    if (!normalized.ok) {
      const fallback = await inspectCodexLbToolCatalog(outputPath, inspectOpts)
      if (fallback.ok) {
        return { ...fallback, generated_at: nowIso(), status: 'cached_compatible_after_refresh_rejected', fetched: true, required: true, refresh_blockers: normalized.blockers }
      }
      const { catalog: _catalog, ...status } = normalized
      return { ...status, generated_at: nowIso(), status: 'blocked', path: outputPath, exists: await exists(outputPath), fetched: true, required: true }
    }

    await writeSecureCatalog(outputPath, normalized.catalog, identity, {
      upstream_etag: response.headers.get('etag'),
      upstream_last_modified: response.headers.get('last-modified'),
      client_version: String(input.clientVersion || 'runtime-discovered')
    })
    const verified = await inspectCodexLbToolCatalog(outputPath, inspectOpts)
    return {
      ...verified,
      generated_at: nowIso(),
      status: verified.ok ? 'repaired' : 'write_verification_failed',
      fetched: true,
      required: true,
      patched_models: normalized.patched_models,
      blockers: verified.ok ? [] : verified.blockers
    }
  } catch (error: any) {
    const fallback = await inspectCodexLbToolCatalog(outputPath, inspectOpts)
    if (fallback.ok) {
      return {
        ...fallback,
        generated_at: nowIso(),
        status: 'cached_compatible_after_refresh_failed',
        fetched: false,
        required: true,
        refresh_error: safeError(error, [apiKey])
      }
    }
    const code = error instanceof CatalogFetchError ? error.code : 'codex_lb_tool_catalog_fetch_failed'
    return {
      ...blockedResult(outputPath, uniqueBounded(['codex_lb_tool_catalog_fetch_failed', code])),
      status: 'fetch_failed',
      fetched: false,
      error: safeError(error, [apiKey])
    }
  }
}

async function readJsonResponseBounded(response: Response, maxBytes: number): Promise<any> {
  const advertised = Number(response.headers.get('content-length'))
  if (Number.isFinite(advertised) && advertised > maxBytes) throw new CatalogFetchError('codex_lb_tool_catalog_response_too_large')
  if (!response.body) {
    const text = await response.text()
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new CatalogFetchError('codex_lb_tool_catalog_response_too_large')
    return parseCatalogJson(text)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new CatalogFetchError('codex_lb_tool_catalog_response_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total)
  return parseCatalogJson(bytes.toString('utf8'))
}

function parseCatalogJson(text: string) {
  try {
    return JSON.parse(text)
  } catch {
    throw new CatalogFetchError('codex_lb_tool_catalog_response_json_invalid')
  }
}

async function writeSecureCatalog(file: string, catalog: any, identity: CatalogIdentity, upstream: {
  upstream_etag: string | null
  upstream_last_modified: string | null
  client_version: string
}) {
  const text = `${JSON.stringify(catalog, null, 2)}\n`
  const metadataPath = codexLbToolCatalogMetadataPath(file)
  const metadata = {
    schema: CODEX_LB_TOOL_CATALOG_METADATA_SCHEMA,
    generated_at: nowIso(),
    catalog_schema: CODEX_LB_TOOL_CATALOG_SCHEMA,
    catalog_sha256: sha256(text),
    identity,
    model_count: Array.isArray(catalog?.models) ? catalog.models.length : 0,
    upstream_etag: upstream.upstream_etag,
    upstream_last_modified: upstream.upstream_last_modified,
    client_version: upstream.client_version,
    unknown_fields_preserved: true,
    normalizations: ['desktop_full_responses_required']
  }
  await ensureDir(path.dirname(file))
  await writeTextAtomic(file, text, { mode: 0o600 })
  const catalogSafety = await inspectSecureRegularFile(file, CODEX_LB_TOOL_CATALOG_MAX_RESPONSE_BYTES, 'codex_lb_tool_catalog')
  if (!catalogSafety.ok) throw new CatalogFetchError(catalogSafety.blockers[0] || 'codex_lb_tool_catalog_file_insecure')
  await writeTextAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 })
  const metadataSafety = await inspectSecureRegularFile(metadataPath, CODEX_LB_TOOL_CATALOG_MAX_METADATA_BYTES, 'codex_lb_tool_catalog_metadata')
  if (!metadataSafety.ok) throw new CatalogFetchError(metadataSafety.blockers[0] || 'codex_lb_tool_catalog_metadata_file_insecure')
}

async function inspectSecureRegularFile(file: string, maxBytes: number, prefix: string) {
  const stat = await fs.lstat(file).catch(() => null)
  if (!stat) return { ok: false, exists: false, updated_at_ms: null, size_bytes: 0, mode: null, owner_uid: null, blockers: [`${prefix}_missing`] }
  const blockers: string[] = []
  if (!stat.isFile() || stat.isSymbolicLink()) blockers.push(`${prefix}_not_regular_file`)
  if (stat.size > maxBytes) blockers.push(`${prefix}_too_large:${stat.size}:${maxBytes}`)
  const ownerUid = Number.isFinite(Number(stat.uid)) ? Number(stat.uid) : null
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null
  if (expectedUid !== null && ownerUid !== expectedUid) blockers.push(`${prefix}_owner_mismatch`)
  const mode = stat.mode & 0o777
  if (process.platform !== 'win32' && mode !== 0o600) blockers.push(`${prefix}_mode_insecure:${mode.toString(8)}`)
  return { ok: blockers.length === 0, exists: true, updated_at_ms: stat.mtimeMs, size_bytes: stat.size, mode: mode.toString(8).padStart(3, '0'), owner_uid: ownerUid, blockers }
}

export function normalizeCodexLbModelRow(row: Record<string, unknown>, index = 0): Record<string, unknown> {
  const cloned = structuredClone(row)
  for (const key of Object.keys(cloned)) {
    if (isSensitiveCatalogField(key)) delete cloned[key]
  }
  const slug = String(cloned.slug ?? cloned.id ?? cloned.model ?? cloned.name ?? '').trim()
  if (!slug) throw new Error(`codex_lb_model_catalog_slug_missing:${index}`)
  if (!Object.prototype.hasOwnProperty.call(cloned, 'slug')) cloned.slug = slug
  cloned.use_responses_lite = false
  return cloned
}

function isSensitiveCatalogField(field: string): boolean {
  return /(?:^|[_-])(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set[_-]?cookie)(?:$|[_-])/i.test(field)
}

function validateKnownModelFields(row: Record<string, unknown>, index: number) {
  const issues: string[] = []
  for (const [field, allowedTypes] of Object.entries(REQUIRED_MODEL_FIELDS)) {
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      issues.push(`codex_lb_model_catalog_required_field_missing:${index}:${field}`)
      continue
    }
    if (!allowedTypes.includes(valueType(row[field]))) issues.push(`codex_lb_model_catalog_field_type_invalid:${index}:${field}`)
  }
  if (typeof row.slug === 'string' && !row.slug.trim()) issues.push(`codex_lb_model_catalog_field_empty:${index}:slug`)
  if (typeof row.display_name === 'string' && !row.display_name.trim()) issues.push(`codex_lb_model_catalog_field_empty:${index}:display_name`)
  if (Array.isArray(row.supported_reasoning_levels) && row.supported_reasoning_levels.some((entry: any) => !isPlainObject(entry) || typeof entry.effort !== 'string' || !entry.effort.trim())) {
    issues.push(`codex_lb_model_catalog_reasoning_level_invalid:${index}`)
  }
  return issues
}

function catalogTransportBlocker(baseUrl: string) {
  const blocker = codexLbBaseUrlSecurityBlocker(baseUrl)
  if (blocker) return blocker
  try {
    const url = new URL(baseUrl)
    if (url.search || url.hash) return 'codex_lb_base_url_query_or_fragment_forbidden'
    return null
  } catch {
    return 'codex_lb_invalid_base_url'
  }
}

function catalogIdentity(baseUrl: string, apiKey: string): CatalogIdentity {
  return {
    origin: new URL(baseUrl).origin,
    base_url_sha256: sha256(baseUrl),
    api_key_sha256: sha256(apiKey),
    contract: 'codex-model-catalog-pass-through.v2'
  }
}

function sameCatalogIdentity(actual: any, expected: CatalogIdentity) {
  return actual?.origin === expected.origin
    && actual?.base_url_sha256 === expected.base_url_sha256
    && actual?.api_key_sha256 === expected.api_key_sha256
    && actual?.contract === expected.contract
}

function blockedResult(outputPath: string, blockers: string[]) {
  return {
    schema: CODEX_LB_TOOL_CATALOG_SCHEMA,
    generated_at: nowIso(),
    ok: false,
    status: 'blocked',
    path: outputPath,
    exists: false,
    fetched: false,
    required: true,
    model_count: 0,
    gpt56_models: [],
    patched_models: [],
    tools_transport: 'unverified',
    blockers: uniqueBounded(blockers)
  }
}

function incompatibleInspection(file: string, safety: any, blockers: string[]) {
  return {
    schema: CODEX_LB_TOOL_CATALOG_SCHEMA,
    ok: false,
    path: file,
    exists: safety.exists === true,
    updated_at_ms: safety.updated_at_ms || null,
    size_bytes: safety.size_bytes || 0,
    mode: safety.mode || null,
    owner_uid: safety.owner_uid ?? null,
    metadata_path: codexLbToolCatalogMetadataPath(file),
    identity_verified: false,
    cache_origin: null,
    model_count: 0,
    gpt56_models: [],
    patched_models: [],
    tools_transport: 'unverified',
    blockers: uniqueBounded(blockers)
  }
}

function cacheIsFresh(updatedAtMs: unknown, now: number, maxAgeMs: number) {
  const updated = Number(updatedAtMs)
  const age = now - updated
  return Number.isFinite(updated) && Number.isFinite(age) && age >= 0 && age <= maxAgeMs
}

function boundedPositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.floor(parsed)) : fallback
}

function valueType(value: unknown) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value === 'object' ? 'object' : typeof value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function uniqueBounded(values: unknown[]) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 64)
}

function safeError(error: unknown, secrets: string[] = []): string {
  let text = String(error instanceof Error ? error.message : error || 'unknown')
  for (const secret of secrets.filter((value) => value.length >= 4)) text = text.split(secret).join('<redacted>')
  return text.replace(/(?:sk|key|token|secret)[-_a-z0-9]*/gi, '<redacted>').slice(0, 300)
}

class CatalogFetchError extends Error {
  constructor(readonly code: string) {
    super(code)
    this.name = 'CatalogFetchError'
  }
}
