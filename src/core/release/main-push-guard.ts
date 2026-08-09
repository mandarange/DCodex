import path from 'node:path'
import { sameFilesystemPathSync } from '../fsx.js'
import { readMacosMenubarProof, validateMacosMenubarProofArtifacts } from './macos-menubar-proof.js'
import { fileSha256, gitOk, gitText, readJson, relative, unique } from './release-proof-io.js'
import { releaseOriginIdentity } from './release-origin.js'
import { releaseProofDir, validateLocalReleasePackBinding } from './release-pack-receipt.js'
import { validatePhysicalReleaseGateInspection } from './physical-release-gates.js'
import { validateFullReleaseStamp } from './release-stamp-proof.js'
import {
  RELEASE_UPGRADE_BASELINE_SHA256,
  RELEASE_UPGRADE_BASELINE_VERSION,
  isExpectedReleaseUpgradeLaunchctlCall,
  releaseUpgradeExpectedVersion,
  releaseUpgradeProofFilename
} from './release-upgrade-baseline.js'

export const MAIN_PUSH_GUARD_SCHEMA = 'sks.release-main-push-guard.v1'
const RELEASE_UPGRADE_SMOKE_SCHEMA = 'sks.release-upgrade-smoke.v2'
const RELEASE_UPGRADE_COMMAND_STAGES = Object.freeze([
  'baseline_fetch',
  'baseline_install',
  'baseline_version',
  'baseline_bootstrap',
  'baseline_doctor',
  'baseline_menubar_install',
  'baseline_menubar_status',
  'target_install',
  'target_version',
  'target_doctor',
  'target_menubar_install',
  'target_menubar_status',
  'target_menubar_rollback',
  'target_menubar_reinstall_install',
  'target_menubar_reinstall_status',
  'package_rollback_install',
  'package_rollback_version',
  'package_rollback_doctor'
] as const)
const RELEASE_UPGRADE_STATE_STAGES = Object.freeze({
  baseline_package: ['baseline_install', 'baseline_version', 'baseline_bootstrap', 'baseline_doctor'],
  baseline_menubar: ['baseline_menubar_install', 'baseline_menubar_status'],
  target_package: ['target_install', 'target_version', 'target_doctor'],
  target_menubar: ['target_menubar_install', 'target_menubar_status'],
  menubar_rollback: ['target_menubar_rollback'],
  target_menubar_reinstall: ['target_menubar_reinstall_install', 'target_menubar_reinstall_status'],
  package_rollback: ['package_rollback_install', 'package_rollback_version', 'package_rollback_doctor']
} as const)

export interface MainPushGuardInput {
  root: string
  expectedVersion: string
  expectedOriginMain: string
  expectedOriginIdentity: string
  requireReleaseStamp?: boolean
  requirePackProof?: boolean
  requireMacosProof?: boolean
  requirePhysicalProof?: boolean
  requireCleanTree?: boolean
}

