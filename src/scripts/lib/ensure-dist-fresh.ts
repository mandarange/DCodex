// @ts-nocheck
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(
  process.env.SKS_BUILD_SOURCE_ROOT
  || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
);
const distRoot = path.resolve(process.env.SKS_BUILD_OUTPUT_DIR || path.join(root, 'dist'));
export const distStampPath = path.join(distRoot, '.sks-build-stamp.json');
export const reportStampPath = path.join(root, '.sneakoscope', 'reports', 'dist-build-stamp.json');

export function sourceSnapshot() {
  const files = releaseRelevantFiles();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
    const buf = fs.readFileSync(full);
    hash.update(file);
    hash.update('\0');
    hash.update(String(buf.length));
    hash.update('\0');
    hash.update(sha256(buf));
    hash.update('\0');
  }
  return { digest: hash.digest('hex'), file_count: files.length, files };
}

export function currentDistFreshness() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const snapshot = sourceSnapshot();
  const stamp = readJson(distStampPath) || readJson(path.join(distRoot, 'build-manifest.json'));
  const issues = [];
  if (!stamp) issues.push('dist_build_stamp_missing');
  if (stamp && stamp.package_version !== pkg.version && stamp.version !== pkg.version) issues.push(`dist_version:${stamp.package_version || stamp.version || 'missing'}!=${pkg.version}`);
  if (stamp && stamp.source_digest !== snapshot.digest) issues.push('dist_source_digest_stale');
  if (!fs.existsSync(path.join(distRoot, 'bin', 'sks.js'))) issues.push('dist_bin_missing');
  return {
    schema: 'sks.dist-freshness.v1',
    ok: issues.length === 0,
    package_version: pkg.version,
    source_digest: snapshot.digest,
    source_file_count: snapshot.file_count,
    stamp_path: fs.existsSync(distStampPath) ? distStampPath : path.join(distRoot, 'build-manifest.json'),
    stamp,
    issues
  };
}

export function ensureDistFresh({ rebuild = true } = {}) {
  let freshness = currentDistFreshness();
  const rebuildAllowed = rebuild
    && process.env.SKS_ENSURE_DIST_NO_REBUILD !== '1'
    && process.env.SKS_RELEASE_DIST_FRESHNESS_NO_REBUILD !== '1';
  if (freshness.ok || !rebuildAllowed) return freshness;
  const run = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build', '--silent'], {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe'
  });
  if (run.status !== 0) {
    return {
      ...freshness,
      ok: false,
      rebuild_attempted: true,
      rebuild_status: run.status,
      issues: [...freshness.issues, `build_failed:${tail(run.stderr || run.stdout)}`]
    };
  }
  freshness = currentDistFreshness();
  return { ...freshness, rebuild_attempted: true, rebuild_status: run.status };
}

export function buildStampPayload() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const snapshot = sourceSnapshot();
  return {
    schema: 'sks.dist-build-stamp.v1',
    package_name: pkg.name,
    package_version: pkg.version,
    source_digest: snapshot.digest,
    source_file_count: snapshot.file_count,
    built_at_source_time: latestSourceMtime(snapshot.files)
  };
}

export function writeDistFreshStamp() {
  const payload = buildStampPayload();
  fs.mkdirSync(path.dirname(distStampPath), { recursive: true });
  fs.writeFileSync(distStampPath, `${JSON.stringify(payload, null, 2)}\n`);
  if (!process.env.SKS_BUILD_OUTPUT_DIR) {
    fs.mkdirSync(path.dirname(reportStampPath), { recursive: true });
    fs.writeFileSync(reportStampPath, `${JSON.stringify(payload, null, 2)}\n`);
  }
  return payload;
}

function releaseRelevantFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8'
  });
  const raw = result.status === 0 ? result.stdout.split('\0').filter(Boolean) : walk(root).map((file) => path.relative(root, file).split(path.sep).join('/'));
  return raw
    .filter((file) => /^(src|scripts|schemas|docs|test|native|config|crates\/sks-core)\//.test(file) || /^(package|package-lock)\.json$|^README\.md$|^CHANGELOG\.md$|^tsconfig\.json$/.test(file))
    .filter((file) => !file.startsWith('dist/') && !file.startsWith('node_modules/') && !file.startsWith('.sneakoscope/'))
    .sort();
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.sneakoscope') continue;
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile()) out.push(file);
  }
  return out;
}

function latestSourceMtime(files) {
  let latest = 0;
  for (const file of files) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(root, file)).mtimeMs);
    } catch {}
  }
  return Math.round(latest);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function tail(value) {
  return String(value || '').slice(-1200).replace(/\s+/g, ' ').trim();
}
