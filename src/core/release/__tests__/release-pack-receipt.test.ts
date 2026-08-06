import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { writeNpmPackProof } from '../npm-pack-proof.js'
import {
  RELEASE_PACK_RECEIPT_SCHEMA,
  compareReleasePacks,
  inspectLocalReleaseSourceState,
  inspectReleaseTarball,
  validateLocalReleasePackBinding,
  validateReleasePackReceipt
} from '../release-pack-receipt.js'

test('release pack receipts bind exact local and staged tarball bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-receipt-'))
  try {
    const fixture = createLocalBindingFixture(root)
    const first = fixture.tarball
    const second = createTarball(root, 'second', '8.0.1')
    const local = inspectReleaseTarball({
      tarball: first,
      kind: 'local',
      sourceCommit: fixture.head,
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
      'dist/core/init/skills.js': 'const retiredSkill = "ralph-supervisor";\n',
      'dist/core/init/skills/inventory.js': 'const removedSkills = ["ralph", "ralph-supervisor", "ralph-resolver"];\n'
    })
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, true, receipt.blockers.join(','))
    assert.equal(receipt.retired_surface_scan.ok, true)
    assert.equal(receipt.retired_surface_scan.allowlisted_finding_count, 8)
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

test('release pack inspection rejects current Supabase secret keys without echoing them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-supabase-secret-'))
  const secret = `sb_secret_${'a'.repeat(32)}`
  try {
    const tarball = createTarball(root, 'supabase-secret', '8.0.0', secret)
    const receipt = inspectReleaseTarball({ tarball, kind: 'staged', root })
    assert.equal(receipt.ok, false)
    assert.equal(receipt.secret_scan.ok, false)
    assert.equal(receipt.secret_scan.findings.some((finding) => finding.kind === 'supabase_secret_key'), true)
    assert.equal(JSON.stringify(receipt).includes(secret), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack comparison rejects matching but malformed receipts', () => {
  const malformed = {
    schema: RELEASE_PACK_RECEIPT_SCHEMA,
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
    schema: RELEASE_PACK_RECEIPT_SCHEMA, ok: true, kind: 'local', package_name: 'sneakoscope', package_version: '8.0.0',
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

test('local release pack source state independently rejects tracked modifications', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-dirty-worktree-'))
  try {
    const fixture = createLocalBindingFixture(root)
    fs.writeFileSync(path.join(root, 'index.js'), 'export const value = "dirty"\n')
    const sourceState = inspectLocalReleaseSourceState(root)
    const result = validateLocalReleasePackBinding(root, fixture.receipt)
    assert.equal(sourceState.ok, false)
    assert.ok(sourceState.blockers.includes('npm_pack_tracked_changes_present'))
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('npm_pack_tracked_changes_present'))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local release pack source state independently rejects pack-eligible untracked files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-untracked-source-'))
  try {
    const fixture = createLocalBindingFixture(root)
    const untracked = path.join(root, 'untracked.js')
    fs.writeFileSync(untracked, 'export const untracked = true\n')
    const sourceState = inspectLocalReleaseSourceState(root)
    const result = validateLocalReleasePackBinding(root, fixture.receipt)
    assert.equal(sourceState.ok, false)
    assert.deepEqual(sourceState.pack_eligible_untracked, ['untracked.js'])
    assert.ok(sourceState.blockers.includes('npm_pack_eligible_untracked_files_present'))
    assert.ok(result.blockers.includes('npm_pack_eligible_untracked_files_present'))
    assert.equal(fs.existsSync(untracked), true, 'validation must preserve the rejected user file')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local release pack binding rejects dirty packed bytes after the worktree is restored to HEAD without deleting evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-dirty-tarball-'))
  try {
    const fixture = createLocalBindingFixture(root)
    fs.writeFileSync(path.join(root, 'index.js'), 'export const value = "dirty packed bytes"\n')
    const dirtyOutput = path.join(root, 'dirty-output')
    const dirtyPack = npmPack(root, dirtyOutput)
    fs.copyFileSync(dirtyPack.tarball, fixture.tarball)
    const dirtyInspection = inspectReleaseTarball({ tarball: fixture.tarball, kind: 'local', sourceCommit: fixture.head, root })
    assert.ok(dirtyInspection.blockers.includes('packed_file_differs_from_source_commit:index.js'))
    fs.writeFileSync(path.join(root, 'index.js'), 'export const value = "clean"\n')
    const dirtyProof = writeGateArtifacts(root, dirtyPack.info)
    const forged = {
      ...dirtyInspection,
      ok: true,
      blockers: [],
      npm_pack_proof: {
        proof_id: dirtyProof.proof_id,
        info_sha256: dirtyProof.info_digest,
        file_list_sha256: dirtyProof.file_list_digest
      }
    }
    const before = fs.readFileSync(fixture.tarball)
    const result = validateLocalReleasePackBinding(root, forged)
    assert.equal(result.ok, false)
    assert.ok(result.blockers.includes('local_tarball_artifact:packed_file_differs_from_source_commit:index.js'))
    assert.deepEqual(fs.readFileSync(fixture.tarball), before, 'validation must not delete or rewrite rejected package bytes')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local release pack binding accepts a clean commit-bound package receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-clean-binding-'))
  try {
    const fixture = createLocalBindingFixture(root)
    const result = validateLocalReleasePackBinding(root, fixture.receipt)
    assert.equal(result.ok, true, result.blockers.join(','))
    assert.match(fixture.receipt.source_tree_sha256 || '', /^[a-f0-9]{64}$/)
    assert.match(fixture.receipt.source_package_sha256 || '', /^[a-f0-9]{64}$/)
    assert.match(fixture.receipt.source_package_binding_sha256 || '', /^[a-f0-9]{64}$/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('local release pack binding accepts ignored generated dist only when it matches the current clean build', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-pack-generated-dist-'))
  try {
    const fixture = createGeneratedDistBindingFixture(root)
    const sourceState = inspectLocalReleaseSourceState(root)
    assert.equal(sourceState.ok, true, sourceState.blockers.join(','))
    assert.deepEqual(sourceState.pack_eligible_untracked, [])
    assert.equal(validateLocalReleasePackBinding(root, fixture.receipt).ok, true)

    fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const generated = "tampered"\n')
    const mismatched = validateLocalReleasePackBinding(root, fixture.receipt)
    assert.equal(mismatched.ok, false)
    assert.ok(mismatched.blockers.includes(
      'local_tarball_artifact:packed_generated_dist_differs_from_current_build:dist/index.js'
    ))
    assert.equal(fs.existsSync(fixture.tarball), true, 'validation must preserve the rejected tarball')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release pack receipt v1 is rejected with a precise regeneration instruction', () => {
  const result = validateReleasePackReceipt({ schema: 'sks.release-pack-receipt.v1', ok: true })
  assert.ok(result.blockers.includes('receipt_schema_v1_outdated_regenerate_with_npm_run_release:pack-receipt'))
})

function createLocalBindingFixture(root: string) {
  git(root, ['init'])
  git(root, ['config', 'user.email', 'release-pack@example.invalid'])
  git(root, ['config', 'user.name', 'Release Pack Test'])
  fs.writeFileSync(path.join(root, '.gitignore'), '.sneakoscope/\ndirty-output/\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sneakoscope',
    version: '8.0.0',
    files: ['*.js']
  }))
  fs.writeFileSync(path.join(root, 'index.js'), 'export const value = "clean"\n')
  git(root, ['add', '.gitignore', 'package.json', 'index.js'])
  git(root, ['commit', '-m', 'fixture'])
  const head = git(root, ['rev-parse', 'HEAD'])
  const outputDir = path.join(root, '.sneakoscope', 'reports', 'release', '8.0.0', 'artifacts')
  const packed = npmPack(root, outputDir)
  const proof = writeGateArtifacts(root, packed.info)
  const receipt = inspectReleaseTarball({
    tarball: packed.tarball,
    kind: 'local',
    sourceCommit: head,
    root,
    npmPackProof: {
      proof_id: proof.proof_id,
      info_sha256: proof.info_digest,
      file_list_sha256: proof.file_list_digest
    }
  })
  assert.equal(receipt.ok, true, receipt.blockers.join(','))
  return { head, tarball: packed.tarball, info: packed.info, receipt }
}

function createGeneratedDistBindingFixture(root: string) {
  git(root, ['init'])
  git(root, ['config', 'user.email', 'release-pack@example.invalid'])
  git(root, ['config', 'user.name', 'Release Pack Test'])
  fs.writeFileSync(path.join(root, '.gitignore'), '.sneakoscope/\ndist/\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'sneakoscope',
    version: '8.0.0',
    files: ['dist/**']
  }))
  fs.mkdirSync(path.join(root, 'src'), { recursive: true })
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), 'export const source = true\n')
  git(root, ['add', '.gitignore', 'package.json', 'src/index.ts'])
  git(root, ['commit', '-m', 'fixture'])
  const head = git(root, ['rev-parse', 'HEAD'])
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true })
  fs.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const generated = true\n')
  const outputDir = path.join(root, '.sneakoscope', 'reports', 'release', '8.0.0', 'artifacts')
  const packed = npmPack(root, outputDir)
  const proof = writeGateArtifacts(root, packed.info)
  const receipt = inspectReleaseTarball({
    tarball: packed.tarball,
    kind: 'local',
    sourceCommit: head,
    root,
    npmPackProof: {
      proof_id: proof.proof_id,
      info_sha256: proof.info_digest,
      file_list_sha256: proof.file_list_digest
    }
  })
  assert.equal(receipt.ok, true, receipt.blockers.join(','))
  return { head, tarball: packed.tarball, info: packed.info, receipt }
}

