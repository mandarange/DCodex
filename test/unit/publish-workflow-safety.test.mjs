import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  INSTALLED_REMOVED_ARGUMENT_PROBES,
  INSTALLED_REMOVED_COMMANDS,
  INSTALLED_REMOVED_DOLLAR_COMMANDS,
  INSTALLED_REMOVED_SUBCOMMAND_PROBES
} from '../../dist/core/install/installed-package-smoke.js';

const workflow = fs.readFileSync('.github/workflows/publish-npm.yml', 'utf8');
const captureWorkflow = fs.readFileSync('.github/workflows/capture-physical-release-evidence.yml', 'utf8');
const globalPermissions = sectionBetween('permissions:', 'concurrency:');
const linuxJob = jobBlock('linux-release-proof');
const macosJob = jobBlock('macos-menubar-proof');
const packJob = jobBlock('pack-and-compare');
const stageJob = jobBlock('stage-publish');
const stageContract = fs.readFileSync('src/core/release/npm-stage-contract.ts', 'utf8');
const stagePublish = fs.readFileSync('src/core/release/stage-publish.ts', 'utf8');
const stageVerifier = fs.readFileSync('src/core/release/npm-stage-tarball-verifier.ts', 'utf8');
const stageVerifierSupport = fs.readFileSync('src/core/release/npm-stage-tarball-verifier-support.ts', 'utf8');
const stageVerifierCli = fs.readFileSync('src/scripts/npm-stage-tarball-verifier.ts', 'utf8');
const physicalGateSource = fs.readFileSync('src/core/release/physical-release-gates.ts', 'utf8');
const physicalGateCli = fs.readFileSync('src/scripts/release-physical-gates-check.ts', 'utf8');
const releaseRealCheck = fs.readFileSync('src/scripts/release-real-check.ts', 'utf8');
const desktopBridgeEvidenceSource = fs.readFileSync('src/core/release/desktop-bridge-release-evidence.ts', 'utf8');
const closureProbeCounts = {
  command_probe_count: INSTALLED_REMOVED_COMMANDS.length,
  dollar_command_probe_count: INSTALLED_REMOVED_DOLLAR_COMMANDS.length,
  argument_probe_count: INSTALLED_REMOVED_ARGUMENT_PROBES.length,
  subcommand_probe_count: INSTALLED_REMOVED_SUBCOMMAND_PROBES.length
};
const closureRejectedCount = Object.values(closureProbeCounts).reduce((sum, count) => sum + count, 0);
const closureReasonCounts = {
  unknown_command: INSTALLED_REMOVED_COMMANDS.length + INSTALLED_REMOVED_DOLLAR_COMMANDS.length,
  unknown_subcommand: 0,
  unsupported_argument: 0
};
for (const probe of [...INSTALLED_REMOVED_ARGUMENT_PROBES, ...INSTALLED_REMOVED_SUBCOMMAND_PROBES]) {
  closureReasonCounts[probe.expected_reason] += 1;
}
const closureContract = JSON.parse(fs.readFileSync('config/installed-public-surface-closure.v1.json', 'utf8'));

