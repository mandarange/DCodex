import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { releaseProofDir, writeReleaseJson } from './release-pack-receipt.js'
import { RELEASE_UPGRADE_BASELINE_VERSION } from './release-upgrade-baseline.js'

export const MACOS_MENUBAR_PROOF_SCHEMA = 'sks.macos-menubar-proof.v2'
export const MACOS_MENUBAR_REQUIRED_CHECKS = Object.freeze([
  'swift_parse',
  'swift_compile',
  'appkit_link',
  'source_inventory',
  'resources',
  'plist_icon',
  'app_icon_load',
  'codesign',
  'codesign_identifier',
  'install_idempotence',
  'previous_app_rollback',
  'resource_hash',
  'source_hash',
  'build_stamp_binding',
  'notification_actions',
  'accessibility',
  'reduced_motion',
  'action_script',
  'launch_agent'
] as const)

export type MacosMenubarCheck = typeof MACOS_MENUBAR_REQUIRED_CHECKS[number]
export const MACOS_INSTALL_REQUIRED_CHECKS = Object.freeze([
  'install_ok',
  'app_bundle_exists',
  'swift_compile',
  'swift_parse',
  'source_inventory',
  'resources_inventory',
  'expected_resources_present',
  'info_plist_icon_verified',
  'app_icon_load_smoke',
  'codesign_strict_verified',
  'codesign_identifier_verified',
  'action_script_executable',
  'launch_agent_safe',
  'notification_action_test',
  'accessibility_smoke',
  'reduced_motion_smoke',
  'build_stamp_version_source_binding',
  'is_idempotent',
  'previous_app_rollback_verified'
] as const)

export interface MacosMenubarProof {
  schema: typeof MACOS_MENUBAR_PROOF_SCHEMA
  ok: boolean
  version: string
  source_commit: string
  runner_os: 'macOS'
  swift_version: string
  xcode_version: string
  app_path: string
  install_report_path: string
  install_report_sha256: string
  upgrade_report_path: string
  upgrade_report_sha256: string
  upgrade_report: {
    schema: string
    baseline_version: string
    target_version: string
    source_commit: string
    target_tarball_sha256: string
    target_receipt_sha256: string
    target_tarball_sha512_integrity: string
    target_package_version: string
  }
  install_report: {
    schema: string
    checks: Record<string, boolean>
    failed_checks: string[]
    resources_sha256: string
    source_sha256: string
    build_stamp_schema: string
    build_stamp_package_version: string
    build_stamp_resources_sha256: string
    build_stamp_source_sha256: string
  }
  checks: Record<MacosMenubarCheck, boolean>
  generated_at: string
  blockers: string[]
}

export function validateMacosInstallReportOutcome(value: unknown) {
  const report = value as Record<string, unknown> | null
  const blockers: string[] = []
  if (report?.ok !== true) blockers.push('not_ok')
  if (!Array.isArray(report?.failed_checks) || report.failed_checks.length > 0) blockers.push('failed_checks_present')
  if (!Array.isArray(report?.blockers) || report.blockers.length > 0) blockers.push('blockers_present')
  return { ok: blockers.length === 0, blockers }
}

