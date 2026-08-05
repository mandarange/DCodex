#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { assertGate, emitGate, root } from './sks-cli-gate-lib.js';

const pkg = readJson('package.json');
const lock = readJson('package-lock.json');
const releaseManifest = readJson('release-gates.v2.json');
const harnessManifest = readJson('infra-harness-gates.json');
const RELEASE_VERSION = String(pkg.version || '');
const distManifest = readJsonIfExists('dist/build-manifest.json');
const releaseGates = Array.isArray(releaseManifest?.gates)
  ? releaseManifest.gates.filter((gate: any) => Array.isArray(gate.preset) && gate.preset.includes('release'))
  : [];
const harnessGates = Array.isArray(harnessManifest?.gates)
  ? harnessManifest.gates.filter((gate: any) => Array.isArray(gate.preset) && gate.preset.includes('harness'))
  : [];
const releaseGateIds = new Set(releaseGates.map((gate: any) => gate.id));
const harnessGateIds = new Set(harnessGates.map((gate: any) => gate.id));
const allManifestGates = [...releaseGates, ...harnessGates];

const requiredDocs = [
  'README.md',
  'CHANGELOG.md',
  'docs/release-readiness.md',
  'docs/release-proof-truth.md',
  'docs/naruto.md',
  'docs/AGENT-BRIDGE.md',
  'docs/runtime-truth-matrix.md',
  'docs/feature-fixtures.md',
  'docs/orchestration-layers.md'
];
const versionedDocs = new Set([
  'README.md',
  'CHANGELOG.md',
  'docs/release-readiness.md',
  'docs/release-proof-truth.md'
]);
const requiredPackageScripts = [
  'build',
  'build:incremental',
  'test:all',
  'test:release',
  'release:ensure-build',
  'typecheck',
  'release:check',
  'release:metadata',
  'release:check:affected',
  'release:check:fast',
  'release:check:confidence',
  'release:check:full',
  'prepublishOnly',
  'release:file-ownership',
  'release:macos-menubar-proof',
  'release:main-push-guard',
  'release:main-push-receipt',
  'release:pack-receipt',
  'runtime:installed-smoke',
  'gates:run',
  'policy:gate-audit',
  'naruto:e2e-hermetic',
  'naruto:e2e-hermetic-write'
];
const requiredReleaseGates = [
  'architecture:guard',
  'codex:current:manifest',
  'codex:current:binary-identity',
  'codex:current:policy',
  'codex:current:app-server-v2',
  'codex:current:thread-store',
  'codex:current:capability',
  'commands:current-surface-only',
  'config:managed-merge',
  'docs:truthfulness',
  'latest-version:guidance',
  'migration:current-surface-e2e',
  'migration:upgrade-safety',
  'runtime:installed-smoke',
  'release:metadata-current',
  'publish:packlist-performance',
  'publish:runtime-script-closure',
  'package:published-contract',
  'release:dag-runner',
  'release:gate-budget',
  'release:latency-slo',
  'release:proof-truth',
  'release:provenance',
  'policy:gate-audit',
  'safety:mutation-callsite-coverage',
  'schema:check',
  'secret:preservation',
  'side-effect:runtime-report',
  'typecheck'
];
const requiredHarnessGates = [];

assertGate(/^\d+\.\d+\.\d+$/.test(RELEASE_VERSION), 'package.json version must be a stable semver', { version: pkg.version });
assertGate(lock.version === RELEASE_VERSION, `package-lock version must be ${RELEASE_VERSION}`, { version: lock.version });
assertGate(lock.packages?.['']?.version === RELEASE_VERSION, `package-lock root version must be ${RELEASE_VERSION}`, { version: lock.packages?.['']?.version });
assertVersionSurface('src/core/version.ts', `PACKAGE_VERSION = '${RELEASE_VERSION}'`);
assertVersionSurface('src/core/fsx.ts', "PACKAGE_VERSION } from './version.js'");
assertVersionSurface('src/bin/sks.ts', "PACKAGE_VERSION } from '../core/version.js'");
assertVersionSurface('crates/sks-core/Cargo.toml', `version = "${RELEASE_VERSION}"`);
assertVersionSurface('crates/sks-core/Cargo.lock', `version = "${RELEASE_VERSION}"`);
assertVersionSurface('crates/sks-core/src/main.rs', 'sks-rs {}", env!("CARGO_PKG_VERSION")');
assertGate(distManifest?.version === RELEASE_VERSION, `dist/build-manifest version must be ${RELEASE_VERSION}`, { version: distManifest?.version || null });
assertGate(distManifest?.package_version === RELEASE_VERSION, `dist/build-manifest package_version must be ${RELEASE_VERSION}`, { package_version: distManifest?.package_version || null });
assertGate(typeof distManifest?.source_digest === 'string' && distManifest.source_digest.length >= 32, 'dist/build-manifest must include source_digest', { source_digest: distManifest?.source_digest || null });

