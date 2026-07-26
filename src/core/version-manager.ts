import path from 'node:path';
import fsp from 'node:fs/promises';
import { exists, nowIso, readJson, runProcess, writeJsonAtomic, writeTextAtomic } from './fsx.js';
import { escapeRegExp } from './text/regex.js';
import { RELEASE_UPGRADE_BASELINE_VERSION } from './release/release-upgrade-baseline.js';

const VERSION_HOOK_MARKER = 'Sneakoscope Codex Version Guard';
const VERSION_STATE_FILE = 'sks-version-state.json';
const DEFAULT_BUMP = 'patch';

export async function installVersionGitHook(root: any, commandPrefix: any = 'sks') {
  void root;
  void commandPrefix;
  return {
    ok: false,
    installed: false,
    reason: 'pre_commit_hooks_unsupported',
    message: 'SKS no longer installs Git pre-commit hooks. Use `sks versioning bump` and release checks explicitly.'
  };
}

export async function disableVersionGitHook(root: any) {
  await setVersionPolicyEnabled(root, false);
  const git = await gitPaths(root);
  if (!git.ok) return { ok: true, disabled: true, hook_removed: false, reason: git.reason || 'not_git' };
  const current = await readFileMaybe(git.hook_path);
  if (!current.includes(`BEGIN ${VERSION_HOOK_MARKER}`)) {
    return { ok: true, disabled: true, hook_removed: false, hook_path: git.hook_path, reason: 'managed_hook_not_installed' };
  }
  const next = removeShellBlock(current, VERSION_HOOK_MARKER);
  if (next.trim() === '#!/bin/sh' || next.trim() === '#!/usr/bin/env sh' || !next.trim()) {
    await fsp.rm(git.hook_path, { force: true });
    return { ok: true, disabled: true, hook_removed: true, hook_path: git.hook_path };
  }
  await writeTextAtomic(git.hook_path, next);
  await fsp.chmod(git.hook_path, 0o755).catch(() => {});
  return { ok: true, disabled: true, hook_removed: true, hook_path: git.hook_path };
}

export async function versioningStatus(root: any) {
  const git = await gitPaths(root);
  const packagePath = path.join(root, 'package.json');
  const pkg = await readJson(packagePath, null);
  const version = typeof pkg?.version === 'string' ? pkg.version : null;
  if (!git.ok) return { ok: true, enabled: false, reason: git.reason || 'not_git', package_version: version };
  const hookText = await readFileMaybe(git.hook_path);
  const hookInstalled = hookText.includes(`BEGIN ${VERSION_HOOK_MARKER}`);
  const policy = await versionPolicy(root);
  const state = await readJson(path.join(git.common_dir, VERSION_STATE_FILE), {});
  const runtimeDrift = await runtimeDriftStatus(root, version);
  return {
    ok: (!policy.enabled || hookInstalled || !version) && runtimeDrift.ok,
    enabled: Boolean(policy.enabled && version),
    package_version: version,
    bump: policy.bump,
    hook_installed: hookInstalled,
    hook_path: git.hook_path,
    state_path: path.join(git.common_dir, VERSION_STATE_FILE),
    last_version: state.last_version || null,
    runtime_drift: runtimeDrift,
    reason: !policy.enabled ? 'disabled_by_policy' : (version ? null : 'package_json_version_missing')
  };
}

