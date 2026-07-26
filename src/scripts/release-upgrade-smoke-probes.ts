import fs from 'node:fs'
import path from 'node:path'
import { runLifecycleCommand } from './release-upgrade-smoke-command.js'
import type {
  ReleaseUpgradeCommandReceipt,
  ReleaseUpgradeCommandResult,
  ReleaseUpgradeCommandRunner,
  ReleaseUpgradeIsolation,
  ReleaseUpgradeLifecycleInput
} from './release-upgrade-smoke-contract.js'
import { RELEASE_UPGRADE_BASELINE_VERSION } from './release-upgrade-smoke-contract.js'
import { verifySealedTarball } from './release-upgrade-smoke-isolation.js'
import {
  canonicalJson,
  hashBytes,
  hashText,
  isSubpath,
  npmInstallArgs,
  parseJson,
  samePath,
  stringOrNull,
  unique
} from './release-upgrade-smoke-utils.js'

export async function installAndInspectMenuBar(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[],
  bin: string,
  packageRoot: string,
  expectedVersion: string,
  stagePrefix: string,
  requireResources: boolean
): Promise<{ version: string | null; stages: string[]; blockers: string[] }> {
  const installStage = `${stagePrefix}_install`
  const statusStage = `${stagePrefix}_status`
  const install = await jsonProbe(
    input, runner, commands, installStage, bin,
    ['menubar', 'install', '--no-launch', '--json', '--home', input.isolation.home, '--root', packageRoot],
    (json) => json?.schema === 'sks.codex-app-sks-menubar.v1'
      && json?.ok === true
      && json?.status === 'installed_launch_skipped'
      && json?.launch?.requested === false
      && json?.launch?.method === 'skipped'
      && json?.launch?.ok === true
      && json?.build_stamp?.package_version === expectedVersion
      && Array.isArray(json?.blockers)
      && json.blockers.length === 0,
    `${installStage}_failed`
  )
  if (!install.ok) return { version: null, stages: [installStage], blockers: install.blockers }
  const statusResult = await runLifecycleCommand(
    input, runner, commands, statusStage, bin,
    ['menubar', 'status', '--json', '--home', input.isolation.home, '--root', packageRoot]
  )
  const status = parseJson(statusResult.stdout) as Record<string, any> | null
  const unexpected = Array.isArray(status?.blockers)
    ? status.blockers.map(String).filter((blocker: string) => blocker !== 'launchd_not_running')
    : ['menubar_status_blockers_invalid']
  const valid = (statusResult.code === 0 || statusResult.code === 1)
    && status?.schema === 'sks.menubar-status.v1'
    && status?.installed === true
    && status?.build_stamp?.package_version === expectedVersion
    && status?.action_target?.ok === true
    && status?.signature?.ok === true
    && (!requireResources || status?.resources?.ok === true)
    && unexpected.length === 0
  return {
    version: stringOrNull(status?.build_stamp?.package_version),
    stages: [installStage, statusStage],
    blockers: valid ? [] : unique([`${statusStage}_failed`, ...unexpected])
  }
}

export async function versionProbe(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[],
  stage: string,
  bin: string,
  expected: string
): Promise<{ ok: boolean; version: string | null; blockers: string[] }> {
  const result = await runLifecycleCommand(input, runner, commands, stage, bin, ['--version'])
  const match = result.stdout.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/)
  const version = match?.[1] || null
  const blockers = [
    ...(result.code === 0 ? [] : [`${stage}_command_failed`]),
    ...(version === expected ? [] : [`${stage}_mismatch:${version || 'missing'}:expected_${expected}`])
  ]
  return { ok: blockers.length === 0, version, blockers }
}

export async function doctorProbe(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[],
  stage: string,
  bin: string,
  expectedVersion: string,
  evidencePolicy: 'strict_report_file' | 'pinned_baseline_stdout_compatible' = 'strict_report_file'
): Promise<{ ok: boolean; version: null; json: any; blockers: string[] }> {
  const reportPath = path.join(input.isolation.commandReportsDir, `${stage}.json`)
  const result = await runLifecycleCommand(
    input, runner, commands, stage, bin,
    ['doctor', '--json', '--report-file', reportPath]
  )
  const json = parseJson(result.stdout)
  const stdoutOk = result.code === 0
    && json?.schema === 'sks.doctor-status.v3'
    && json?.ok === true
    && typeof json?.root === 'string'
    && samePath(json.root, input.isolation.workspace)
  const inspected = inspectDoctorReport(reportPath, input.isolation, json, expectedVersion)
  const stdoutOnlyCompatible = evidencePolicy === 'pinned_baseline_stdout_compatible'
    && expectedVersion === RELEASE_UPGRADE_BASELINE_VERSION
    && stdoutOk
    && inspected.reportAbsentByEnoent
    && inspected.reportParentSafe
    && inspected.blockers.length === 2
    && inspected.blockers.every((blocker) => blocker === 'doctor_report_missing_or_unreadable'
      || blocker === 'doctor_report_stdout_mismatch')
  inspected.binding.validation_mode = stdoutOnlyCompatible
    ? 'pinned_baseline_stdout_only'
    : 'strict_report_file'
  const receipt = commands.at(-1)
  if (receipt?.stage === stage) receipt.report_file = inspected.binding
  const blockers = unique([
    ...(stdoutOk ? [] : [`${stage}_stdout_failed`]),
    ...(stdoutOnlyCompatible ? [] : inspected.blockers.map((blocker) => `${stage}:${blocker}`))
  ])
  return { ok: blockers.length === 0, version: null, json, blockers }
}

