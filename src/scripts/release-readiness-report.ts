#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkg = readJson('package.json', {});
const lock = readJson('package-lock.json', {});
const manifest = readJson('release-gates.v2.json', { gates: [] });
const version = String(pkg.version || 'unknown');
const canonicalReportDir = path.join(root, '.sneakoscope', 'reports');
const reportDir = process.env.SKS_RELEASE_READINESS_REPORT_DIR
  ? path.resolve(process.env.SKS_RELEASE_READINESS_REPORT_DIR)
  : canonicalReportDir;
const canonicalReleaseStampPath = path.join(canonicalReportDir, 'release-check-stamp.json');
const releaseStampPath = process.env.SKS_RELEASE_STAMP_PATH || canonicalReleaseStampPath;
const evidenceScope = path.resolve(reportDir) === path.resolve(canonicalReportDir)
  && path.resolve(releaseStampPath) === path.resolve(canonicalReleaseStampPath)
  ? 'production'
  : 'fixture';
const jsonPath = path.join(reportDir, `release-readiness-${version}.json`);
const mdPath = path.join(reportDir, `release-readiness-${version}.md`);
const gates = Array.isArray(manifest.gates) ? manifest.gates : [];
const gateIds = new Set(gates.map((gate) => String(gate.id || '')));
const scriptNames = Object.keys(pkg.scripts || {});
const codexSdkVersion = String(pkg.dependencies?.['@openai/codex-sdk'] || '');

const requiredGateGroups = {
  codex_current: [
    'codex:current:dependency-graph',
    'codex:current:binary-identity',
    'codex:current:policy',
    'codex:current:app-server-v2',
    'codex:current:thread-store',
    'codex:current:capability'
  ],
  codex_desktop: [
    'codex-app:fast-ui-preservation',
    'doctor:fixes-codex-app-fast-ui',
    'desktop-bridge:comprehensive',
    'native-capability:repair-matrix',
    'native:image-generation-repair',
    'mcp:plugin-inventory'
  ],
  voxel_triwiki: [
    'triwiki:proof-comprehensive',
    'triwiki:cache-key',
    'shared-memory:check',
    'wrongness:check'
  ],
  release_integrity: [
    'policy:gate-audit',
    'typecheck',
    'test:proof-stop-gate',
    'test:commands-regression',
    'release:proof-truth',
    'release:provenance',
    'release:runtime-truth-matrix',
    'package:published-contract',
    'publish:packlist-performance',
    'publish:runtime-script-closure'
  ],
  flagship_routes: [
    'ux-review:run-wires-imagegen',
    'ux-review:extract-wires-real-extractor',
    'ux-review:patch-diff-recheck',
    'ux-review:imagegen-blackbox',
    'ppt:real-export-adapter',
    'ppt:real-imagegen-wiring',
    'ppt:reexport-rereview',
    'ppt:full-e2e-blackbox',
    'dfix:fixture',
    'dfix:patch-handoff',
    'dfix:verification-recommendation',
    'dfix:verification',
    'evidence:flagship-coverage',
    'all-features:deep-completion'
  ]
};

const requiredScripts = [
  'build',
  'test',
  'typecheck',
  'release:check:full',
  'release:real-check',
  'release:pack-receipt',
  'release:macos-menubar-proof',
  'runtime:installed-smoke'
];
const remainingP0 = [];
const duplicateGateIds = duplicateValues(gates.map((gate) => String(gate.id || '')));
if (manifest.schema !== 'sks.release-gates.v2') remainingP0.push('release_gate_manifest_schema_invalid');
if (gates.length < 1 || gates.length > 200) remainingP0.push('release_gate_count_out_of_budget');
if (duplicateGateIds.length) remainingP0.push(`release_gate_ids_duplicate:${duplicateGateIds.join(',')}`);
if (scriptNames.length > 101) remainingP0.push(`package_script_budget_exceeded:${scriptNames.length}`);
for (const name of requiredScripts) if (!pkg.scripts?.[name]) remainingP0.push(`required_script_missing:${name}`);
for (const [group, ids] of Object.entries(requiredGateGroups)) {
  for (const id of ids) if (!gateIds.has(id)) remainingP0.push(`${group}_gate_missing:${id}`);
}