assertGate(pkg.scripts?.['release:metadata']?.includes('dist/scripts/release-metadata-check.js'), 'release:metadata must point to the generic release metadata check');
const releaseCheckScript = String(pkg.scripts?.['release:check'] || '');
assertGate(
  releaseCheckScript.startsWith('npm run release:check:parallel')
    || releaseCheckScript.includes('release-gate-dag-runner.js --preset release')
    || releaseCheckScript.includes('release:check:affected'),
  'release:check must use the current release DAG'
);
assertGate(releaseManifest?.schema === 'sks.release-gates.v2', 'release gate manifest schema mismatch', { schema: releaseManifest?.schema || null });
assertGate(harnessManifest?.schema === 'sks.infra-harness-gates.v1', 'infra harness manifest schema mismatch', { schema: harnessManifest?.schema || null });
assertGate(releaseGates.length > 0 && releaseGates.length <= 200, 'release manifest must include 1..200 release gates', { release_gates: releaseGates.length });
assertGate(harnessGates.length === 0, 'retired infra harness manifest must remain empty', { harness_gates: harnessGates.length });
assertGate(Object.keys(pkg.scripts || {}).length <= 101, 'package script budget exceeded', { script_count: Object.keys(pkg.scripts || {}).length, limit: 101 });
for (const script of requiredPackageScripts) assertGate(Boolean(pkg.scripts?.[script]), `missing package script: ${script}`);

const fullReleaseScript = String(pkg.scripts?.['release:check:full'] || '');
assertGate((fullReleaseScript.match(/build:clean/g) || []).length === 1, 'release:check:full must perform exactly one clean build', { script: fullReleaseScript });
assertGate((fullReleaseScript.match(/npm run test:release --silent/g) || []).length === 1, 'release:check:full must run the release test corpus exactly once', { script: fullReleaseScript });
assertGate(pkg.scripts?.test === 'node ./dist/scripts/canonical-test-runner.js --all' && pkg.scripts?.['test:all'] === pkg.scripts?.test, 'npm test and test:all must preserve the exhaustive developer corpus');
assertGate(pkg.scripts?.['test:release'] === 'node ./dist/scripts/canonical-test-runner.js', 'test:release must use the proof-producing release corpus selector');
for (const id of requiredReleaseGates) assertGate(releaseGateIds.has(id), `critical release gate missing: ${id}`, { id });
for (const id of requiredHarnessGates) assertGate(harnessGateIds.has(id), `critical harness gate missing: ${id}`, { id });
const duplicateAcrossManifests = [...releaseGateIds].filter((id) => harnessGateIds.has(id));
assertGate(duplicateAcrossManifests.length === 0, 'gate appears in both release and harness manifests', { duplicate_count: duplicateAcrossManifests.length });
assertGate(allManifestGates.every((gate: any) => !/\bnpm\s+run\b/.test(String(gate.command))), 'gate manifest commands must not use npm run indirection');
const retiredPublicSurfaceGateCount = allManifestGates.filter((gate: any) =>
  /(?:^|[^a-z0-9])(?:team|mad-db|tmux|xai|swarm|ralph)(?:[^a-z0-9]|$)/i.test(`${String(gate.id || '')}\n${String(gate.command || '')}`)
).length;
assertGate(retiredPublicSurfaceGateCount === 0, 'release and harness manifests must use only the current public surface', { violation_count: retiredPublicSurfaceGateCount });
for (const gate of allManifestGates) assertDistScriptTargetsExist(gate);

assertGate(pkg.bin?.sks === 'dist/bin/sks.js', 'package runtime must use dist/bin/sks.js');
assertGate(pkg.bin?.sneakoscope === 'dist/bin/sks.js', 'sneakoscope runtime must use dist/bin/sks.js');
assertGate(!pkg.files?.includes('src'), 'package files must not include source runtime shadows');
for (const removed of ['publish:dry', 'publish:verify-ignore-scripts', 'publish:prep-ignore-scripts', 'publish:ignore-scripts']) {
  assertGate(!pkg.scripts?.[removed], `direct publish package script must be removed: ${removed}`);
}
assertGate(!/\bnpm\s+publish\b/.test(Object.values(pkg.scripts || {}).join('\n')), 'package scripts must not contain direct npm publish');

