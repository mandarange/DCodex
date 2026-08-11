#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_PACK_BYTES, DEFAULT_MAX_UNPACKED_BYTES } from '../core/release/package-size-budget.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const limits = {
  packedBytes: Number(process.env.SKS_MAX_PACK_BYTES || DEFAULT_MAX_PACK_BYTES),
  unpackedBytes: Number(process.env.SKS_MAX_UNPACKED_BYTES || DEFAULT_MAX_UNPACKED_BYTES),
  packFiles: Number(process.env.SKS_MAX_PACK_FILES || 2100),
  trackedFileBytes: Number(process.env.SKS_MAX_TRACKED_FILE_BYTES || 384 * 1024)
};
const trackedFileSizeAllowlist = new Set([
  'release-gates.v2.json'
]);
const trackedFileSizeBudgets = new Map([
  // Append-only release history and the generated mutation policy are large
  // by design, but remain independently bounded instead of bypassing checks.
  ['CHANGELOG.md', 512 * 1024],
  ['safety-mutation-allowlist.json', 512 * 1024],
  // The code-navigation manifest is generated project memory and is excluded
  // from the npm tarball; keep a finite repository budget for it.
  ['.sneakoscope/wiki/code-navigation-manifest.json', 768 * 1024]
]);

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function fail(message, detail = '') {
  console.error(`Size check failed: ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(2);
}

function fmt(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: root,
    encoding: 'utf8',
    ...options
  });
}

function checkTrackedFiles() {
  const result = run('git', ['ls-files', '-z'], { encoding: 'buffer' });
  if (result.status !== 0) fail('unable to list tracked files', result.stderr?.toString('utf8') || '');
  const files = result.stdout.toString('utf8').split('\0').filter(Boolean);
  const oversized = [];
  for (const file of files) {
    if (trackedFileSizeAllowlist.has(file)) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(root, file));
    } catch (err) {
      if (err?.code === 'ENOENT') continue;
      throw err;
    }
    const fileLimit = trackedFileSizeBudgets.get(file) || limits.trackedFileBytes;
    if (stat.size > fileLimit) oversized.push(`${file} (${fmt(stat.size)} > ${fmt(fileLimit)})`);
  }
  if (oversized.length) {
    fail('tracked file exceeds configured limit', oversized.join('\n'));
  }
}

function checkVersionSync() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const source = fs.readFileSync(path.join(root, 'src', 'core', 'version.ts'), 'utf8');
  const fsx = fs.readFileSync(path.join(root, 'src', 'core', 'fsx.ts'), 'utf8');
  const tsBin = fs.readFileSync(path.join(root, 'src', 'bin', 'sks.ts'), 'utf8');
  const cargoToml = fs.readFileSync(path.join(root, 'crates', 'sks-core', 'Cargo.toml'), 'utf8');
  const cargoLock = fs.readFileSync(path.join(root, 'crates', 'sks-core', 'Cargo.lock'), 'utf8');
  const cargoMain = fs.readFileSync(path.join(root, 'crates', 'sks-core', 'src', 'main.rs'), 'utf8');
  const sourceVersion = source.match(/export const PACKAGE_VERSION = ['"]([^'"]+)['"];/)?.[1];
  const fsxReExportsVersion = /PACKAGE_VERSION\s*}\s*from\s*['"]\.\/version(?:\.js)?['"]/.test(fsx);
  const fsxVersion = fsxReExportsVersion ? sourceVersion : fsx.match(/export const PACKAGE_VERSION = ['"]([^'"]+)['"];/)?.[1];
  const tsBinReExportsVersion = /PACKAGE_VERSION\s*}\s*from\s*['"]\.\.\/core\/version(?:\.js)?['"]/.test(tsBin);
  const tsBinVersion = tsBinReExportsVersion ? sourceVersion : tsBin.match(/const FAST_PACKAGE_VERSION = ['"]([^'"]+)['"];/)?.[1];
  const cargoTomlVersion = cargoToml.match(/^version = "([^"]+)"/m)?.[1];
  const cargoLockVersion = cargoLock.match(/\[\[package\]\]\nname = "sks-core"\nversion = "([^"]+)"/)?.[1];
  const cargoMainUsesCargoPkgVersion = /env!\(\s*"CARGO_PKG_VERSION"\s*\)/.test(cargoMain);
  const cargoMainVersion = cargoMainUsesCargoPkgVersion ? cargoTomlVersion : cargoMain.match(/println!\("sks-rs ([^"]+)"\)/)?.[1];
  const lockRootVersion = lock.packages?.['']?.version;
  const mismatches = [
    ['package-lock.json version', lock.version],
    ['package-lock root package version', lockRootVersion],
    ['src/core/version.ts PACKAGE_VERSION', sourceVersion],
    ['src/core/fsx.ts PACKAGE_VERSION', fsxVersion],
    ['src/bin/sks.ts FAST_PACKAGE_VERSION', tsBinVersion],
    ['crates/sks-core/Cargo.toml version', cargoTomlVersion],
    ['crates/sks-core/Cargo.lock sks-core version', cargoLockVersion],
    ['crates/sks-core/src/main.rs sks-rs version', cargoMainVersion]
  ].filter(([, version]) => version !== pkg.version);
  if (mismatches.length) {
    fail('package version metadata is not synchronized', [
      `package.json version: ${pkg.version}`,
      ...mismatches.map(([label, version]) => `${label}: ${version || 'missing'}`)
    ].join('\n'));
  }
}

function checkPackageFootprint() {
  const env = {
    ...process.env,
    npm_config_cache: process.env.SKS_SIZECHECK_NPM_CACHE || path.join(os.tmpdir(), 'sneakoscope-npm-cache')
  };
  const result = run(npmBin, ['pack', '--dry-run', '--json', '--ignore-scripts'], { env });
  if (result.status !== 0) fail('npm pack dry-run failed', `${result.stdout || ''}\n${result.stderr || ''}`);

  let info;
  try {
    info = JSON.parse(result.stdout)[0];
  } catch {
    fail('npm pack dry-run returned non-json output', result.stdout || '');
  }
  if (!info) fail('npm pack dry-run returned no package metadata');

  const forbiddenPatterns = [
    /^\.agents\//,
    /^\.codex\//,
    /^\.dcodex\//,
    /^\.omx\//,
    /^\.sneakoscope\//,
    /^native\//,
    /^node_modules\//,
    /^scripts\//,
    /^tmp\//,
    /^logs\//,
    /\.(tgz|zip|tar|tar\.gz|log)$/i
  ];
  const forbidden = (info.files || [])
    .map((file) => file.path)
    .filter((file) => forbiddenPatterns.some((pattern) => pattern.test(file)));
  if (forbidden.length) fail('npm package includes forbidden files', forbidden.join('\n'));
  if (info.size > limits.packedBytes) fail(`npm tarball exceeds ${fmt(limits.packedBytes)}`, `${info.filename}: ${fmt(info.size)}`);
  if (info.unpackedSize > limits.unpackedBytes) fail(`npm unpacked size exceeds ${fmt(limits.unpackedBytes)}`, `${info.filename}: ${fmt(info.unpackedSize)}`);
  if (info.entryCount > limits.packFiles) fail(`npm package file count exceeds ${limits.packFiles}`, `${info.entryCount} files`);

  console.log(`Size check passed: ${fmt(info.size)} packed, ${fmt(info.unpackedSize)} unpacked, ${info.entryCount} files.`);
}

checkTrackedFiles();
checkVersionSync();
checkPackageFootprint();