async function runtimeDriftStatus(root: any, packageVersion: any) {
  if (!packageVersion || process.env.SKS_RUNTIME_DRIFT_CHECK === '0') {
    return { ok: true, checked: false, reason: packageVersion ? 'disabled' : 'package_json_version_missing' };
  }
  const localBin = path.join(root, 'dist', 'bin', 'sks.js');
  const useLocalBin = await exists(localBin);
  const command = useLocalBin ? process.execPath : 'sks';
  const args = useLocalBin ? [localBin, '--version'] : ['--version'];
  const result = await runProcess(command, args, {
    cwd: root,
    timeoutMs: 5000,
    maxOutputBytes: 16 * 1024,
    env: { SKS_RUNTIME_DRIFT_CHECK: '0' }
  });
  if (result.code !== 0) {
    return { ok: true, checked: false, reason: 'sks_binary_unavailable', stderr: result.stderr?.trim() || null };
  }
  const match = String(result.stdout || '').match(/(\d+\.\d+\.\d+)/);
  const runtimeVersion = match?.[1] || null;
  const runtime = parseSemver(runtimeVersion);
  const source = parseSemver(packageVersion);
  if (!runtime || !source) {
    return { ok: true, checked: true, reason: 'version_parse_unavailable', runtime_version: runtimeVersion, package_version: packageVersion };
  }
  const comparison = compareSemver(runtime, source);
  return {
    ok: comparison >= 0,
    checked: true,
    command: [command, ...args].join(' '),
    runtime_version: runtimeVersion,
    package_version: packageVersion,
    relation: comparison === 0 ? 'same' : (comparison > 0 ? 'runtime_newer' : 'runtime_older')
  };
}

export async function runVersionPreCommit(root: any, opts: any = {}) {
  if (process.env.SKS_DISABLE_VERSIONING === '1') return { ok: true, skipped: true, reason: 'SKS_DISABLE_VERSIONING=1' };
  const policy = await versionPolicy(root);
  if (!policy.enabled && !opts.force) return { ok: true, skipped: true, reason: 'disabled_by_policy' };
  const pkgPath = path.join(root, 'package.json');
  const pkg = await readJson(pkgPath, null);
  if (!pkg?.version) return { ok: true, skipped: true, reason: 'package_json_version_missing' };
  const git = await gitPaths(root);
  if (!git.ok) return { ok: true, skipped: true, reason: git.reason || 'not_git' };
  return withVersionLock(git.common_dir, async () => verifyProjectVersion(root, { ...opts, policy, git }));
}

export async function bumpProjectVersion(root: any, opts: any = {}) {
  const policy = { ...(opts.policy || await versionPolicy(root)), ...(opts.bump ? { bump: opts.bump } : {}) };
  const git = opts.git || await gitPaths(root);
  const pkgPath = path.join(root, 'package.json');
  const pkg = await readJson(pkgPath, {});
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
  const targetVersion = formatSemver(target);
  const sourceVersion = await syncSourcePackageVersion(root, targetVersion);
  const changelog = await syncChangelogVersionSection(root, targetVersion);
  const synced = await syncPackageLockVersions(root, targetVersion);
  const staged = await stageVersionFiles(root, [pkgPath, ...synced.files, ...sourceVersion.files, ...changelog.files]);
  if (!staged.ok) return { ok: false, reason: 'git_add_version_files_failed', stderr: staged.stderr };
  if (statePath) {
    await writeJsonAtomic(statePath, {
      schema_version: 1,
      last_version: targetVersion,
      previous_version: pkg.version === targetVersion && !changed ? formatSemver(current) : formatSemver(current),
      updated_at: nowIso(),
      pid: process.pid,
      bump: policy.bump || DEFAULT_BUMP,
      changed
    });
  }
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'version', 'last.json'), {
    schema_version: 1,
    version: targetVersion,
    previous_version: formatSemver(current),
    changed,
    synced_files: [...synced.relative_files, ...sourceVersion.relative_files, ...changelog.relative_files],
    staged_files: staged.relative_files,
    updated_at: nowIso()
  }).catch(() => {});
  return {
    ok: true,
    changed,
    version: targetVersion,
    previous_version: formatSemver(current),
    synced_files: [...synced.relative_files, ...sourceVersion.relative_files, ...changelog.relative_files],
    staged_files: staged.relative_files,
    lock_scope: git.common_dir
  };
}

