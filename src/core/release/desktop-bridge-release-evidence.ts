import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const DESKTOP_BRIDGE_RELEASE_EVIDENCE_SCHEMA = 'sks.desktop-bridge-release-evidence.v1'
export const DESKTOP_BRIDGE_PRODUCTION_ADAPTER_RECEIPT_SCHEMA = 'sks.desktop-bridge-production-adapter-receipt.v1'
export const DESKTOP_BRIDGE_RELEASE_PROVIDERS = ['codex-lb', 'openrouter'] as const
export const DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES = [
  'fast_mode',
  'image_generation',
  'computer_use',
  'browser_use',
  'voice_mode',
  'plugins',
  'auxiliary_surfaces'
] as const

const SHA256_RE = /^[a-f0-9]{64}$/i
const ID_RE = /^[a-z0-9][a-z0-9._:/-]{2,159}$/i
const MAX_EVIDENCE_FILE_BYTES = 16 * 1024 * 1024
const MIN_NATIVE_SCREENSHOT_WIDTH = 640
const MIN_NATIVE_SCREENSHOT_HEIGHT = 360
const MAX_RELEASE_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_RELEASE_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1000

export interface DesktopBridgeReleaseEvidenceInspection {
  readonly schema: 'sks.desktop-bridge-release-evidence-inspection.v1'
  readonly ok: boolean
  readonly report_path: string
  readonly report_sha256: string | null
  readonly adapter_receipt_path: string | null
  readonly adapter_receipt_sha256: string | null
  readonly adapter_id: string | null
  readonly adapter_version: string | null
  readonly adapter_run_id: string | null
  readonly adapter_receipt_id: string | null
  readonly native_screenshot_path: string | null
  readonly native_screenshot_sha256: string | null
  readonly providers: string[]
  readonly deep_artifact_count: number
  readonly blockers: string[]
}

export function desktopBridgeReleaseSourceIdentitySha256(version: string, sourceCommit: string): string {
  return sha256(Buffer.from(`sks.desktop-bridge-release-source.v1\n${version}\n${sourceCommit.toLowerCase()}\n`))
}

export function desktopBridgeDeepArtifactManifestSha256(value: unknown): string {
  const artifacts = Array.isArray(value) ? value : []
  const rows = artifacts.map((entry: any) => ({
    provider_id: String(entry?.provider_id || ''),
    capability: String(entry?.capability || ''),
    artifact_path: String(entry?.artifact_path || ''),
    artifact_sha256: String(entry?.artifact_sha256 || '').toLowerCase(),
    producer_receipt_id: String(entry?.producer_receipt_id || '')
  })).sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
  return sha256(Buffer.from(canonicalJson(rows)))
}

