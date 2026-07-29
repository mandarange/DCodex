import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  MACOS_INSTALL_REQUIRED_CHECKS,
  MACOS_MENUBAR_PROOF_SCHEMA,
  validateMacosInstallReportOutcome,
  validateMacosMenubarProof,
  validateMacosMenubarProofArtifacts
} from '../macos-menubar-proof.js'

const completeProof = {
  schema: MACOS_MENUBAR_PROOF_SCHEMA,
  ok: true,
  version: '8.0.0',
  source_commit: 'a'.repeat(40),
  runner_os: 'macOS',
  swift_version: 'Swift 6',
  xcode_version: 'Xcode 17',
  app_path: '/tmp/SKS.app',
  install_report_path: '.sneakoscope/reports/menubar-install.json',
  install_report_sha256: 'b'.repeat(64),
  upgrade_report_path: '.sneakoscope/reports/release/8.0.0/upgrade-7.6-to-8.0.0.json',
  upgrade_report_sha256: 'e'.repeat(64),
  upgrade_report: {
    schema: 'sks.release-upgrade-smoke.v2',
    baseline_version: '7.6.0',
    target_version: '8.0.0',
    source_commit: 'a'.repeat(40),
    target_tarball_sha256: 'f'.repeat(64),
    target_receipt_sha256: '1'.repeat(64),
    target_tarball_sha512_integrity: 'sha512-Zml4dHVyZS10YXJiYWxs',
    target_package_version: '8.0.0'
  },
  install_report: {
    schema: 'sks.sks-menubar-install-check.v2',
    checks: Object.fromEntries(MACOS_INSTALL_REQUIRED_CHECKS.map((key) => [key, true])),
    failed_checks: [],
    resources_sha256: 'c'.repeat(64),
    source_sha256: 'd'.repeat(64),
    build_stamp_schema: 'sks.sks-menubar-build-stamp.v2',
    build_stamp_package_version: '8.0.0',
    build_stamp_resources_sha256: 'c'.repeat(64),
    build_stamp_source_sha256: 'd'.repeat(64)
  },
  checks: {
    swift_parse: true,
    swift_compile: true,
    appkit_link: true,
    source_inventory: true,
    resources: true,
    plist_icon: true,
    app_icon_load: true,
    codesign: true,
    codesign_identifier: true,
    install_idempotence: true,
    previous_app_rollback: true,
    resource_hash: true,
    source_hash: true,
    build_stamp_binding: true,
    notification_actions: true,
    accessibility: true,
    reduced_motion: true,
    action_script: true,
    launch_agent: true
  },
  generated_at: new Date().toISOString(),
  blockers: []
}

test('macOS Menu Bar proof is source- and version-bound', () => {
  assert.equal(validateMacosMenubarProof(completeProof, { version: '8.0.0', sourceCommit: 'a'.repeat(40) }).ok, true)
  const missingRollback = structuredClone(completeProof)
  missingRollback.checks.previous_app_rollback = false
  const invalid = validateMacosMenubarProof(missingRollback, { version: '8.0.0', sourceCommit: 'a'.repeat(40) })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.blockers.includes('macos_check_failed:previous_app_rollback'), true)

  const tampered: any = structuredClone(completeProof)
  tampered.generated_at = 'not-a-date'
  tampered.blockers = ['tampered']
  tampered.install_report.checks = { install_ok: true }
  const rejected = validateMacosMenubarProof(tampered, { version: '8.0.0', sourceCommit: 'a'.repeat(40) })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.blockers.includes('macos_proof_generated_at_invalid'), true)
  assert.equal(rejected.blockers.includes('macos_proof_blockers_present'), true)
  assert.equal(rejected.blockers.includes('install_report_check_failed:swift_compile'), true)

  const wrongUpgradeVersion: any = structuredClone(completeProof)
  wrongUpgradeVersion.upgrade_report.target_version = '8.0.1'
  assert.equal(validateMacosMenubarProof(wrongUpgradeVersion).blockers.includes('upgrade_report_target_version_mismatch'), true)

  const wrongUpgradeSource: any = structuredClone(completeProof)
  wrongUpgradeSource.upgrade_report.source_commit = '9'.repeat(40)
  assert.equal(validateMacosMenubarProof(wrongUpgradeSource).blockers.includes('upgrade_report_source_commit_mismatch'), true)

  const wrongUpgradeTarball = validateMacosMenubarProof(completeProof, { targetTarballSha256: '0'.repeat(64) })
  assert.equal(wrongUpgradeTarball.blockers.includes('macos_upgrade_target_tarball_mismatch'), true)
})

