import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { inspectPhysicalReleaseGates, PHYSICAL_RELEASE_GATES_SCHEMA } from '../physical-release-gates.js'

const VERSION = '8.0.5'
const SHA = 'a'.repeat(40)

test('physical release gates bind all four real receipts to version, commit, and artifact bytes', () => {
  const root = fixture()
  const report = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA })
  assert.equal(report.ok, true, report.blockers.join(', '))
  assert.deepEqual(report.verified_gate_ids, [
    'update_5001_directory',
    'single_menubar_process',
    'codex_lb_measured_request',
    'telegram_cellular_e2e'
  ])
})

test('physical release gates reject missing, stale, synthetic, and hash-mismatched evidence', () => {
  const missingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-missing-'))
  const missing = inspectPhysicalReleaseGates({ root: missingRoot, version: VERSION, sourceCommit: SHA })
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes('physical_receipt_missing_or_invalid'))

  const root = fixture()
  const receiptPath = path.join(root, 'release-evidence', VERSION, 'physical-gates.json')
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.source_commit = 'b'.repeat(40)
  receipt.gates[0].fixture = true
  receipt.gates[1].artifact_sha256 = '0'.repeat(64)
  fs.writeFileSync(path.join(root, 'release-evidence', VERSION, receipt.gates[2].artifact_path), '')
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
  const blocked = inspectPhysicalReleaseGates({ root, version: VERSION, sourceCommit: SHA })
  assert.equal(blocked.ok, false)
  assert.ok(blocked.blockers.includes('physical_receipt_source_commit_mismatch'))
  assert.ok(blocked.blockers.includes('physical_receipt_gate_synthetic:update_5001_directory'))
  assert.ok(blocked.blockers.includes('physical_receipt_artifact_hash_mismatch:single_menubar_process'))
  assert.ok(blocked.blockers.includes('physical_receipt_artifact_size_invalid:codex_lb_measured_request'))
})

test('a tracked evidence-only commit may bind the immediately preceding release source commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-git-'))
  git(root, ['init'])
  git(root, ['config', 'user.name', 'SKS Test'])
  git(root, ['config', 'user.email', 'sks-test@example.invalid'])
  fs.writeFileSync(path.join(root, 'product.txt'), 'release source\n')
  git(root, ['add', 'product.txt'])
  git(root, ['commit', '-m', 'release source'])
  const releaseSource = git(root, ['rev-parse', 'HEAD']).trim()
  writeEvidence(root, releaseSource)
  git(root, ['add', 'release-evidence'])
  git(root, ['commit', '-m', 'bind physical evidence'])
  const report = inspectPhysicalReleaseGates({ root, version: VERSION })
  assert.equal(report.ok, true, report.blockers.join(', '))
  assert.equal(report.release_source_commit, releaseSource)
  assert.notEqual(report.head_commit, releaseSource)
})

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-physical-release-'))
  writeEvidence(root, SHA)
  return root
}

function writeEvidence(root: string, sourceCommit: string): void {
  const evidenceRoot = path.join(root, 'release-evidence', VERSION)
  fs.mkdirSync(evidenceRoot, { recursive: true })
  const performedAt = new Date().toISOString()
  const gates = [
    gate('update_5001_directory', 'update.json', {
      directories_encountered: 5001,
      update_status: 'succeeded',
      warning_code: 'guidance_scan_truncated',
      false_residue_blockers: 0
    }),
    gate('single_menubar_process', 'menubar.json', {
      process_count: 1,
      running_version: VERSION,
      prior_version: '8.0.3',
      process_readback: true
    }),
    gate('codex_lb_measured_request', 'codex-lb.json', {
      selected: true,
      measured: true,
      target_matches_configured: true,
      auth_class: 'gateway-key',
      oauth_fallback: false,
      latency_ms: 42
    }),
    gate('telegram_cellular_e2e', 'telegram.json', {
      network: 'cellular',
      paired: true,
      allowlisted: true,
      typed_command: true,
      reply_received: true,
      bot_token_recorded: false
    })
  ]
  for (const entry of gates) {
    const bytes = Buffer.from(`${entry.id}\n`)
    fs.writeFileSync(path.join(evidenceRoot, entry.artifact_path), bytes)
    entry.artifact_sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    entry.performed_at = performedAt
  }
  fs.writeFileSync(path.join(evidenceRoot, 'physical-gates.json'), `${JSON.stringify({
    schema: PHYSICAL_RELEASE_GATES_SCHEMA,
    ok: true,
    package_version: VERSION,
    source_commit: sourceCommit,
    gates
  }, null, 2)}\n`)
}

function gate(id: string, artifactPath: string, observations: Record<string, unknown>): any {
  return {
    id,
    ok: true,
    evidence_kind: 'real',
    fixture: false,
    mock: false,
    synthetic: false,
    redacted: true,
    secrets_present: false,
    reviewer: 'release-maintainer',
    summary: `${id} verified on the required physical environment`,
    artifact_path: artifactPath,
    artifact_sha256: '',
    observations
  }
}

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return String(result.stdout || '')
}
