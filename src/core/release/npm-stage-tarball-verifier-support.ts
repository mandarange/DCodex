import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { ReleasePackReceipt } from './release-pack-receipt.js'
import {
  localNpmStageReviewEnvironmentBlocker,
  REQUIRED_NPM_STAGE_CLI_VERSION
} from './npm-stage-contract.js'

export const NPM_STAGE_REVIEW_RECEIPT_SCHEMA = 'sks.npm-stage-review-receipt.v2'
export const NPM_STAGE_PUBLISH_RECEIPT_SCHEMA = 'sks.npm-stage-receipt.v2'
export const NPM_STAGE_REGISTRY = 'https://registry.npmjs.org/'
export const STAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const STAGE_DISPATCH_NONCE_PATTERN = /^[a-f0-9]{32}$/

export { REQUIRED_NPM_STAGE_CLI_VERSION } from './npm-stage-contract.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SHA512_PATTERN = /^[a-f0-9]{128}$/i
const INTEGRITY_PATTERN = /^sha512-[A-Za-z0-9+/]+={0,2}$/

export interface StagePublishReceipt {
  schema?: unknown
  ok?: unknown
  stage_id?: unknown
  package_name?: unknown
  package_version?: unknown
  release_tag?: unknown
  source_commit?: unknown
  tarball_sha256?: unknown
  tarball_sha512?: unknown
  tarball_integrity?: unknown
  packed_bytes?: unknown
  unpacked_bytes?: unknown
  file_count?: unknown
  dispatch_nonce?: unknown
  physical_evidence_run_id?: unknown
  workflow_run_id?: unknown
  workflow_run_attempt?: unknown
  local_pack_receipt_sha256?: unknown
  stage_command_digest?: unknown
  stage_output_digest?: unknown
  review_verifier_schema?: unknown
  oidc_review_supported?: unknown
  maintainer_session_required?: unknown
  review_required?: unknown
  approved_with_2fa?: unknown
  human_2fa_pending?: unknown
  generated_at?: unknown
}

export class NpmStageReviewError extends Error {
  readonly blocker: string

  constructor(blocker: string, message = blocker) {
    super(message)
    this.name = 'NpmStageReviewError'
    this.blocker = blocker
  }
}

export function validateStagePublishReceipt(
  receipt: StagePublishReceipt,
  expected: {
    stageId: string
    dispatchNonce: string
    physicalEvidenceRunId: string
    workflowRunId: string
    localReceipt: ReleasePackReceipt
    localReceiptSha256: string
    localTarballSha512: string
  }
): string[] {
  const blockers: string[] = []
  if (receipt.schema !== NPM_STAGE_PUBLISH_RECEIPT_SCHEMA || receipt.ok !== true) blockers.push('schema_or_status_invalid')
  if (stringValue(receipt.stage_id).toLowerCase() !== expected.stageId) blockers.push('stage_id_mismatch')
  if (stringValue(receipt.package_name) !== expected.localReceipt.package_name) blockers.push('package_name_mismatch')
  if (stringValue(receipt.package_version) !== expected.localReceipt.package_version) blockers.push('package_version_mismatch')
  if (stringValue(receipt.release_tag) !== `v${expected.localReceipt.package_version}`) blockers.push('release_tag_mismatch')
  if (stringValue(receipt.source_commit) !== String(expected.localReceipt.source_commit || '')) blockers.push('source_commit_mismatch')
  if (!SHA256_PATTERN.test(stringValue(receipt.tarball_sha256)) || stringValue(receipt.tarball_sha256) !== expected.localReceipt.sha256) blockers.push('sha256_mismatch')
  if (!SHA512_PATTERN.test(stringValue(receipt.tarball_sha512)) || stringValue(receipt.tarball_sha512) !== expected.localTarballSha512) blockers.push('sha512_mismatch')
  if (!INTEGRITY_PATTERN.test(stringValue(receipt.tarball_integrity)) || stringValue(receipt.tarball_integrity) !== expected.localReceipt.sha512_integrity) blockers.push('integrity_mismatch')
  if (numberValue(receipt.packed_bytes) !== expected.localReceipt.bytes) blockers.push('packed_bytes_mismatch')
  if (numberValue(receipt.unpacked_bytes) !== expected.localReceipt.unpacked_bytes) blockers.push('unpacked_bytes_mismatch')
  if (numberValue(receipt.file_count) !== expected.localReceipt.file_count) blockers.push('file_count_mismatch')
  if (!STAGE_DISPATCH_NONCE_PATTERN.test(stringValue(receipt.dispatch_nonce))
    || stringValue(receipt.dispatch_nonce) !== expected.dispatchNonce) blockers.push('dispatch_nonce_mismatch')
  if (!/^\d+$/.test(stringValue(receipt.physical_evidence_run_id))
    || stringValue(receipt.physical_evidence_run_id) !== expected.physicalEvidenceRunId) blockers.push('physical_evidence_run_id_mismatch')
  if (!/^\d+$/.test(stringValue(receipt.workflow_run_id))
    || stringValue(receipt.workflow_run_id) !== expected.workflowRunId) blockers.push('workflow_run_id_mismatch')
  if (!/^\d+$/.test(stringValue(receipt.workflow_run_attempt))) blockers.push('workflow_run_attempt_invalid')
  if (stringValue(receipt.local_pack_receipt_sha256) !== expected.localReceiptSha256) blockers.push('local_pack_receipt_sha256_mismatch')
  if (!SHA256_PATTERN.test(stringValue(receipt.stage_command_digest))) blockers.push('stage_command_digest_invalid')
  if (!SHA256_PATTERN.test(stringValue(receipt.stage_output_digest))) blockers.push('stage_output_digest_invalid')
  if (receipt.review_verifier_schema !== NPM_STAGE_REVIEW_RECEIPT_SCHEMA) blockers.push('review_verifier_schema_mismatch')
  if (receipt.oidc_review_supported !== false || receipt.maintainer_session_required !== true) blockers.push('review_auth_boundary_invalid')
  if (receipt.review_required !== true || receipt.approved_with_2fa !== false || receipt.human_2fa_pending !== true) blockers.push('review_boundary_invalid')
  if (!stringValue(receipt.generated_at) || Number.isNaN(Date.parse(stringValue(receipt.generated_at)))) blockers.push('generated_at_invalid')
  return unique(blockers)
}

