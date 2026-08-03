import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { compareReleasePacks, inspectReleaseTarball } from '../release-pack-receipt.js'

test('release pack receipts bind exact local and staged tarball bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-receipt-'))
  try {
    const first = createTarball(root, 'first', '8.0.0')
    const second = createTarball(root, 'second', '8.0.1')
    const local = inspectReleaseTarball({
      tarball: first,
      kind: 'local',
      sourceCommit: 'a'.repeat(40),
      root,
      npmPackProof: { proof_id: 'a'.repeat(64), info_sha256: 'b'.repeat(64), file_list_sha256: 'c'.repeat(64) }
    })
    const staged = inspectReleaseTarball({ tarball: first, kind: 'staged', root })
    const different = inspectReleaseTarball({ tarball: second, kind: 'staged', root })
    assert.equal(local.ok, true, local.blockers.join(','))
    assert.equal(local.package_name, 'sneakoscope')
    assert.equal(local.package_version, '8.0.0')
    assert.match(local.sha256, /^[a-f0-9]{64}$/)
    assert.match(local.sha512_integrity, /^sha512-/)
    assert.equal(local.secret_scan.ok, true)
    assert.equal(local.secret_scan.findings.length, 0)
    assert.equal(local.retired_surface_scan.ok, true)
    assert.equal(local.retired_surface_scan.findings.length, 0)
    assert.equal(compareReleasePacks(local, staged).ok, true)
    const mismatch = compareReleasePacks(local, different)
    assert.equal(mismatch.ok, false)
    assert.equal(mismatch.blockers.includes('package_version_mismatch'), true)
    assert.equal(mismatch.blockers.includes('tarball_sha256_mismatch'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection fails closed on retired runtime identity outside the migration allowlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-surface-'))
  const leakedIdentity = 'team_trigger_matrix'
  try {
    const tarball = createTarball(root, 'retired-surface', '8.0.0', '', {
      'dist/core/runtime/leak.js': `export const leaked = ${JSON.stringify(leakedIdentity)};\n`
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.ok, false)
    assert.equal(receipt.retired_surface_scan.findings.some((finding) => finding.kind === 'retired_team_runtime_identity'), true)
    assert.equal(JSON.stringify(receipt).includes(leakedIdentity), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects Team workdirs, current wording, and mixed-case commands outside migration modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-team-current-surface-'))
  try {
    const tarball = createTarball(root, 'team-current-surface', '8.0.0', '', {
      'dist/core/runtime/leak.js': [
        'export const workdir = "team-inbox";',
        'export const wording = "Team architecture";',
        'export const command = "SKS TEAM --json";'
      ].join('\n')
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    const kinds = new Set(receipt.retired_surface_scan.findings.map((finding) => finding.kind))
    assert.equal(receipt.ok, false)
    assert.equal(kinds.has('retired_team_workdir'), true)
    assert.equal(kinds.has('retired_team_current_wording'), true)
    assert.equal(kinds.has('retired_cli_command'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection allows retired tokens only in explicit cleanup and migration modules', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-allowlist-'))
  try {
    const tarball = createTarball(root, 'retired-allowlist', '8.0.0', '', {
      'dist/core/doctor/retired-managed-residue-private.js': 'const tombstone = "sks team --json";\n',
      'dist/core/doctor/retired-managed-projection-residue.js': 'const oldMode = "strict-team";\n',
      'dist/core/doctor/retired-managed-residue-missions.js': 'const oldRoute = "$Team"; const oldGoalField = "ralph_removed";\n',
      'dist/core/init/skills.js': 'const retiredSkill = "ralph-supervisor";\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, true, receipt.blockers.join(','))
    assert.equal(receipt.retired_surface_scan.ok, true)
    assert.equal(receipt.retired_surface_scan.allowlisted_finding_count, 5)
    assert.equal(receipt.retired_surface_scan.findings.length, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection does not exempt retired commands in the global mode router', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-global-router-'))
  try {
    const tarball = createTarball(root, 'global-router-leak', '8.0.0', '', {
      'dist/cli/global-mode-router.js': 'export const leaked = "sks team --json";\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.findings.some((finding) => finding.kind === 'retired_cli_command'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects retired Ralph identity in generated customer artifacts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-ralph-'))
  try {
    const tarball = createTarball(root, 'retired-ralph', '8.0.0', '', {
      'dist/core/init.js': 'export const guidance = "Ralph route is removed";\n',
      'dist/core/goal-workflow.js': 'export const contract = { ralph_removed: true };\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.findings.filter((finding) => finding.kind === 'retired_ralph_identity').length, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects removed dashboard prose and command surfaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-dashboard-surface-'))
  try {
    const retiredToken = ['zel', 'lij'].join('')
    const tarball = createTarball(root, 'dashboard-surface', '8.0.0', '', {
      'dist/cli/command-manifest-lite.js': 'export const summary = "Open Dashboard with sks ui";\n',
      'dist/core/runtime/leak.js': `export const option = "--${retiredToken}-dashboard"; export const artifact = "agent-codex-dashboard.json";\n`
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    const kinds = new Set(receipt.retired_surface_scan.findings.map((finding) => finding.kind))
    assert.equal(receipt.ok, false)
    assert.equal(kinds.has('retired_ui_command'), true)
    assert.equal(kinds.has('retired_terminal_multiplexer'), true)
    assert.equal(kinds.has('retired_dashboard_surface'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects removed dashboard files even when their contents are empty', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-dashboard-file-'))
  try {
    const retiredToken = ['zel', 'lij'].join('')
    const tarball = createTarball(root, 'dashboard-file', '8.0.0', '', {
      'dist/core/commands/ui-command.js': '',
      'dist/core/ui/dashboard-html.js': '',
      [`dist/core/${retiredToken}/${retiredToken}-dashboard-pane.js`]: ''
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.blockers.filter((blocker) => blocker.startsWith('retired_package_file_present:')).length, 3)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection does not allow Team injection into current generated guidance', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-current-guidance-team-'))
  try {
    const tarball = createTarball(root, 'current-guidance-team', '8.0.0', '', {
      'dist/core/init/skills.js': 'export const currentSkill = "$Team";\n',
      'dist/core/doctor/current-project-guidance.js': 'export const currentGuidance = "Team architecture";\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    const kinds = new Set(receipt.retired_surface_scan.findings.map((finding) => finding.kind))
    assert.equal(receipt.ok, false)
    assert.equal(kinds.has('retired_dollar_command'), true)
    assert.equal(kinds.has('retired_team_current_wording'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection still rejects an actual lowercase retired CLI command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-command-'))
  try {
    const tarball = createTarball(root, 'retired-command', '8.0.0', '', {
      'dist/core/runtime/leak.js': 'export const command = "sks agent run";\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.findings.some((finding) => finding.kind === 'retired_cli_command'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects retired Naruto options and workers command outside the proof allowlist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-naruto-surface-'))
  const leaked = ['--naruto', '--clones', 'naruto workers']
  try {
    const tarball = createTarball(root, 'retired-naruto-surface', '8.0.0', '', {
      'dist/core/runtime/leak.js': `export const leaked = ${JSON.stringify(leaked)};\n`
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    const kinds = new Set(receipt.retired_surface_scan.findings.map((finding) => finding.kind))
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.ok, false)
    assert.equal(kinds.has('retired_naruto_option'), true)
    assert.equal(kinds.has('retired_clones_option'), true)
    assert.equal(kinds.has('retired_naruto_workers_command'), true)
    for (const value of leaked) assert.equal(JSON.stringify(receipt).includes(value), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection rejects every packaged menu bar MCP identity spelling', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-retired-mcp-identity-'))
  try {
    const tarball = createTarball(root, 'retired-mcp-identity', '8.0.0', '', {
      'dist/core/runtime/leak.js': [
        'export const dash = "sks.menubar-mcp-list.v1";',
        'export const underscore = "sks.menubar_mcp_mutation.v1";',
        'export const dotted = "sks.menubar.mcp.view.v1";',
        'export const spaced = "menu bar label: menubar mcp";'
      ].join('\n')
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.retired_surface_scan.ok, false)
    assert.equal(receipt.retired_surface_scan.findings.filter((finding) => finding.kind === 'retired_menubar_mcp_identity').length, 4)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack inspection fails closed on secret-like content without echoing the secret', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-secret-'))
  const secret = `ghp_${'a'.repeat(40)}`
  try {
    const tarball = createTarball(root, 'secret', '8.0.0', secret)
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.secret_scan.ok, false)
    assert.equal(receipt.secret_scan.findings.some((finding) => finding.kind === 'github_token'), true)
    assert.equal(JSON.stringify(receipt).includes(secret), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack comparison rejects matching but malformed receipts', () => {
  const malformed = {
    schema: 'sks.release-pack-receipt.v1',
    ok: true,
    kind: 'local',
    package_name: 'sneakoscope',
    package_version: '8.0.0',
    source_commit: null,
    tarball_name: '',
    tarball_path: '',
    bytes: 0,
    unpacked_bytes: 0,
    sha256: '',
    sha512_integrity: '',
    file_count: 0,
    file_list_sha256: '',
    budget: { ok: false, max_packed_bytes: 0, max_unpacked_bytes: 0, max_file_count: 0, blockers: ['failed'] },
    npm_pack_proof: null,
    generated_at: '',
    blockers: []
  } as any
  const result = compareReleasePacks(malformed, { ...malformed, kind: 'staged' })
  assert.equal(result.ok, false)
  assert.equal(result.blockers.includes('local_receipt_invalid'), true)
  assert.equal(result.blockers.includes('staged_receipt_invalid'), true)
})

test('release pack comparison recomputes frozen package budgets instead of trusting receipt claims', () => {
  const forged = {
    schema: 'sks.release-pack-receipt.v1', ok: true, kind: 'local', package_name: 'sneakoscope', package_version: '8.0.0',
    source_commit: 'a'.repeat(40), tarball_name: 'sneakoscope-8.0.0.tgz', tarball_path: '.sneakoscope/reports/release/8.0.0/artifacts/sneakoscope-8.0.0.tgz', bytes: 999_999_999, unpacked_bytes: 999_999_999,
    sha256: 'a'.repeat(64), sha512_integrity: 'sha512-YQ==', file_count: 1, file_list_sha256: 'b'.repeat(64),
    budget: { ok: true, max_packed_bytes: 999_999_999, max_unpacked_bytes: 999_999_999, max_file_count: 999_999, blockers: [] },
    npm_pack_proof: { proof_id: 'c'.repeat(64), info_sha256: 'd'.repeat(64), file_list_sha256: 'e'.repeat(64) },
    generated_at: new Date().toISOString(), blockers: []
  } as any
  const result = compareReleasePacks(forged, { ...forged, kind: 'staged', source_commit: null, npm_pack_proof: null })
  assert.equal(result.ok, false)
  assert.equal(result.blockers.includes('local_receipt:package_budget_invalid_or_failed'), true)
  assert.equal(result.blockers.includes('staged_receipt:package_budget_invalid_or_failed'), true)
})

function createTarball(
  root: string,
  name: string,
  version: string,
  secret = '',
  extraFiles: Record<string, string> = {}
): string {
  const staging = path.join(root, name, 'package')
  fs.mkdirSync(path.join(staging, 'dist/bin'), { recursive: true })
  fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'sneakoscope', version }))
  fs.writeFileSync(path.join(staging, 'dist/bin/sks.js'), '#!/usr/bin/env node\n')
  if (secret) fs.writeFileSync(path.join(staging, 'dist/secret.txt'), secret)
  for (const [relative, text] of Object.entries(extraFiles)) {
    const file = path.join(staging, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, text)
  }
  const tarball = path.join(root, `${name}.tgz`)
  const result = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(staging), 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return tarball
}