test('macOS proof rejects a raw install artifact that reports failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-macos-proof-artifact-'))
  try {
    const proof: any = structuredClone(completeProof)
    const file = path.join(root, '.sneakoscope', 'reports', 'menubar-install.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const report = {
      schema: proof.install_report.schema,
      ok: false,
      checks: proof.install_report.checks,
      failed_checks: ['install_ok'],
      blockers: ['failed'],
      resources_sha256: proof.install_report.resources_sha256,
      source_sha256: proof.install_report.source_sha256,
      result: { build_stamp: {
        schema: proof.install_report.build_stamp_schema,
        package_version: proof.install_report.build_stamp_package_version,
        resources_sha256: proof.install_report.build_stamp_resources_sha256,
        source_sha256: proof.install_report.build_stamp_source_sha256
      } }
    }
    const bytes = Buffer.from(`${JSON.stringify(report)}\n`)
    fs.writeFileSync(file, bytes)
    proof.install_report_sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
    writeUpgradeArtifact(root, proof)
    const result = validateMacosMenubarProofArtifacts(root, proof, { version: '8.0.0', sourceCommit: 'a'.repeat(40) })
    assert.equal(result.ok, false)
    assert.equal(result.blockers.includes('install_report_artifact_not_ok'), true)
    assert.equal(result.blockers.includes('install_report_artifact_failed_checks_present'), true)
    assert.equal(result.blockers.includes('install_report_artifact_blockers_present'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('macOS proof rehashes and binds the exact upgrade report', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-macos-upgrade-proof-'))
  try {
    const proof: any = structuredClone(completeProof)
    writeInstallArtifact(root, proof)
    const upgradeFile = writeUpgradeArtifact(root, proof)
    const expected = {
      version: '8.0.0',
      sourceCommit: 'a'.repeat(40),
      upgradeReportPath: proof.upgrade_report_path,
      upgradeReportSha256: proof.upgrade_report_sha256,
      targetTarballSha256: proof.upgrade_report.target_tarball_sha256
    }
    assert.equal(validateMacosMenubarProofArtifacts(root, proof, expected).ok, true)

    const tampered = JSON.parse(fs.readFileSync(upgradeFile, 'utf8'))
    tampered.target.receipt_sha256 = '9'.repeat(64)
    fs.writeFileSync(upgradeFile, `${JSON.stringify(tampered)}\n`)
    const rejected = validateMacosMenubarProofArtifacts(root, proof, expected)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.blockers.includes('upgrade_report_artifact_hash_mismatch'), true)
    assert.equal(rejected.blockers.includes('upgrade_report_artifact_target_binding_mismatch'), true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('macOS proof generation rejects non-empty raw failed_checks even when ok is true', () => {
  const result = validateMacosInstallReportOutcome({ ok: true, failed_checks: ['swift_compile'], blockers: [] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, ['failed_checks_present'])
})

test('macOS proof generation rejects non-empty raw blockers even when ok is true', () => {
  const result = validateMacosInstallReportOutcome({ ok: true, failed_checks: [], blockers: ['resource_hash_mismatch'] })
  assert.equal(result.ok, false)
  assert.deepEqual(result.blockers, ['blockers_present'])
})

function writeInstallArtifact(root: string, proof: any): string {
  const file = path.join(root, proof.install_report_path)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const report = {
    schema: proof.install_report.schema,
    ok: true,
    checks: proof.install_report.checks,
    failed_checks: [],
    blockers: [],
    resources_sha256: proof.install_report.resources_sha256,
    source_sha256: proof.install_report.source_sha256,
    result: {
      build_stamp: {
        schema: proof.install_report.build_stamp_schema,
        package_version: proof.install_report.build_stamp_package_version,
        resources_sha256: proof.install_report.build_stamp_resources_sha256,
        source_sha256: proof.install_report.build_stamp_source_sha256
      }
    }
  }
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`)
  fs.writeFileSync(file, bytes)
  proof.install_report_sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return file
}

function writeUpgradeArtifact(root: string, proof: any): string {
  const file = path.join(root, proof.upgrade_report_path)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const report = {
    schema: proof.upgrade_report.schema,
    ok: true,
    platform: 'darwin',
    baseline_version: proof.upgrade_report.baseline_version,
    target_version: proof.upgrade_report.target_version,
    source_tree: { head: proof.upgrade_report.source_commit },
    target: {
      tarball_sha256: proof.upgrade_report.target_tarball_sha256,
      receipt_sha256: proof.upgrade_report.target_receipt_sha256,
      tarball_sha512_integrity: proof.upgrade_report.target_tarball_sha512_integrity,
      package_version: proof.upgrade_report.target_package_version
    },
    blockers: []
  }
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`)
  fs.writeFileSync(file, bytes)
  proof.upgrade_report_sha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  return file
}
