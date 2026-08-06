import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { inspectMainPushGuard } from '../main-push-guard.js'
import { inspectMainPushReceipt } from '../main-push-receipt.js'
import { normalizeReleaseOrigin } from '../release-origin.js'
import { releaseProofDir } from '../release-pack-receipt.js'
import { writeCompleteReleaseProofs } from './release-proof-fixture.js'

test('main push receipt independently revalidates remote main and the exact pre-push guard', () => {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-main-push-receipt-'))
  const root = path.join(container, 'work')
  const remote = path.join(container, 'origin.git')
  try {
    fs.mkdirSync(root, { recursive: true })
    git(container, ['init', '--bare', remote])
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '8.0.0' }))
    fs.writeFileSync(path.join(root, '.gitignore'), '.sneakoscope/reports/\ndist/\nrelease-evidence/\n')
    git(root, ['init', '-b', 'main'])
    git(root, ['config', 'user.email', 'fixture@example.test'])
    git(root, ['config', 'user.name', 'Release Fixture'])
    git(root, ['remote', 'add', 'origin', remote])
    git(root, ['add', '.'])
    git(root, ['commit', '-m', 'baseline'])
    const baseline = gitText(root, ['rev-parse', 'HEAD'])
    git(root, ['push', '-u', 'origin', 'main'])

    fs.writeFileSync(path.join(root, 'release.txt'), 'release\n')
    git(root, ['add', 'release.txt'])
    git(root, ['commit', '-m', 'release source'])
    const head = gitText(root, ['rev-parse', 'HEAD'])
    const expectedOriginIdentity = normalizeReleaseOrigin(remote)
    writeCompleteReleaseProofs(root, head, baseline, expectedOriginIdentity)
    const guard = inspectMainPushGuard({
      root,
      expectedVersion: '8.0.0',
      expectedOriginMain: baseline,
      expectedOriginIdentity,
      requireReleaseStamp: true,
      requirePackProof: true,
      requireMacosProof: true,
      requirePhysicalProof: true,
      requireCleanTree: true
    })
    assert.equal(guard.ok, true, guard.blockers.join(','))
    const guardFile = path.join(releaseProofDir(root, '8.0.0'), 'main-push-guard.json')
    writeJson(guardFile, guard)
    git(root, ['push', 'origin', 'HEAD:refs/heads/main'])

    const inspect = () => inspectMainPushReceipt({
      root,
      version: '8.0.0',
      baseline,
      method: 'fast-forward',
      expectedOriginIdentity
    })
    const passing = inspect()
    assert.equal(passing.ok, true, passing.blockers.join(','))
    assert.equal(passing.main_sha, head)
    assert.equal(passing.remote_main_sha, head)

    const originalGuard = JSON.parse(fs.readFileSync(guardFile, 'utf8'))
    const driftedGuard = structuredClone(originalGuard)
    driftedGuard.head = '0'.repeat(40)
    writeJson(guardFile, driftedGuard)
    const mismatchedGuard = inspect()
    assert.equal(mismatchedGuard.ok, false)
    assert.equal(mismatchedGuard.blockers.includes('pre_push_guard_head_mismatch'), true)
    writeJson(guardFile, originalGuard)

    const upgradeFile = path.join(releaseProofDir(root, '8.0.0'), 'upgrade-7.6-to-8.0.0.json')
    const originalUpgrade = JSON.parse(fs.readFileSync(upgradeFile, 'utf8'))
    const driftedUpgrade = structuredClone(originalUpgrade)
    driftedUpgrade.target.receipt_source_commit = '0'.repeat(40)
    writeJson(upgradeFile, driftedUpgrade)
    const mismatchedUpgrade = inspect()
    assert.equal(mismatchedUpgrade.ok, false)
    assert.equal(mismatchedUpgrade.blockers.includes('upgrade_proof:target_source_commit_mismatch'), true)
    assert.equal(mismatchedUpgrade.blockers.includes('pre_push_guard_upgrade_proof_mismatch'), true)
    writeJson(upgradeFile, originalUpgrade)

    fs.writeFileSync(path.join(root, 'unpushed.txt'), 'not on remote\n')
    git(root, ['add', 'unpushed.txt'])
    git(root, ['commit', '-m', 'unpushed source'])
    const blocked = inspect()
    assert.equal(blocked.ok, false)
    assert.equal(blocked.blockers.includes('remote_main_does_not_match_head'), true)
    assert.equal(blocked.blockers.includes('pre_push_guard_head_mismatch'), true)
  } finally {
    fs.rmSync(container, { recursive: true, force: true })
  }
})

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

function gitText(root: string, args: string[]): string {
  return String(spawnSync('git', args, { cwd: root, encoding: 'utf8' }).stdout || '').trim()
}
