#!/usr/bin/env node
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  MACOS_MENUBAR_PROOF_SCHEMA,
  validateMacosInstallReportOutcome,
  writeMacosMenubarProof,
  type MacosMenubarProof
} from '../core/release/macos-menubar-proof.js'
import { RELEASE_UPGRADE_BASELINE_VERSION } from '../core/release/release-upgrade-baseline.js'
import { NATIVE_SOURCE_FILES } from '../core/codex-app/menubar/constants.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const installReportFile = path.resolve(root, required('--install-report'))
const installReportBytes = fs.readFileSync(installReportFile)
const installReport = JSON.parse(installReportBytes.toString('utf8'))
const upgradeReportFile = path.resolve(root, required('--upgrade-report'))
const upgradeReportBytes = fs.readFileSync(upgradeReportFile)
const upgradeReport = JSON.parse(upgradeReportBytes.toString('utf8'))
const sourceCommit = gitHead()
const appPath = String(installReport?.result?.app_path || installReport?.app_path || '')
const resources = path.join(appPath, 'Contents', 'Resources')
const plist = path.join(appPath, 'Contents', 'Info.plist')
const executable = String(installReport?.result?.executable_path || '')
const installChecks = booleanRecord(installReport?.checks)
const buildStamp = installReport?.result?.build_stamp || installReport?.build_stamp || {}
const sourceRoot = firstExisting([
  path.join(path.dirname(appPath), 'Sources'),
  path.join(root, 'dist', 'native', 'sks-menubar', 'Sources'),
  path.join(root, 'native', 'sks-menubar', 'Sources')
])
const swiftFiles = sourceRoot ? fs.readdirSync(sourceRoot).filter((name) => name.endsWith('.swift')).map((name) => path.join(sourceRoot, name)) : []
const swiftParse = process.platform === 'darwin' && swiftFiles.length > 0
  ? run('swiftc', ['-parse', ...swiftFiles]).status === 0
  : false
const resourceNames = [
  'AppIcon.icns',
  'SKSStatusTemplate.pdf',
  'SKSStatusUpdateTemplate.pdf',
  'SKSStatusWarningTemplate.pdf',
  'SKSStatusAttentionTemplate.pdf',
  'Localizable.strings'
]
const installedResourceNames = fs.existsSync(resources) ? fs.readdirSync(resources).sort() : []
const resourcesOk = Boolean(appPath)
  && JSON.stringify(installedResourceNames) === JSON.stringify([...resourceNames].sort())
const plistIcon = process.platform === 'darwin' && fs.existsSync(plist)
  ? String(run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', plist]).stdout || '').trim() === 'AppIcon'
  : false
const codesign = process.platform === 'darwin' && Boolean(appPath)
  ? run('codesign', ['--verify', '--deep', '--strict', appPath]).status === 0
  : false
const codesignDetail = process.platform === 'darwin' && Boolean(appPath) ? run('codesign', ['-dv', '--verbose=4', appPath]) : null
const codesignText = `${codesignDetail?.stdout || ''}\n${codesignDetail?.stderr || ''}`
const codesignIdentifier = codesignDetail?.status === 0 && /\bIdentifier=com\.sneakoscope\.sks-menubar\b/.test(codesignText)
const resourceHashes = hashFiles(resources, resourceNames)
const sourceNames = Object.keys(installReport?.source_files_sha256 || {}).sort()
const sourceHashes = hashFiles(sourceRoot, sourceNames)
const resourceAggregate = aggregateFileHashes(resourceHashes)
const sourceAggregate = aggregateFileHashes(sourceHashes)
const resourceHash = resourceNames.length > 0
  && recordsEqual(resourceHashes, installReport?.resource_files_sha256)
  && recordsEqual(resourceHashes, buildStamp?.resource_files_sha256)
  && resourceAggregate === installReport?.resources_sha256
  && resourceAggregate === buildStamp?.resources_sha256
const sourceHash = sourceNames.length === NATIVE_SOURCE_FILES.length
  && recordsEqual(sourceHashes, installReport?.source_files_sha256)
  && recordsEqual(sourceHashes, buildStamp?.source_files_sha256)
  && sourceAggregate === installReport?.source_sha256
  && sourceAggregate === buildStamp?.source_sha256
const iconLoad = process.platform === 'darwin' && fs.existsSync(path.join(resources, 'AppIcon.icns'))
  ? run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path.join(resources, 'AppIcon.icns')]).status === 0
  : false