test('npm workflow stages one immutable tarball after Linux and macOS proof', () => {
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /dispatch_nonce:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/);
  assert.match(workflow, /^run-name: npm-stage-\$\{\{ inputs\.version \}\}-\$\{\{ inputs\.dispatch_nonce \}\}-physical-\$\{\{ inputs\.physical_evidence_run_id \}\}$/m);
  assert.doesNotMatch(workflow, /^\s*push:\s*$/m);
  assert.match(workflow, /inputs\.confirm_stage == true/);
  assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /^  linux-release-proof:/m);
  assert.match(workflow, /^  macos-menubar-proof:/m);
  assert.match(workflow, /^  pack-and-compare:/m);
  assert.match(workflow, /^  stage-publish:/m);
  assert.match(macosJob, /needs: \[linux-release-proof\]/);
  assert.match(workflow, /needs: \[linux-release-proof, macos-menubar-proof\]/);
  assert.match(workflow, /needs: \[pack-and-compare\]/);
  assert.doesNotMatch(linuxJob, /release-physical-gates-check\.js|release:check:full|release-real-check\.js|release-check-stamp\.js/);
  assert.match(macosJob, /npm run test:release --silent/);
  assert.match(macosJob, /release-gate-dag-runner\.js --preset release --full/);
  assert.match(macosJob, /release-physical-gates-check\.js/);
  assert.match(macosJob, /release-real-check\.js --skip-release-check/);
  assert.match(macosJob, /SKS_PHYSICAL_EVIDENCE_RUN_ID: \$\{\{ inputs\.physical_evidence_run_id \}\}/);
  assert.match(macosJob, /SKS_PHYSICAL_EVIDENCE_REPOSITORY: \$\{\{ github\.repository \}\}/);
  assert.match(macosJob, /release-check-stamp\.js write --preset release --full/);
  const macosProofOrder = [
    'npm run build:clean --silent',
    'npm run test:release --silent',
    'release-gate-dag-runner.js --preset release --full',
    'release-physical-gates-check.js',
    'release-real-check.js --skip-release-check',
    'release-check-stamp.js write --preset release --full'
  ].map((needle) => macosJob.indexOf(needle));
  assert.ok(macosProofOrder.every((index) => index >= 0), 'macOS proof sequence must be complete');
  assert.deepEqual([...macosProofOrder].sort((a, b) => a - b), macosProofOrder, 'macOS proof must be regenerated after its build and before real authorization');
  for (const artifact of ['linux-release-proof', 'macos-menubar-proof']) {
    assert.match(workflow, new RegExp(`name: ${artifact}-\\$\\{\\{ github\\.sha \\}\\}`));
  }
  for (const artifact of ['stage-input', 'npm-stage-receipt']) {
    assert.match(workflow, new RegExp(`name: ${artifact}-\\$\\{\\{ github\\.sha \\}\\}-\\$\\{\\{ inputs\\.dispatch_nonce \\}\\}`));
  }
  assert.match(workflow, /npm stage publish "\$TARBALL" --json --ignore-scripts --provenance --access public/);
  assert.equal(countMatches(workflow, /npm stage publish "\$TARBALL"/g), 1, 'workflow must contain exactly one registry mutation');
  assert.match(linuxJob, /\^\[a-f0-9\]\{32\}\$/);
  assert.ok(stageJob.indexOf('case "$DISPATCH_NONCE"') >= 0);
  assert.ok(stageJob.indexOf('case "$DISPATCH_NONCE"') < stageJob.indexOf('npm stage publish "$TARBALL"'));
  assert.match(workflow, /stage_id: stageId/);
  assert.match(workflow, /stage_id_uuid_invalid/);
  assert.match(workflow, /sha512Integrity !== receipt\.sha512_integrity/);
  assert.match(workflow, /tarball_integrity: sha512Integrity/);
  assert.match(workflow, /stage-receipt\/stage-output\.json/);
  assert.match(workflow, /path: stage-receipt/);
  assert.match(workflow, /approved_with_2fa: false/);
  assert.doesNotMatch(workflow, /approve_command/);
});

test('OIDC stage job cannot directly publish, inspect, download, or approve', () => {
  assert.match(globalPermissions, /contents: read/);
  assert.doesNotMatch(globalPermissions, /id-token:/);
  assert.match(stageJob, /permissions:\n      contents: read\n      id-token: write/);
  assert.equal(countMatches(workflow, /id-token: write/g), 1, 'OIDC permission must be scoped to stage-publish only');
  assert.match(stageJob, /environment: npm-production/);
  assert.match(workflow, /NPM_STAGE_CLI_VERSION: 11\.15\.0/);
  assert.match(workflow, /npm install --global npm@\$\{NPM_STAGE_CLI_VERSION\}/);
  assert.match(stageJob, /test "\$\(npm --version\)" = "\$\{NPM_STAGE_CLI_VERSION\}"/);
  assert.doesNotMatch(workflow, /\bnpm\s+publish\b/);
  assert.doesNotMatch(workflow, /npm\s+stage\s+(?:list|view|download|approve|reject)\b/);
  assert.doesNotMatch(stageJob, /\bnpm[ \t]+(?:ci|pack|run|publish|login|logout|whoami)\b/);
  assert.doesNotMatch(workflow, /npm whoami/);
  assert.doesNotMatch(workflow, /NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/);
});