const versionTruth = {
  package: version,
  package_lock: String(lock.packages?.['']?.version || ''),
  version_ts: versionFromText(readText('src/core/version.ts')),
  cargo: cargoVersion(readText('crates/sks-core/Cargo.toml')),
  dist_build_manifest: String(readJson('dist/build-manifest.json', {}).version || ''),
  codex_dependency_target: codexSdkVersion ? `rust-v${codexSdkVersion}` : '',
  codex_sdk: String(pkg.dependencies?.['@openai/codex-sdk'] || ''),
  codex_sdk_lock: String(lock.packages?.['node_modules/@openai/codex-sdk']?.version || ''),
  codex_cli_lock: String(lock.packages?.['node_modules/@openai/codex']?.version || '')
};
for (const [id, actual] of Object.entries({
  package_lock: versionTruth.package_lock,
  version_ts: versionTruth.version_ts,
  cargo: versionTruth.cargo,
  dist_build_manifest: versionTruth.dist_build_manifest
})) if (actual !== version) remainingP0.push(`version_mismatch:${id}:${actual || 'missing'}`);
for (const [id, actual] of Object.entries({
  codex_sdk: versionTruth.codex_sdk,
  codex_sdk_lock: versionTruth.codex_sdk_lock,
  codex_cli_lock: versionTruth.codex_cli_lock
})) if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(codexSdkVersion) || actual !== codexSdkVersion) {
  remainingP0.push(`codex_current_dependency_mismatch:${id}:${actual || 'missing'}`);
}

const checks = {
  docs_truthfulness: runScript('dist/scripts/docs-truthfulness-check.js'),
  official_docs_compat: runScript('dist/scripts/official-docs-compat-report.js', 60_000),
  release_metadata: runScript('dist/scripts/release-metadata-check.js', 60_000),
  release_provenance: runScript('dist/scripts/release-provenance-check.js'),
  imagegen_capability: runScript('dist/scripts/imagegen-capability-check.js'),
  physical_release_gates: runScript('dist/scripts/release-physical-gates-check.js'),
  stamp_verification: runScript('dist/scripts/release-check-stamp.js', 30_000, ['verify'])
};
for (const [id, check] of Object.entries(checks)) {
  if (id !== 'physical_release_gates' && !check.ok) remainingP0.push(`${id}_failed`);
}

const stamp = readJson(releaseStampPath, null);
const physicalGateReport = parseJsonOutput(checks.physical_release_gates.stdout);
const publishBlockers = [];
if (evidenceScope !== 'production') publishBlockers.push('release_evidence_scope_is_fixture');
if (!checks.physical_release_gates.ok) {
  const physicalBlockers = Array.isArray(physicalGateReport?.blockers) ? physicalGateReport.blockers : ['physical_release_gates_invalid'];
  publishBlockers.push(...physicalBlockers.map((blocker) => `physical:${blocker}`));
}
if (!checks.stamp_verification.ok) publishBlockers.push('production_release_stamp_invalid');
const stageDispatchReady = remainingP0.length === 0 && publishBlockers.length === 0;
const statusFor = (group) => requiredGateGroups[group].every((id) => gateIds.has(id)) ? 'present' : 'missing';
const report = {
  schema: 'sks.release-readiness.v1',
  generated_at: new Date().toISOString(),
  evidence_scope: evidenceScope,
  scope: {
    release_version: version,
    gate: `${version} current release DAG`,
    ok_means: `current ${version} release contract, package-tracked Codex ${codexSdkVersion || 'dependency'}, runtime-generated capability evidence, native capability self-repair, Voxel TriWiki, flagship routes, and signed full-run stamp have no structural blocker`,
    legacy_report_surfaces_removed: true,
    strict_readiness_mode: true
  },
  package: { name: pkg.name, version },
  manifest: {
    schema: manifest.schema || null,
    gate_count: gates.length,
    unique_gate_count: gateIds.size,
    package_script_count: scriptNames.length,
    gate_budget_ok: gates.length <= 200,
    script_budget_ok: scriptNames.length <= 101,
    duplicate_gate_ids: duplicateGateIds
  },
  version_truth: versionTruth,
  codex_current: { status: statusFor('codex_current'), gates: requiredGateGroups.codex_current },
  codex_desktop_capabilities: { status: statusFor('codex_desktop'), gates: requiredGateGroups.codex_desktop },
  voxel_triwiki: { status: statusFor('voxel_triwiki'), gates: requiredGateGroups.voxel_triwiki },
  image_ux_review: { status: statusFor('flagship_routes'), gates: requiredGateGroups.flagship_routes.filter((id) => id.startsWith('ux-review:')) },
  ppt_imagegen_review: { status: statusFor('flagship_routes'), gates: requiredGateGroups.flagship_routes.filter((id) => id.startsWith('ppt:')) },
  dfix: { status: statusFor('flagship_routes'), gates: requiredGateGroups.flagship_routes.filter((id) => id.startsWith('dfix:')) },
  all_features_completion: { status: statusFor('flagship_routes'), gates: ['evidence:flagship-coverage', 'all-features:deep-completion'] },
  release_integrity: { status: statusFor('release_integrity'), gates: requiredGateGroups.release_integrity },
  checks,
  release_gate_last_pass_stamp: stamp ? {
    package_version: stamp.package_version || null,
    generated_at: stamp.generated_at || null,
    git_commit: stamp.git_commit || stamp.source_commit || null,
    source_digest: stamp.source_digest || null,
    full_release_proof: stamp.full_release_proof || stamp.proof_scope || null
  } : null,
  non_publish_gaps: [],
  legacy_report_only_gaps: [],
  remaining_p0_gaps: [...new Set(remainingP0)],
  publish_blockers: [...new Set(publishBlockers)],
  stage_dispatch_ready: stageDispatchReady,
  publish_ready: stageDispatchReady,
  ok: remainingP0.length === 0
};

