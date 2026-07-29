import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { uniqueValues as unique } from '../text/strings.js'

export function validateFullReleaseStamp(input: {
  root: string
  stampFile: string
  expectedVersion: string
  expectedHead: string
}) {
  const blockers: string[] = []
  const stamp = readJson(input.stampFile)
  const pkgFile = path.join(input.root, 'package.json')
  const pkg = readJson(pkgFile) || {}
  if (stamp?.schema !== 'sks.release-check-stamp.v2') blockers.push('release_stamp_schema_invalid')
  if (stamp?.package_name !== pkg.name) blockers.push('release_stamp_package_name_mismatch')
  if (stamp?.package_version !== input.expectedVersion || pkg.version !== input.expectedVersion) blockers.push('release_stamp_version_mismatch')
  if (stamp?.package_json_sha256 !== fileSha256(pkgFile)) blockers.push('release_stamp_package_json_hash_mismatch')
  if (stamp?.git_commit !== input.expectedHead) blockers.push('release_stamp_source_commit_mismatch')
  for (const key of [
    'source_digest', 'package_files_sha256', 'release_gate_sha256', 'dist_build_sha256',
    'dist_source_digest', 'release_check_sha256', 'release_gate_contract_sha256'
  ]) {
    if (!/^[a-f0-9]{64}$/i.test(String(stamp?.[key] || ''))) blockers.push(`release_stamp_hash_invalid:${key}`)
  }
  for (const key of ['source_file_count', 'package_file_count', 'dist_file_count', 'dist_source_file_count', 'release_gate_contract_count']) {
    if (!Number.isSafeInteger(stamp?.[key]) || Number(stamp?.[key]) <= 0) blockers.push(`release_stamp_count_invalid:${key}`)
  }
  if (stamp?.release_gate_contract_schema !== 'sks.release-gate-contract.v1') blockers.push('release_stamp_gate_contract_schema_invalid')
  if (!stamp?.generated_at || Number.isNaN(Date.parse(String(stamp.generated_at)))) blockers.push('release_stamp_generated_at_invalid')
  blockers.push(...validateBoundProof(input.root, stamp?.release_gate_proof))

  const verifier = path.join(input.root, 'dist', 'scripts', 'release-check-stamp.js')
  if (!fs.existsSync(verifier)) blockers.push('release_stamp_verifier_missing')
  else {
    const verified = spawnSync(process.execPath, [verifier, 'verify'], {
      cwd: input.root,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, SKS_RELEASE_STAMP_PATH: input.stampFile }
    })
    if (verified.status !== 0) blockers.push(`release_stamp_verify_failed:${compact(verified.stderr || verified.stdout)}`)
  }
  return { ok: blockers.length === 0, stamp, blockers: unique(blockers) }
}

function validateBoundProof(root: string, proof: any): string[] {
  const blockers: string[] = []
  if (proof?.schema !== 'sks.release-check-full-proof.v1') blockers.push('release_stamp_full_proof_schema_invalid')
  if (proof?.preset !== 'release' || proof?.full !== true) blockers.push('release_stamp_not_full_release')
  if (!proof?.run_id) blockers.push('release_stamp_run_id_missing')
  if (!Number.isSafeInteger(proof?.selected_gates) || proof.selected_gates <= 0) blockers.push('release_stamp_selected_gates_invalid')
  if (proof?.completed !== proof?.selected_gates || proof?.failed !== 0) blockers.push('release_stamp_gates_not_complete')
  if (proof?.affected_mode !== 'full' || proof?.confidence !== 'full-release-proof') blockers.push('release_stamp_completion_contract_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(proof?.release_preset_gate_ids_sha256 || ''))) blockers.push('release_stamp_gate_ids_hash_invalid')
  const summary = validateManagedJson(root, proof?.summary_path, proof?.summary_sha256, 'release-gates', 'sks.release-gate-dag-run.v1')
  blockers.push(...summary.blockers.map((value) => `release_stamp_summary:${value}`))
  if (summary.value?.ok !== true || summary.value?.run_id !== proof?.run_id) blockers.push('release_stamp_summary_identity_invalid')
  const real = validateManagedJson(root, proof?.real_check_path, proof?.real_check_sha256, '', 'sks.release-real-check.v1')
  blockers.push(...real.blockers.map((value) => `release_stamp_real_check:${value}`))
  if (real.value?.ok !== true || !Array.isArray(real.value?.all_checks) || real.value.all_checks.length !== proof?.real_check_count) {
    blockers.push('release_stamp_real_check_identity_invalid')
  }
  return blockers
}

function validateManagedJson(root: string, relative: unknown, expectedHash: unknown, subdir: string, schema: string) {
  const blockers: string[] = []
  const reportRoot = path.resolve(root, '.sneakoscope', 'reports', subdir)
  const file = typeof relative === 'string' ? path.resolve(root, relative) : ''
  const rel = file ? path.relative(reportRoot, file) : '..'
  if (!file || rel.startsWith('..') || path.isAbsolute(rel)) blockers.push('path_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) blockers.push('hash_invalid')
  if (!file || !fs.existsSync(file)) return { value: null, blockers: [...blockers, 'file_missing'] }
  const bytes = fs.readFileSync(file)
  if (hash(bytes) !== expectedHash) blockers.push('hash_mismatch')
  let value: any = null
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    blockers.push('json_invalid')
  }
  if (value?.schema !== schema) blockers.push('schema_invalid')
  return { value, blockers }
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function fileSha256(file: string): string {
  try {
    return hash(fs.readFileSync(file))
  } catch {
    return ''
  }
}

function hash(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function compact(value: string): string {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 240) || 'unknown'
}