test('workflow proves Node 20, 22, and 24 and runs exact-tarball smoke plus secret scan', () => {
  assert.match(workflow, /node-version: '20\.11\.1'/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /node-version: '24'/);
  assert.match(linuxJob, /release-gate-dag-runner\.js --preset release --full/);
  assert.match(workflow, /release-pack-receipt\.js create/);
  assert.match(workflow, /release-pack-receipt\.js inspect --tarball "\$TARBALL"/);
  assert.match(workflow, /installed-package-smoke-check\.js --tarball "\$TARBALL" --receipt "\$LOCAL_RECEIPT"/);
  assert.match(macosJob, /release-upgrade-smoke\.js --target-tarball "\$TARBALL" --target-receipt "\$LOCAL_RECEIPT"/);
  assert.match(macosJob, /upgrade-7\.6-to-\$\{VERSION\}\.json/);
  assert.match(macosJob, /macos-menubar-proof\.js[\s\S]*--install-report[\s\S]*--upgrade-report "\$UPGRADE_PROOF"/);
  assert.match(packJob, /release-main-push-guard\.js/);
  for (const flag of ['--require-release-stamp', '--require-pack-proof', '--require-macos-proof', '--require-clean-tree']) {
    assert.match(packJob, new RegExp(flag));
  }
  assert.match(packJob, /--expected-origin-main "\$EXPECTED_SHA"/);
  for (const block of [linuxJob, macosJob, packJob]) {
    assert.match(block, /REQUESTED_VERSION: \$\{\{ inputs\.version \}\}/);
    assert.match(block, /EXPECTED_SHA: \$\{\{ github\.sha \}\}/);
    assert.match(block, /pkg\.version !== process\.env\.REQUESTED_VERSION/);
    assert.match(block, /head !== process\.env\.EXPECTED_SHA/);
    assert.match(block, /status', '--porcelain=v1', '--untracked-files=all'/);
    assert.match(block, /ls-remote', '--exit-code', 'origin', 'refs\/heads\/main'/);
    assert.match(block, /remoteMain !== head/);
    assert.match(block, /publishConfig\?\.tag !== expectedTag/);
    assert.match(block, /npmrcTag !== expectedTag/);
  }
  assert.match(stageJob, /pkg\.version !== process\.env\.VERSION/);
  assert.match(stageJob, /comparison\.local_sha256 !== receipt\.sha256/);
  assert.match(stageJob, /smoke\.tarball_sha256 !== receipt\.sha256/);
  assert.match(stageJob, /upgrade\.schema !== 'sks\.release-upgrade-smoke\.v2'/);
  assert.match(stageJob, /upgrade\.platform !== 'darwin'/);
  assert.match(stageJob, /upgrade\.source_tree\?\.head !== process\.env\.SOURCE_SHA/);
  assert.match(stageJob, /upgrade\.target\?\.tarball_sha256 !== receipt\.sha256/);
  assert.match(stageJob, /upgrade\.target\?\.receipt_sha256 !== receiptSha256/);
  assert.match(stageJob, /upgrade\.target\?\.tarball_sha512_integrity !== receipt\.sha512_integrity/);
  assert.match(stageJob, /upgrade\.target\?\.npm_pack_proof\?\.proof_id !== receipt\.npm_pack_proof\?\.proof_id/);
  assert.match(stageJob, /upgrade\.commands\.map\(command => command\?\.stage\)/);
  assert.match(stageJob, /isolation\.removed_after_success !== true/);
  assert.match(stageJob, /launchctl_unexpected_calls\.length !== 0/);
  assert.match(stageJob, /macos\.schema !== 'sks\.macos-menubar-proof\.v2'/);
  assert.match(stageJob, /macos\.upgrade_report_sha256 !== upgradeSha256/);
  assert.match(stageJob, /macos\.upgrade_report\?\.target_receipt_sha256 !== receiptSha256/);
  assert.match(stageJob, /guard\.schema !== 'sks\.release-main-push-guard\.v1'/);
  assert.match(stageJob, /guard\.upgrade_proof\?\.sha256 !== upgradeSha256/);
  assert.match(stageJob, /main-push-guard\.json/);
  assert.match(stageJob, /upgrade-7\.6-to-\$\{process\.env\.VERSION\}\.json/);
  assert.match(stageJob, /closure\.rejected_count !== closure\.command_probe_count \+ closure\.dollar_command_probe_count \+ closure\.argument_probe_count \+ closure\.subcommand_probe_count/);
  assert.equal(closureContract.schema, 'sks.installed-public-surface-closure.v1');
  assert.deepEqual(
    Object.fromEntries(Object.keys(closureProbeCounts).map((field) => [field, closureContract[field]])),
    closureProbeCounts
  );
  assert.equal(closureContract.rejected_count, closureRejectedCount);
  assert.deepEqual(closureContract.reason_counts, closureReasonCounts);
  assert.match(stageJob, /config\/installed-public-surface-closure\.v1\.json/);
  assert.match(stageJob, /closure\[field\] !== closureContract\[field\]/);
  assert.match(stageJob, /closure\.expected_reason_counts\?\.\[reason\] !== closureContract\.reason_counts\?\.\[reason\]/);
  assert.match(stageJob, /closure\.observed_reason_counts\?\.\[reason\] !== closureContract\.reason_counts\?\.\[reason\]/);
  assert.match(stageJob, /observed_reason_counts\?\.other !== 0/);
});

test('physical evidence authorization requires an exact cross-run GitHub-attested capture artifact', () => {
  assert.match(workflow, /physical_evidence_run_id:\n\s+description:[^\n]+\n\s+required: true\n\s+type: string/);
  assert.match(macosJob, /actions: read/);
  assert.match(macosJob, /attestations: read/);
  assert.match(macosJob, /repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{PHYSICAL_EVIDENCE_RUN_ID\}/);
  assert.match(macosJob, /run\.path !== '\.github\/workflows\/capture-physical-release-evidence\.yml'/);
  assert.match(macosJob, /run\.head_sha !== process\.env\.SOURCE_COMMIT/);
  assert.match(macosJob, /name: physical-release-evidence-\$\{\{ github\.sha \}\}/);
  assert.match(macosJob, /github-token: \$\{\{ github\.token \}\}/);
  assert.match(macosJob, /repository: \$\{\{ github\.repository \}\}/);
  assert.match(macosJob, /run-id: \$\{\{ inputs\.physical_evidence_run_id \}\}/);
  assert.match(macosJob, /gh attestation verify "\$ARCHIVE"/);
  assert.match(macosJob, /--signer-workflow "\$TRUSTED_WORKFLOW"/);
  assert.match(macosJob, /--source-digest "\$SOURCE_COMMIT"/);
  assert.match(macosJob, /physical archive digest changed during verification/);
  assert.match(macosJob, /physical evidence manifest identity mismatch/);
  assert.match(macosJob, /physical capture adapter manifest binding invalid/);
  assert.match(macosJob, /physical capture adapter receipt binding mismatch/);
  assert.match(macosJob, /maxBuffer: 64 \* 1024 \* 1024/);
  assert.match(macosJob, /fs\.writeFileSync\(entry\.path, bytes, \{ mode: 0o600, flag: 'wx' \}\)/);
  assert.doesNotMatch(macosJob, /execFileSync\('tar', \['-xzf', archive/);
  assert.match(macosJob, /release-physical-gates-check\.js[\s\S]*--archive downloaded\/physical\/physical-release-evidence\.tgz[\s\S]*--evidence-run-id "\$PHYSICAL_EVIDENCE_RUN_ID"[\s\S]*--repository "\$GITHUB_REPOSITORY"/);
  assert.ok(macosJob.indexOf('gh attestation verify "$ARCHIVE"') < macosJob.indexOf('release-physical-gates-check.js'));
  assert.match(macosJob, /fs\.rmSync\(path\.join\('release-evidence', process\.env\.VERSION\)/);
  assert.match(macosJob, /physical-evidence-archive\.tgz/);
  assert.match(packJob, /rm -rf "release-evidence\/\$\{VERSION\}"/);
  assert.match(packJob, /attestations: read/);
  assert.match(stageJob, /physicalAttestation\?\.schema !== 'sks\.release-physical-evidence-artifact-attestation\.v1'/);
  assert.match(stageJob, /capture_adapter_executable_sha256/);

  assert.match(physicalGateSource, /spawnSync\('gh', \[/);
  assert.match(physicalGateSource, /'attestation', 'verify', input\.archivePath/);
  assert.match(physicalGateSource, /'--signer-workflow', input\.trustedWorkflow/);
  assert.match(physicalGateSource, /'--source-digest', input\.sourceCommit/);
  assert.match(physicalGateSource, /physical_evidence_attestation_run_binding_invalid/);
  assert.match(physicalGateSource, /releaseSourceCommit !== headCommit/);
  assert.doesNotMatch(physicalGateSource, /merge-base|source_changed_after_capture/);
  assert.match(physicalGateCli, /--evidence-run-id/);
  assert.match(physicalGateCli, /--repository/);
  assert.match(releaseRealCheck, /'--evidence-run-id', physicalEvidenceRunId/);
  assert.match(releaseRealCheck, /'--repository', physicalEvidenceRepository/);
  assert.match(desktopBridgeEvidenceSource, /pngCrc32/);
  assert.match(desktopBridgeEvidenceSource, /type === 'IDAT'/);
  assert.match(desktopBridgeEvidenceSource, /type === 'IEND'/);
  assert.match(physicalGateSource, /sks\.release-physical-gate-artifact\.v2/);
  assert.match(physicalGateSource, /sks\.release-physical-gate-producer-output\.v1/);
  assert.match(physicalGateSource, /deriveGenericGateObservations\(id, output\?\.measurement\)/);
  assert.match(physicalGateSource, /canonicalJson\(derived\) !== canonicalJson\(gate\.observations \|\| \{\}\)/);
});

test('trusted physical capture workflow has no fixture fallback and attests the real adapter archive', () => {
  assert.match(captureWorkflow, /runs-on: \[self-hosted, macOS, sneakoscope-physical-release\]/);
  assert.match(captureWorkflow, /id-token: write/);
  assert.match(captureWorkflow, /attestations: write/);
  assert.match(captureWorkflow, /environment: physical-release-capture/);
  assert.match(captureWorkflow, /const adapter = '\/usr\/local\/bin\/sks-physical-release-capture'/);
  assert.match(captureWorkflow, /EXPECTED_ADAPTER_SHA256: \$\{\{ secrets\.SKS_PHYSICAL_CAPTURE_ADAPTER_SHA256 \}\}/);
  assert.match(captureWorkflow, /const components = \['\/', '\/usr', '\/usr\/local', '\/usr\/local\/bin'\]/);
  assert.match(captureWorkflow, /!stat\.isDirectory\(\) \|\| stat\.isSymbolicLink\(\)/);
  assert.match(captureWorkflow, /stat\.uid !== 0 \|\| \(stat\.mode & 0o022\) !== 0/);
  assert.match(captureWorkflow, /fs\.lstatSync\(adapter\)/);
  assert.match(captureWorkflow, /sourceStat\.uid !== 0 \|\| \(sourceStat\.mode & 0o022\) !== 0/);
  assert.match(captureWorkflow, /fs\.constants\.O_RDONLY \| fs\.constants\.O_NOFOLLOW/);
  assert.match(captureWorkflow, /openedStat\.dev !== sourceStat\.dev \|\| openedStat\.ino !== sourceStat\.ino/);
  assert.match(captureWorkflow, /actual !== expected/);
  assert.match(captureWorkflow, /fs\.chmodSync\(privateRoot, 0o700\)/);
  assert.match(captureWorkflow, /fs\.writeFileSync\(privateAdapter, sourceBytes, \{ mode: 0o500, flag: 'wx' \}\)/);
  assert.match(captureWorkflow, /spawnSync\(privateAdapter, \[/);
  assert.doesNotMatch(captureWorkflow, /spawnSync\(adapter, \[/);
  assert.match(captureWorkflow, /const adapterEnvKeys = \[/);
  assert.match(captureWorkflow, /env: adapterEnv, maxBuffer: 1024 \* 1024/);
  assert.doesNotMatch(captureWorkflow, /stdio: 'inherit', env: process\.env/);
  assert.match(captureWorkflow, /Buffer\.isBuffer\(run\.stdout\)/);
  assert.match(captureWorkflow, /physical capture adapter emitted prohibited secret-like output/);
  assert.match(captureWorkflow, /stdout_sha256: crypto\.createHash\('sha256'\)/);
  assert.match(captureWorkflow, /stderr_sha256: crypto\.createHash\('sha256'\)/);
  assert.doesNotMatch(captureWorkflow, /console\.log\(run\.(?:stdout|stderr)/);
  assert.match(captureWorkflow, /JSON\.stringify\(afterParents\) !== JSON\.stringify\(beforeParents\)/);
  assert.match(captureWorkflow, /afterSource\.dev !== sourceStat\.dev \|\| afterSource\.ino !== sourceStat\.ino/);
  assert.match(captureWorkflow, /private physical capture adapter changed during execution/);
  assert.match(captureWorkflow, /PHYSICAL_CAPTURE_ADAPTER_SHA256=\$\{actual\}/);
  assert.doesNotMatch(captureWorkflow, /vars\.PHYSICAL_CAPTURE_ADAPTER|inputs\.physical_capture_adapter/);
  assert.match(captureWorkflow, /source_commit: process\.env\.SOURCE_COMMIT/);
  assert.match(captureWorkflow, /workflow_run_id: process\.env\.WORKFLOW_RUN_ID/);
  assert.match(captureWorkflow, /schema: 'sks\.release-physical-capture-adapter\.v1'/);
  assert.match(captureWorkflow, /executable_sha256: process\.env\.PHYSICAL_CAPTURE_ADAPTER_SHA256/);
  assert.match(captureWorkflow, /capture adapter receipt identity mismatch/);
  assert.match(captureWorkflow, /gate\.fixture !== false[\s\S]*gate\.mock !== false[\s\S]*gate\.synthetic !== false/);
  assert.match(captureWorkflow, /gate\.producer_receipt_sha256 !== adapterReceiptSha256/);
  assert.match(captureWorkflow, /artifact\.schema !== 'sks\.release-physical-gate-artifact\.v2'/);
  assert.match(captureWorkflow, /producer\?\.schema !== 'sks\.release-physical-gate-producer\.v1'/);
  assert.match(captureWorkflow, /output\.schema !== 'sks\.release-physical-gate-producer-output\.v1'/);
  assert.match(captureWorkflow, /producer output digest mismatch/);
  assert.match(captureWorkflow, /capture contains secret material/);
  assert.match(captureWorkflow, /uses: actions\/attest@v4/);
  assert.match(captureWorkflow, /subject-path: \$\{\{ runner\.temp \}\}\/physical-release-evidence\.tgz/);
  assert.match(captureWorkflow, /name: physical-release-evidence-\$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(captureWorkflow, /fake|fallback/i);
});

test('stage receipt is content-bound and review-only', () => {
  for (const field of [
    'release_tag',
    'tarball_sha256',
    'tarball_sha512',
    'tarball_integrity',
    'packed_bytes',
    'unpacked_bytes',
    'file_count',
    'dispatch_nonce',
    'physical_evidence_run_id',
    'workflow_run_id',
    'workflow_run_attempt',
    'local_pack_receipt_sha256',
    'stage_command_digest',
    'stage_output_digest',
    'review_verifier_schema',
    'oidc_review_supported',
    'maintainer_session_required',
    'review_required',
    'human_2fa_pending',
    'generated_at'
  ]) assert.match(stageJob, new RegExp(`${field}:`));
  assert.match(stageJob, /Object\.hasOwn\(output, receipt\.package_name\)/);
  assert.match(stageJob, /uniqueStageIds\.length !== 1/);
  assert.match(stageJob, /review_required: true/);
  assert.match(stageJob, /approved_with_2fa: false/);
  assert.match(stageJob, /schema: 'sks\.npm-stage-receipt\.v2'/);
  assert.match(stageJob, /dispatch_nonce: process\.env\.DISPATCH_NONCE/);
  assert.match(stageJob, /physical_evidence_run_id: process\.env\.PHYSICAL_EVIDENCE_RUN_ID/);
  assert.match(stageJob, /workflow_run_id: process\.env\.GITHUB_RUN_ID/);
  assert.match(stageJob, /review_verifier_schema: 'sks\.npm-stage-review-receipt\.v2'/);
  assert.match(stageJob, /release_tag: `v\$\{receipt\.package_version\}`/);
  assert.match(stageJob, /oidc_review_supported: false/);
  assert.match(stageJob, /maintainer_session_required: true/);
  assert.match(stageJob, /human_2fa_pending: true/);
  assert.match(stageJob, /localPackReceiptSha256 = crypto\.createHash\('sha256'\)\.update\(localPackReceiptBytes\)/);
  assert.match(stageJob, /stageOutputDigest = crypto\.createHash\('sha256'\)\.update\(outputBytes\)/);
});

test('workflow accepts only source-bound v2 pack receipts and exact release tags', () => {
  assert.doesNotMatch(workflow, /sks\.release-pack-receipt\.v1/);
  assert.match(workflow, /receipt\.schema !== 'sks\.release-pack-receipt\.v2'/);
  for (const field of ['source_tree_sha256', 'source_package_sha256', 'source_package_binding_sha256']) {
    assert.match(workflow, new RegExp(field));
  }
  assert.match(workflow, /refs\/tags\/\$\{releaseTag\}\^\{commit\}/);
  assert.match(workflow, /manifest\.release_tag !== releaseTag/);
  assert.match(workflow, /release_tag: `v\$\{receipt\.package_version\}`/);
  assert.match(stageVerifierSupport, /release_tag_mismatch/);
});

test('stage job requires scripts-enabled default postinstall safety proof', () => {
  assert.match(stageJob, /smoke\.postinstall_default\?\.scripts_enabled !== true/);
  assert.match(stageJob, /smoke\.postinstall_default\?\.external_snapshot_match !== true/);
  assert.match(stageJob, /smoke\.postinstall_default\?\.package_local_stamp_present !== true/);
  assert.match(stageJob, /smoke\.postinstall_default\?\.opt_in_guidance_present !== true/);
  assert.match(stageJob, /smoke\.postinstall_default\.external_findings\.length !== 0/);
  assert.match(stageJob, /smoke\.postinstall_default\.launchctl_calls\.length !== 0/);
});

test('maintainer verifier is read-only, exact-versioned, and OIDC-ineligible', () => {
  assert.match(stageContract, /export const REQUIRED_NPM_STAGE_CLI_VERSION = '11\.15\.0'/);
  assert.match(stageContract, /command: platform === 'win32' \? 'npx\.cmd' : 'npx'/);
  assert.match(stageContract, /args: \['--yes', `npm@\$\{REQUIRED_NPM_STAGE_CLI_VERSION\}`\]/);
  assert.match(stageVerifierSupport, /from '\.\/npm-stage-contract\.js'/);
  assert.match(stageVerifier, /from '\.\/npm-stage-tarball-verifier-support\.js'/);
  assert.match(stageVerifier, /exactNpmStageCliInvocation\(\)/);
  assert.match(stageVerifier, /\['stage', 'view', stageId, '--json'/);
  assert.match(stageVerifier, /\['stage', 'download', stageId, '--json'/);
  assert.match(stageContract, /oidc_environment_not_allowed/);
  assert.match(stageVerifier, /exact_bytes_match/);
  assert.match(stageVerifier, /sha256_match/);
  assert.match(stageVerifier, /sha512_match/);
  assert.match(stageVerifier, /integrity_match/);
  assert.match(stageVerifierSupport, /local_pack_receipt_sha256_mismatch/);
  assert.match(stageVerifierSupport, /dispatch_nonce_mismatch/);
  assert.match(stageVerifierSupport, /physical_evidence_run_id_mismatch/);
  assert.match(stageVerifierSupport, /workflow_run_id_mismatch/);
  assert.match(stageVerifierCli, /--dispatch-nonce/);
  assert.match(stageVerifierCli, /--physical-evidence-run-id/);
  assert.match(stageVerifierCli, /--workflow-run-id/);
  assert.match(stageVerifierCli, /--local-receipt/);
  assert.match(stageVerifierCli, /--local-tarball/);
  assert.match(stageVerifierCli, /--stage-receipt/);
  assert.doesNotMatch(`${stageVerifier}\n${stageVerifierSupport}\n${stageVerifierCli}`, /\['stage',\s*'(?:publish|approve|reject)'/);
});

test('confirmed staging proves the local review path before any mutation', () => {
  assert.match(stagePublish, /const preflight = runPreflight\(opts, packageIdentity\.name, version\)/);
  assert.match(stagePublish, /if \(!preflight\.ok\) return finish\(\)/);
  assert.match(stagePublish, /local_review_verifier/);
  assert.match(stagePublish, /physical_release_gates/);
  assert.match(stagePublish, /localNpmStageReviewEnvironmentBlocker/);
  assert.match(stagePublish, /exactNpmStageCliInvocation\(\)/);
  assert.match(stagePublish, /stage_npm_cli_version_mismatch/);
  assert.match(stagePublish, /stage_npm_cli_unavailable/);
  assert.match(stagePublish, /stage_npm_not_authenticated/);
  assert.match(stagePublish, /stage_npm_user_not_maintainer/);
  assert.match(stagePublish, /stage_version_already_staged/);
  assert.match(stagePublish, /snapshotWorkflowRunIds/);
  assert.match(stagePublish, /!priorRunIds\.has\(id\)/);
  assert.match(stagePublish, /String\(row\?\.displayTitle \|\| ''\) === expectedDisplayTitle/);
  assert.match(stagePublish, /--json', 'databaseId,headSha,status,event,displayTitle'/);
  assert.match(stagePublish, /STAGE_DISPATCH_NONCE_PATTERN/);
  assert.match(stagePublish, /crypto\.randomBytes\(16\)\.toString\('hex'\)/);
  assert.match(stagePublish, /stage_receipt_dispatch_nonce_mismatch/);
  assert.match(stagePublish, /stage_receipt_physical_evidence_run_id_mismatch/);
  assert.match(stagePublish, /stage_receipt_workflow_run_id_mismatch/);
});

function sectionBetween(startLabel, endLabel) {
  const start = workflow.indexOf(`${startLabel}\n`);
  const end = workflow.indexOf(`\n${endLabel}\n`, start);
  assert.notEqual(start, -1, `${startLabel} section missing`);
  assert.notEqual(end, -1, `${endLabel} section missing`);
  return workflow.slice(start, end);
}

function jobBlock(name) {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  assert.notEqual(start, -1, `${name} job missing`);
  const rest = workflow.slice(start + marker.length);
  const next = rest.search(/^  [a-z0-9-]+:\n/m);
  return next === -1 ? rest : rest.slice(0, next);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}