export function inspectMainPushGuard(input: MainPushGuardInput) {
  const blockers: string[] = []
  const pkg = readJson(path.join(input.root, 'package.json')) || {}
  const head = gitText(input.root, ['rev-parse', 'HEAD'])
  const originMain = gitText(input.root, ['rev-parse', 'origin/main'])
  const origin = releaseOriginIdentity(input.root)
  if (!head) blockers.push('head_sha_unavailable')
  if (originMain !== input.expectedOriginMain) blockers.push(`origin_main_mismatch:${originMain || 'missing'}`)
  if (!origin.identity || origin.identity !== input.expectedOriginIdentity) blockers.push(`origin_identity_mismatch:${origin.identity || 'missing'}`)
  if (pkg.version !== input.expectedVersion) blockers.push(`package_version_mismatch:${String(pkg.version || 'missing')}`)
  if (!gitOk(input.root, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])) blockers.push('origin_main_not_ancestor_of_head')
  if (input.requireCleanTree && gitText(input.root, ['status', '--porcelain=v1'])) blockers.push('worktree_not_clean')

  const proofDir = releaseProofDir(input.root, input.expectedVersion)
  if (input.requireReleaseStamp !== true) blockers.push('release_stamp_requirement_missing')
  if (input.requireReleaseStamp) {
    const validation = validateFullReleaseStamp({
      root: input.root,
      stampFile: path.join(input.root, '.sneakoscope', 'reports', 'release-check-stamp.json'),
      expectedVersion: input.expectedVersion,
      expectedHead: head
    })
    if (!validation.ok) blockers.push(...validation.blockers)
  }

  const pack = readJson(path.join(proofDir, 'pack-receipt.json'))
  if (input.requirePackProof !== true) blockers.push('pack_proof_requirement_missing')
  if (input.requirePackProof) {
    const validation = validateLocalReleasePackBinding(input.root, pack)
    if (!validation.ok) blockers.push('pack_receipt_missing_or_invalid', ...validation.blockers.map((blocker) => `pack_receipt:${blocker}`))
    if (pack?.package_version !== input.expectedVersion) blockers.push('pack_receipt_version_mismatch')
    if (head && pack?.source_commit !== head) blockers.push('pack_receipt_source_commit_mismatch')
  }

  const upgrade = validateReleaseUpgradeProof(input.root, input.expectedVersion, head, pack)
  blockers.push(...upgrade.blockers.map((blocker) => `upgrade_proof:${blocker}`))

  const macos = readMacosMenubarProof(input.root, input.expectedVersion)
  if (input.requireMacosProof !== true) blockers.push('macos_proof_requirement_missing')
  if (input.requireMacosProof) blockers.push(...validateMacosMenubarProofArtifacts(input.root, macos, {
    version: input.expectedVersion,
    ...(head ? { sourceCommit: head } : {}),
    upgradeReportPath: upgrade.path,
    upgradeReportSha256: upgrade.sha256,
    targetTarballSha256: pack?.sha256
  }).blockers)

  if (input.requirePhysicalProof !== true) blockers.push('physical_proof_requirement_missing')
  const physical = input.requirePhysicalProof && head
    ? validatePhysicalReleaseGateInspection({
      root: input.root,
      version: input.expectedVersion,
      sourceCommit: head
    })
    : null
  if (physical && !physical.ok) blockers.push(...physical.blockers.map((blocker) => `physical_proof:${blocker}`))

  if (input.requireCleanTree !== true) blockers.push('clean_tree_requirement_missing')
  return {
    schema: MAIN_PUSH_GUARD_SCHEMA,
    ok: blockers.length === 0,
    expected_version: input.expectedVersion,
    expected_origin_main: input.expectedOriginMain,
    expected_origin_identity: input.expectedOriginIdentity,
    actual_origin_identity: origin.identity || null,
    actual_origin_url: origin.url || null,
    actual_origin_main: originMain || null,
    head: head || null,
    release_stamp: input.requireReleaseStamp ? path.join('.sneakoscope', 'reports', 'release-check-stamp.json') : null,
    pack_proof: input.requirePackProof ? path.relative(input.root, path.join(proofDir, 'pack-receipt.json')) : null,
    upgrade_proof: upgrade,
    macos_proof: input.requireMacosProof ? path.relative(input.root, path.join(proofDir, 'macos-menubar-proof.json')) : null,
    physical_proof: physical?.path || null,
    force_push_allowed: false,
    blockers: unique(blockers),
    checked_at: new Date().toISOString()
  }
}