export async function jsonProbe(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[],
  stage: string,
  commandName: string,
  args: string[],
  validate: (json: any) => boolean,
  blocker: string
): Promise<{ ok: boolean; version: null; json: any; blockers: string[] }> {
  const result = await runLifecycleCommand(input, runner, commands, stage, commandName, args)
  const json = parseJson(result.stdout)
  const ok = result.code === 0 && validate(json)
  return { ok, version: null, json, blockers: ok ? [] : [blocker] }
}

export async function installSealedTarball(
  input: ReleaseUpgradeLifecycleInput,
  runner: ReleaseUpgradeCommandRunner,
  commands: ReleaseUpgradeCommandReceipt[],
  stage: string,
  tarball: string,
  expectedSha256: string,
  label: 'baseline' | 'target'
): Promise<{ result: ReleaseUpgradeCommandResult | null; blockers: string[] }> {
  const verified = verifySealedTarball(tarball, expectedSha256, input.isolation, label)
  if (verified.length) return { result: null, blockers: verified }
  const result = await runLifecycleCommand(
    input, runner, commands, stage, input.npmCommand,
    npmInstallArgs(input.isolation.npmPrefix, tarball)
  )
  return { result, blockers: [] }
}

function inspectDoctorReport(
  reportPath: string,
  isolation: ReleaseUpgradeIsolation,
  stdoutJson: any,
  expectedVersion: string
): {
  binding: NonNullable<ReleaseUpgradeCommandReceipt['report_file']>
  blockers: string[]
  reportAbsentByEnoent: boolean
  reportParentSafe: boolean
} {
  const blockers: string[] = []
  const lexicalInside = isSubpath(reportPath, isolation.sandbox)
    && isSubpath(reportPath, isolation.commandReportsDir)
  if (!lexicalInside) blockers.push('doctor_report_path_outside_sandbox')
  const reportParent = path.dirname(reportPath)
  let reportParentSafe = false
  try {
    const parentStat = fs.lstatSync(reportParent)
    const parentRealPath = fs.realpathSync(reportParent)
    reportParentSafe = parentStat.isDirectory()
      && !parentStat.isSymbolicLink()
      && samePath(reportParent, isolation.commandReportsDir)
      && isSubpath(parentRealPath, isolation.sandbox)
  } catch {}
  let stat: fs.Stats | null = null
  let reportAbsentByEnoent = false
  try {
    stat = fs.lstatSync(reportPath)
  } catch (error) {
    reportAbsentByEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT'
    blockers.push('doctor_report_missing_or_unreadable')
  }
  const symlink = stat?.isSymbolicLink() === true
  const regular = stat?.isFile() === true && !symlink
  if (symlink) blockers.push('doctor_report_symlink_refused')
  else if (stat && !regular) blockers.push('doctor_report_not_regular_file')
  let realPath: string | null = null
  if (regular) {
    try {
      realPath = fs.realpathSync(reportPath)
      if (!isSubpath(realPath, isolation.sandbox) || !isSubpath(realPath, isolation.commandReportsDir)) {
        blockers.push('doctor_report_realpath_outside_sandbox')
      }
    } catch {
      blockers.push('doctor_report_realpath_unavailable')
    }
  }
  let bytes: Buffer | null = null
  let reportJson: any = null
  if (regular && realPath && isSubpath(realPath, isolation.sandbox) && isSubpath(realPath, isolation.commandReportsDir)) {
    try {
      bytes = fs.readFileSync(reportPath)
      reportJson = JSON.parse(bytes.toString('utf8'))
    } catch {
      blockers.push('doctor_report_json_invalid')
    }
  }
  if (reportJson) {
    if (reportJson.schema !== 'sks.doctor-status.v3') blockers.push('doctor_report_schema_invalid')
    if (reportJson.ok !== true) blockers.push('doctor_report_not_ok')
    if (typeof reportJson.root !== 'string' || !samePath(reportJson.root, isolation.workspace)) {
      blockers.push('doctor_report_root_mismatch')
    }
  }
  const reportJsonSha256 = reportJson ? hashText(canonicalJson(reportJson)) : null
  const stdoutJsonSha256 = stdoutJson ? hashText(canonicalJson(stdoutJson)) : null
  const matchesStdout = Boolean(reportJsonSha256 && stdoutJsonSha256 && reportJsonSha256 === stdoutJsonSha256)
  if (!matchesStdout) blockers.push('doctor_report_stdout_mismatch')
  return {
    binding: {
      validation_mode: 'strict_report_file',
      path: reportPath,
      real_path: realPath,
      inside_sandbox: Boolean(
        lexicalInside
        && realPath
        && isSubpath(realPath, isolation.sandbox)
        && isSubpath(realPath, isolation.commandReportsDir)
      ),
      regular_file: regular,
      symlink_refused: symlink,
      sha256: bytes ? hashBytes(bytes) : null,
      json_sha256: reportJsonSha256,
      stdout_json_sha256: stdoutJsonSha256,
      matches_stdout: matchesStdout,
      schema: typeof reportJson?.schema === 'string' ? reportJson.schema : null,
      ok: typeof reportJson?.ok === 'boolean' ? reportJson.ok : null,
      root: typeof reportJson?.root === 'string' ? reportJson.root : null,
      expected_package_version: expectedVersion
    },
    blockers: unique(blockers),
    reportAbsentByEnoent,
    reportParentSafe
  }
}
