import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  createReleaseUpgradeIsolation,
  runValidatedReleaseUpgradeLifecycle,
  validateReleaseUpgradeMenuBarRollbackReceipt,
  type ReleaseUpgradeCommandResult,
  type ReleaseUpgradeCommandSpec
} from '../../../scripts/release-upgrade-smoke.js'
import {
  doctorReportPath,
  makeLifecycleInput,
  result,
  writeDoctorReport
} from './release-upgrade-smoke-fixtures.js'

test('release upgrade lifecycle keeps every command in one fresh prefix and uses packaged Menu Bar rollback', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-smoke-test-'))
  try {
    const isolation = await createReleaseUpgradeIsolation(temp, {
      PATH: '/usr/bin:/bin',
      HOME: '/host-home-must-not-leak',
      CODEX_HOME: '/host-codex-must-not-leak',
      NPM_TOKEN: 'host-token-must-not-leak'
    })
    assert.notEqual(isolation.home, '/host-home-must-not-leak')
    assert.notEqual(isolation.codexHome, '/host-codex-must-not-leak')
    assert.equal(isolation.env.NPM_TOKEN, undefined)

    const seen: ReleaseUpgradeCommandSpec[] = []
    const runner = async (spec: ReleaseUpgradeCommandSpec): Promise<ReleaseUpgradeCommandResult> => {
      seen.push(spec)
      const version = spec.stage.startsWith('baseline_') || spec.stage.startsWith('package_rollback_') ? '7.6.0' : '8.0.0'
      if (spec.stage.endsWith('_version')) return result(`sneakoscope ${version}\n`)
      if (spec.stage.endsWith('_doctor')) {
        const body = { schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }
        await writeDoctorReport(spec, body)
        return result(JSON.stringify(body))
      }
      if (spec.stage === 'baseline_bootstrap') {
        return result(JSON.stringify({
          schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
        }))
      }
      if (spec.stage.endsWith('_menubar_install') || spec.stage === 'target_menubar_reinstall_install') {
        return result(JSON.stringify({
          schema: 'sks.codex-app-sks-menubar.v1', ok: true,
          status: 'installed_launch_skipped', blockers: [],
          launch: { requested: false, method: 'skipped', ok: true },
          build_stamp: { package_version: version }
        }))
      }
      if (spec.stage.endsWith('_menubar_status') || spec.stage === 'target_menubar_reinstall_status') {
        return result(JSON.stringify({
          schema: 'sks.menubar-status.v1', ok: false, installed: true,
          build_stamp: { package_version: version }, action_target: { ok: true },
          signature: { ok: true }, resources: { ok: true }, blockers: ['launchd_not_running']
        }), 1)
      }
      if (spec.stage === 'target_menubar_rollback') {
        return result(JSON.stringify({
          schema: 'sks.menubar-rollback.v1', ok: true,
          status: 'rolled_back_launch_skipped', blockers: [],
          previous_version: '7.6.0', replaced_version: '8.0.0',
          verification_before: { ok: true }, verification_after: { ok: true },
          launch: { requested: false, method: 'skipped', ok: true }
        }))
      }
      return result('')
    }

    const lifecycle = await runValidatedReleaseUpgradeLifecycle(
      await makeLifecycleInput(isolation, 'darwin'), runner
    )

    assert.deepEqual(lifecycle.blockers, [])
    for (const state of Object.values(lifecycle.states)) assert.equal(state.status, 'passed')
    assert.deepEqual(seen.map((entry) => entry.stage), [
      'baseline_install', 'baseline_version', 'baseline_bootstrap', 'baseline_doctor',
      'baseline_menubar_install', 'baseline_menubar_status',
      'target_install', 'target_version', 'target_doctor',
      'target_menubar_install', 'target_menubar_status', 'target_menubar_rollback',
      'target_menubar_reinstall_install', 'target_menubar_reinstall_status',
      'package_rollback_install', 'package_rollback_version', 'package_rollback_doctor'
    ])
    for (const spec of seen) {
      assert.equal(spec.cwd, isolation.workspace)
      assert.equal(spec.env.HOME, isolation.home)
      assert.equal(spec.env.CODEX_HOME, isolation.codexHome)
      assert.equal(spec.env.npm_config_cache, isolation.npmCache)
      assert.equal(spec.env.npm_config_prefix, isolation.npmPrefix)
      assert.equal(spec.env.NPM_TOKEN, undefined)
    }
    const globalInstalls = seen.filter((entry) => entry.command === 'npm' && entry.args[0] === 'install')
    assert.equal(globalInstalls.length, 3)
    for (const install of globalInstalls) {
      assert.deepEqual(install.args.slice(0, 4), ['install', '--global', '--prefix', isolation.npmPrefix])
      const tarball = install.args.at(-1)
      assert.ok(tarball)
      assert.equal(path.dirname(tarball), isolation.sealedInputsDir)
    }
    const rollback = seen.find((entry) => entry.stage === 'target_menubar_rollback')
    assert.ok(rollback)
    assert.deepEqual(rollback.args.slice(0, 5), ['menubar', 'rollback', '--no-launch', '--json', '--home'])
    assert.ok(rollback.args.includes(path.join(isolation.npmPrefix, 'lib', 'node_modules', 'sneakoscope')))
    const doctorReceipts = lifecycle.commands.filter((entry) => entry.stage.endsWith('_doctor'))
    assert.equal(doctorReceipts.length, 3)
    for (const receipt of doctorReceipts) {
      assert.equal(receipt.report_file?.regular_file, true)
      assert.equal(receipt.report_file?.inside_sandbox, true)
      assert.equal(receipt.report_file?.matches_stdout, true)
      assert.match(String(receipt.report_file?.sha256), /^[a-f0-9]{64}$/)
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('pinned 7.6 doctors may use valid stdout-only evidence while target doctor stays strict', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-620-doctor-compat-'))
  try {
    const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
    const lifecycle = await runValidatedReleaseUpgradeLifecycle(
      await makeLifecycleInput(isolation, 'linux'),
      async (spec) => {
        if (spec.stage.endsWith('_version')) {
          return result(`sneakoscope ${spec.stage === 'target_version' ? '8.0.0' : '7.6.0'}\n`)
        }
        if (spec.stage === 'baseline_bootstrap') {
          return result(JSON.stringify({
            schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
          }))
        }
        if (spec.stage.endsWith('_doctor')) {
          const body = { schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }
          if (spec.stage === 'target_doctor') await writeDoctorReport(spec, body)
          return result(JSON.stringify(body))
        }
        return result('')
      }
    )

    assert.deepEqual(lifecycle.blockers, [])
    assert.equal(lifecycle.states.baseline_package.status, 'passed')
    assert.equal(lifecycle.states.target_package.status, 'passed')
    assert.equal(lifecycle.states.package_rollback.status, 'passed')
    const doctors = lifecycle.commands.filter((entry) => entry.stage.endsWith('_doctor'))
    assert.deepEqual(doctors.map((entry) => entry.report_file?.validation_mode), [
      'pinned_baseline_stdout_only', 'strict_report_file', 'pinned_baseline_stdout_only'
    ])
    assert.deepEqual(doctors.map((entry) => entry.report_file?.regular_file), [false, true, false])
    assert.deepEqual(doctors.map((entry) => entry.report_file?.matches_stdout), [false, true, false])
    for (const receipt of doctors) assert.ok(receipt.argv.includes('--report-file'))
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('pinned 7.6 stdout-only doctor compatibility rejects invalid stdout evidence', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-620-doctor-invalid-'))
  const cases = [
    [(_root: string) => JSON.stringify({ schema: 'sks.doctor-status.v3', ok: true, root: '/wrong-root' }), 0],
    [(_root: string) => JSON.stringify({ schema: 'sks.doctor-status.v3', ok: false }), 0],
    [(_root: string) => '{}', 0],
    [(root: string) => JSON.stringify({ schema: 'sks.doctor-status.v3', ok: true, root }), 1]
  ] as const
  try {
    for (const [makeStdout, code] of cases) {
      const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
      const lifecycle = await runValidatedReleaseUpgradeLifecycle(
        await makeLifecycleInput(isolation, 'linux'),
        async (spec) => {
          if (spec.stage === 'baseline_version') return result('sneakoscope 7.6.0\n')
          if (spec.stage === 'baseline_bootstrap') {
            return result(JSON.stringify({
              schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
            }))
          }
          if (spec.stage === 'baseline_doctor') return result(makeStdout(isolation.workspace), code)
          return result('')
        }
      )
      assert.ok(lifecycle.blockers.includes('baseline_doctor_stdout_failed'))
      assert.equal(lifecycle.states.baseline_package.status, 'failed')
      assert.equal(lifecycle.states.target_package.status, 'skipped')
      const receipt = lifecycle.commands.find((entry) => entry.stage === 'baseline_doctor')
      assert.equal(receipt?.report_file?.validation_mode, 'strict_report_file')
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('pinned 7.6 stdout-only doctor compatibility rejects unsafe report directories', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-620-doctor-parent-'))
  try {
    for (const mode of ['removed', 'symlink', 'outside'] as const) {
      const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
      const unsafeParent = path.join(temp, `unsafe-${mode}-${path.basename(isolation.sandbox)}`)
      if (mode === 'outside') {
        isolation.commandReportsDir = unsafeParent
        await fs.mkdir(unsafeParent, { recursive: true })
      }
      const lifecycle = await runValidatedReleaseUpgradeLifecycle(
        await makeLifecycleInput(isolation, 'linux'),
        async (spec) => {
          if (spec.stage === 'baseline_version') return result('sneakoscope 7.6.0\n')
          if (spec.stage === 'baseline_bootstrap') {
            return result(JSON.stringify({
              schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
            }))
          }
          if (spec.stage === 'baseline_doctor') {
            if (mode === 'removed') {
              await fs.rm(isolation.commandReportsDir, { recursive: true, force: true })
            } else if (mode === 'symlink') {
              await fs.mkdir(unsafeParent, { recursive: true })
              await fs.rm(isolation.commandReportsDir, { recursive: true, force: true })
              await fs.symlink(unsafeParent, isolation.commandReportsDir)
            }
            return result(JSON.stringify({ schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }))
          }
          return result('')
        }
      )

      assert.ok(lifecycle.blockers.includes('baseline_doctor:doctor_report_missing_or_unreadable'), mode)
      assert.ok(lifecycle.blockers.includes('baseline_doctor:doctor_report_stdout_mismatch'), mode)
      assert.equal(lifecycle.states.baseline_package.status, 'failed', mode)
      const receipt = lifecycle.commands.find((entry) => entry.stage === 'baseline_doctor')
      assert.equal(receipt?.report_file?.validation_mode, 'strict_report_file', mode)
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('target 8.0 doctor still requires a matching report file', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-target-doctor-report-'))
  try {
    const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
    const lifecycle = await runValidatedReleaseUpgradeLifecycle(
      await makeLifecycleInput(isolation, 'linux'),
      async (spec) => {
        if (spec.stage.endsWith('_version')) {
          return result(`sneakoscope ${spec.stage === 'target_version' ? '8.0.0' : '7.6.0'}\n`)
        }
        if (spec.stage === 'baseline_bootstrap') {
          return result(JSON.stringify({
            schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
          }))
        }
        if (spec.stage.endsWith('_doctor')) {
          return result(JSON.stringify({ schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }))
        }
        return result('')
      }
    )

    assert.ok(lifecycle.blockers.includes('target_doctor:doctor_report_missing_or_unreadable'))
    assert.ok(lifecycle.blockers.includes('target_doctor:doctor_report_stdout_mismatch'))
    assert.equal(lifecycle.states.baseline_package.status, 'passed')
    assert.equal(lifecycle.states.target_package.status, 'failed')
    const receipt = lifecycle.commands.find((entry) => entry.stage === 'target_doctor')
    assert.equal(receipt?.report_file?.validation_mode, 'strict_report_file')
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('Menu Bar rollback proof requires the exact no-launch success receipt', () => {
  const valid = {
    schema: 'sks.menubar-rollback.v1',
    ok: true,
    status: 'rolled_back_launch_skipped',
    previous_version: '7.6.0',
    replaced_version: '8.0.0',
    verification_before: { ok: true },
    verification_after: { ok: true },
    launch: { requested: false, method: 'skipped', ok: true },
    blockers: []
  }
  assert.equal(validateReleaseUpgradeMenuBarRollbackReceipt(valid, '8.0.0'), true)
  for (const invalid of [
    { ...valid, status: 'rolled_back' },
    { ...valid, launch: { ...valid.launch, method: 'launchctl' } },
    { ...valid, launch: { ...valid.launch, ok: false } },
    { ...valid, blockers: ['launch_attempted'] }
  ]) {
    assert.equal(validateReleaseUpgradeMenuBarRollbackReceipt(invalid, '8.0.0'), false)
  }
})

test('sealed target input is revalidated immediately before target install', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-sealed-toctou-'))
  try {
    for (const mode of ['symlink', 'bytes'] as const) {
      const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
      const input = await makeLifecycleInput(isolation, 'linux')
      const seen: string[] = []
      const outside = path.join(temp, `outside-${mode}-${path.basename(isolation.sandbox)}.tgz`)
      const lifecycle = await runValidatedReleaseUpgradeLifecycle(input, async (spec) => {
        seen.push(spec.stage)
        if (spec.stage.endsWith('_version')) return result('sneakoscope 7.6.0\n')
        if (spec.stage === 'baseline_bootstrap') {
          return result(JSON.stringify({
            schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
          }))
        }
        if (spec.stage.endsWith('_doctor')) {
          const body = { schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }
          await writeDoctorReport(spec, body)
          if (spec.stage === 'baseline_doctor') {
            await fs.chmod(input.targetTarball, 0o600)
            if (mode === 'symlink') {
              await fs.writeFile(outside, 'outside-target')
              await fs.rm(input.targetTarball)
              await fs.symlink(outside, input.targetTarball)
            } else {
              await fs.writeFile(input.targetTarball, 'altered-target')
              await fs.chmod(input.targetTarball, 0o400)
            }
          }
          return result(JSON.stringify(body))
        }
        return result('')
      })

      assert.equal(seen.includes('target_install'), false)
      const expected = mode === 'symlink' ? 'sealed_target_symlink_refused' : 'sealed_target_sha256_mismatch'
      assert.ok(lifecycle.blockers.includes(expected), `${mode}: ${lifecycle.blockers.join(',')}`)
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('baseline bootstrap requires the exact setup receipt instead of accepting empty or weak JSON', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-bootstrap-contract-'))
  try {
    for (const stdout of [
      '',
      '{}',
      JSON.stringify({ schema: 'sks.bootstrap.v1', ok: true }),
      JSON.stringify({ schema: 'sks.setup.v1', ok: false, local_only: true })
    ]) {
      const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
      const seen: string[] = []
      const lifecycle = await runValidatedReleaseUpgradeLifecycle(await makeLifecycleInput(isolation, 'linux'), async (spec) => {
        seen.push(spec.stage)
        if (spec.stage === 'baseline_version') return result('sneakoscope 7.6.0\n')
        if (spec.stage === 'baseline_bootstrap') return result(stdout)
        return result('')
      })
      assert.ok(lifecycle.blockers.includes('baseline_bootstrap_failed'))
      assert.equal(seen.includes('baseline_doctor'), false)
      assert.equal(seen.includes('target_install'), false)
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})

test('pinned 7.6 doctor fallback rejects unsafe or mismatched report files when present', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-upgrade-doctor-contract-'))
  const cases = [
    ['invalid', 'doctor_report_schema_invalid'],
    ['mismatch', 'doctor_report_stdout_mismatch'],
    ['symlink', 'doctor_report_symlink_refused'],
    ['outside', 'doctor_report_path_outside_sandbox']
  ] as const
  try {
    for (const [mode, expectedBlocker] of cases) {
      const isolation = await createReleaseUpgradeIsolation(temp, { PATH: '/usr/bin:/bin' })
      if (mode === 'outside') {
        isolation.commandReportsDir = path.join(temp, `outside-${path.basename(isolation.sandbox)}`)
        await fs.mkdir(isolation.commandReportsDir, { recursive: true })
      }
      const lifecycle = await runValidatedReleaseUpgradeLifecycle(await makeLifecycleInput(isolation, 'linux'), async (spec) => {
        if (spec.stage === 'baseline_version') return result('sneakoscope 7.6.0\n')
        if (spec.stage === 'baseline_bootstrap') {
          return result(JSON.stringify({
            schema: 'sks.setup.v1', ok: true, status: 'completed', local_only: true, root: isolation.workspace
          }))
        }
        if (spec.stage === 'baseline_doctor') {
          const stdoutBody = { schema: 'sks.doctor-status.v3', ok: true, root: isolation.workspace }
          const reportPath = doctorReportPath(spec)
          await fs.mkdir(path.dirname(reportPath), { recursive: true })
          if (mode === 'invalid') await fs.writeFile(reportPath, '{}')
          else if (mode === 'mismatch') await fs.writeFile(reportPath, JSON.stringify({ ...stdoutBody, source: 'report' }))
          else if (mode === 'symlink') {
            const outside = path.join(temp, `doctor-outside-${path.basename(isolation.sandbox)}.json`)
            await fs.writeFile(outside, JSON.stringify(stdoutBody))
            await fs.symlink(outside, reportPath)
          } else if (mode === 'outside') await fs.writeFile(reportPath, JSON.stringify(stdoutBody))
          return result(JSON.stringify(stdoutBody))
        }
        return result('')
      })
      assert.ok(lifecycle.blockers.some((blocker) => blocker.endsWith(expectedBlocker)), `${mode}: ${lifecycle.blockers.join(',')}`)
      assert.equal(lifecycle.states.baseline_package.status, 'failed')
      const receipt = lifecycle.commands.find((entry) => entry.stage === 'baseline_doctor')
      assert.ok(receipt?.report_file)
      assert.equal(receipt.report_file.expected_package_version, '7.6.0')
      if (mode === 'symlink') assert.equal(receipt.report_file.symlink_refused, true)
      if (mode === 'outside') assert.equal(receipt.report_file.inside_sandbox, false)
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true })
  }
})