export function validateReleaseUpgradeProof(root: string, version: string, sourceCommit: string, pack: any) {
  const file = path.join(releaseProofDir(root, version), releaseUpgradeProofFilename(version))
  const report = readJson(file)
  const blockers: string[] = []
  const targetReceipt = path.join(releaseProofDir(root, version), 'pack-receipt.json')
  const targetTarball = pack?.tarball_path ? path.resolve(root, pack.tarball_path) : ''
  const expectedReceiptPath = relative(root, targetReceipt)
  const expectedTarballPath = targetTarball ? relative(root, targetTarball) : ''
  const targetReceiptSha256 = fileSha256(targetReceipt)
  if (report?.schema !== RELEASE_UPGRADE_SMOKE_SCHEMA) blockers.push('missing_or_invalid')
  if (report?.ok !== true || !Array.isArray(report?.blockers) || report.blockers.length) blockers.push('not_ok')
  if (report?.platform !== 'darwin' || report?.baseline_version !== RELEASE_UPGRADE_BASELINE_VERSION || report?.target_version !== version) blockers.push('version_or_platform_mismatch')
  if (!validTimestamp(report?.started_at) || !validTimestamp(report?.generated_at)
    || Date.parse(report.generated_at) < Date.parse(report.started_at)) blockers.push('timestamp_invalid')
  if (report?.baseline?.source !== 'registry'
    || report?.baseline?.spec !== `sneakoscope@${RELEASE_UPGRADE_BASELINE_VERSION}`
    || report?.baseline?.pinned_sha256 !== RELEASE_UPGRADE_BASELINE_SHA256
    || report?.baseline?.tarball_sha256 !== RELEASE_UPGRADE_BASELINE_SHA256
    || !validSha512(report?.baseline?.sha512_integrity)
    || !/^[a-f0-9]{40}$/i.test(String(report?.baseline?.registry_shasum || ''))
    || !Array.isArray(report?.baseline?.inspection_warnings)) blockers.push('baseline_binding_mismatch')
  if (report?.source_tree?.ok !== true || report?.source_tree?.head !== sourceCommit
    || !Array.isArray(report?.source_tree?.dirty_entries) || report.source_tree.dirty_entries.length
    || !Array.isArray(report?.source_tree?.blockers) || report.source_tree.blockers.length) blockers.push('source_commit_mismatch')
  if (report?.target?.binding_ok !== true
    || report?.target?.source_commit !== sourceCommit
    || report?.target?.receipt_source_commit !== sourceCommit) blockers.push('target_source_commit_mismatch')
  if (report?.target?.package_version !== version) blockers.push('target_package_version_mismatch')
  if (portableProofPath(report?.root, report?.target?.receipt_path) !== expectedReceiptPath) blockers.push('target_receipt_path_mismatch')
  if (!targetTarball || portableProofPath(report?.root, report?.target?.tarball_path) !== expectedTarballPath) blockers.push('target_tarball_path_mismatch')
  if (!targetReceiptSha256 || report?.target?.receipt_sha256 !== targetReceiptSha256) blockers.push('target_receipt_sha256_mismatch')
  if (report?.target?.tarball_sha256 !== pack?.sha256) blockers.push('target_tarball_sha256_mismatch')
  if (report?.target?.tarball_sha512_integrity !== pack?.sha512_integrity) blockers.push('target_tarball_integrity_mismatch')
  if (report?.target?.npm_pack_proof?.proof_id !== pack?.npm_pack_proof?.proof_id
    || report?.target?.npm_pack_proof?.info_sha256 !== pack?.npm_pack_proof?.info_sha256
    || report?.target?.npm_pack_proof?.file_list_sha256 !== pack?.npm_pack_proof?.file_list_sha256) {
    blockers.push('target_npm_pack_proof_mismatch')
  }
  const stateNames = Object.keys(RELEASE_UPGRADE_STATE_STAGES)
  if (Object.keys(report?.states || {}).length !== stateNames.length || stateNames.some((name) => {
    const state = report?.states?.[name]
    const expected = releaseUpgradeExpectedVersion(name, version)
    return state?.status !== 'passed' || state?.expected_version !== expected || state?.observed_version !== expected
      || !Array.isArray(state?.command_stages)
      || !sameStringArray(state.command_stages, RELEASE_UPGRADE_STATE_STAGES[name as keyof typeof RELEASE_UPGRADE_STATE_STAGES])
      || !Array.isArray(state?.blockers) || state.blockers.length
  })) blockers.push('lifecycle_incomplete')
  validateReleaseUpgradeIsolationAndCommands(report, blockers)
  return {
    ok: blockers.length === 0,
    path: path.relative(root, file),
    sha256: fileSha256(file),
    blockers: unique(blockers)
  }
}