export function inspectDesktopBridgeReleaseEvidence(input: {
  evidenceRoot: string
  reportPath: string
  expectedVersion: string
  expectedSourceCommit: string
  now?: Date
}): DesktopBridgeReleaseEvidenceInspection {
  const evidenceRoot = path.resolve(input.evidenceRoot)
  const blockers: string[] = []
  const reportFile = resolveEvidenceFile(evidenceRoot, input.reportPath)
  const reportBytes = reportFile ? readRegularFile(reportFile, 'report', blockers) : null
  const report = reportBytes ? parseJson(reportBytes, 'report', blockers) : null
  const reportSha256 = reportBytes ? sha256(reportBytes) : null
  const sourceIdentitySha256 = desktopBridgeReleaseSourceIdentitySha256(input.expectedVersion, input.expectedSourceCommit)

  if (!reportFile) blockers.push('desktop_bridge_release_report_path_invalid')
  if (report?.schema !== DESKTOP_BRIDGE_RELEASE_EVIDENCE_SCHEMA) blockers.push('desktop_bridge_release_report_schema_invalid')
  if (report?.ok !== true || report?.status !== 'passed' || report?.release_authorizing !== true) {
    blockers.push('desktop_bridge_release_report_not_authorizing')
  }
  if (report?.evidence_kind !== 'real'
    || report?.fixture !== false
    || report?.mock !== false
    || report?.synthetic !== false) blockers.push('desktop_bridge_release_report_not_real')
  if (report?.capture_platform !== 'darwin' || report?.native_runtime !== 'desktop-bridge') {
    blockers.push('desktop_bridge_release_platform_invalid')
  }
  if (report?.package_version !== input.expectedVersion) blockers.push('desktop_bridge_release_version_mismatch')
  if (report?.source_commit !== input.expectedSourceCommit) blockers.push('desktop_bridge_release_source_commit_mismatch')
  if (report?.source_identity_sha256 !== sourceIdentitySha256) blockers.push('desktop_bridge_release_source_identity_mismatch')
  const now = input.now?.getTime() ?? Date.now()
  if (!validFreshDate(report?.captured_at, now)) blockers.push('desktop_bridge_release_capture_time_invalid')
  if (!Array.isArray(report?.blockers) || report.blockers.length > 0) blockers.push('desktop_bridge_release_report_blockers_present')
  if (containsSecretMaterial(report)) blockers.push('desktop_bridge_release_secret_material_present')

  const providerIds = validateProviders(report?.providers, blockers)
  validateOAuth(report?.oauth, blockers)
  validateWebSocket(report?.websocket, blockers)

  const screenshotPath = String(report?.native_ui?.screenshot_path || '')
  const screenshot = validateBoundArtifact({
    evidenceRoot,
    relativePath: screenshotPath,
    expectedSha256: report?.native_ui?.screenshot_sha256,
    label: 'native_screenshot',
    blockers
  })
  if (report?.native_ui?.schema !== 'sks.desktop-bridge-native-ui-evidence.v1'
    || report?.native_ui?.app !== 'sks-menubar'
    || report?.native_ui?.visible_provider_ids?.length !== DESKTOP_BRIDGE_RELEASE_PROVIDERS.length
    || !sameStrings(report?.native_ui?.visible_provider_ids, DESKTOP_BRIDGE_RELEASE_PROVIDERS)
    || report?.native_ui?.fixture !== false
    || report?.native_ui?.mock !== false
    || report?.native_ui?.synthetic !== false) blockers.push('desktop_bridge_release_native_ui_contract_invalid')
  if (screenshot.bytes && !validNativeScreenshot(screenshot.bytes)) blockers.push('desktop_bridge_release_native_screenshot_invalid')

  const deepArtifacts = Array.isArray(report?.deep_artifacts) ? report.deep_artifacts : []
  validateDeepArtifacts(deepArtifacts, evidenceRoot, blockers)
  const adapter = validateProductionAdapterReceipt({
    value: report?.production_adapter,
    evidenceRoot,
    expectedVersion: input.expectedVersion,
    expectedSourceCommit: input.expectedSourceCommit,
    expectedSourceIdentitySha256: sourceIdentitySha256,
    now,
    deepArtifacts,
    blockers
  })

  return {
    schema: 'sks.desktop-bridge-release-evidence-inspection.v1',
    ok: blockers.length === 0,
    report_path: reportFile ? relative(evidenceRoot, reportFile) : input.reportPath,
    report_sha256: reportSha256,
    adapter_receipt_path: adapter.path,
    adapter_receipt_sha256: adapter.sha256,
    adapter_id: adapter.adapter_id,
    adapter_version: adapter.adapter_version,
    adapter_run_id: adapter.run_id,
    adapter_receipt_id: adapter.receipt_id,
    native_screenshot_path: screenshot.path,
    native_screenshot_sha256: screenshot.sha256,
    providers: providerIds,
    deep_artifact_count: deepArtifacts.length,
    blockers: unique(blockers)
  }
}

function validateProviders(value: unknown, blockers: string[]): string[] {
  if (!isRecord(value) || !sameStrings(Object.keys(value), DESKTOP_BRIDGE_RELEASE_PROVIDERS)) {
    blockers.push('desktop_bridge_release_provider_inventory_invalid')
    return []
  }
  const verified: string[] = []
  for (const providerId of DESKTOP_BRIDGE_RELEASE_PROVIDERS) {
    const provider = value[providerId]
    const valid = isRecord(provider)
      && provider.provider_id === providerId
      && provider.enabled === true
      && provider.credential_state === 'ready'
      && /^sha256:[a-f0-9]{64}$/i.test(String(provider.credential_fingerprint || ''))
      && provider.auth_verified === true
      && provider.catalog_verified === true
      && provider.text_response_verified === true
      && provider.no_fallback_verified === true
      && sameStrings(provider.deep_capabilities, DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES)
      && Array.isArray(provider.blockers)
      && provider.blockers.length === 0
    if (!valid) blockers.push(`desktop_bridge_release_provider_invalid:${providerId}`)
    else verified.push(providerId)
  }
  return verified
}

