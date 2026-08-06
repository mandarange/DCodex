#!/usr/bin/env node
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  compareReleasePacks,
  inspectLocalReleaseSourceState,
  inspectReleaseTarball,
  releaseProofDir,
  validateLocalReleasePackBinding,
  writeReleaseJson,
  type ReleasePackKind,
  type ReleasePackReceipt
} from '../core/release/release-pack-receipt.js'
import { normalizeNpmPackInfo, readCurrentNpmPackGateArtifacts } from '../core/release/npm-pack-proof.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const action = process.argv[2] || 'create'
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const proofDir = releaseProofDir(root, String(pkg.version || 'unknown'))

if (action === 'create') createLocalReceipt()
else if (action === 'verify') verifyLocalReceipt()
else if (action === 'inspect') inspectDownloadedReceipt()
else if (action === 'compare') compareReceipts()
else fail(`unknown action: ${action}`)

function createLocalReceipt() {
  const sourceBeforePack = inspectLocalReleaseSourceState(root)
  if (!sourceBeforePack.ok) fail('source tree is not clean and fully tracked for npm pack', sourceBeforePack.blockers.join('\n'))
  const outputDir = path.resolve(root, option('--output-dir') || path.join(proofDir, 'artifacts'))
  fs.mkdirSync(outputDir, { recursive: true })
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, npm_config_cache: process.env.SKS_RELEASE_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache') }
  })
  if (result.status !== 0) fail('npm pack failed', result.stderr || result.stdout)
  let info: any
  try {
    const parsed = JSON.parse(String(result.stdout || '[]'))
    info = Array.isArray(parsed) ? parsed[0] : parsed
  } catch {
    fail('npm pack output was not JSON')
  }
  const tarball = path.join(outputDir, String(info?.filename || ''))
  const gate = readCurrentNpmPackGateArtifacts(root)
  const receipt = inspectReleaseTarball({
    tarball,
    kind: 'local',
    sourceCommit: sourceBeforePack.head,
    root,
    ...(gate.ok && gate.proof ? {
      npmPackProof: {
        proof_id: gate.proof.proof_id,
        info_sha256: gate.proof.info_digest,
        file_list_sha256: gate.proof.file_list_digest
      }
    } : {})
  })
  if (!gate.ok) receipt.blockers.push(...gate.blockers.map((blocker) => `npm_pack_gate:${blocker}`))
  const normalizedInfo = normalizeNpmPackInfo(info || {})
  const actualInfoSha256 = sha256Json(normalizedInfo)
  const actualFileListSha256 = sha256Json(normalizedInfo.files)
  if (gate.proof && gate.proof.info_digest !== actualInfoSha256) receipt.blockers.push('npm_pack_proof_info_digest_mismatch')
  if (gate.proof && gate.proof.file_list_digest !== actualFileListSha256) receipt.blockers.push('npm_pack_proof_file_list_digest_mismatch')
  if (receipt.package_name !== pkg.name) receipt.blockers.push('pack_metadata_name_mismatch')
  if (receipt.package_version !== pkg.version) receipt.blockers.push('pack_metadata_version_mismatch')
  if (Number(info?.size || 0) !== receipt.bytes) receipt.blockers.push('pack_metadata_size_mismatch')
  if (Number(info?.unpackedSize || 0) !== receipt.unpacked_bytes) receipt.blockers.push('pack_metadata_unpacked_size_mismatch')
  if (Number(info?.entryCount || 0) !== receipt.file_count) receipt.blockers.push('pack_metadata_file_count_mismatch')
  if (String(info?.integrity || '') !== receipt.sha512_integrity) receipt.blockers.push('pack_metadata_integrity_mismatch')
  const sourceAfterPack = inspectLocalReleaseSourceState(root)
  if (!sourceAfterPack.ok) receipt.blockers.push(...sourceAfterPack.blockers.map((blocker) => `post_pack_source:${blocker}`))
  if (sourceAfterPack.head !== sourceBeforePack.head) receipt.blockers.push('post_pack_source_commit_changed')
  if (sourceAfterPack.source_tree_sha256 !== sourceBeforePack.source_tree_sha256) receipt.blockers.push('post_pack_source_tree_digest_changed')
  receipt.ok = receipt.blockers.length === 0
  const binding = validateLocalReleasePackBinding(root, receipt)
  if (!binding.ok) receipt.blockers.push(...binding.blockers.map((blocker) => `local_binding:${blocker}`))
  receipt.blockers = [...new Set(receipt.blockers)]
  receipt.ok = receipt.blockers.length === 0
  const file = path.join(proofDir, 'pack-receipt.json')
  writeReleaseJson(file, receipt)
  emit(receipt, file)
}

function verifyLocalReceipt() {
  const file = path.join(proofDir, 'pack-receipt.json')
  const receipt = readReceipt(file)
  const validation = validateLocalReleasePackBinding(root, receipt)
  const blockers = [
    ...(Array.isArray(receipt.blockers) ? receipt.blockers : ['pack_receipt_blockers_invalid']),
    ...validation.blockers.map((blocker) => `local_binding:${blocker}`)
  ]
  if (receipt.package_name !== pkg.name) blockers.push('pack_metadata_name_mismatch')
  if (receipt.package_version !== pkg.version) blockers.push('pack_metadata_version_mismatch')
  const report = { ...receipt, ok: blockers.length === 0, blockers: [...new Set(blockers)] }
  emit(report, file)
}

function inspectDownloadedReceipt() {
  const tarball = required('--tarball')
  const kind = String(option('--kind') || 'staged') as ReleasePackKind
  if (kind !== 'local' && kind !== 'staged') fail('--kind must be local or staged')
  const receipt = inspectReleaseTarball({ tarball, kind, sourceCommit: option('--source-commit') || null, root })
  const file = path.resolve(root, option('--output') || path.join(proofDir, `${kind}-pack-receipt.json`))
  writeReleaseJson(file, receipt)
  emit(receipt, file)
}

function compareReceipts() {
  const local = readReceipt(required('--local'))
  const staged = readReceipt(required('--staged'))
  const comparison = compareReleasePacks(local, staged)
  const binding = validateLocalReleasePackBinding(root, local)
  if (!binding.ok) comparison.blockers.push(...binding.blockers.map((blocker) => `local_binding:${blocker}`))
  comparison.blockers = [...new Set(comparison.blockers)]
  comparison.ok = comparison.blockers.length === 0
  const file = path.resolve(root, option('--output') || path.join(proofDir, 'pack-compare.json'))
  writeReleaseJson(file, comparison)
  emit(comparison, file)
}

function readReceipt(file: string): ReleasePackReceipt {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(root, file), 'utf8'))
  } catch (error: any) {
    fail(`unable to read receipt ${file}`, error?.message || String(error))
  }
}

function sha256Json(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function required(name: string): string {
  const value = option(name)
  if (!value) fail(`${name} is required`)
  return value
}

function option(name: string): string {
  const index = process.argv.indexOf(name)
  return index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
}

function emit(value: any, file: string): never {
  console.log(JSON.stringify({ ...value, receipt_path: path.relative(root, file).split(path.sep).join('/') }, null, 2))
  process.exit(value.ok === true ? 0 : 1)
}

function fail(message: string, detail = ''): never {
  console.error(`Release pack receipt failed: ${message}`)
  if (detail) console.error(String(detail).trim())
  process.exit(2)
}
