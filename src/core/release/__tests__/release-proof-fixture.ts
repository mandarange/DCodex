import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { MACOS_INSTALL_REQUIRED_CHECKS, MACOS_MENUBAR_PROOF_SCHEMA, MACOS_MENUBAR_REQUIRED_CHECKS } from '../macos-menubar-proof.js'
import { MAIN_PUSH_GUARD_SCHEMA } from '../main-push-guard.js'
import { writeNpmPackProof } from '../npm-pack-proof.js'
import { inspectReleaseTarball, releaseProofDir } from '../release-pack-receipt.js'
import { writePhysicalReleaseEvidence } from './physical-release-evidence-fixture.js'

export function writeCompleteReleaseProofs(root: string, head: string, baseline = head, originIdentity = '') {
  const reports = path.join(root, '.sneakoscope', 'reports')
  const proofDir = releaseProofDir(root, '8.0.0')
  const summaryPath = path.join(reports, 'release-gates', 'fixture', 'summary.json')
  const realPath = path.join(reports, 'release-real-check.json')
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
  fs.mkdirSync(proofDir, { recursive: true })
  fs.writeFileSync(summaryPath, `${JSON.stringify({ schema: 'sks.release-gate-dag-run.v1', ok: true, run_id: 'fixture' })}\n`)
  fs.writeFileSync(realPath, `${JSON.stringify({ schema: 'sks.release-real-check.v1', ok: true, all_checks: [{ id: 'fixture', ok: true }] })}\n`)
  const packageJson = path.join(root, 'package.json')
  fs.writeFileSync(path.join(reports, 'release-check-stamp.json'), JSON.stringify({
    schema: 'sks.release-check-stamp.v2',
    package_name: 'sneakoscope',
    package_version: '8.0.0',
    package_json_sha256: sha(fs.readFileSync(packageJson)),
    git_commit: head,
    source_digest: 'a'.repeat(64), source_file_count: 1,
    package_files_sha256: 'b'.repeat(64), package_file_count: 1,
    release_gate_sha256: 'c'.repeat(64),
    dist_build_sha256: 'd'.repeat(64), dist_file_count: 1,
    dist_source_digest: 'e'.repeat(64), dist_source_file_count: 1,
    release_check_sha256: 'f'.repeat(64),
    release_gate_contract_schema: 'sks.release-gate-contract.v1',
    release_gate_contract_count: 1,
    release_gate_contract_sha256: '1'.repeat(64),
    release_gate_proof: {
      schema: 'sks.release-check-full-proof.v1', preset: 'release', full: true, run_id: 'fixture',
      summary_path: path.relative(root, summaryPath), summary_sha256: sha(fs.readFileSync(summaryPath)),
      release_preset_gate_ids_sha256: '2'.repeat(64), selected_gates: 1, completed: 1, failed: 0,
      affected_mode: 'full', confidence: 'full-release-proof',
      real_check_path: path.relative(root, realPath), real_check_sha256: sha(fs.readFileSync(realPath)), real_check_count: 1
    },
    generated_at: new Date().toISOString()
  }))
  const verifier = path.join(root, 'dist', 'scripts', 'release-check-stamp.js')
  fs.mkdirSync(path.dirname(verifier), { recursive: true })
  fs.writeFileSync(verifier, 'process.exit(0)\n')

  const artifacts = path.join(proofDir, 'artifacts')
  const packageDir = path.join(proofDir, 'fixture-package', 'package')
  fs.mkdirSync(artifacts, { recursive: true })
  fs.mkdirSync(packageDir, { recursive: true })
  fs.copyFileSync(packageJson, path.join(packageDir, 'package.json'))
  const tarball = path.join(artifacts, 'sneakoscope-8.0.0.tgz')
  const packed = spawnSync('tar', ['-czf', tarball, '-C', path.dirname(packageDir), 'package'], { encoding: 'utf8' })
  if (packed.status !== 0) throw new Error(String(packed.stderr || packed.stdout || 'fixture tar failed'))
  const inspected = inspectReleaseTarball({ tarball, kind: 'local', sourceCommit: head, root })
  if (!inspected.ok) throw new Error(inspected.blockers.join(','))
  const info = {
    id: 'sneakoscope@8.0.0', name: 'sneakoscope', version: '8.0.0', filename: 'sneakoscope-8.0.0.tgz',
    size: inspected.bytes, unpackedSize: inspected.unpacked_bytes, shasum: 'a'.repeat(40), integrity: inspected.sha512_integrity, entryCount: inspected.file_count,
    files: [{ path: 'package.json', size: fs.statSync(packageJson).size, mode: 0o644 }]
  }
  const npmProof = writeNpmPackProof(root, info, 1)
  fs.writeFileSync(path.join(reports, 'packlist-performance.json'), JSON.stringify({
    schema: 'sks.packlist-performance.v1', ok: true, blockers: [], forbidden: [], runtime_required_missing: [],
    pack_proof_id: npmProof.proof_id, pack_info_sha256: npmProof.info_digest, pack_file_list_sha256: npmProof.file_list_digest,
    entryCount: info.entryCount, size: info.size, unpackedSize: info.unpackedSize
  }))
  fs.writeFileSync(path.join(reports, 'package-surface-budget.json'), JSON.stringify({
    schema: 'sks.package-surface-budget.v1', ok: true, blockers: [], forbidden_findings: [],
    pack_proof_id: npmProof.proof_id, pack_info_sha256: npmProof.info_digest, pack_file_list_sha256: npmProof.file_list_digest,
    actual_file_count: info.entryCount, actual_tarball_bytes: info.size
  }))
  const packReceiptPath = path.join(proofDir, 'pack-receipt.json')
  const packReceipt = {
    ...inspected,
    npm_pack_proof: { proof_id: npmProof.proof_id, info_sha256: npmProof.info_digest, file_list_sha256: npmProof.file_list_digest }
  }
  fs.writeFileSync(packReceiptPath, JSON.stringify(packReceipt))
  const upgradeSandbox = path.join(root, '.fixture-upgrade-sandbox')
  const upgradeIsolation = {
    sandbox: upgradeSandbox,
    home: path.join(upgradeSandbox, 'home'),
    codex_home: path.join(upgradeSandbox, 'codex-home'),
    npm_cache: path.join(upgradeSandbox, 'npm-cache'),
    npm_prefix: path.join(upgradeSandbox, 'npm-prefix'),
    npm_userconfig: path.join(upgradeSandbox, 'npmrc'),
    workspace: path.join(upgradeSandbox, 'workspace'),
    baseline_pack_dir: path.join(upgradeSandbox, 'baseline-pack'),
    command_reports_dir: path.join(upgradeSandbox, 'command-reports'),
    sealed_inputs_dir: path.join(upgradeSandbox, 'sealed-inputs'),
    host_home_reused: false,
    host_codex_home_reused: false,
    host_npm_prefix_reused: false,
    retained: false,
    removed_after_success: true,
    cleanup_status: 'removed',
    cleanup_error: null
  }
  const baselineSealedTarball = path.join(upgradeIsolation.sealed_inputs_dir, 'baseline-7.6.0-fixture.tgz')
  const targetSealedTarball = path.join(upgradeIsolation.sealed_inputs_dir, 'target-8.0.0-fixture.tgz')
  const sksBinary = path.join(upgradeIsolation.npm_prefix, 'bin', 'sks')
  const packageRoot = path.join(upgradeIsolation.npm_prefix, 'lib', 'node_modules', 'sneakoscope')
  const upgradeCommands = [
    upgradeCommand(upgradeIsolation, 'baseline_fetch', ['npm', 'pack', 'sneakoscope@7.6.0', '--ignore-scripts', '--json', '--pack-destination', upgradeIsolation.baseline_pack_dir]),
    upgradeCommand(upgradeIsolation, 'baseline_install', ['npm', 'install', '--global', '--prefix', upgradeIsolation.npm_prefix, '--no-audit', '--no-fund', '--loglevel=error', baselineSealedTarball]),
    upgradeCommand(upgradeIsolation, 'baseline_version', [sksBinary, '--version']),
    upgradeCommand(upgradeIsolation, 'baseline_bootstrap', [sksBinary, 'bootstrap', '--json']),
    upgradeDoctorCommand(upgradeIsolation, 'baseline_doctor', sksBinary, '7.6.0', 'pinned_baseline_stdout_only'),
    upgradeCommand(upgradeIsolation, 'baseline_menubar_install', [sksBinary, 'menubar', 'install', '--no-launch', '--json', '--home', upgradeIsolation.home, '--root', packageRoot]),
    upgradeCommand(upgradeIsolation, 'baseline_menubar_status', [sksBinary, 'menubar', 'status', '--json', '--home', upgradeIsolation.home, '--root', packageRoot], 1),
    upgradeCommand(upgradeIsolation, 'target_install', ['npm', 'install', '--global', '--prefix', upgradeIsolation.npm_prefix, '--no-audit', '--no-fund', '--loglevel=error', targetSealedTarball]),
    upgradeCommand(upgradeIsolation, 'target_version', [sksBinary, '--version']),
    upgradeDoctorCommand(upgradeIsolation, 'target_doctor', sksBinary, '8.0.0', 'strict_report_file'),
    upgradeCommand(upgradeIsolation, 'target_menubar_install', [sksBinary, 'menubar', 'install', '--no-launch', '--json', '--home', upgradeIsolation.home, '--root', packageRoot]),
    upgradeCommand(upgradeIsolation, 'target_menubar_status', [sksBinary, 'menubar', 'status', '--json', '--home', upgradeIsolation.home, '--root', packageRoot], 1),
    upgradeCommand(upgradeIsolation, 'target_menubar_rollback', [sksBinary, 'menubar', 'rollback', '--no-launch', '--json', '--home', upgradeIsolation.home, '--root', packageRoot]),
    upgradeCommand(upgradeIsolation, 'target_menubar_reinstall_install', [sksBinary, 'menubar', 'install', '--no-launch', '--json', '--home', upgradeIsolation.home, '--root', packageRoot]),
    upgradeCommand(upgradeIsolation, 'target_menubar_reinstall_status', [sksBinary, 'menubar', 'status', '--json', '--home', upgradeIsolation.home, '--root', packageRoot], 1),
    upgradeCommand(upgradeIsolation, 'package_rollback_install', ['npm', 'install', '--global', '--prefix', upgradeIsolation.npm_prefix, '--no-audit', '--no-fund', '--loglevel=error', baselineSealedTarball]),
    upgradeCommand(upgradeIsolation, 'package_rollback_version', [sksBinary, '--version']),
    upgradeDoctorCommand(upgradeIsolation, 'package_rollback_doctor', sksBinary, '7.6.0', 'pinned_baseline_stdout_only')
  ]
  const upgradePath = path.join(proofDir, 'upgrade-7.6-to-8.0.0.json')
  fs.writeFileSync(upgradePath, JSON.stringify({
    schema: 'sks.release-upgrade-smoke.v2', ok: true,
    started_at: new Date().toISOString(), generated_at: new Date().toISOString(),
    platform: 'darwin', baseline_version: '7.6.0', target_version: '8.0.0', root, blockers: [],
    baseline: {
      source: 'registry',
      spec: 'sneakoscope@7.6.0',
      pinned_sha256: '40a9e89f3a234dfcd32507ab7deeb95044084cae95a9ce46b36be4113d5b2a7c',
      tarball_path: path.join(upgradeIsolation.baseline_pack_dir, 'sneakoscope-7.6.0.tgz'),
      tarball_sha256: '40a9e89f3a234dfcd32507ab7deeb95044084cae95a9ce46b36be4113d5b2a7c',
      sealed_tarball_path: baselineSealedTarball,
      sha512_integrity: 'sha512-Zml4dHVyZS1iYXNlbGluZQ==',
      registry_shasum: 'a'.repeat(40),
      inspection_warnings: []
    },
    source_tree: { ok: true, head, dirty_entries: [], blockers: [] },
    target: {
      binding_ok: true,
      receipt_source_commit: head,
      source_commit: head,
      package_version: '8.0.0',
      receipt_sha256: sha(fs.readFileSync(packReceiptPath)),
      tarball_sha256: inspected.sha256,
      tarball_sha512_integrity: inspected.sha512_integrity,
      receipt_path: path.relative(root, packReceiptPath).split(path.sep).join('/'),
      tarball_path: inspected.tarball_path,
      sealed_tarball_path: targetSealedTarball,
      npm_pack_proof: {
        proof_id: npmProof.proof_id,
        info_sha256: npmProof.info_digest,
        file_list_sha256: npmProof.file_list_digest
      }
    },
    isolation: upgradeIsolation,
    menubar_launch_policy: {
      applicable: true,
      launch_skipped: true,
      proof_scope: 'bundle_install_status_rollback_only',
      separate_real_launch_proof_required: true
    },
    install_safety_policy: {
      host_process_mutation_allowed: false,
      host_session_mutation_allowed: false,
      postinstall_network_allowed: false,
      postinstall_skip_env: ['SKS_DISABLE_NETWORK'],
      launchctl_stub_path: path.join(upgradeSandbox, 'bin', 'launchctl'),
      launchctl_stub_sha256: 'e'.repeat(64),
      launchctl_log_path: path.join(upgradeSandbox, 'launchctl-calls.log'),
      launchctl_calls: [],
      launchctl_unexpected_calls: [],
      real_launchctl_allowed: false
    },
    commands: upgradeCommands,
    states: Object.fromEntries([
      'baseline_package', 'baseline_menubar', 'target_package', 'target_menubar', 'menubar_rollback',
      'target_menubar_reinstall', 'package_rollback'
    ].map((key) => {
      const expected = key.startsWith('target_') ? '8.0.0' : '7.6.0'
      const stages = ({
        baseline_package: ['baseline_install', 'baseline_version', 'baseline_bootstrap', 'baseline_doctor'],
        baseline_menubar: ['baseline_menubar_install', 'baseline_menubar_status'],
        target_package: ['target_install', 'target_version', 'target_doctor'],
        target_menubar: ['target_menubar_install', 'target_menubar_status'],
        menubar_rollback: ['target_menubar_rollback'],
        target_menubar_reinstall: ['target_menubar_reinstall_install', 'target_menubar_reinstall_status'],
        package_rollback: ['package_rollback_install', 'package_rollback_version', 'package_rollback_doctor']
      } as Record<string, string[]>)[key] || []
      return [key, { status: 'passed', expected_version: expected, observed_version: expected, command_stages: stages, blockers: [] }]
    }))
  }))

  const installChecks = Object.fromEntries(MACOS_INSTALL_REQUIRED_CHECKS.map((key) => [key, true]))
  const buildStamp = {
    schema: 'sks.sks-menubar-build-stamp.v2', package_version: '8.0.0',
    resources_sha256: 'c'.repeat(64), source_sha256: 'd'.repeat(64)
  }
  const installReport = {
    schema: 'sks.sks-menubar-install-check.v2', ok: true, checks: installChecks, failed_checks: [],
    blockers: [], resources_sha256: 'c'.repeat(64), source_sha256: 'd'.repeat(64), result: { build_stamp: buildStamp }
  }
  const installReportPath = path.join(reports, 'menubar-install.json')
  fs.writeFileSync(installReportPath, `${JSON.stringify(installReport)}\n`)
  fs.writeFileSync(path.join(proofDir, 'macos-menubar-proof.json'), JSON.stringify({
    schema: MACOS_MENUBAR_PROOF_SCHEMA, ok: true, version: '8.0.0', source_commit: head, runner_os: 'macOS',
    swift_version: 'Swift 6', xcode_version: 'Xcode 17', app_path: '/tmp/SKS.app',
    install_report_path: path.relative(root, installReportPath), install_report_sha256: sha(fs.readFileSync(installReportPath)),
    upgrade_report_path: path.relative(root, upgradePath), upgrade_report_sha256: sha(fs.readFileSync(upgradePath)),
    upgrade_report: {
      schema: 'sks.release-upgrade-smoke.v2',
      baseline_version: '7.6.0',
      target_version: '8.0.0',
      source_commit: head,
      target_tarball_sha256: inspected.sha256,
      target_receipt_sha256: sha(fs.readFileSync(packReceiptPath)),
      target_tarball_sha512_integrity: inspected.sha512_integrity,
      target_package_version: '8.0.0'
    },
    install_report: {
      schema: installReport.schema, checks: installChecks, failed_checks: [],
      resources_sha256: installReport.resources_sha256, source_sha256: installReport.source_sha256,
      build_stamp_schema: buildStamp.schema, build_stamp_package_version: buildStamp.package_version,
      build_stamp_resources_sha256: buildStamp.resources_sha256, build_stamp_source_sha256: buildStamp.source_sha256
    },
    checks: Object.fromEntries(MACOS_MENUBAR_REQUIRED_CHECKS.map((key) => [key, true])),
    generated_at: new Date().toISOString(), blockers: []
  }))
  writePhysicalReleaseEvidence(root, '8.0.0', head)
  fs.writeFileSync(path.join(proofDir, 'main-push-guard.json'), JSON.stringify({
    schema: MAIN_PUSH_GUARD_SCHEMA, ok: true, head, expected_origin_main: baseline, actual_origin_main: baseline,
    expected_origin_identity: originIdentity, actual_origin_identity: originIdentity,
    physical_proof: path.relative(root, path.join(proofDir, 'physical-gates-inspection.json')).split(path.sep).join('/'),
    force_push_allowed: false, blockers: []
  }))
}