const currentCommandManifest = text('src/cli/command-manifest-lite.ts');
const currentDollarManifest = text('src/core/routes/dollar-manifest-lite.ts');
for (const token of ["{ name: 'team',", "{ name: 'mad-db',", "{ name: 'tmux',", "{ name: 'xai',", "{ name: 'swarm',", "{ name: 'agent',", "{ name: 'ralph',"]) {
  assertGate(!currentCommandManifest.includes(token), 'current command manifest contains a retired public command');
}
for (const token of ["command: '$Agent'", "command: '$Team'", "command: '$MAD-DB'", "command: '$Swarm'", "command: '$ShadowClone'", "command: '$Kagebunshin'", "command: '$Ralph'"]) {
  assertGate(!currentDollarManifest.includes(token), 'current dollar manifest contains a retired route identity');
}
assertGate(currentDollarManifest.includes("{ command: '$Naruto'") && currentDollarManifest.includes("{ command: '$Work'"), 'current dollar manifest must expose the canonical workflow and intended alias');

const stageWorkflow = text('.github/workflows/publish-npm.yml');
const stageJob = stageWorkflow.match(/^  stage-publish:\n[\s\S]*$/m)?.[0] || '';
const workflowPermissions = stageWorkflow.match(/^permissions:\n(?:  [^\n]+\n)+/m)?.[0] || '';
const stageContract = text('src/core/release/npm-stage-contract.ts');
const stagePublishSource = text('src/core/release/stage-publish.ts');
const physicalReleaseGateSource = text('src/core/release/physical-release-gates.ts');
const stageVerifierSource = text('src/core/release/npm-stage-tarball-verifier.ts');
const stageVerifierSupport = text('src/core/release/npm-stage-tarball-verifier-support.ts');
const stageVerifierCli = text('src/scripts/npm-stage-tarball-verifier.ts');
const releaseReadinessDoc = text('docs/release-readiness.md');
const workflowNpmStageVersion = stageWorkflow.match(/NPM_STAGE_CLI_VERSION:\s*([0-9]+\.[0-9]+\.[0-9]+)/)?.[1] || '';
const localNpmStageVersion = stageContract.match(/REQUIRED_NPM_STAGE_CLI_VERSION = '([0-9]+\.[0-9]+\.[0-9]+)'/)?.[1] || '';
for (const job of ['linux-release-proof', 'macos-menubar-proof', 'pack-and-compare', 'stage-publish']) {
  assertGate(new RegExp(`^  ${job}:`, 'm').test(stageWorkflow), `stage workflow missing job: ${job}`);
}
assertGate(/npm install --global npm@\$\{NPM_STAGE_CLI_VERSION\}/.test(stageWorkflow), 'stage workflow must install the exact pinned npm CLI');
assertGate(workflowNpmStageVersion === '11.15.0', 'stage workflow must pin npm 11.15.0', { version: workflowNpmStageVersion || null });
assertGate(localNpmStageVersion === workflowNpmStageVersion, 'local and workflow npm stage CLI versions must match', {
  local_version: localNpmStageVersion || null,
  workflow_version: workflowNpmStageVersion || null
});
assertGate(/npm stage publish "\$TARBALL"/.test(stageWorkflow), 'stage workflow must stage the exact tarball path');
assertGate((stageWorkflow.match(/npm stage publish "\$TARBALL"/g) || []).length === 1, 'stage workflow must contain exactly one registry mutation');
assertGate(!/\bnpm\s+publish\b/.test(stageWorkflow), 'stage workflow must not call direct npm publish');
assertGate(!/npm\s+stage\s+(?:list|view|download|approve|reject)\b/.test(stageWorkflow), 'OIDC stage job must not use maintainer-only stage subcommands');
assertGate(/environment: npm-production/.test(stageWorkflow), 'stage workflow must use the npm-production environment');
assertGate(!/id-token:/.test(workflowPermissions), 'workflow-global permissions must not grant OIDC identity');
assertGate((stageWorkflow.match(/id-token: write/g) || []).length === 1 && /permissions:\n      contents: read\n      id-token: write/.test(stageJob), 'OIDC identity must be scoped only to stage-publish');
for (const artifact of ['linux-release-proof', 'macos-menubar-proof', 'stage-input', 'npm-stage-receipt']) {
  assertGate(new RegExp(`name: ${artifact}-\\$\\{\\{ github\\.sha \\}\\}`).test(stageWorkflow), `stage workflow artifact name mismatch: ${artifact}`);
}
for (const receiptField of ['tarball_sha256', 'tarball_sha512', 'tarball_integrity', 'packed_bytes', 'unpacked_bytes', 'file_count', 'workflow_run_id', 'local_pack_receipt_sha256', 'stage_command_digest', 'stage_output_digest', 'stage_id', 'review_verifier_schema', 'human_2fa_pending']) {
  assertGate(new RegExp(`${receiptField}:`).test(stageJob), `stage receipt missing field: ${receiptField}`);
}
assertGate(/stage_id_uuid_invalid/.test(stageJob), 'stage workflow must fail closed on non-UUID stage IDs');
assertGate(/sha512Integrity !== receipt\.sha512_integrity/.test(stageJob), 'stage workflow must recompute and verify tarball SHA-512 integrity');
assertGate(/tarball_integrity: sha512Integrity/.test(stageJob), 'stage receipt must serialize recomputed tarball integrity');
assertGate(/stage-receipt\/stage-output\.json/.test(stageJob) && /path: stage-receipt/.test(stageJob), 'stage receipt artifact must preserve digest-bound raw stage output');
assertGate(/review_verifier_schema: 'sks\.npm-stage-review-receipt\.v1'/.test(stageJob), 'stage receipt must declare the maintainer verifier schema');
assertGate(/localPackReceiptSha256 = crypto\.createHash\('sha256'\)\.update\(localPackReceiptBytes\)/.test(stageJob), 'stage receipt must bind immutable local pack receipt bytes');
assertGate(/smoke\.postinstall_default\?\.scripts_enabled !== true/.test(stageJob), 'stage job must require scripts-enabled default postinstall proof');
assertGate(/smoke\.postinstall_default\?\.external_snapshot_match !== true/.test(stageJob), 'stage job must require zero external postinstall mutation');
assertGate(/smoke\.postinstall_default\.launchctl_calls\.length !== 0/.test(stageJob), 'stage job must require zero default postinstall launchctl calls');
assertGate(!/approve_command/.test(stageWorkflow), 'stage workflow must not serialize an approval command');
assertGate(!/\bnpm[ \t]+(?:ci|pack|run|publish|login|logout|whoami)\b/.test(stageJob), 'stage job must not install dependencies, repack, run lifecycle scripts, or use session credentials');
assertGate(!/NODE_AUTH_TOKEN|NPM_TOKEN|_authToken/.test(stageWorkflow), 'stage workflow must not inject npm tokens');
assertGate(/from '\.\/npm-stage-contract\.js'/.test(stageVerifierSupport), 'maintainer stage verifier support must use the shared npm stage contract');
assertGate(/exactNpmStageCliInvocation\(\)/.test(stageVerifierSource), 'maintainer stage verifier must resolve the exact pinned npm CLI');
assertGate(/\['stage', 'view', stageId, '--json'/.test(stageVerifierSource), 'maintainer stage verifier must inspect the exact stage ID read-only');
assertGate(/\['stage', 'download', stageId, '--json'/.test(stageVerifierSource), 'maintainer stage verifier must download the exact stage ID read-only');
assertGate(/exact_bytes_match/.test(stageVerifierSource) && /sha256_match/.test(stageVerifierSource) && /sha512_match/.test(stageVerifierSource) && /integrity_match/.test(stageVerifierSource), 'maintainer stage verifier must compare bytes and digests');
assertGate(/oidc_environment_not_allowed/.test(stageContract), 'maintainer stage verifier must reject OIDC and GitHub Actions environments');
assertGate(/local_review_verifier/.test(stagePublishSource), 'confirmed stage preflight must require the local review verifier');
assertGate(/localNpmStageReviewEnvironmentBlocker/.test(stagePublishSource), 'confirmed stage preflight must reject CI and OIDC review environments');
assertGate(/exactNpmStageCliInvocation\(\)/.test(stagePublishSource), 'confirmed stage preflight must resolve the pinned npm CLI before mutation');
assertGate(/if \(!preflight\.ok\) return finish\(\)/.test(stagePublishSource), 'stage preflight failures must stop before push or dispatch');
assertGate(!/\['stage',\s*'(?:publish|approve|reject)'/.test(`${stageVerifierSource}\n${stageVerifierSupport}\n${stageVerifierCli}`), 'maintainer stage verifier must not contain mutating stage argv');
assertGate(/npx --yes npm@11\.15\.0/.test(releaseReadinessDoc), 'release readiness must document pinned local npm stage resolution');
assertGate(/npm-stage-tarball-verifier\.js/.test(releaseReadinessDoc) && /--local-receipt/.test(releaseReadinessDoc) && /--local-tarball/.test(releaseReadinessDoc) && /--stage-receipt/.test(releaseReadinessDoc), 'release readiness must document the maintainer-local read-only verifier inputs');
assertGate(/release-physical-gates-check\.js/.test(stageWorkflow), 'stage workflow must verify tracked source-bound physical release receipts before staging');
assertGate(/release-physical-gates-check\.js/.test(stagePublishSource), 'local stage preflight must verify physical release receipts before mutation');
assertGate(/requirePhysicalReleaseGates:\s*!dryRun/.test(text('src/scripts/publish-preflight.ts')), 'real direct npm publish preflight must verify physical release receipts');
assertGate(/PHYSICAL_RELEASE_GATE_IDS/.test(physicalReleaseGateSource) && /artifact_sha256/.test(physicalReleaseGateSource), 'physical release gate contract must bind all required gates to evidence artifact hashes');
assertGate(pkg.scripts?.prepublishOnly === 'node ./dist/scripts/prepublish-release-check-or-fast.js', 'prepublishOnly must verify release proof during official npm publish');
assertGate(pkg.scripts?.prepack === 'node ./dist/scripts/prepublish-release-check-or-fast.js --prepack-build', 'prepack must rebuild and reverify official npm publish output');
assertGate(/publish-preflight\.js/.test(text('src/scripts/prepublish-release-check-or-fast.ts')), 'official npm publish must run the reproducibility preflight');
assertGate(/check-publish-tag\.js/.test(text('src/scripts/prepublish-release-check-or-fast.ts')), 'official npm publish must verify the exact dist-tag');

for (const file of requiredDocs) {
  const absolute = path.join(root, file);
  assertGate(fs.existsSync(absolute), `missing release doc: ${file}`);
  if (versionedDocs.has(file)) {
    assertGate(fs.readFileSync(absolute, 'utf8').includes(RELEASE_VERSION), `release doc does not mention ${RELEASE_VERSION}: ${file}`);
  }
}
const retiredPublicDocReferenceCount = requiredDocs
  .filter((file) => file !== 'CHANGELOG.md')
  .reduce((count, file) => {
    const source = text(file);
    const commandHit = /\bsks\s+(?:agent(?=\s|$)|--agent(?=\s|$)|team(?=\s|$)|mad-db(?=\s|$)|tmux(?=\s|$)|xai(?=\s|$)|swarm(?=\s|$)|ralph(?=\s|$))/i.test(source);
    const routeHit = /\$(?:Team|MAD-DB|Swarm|ShadowClone|Kagebunshin|Ralph)\b/.test(source);
    return count + Number(commandHit || routeHit);
  }, 0);
assertGate(retiredPublicDocReferenceCount === 0, 'current release documentation must not republish retired command or route identities', { violation_count: retiredPublicDocReferenceCount });

const report = {
  schema: 'sks.version-metadata-current.v1',
  version: RELEASE_VERSION,
  package_version: pkg.version,
  current_public_surface: true,
  official_subagent_workflow: true,
  version_surface_count: 9,
  package_script_count: requiredPackageScripts.length,
  release_gate_count: releaseGates.length,
  harness_gate_count: harnessGates.length,
  required_doc_count: requiredDocs.length,
  dist_source_digest: distManifest?.source_digest || null,
  generated_at: new Date().toISOString(),
  ok: true
};
const out = path.join(root, '.sneakoscope', 'reports', `version-metadata-${RELEASE_VERSION}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

emitGate('release:metadata', {
  version: pkg.version,
  package_scripts: requiredPackageScripts.length,
  release_gates: releaseGates.length,
  harness_gates: harnessGates.length,
  docs: requiredDocs.length,
  current_public_surface: true
});

function text(relFile: string): string {
  return fs.readFileSync(path.join(root, relFile), 'utf8');
}

function readJson(relFile: string): any {
  return JSON.parse(text(relFile));
}

function readJsonIfExists(relFile: string): any {
  const absolute = path.join(root, relFile);
  return fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : null;
}

function assertVersionSurface(relFile: string, needle: string): void {
  const absolute = path.join(root, relFile);
  assertGate(fs.existsSync(absolute), `missing version surface: ${relFile}`);
  const source = fs.readFileSync(absolute, 'utf8');
  assertGate(source.includes(needle), `${relFile} must contain ${needle}`, { file: relFile, needle });
}

function assertDistScriptTargetsExist(gate: any): void {
  for (const match of String(gate.command || '').matchAll(/node\s+(\.\/dist\/scripts\/[^ &|;]+\.js)/g)) {
    assertGate(fs.existsSync(path.join(root, match[1])), `gate command target missing: ${gate.id}`, {
      id: gate.id,
      target: match[1]
    });
  }
}
