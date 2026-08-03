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

test('npm workflow stages one immutable tarball after Linux and macOS proof', () => {
  assert.match(workflow, /workflow_dispatch:/);
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
  assert.match(linuxJob, /release-physical-gates-check\.js/);
  for (const artifact of [
    'linux-release-proof',
    'macos-menubar-proof',
    'stage-input',
    'npm-stage-receipt'
  ]) assert.match(workflow, new RegExp(`name: ${artifact}-\\$\\{\\{ github\\.sha \\}\\}`));
  assert.match(workflow, /npm stage publish "\$TARBALL" --json --ignore-scripts --provenance --access public/);
  assert.equal(countMatches(workflow, /npm stage publish "\$TARBALL"/g), 1, 'workflow must contain exactly one registry mutation');
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
  assert.match(workflow, /release:check:full/);
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
  for (const [field, count] of Object.entries(closureProbeCounts)) {
    assert.match(stageJob, new RegExp(`closure\\.${field} !== ${count}`));
  }
  assert.match(stageJob, new RegExp(`closure\\.rejected_count !== ${closureRejectedCount}`));
  for (const [reason, count] of Object.entries(closureReasonCounts)) {
    assert.match(stageJob, new RegExp(`expected_reason_counts\\?\\.${reason} !== ${count}`));
    assert.match(stageJob, new RegExp(`observed_reason_counts\\?\\.${reason} !== ${count}`));
  }
  assert.match(stageJob, /observed_reason_counts\?\.other !== 0/);
});

test('stage receipt is content-bound and review-only', () => {
  for (const field of [
    'tarball_sha256',
    'tarball_sha512',
    'tarball_integrity',
    'packed_bytes',
    'unpacked_bytes',
    'file_count',
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
  assert.match(stageJob, /review_verifier_schema: 'sks\.npm-stage-review-receipt\.v1'/);
  assert.match(stageJob, /oidc_review_supported: false/);
  assert.match(stageJob, /maintainer_session_required: true/);
  assert.match(stageJob, /human_2fa_pending: true/);
  assert.match(stageJob, /localPackReceiptSha256 = crypto\.createHash\('sha256'\)\.update\(localPackReceiptBytes\)/);
  assert.match(stageJob, /stageOutputDigest = crypto\.createHash\('sha256'\)\.update\(outputBytes\)/);
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
