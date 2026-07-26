#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const issues = [];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function readJson(rel) {
  return JSON.parse(read(rel));
}

function assertIncludes(rel, needle, message = `${rel} missing ${needle}`) {
  if (!read(rel).includes(needle)) issues.push(message);
}

function assertScript(name, expected) {
  const actual = String(pkg.scripts?.[name] || '');
  if (!actual.includes(expected)) issues.push(`package script ${name} must include ${expected}`);
}

const pkg = readJson('package.json');
const architectureBudgets = readJson('config/architecture-budgets.v1.json');
const releaseManifest = readJson('release-gates.v2.json');
const releaseGateIds = new Set((Array.isArray(releaseManifest?.gates) ? releaseManifest.gates : [])
  .filter((gate) => Array.isArray(gate?.preset) && gate.preset.includes('release'))
  .map((gate) => String(gate.id || '')));

assertScript('architecture:guard', 'node ./dist/scripts/architecture-guard-check.js');
if (!releaseGateIds.has('architecture:guard')) issues.push('release-gates.v2.json release preset missing architecture:guard');
if (architectureBudgets.schema !== 'sks.architecture-budgets.v1') issues.push('architecture budget schema must be sks.architecture-budgets.v1');
if (architectureBudgets.waiver_policy?.mode !== 'shrink-only') issues.push('architecture waivers must be shrink-only');
for (const [id, maxLines] of [
  ['menubar-typescript', 450],
  ['menubar-swift', 500],
  ['menubar-app-delegate', 250],
  ['pipeline-trust-evidence-proof', 1200],
  ['command-module', 900],
  ['default-handwritten-source', 1800]
]) {
  const rule = architectureBudgets.budgets?.find((candidate) => candidate?.id === id);
  if (rule?.max_lines !== maxLines) issues.push(`architecture budget ${id} must be ${maxLines}`);
}
if (architectureBudgets.split_review_lines !== 3000) issues.push('architecture split-review threshold must be 3000');
assertIncludes('src/scripts/check-architecture.ts', "git', ['merge-base'", 'architecture check must use git merge-base');
assertIncludes('src/scripts/check-architecture.ts', "args.includes('--strict-all')", 'architecture check must expose strict-all mode');
assertIncludes('src/scripts/check-architecture.ts', "'config', 'architecture-budgets.v1.json'", 'architecture check must load the budget SSOT');
assertIncludes('src/scripts/check-architecture.ts', 'shrink-only ceiling', 'architecture check must enforce shrink-only waivers');
assertIncludes('docs/architecture.md', '`config/architecture-budgets.v1.json`', 'architecture docs must name the budget SSOT');
for (const token of ['`250`', '`450`', '`500`', '`900`', '`1200`', '`1800`', '`3000`', '`--strict-all`', 'shrink-only']) {
  assertIncludes('docs/architecture.md', token, `architecture docs missing ${token}`);
}
assertIncludes('src/core/pipeline-internals/runtime-core.ts', "'ssot_guard'");
assertIncludes('src/core/pipeline-internals/runtime-core.ts', 'buildSsotGuard');
assertIncludes('src/core/pipeline-internals/runtime-gates.ts', 'validateSsotGuardArtifact');
assertIncludes('src/core/pipeline-internals/runtime-gates.ts', "'ssot_guard'");
assertIncludes('src/core/subagents/official-subagent-preparation.ts', 'SSOT_GUARD_ARTIFACT');
assertIncludes('src/core/subagents/official-subagent-preparation.ts', 'validateSsotGuardArtifact');
assertIncludes('src/scripts/release-parallel-check.ts', 'release-gate-dag-runner.js');
assertIncludes('src/scripts/release-parallel-check.ts', "'--preset', 'release', '--full'");
assertIncludes('src/core/release/gate-manifest.ts', "'architecture:guard'");
assertIncludes('src/core/release/gate-manifest.ts', "'architecture:'");
assertIncludes('docs/architecture-ts-rust-boundary.md', '`architecture:guard`');

const report = {
  schema: 'sks.architecture-guard-check.v1',
  ok: issues.length === 0,
  gate: 'architecture:guard',
  guarantees: ['ssot', 'merge-base', 'shrink-only'],
  issues
};

const reportDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'architecture-guard.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exitCode = 1;