export function compareReceiptToInspectedTarball(local: ReleasePackReceipt, inspected: ReleasePackReceipt): string[] {
  const blockers = [...inspected.blockers.map((blocker) => `inspection:${blocker}`)]
  for (const key of ['package_name', 'package_version', 'bytes', 'unpacked_bytes', 'sha256', 'sha512_integrity', 'file_count', 'file_list_sha256'] as const) {
    if (local[key] !== inspected[key]) blockers.push(`field_mismatch:${key}`)
  }
  if (path.basename(local.tarball_name) !== path.basename(inspected.tarball_name)) blockers.push('field_mismatch:tarball_name')
  if (JSON.stringify(local.secret_scan) !== JSON.stringify(inspected.secret_scan)) blockers.push('field_mismatch:secret_scan')
  if (!inspected.ok) blockers.push('inspection_not_ok')
  return unique(blockers)
}

export function assertMaintainerLocalEnvironment(env: NodeJS.ProcessEnv): void {
  const blocker = localNpmStageReviewEnvironmentBlocker(env)
  if (blocker) throw new NpmStageReviewError(blocker)
}

export function runReadOnlyNpm(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024
  })
  return {
    status: result.status,
    signal: result.signal,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: result.error || null
  }
}

export function assertCommandSucceeded(result: ReturnType<typeof runReadOnlyNpm>, blocker: string): void {
  if (result.error || result.status !== 0 || result.signal) {
    const detail = result.error instanceof Error
      ? result.error.message
      : `status=${String(result.status)} signal=${String(result.signal || '')} stderr_sha256=${hash(Buffer.from(result.stderr), 'sha256', 'hex')}`
    throw new NpmStageReviewError(blocker, detail)
  }
}

export function parseJsonObject(text: string, blocker: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    const record = recordValue(parsed)
    if (!record) throw new Error('JSON value is not an object')
    return record
  } catch (error) {
    throw new NpmStageReviewError(blocker, error instanceof Error ? error.message : String(error))
  }
}

export function readRequiredFile(file: string, blocker: string): Buffer {
  try {
    const value = fs.readFileSync(file)
    if (value.length === 0) throw new Error('file is empty')
    return value
  } catch (error) {
    throw new NpmStageReviewError(blocker, error instanceof Error ? error.message : String(error))
  }
}

export function digestTarball(value: Buffer) {
  return {
    sha256: hash(value, 'sha256', 'hex'),
    sha512: hash(value, 'sha512', 'hex'),
    integrity: `sha512-${hash(value, 'sha512', 'base64')}`
  }
}

export function hash(value: Buffer, algorithm: 'sha1' | 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algorithm).update(value).digest(encoding)
}

export function recordCheck(checks: Record<string, boolean>, blockers: string[], name: string, ok: boolean): void {
  checks[name] = ok
  if (!ok) blockers.push(name)
}

export function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function nullableString(value: unknown): string | null {
  const normalized = stringValue(value).trim()
  return normalized || null
}

export function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : -1
}

export function npmSafeName(name: string): string {
  return name.replace('@', '').replace('/', '-')
}

export function displayPath(root: string, file: string): string {
  const relative = path.relative(root, file)
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return normalizePath(relative)
  return path.basename(file)
}

export function normalizePath(value: string): string {
  return value.split(path.sep).join('/')
}

export function writePrivate(file: string, value: Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, value, { mode: 0o600 })
  fs.chmodSync(file, 0o600)
}

export function writePrivateJson(file: string, value: unknown): void {
  writePrivate(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`))
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}