function validateReleaseUpgradeIsolationAndCommands(report: any, blockers: string[]): void {
  const isolation = report?.isolation || {}
  const sandbox = String(isolation.sandbox || '')
  const isolationPaths = {
    home: isolation.home,
    codex_home: isolation.codex_home,
    npm_cache: isolation.npm_cache,
    npm_prefix: isolation.npm_prefix,
    npm_userconfig: isolation.npm_userconfig,
    workspace: isolation.workspace,
    baseline_pack_dir: isolation.baseline_pack_dir,
    command_reports_dir: isolation.command_reports_dir,
    sealed_inputs_dir: isolation.sealed_inputs_dir
  }
  if (!path.isAbsolute(sandbox)) blockers.push('isolation_sandbox_invalid')
  for (const [name, value] of Object.entries(isolationPaths)) {
    if (!path.isAbsolute(String(value || '')) || !lexicalSubpath(String(value || ''), sandbox)) {
      blockers.push(`isolation_path_invalid:${name}`)
    }
  }
  if (isolation.host_home_reused !== false
    || isolation.host_codex_home_reused !== false
    || isolation.host_npm_prefix_reused !== false) blockers.push('host_isolation_reused')
  if (isolation.retained !== false
    || isolation.removed_after_success !== true
    || isolation.cleanup_status !== 'removed'
    || isolation.cleanup_error !== null) blockers.push('sandbox_cleanup_incomplete')

  const launchPolicy = report?.menubar_launch_policy
  if (launchPolicy?.applicable !== true
    || launchPolicy?.launch_skipped !== true
    || launchPolicy?.proof_scope !== 'bundle_install_status_rollback_only'
    || launchPolicy?.separate_real_launch_proof_required !== true) blockers.push('menubar_launch_policy_invalid')

  const safety = report?.install_safety_policy
  if (safety?.host_process_mutation_allowed !== false
    || safety?.host_session_mutation_allowed !== false
    || safety?.postinstall_network_allowed !== false
    || safety?.real_launchctl_allowed !== false
    || !Array.isArray(safety?.postinstall_skip_env)
    || safety.postinstall_skip_env.length === 0
    || !path.isAbsolute(String(safety?.launchctl_stub_path || ''))
    || !lexicalSubpath(String(safety?.launchctl_stub_path || ''), sandbox)
    || !validSha256(safety?.launchctl_stub_sha256)
    || !path.isAbsolute(String(safety?.launchctl_log_path || ''))
    || !lexicalSubpath(String(safety?.launchctl_log_path || ''), sandbox)
    || !Array.isArray(safety?.launchctl_calls)
    || safety.launchctl_calls.some((call: unknown) => !isExpectedReleaseUpgradeLaunchctlCall(call))
    || !Array.isArray(safety?.launchctl_unexpected_calls)
    || safety.launchctl_unexpected_calls.length > 0) blockers.push('install_safety_policy_invalid')

  if (!path.isAbsolute(String(report?.target?.sealed_tarball_path || ''))
    || !lexicalSubpath(String(report?.target?.sealed_tarball_path || ''), String(isolation.sealed_inputs_dir || ''))) {
    blockers.push('target_sealed_tarball_path_invalid')
  }
  if (!path.isAbsolute(String(report?.baseline?.sealed_tarball_path || ''))
    || !lexicalSubpath(String(report?.baseline?.sealed_tarball_path || ''), String(isolation.sealed_inputs_dir || ''))) {
    blockers.push('baseline_sealed_tarball_path_invalid')
  }

  const commands = Array.isArray(report?.commands) ? report.commands : []
  const stages = commands.map((command: any) => String(command?.stage || ''))
  if (!sameStringArray(stages, RELEASE_UPGRADE_COMMAND_STAGES)) blockers.push('command_inventory_incomplete')
  for (const command of commands) validateReleaseUpgradeCommand(report, command, blockers)
}

function validateReleaseUpgradeCommand(report: any, command: any, blockers: string[]): void {
  const stage = String(command?.stage || '')
  const isolation = report?.isolation || {}
  const argv = Array.isArray(command?.argv) ? command.argv.map(String) : []
  const statusMayBeNotRunning = stage.endsWith('_menubar_status') || stage === 'target_menubar_reinstall_status'
  if (!argv.length
    || command?.cwd !== isolation.workspace
    || command?.isolated_home !== isolation.home
    || command?.isolated_codex_home !== isolation.codex_home
    || command?.isolated_npm_cache !== isolation.npm_cache
    || command?.isolated_npm_prefix !== isolation.npm_prefix
    || command?.timed_out !== false
    || (statusMayBeNotRunning ? ![0, 1].includes(command?.exit_code) : command?.exit_code !== 0)
    || !Number.isFinite(command?.duration_ms)
    || command.duration_ms < 0
    || !validSha256(command?.stdout_sha256)
    || !validSha256(command?.stderr_sha256)) {
    blockers.push(`command_receipt_invalid:${stage || 'missing'}`)
    return
  }

  const npmPrefix = String(isolation.npm_prefix || '')
  const sksBinary = path.join(npmPrefix, 'bin', 'sks')
  const packageRoot = path.join(npmPrefix, 'lib', 'node_modules', 'sneakoscope')
  const args = argv.slice(1)
  const exact = (expected: readonly string[]) => sameStringArray(args, expected)
  let commandOk = true
  if (stage === 'baseline_fetch') {
    commandOk = /^(?:npm|npm\.cmd)$/.test(path.basename(argv[0] || '')) && exact([
      'pack',
      `sneakoscope@${RELEASE_UPGRADE_BASELINE_VERSION}`,
      '--ignore-scripts',
      '--json',
      '--pack-destination',
      String(isolation.baseline_pack_dir || '')
    ])
  } else if (['baseline_install', 'target_install', 'package_rollback_install'].includes(stage)) {
    const tarball = stage === 'target_install'
      ? String(report?.target?.sealed_tarball_path || '')
      : String(report?.baseline?.sealed_tarball_path || '')
    commandOk = /^(?:npm|npm\.cmd)$/.test(path.basename(argv[0] || '')) && exact([
      'install',
      '--global',
      '--prefix',
      npmPrefix,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      tarball
    ])
  } else if (stage.endsWith('_version')) {
    commandOk = argv[0] === sksBinary && exact(['--version'])
  } else if (stage === 'baseline_bootstrap') {
    commandOk = argv[0] === sksBinary && exact(['bootstrap', '--json'])
  } else if (stage.endsWith('_doctor')) {
    const reportFile = path.join(String(isolation.command_reports_dir || ''), `${stage}.json`)
    commandOk = argv[0] === sksBinary && exact(['doctor', '--json', '--report-file', reportFile])
    validateDoctorCommandReceipt(command, stage, reportFile, isolation, String(report?.target_version || ''), blockers)
  } else if (stage.endsWith('_menubar_install') || stage === 'target_menubar_reinstall_install') {
    commandOk = argv[0] === sksBinary && exact([
      'menubar', 'install', '--no-launch', '--json', '--home', String(isolation.home || ''), '--root', packageRoot
    ])
  } else if (stage.endsWith('_menubar_status') || stage === 'target_menubar_reinstall_status') {
    commandOk = argv[0] === sksBinary && exact([
      'menubar', 'status', '--json', '--home', String(isolation.home || ''), '--root', packageRoot
    ])
  } else if (stage === 'target_menubar_rollback') {
    commandOk = argv[0] === sksBinary && exact([
      'menubar', 'rollback', '--no-launch', '--json', '--home', String(isolation.home || ''), '--root', packageRoot
    ])
  } else {
    commandOk = false
  }
  if (!commandOk) blockers.push(`command_argv_invalid:${stage || 'missing'}`)
}

