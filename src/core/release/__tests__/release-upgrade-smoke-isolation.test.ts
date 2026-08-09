import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createReleaseUpgradeIsolation,
  inspectReleaseUpgradeLaunchctlLog,
  removeReleaseUpgradeSandbox,
  runReleaseUpgradeCommand,
  sealReleaseUpgradeTarball
} from '../../../scripts/release-upgrade-smoke.js'
import { pathExists } from './release-upgrade-smoke-fixtures.js'

test('isolation routes launchctl and broad postinstall side effects to sandbox-safe controls', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-launchctl-stub-'))
  try {
    const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
    assert.equal(isolation.env.SKS_MENUBAR_LAUNCHCTL, isolation.launchctlStub)
    assert.notEqual(isolation.env.SKS_MENUBAR_LAUNCHCTL, '/bin/launchctl')
    assert.equal(isolation.env.SKS_POSTINSTALL_NO_BOOTSTRAP, '1')
    assert.equal(isolation.env.SKS_POSTINSTALL_GLOBAL_DOCTOR, '0')
    assert.equal(isolation.env.SKS_POSTINSTALL_RECONCILE_APP_PROCESSES, '0')
    assert.equal(isolation.env.SKS_SKIP_POSTINSTALL_CONTEXT7, '1')
    assert.equal(isolation.env.SKS_SKIP_CODEX_LB_LAUNCH_ENV, '1')
    assert.equal(isolation.env.SKS_DISABLE_NETWORK, '1')
    assert.equal(String(isolation.env.PATH).split(path.delimiter)[0], path.dirname(isolation.launchctlStub))
    const resolved = spawnSync('/bin/sh', ['-c', 'command -v launchctl'], {
      cwd: isolation.workspace,
      env: isolation.env,
      encoding: 'utf8'
    })
    assert.equal(resolved.status, 0)
    assert.equal(resolved.stdout.trim(), isolation.launchctlStub)

    const unsetenv = await runReleaseUpgradeCommand({
      stage: 'stub_unsetenv', command: isolation.launchctlStub, args: ['unsetenv', 'CODEX_LB_API_KEY'],
      cwd: isolation.workspace, env: isolation.env, timeoutMs: 5_000
    })
    const printed = await runReleaseUpgradeCommand({
      stage: 'stub_print', command: isolation.launchctlStub, args: ['print', 'gui/501/com.sneakoscope.sks-menubar'],
      cwd: isolation.workspace, env: isolation.env, timeoutMs: 5_000
    })
    // Replacing an existing install boots out the service it replaces, so the
    // stub accepts that for this product's own labels and refuses every other
    // target. A foreign label must not even be echoed into the log.
    const ownBootout = await runReleaseUpgradeCommand({
      stage: 'stub_bootout_own', command: isolation.launchctlStub, args: ['bootout', 'gui/501/com.sneakoscope.sks-menubar'],
      cwd: isolation.workspace, env: isolation.env, timeoutMs: 5_000
    })
    const foreignBootout = await runReleaseUpgradeCommand({
      stage: 'stub_bootout_foreign', command: isolation.launchctlStub, args: ['bootout', 'gui/501/com.apple.Finder'],
      cwd: isolation.workspace, env: isolation.env, timeoutMs: 5_000
    })
    const secret = 'super-secret-launchctl-value'
    const forbidden = await runReleaseUpgradeCommand({
      stage: 'stub_forbidden_setenv', command: 'launchctl', args: ['setenv', 'OPENAI_API_KEY', secret],
      cwd: isolation.workspace, env: isolation.env, timeoutMs: 5_000
    })
    assert.equal(unsetenv.code, 0)
    // The stub is what the upgrade under test observes, so an absent service has
    // to read exactly as launchctl reports one: anything the product cannot
    // classify makes it fail closed on a condition that exists only in here.
    assert.equal(printed.code, 113)
    assert.match(printed.stderr, /Bad request\./)
    assert.match(printed.stderr, /Could not find service/)
    assert.equal(ownBootout.code, 0)
    assert.notEqual(foreignBootout.code, 0)
    assert.notEqual(forbidden.code, 0)
    const log = await fs.readFile(isolation.launchctlLog, 'utf8')
    assert.equal(log.includes(secret), false)
    assert.equal(log.includes('com.apple.Finder'), false)
    assert.deepEqual(log.trim().split('\n'), [
      'unsetenv CODEX_LB_API_KEY',
      'print',
      'bootout com.sneakoscope.sks-menubar',
      'forbidden bootout [redacted]',
      'forbidden setenv'
    ])
    const inspected = inspectReleaseUpgradeLaunchctlLog(isolation)
    assert.deepEqual(inspected.unexpected, ['forbidden bootout [redacted]', 'forbidden setenv'])
    assert.ok(inspected.blockers.includes('launchctl_stub_unexpected_call:forbidden setenv'))

    // Process discovery is the other route out of the HOME redirect, and naming
    // the tools does nothing unless the injection flag is set.
    assert.equal(isolation.env.SKS_MENUBAR_TEST_PROCESS_TOOLS, '1')
    assert.equal(path.dirname(String(isolation.env.SKS_MENUBAR_PGREP)), path.dirname(isolation.launchctlStub))
    assert.equal(path.dirname(String(isolation.env.SKS_MENUBAR_PS)), path.dirname(isolation.launchctlStub))
    for (const tool of [isolation.env.SKS_MENUBAR_PGREP, isolation.env.SKS_MENUBAR_PS]) {
      const probe = spawnSync(String(tool), ['-f', 'SKSMenuBar'], { cwd: isolation.workspace, env: isolation.env, encoding: 'utf8' })
      assert.notEqual(probe.status, 0)
      assert.equal(probe.stdout.trim(), '')
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('tarball sealing copies, hashes, and makes the sandbox input read-only', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-seal-'))
  try {
    const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
    const source = path.join(temp, 'source-target.tgz')
    const bytes = Buffer.from('independent-release-input')
    await fs.writeFile(source, bytes)
    const expected = crypto.createHash('sha256').update(bytes).digest('hex')

    const sealed = sealReleaseUpgradeTarball(source, expected, isolation, 'target-8.0.0.tgz')
    assert.deepEqual(sealed.blockers, [])
    assert.ok(sealed.path)
    assert.equal(path.dirname(sealed.path), isolation.sealedInputsDir)
    assert.notEqual(sealed.path, source)
    assert.deepEqual(await fs.readFile(sealed.path), bytes)
    assert.equal((await fs.stat(sealed.path)).mode & 0o222, 0)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('sandbox cleanup receipts reflect removal failures and partial creation truth', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-cleanup-'))
  try {
    const retainedSandbox = path.join(temp, 'retained-sandbox')
    await fs.mkdir(retainedSandbox)
    const removal = await removeReleaseUpgradeSandbox(retainedSandbox, async () => {
      throw new Error('injected-remove-failure')
    })
    assert.equal(removal.status, 'remove_failed')
    assert.equal(removal.retained, true)
    assert.equal(removal.removed, false)
    assert.equal(removal.error, 'injected-remove-failure')
    assert.ok(removal.blockers.includes('sandbox_cleanup_failed:injected-remove-failure'))
    assert.equal(await pathExists(retainedSandbox), true)

    let removedPartial = ''
    try {
      await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' }, {
        afterSandboxCreated: async (sandbox) => {
          removedPartial = sandbox
          throw new Error('injected-partial-create-failure')
        }
      })
      assert.fail('partial creation should fail')
    } catch (error) {
      const receipt = error as Error & { cleanupStatus?: string; cleanupError?: string | null }
      assert.match(receipt.message, /injected-partial-create-failure/)
      assert.equal(receipt.cleanupStatus, 'partial_creation_removed')
      assert.equal(receipt.cleanupError, null)
    }
    assert.equal(await pathExists(removedPartial), false)

    let retainedPartial = ''
    try {
      await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' }, {
        afterSandboxCreated: async (sandbox) => {
          retainedPartial = sandbox
          throw new Error('injected-partial-create-failure')
        },
        removeSandbox: async () => {
          throw new Error('injected-partial-cleanup-failure')
        }
      })
      assert.fail('partial creation cleanup should fail')
    } catch (error) {
      const receipt = error as Error & { cleanupStatus?: string; cleanupError?: string | null }
      assert.equal(receipt.cleanupStatus, 'partial_creation_remove_failed')
      assert.equal(receipt.cleanupError, 'injected-partial-cleanup-failure')
    }
    assert.equal(await pathExists(retainedPartial), true)
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