function validateOAuth(value: unknown, blockers: string[]): void {
  if (!isRecord(value)
    || value.schema !== 'sks.desktop-bridge-oauth-preservation-evidence.v1'
    || !SHA256_RE.test(String(value.auth_before_sha256 || ''))
    || value.auth_before_sha256 !== value.auth_after_sha256
    || !SHA256_RE.test(String(value.semantic_identity_before_sha256 || ''))
    || value.semantic_identity_before_sha256 !== value.semantic_identity_after_sha256
    || value.semantic_identity_preserved !== true
    || value.auth_file_bytes_preserved !== true
    || value.oauth_forwarded_to_provider !== false
    || value.fixture !== false
    || value.mock !== false
    || value.synthetic !== false) blockers.push('desktop_bridge_release_oauth_preservation_invalid')
}

function validateWebSocket(value: unknown, blockers: string[]): void {
  if (!isRecord(value)
    || value.schema !== 'sks.desktop-bridge-websocket-release-evidence.v1'
    || value.upgrade_verified !== true
    || value.protocol_verified !== true
    || value.frame_round_trip_verified !== true
    || value.clean_close_verified !== true
    || value.fixture !== false
    || value.mock !== false
    || value.synthetic !== false
    || !Number.isFinite(value.latency_ms)
    || Number(value.latency_ms) < 0) blockers.push('desktop_bridge_release_websocket_invalid')
}

function validateDeepArtifacts(value: unknown[], evidenceRoot: string, blockers: string[]): void {
  const expected = new Set(DESKTOP_BRIDGE_RELEASE_PROVIDERS.flatMap((providerId) =>
    DESKTOP_BRIDGE_RELEASE_DEEP_CAPABILITIES.map((capability) => `${providerId}:${capability}`)))
  const seen = new Set<string>()
  const paths = new Set<string>()
  for (const artifact of value) {
    const providerId = String((artifact as any)?.provider_id || '')
    const capability = String((artifact as any)?.capability || '')
    const key = `${providerId}:${capability}`
    if (!expected.has(key)) {
      blockers.push(`desktop_bridge_release_deep_artifact_unknown:${key}`)
      continue
    }
    if (seen.has(key)) blockers.push(`desktop_bridge_release_deep_artifact_duplicate:${key}`)
    seen.add(key)
    if ((artifact as any)?.schema !== 'sks.desktop-bridge-deep-artifact.v1'
      || (artifact as any)?.evidence_kind !== 'real'
      || (artifact as any)?.attempted !== true
      || (artifact as any)?.verified !== true
      || (artifact as any)?.stale !== false
      || (artifact as any)?.fixture !== false
      || (artifact as any)?.mock !== false
      || (artifact as any)?.synthetic !== false
      || !ID_RE.test(String((artifact as any)?.producer_receipt_id || ''))) {
      blockers.push(`desktop_bridge_release_deep_artifact_invalid:${key}`)
    }
    const bound = validateBoundArtifact({
      evidenceRoot,
      relativePath: String((artifact as any)?.artifact_path || ''),
      expectedSha256: (artifact as any)?.artifact_sha256,
      label: `deep_artifact:${key}`,
      blockers
    })
    if (bound.bytes && containsSecretBytes(bound.bytes)) blockers.push(`desktop_bridge_release_deep_artifact_secret_material:${key}`)
    if (bound.path && paths.has(bound.path)) blockers.push(`desktop_bridge_release_deep_artifact_path_reused:${bound.path}`)
    if (bound.path) paths.add(bound.path)
  }
  for (const key of expected) {
    if (!seen.has(key)) blockers.push(`desktop_bridge_release_deep_artifact_missing:${key}`)
  }
}