function validateDoctorCommandReceipt(
  command: any,
  stage: string,
  reportFile: string,
  isolation: any,
  targetVersion: string,
  blockers: string[]
): void {
  const binding = command?.report_file
  const requiredVersion = stage === 'target_doctor' ? targetVersion : RELEASE_UPGRADE_BASELINE_VERSION
  if (!binding
    || binding.path !== reportFile
    || binding.expected_package_version !== requiredVersion
    || command?.json_schema !== 'sks.doctor-status.v3'
    || command?.json_ok !== true) {
    blockers.push(`doctor_command_receipt_invalid:${stage}`)
    return
  }
  if (binding.validation_mode === 'strict_report_file') {
    if (binding.inside_sandbox !== true
      || binding.regular_file !== true
      || binding.symlink_refused !== false
      || !validSha256(binding.sha256)
      || !validSha256(binding.json_sha256)
      || !validSha256(binding.stdout_json_sha256)
      || binding.matches_stdout !== true
      || binding.schema !== 'sks.doctor-status.v3'
      || binding.ok !== true
      // The doctor resolves its root through realpath, the isolation record
      // keeps the path it created; on macOS those are the same directory spelled
      // two ways, and a string compare rejected every proof this smoke produces.
      || !sameFilesystemPathSync(binding.root, isolation.workspace)) blockers.push(`doctor_report_binding_invalid:${stage}`)
  } else if (stage !== 'target_doctor' && binding.validation_mode === 'pinned_baseline_stdout_only') {
    if (binding.regular_file !== false
      || binding.symlink_refused !== false
      || binding.matches_stdout !== false
      || !validSha256(binding.stdout_json_sha256)) blockers.push(`doctor_report_binding_invalid:${stage}`)
  } else {
    blockers.push(`doctor_report_binding_invalid:${stage}`)
  }
}

function portableProofPath(reportRootValue: unknown, fileValue: unknown): string | null {
  const reportRoot = String(reportRootValue || '')
  const file = String(fileValue || '')
  if (!path.isAbsolute(reportRoot) || !file) return null
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(reportRoot, file)
  const normalized = path.relative(path.resolve(reportRoot), absolute).split(path.sep).join('/')
  if (!normalized || normalized.startsWith('../') || path.isAbsolute(normalized)) return null
  return normalized
}

function lexicalSubpath(candidateValue: string, rootValue: string): boolean {
  if (!path.isAbsolute(candidateValue) || !path.isAbsolute(rootValue)) return false
  const relativePath = path.relative(path.resolve(rootValue), path.resolve(candidateValue))
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
}

function validSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(String(value || ''))
}

function validSha512(value: unknown): boolean {
  return /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(value || ''))
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function sameStringArray(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => String(value) === String(right[index]))
}