function sha(value: crypto.BinaryLike): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function upgradeCommand(
  isolation: {
    workspace: string
    home: string
    codex_home: string
    npm_cache: string
    npm_prefix: string
  },
  stage: string,
  argv: string[],
  exitCode = 0
): any {
  return {
    stage,
    argv,
    cwd: isolation.workspace,
    isolated_home: isolation.home,
    isolated_codex_home: isolation.codex_home,
    isolated_npm_cache: isolation.npm_cache,
    isolated_npm_prefix: isolation.npm_prefix,
    exit_code: exitCode,
    timed_out: false,
    duration_ms: 1,
    stdout_sha256: sha(Buffer.alloc(0)),
    stderr_sha256: sha(Buffer.alloc(0)),
    stdout_tail: '',
    stderr_tail: '',
    json_schema: null,
    json_ok: null,
    report_file: null
  }
}

function upgradeDoctorCommand(
  isolation: {
    workspace: string
    home: string
    codex_home: string
    npm_cache: string
    npm_prefix: string
    command_reports_dir: string
  },
  stage: string,
  sksBinary: string,
  expectedVersion: string,
  validationMode: 'strict_report_file' | 'pinned_baseline_stdout_only'
) {
  const reportFile = path.join(isolation.command_reports_dir, `${stage}.json`)
  const command = upgradeCommand(isolation, stage, [sksBinary, 'doctor', '--json', '--report-file', reportFile])
  command.json_schema = 'sks.doctor-status.v3'
  command.json_ok = true
  command.report_file = validationMode === 'strict_report_file' ? {
    validation_mode: validationMode,
    path: reportFile,
    real_path: reportFile,
    inside_sandbox: true,
    regular_file: true,
    symlink_refused: false,
    sha256: '1'.repeat(64),
    json_sha256: '2'.repeat(64),
    stdout_json_sha256: '2'.repeat(64),
    matches_stdout: true,
    schema: 'sks.doctor-status.v3',
    ok: true,
    root: isolation.workspace,
    expected_package_version: expectedVersion
  } : {
    validation_mode: validationMode,
    path: reportFile,
    real_path: null,
    inside_sandbox: false,
    regular_file: false,
    symlink_refused: false,
    sha256: null,
    json_sha256: null,
    stdout_json_sha256: '2'.repeat(64),
    matches_stdout: false,
    schema: null,
    ok: null,
    root: null,
    expected_package_version: expectedVersion
  }
  return command
}
