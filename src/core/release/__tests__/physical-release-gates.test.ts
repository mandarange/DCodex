import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectPhysicalReleaseGates, validatePhysicalReleaseGateInspection } from '../physical-release-gates.js'
import { writePhysicalReleaseEvidence } from './physical-release-evidence-fixture.js'

const VERSION = String(JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version || '')
const SHA = 'a'.repeat(40)

test('physical release gates bind five real receipts and the complete Desktop Bridge evidence contract', () => {
  const { root, attestation } = fixture()
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, true, report.blockers.join(', '))
  assert.deepEqual(report.verified_gate_ids, [
    'update_5001_directory',
    'single_menubar_process',
    'codex_lb_measured_request',
    'telegram_cellular_e2e',
    'desktop_bridge_live_evidence'
  ])
  assert.deepEqual(report.desktop_bridge_evidence?.providers, ['codex-lb', 'openrouter'])
  assert.equal(report.desktop_bridge_evidence?.deep_artifact_count, 14)
  assert.equal(report.artifact_attestation?.capture_adapter_id, 'desktop-bridge-production-adapter')
  assert.equal(report.artifact_attestation?.capture_adapter_version, '1.0.0')
  assert.equal(report.artifact_attestation?.capture_adapter_receipt_id, 'desktop-bridge-adapter-receipt-001')
  assert.match(report.artifact_attestation?.capture_adapter_executable_sha256 || '', /^[a-f0-9]{64}$/)
  const sealed = validatePhysicalReleaseGateInspection({ root, version: VERSION, sourceCommit: SHA })
  assert.equal(sealed.ok, true, sealed.blockers.join(', '))
})

test('physical release gates reject missing, stale, synthetic, and hash-mismatched evidence', () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-missing-'))
  const missing = inspectPhysicalReleaseGates({ root: missingRoot, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin' })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes('physical_receipt_missing_or_invalid'))

  const { root, attestation } = fixture()
  const receiptPath = path.join(root, 'release-evidence', VERSION, 'physical-gates.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.source_commit = 'b'.repeat(40)
  receipt.gates[0].fixture = true
  receipt.gates[1].artifact_sha256 = '0'.repeat(64)
  fs.writeFileSync(path.join(root, 'release-evidence', VERSION, receipt.gates[2].artifact_path), '')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const blocked = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes('physical_receipt_source_commit_mismatch'))
  assert.ok(blocked.blockers.includes('physical_receipt_gate_synthetic:update_5001_directory'))
  assert.ok(blocked.blockers.includes('physical_receipt_artifact_hash_mismatch:single_menubar_process'))
  assert.ok(blocked.blockers.includes('physical_receipt_artifact_size_invalid:codex_lb_measured_request'))
})

test('Linux cannot create a release-authorizing physical inspection and synthetic deep evidence is rejected', () => {
  const { root, attestation } = fixture()
  const linux = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'linux', ...attestation })
  assert.equal(linux.ok, false)
  assert.ok(linux.blockers.includes('physical_receipt_requires_macos_inspector:linux'))

  const reportPath = path.join(root, 'release-evidence', VERSION, 'desktop-bridge', 'release-evidence.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  report.deep_artifacts[0].synthetic = true
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  const receiptPath = path.join(root, 'release-evidence', VERSION, 'physical-gates.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.gates.find((gate: any) => gate.id === 'desktop_bridge_live_evidence').artifact_sha256 = sha256(fs.readFileSync(reportPath))
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const synthetic = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(synthetic.ok, false)
  assert.ok(synthetic.blockers.some((blocker) => blocker.includes('deep_artifact_invalid:codex-lb:fast_mode')))
})

test('physical evidence source commit must equal release HEAD even for an evidence-only descendant commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-git-'))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'SKS Test'])
  git(root, ['config', 'user.email', 'sks-test@example.invalid'])
  fs.writeFileSync(path.join(root, 'product.txt'), 'release source\n')
  git(root, ['add', 'product.txt'])
  git(root, ['commit', '-m', 'release source'])
  const releaseSource = git(root, ['rev-parse', 'HEAD']).trim()
  const attestation = writeEvidence(root, releaseSource)
  git(root, ['add', 'release-evidence'])
  git(root, ['commit', '-m', 'bind physical evidence'])
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, false)
  assert.ok(report.blockers.includes('physical_receipt_source_commit_mismatch'))
  assert.equal(report.release_source_commit, releaseSource)
  assert.notEqual(report.head_commit, releaseSource)
})