function validateProductionAdapterReceipt(input: {
  value: unknown
  evidenceRoot: string
  expectedVersion: string
  expectedSourceCommit: string
  expectedSourceIdentitySha256: string
  now: number
  deepArtifacts: unknown[]
  blockers: string[]
}): {
  path: string | null
  sha256: string | null
  adapter_id: string | null
  adapter_version: string | null
  run_id: string | null
  receipt_id: string | null
} {
  const adapter = input.value
  if (!isRecord(adapter)
    || adapter.schema !== 'sks.desktop-bridge-production-adapter-binding.v1'
    || !ID_RE.test(String(adapter.adapter_id || ''))
    || !ID_RE.test(String(adapter.adapter_version || ''))
    || !ID_RE.test(String(adapter.run_id || ''))
    || !ID_RE.test(String(adapter.receipt_id || ''))
    || adapter.execution_mode !== 'production'
    || adapter.fixture !== false
    || adapter.mock !== false
    || adapter.synthetic !== false) {
    input.blockers.push('desktop_bridge_release_production_adapter_invalid')
  }
  const receipt = validateBoundArtifact({
    evidenceRoot: input.evidenceRoot,
    relativePath: String((adapter as any)?.receipt_path || ''),
    expectedSha256: (adapter as any)?.receipt_sha256,
    label: 'production_adapter_receipt',
    blockers: input.blockers
  })
  const parsed = receipt.bytes ? parseJson(receipt.bytes, 'production_adapter_receipt', input.blockers) : null
  if (parsed?.schema !== DESKTOP_BRIDGE_PRODUCTION_ADAPTER_RECEIPT_SCHEMA
    || parsed?.ok !== true
    || parsed?.release_authorizing !== true
    || parsed?.execution_mode !== 'production'
    || parsed?.adapter_id !== (adapter as any)?.adapter_id
    || parsed?.adapter_version !== (adapter as any)?.adapter_version
    || parsed?.run_id !== (adapter as any)?.run_id
    || parsed?.receipt_id !== (adapter as any)?.receipt_id
    || parsed?.package_version !== input.expectedVersion
    || parsed?.source_commit !== input.expectedSourceCommit
    || parsed?.source_identity_sha256 !== input.expectedSourceIdentitySha256
    || parsed?.fixture !== false
    || parsed?.mock !== false
    || parsed?.synthetic !== false
    || parsed?.redacted !== true
    || parsed?.secrets_present !== false
    || !sameStrings(parsed?.provider_ids, DESKTOP_BRIDGE_RELEASE_PROVIDERS)
    || parsed?.artifact_manifest_sha256 !== desktopBridgeDeepArtifactManifestSha256(input.deepArtifacts)
    || !validFreshDate(parsed?.executed_at, input.now)
    || !Array.isArray(parsed?.blockers)
    || parsed.blockers.length > 0
    || containsSecretMaterial(parsed)) input.blockers.push('desktop_bridge_release_production_adapter_receipt_invalid')
  const mismatchedProducer = input.deepArtifacts.some((artifact: any) =>
    artifact?.producer_receipt_id !== (adapter as any)?.receipt_id)
  if (mismatchedProducer) input.blockers.push('desktop_bridge_release_deep_artifact_producer_mismatch')
  return {
    path: receipt.path,
    sha256: receipt.sha256,
    adapter_id: ID_RE.test(String(parsed?.adapter_id || '')) ? String(parsed.adapter_id) : null,
    adapter_version: ID_RE.test(String(parsed?.adapter_version || '')) ? String(parsed.adapter_version) : null,
    run_id: ID_RE.test(String(parsed?.run_id || '')) ? String(parsed.run_id) : null,
    receipt_id: ID_RE.test(String(parsed?.receipt_id || '')) ? String(parsed.receipt_id) : null
  }
}

function validateBoundArtifact(input: {
  evidenceRoot: string
  relativePath: string
  expectedSha256: unknown
  label: string
  blockers: string[]
}): { path: string | null; sha256: string | null; bytes: Buffer | null } {
  const file = resolveEvidenceFile(input.evidenceRoot, input.relativePath)
  if (!file) {
    input.blockers.push(`desktop_bridge_release_${input.label}_path_invalid`)
    return { path: null, sha256: null, bytes: null }
  }
  const bytes = readRegularFile(file, input.label, input.blockers)
  if (!bytes) return { path: relative(input.evidenceRoot, file), sha256: null, bytes: null }
  const actual = sha256(bytes)
  if (!SHA256_RE.test(String(input.expectedSha256 || '')) || actual !== String(input.expectedSha256).toLowerCase()) {
    input.blockers.push(`desktop_bridge_release_${input.label}_hash_mismatch`)
  }
  return { path: relative(input.evidenceRoot, file), sha256: actual, bytes }
}

