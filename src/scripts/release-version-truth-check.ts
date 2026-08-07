#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertGate, emitGate, root } from './gate-lib.js';

const pkg = readJson('package.json');
const expected = String(pkg.version || '');
const mismatches = [];
const warnings = [];
let checked = 0;

checkJson('package.json', 'version', pkg.version);
const lock = readJson('package-lock.json');
checkJson('package-lock.json', 'version', lock.version);
checkJson('package-lock.json', 'packages[""].version', lock.packages?.['']?.version);
const plugin = readJson('plugins/sks/.codex-plugin/plugin.json');
checkJson('plugins/sks/.codex-plugin/plugin.json', 'version', plugin.version);
checkRegex('src/core/version.ts', /PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/, 'PACKAGE_VERSION');
checkReExportOrRegex('src/core/fsx.ts', /PACKAGE_VERSION\s*}\s*from\s*['"]\.\/version(?:\.js)?['"]/, /PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/, 'PACKAGE_VERSION');
checkReExportOrRegex('src/bin/sks.ts', /PACKAGE_VERSION\s*}\s*from\s*['"]\.\.\/core\/version(?:\.js)?['"]/, /FAST_PACKAGE_VERSION\s*=\s*['"]([^'"]+)['"]/, 'FAST_PACKAGE_VERSION');
checkRegex('crates/sks-core/Cargo.toml', /^version\s*=\s*"([^"]+)"/m, 'package.version');
checkCargoLock('crates/sks-core/Cargo.lock', 'sks-core');
const dist = readJson('dist/build-manifest.json', null);
checkJson('dist/build-manifest.json', 'package_version', dist?.package_version);
checkJson('dist/build-manifest.json', 'version', dist?.version);
checkChangelog();
checkReadme();
checkReleaseMetadataScript();
checkCargoMetadata();

const ok = mismatches.length === 0;
const report = {
  schema: 'sks.release-version-truth.v1',
  ok,
  expected,
  checked,
  mismatches,
  warnings,
  generated_at: new Date().toISOString()
};
const out = path.join(root, '.sneakoscope', 'reports', 'release-version-truth.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

assertGate(ok, 'release version truth mismatch', { expected, mismatches });
emitGate('release:version-truth', { version: expected, checked, warnings: warnings.length });

function checkJson(file, field, actual) {
  checked += 1;
  if (actual !== expected) mismatch(file, field, actual);
}

function checkRegex(file, re, field) {
  checked += 1;
  const text = readText(file);
  const match = text.match(re);
  if (!match) mismatch(file, field, null);
  else if (match[1] !== expected) mismatch(file, field, match[1]);
}

function checkReExportOrRegex(file, reExportRe, literalRe, field) {
  const text = readText(file);
  if (reExportRe.test(text)) {
    checked += 1;
    return;
  }
  checkRegex(file, literalRe, field);
}

function checkCargoLock(file, name) {
  checked += 1;
  const text = readText(file);
  const block = text.split(/\n\[\[package\]\]\n/).find((part) => new RegExp(`name\\s*=\\s*"${escapeRe(name)}"`).test(part));
  const match = block?.match(/version\s*=\s*"([^"]+)"/);
  if (!match) mismatch(file, `${name}.version`, null);
  else if (match[1] !== expected) mismatch(file, `${name}.version`, match[1]);
}

function checkChangelog() {
  checked += 1;
  const text = readText('CHANGELOG.md');
  const latest = latestVersionedChangelogSection(text);
  if (latest !== expected) mismatch('CHANGELOG.md', 'latest release section', latest);
}

function checkReadme() {
  checked += 1;
  const text = readText('README.md');
  // README renders the banner as `Current release: **SKS 7.1.3**` — the bold wraps `SKS <version>`,
  // not the version alone. Fail closed when the banner is absent so a stale README cannot pass by
  // simply not matching.
  const displayed = text.match(/\*\*SKS ([0-9]+\.[0-9]+\.[0-9]+)\*\*/)?.[1] || null;
  if (!displayed) mismatch('README.md', 'displayed current version', null);
  else if (displayed !== expected) mismatch('README.md', 'displayed current version', displayed);
}

function checkReleaseMetadataScript() {
  checked += 1;
  const script = String(pkg.scripts?.['release:metadata'] || '');
  if (!script.includes('dist/scripts/release-metadata-check.js')) {
    mismatch('package.json', 'scripts.release:metadata', script || null, 'node ./dist/scripts/release-metadata-check.js');
  }
}

function checkCargoMetadata() {
  checked += 1;
  const res = spawnSync('cargo', ['metadata', '--no-deps', '--manifest-path', path.join(root, 'crates/sks-core/Cargo.toml'), '--format-version', '1'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000
  });
  if (res.status !== 0) {
    warnings.push({ file: 'crates/sks-core/Cargo.toml', message: 'cargo metadata unavailable', stderr_tail: tail(res.stderr) });
    return;
  }
  try {
    const metadata = JSON.parse(res.stdout);
    const crate = metadata.packages?.find((row) => row.name === 'sks-core');
    if (crate?.version !== expected) mismatch('cargo metadata', 'sks-core.version', crate?.version || null);
  } catch (err) {
    warnings.push({ file: 'cargo metadata', message: `unparseable:${err instanceof Error ? err.message : String(err)}` });
  }
}

function mismatch(file, field, actual, wanted = expected) {
  mismatches.push({ file, field, expected: wanted, actual: actual ?? null });
}

function readJson(rel, fallback) {
  try {
    return JSON.parse(readText(rel));
  } catch (err) {
    if (arguments.length > 1) return fallback;
    throw err;
  }
}

function readText(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
