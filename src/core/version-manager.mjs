import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, nowIso, readJson, runProcess, writeJsonAtomic, writeTextAtomic } from './fsx.mjs';

const VERSION_HOOK_MARKER = 'Sneakoscope Codex Version Guard';
const VERSION_STATE_FILE = 'sks-version-state.json';
const DEFAULT_BUMP = 'patch';

export async function installVersionGitHook(root, commandPrefix = 'sks') {
  const git = await gitPaths(root);
  if (!git.ok) return { ok: true, installed: false, reason: git.reason || 'not_git' };
  const hookPath = git.hook_path;
  const block = versionHookBlock(commandPrefix);
  const current = await readFileMaybe(hookPath);
  const next = mergeShellBlock(current, VERSION_HOOK_MARKER, block);
  await ensureDir(path.dirname(hookPath));
  await writeTextAtomic(hookPath, next);
  await fsp.chmod(hookPath, 0o755).catch(() => {});
  return { ok: true, installed: true, hook_path: hookPath };
}

export async function versioningStatus(root) {
  const git = await gitPaths(root);
  const packagePath = path.join(root, 'package.json');
  const pkg = await readJson(packagePath, null);
  const version = typeof pkg?.version === 'string' ? pkg.version : null;
  if (!git.ok) return { ok: true, enabled: false, reason: git.reason || 'not_git', package_version: version };
  const hookText = await readFileMaybe(git.hook_path);
  const hookInstalled = hookText.includes(`BEGIN ${VERSION_HOOK_MARKER}`);
  const policy = await versionPolicy(root);
  const state = await readJson(path.join(git.common_dir, VERSION_STATE_FILE), {});
  return {
    ok: !policy.enabled || hookInstalled || !version,
    enabled: Boolean(policy.enabled && version),
    package_version: version,
    bump: policy.bump,
    hook_installed: hookInstalled,
    hook_path: git.hook_path,
    state_path: path.join(git.common_dir, VERSION_STATE_FILE),
    last_version: state.last_version || null,
    reason: version ? null : 'package_json_version_missing'
  };
}

export async function runVersionPreCommit(root, opts = {}) {
  if (process.env.SKS_DISABLE_VERSIONING === '1') return { ok: true, skipped: true, reason: 'SKS_DISABLE_VERSIONING=1' };
  const policy = await versionPolicy(root);
  if (!policy.enabled && !opts.force) return { ok: true, skipped: true, reason: 'disabled_by_policy' };
  const pkgPath = path.join(root, 'package.json');
  const pkg = await readJson(pkgPath, null);
  if (!pkg?.version) return { ok: true, skipped: true, reason: 'package_json_version_missing' };
  const git = await gitPaths(root);
  if (!git.ok) return { ok: true, skipped: true, reason: git.reason || 'not_git' };
  return withVersionLock(git.common_dir, async () => bumpProjectVersion(root, { ...opts, policy, git }));
}

export async function bumpProjectVersion(root, opts = {}) {
  const policy = opts.policy || await versionPolicy(root);
  const git = opts.git || await gitPaths(root);
  const pkgPath = path.join(root, 'package.json');
  const pkg = await readJson(pkgPath);
  const current = parseSemver(pkg.version);
  if (!current) return { ok: false, reason: `Unsupported package.json version: ${pkg.version}` };

  const statePath = git.ok ? path.join(git.common_dir, VERSION_STATE_FILE) : null;
  const state = statePath ? await readJson(statePath, {}) : {};
  const headPkg = await gitJson(root, 'HEAD:package.json');
  const headVersion = parseSemver(headPkg?.version);
  const stateVersion = parseSemver(state.last_version);
  const base = maxSemver([headVersion, stateVersion].filter(Boolean));
  const manualAlreadyBumped = base && compareSemver(current, base) > 0;
  const target = manualAlreadyBumped ? current : bumpSemver(base || current, policy.bump || DEFAULT_BUMP);
  const changed = compareSemver(current, target) !== 0;

  if (changed) {
    pkg.version = formatSemver(target);
    await writeJsonAtomic(pkgPath, pkg);
  }
  const synced = await syncPackageLockVersions(root, formatSemver(target));
  const staged = await stageVersionFiles(root, [pkgPath, ...synced.files]);
  if (!staged.ok) return { ok: false, reason: 'git_add_version_files_failed', stderr: staged.stderr };
  if (statePath) {
    await writeJsonAtomic(statePath, {
      schema_version: 1,
      last_version: formatSemver(target),
      previous_version: pkg.version === formatSemver(target) && !changed ? formatSemver(current) : formatSemver(current),
      updated_at: nowIso(),
      pid: process.pid,
      bump: policy.bump || DEFAULT_BUMP,
      changed
    });
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'version', 'last.json'), {
    schema_version: 1,
    version: formatSemver(target),
    previous_version: formatSemver(current),
    changed,
    synced_files: synced.relative_files,
    staged_files: staged.relative_files,
    updated_at: nowIso()
  }).catch(() => {});
  return {
    ok: true,
    changed,
    version: formatSemver(target),
    previous_version: formatSemver(current),
    synced_files: synced.relative_files,
    staged_files: staged.relative_files,
    lock_scope: git.common_dir
  };
}