writeReadinessReports();
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;

function writeReadinessReports() {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, renderMarkdown(report));
}

function runScript(rel, timeout = 30_000, args = []) {
  const result = spawnSync(process.execPath, [rel, ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, CI: 'true' }, timeout });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || null,
    stdout: String(result.stdout || '').slice(-4000),
    stderr: String(result.stderr || '').slice(-4000)
  };
}

function duplicateValues(values) {
  const seen = new Set();
  const duplicates = new Set();
  for (const value of values) value && (seen.has(value) ? duplicates.add(value) : seen.add(value));
  return [...duplicates].sort();
}

function versionFromText(text) {
  return text.match(/PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/)?.[1] || '';
}

function cargoVersion(text) {
  return text.match(/^version\s*=\s*['"]([^'"]+)['"]/m)?.[1] || '';
}

function readJson(rel, fallback) {
  const file = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readText(rel) {
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

function parseJsonOutput(value) {
  try { return JSON.parse(String(value || '')); } catch { return null; }
}

function renderMarkdown(value) {
  const lines = [
    '# Release Readiness',
    '',
    `- Version: \`${value.package.version}\``,
    `- Status: **${value.ok ? 'PASS' : 'BLOCKED'}**`,
    `- Evidence scope: \`${value.evidence_scope}\``,
    `- Stage dispatch ready: **${value.stage_dispatch_ready ? 'YES' : 'NO'}**`,
    `- Gates: ${value.manifest.gate_count} / 200`,
    `- Package scripts: ${value.manifest.package_script_count} / 101`,
    `- Codex: \`${value.version_truth.codex_manifest_target}\``,
    '',
    '## Current surfaces',
    '',
    `- Current Codex: ${value.codex_current.status}`,
    `- Codex Desktop capabilities: ${value.codex_desktop_capabilities.status}`,
    `- Voxel TriWiki: ${value.voxel_triwiki.status}`,
    `- Image UX Review: ${value.image_ux_review.status}`,
    `- PPT Imagegen Review: ${value.ppt_imagegen_review.status}`,
    `- DFix: ${value.dfix.status}`,
    '',
    `Remaining P0 gaps: ${value.remaining_p0_gaps.length ? value.remaining_p0_gaps.join(', ') : 'None'}`,
    `Publish blockers: ${value.publish_blockers.length ? value.publish_blockers.join(', ') : 'None'}`
  ];
  return `${lines.join('\n')}\n`;
}