export async function verifyProjectVersion(root: any, opts: any = {}) {
  const git = opts.git || await gitPaths(root);
  const pkgPath = path.join(root, 'package.json');
  const pkg = await readJson(pkgPath, {});
  const current = parseSemver(pkg.version);
  if (!current) return { ok: false, reason: `Unsupported package.json version: ${pkg.version}` };
  const version = formatSemver(current);
  const sourceVersion = await syncSourcePackageVersion(root, version);
  const synced = await syncPackageLockVersions(root, version);
  if (!await changelogHasVersionSection(root, version)) {
    return { ok: false, reason: 'changelog_section_missing', version, expected: `## [${version}]` };
  }
  const staged = await stageVersionFiles(root, [...synced.files, ...sourceVersion.files]);
  if (!staged.ok) return { ok: false, reason: 'git_add_version_files_failed', stderr: staged.stderr };
  const statePath = git.ok ? path.join(git.common_dir, VERSION_STATE_FILE) : null;
  if (statePath) {
    await writeJsonAtomic(statePath, {
      schema_version: 1,
      last_version: version,
      updated_at: nowIso(),
      pid: process.pid,
      mode: 'verify',
      changed: Boolean(synced.files.length || sourceVersion.files.length)
    });
  }
  return {
    ok: true,
    changed: Boolean(synced.files.length || sourceVersion.files.length),
    version,
    previous_version: version,
    synced_files: [...synced.relative_files, ...sourceVersion.relative_files],
    staged_files: staged.relative_files,
    lock_scope: git.common_dir,
    mode: 'verify'
  };
}

async function versionPolicy(root: any) {
  const policy = await readJson(path.join(root, '.sneakoscope', 'policy.json'), {});
  return {
    enabled: policy.versioning?.enabled === true,
    bump: policy.versioning?.bump || DEFAULT_BUMP
  };
}

async function setVersionPolicyEnabled(root: any, enabled: any) {
  const policyPath = path.join(root, '.sneakoscope', 'policy.json');
  const policy = await readJson(policyPath, {});
  await writeJsonAtomic(policyPath, {
    ...policy,
    git: {
      ...(policy.git || {}),
      versioning: {
        ...(policy.git?.versioning || {}),
        enabled: Boolean(enabled),
        bump: policy.git?.versioning?.bump || policy.versioning?.bump || DEFAULT_BUMP,
        lock: 'git-common-dir/sks-version.lock',
        state: 'git-common-dir/sks-version-state.json'
      }
    },
    versioning: {
      ...(policy.versioning || {}),
      enabled: Boolean(enabled),
      bump: policy.versioning?.bump || DEFAULT_BUMP,
      trigger: 'manual',
      lock_scope: 'git-common-dir',
      managed_files: policy.versioning?.managed_files || ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'],
      collision_policy: policy.versioning?.collision_policy || 'explicit_bump_only'
    }
  });
}

type GitPathsResult =
  | { ok: true; top_level: string; common_dir: string; hook_path: string }
  | { ok: false; reason: string };

async function gitPaths(root: any): Promise<GitPathsResult> {
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

async function git(root: any, args: any, opts: any = {}) {
  return runProcess('git', args, { cwd: root, timeoutMs: opts.timeoutMs || 15000, maxOutputBytes: opts.maxOutputBytes || 64 * 1024 });
}

async function gitJson(root: any, spec: any) {
  const result = await git(root, ['show', spec], { maxOutputBytes: 256 * 1024 });
  if (result.code !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

async function withVersionLock(commonDir: any, fn: any) {
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
    } catch (err: any) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - started > 15000) return { ok: false, reason: 'version_lock_timeout', lock_path: lockDir };
      await sleep(150 + Math.min(750, attempts * 25));
    }
  }
}

function sleep(ms: any) {
  return new Promise<any>((resolve: any) => setTimeout(resolve, ms));
}

async function syncPackageLockVersions(root: any, version: any) {
  const files: any[] = [];
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
  return { files, relative_files: files.map((file: any) => path.relative(root, file)) };
}