test('self-declared fixture evidence cannot authorize without a GitHub-attested archive', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-'))
  writePhysicalReleaseEvidence(root, VERSION, SHA, { attested: false })
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin' })
  assert.equal(report.ok, false)
  assert.equal(report.release_authorizing, false)
  assert.equal(report.artifact_attestation, null)
  assert.ok(report.blockers.includes('physical_evidence_attestation_missing'))
})

test('a saved authorizing inspection cannot bypass a failed GitHub attestation verification', () => {
  const { root, attestation } = fixture()
  const failedBin = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-gh-fail-'))
  const failedGh = path.join(failedBin, 'gh')
  fs.writeFileSync(failedGh, '#!/bin/sh\nexit 1\n')
  fs.chmodSync(failedGh, 0o755)
  const priorPath = process.env.PATH
  process.env.PATH = `${failedBin}${path.delimiter}${priorPath || ''}`
  try {
    const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
    assert.equal(report.ok, false)
    assert.equal(report.artifact_attestation, null)
    assert.ok(report.blockers.includes('physical_evidence_attestation_verification_failed'))
    const sealed = validatePhysicalReleaseGateInspection({ root, version: VERSION, sourceCommit: SHA })
    assert.equal(sealed.ok, false)
    assert.ok(sealed.blockers.includes('physical_inspection_artifact_attestation_mismatch'))
  } finally {
    process.env.PATH = priorPath
  }
})

test('native screenshot evidence rejects a PNG with a corrupted chunk CRC', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-png-'))
  const attestation = writePhysicalReleaseEvidence(root, VERSION, SHA, { corruptPngCrc: true })
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, false)
  assert.ok(report.blockers.includes('physical_receipt_desktop_bridge:desktop_bridge_release_native_screenshot_invalid'))
})

test('attested physical evidence still rejects secret-bearing artifact bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-secret-'))
  const attestation = writePhysicalReleaseEvidence(root, VERSION, SHA, { secretArtifact: true })
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, false)
  assert.ok(report.blockers.some((blocker) => blocker.startsWith('physical_evidence_artifact_secret_material:')))
  assert.ok(report.blockers.includes('physical_receipt_artifact_secret_material:update_5001_directory'))
})

test('attested evidence rejects a manifest bound to the wrong capture adapter identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-wrong-adapter-'))
  const attestation = writePhysicalReleaseEvidence(root, VERSION, SHA, { wrongAdapterManifest: true })
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, false)
  assert.ok(report.blockers.includes('physical_receipt_capture_adapter_binding_mismatch'))
})

test('generic gates require explicit false reality flags and receipt-bound observation artifacts', () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-missing-flags-'))
  const missingAttestation = writePhysicalReleaseEvidence(missingRoot, VERSION, SHA, { missingGateFlags: true })
  const missing = inspectPhysicalReleaseGates({ root: missingRoot, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...missingAttestation })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes('physical_receipt_gate_synthetic:update_5001_directory'))

  const { root, attestation } = fixture()
  const receiptPath = path.join(root, 'release-evidence', VERSION, 'physical-gates.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.gates[0].observations.directories_encountered = 9999
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const selfDeclared = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(selfDeclared.ok, false)
  assert.ok(selfDeclared.blockers.includes('physical_receipt_gate_producer_output_invalid:update_5001_directory'))
})

test('an attested coherent declaration and matching observation hash is not independent producer evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-coherent-declaration-'))
  const attestation = writePhysicalReleaseEvidence(root, VERSION, SHA, { coherentSelfDeclaration: true })
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA, inspectorPlatform: 'darwin', ...attestation })
  assert.equal(report.ok, false)
  for (const id of ['update_5001_directory', 'single_menubar_process', 'codex_lb_measured_request', 'telegram_cellular_e2e']) {
    assert.ok(report.blockers.includes(`physical_receipt_gate_artifact_contract_invalid:${id}`))
  }
})

function fixture(): { root: string; attestation: ReturnType<typeof writePhysicalReleaseEvidence> } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-'))
  const attestation = writeEvidence(root, SHA)
  return { root, attestation }
}

function writeEvidence(root: string, sourceCommit: string): ReturnType<typeof writePhysicalReleaseEvidence> {
  return writePhysicalReleaseEvidence(root, VERSION, sourceCommit)
}

function sha256(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return String(result.stdout || '')
}