function resolveEvidenceFile(root: string, relativePath: string): string | null {
  if (!relativePath || path.isAbsolute(relativePath)) return null
  const file = path.resolve(root, relativePath)
  const rel = path.relative(path.resolve(root), file)
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? file : null
}

function readRegularFile(file: string, label: string, blockers: string[]): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_EVIDENCE_FILE_BYTES) {
      blockers.push(`desktop_bridge_release_${label}_file_invalid`)
      return null
    }
    return fs.readFileSync(file)
  } catch {
    blockers.push(`desktop_bridge_release_${label}_missing`)
    return null
  }
}

function validNativeScreenshot(bytes: Buffer): boolean {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (bytes.length < signature.length + 12 || !bytes.subarray(0, signature.length).equals(signature)) return false
  let offset = signature.length
  let chunkIndex = 0
  let sawHeader = false
  let sawImageData = false
  let sawEnd = false
  while (offset < bytes.length) {
    if (sawEnd || offset + 12 > bytes.length) return false
    const length = bytes.readUInt32BE(offset)
    const chunkEnd = offset + 12 + length
    if (chunkEnd > bytes.length) return false
    const typeBytes = bytes.subarray(offset + 4, offset + 8)
    const type = typeBytes.toString('ascii')
    if (!/^[A-Za-z]{4}$/.test(type)) return false
    const data = bytes.subarray(offset + 8, offset + 8 + length)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    if (pngCrc32(Buffer.concat([typeBytes, data])) !== expectedCrc) return false
    if (chunkIndex === 0 && type !== 'IHDR') return false
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) return false
      sawHeader = true
      const width = data.readUInt32BE(0)
      const height = data.readUInt32BE(4)
      const bitDepth = data[8]!
      const colorType = data[9]!
      const validBitDepth = (colorType === 0 && [1, 2, 4, 8, 16].includes(bitDepth))
        || (colorType === 2 && [8, 16].includes(bitDepth))
        || (colorType === 3 && [1, 2, 4, 8].includes(bitDepth))
        || ([4, 6].includes(colorType) && [8, 16].includes(bitDepth))
      if (width < MIN_NATIVE_SCREENSHOT_WIDTH
        || height < MIN_NATIVE_SCREENSHOT_HEIGHT
        || !validBitDepth
        || data[10] !== 0
        || data[11] !== 0
        || ![0, 1].includes(data[12]!)) return false
    } else if (!sawHeader) {
      return false
    } else if (type === 'IDAT') {
      if (length < 1 || sawEnd) return false
      sawImageData = true
    } else if (type === 'IEND') {
      if (length !== 0 || !sawImageData) return false
      sawEnd = true
    }
    offset = chunkEnd
    chunkIndex += 1
  }
  return sawHeader && sawImageData && sawEnd && offset === bytes.length
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function parseJson(bytes: Buffer, label: string, blockers: string[]): any | null {
  try {
    const parsed = JSON.parse(bytes.toString('utf8'))
    if (!isRecord(parsed)) throw new Error('not_object')
    return parsed
  } catch {
    blockers.push(`desktop_bridge_release_${label}_json_invalid`)
    return null
  }
}

function containsSecretMaterial(value: unknown): boolean {
  const visit = (entry: unknown): boolean => {
    if (Array.isArray(entry)) return entry.some(visit)
    if (!isRecord(entry)) {
      return typeof entry === 'string' && /\b(?:sk|or|sess|key)-[A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(entry)
    }
    for (const [key, child] of Object.entries(entry)) {
      if (/(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret_value|credential_value)/i.test(key)) return true
      if (visit(child)) return true
    }
    return false
  }
  return visit(value)
}

function containsSecretBytes(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false
  const text = bytes.toString('utf8')
  return /(?:"|')?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret_value|credential_value)(?:"|')?\s*[:=]/i.test(text)
    || /\b(?:sk|or|sess|key)-[A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(text)
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  return JSON.stringify(value.map(String).sort()) === JSON.stringify([...expected].sort())
}

function validFreshDate(value: unknown, now: number): boolean {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(timestamp)
    && timestamp <= now + MAX_RELEASE_EVIDENCE_FUTURE_SKEW_MS
    && now - timestamp <= MAX_RELEASE_EVIDENCE_AGE_MS
}

function relative(root: string, file: string): string {
  return path.relative(path.resolve(root), path.resolve(file)).split(path.sep).join('/')
}

function sha256(bytes: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}