export function validateMacosMenubarProof(value: unknown, expected: {
  version?: string
  sourceCommit?: string
  upgradeReportPath?: string
  upgradeReportSha256?: string | null
  targetTarballSha256?: string
} = {}) {
  const proof = value as Partial<MacosMenubarProof> | null
  const blockers: string[] = []
  if (!proof || proof.schema !== MACOS_MENUBAR_PROOF_SCHEMA) blockers.push('macos_proof_schema_invalid')
  if (proof?.ok !== true) blockers.push('macos_proof_not_ok')
  if (proof?.runner_os !== 'macOS') blockers.push('macos_runner_identity_invalid')
  if (!proof?.swift_version) blockers.push('swift_version_missing')
  if (!proof?.xcode_version) blockers.push('xcode_version_missing')
  if (!proof?.app_path) blockers.push('app_path_missing')
  if (!proof?.install_report_path || path.isAbsolute(proof.install_report_path) || !proof.install_report_path.startsWith('.sneakoscope/reports/')) blockers.push('install_report_path_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(proof?.install_report_sha256 || ''))) blockers.push('install_report_hash_missing')
  if (!proof?.upgrade_report_path || path.isAbsolute(proof.upgrade_report_path) || !proof.upgrade_report_path.startsWith('.sneakoscope/reports/release/')) blockers.push('upgrade_report_path_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(proof?.upgrade_report_sha256 || ''))) blockers.push('upgrade_report_hash_missing')
  if (proof?.upgrade_report?.schema !== 'sks.release-upgrade-smoke.v2') blockers.push('upgrade_report_schema_invalid')
  if (proof?.upgrade_report?.baseline_version !== RELEASE_UPGRADE_BASELINE_VERSION) blockers.push('upgrade_report_baseline_version_invalid')
  if (proof?.upgrade_report?.target_version !== proof?.version
    || proof?.upgrade_report?.target_package_version !== proof?.version) blockers.push('upgrade_report_target_version_mismatch')
  if (proof?.upgrade_report?.source_commit !== proof?.source_commit) blockers.push('upgrade_report_source_commit_mismatch')
  if (!/^[a-f0-9]{64}$/i.test(String(proof?.upgrade_report?.target_tarball_sha256 || ''))) blockers.push('upgrade_report_target_tarball_sha256_invalid')
  if (!/^[a-f0-9]{64}$/i.test(String(proof?.upgrade_report?.target_receipt_sha256 || ''))) blockers.push('upgrade_report_target_receipt_sha256_invalid')
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(proof?.upgrade_report?.target_tarball_sha512_integrity || ''))) blockers.push('upgrade_report_target_integrity_invalid')
  if (proof?.install_report?.schema !== 'sks.sks-menubar-install-check.v2') blockers.push('install_report_schema_invalid')
  if (!proof?.install_report?.checks || Object.keys(proof.install_report.checks).length === 0) blockers.push('install_report_checks_missing')
  else {
    for (const key of MACOS_INSTALL_REQUIRED_CHECKS) if (proof.install_report.checks[key] !== true) blockers.push(`install_report_check_failed:${key}`)
    for (const [key, ok] of Object.entries(proof.install_report.checks)) if (ok !== true) blockers.push(`install_report_check_failed:${key}`)
  }
  if (!Array.isArray(proof?.install_report?.failed_checks) || proof.install_report.failed_checks.length > 0) blockers.push('install_report_failed_checks_present')
  for (const key of ['resources_sha256', 'source_sha256', 'build_stamp_resources_sha256', 'build_stamp_source_sha256'] as const) {
    if (!/^[a-f0-9]{64}$/i.test(String(proof?.install_report?.[key] || ''))) blockers.push(`install_report_hash_invalid:${key}`)
  }
  if (proof?.install_report?.build_stamp_schema !== 'sks.sks-menubar-build-stamp.v2') blockers.push('install_report_build_stamp_schema_invalid')
  if (expected.version && proof?.install_report?.build_stamp_package_version !== expected.version) blockers.push('install_report_build_stamp_version_mismatch')
  if (proof?.install_report?.resources_sha256 !== proof?.install_report?.build_stamp_resources_sha256) blockers.push('install_report_resource_hash_binding_mismatch')
  if (proof?.install_report?.source_sha256 !== proof?.install_report?.build_stamp_source_sha256) blockers.push('install_report_source_hash_binding_mismatch')
  if (expected.version && proof?.version !== expected.version) blockers.push('macos_proof_version_mismatch')
  if (expected.sourceCommit && proof?.source_commit !== expected.sourceCommit) blockers.push('macos_proof_source_commit_mismatch')
  if (expected.upgradeReportPath && proof?.upgrade_report_path !== expected.upgradeReportPath) blockers.push('macos_upgrade_report_path_mismatch')
  if (expected.upgradeReportSha256 && proof?.upgrade_report_sha256 !== expected.upgradeReportSha256) blockers.push('macos_upgrade_report_hash_mismatch')
  if (expected.targetTarballSha256 && proof?.upgrade_report?.target_tarball_sha256 !== expected.targetTarballSha256) blockers.push('macos_upgrade_target_tarball_mismatch')
  for (const key of MACOS_MENUBAR_REQUIRED_CHECKS) {
    if (proof?.checks?.[key] !== true) blockers.push(`macos_check_failed:${key}`)
  }
  if (!proof?.generated_at || Number.isNaN(Date.parse(String(proof.generated_at)))) blockers.push('macos_proof_generated_at_invalid')
  if (!Array.isArray(proof?.blockers) || proof.blockers.length > 0) blockers.push('macos_proof_blockers_present')
  return { ok: blockers.length === 0, proof: proof || null, blockers }
}

