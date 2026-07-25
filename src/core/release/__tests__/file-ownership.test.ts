import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { inspectReleaseFileOwnership, type ReleaseFileOwnershipManifest } from '../file-ownership.js'

test('release ownership check accepts an isolated worker and rejects shared-file edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-file-ownership-'))
  try {
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Release Fixture'])
    fs.mkdirSync(path.join(root, 'src/core/telegram'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
    fs.writeFileSync(path.join(root, 'src/core/telegram/index.ts'), 'export {}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const base = gitText(root, ['rev-parse', 'HEAD'])

    fs.writeFileSync(path.join(root, 'src/core/telegram/index.ts'), 'export const ready = true\n')
    fs.mkdirSync(path.join(root, '.sneakoscope/release/7.1.3/shared-file-requests'), { recursive: true })
    fs.writeFileSync(path.join(root, '.sneakoscope/release/7.1.3/shared-file-requests/W05.json'), '{}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'worker'])
    const worker = gitText(root, ['rev-parse', 'HEAD'])
    const manifest = fixtureManifest(base)
    const accepted = inspectReleaseFileOwnership({ root, manifest, base, head: worker.slice(0, 8) })
    assert.equal(accepted.ok, true, accepted.blockers.join(','))
    assert.equal(accepted.workstream, 'W05')
    assert.equal(accepted.release, '7.1.3')
    assert.equal(accepted.head, worker)

    // The request exemption is scoped to the release being cut: the same diff read against a
    // different release line must not silently grant the shared-file-request carve-out.
    const otherRelease = inspectReleaseFileOwnership({ root, manifest, base, head: worker, release: '7.2.0' })
    assert.equal(otherRelease.ok, false)
    assert.equal(otherRelease.release, '7.2.0')
    assert.equal(
      otherRelease.blockers.includes('out_of_scope_change:.sneakoscope/release/7.1.3/shared-file-requests/W05.json'),
      true,
      otherRelease.blockers.join(',')
    )

    fs.writeFileSync(path.join(root, 'package.json'), '{"version":"7.1.3"}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'shared edit'])
    const invalid = inspectReleaseFileOwnership({ root, manifest, base, head: gitText(root, ['rev-parse', 'HEAD']), workstream: 'W05' })
    assert.equal(invalid.ok, false)
    assert.equal(invalid.blockers.includes('shared_file_changed:package.json'), true)
    assert.equal(invalid.blockers.includes('out_of_scope_change:package.json'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release ownership check fails closed when ownership patterns overlap', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-file-overlap-'))
  try {
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Release Fixture'])
    fs.mkdirSync(path.join(root, 'src/core/shared'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/core/shared/index.ts'), 'export {}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const base = gitText(root, ['rev-parse', 'HEAD'])
    fs.writeFileSync(path.join(root, 'src/core/shared/index.ts'), 'export const changed = true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'overlap'])
    const manifest: ReleaseFileOwnershipManifest = {
      schema: 'sks.release-file-ownership.v1',
      baseline: base,
      workstreams: { W01: ['src/core/shared/**'], W02: ['src/core/shared/**'] },
      shared_files: [],
      overlap_policy: 'fail_closed'
    }
    const report = inspectReleaseFileOwnership({ root, manifest, base, head: 'HEAD', workstream: 'W01' })
    assert.equal(report.ok, false)
    assert.equal(report.blockers.some((value) => value.startsWith('ambiguous_file_owner:src/core/shared/index.ts:')), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release ownership check includes both sides of a rename so shared files cannot be hidden', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-file-rename-'))
  try {
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Release Fixture'])
    fs.mkdirSync(path.join(root, 'src/core/telegram'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const base = gitText(root, ['rev-parse', 'HEAD'])
    git(root, ['mv', 'package.json', 'src/core/telegram/package.json'])
    git(root, ['commit', '-m', 'hide shared file'])
    const manifest: ReleaseFileOwnershipManifest = {
      schema: 'sks.release-file-ownership.v1', baseline: base,
      workstreams: { W05: ['src/core/telegram/**'] }, shared_files: ['package.json'], overlap_policy: 'fail_closed'
    }
    const report = inspectReleaseFileOwnership({ root, manifest, base, head: 'HEAD', workstream: 'W05' })
    assert.equal(report.ok, false)
    assert.equal(report.changed_files.includes('package.json'), true)
    assert.equal(report.changed_files.includes('src/core/telegram/package.json'), true)
    assert.equal(report.blockers.includes('shared_file_changed:package.json'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('release ownership check fails closed when no release line is resolvable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-file-no-release-'))
  try {
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Release Fixture'])
    fs.mkdirSync(path.join(root, 'src/core/telegram'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src/core/telegram/index.ts'), 'export {}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const base = gitText(root, ['rev-parse', 'HEAD'])
    fs.mkdirSync(path.join(root, '.sneakoscope/release/7.1.3/shared-file-requests'), { recursive: true })
    fs.writeFileSync(path.join(root, '.sneakoscope/release/7.1.3/shared-file-requests/W05.json'), '{}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'request only'])
    const manifest: ReleaseFileOwnershipManifest = {
      schema: 'sks.release-file-ownership.v1',
      baseline: base,
      workstreams: { W05: ['src/core/telegram/**'] },
      shared_files: ['package.json'],
      overlap_policy: 'fail_closed'
    }
    const report = inspectReleaseFileOwnership({ root, manifest, base, head: 'HEAD', workstream: 'W05' })
    assert.equal(report.ok, false)
    assert.equal(report.release, null)
    assert.equal(report.blockers.includes('release_unresolved'), true, report.blockers.join(','))
    assert.equal(
      report.blockers.includes('out_of_scope_change:.sneakoscope/release/7.1.3/shared-file-requests/W05.json'),
      true,
      report.blockers.join(',')
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixtureManifest(base: string): ReleaseFileOwnershipManifest {
  return {
    schema: 'sks.release-file-ownership.v1',
    baseline: base,
    release: '7.1.3',
    workstreams: {
      W05: ['src/core/telegram/**'],
      W06: ['src/core/remote/**']
    },
    shared_files: ['package.json'],
    overlap_policy: 'fail_closed'
  }
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function gitText(root: string, args: string[]): string {
  return String(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout || '').trim()
}
