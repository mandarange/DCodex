#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, root } from './gate-lib.js';

const args = process.argv.slice(2);
const publish = args.includes('--publish');
const pkg = readJson('package.json');
const version = pkg.version;
const currentBranch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
const currentCommit = git(['rev-parse', 'HEAD']);
const dist = readJson('dist/build-manifest.json', null);
const srcVersion = readVersionFrom('src/core/version.ts', /PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/);
const fsxReExportsVersion = /PACKAGE_VERSION\s*}\s*from\s*['"]\.\/version(?:\.js)?['"]/.test(readText('src/core/fsx.ts'));
const fsxVersion = fsxReExportsVersion
  ? srcVersion
  : readVersionFrom('src/core/fsx.ts', /PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/);
const cargoVersion = readVersionFrom('crates/sks-core/Cargo.toml', /^version\s*=\s*"([^"]+)"/m);
const latestChangelog = latestVersionedChangelogSection(readText('CHANGELOG.md'));
const tag = tagStatus(version, currentCommit);
const candidate = candidateVersion();
const originMain = originMainVersion();
const npm = publish
  ? npmVersion()
  : { version: null, status: 'not_checked_in_dev_review' };
const warnings = [];
const blockers = [];

if (candidate.version && candidate.version !== version) blockers.push('candidate_version_mismatch');
if (originMain.version && originMain.version !== version) warnings.push('origin_main_out_of_date');
if (publish && tag.exists && tag.commit !== currentCommit) blockers.push('tag_not_on_current_commit');
if (publish && npm.version && semverCompare(npm.version, version) >= 0) blockers.push('npm_version_already_published_or_ahead');
for (const [name, actual] of Object.entries({ dist_package_version: dist?.package_version, dist_version: dist?.version, src_version: srcVersion, fsx_version: fsxVersion, cargo_version: cargoVersion, changelog: latestChangelog })) {
  if (actual !== version) blockers.push(`${name}_mismatch`);
}

const report = {
  schema: 'sks.release-provenance.v1',
  ok: blockers.length === 0,
  mode: publish ? 'publish' : 'dev_review',
  reviewed_ref: currentBranch || 'unknown',
  current_branch: currentBranch,
  current_git_commit: currentCommit,
  package_version: version,
  dist_build_manifest_version: dist?.package_version || null,
  src_versions: { version_ts: srcVersion, fsx_ts: fsxVersion },
  cargo_version: cargoVersion,
  latest_changelog_section: latestChangelog,
  main_version: candidate.version,
  main_commit: candidate.commit,
  main_status: candidate.status,
  origin_main_version: originMain.version,
  origin_main_commit: originMain.commit,
  origin_main_status: originMain.status,
  npm_version: npm.version,
  npm_status: npm.version ? (semverCompare(npm.version, version) < 0 ? 'registry_behind_candidate' : npm.version === version ? 'candidate_already_published' : 'registry_ahead') : npm.status,
  tag_status: tag,
  warnings,
  blockers,
  generated_at: new Date().toISOString()
};
const out = path.join(root, '.sneakoscope', 'reports', 'release-provenance.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
assertGate(report.ok, 'release provenance blockers', report);
emitGate('release:provenance', { mode: report.mode, reviewed_ref: report.reviewed_ref, warnings: warnings.length, blockers: blockers.length });

function git(argv) {
  const res = spawnSync('git', argv, { cwd: root, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
}

function candidateVersion() {
  const ref = git(['rev-parse', '--verify', 'HEAD']);
  try {
    return { version: pkg.version || null, commit: ref, status: 'working_tree_candidate' };
  } catch {
    return { version: null, commit: ref, status: 'unparseable' };
  }
}

function originMainVersion() {
  const ref = git(['rev-parse', '--verify', 'origin/main']);
  if (!ref) return { version: null, commit: null, status: 'unavailable' };
  const res = spawnSync('git', ['show', 'origin/main:package.json'], { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) return { version: null, commit: ref, status: 'package_unavailable' };
  try {
    return { version: JSON.parse(res.stdout).version || null, commit: ref, status: 'ok' };
  } catch {
    return { version: null, commit: ref, status: 'unparseable' };
  }
}

function npmVersion() {
  const res = spawnSync('npm', ['view', `${pkg.name}`, 'version'], { cwd: root, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) return { version: null, status: 'unavailable', stderr_tail: tail(res.stderr) };
  return { version: res.stdout.trim() || null, status: 'ok' };
}

function tagStatus(version, currentCommit) {
  const tagName = `v${version}`;
  const commit = git(['rev-list', '-n', '1', tagName]);
  if (!commit) return { tag: tagName, exists: false, commit: null, matches_current: false };
  return { tag: tagName, exists: true, commit, matches_current: commit === currentCommit };
}

function readJson(rel, fallback) {
  try {
    return JSON.parse(readText(rel));
  } catch {
    if (arguments.length > 1) return fallback;
    throw new Error(`failed to read ${rel}`);
  }
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function readVersionFrom(rel, re) {
  return readText(rel).match(re)?.[1] || null;
}

function semverCompare(a, b) {
  const av = String(a).split('.').map((n) => Number(n));
  const bv = String(b).split('.').map((n) => Number(n));
  for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function latestVersionedChangelogSection(text) {
  for (const match of text.matchAll(/^## \[([^\]]+)\]/gm)) {
    if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(match[1])) return match[1];
  }
  return null;
}

function tail(value, limit = 1000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}