export function validateMacosMenubarProofArtifacts(root: string, value: unknown, expected: {
  version?: string
  sourceCommit?: string
  upgradeReportPath?: string
  upgradeReportSha256?: string | null
  targetTarballSha256?: string
} = {}) {
  const validation = validateMacosMenubarProof(value, expected)
  const proof = validation.proof
  const blockers = [...validation.blockers]
  const file = proof?.install_report_path ? path.resolve(root, proof.install_report_path) : ''
  const reportRoot = path.resolve(root, '.sneakoscope', 'reports')
  const relative = file ? path.relative(reportRoot, file) : '..'
  if (!file || relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file)) blockers.push('install_report_artifact_missing_or_unsafe')
  else {
    const bytes = fs.readFileSync(file)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== proof?.install_report_sha256) blockers.push('install_report_artifact_hash_mismatch')
    try {
      const report = JSON.parse(bytes.toString('utf8'))
      if (report?.schema !== proof?.install_report?.schema) blockers.push('install_report_artifact_schema_mismatch')
      blockers.push(...validateMacosInstallReportOutcome(report).blockers.map((blocker) => `install_report_artifact_${blocker}`))
      if (JSON.stringify(report?.checks || {}) !== JSON.stringify(proof?.install_report?.checks || {})) blockers.push('install_report_artifact_checks_mismatch')
      if (String(report?.resources_sha256 || '') !== proof?.install_report?.resources_sha256) blockers.push('install_report_artifact_resource_hash_mismatch')
      if (String(report?.source_sha256 || '') !== proof?.install_report?.source_sha256) blockers.push('install_report_artifact_source_hash_mismatch')
      const stamp = report?.result?.build_stamp || report?.build_stamp || {}
      if (String(stamp?.schema || '') !== proof?.install_report?.build_stamp_schema
        || String(stamp?.package_version || '') !== proof?.install_report?.build_stamp_package_version
        || String(stamp?.resources_sha256 || '') !== proof?.install_report?.build_stamp_resources_sha256
        || String(stamp?.source_sha256 || '') !== proof?.install_report?.build_stamp_source_sha256) blockers.push('install_report_artifact_build_stamp_mismatch')
    } catch {
      blockers.push('install_report_artifact_json_invalid')
    }
  }
  const upgradeFile = proof?.upgrade_report_path ? path.resolve(root, proof.upgrade_report_path) : ''
  const upgradeRelative = upgradeFile ? path.relative(reportRoot, upgradeFile) : '..'
  if (!upgradeFile || upgradeRelative.startsWith('..') || path.isAbsolute(upgradeRelative) || !fs.existsSync(upgradeFile)) {
    blockers.push('upgrade_report_artifact_missing_or_unsafe')
  } else {
    const bytes = fs.readFileSync(upgradeFile)
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== proof?.upgrade_report_sha256) blockers.push('upgrade_report_artifact_hash_mismatch')
    try {
      const report = JSON.parse(bytes.toString('utf8'))
      if (report?.schema !== proof?.upgrade_report?.schema) blockers.push('upgrade_report_artifact_schema_mismatch')
      if (report?.ok !== true || !Array.isArray(report?.blockers) || report.blockers.length > 0) blockers.push('upgrade_report_artifact_not_ok')
      if (report?.platform !== 'darwin'
        || report?.baseline_version !== proof?.upgrade_report?.baseline_version
        || report?.target_version !== proof?.upgrade_report?.target_version) blockers.push('upgrade_report_artifact_version_mismatch')
      if (report?.source_tree?.head !== proof?.upgrade_report?.source_commit) blockers.push('upgrade_report_artifact_source_commit_mismatch')
      if (report?.target?.tarball_sha256 !== proof?.upgrade_report?.target_tarball_sha256
        || report?.target?.receipt_sha256 !== proof?.upgrade_report?.target_receipt_sha256
        || report?.target?.tarball_sha512_integrity !== proof?.upgrade_report?.target_tarball_sha512_integrity
        || report?.target?.package_version !== proof?.upgrade_report?.target_package_version) {
        blockers.push('upgrade_report_artifact_target_binding_mismatch')
      }
    } catch {
      blockers.push('upgrade_report_artifact_json_invalid')
    }
  }
  return { ok: blockers.length === 0, proof, blockers: [...new Set(blockers)] }
}

export function writeMacosMenubarProof(root: string, proof: MacosMenubarProof): string {
  const file = path.join(releaseProofDir(root, proof.version), 'macos-menubar-proof.json')
  writeReleaseJson(file, proof)
  return file
}

export function readMacosMenubarProof(root: string, version: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(path.join(releaseProofDir(root, version), 'macos-menubar-proof.json'), 'utf8'))
  } catch {
    return null
  }
}