function npmPack(root: string, outputDir: string): { tarball: string; info: Record<string, any> } {
  fs.mkdirSync(outputDir, { recursive: true })
  const result = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', outputDir], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const parsed = JSON.parse(String(result.stdout || '[]'))
  const info = (Array.isArray(parsed) ? parsed[0] : parsed) as Record<string, any>
  return { tarball: path.join(outputDir, String(info.filename || '')), info }
}

function writeGateArtifacts(root: string, info: Record<string, any>) {
  const proof = writeNpmPackProof(root, info, 1)
  const reports = path.join(root, '.sneakoscope', 'reports')
  fs.mkdirSync(reports, { recursive: true })
  fs.writeFileSync(path.join(reports, 'packlist-performance.json'), JSON.stringify({
    schema: 'sks.packlist-performance.v1',
    ok: true,
    blockers: [],
    forbidden: [],
    runtime_required_missing: [],
    pack_proof_id: proof.proof_id,
    pack_info_sha256: proof.info_digest,
    pack_file_list_sha256: proof.file_list_digest,
    entryCount: info.entryCount,
    size: info.size,
    unpackedSize: info.unpackedSize
  }))
  fs.writeFileSync(path.join(reports, 'package-surface-budget.json'), JSON.stringify({
    schema: 'sks.package-surface-budget.v1',
    ok: true,
    blockers: [],
    forbidden_findings: [],
    pack_proof_id: proof.proof_id,
    pack_info_sha256: proof.info_digest,
    pack_file_list_sha256: proof.file_list_digest,
    actual_file_count: info.entryCount,
    actual_tarball_bytes: info.size
  }))
  return proof
}

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

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return String(result.stdout || '').trim()
}