async function syncSourcePackageVersion(root: any, version: any) {
  const files: any[] = [];
  const replacements = [
    // src/core/version.ts is the single place the package version is written into source.
    // Everything else that needs it imports PACKAGE_VERSION, so there is nothing else to stamp.
    {
      rel: 'src/core/version.ts',
      replace: (text: string) => text.replace(/export const PACKAGE_VERSION = ['"][^'"]+['"];/, `export const PACKAGE_VERSION = '${version}';`)
    },
    {
      rel: 'crates/sks-core/Cargo.toml',
      replace: (text: string) => text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`)
    },
    {
      rel: 'crates/sks-core/Cargo.lock',
      replace: (text: string) => text.replace(/(\[\[package\]\]\nname = "sks-core"\nversion = ")[^"]+(")/, `$1${version}$2`)
    },
    {
      rel: 'crates/sks-core/src/main.rs',
      replace: (text: string) => text.replace(/sks-rs \d+\.\d+\.\d+/, `sks-rs ${version}`)
    },
    {
      rel: 'README.md',
      replace: (text: string) => text
        .replace(/\*\*SKS \d+\.\d+\.\d+\*\*/, `**SKS ${version}**`)
        .replace(/SKS \*\*\d+\.\d+\.\d+\*\*/, `SKS **${version}**`)
        .replace(/^## Naruto In \d+\.\d+\.\d+$/m, `## Naruto In ${version}`)
    },
    {
      rel: 'docs/release-readiness.md',
      replace: (text: string) => text
        .replace(/^# SKS \d+\.\d+\.\d+ Release Readiness$/m, `# SKS ${version} Release Readiness`)
        .replace(
          /(`sneakoscope`\r?\n)\d+\.\d+\.\d+\. The current package version on this branch is \d+\.\d+\.\d+\./m,
          (_match: string, prefix: string) => `${prefix}${version}. The current package version on this branch is ${version}.`
        )
        .replace(/^SKS \d+\.\d+\.\d+ is ready/m, `SKS ${version} is ready`)
        .replace(/^Codex 0\.142 references later in this document are historical release records and cannot authorize the \d+\.\d+\.\d+ release\./m, `Codex 0.142 references later in this document are historical release records and cannot authorize the ${version} release.`)
        .replace(/^\d+\.\d+\.\d+ release readiness requires/m, `${version} release readiness requires`)
        .replace(/^## Current publish authorization policy \(\d+\.\d+\.\d+\)$/m, `## Current publish authorization policy (${version})`)
        .replace(/^The \d+\.\d+\.\d+ implementation handoff uses this bounded verification sequence:/m, `The ${version} implementation handoff uses this bounded verification sequence:`)
        .replace(/^the \d+\.\d+\.\d+ command surface;/m, `the ${version} command surface;`)
        .replace(/^not the \d+\.\d+\.\d+ release procedure\./m, `not the ${version} release procedure.`)
        .replace(/do not satisfy the \d+\.\d+\.\d+ official-subagent gate\. Current \d+\.\d+\.\d+ proof/g, `do not satisfy the ${version} official-subagent gate. Current ${version} proof`)
        .replace(/not represented as current \d+\.\d+\.\d+ completion proof\./g, `not represented as current ${version} completion proof.`)
        .replace(/^For \d+\.\d+\.\d+, a selected codex-lb/m, `For ${version}, a selected codex-lb`)
        .replace(/^The \d+\.\d+\.\d+ SKS menu bar/m, `The ${version} SKS menu bar`)
        .replace(/the \d+\.\d+\.\d+ to \d+\.\d+\.\d+ upgrade smoke/g, `the ${RELEASE_UPGRADE_BASELINE_VERSION} to ${version} upgrade smoke`)
        .replace(/under the \d+\.\d+\.\d+ release evidence root/g, `under the ${version} release evidence root`)
        .replace(/^Do not cut \d+\.\d+\.\d+ while/m, `Do not cut ${version} while`)
        .replace(/must agree on \d+\.\d+\.\d+\./g, `must agree on ${version}.`)
        .replace(/It must not claim that \d+\.\d+\.\d+ is/g, `It must not claim that ${version} is`)
        .replace(/npm view sneakoscope@\d+\.\d+\.\d+/g, `npm view sneakoscope@${version}`)
        .replace(/install `sneakoscope@\d+\.\d+\.\d+`/g, `install \`sneakoscope@${version}\``)
        .replace(/(registry version to be)(\s+)\d+\.\d+\.\d+,/g, `$1$2${version},`)
        .replace(/`latest` to resolve to \d+\.\d+\.\d+,/g, `\`latest\` to resolve to ${version},`)
        .replace(/never replace \d+\.\d+\.\d+\./g, `never replace ${version}.`)
    },
    {
      rel: 'docs/release-proof-truth.md',
      replace: (text: string) => text
        .replace(/^SKS \d+\.\d+\.\d+ release proof truth/m, `SKS ${version} release proof truth`)
        .replace(/^SKS \d+\.\d+\.\d+ must not claim/m, `SKS ${version} must not claim`)
        .replace(/; \d+\.\d+\.\d+ proof must additionally show/g, `; ${version} proof must additionally show`)
        .replace(/cannot serve as \d+\.\d+\.\d+ evidence\./m, `cannot serve as ${version} evidence.`)
    },
    {
      rel: 'docs/official-docs-compat.md',
      replace: (text: string) => text
        .replace(/^SKS \d+\.\d+\.\d+ keeps release-gated behavior/m, `SKS ${version} keeps release-gated behavior`)
        .replace(/official-docs-compat-\d+\.\d+\.\d+\.(json|md)/g, `official-docs-compat-${version}.$1`)
    },
    {
      rel: 'docs/codex-0.139-compat.md',
      replace: (text: string) => text.replace(/^SKS \d+\.\d+\.\d+ keeps the historical/m, `SKS ${version} keeps the historical`)
    },
    {
      rel: 'docs/codex-cli-compat.md',
      replace: (text: string) => text
        .replace(/^SKS \d+\.\d+\.\d+ targets/m, `SKS ${version} targets`)
        .replace(/not release-authorizing for SKS \d+\.\d+\.\d+\./m, `not release-authorizing for SKS ${version}.`)
    },
    {
      rel: 'docs/codex-app.md',
      replace: (text: string) => text
        .replace(/^SKS \d+\.\d+\.\d+ targets/m, `SKS ${version} targets`)
        .replace(/^SKS \d+\.\d+\.\d+ also reports/m, `SKS ${version} also reports`)
    },
    {
      rel: 'docs/PERFORMANCE.md',
      replace: (text: string) => text
        .replace(/^Sneakoscope Codex \d+\.\d+\.\d+ is designed/m, `Sneakoscope Codex ${version} is designed`)
        .replace(/(\b[Tt]he )\d+\.\d+\.\d+ package pins/m, `$1${version} package pins`)
        .replace(/(\b[Tt]he final )\d+\.\d+\.\d+ host-capability/m, `$1${version} host-capability`)
    },
    {
      rel: 'docs/AGENT-BRIDGE.md',
      replace: (text: string) => text.replace(/"package_version": "\d+\.\d+\.\d+"/m, `"package_version": "${version}"`)
    }
  ];
  for (const { rel, replace } of replacements) {
    const file = path.join(root, rel);
    const text = await readFileMaybe(file);
    if (!text) continue;
    const next = replace(text);
    if (next === text) continue;
    await writeTextAtomic(file, next);
    files.push(file);
  }
  return { files, relative_files: files.map((file: any) => path.relative(root, file)) };
}

async function syncChangelogVersionSection(root: any, version: any) {
  const file = path.join(root, 'CHANGELOG.md');
  let text = (await readFileMaybe(file)) ?? '';
  const date = nowIso().slice(0, 10);
  const sectionRe = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
  if (sectionRe.test(text)) return { files: [], relative_files: [] };

  if (!text.trim()) text = '# Changelog\n\n## [Unreleased]\n\n';
  if (!/^#\s+Changelog\s*$/m.test(text)) text = `# Changelog\n\n${text.replace(/^\s+/, '')}`;
  if (!/^##\s+\[Unreleased\]\s*$/m.test(text)) {
    text = text.replace(/^#\s+Changelog\s*$/m, (title: any) => `${title}\n\n## [Unreleased]`);
  }

  const unreleasedRe = /^##\s+\[Unreleased\]\s*$/m;
  const unreleased = unreleasedRe.exec(text);
  if (!unreleased) return { files: [], relative_files: [] };
  const bodyStart = unreleased.index + unreleased[0].length;
  const remainder = text.slice(bodyStart);
  const nextReleaseOffset = remainder.search(/\n##\s+\[[^\]]+\]/);
  const unreleasedBody = nextReleaseOffset >= 0 ? remainder.slice(0, nextReleaseOffset) : remainder;
  const managedSection = unreleasedBody.trim()
    ? `\n\n## [${version}] - ${date}`
    : `\n\n## [${version}] - ${date}\n\n### Fixed\n\n- Keep release metadata aligned after an explicit SKS version bump advances the package version.\n`;
  const next = `${text.slice(0, bodyStart)}${managedSection}${text.slice(bodyStart)}`;
  if (next === text) return { files: [], relative_files: [] };
  await writeTextAtomic(file, next);
  return { files: [file], relative_files: [path.relative(root, file)] };
}

async function changelogHasVersionSection(root: any, version: any) {
  const file = path.join(root, 'CHANGELOG.md');
  const text = await readFileMaybe(file);
  const sectionRe = new RegExp(`^##\\s+\\[${escapeRegExp(version)}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}\\s*$`, 'm');
  return sectionRe.test(text ?? '');
}

async function stageVersionFiles(root: any, files: any) {
  const existing: any[] = [];
  for (const file of files) if (await exists(file)) existing.push(path.relative(root, file));
  if (!existing.length) return { ok: true, relative_files: [] };
  const result = await git(root, ['add', '--', ...existing]);
  return { ok: result.code === 0, relative_files: existing, stderr: result.stderr };
}

function parseSemver(value: any) {
  const match = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function formatSemver(v: any) {
  return `${v.major}.${v.minor}.${v.patch}`;
}

function compareSemver(a: any, b: any) {
  for (const key of ['major', 'minor', 'patch']) {
    if ((a?.[key] || 0) > (b?.[key] || 0)) return 1;
    if ((a?.[key] || 0) < (b?.[key] || 0)) return -1;
  }
  return 0;
}

function maxSemver(items: any) {
  return items.reduce((max: any, item: any) => (!max || compareSemver(item, max) > 0 ? item : max), null);
}

function bumpSemver(v: any, bump: any = DEFAULT_BUMP) {
  if (bump === 'major') return { major: v.major + 1, minor: 0, patch: 0 };
  if (bump === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 };
  return { major: v.major, minor: v.minor, patch: v.patch + 1 };
}

function removeShellBlock(current: any, marker: any) {
  const begin = `# BEGIN ${marker}`;
  const end = `# END ${marker}`;
  const beginIdx = current.indexOf(begin);
  const endIdx = current.indexOf(end);
  if (beginIdx < 0 || endIdx < beginIdx) return current;
  return `${current.slice(0, beginIdx)}${current.slice(endIdx + end.length).replace(/^\n/, '')}`.replace(/\s*$/, '\n');
}

async function readFileMaybe(file: any) {
  try { return await fsp.readFile(file, 'utf8'); } catch { return ''; }
}
