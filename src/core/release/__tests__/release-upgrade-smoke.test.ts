import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  classifyPinnedReleaseUpgradeBaselineInspection,
  inspectReleaseSourceCleanliness,
  parseReleaseUpgradeSmokeArgs,
  runReleaseUpgradeSmoke
} from '../../../scripts/release-upgrade-smoke.js'
import { initGit, result } from './release-upgrade-smoke-fixtures.js'

test('release upgrade smoke argv requires exact tarball bindings', () => {
  const parsed = parseReleaseUpgradeSmokeArgs([
    '--target-tarball', 'target.tgz',
    '--target-receipt', 'pack-receipt.json',
    '--baseline-tarball', 'baseline.tgz',
    '--baseline-sha256', 'a'.repeat(64),
    '--keep-sandbox'
  ])
  assert.deepEqual(parsed.blockers, [])
  assert.equal(parsed.options.targetTarball, 'target.tgz')
  assert.equal(parsed.options.targetReceipt, 'pack-receipt.json')
  assert.equal(parsed.options.baselineSha256, 'a'.repeat(64))
  assert.equal(parsed.options.keepSandbox, true)

  const blocked = parseReleaseUpgradeSmokeArgs(['--target-tarball', 'target.tgz', '--baseline-tarball', 'baseline.tgz'])
  assert.ok(blocked.blockers.includes('target_receipt_required'))
  assert.ok(blocked.blockers.includes('provided_baseline_sha256_required'))
})

test('pinned 6.2 baseline records expected legacy content without masking structural failures', () => {
  const classified = classifyPinnedReleaseUpgradeBaselineInspection([
    'secret_content_detected:openai_token:dist/scripts/naruto-gpt-final-pack-check.js:4ac5c1dbbc7ee46b',
    'retired_surface_scan_finding_limit_reached',
    'retired_surface_content_detected:retired_dollar_command:README.md:c0388f4e7a979d2e',
    'retired_package_file_present:package/dist/core/commands/ui-command.js',
    'tarball_secret_scan_extract_failed'
  ])
  assert.deepEqual(classified.blockers, ['tarball_secret_scan_extract_failed'])
  assert.equal(classified.warnings.length, 4)
  assert.ok(classified.warnings.every((warning) => warning.startsWith('published_baseline_expected_content:')))
})

test('release upgrade smoke fails closed before commands when the target receipt is invalid', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-smoke-invalid-'))
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '6.3.0' }))
    await fs.writeFile(path.join(root, 'target.tgz'), 'not-a-tarball')
    await fs.writeFile(path.join(root, 'pack-receipt.json'), JSON.stringify({ schema: 'invalid', ok: true }))
    initGit(root)
    let invoked = false
    const report = await runReleaseUpgradeSmoke(root, {
      targetTarball: 'target.tgz',
      targetReceipt: 'pack-receipt.json'
    }, {
      platform: 'darwin',
      tmpRoot: path.join(root, 'tmp'),
      runner: async () => {
        invoked = true
        return result('')
      }
    })
    assert.equal(report.ok, false)
    assert.equal(invoked, false)
    assert.deepEqual(report.commands, [])
    assert.equal(report.isolation.sandbox, null)
    assert.equal(report.target.binding_ok, false)
    assert.ok(report.blockers.some((blocker) => blocker.startsWith('target_receipt:')))
    const receipt = path.join(root, '.sneakoscope', 'reports', 'release', '6.3.0', 'upgrade-6.2-to-6.3.0.json')
    assert.equal(JSON.parse(await fs.readFile(receipt, 'utf8')).schema, 'sks.release-upgrade-smoke.v2')

    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '6.2.0' }))
    const preCut = await runReleaseUpgradeSmoke(root, {
      targetTarball: 'target.tgz', targetReceipt: 'pack-receipt.json'
    }, { platform: 'darwin', tmpRoot: path.join(root, 'tmp'), runner: async () => result('') })
    assert.equal(preCut.ok, false)
    assert.ok(preCut.blockers.includes('target_version_not_cut_from_baseline'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('release upgrade smoke refuses a traversal package version before choosing a report path', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-smoke-traversal-'))
  const root = path.join(temp, 'repo')
  const malicious = '../../../../escaped-release-proof'
  const escaped = path.resolve(
    root, '.sneakoscope', 'reports', 'release', malicious,
    `upgrade-6.2-to-${malicious}.json`
  )
  try {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: malicious }))
    let invoked = false
    const report = await runReleaseUpgradeSmoke(root, {}, {
      tmpRoot: path.join(temp, 'tmp'),
      runner: async () => {
        invoked = true
        return result('')
      }
    })
    assert.equal(report.ok, false)
    assert.ok(report.blockers.includes('target_version_invalid'))
    assert.equal(invoked, false)
    await assert.rejects(fs.access(path.join(root, '.sneakoscope')))
    await assert.rejects(fs.access(escaped))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('source cleanliness rejects a dirty tracked release pack input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-dirty-tracked-'))
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '6.3.0' }))
    await fs.writeFile(path.join(root, 'target.tgz'), 'original-target')
    initGit(root)
    await fs.writeFile(path.join(root, 'target.tgz'), 'changed-target')

    const inspected = inspectReleaseSourceCleanliness(root)
    assert.equal(inspected.ok, false)
    assert.ok(inspected.blockers.includes('release_source_tree_dirty'))
    assert.ok(inspected.dirty_entries.some((entry) => entry.includes('target.tgz')))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('source cleanliness rejects a dirty untracked release pack input', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-dirty-untracked-'))
  try {
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '6.3.0' }))
    initGit(root)
    await fs.writeFile(path.join(root, 'pack-receipt.json'), '{}')

    const inspected = inspectReleaseSourceCleanliness(root)
    assert.equal(inspected.ok, false)
    assert.ok(inspected.blockers.includes('release_source_tree_dirty'))
    assert.ok(inspected.dirty_entries.some((entry) => entry === '?? pack-receipt.json'))
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
