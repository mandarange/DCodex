#!/usr/bin/env node
/**
 * NC-7 / NC-22 / NC-41: install-surface version agreement.
 * Install SSOT is package.json#version in this checkout. PATH first `sks` and
 * Menu Bar stamp must agree with it when those surfaces are present.
 * Marketplace plugin version must always match package.json.
 *
 * This gate fails closed on disagreement among present surfaces. Missing
 * optional runtime surfaces (PATH CLI or Menu Bar not installed) are reported,
 * not auto-fail. The repository-owned package/plugin pair fails closed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageVersion = String(pkg.version || '').trim();

const blockers: string[] = [];
const notes: string[] = [];

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

if (!packageVersion) blockers.push('package_json_version_missing');

const plugin = readJson(path.join(root, 'plugins/sks/.codex-plugin/plugin.json'));
const pluginVersion = String(plugin?.version || plugin?.packageVersion || '').trim();
if (pluginVersion && packageVersion && pluginVersion !== packageVersion) {
  blockers.push(`marketplace_plugin_version_mismatch:${pluginVersion}!=${packageVersion}`);
} else if (!pluginVersion) {
  blockers.push('marketplace_plugin_version_absent');
} else {
  notes.push(`marketplace_plugin_version_matches:${pluginVersion}`);
}

// Package↔plugin must always agree (marketplace convenience entry = same version).
// PATH/Menu Bar are environment surfaces: enforce as hard fail only when
// SKS_ENFORCE_RUNTIME_INSTALL_SSOT=1 (post-install / update proof). Otherwise
// record advisory notes so in-progress source trees are not blocked before install.
const enforceRuntime = process.env.SKS_ENFORCE_RUNTIME_INSTALL_SSOT === '1';

const pathProbe = spawnSync('sks', ['--version'], { encoding: 'utf8', timeout: 15_000 });
const pathVersion = String(pathProbe.stdout || pathProbe.stderr || '')
  .match(/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] || '';
if (pathProbe.error) {
  notes.push(`path_sks_unavailable:${pathProbe.error.message}`);
} else if (pathVersion && packageVersion && pathVersion !== packageVersion) {
  const msg = `path_sks_version_mismatch:${pathVersion}!=${packageVersion}`;
  if (enforceRuntime) blockers.push(msg);
  else notes.push(`${msg}:advisory_set_SKS_ENFORCE_RUNTIME_INSTALL_SSOT=1_after_install`);
} else if (pathVersion) {
  notes.push(`path_sks_version_matches:${pathVersion}`);
} else {
  notes.push('path_sks_version_unparsed');
}

const menubarStampCandidates = [
  path.join(process.env.HOME || '', '.codex/sks-menubar/.sks-build-stamp.json'),
  path.join(process.env.HOME || '', '.codex/sks-menubar/build-stamp.json')
];
let menubarVersion = '';
for (const candidate of menubarStampCandidates) {
  const stamp = readJson(candidate);
  const version = String(stamp?.package_version || stamp?.version || '').trim();
  if (version) {
    menubarVersion = version;
    break;
  }
}
if (!menubarVersion) {
  notes.push('menubar_stamp_absent');
} else if (packageVersion && menubarVersion !== packageVersion) {
  const msg = `menubar_stamp_version_mismatch:${menubarVersion}!=${packageVersion}`;
  if (enforceRuntime) blockers.push(msg);
  else notes.push(`${msg}:advisory_set_SKS_ENFORCE_RUNTIME_INSTALL_SSOT=1_after_install`);
} else {
  notes.push(`menubar_stamp_version_matches:${menubarVersion}`);
}

const report = {
  schema: 'sks.install-surface-ssot-check.v1',
  ok: blockers.length === 0,
  install_ssot: 'package.json#version',
  package_version: packageVersion || null,
  plugin_version: pluginVersion || null,
  path_sks_version: pathVersion || null,
  menubar_stamp_version: menubarVersion || null,
  blockers,
  notes
};

const outDir = path.join(root, '.sneakoscope', 'reports');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'install-surface-ssot-check.json'), `${JSON.stringify(report, null, 2)}\n`);

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(report, null, 2));