async function versionPolicy(root) {
  const policy = await readJson(path.join(root, '.sneakoscope', 'policy.json'), {});
  return {
    enabled: policy.versioning?.enabled !== false,
    bump: policy.versioning?.bump || DEFAULT_BUMP
  };
}

async function gitPaths(root) {
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { ok: false, reason: 'not_git' };
  const common = await git(root, ['rev-parse', '--git-common-dir']);
  const hook = await git(root, ['rev-parse', '--git-path', 'hooks/pre-commit']);
  if (common.code !== 0 || hook.code !== 0) return { ok: false, reason: 'git_paths_unavailable' };
  const topLevel = top.stdout.trim();
  const commonDir = path.resolve(topLevel, common.stdout.trim());
  const hookPath = path.resolve(topLevel, hook.stdout.trim());
  return { ok: true, top_level: topLevel, common_dir: commonDir, hook_path: hookPath };
}

async function git(root, args, opts = {}) {
  return runProcess('git', args, { cwd: root, timeoutMs: opts.timeoutMs || 15000, maxOutputBytes: opts.maxOutputBytes || 64 * 1024 });
}

async function gitJson(root, spec) {
  const result = await git(root, ['show', spec], { maxOutputBytes: 256 * 1024 });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function withVersionLock(commonDir, fn) {
  const lockDir = path.join(commonDir, 'sks-version.lock');
  const started = Date.now();
  let attempts = 0;
  while (true) {
    attempts += 1;
    try {
      await fsp.mkdir(lockDir);
      await writeTextAtomic(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, started_at: nowIso() }, null, 2));
      try {
        const result = await fn();
        return { ...result, lock_attempts: attempts };
      } finally {
        await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - started > 15000) return { ok: false, reason: 'version_lock_timeout', lock_path: lockDir };
      await sleep(150 + Math.min(750, attempts * 25));
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function syncPackageLockVersions(root, version) {
  const files = [];
  for (const rel of ['package-lock.json', 'npm-shrinkwrap.json']) {
    const file = path.join(root, rel);
    const json = await readJson(file, null);
    if (!json) continue;
    let changed = false;
    if (json.version && json.version !== version) { json.version = version; changed = true; }
    if (json.packages?.['']?.version && json.packages[''].version !== version) {
      json.packages[''].version = version;
      changed = true;
    }
    if (changed) {
      await writeJsonAtomic(file, json);
      files.push(file);
    }
  }
  return { files, relative_files: files.map((file) => path.relative(root, file)) };
}

async function stageVersionFiles(root, files) {
  const existing = [];
  for (const file of files) if (await exists(file)) existing.push(path.relative(root, file));
  if (!existing.length) return { ok: true, relative_files: [] };
  const result = await git(root, ['add', '--', ...existing]);
  return { ok: result.code === 0, relative_files: existing, stderr: result.stderr };
}

function parseSemver(value) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatSemver(v) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function compareSemver(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if ((a?.[key] || 0) > (b?.[key] || 0)) return 1;
    if ((a?.[key] || 0) < (b?.[key] || 0)) return -1;
  }
  return 0;
}

function maxSemver(items) {
  return items.reduce((max, item) => (!max || compareSemver(item, max) > 0 ? item : max), null);
}

function bumpSemver(v, bump = DEFAULT_BUMP) {
  if (bump === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function versionHookBlock(commandPrefix) {
  return `# SKS keeps package versions unique across worker commits.\n${commandPrefix} versioning pre-commit\nstatus=$?\nif [ $status -ne 0 ]; then\n  echo \"SKS versioning blocked commit. Run: sks versioning status\" >&2\n  exit $status\nfi`;
}

function mergeShellBlock(current, marker, block) {
  const begin = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const managed = `${begin}\n${block.trim()}\n${end}\n`;
  if (!current.trim()) return `#!/bin/sh\n${managed}`;
  const withShebang = current.startsWith('#!') ? current : `#!/bin/sh\n${current}`;
  const beginIdx = withShebang.indexOf(begin);
  const endIdx = withShebang.indexOf(end);
  if (beginIdx >= 0 && endIdx >= beginIdx) {
    return `${withShebang.slice(0, beginIdx)}${managed}${withShebang.slice(endIdx + end.length).replace(/^\n/, '')}`;
  }
  const lines = withShebang.split('\n');
  if (lines[0]?.startsWith('#!')) {
    return `${lines[0]}\n${managed}${lines.slice(1).join('\n').replace(/^\n/, '')}`.replace(/\s*$/, '\n');
  }
  return `${managed}${withShebang.replace(/^\n/, '').replace(/\s*$/, '\n')}`;
}

async function readFileMaybe(file) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return ''; }
}