const checks = {
  swift_parse: swiftParse && installChecks.swift_parse === true,
  swift_compile: installChecks.swift_compile === true,
  appkit_link: installChecks.swift_compile === true && fs.existsSync(executable),
  source_inventory: installChecks.source_inventory === true && sourceNames.length === NATIVE_SOURCE_FILES.length,
  resources: resourcesOk && installChecks.resources_inventory === true && installChecks.expected_resources_present === true,
  plist_icon: plistIcon && installChecks.info_plist_icon_verified === true,
  app_icon_load: iconLoad && installChecks.app_icon_load_smoke === true,
  codesign: codesign && installChecks.codesign_strict_verified === true,
  codesign_identifier: codesignIdentifier && installChecks.codesign_identifier_verified === true,
  install_idempotence: installReport?.is_idempotent === true && installChecks.is_idempotent === true,
  previous_app_rollback: installReport?.previous_app_rollback_verified === true && installChecks.previous_app_rollback_verified === true,
  resource_hash: resourceHash,
  source_hash: sourceHash,
  build_stamp_binding: installChecks.build_stamp_version_source_binding === true
    && buildStamp?.schema === 'sks.sks-menubar-build-stamp.v2'
    && buildStamp?.package_version === String(pkg.version || ''),
  notification_actions: installChecks.notification_action_test === true,
  accessibility: installChecks.accessibility_smoke === true,
  reduced_motion: installChecks.reduced_motion_smoke === true,
  action_script: installChecks.action_script_executable === true,
  launch_agent: installChecks.launch_agent_safe === true
}
const blockers = [
  ...(process.platform === 'darwin' ? [] : ['not_macos']),
  ...validateMacosInstallReportOutcome(installReport).blockers.map((blocker) => `menubar_install_report_${blocker}`),
  ...validateUpgradeReport(upgradeReport, String(pkg.version || ''), sourceCommit),
  ...Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => `macos_check_failed:${name}`)
]
const proof: MacosMenubarProof = {
  schema: MACOS_MENUBAR_PROOF_SCHEMA,
  ok: blockers.length === 0,
  version: String(pkg.version || ''),
  source_commit: sourceCommit,
  runner_os: 'macOS',
  swift_version: String(run('swiftc', ['--version']).stdout || '').trim(),
  xcode_version: String(run('xcodebuild', ['-version']).stdout || '').trim(),
  app_path: appPath,
  install_report_path: path.relative(root, installReportFile).split(path.sep).join('/'),
  install_report_sha256: crypto.createHash('sha256').update(installReportBytes).digest('hex'),
  upgrade_report_path: path.relative(root, upgradeReportFile).split(path.sep).join('/'),
  upgrade_report_sha256: crypto.createHash('sha256').update(upgradeReportBytes).digest('hex'),
  upgrade_report: {
    schema: String(upgradeReport?.schema || ''),
    baseline_version: String(upgradeReport?.baseline_version || ''),
    target_version: String(upgradeReport?.target_version || ''),
    source_commit: String(upgradeReport?.source_tree?.head || ''),
    target_tarball_sha256: String(upgradeReport?.target?.tarball_sha256 || ''),
    target_receipt_sha256: String(upgradeReport?.target?.receipt_sha256 || ''),
    target_tarball_sha512_integrity: String(upgradeReport?.target?.tarball_sha512_integrity || ''),
    target_package_version: String(upgradeReport?.target?.package_version || '')
  },
  install_report: {
    schema: String(installReport?.schema || ''),
    checks: installChecks,
    failed_checks: Array.isArray(installReport?.failed_checks) ? installReport.failed_checks.map(String) : [],
    resources_sha256: String(installReport?.resources_sha256 || ''),
    source_sha256: String(installReport?.source_sha256 || ''),
    build_stamp_schema: String(buildStamp?.schema || ''),
    build_stamp_package_version: String(buildStamp?.package_version || ''),
    build_stamp_resources_sha256: String(buildStamp?.resources_sha256 || ''),
    build_stamp_source_sha256: String(buildStamp?.source_sha256 || '')
  },
  checks,
  generated_at: new Date().toISOString(),
  blockers
}
const file = writeMacosMenubarProof(root, proof)
console.log(JSON.stringify({ ...proof, proof_path: path.relative(root, file).split(path.sep).join('/') }, null, 2))
if (!proof.ok) process.exitCode = 1

function run(command: string, args: string[]) {
  return spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function firstExisting(candidates: string[]): string {
  return candidates.find((candidate) => fs.existsSync(candidate)) || ''
}

function booleanRecord(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, item === true]))
}

function hashFiles(directory: string, names: string[]): Record<string, string> {
  if (!directory || !fs.existsSync(directory)) return {}
  const output: Record<string, string> = {}
  for (const name of names) {
    const file = path.join(directory, name)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    output[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  }
  return output
}

function aggregateFileHashes(hashes: Record<string, string>): string {
  const value = Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)).map(([name, digest]) => `${name}:${digest}`).join('\n')
  return crypto.createHash('sha256').update(value).digest('hex')
}

function recordsEqual(left: Record<string, string>, right: unknown): boolean {
  if (!right || typeof right !== 'object' || Array.isArray(right)) return false
  return JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right as Record<string, string>).sort())
}

function gitHead(): string {
  return String(run('git', ['rev-parse', 'HEAD']).stdout || '').trim()
}

function validateUpgradeReport(report: any, version: string, sourceCommit: string): string[] {
  const relative = path.relative(path.join(root, '.sneakoscope', 'reports'), upgradeReportFile)
  const safePath = relative && !relative.startsWith('..') && !path.isAbsolute(relative)
  const blockers = [
    ...(safePath ? [] : ['upgrade_report_path_unsafe']),
    ...(report?.schema === 'sks.release-upgrade-smoke.v2' ? [] : ['upgrade_report_schema_invalid']),
    ...(report?.ok === true && Array.isArray(report?.blockers) && report.blockers.length === 0 ? [] : ['upgrade_report_not_ok']),
    ...(report?.platform === 'darwin' ? [] : ['upgrade_report_platform_invalid']),
    ...(report?.baseline_version === RELEASE_UPGRADE_BASELINE_VERSION ? [] : ['upgrade_report_baseline_version_invalid']),
    ...(report?.target_version === version && report?.target?.package_version === version ? [] : ['upgrade_report_target_version_mismatch']),
    ...(report?.source_tree?.head === sourceCommit ? [] : ['upgrade_report_source_commit_mismatch']),
    ...(/^[a-f0-9]{64}$/i.test(String(report?.target?.tarball_sha256 || '')) ? [] : ['upgrade_report_target_tarball_sha256_invalid']),
    ...(/^[a-f0-9]{64}$/i.test(String(report?.target?.receipt_sha256 || '')) ? [] : ['upgrade_report_target_receipt_sha256_invalid']),
    ...(/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(report?.target?.tarball_sha512_integrity || '')) ? [] : ['upgrade_report_target_integrity_invalid'])
  ]
  return blockers
}

function required(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? String(process.argv[index + 1] || '').trim() : ''
  if (!value) {
    console.error(`Release macOS proof failed: ${name} is required`)
    process.exit(2)
  }
  return value
}
