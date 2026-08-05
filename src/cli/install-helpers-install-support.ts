import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { ensureDir, exists, packageRoot, PACKAGE_VERSION, runProcess, tmpdir, writeTextAtomic } from '../core/fsx.js';
import { EMPTY_CODEX_INFO, getCodexInfo } from '../core/codex-adapter.js';
import { installGlobalSkills } from '../core/init.js';
import { context7ConfigToml, DOLLAR_SKILL_NAMES, GETDESIGN_REFERENCE, hasContext7ConfigText, RECOMMENDED_SKILLS } from '../core/routes.js';
import { writeCodexConfigGuarded } from '../core/codex/codex-config-guard.js';
import { repairCodexImagegen } from '../core/doctor/imagegen-repair.js';
import { compareVersions } from './install-tool-helpers.js';

export type SksPostinstallShimResult = {
  status: string;
  command?: string;
  repaired?: Array<{ path: string; name?: string; previous_version?: unknown; target?: unknown; error?: string }>;
  failed?: unknown[];
  reason?: string;
  error?: string;
};

function packagedSksEntrypoint() {
  return path.join(packageRoot(), 'dist', 'bin', 'sks.js');
}

export async function ensureSksCommandDuringInstall(opts: any = {}): Promise<SksPostinstallShimResult> {
  if (process.env.SKS_SKIP_POSTINSTALL_SHIM === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_SHIM=1' };
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const nodeBin = opts.nodeBin || process.execPath;
  const target = opts.target || packagedSksEntrypoint();
  const repair = await reconcileSksPathShimsDuringInstall({ ...opts, pathEnv, nodeBin, target });
  if (repair.status === 'repaired') return { ...repair, command: repair.command || repair.repaired?.[0]?.path || target };
  if (repair.status === 'failed') return repair;
  const existing = await findCommandOnPath('sks', pathEnv);
  if (isStableSksBin(existing)) return { status: 'present', command: existing };
  const dirs = candidateShimDirs(pathEnv, opts.home || process.env.HOME);
  const script = process.platform === 'win32'
    ? `@echo off\r\n"${nodeBin}" "${target}" %*\r\n`
    : `#!/bin/sh\nexec "${nodeBin}" "${target}" "$@"\n`;
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  let createdFallback = null;
  let lastError = '';
  for (const entry of dirs) {
    const dest = path.join(entry.dir, `sks${suffix}`);
    try {
      await ensureDir(entry.dir);
      await writeTextAtomic(dest, script);
      if (process.platform !== 'win32') await fsp.chmod(dest, 0o755).catch(() => {});
      if (entry.onPath) return { status: 'created', command: dest };
      createdFallback ||= dest;
    } catch (err: any) {
      lastError = err.message;
    }
  }
  if (createdFallback) return { status: 'created_not_on_path', command: createdFallback };
  return { status: 'failed', error: lastError };
}

export async function selftestSksShimRepair() {
  const staleShimTmp = tmpdir();
  const staleBin = path.join(staleShimTmp, 'old-prefix', 'bin');
  const stalePkg = path.join(staleShimTmp, 'old-prefix', 'lib', 'node_modules', 'sneakoscope');
  const staleEntrypoint = path.join(stalePkg, 'dist', 'bin', 'sks.js');
  await ensureDir(path.dirname(staleEntrypoint));
  await ensureDir(staleBin);
  await writeTextAtomic(path.join(stalePkg, 'package.json'), JSON.stringify({ name: 'sneakoscope', version: '0.0.1' }, null, 2));
  await writeTextAtomic(staleEntrypoint, '#!/usr/bin/env node\nconsole.log("sneakoscope 0.0.1");\n');
  await fsp.chmod(staleEntrypoint, 0o755).catch(() => {});
  await fsp.symlink(staleEntrypoint, path.join(staleBin, 'sks'));
  const repair = await ensureSksCommandDuringInstall({ force: true, pathEnv: staleBin, home: path.join(staleShimTmp, 'home') });
  if (repair.status !== 'repaired') throw new Error(`selftest: stale global sks shim was not repaired (${repair.status})`);
  const run = await runProcess(path.join(staleBin, 'sks'), ['--version'], { timeoutMs: 10000, maxOutputBytes: 16 * 1024 });
  if (run.code !== 0 || !String(run.stdout || '').includes(PACKAGE_VERSION)) throw new Error('selftest: repaired stale sks shim does not run current package version');
  return { ok: true, repaired: repair.repaired || [] };
}

async function reconcileSksPathShimsDuringInstall(opts: any = {}): Promise<SksPostinstallShimResult> {
  if (process.env.SKS_SKIP_POSTINSTALL_SHIM_REPAIR === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_SHIM_REPAIR=1' };
  const target = opts.target || packagedSksEntrypoint();
  const nodeBin = opts.nodeBin || process.execPath;
  const currentVersion = await installedPackageVersion(packageRoot());
  const commands = await findCommandsOnPath(['sks', 'sneakoscope'], opts.pathEnv ?? process.env.PATH ?? '');
  const repaired: any[] = [];
  const failed: any[] = [];
  for (const command of commands) {
    const info = await inspectSksPathShim(command.path, { target, currentVersion });
    if (!info.repairable) continue;
    const script = process.platform === 'win32'
      ? `@echo off\r\n"${nodeBin}" "${target}" %*\r\n`
      : `#!/bin/sh\nexec "${nodeBin}" "${target}" "$@"\n`;
    try {
      await writeTextAtomic(command.path, script);
      if (process.platform !== 'win32') await fsp.chmod(command.path, 0o755).catch(() => {});
      repaired.push({ path: command.path, name: command.name, previous_version: info.version || null, target });
    } catch (err: any) {
      failed.push({ path: command.path, name: command.name, previous_version: info.version || null, error: err.message });
    }
  }
  if (repaired.length) return { status: 'repaired', command: repaired[0].path, repaired, failed };
  if (failed.length) return { status: 'failed', error: failed.map((entry: any) => `${entry.path}: ${entry.error}`).join('; '), failed };
  return { status: 'present' };
}

async function inspectSksPathShim(candidate: any, opts: any = {}) {
  if (!candidate || isTransientNpmBinPath(candidate)) return { repairable: false, reason: 'transient_or_missing' };
  const target = path.resolve(opts.target || packagedSksEntrypoint());
  const resolved = await fsp.realpath(candidate).catch(() => candidate);
  if (path.resolve(resolved) === target) return { repairable: false, reason: 'current_target' };
  const packageDir = sksPackageRootForBin(resolved) || sksPackageRootForBin(candidate);
  if (!packageDir) return { repairable: false, reason: 'not_sneakoscope_bin' };
  const version = await installedPackageVersion(packageDir);
  const currentVersion = opts.currentVersion || await installedPackageVersion(packageRoot());
  if (!version || !currentVersion || compareVersions(version, currentVersion) >= 0) return { repairable: false, reason: 'not_older', version, current_version: currentVersion };
  return { repairable: true, version, current_version: currentVersion, package_dir: packageDir, resolved };
}

function sksPackageRootForBin(file: any) {
  const normalized = String(file || '').split(path.sep).join('/');
  const marker = '/node_modules/sneakoscope/';
  const idx = normalized.lastIndexOf(marker);
  if (idx < 0) return null;
  const relative = normalized.slice(idx + marker.length);
  if (!/^(?:dist\/)?bin\//.test(relative)) return null;
  return normalized.slice(0, idx + '/node_modules/sneakoscope'.length).split('/').join(path.sep);
}

async function installedPackageVersion(root: any) {
  const pkg = await readJsonMaybe(path.join(root, 'package.json'));
  return pkg?.version || (root === packageRoot() ? PACKAGE_VERSION : null);
}

async function readJsonMaybe(file: any) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return null; }
}

function candidateShimDirs(pathEnv: any, home: any) {
  const seen = new Set();
  const out: any[] = [];
  for (const raw of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    const dir = path.resolve(raw);
    if (seen.has(dir) || isTransientNpmBinPath(dir)) continue;
    seen.add(dir);
    out.push({ dir, onPath: true });
  }
  for (const raw of [home && path.join(home, '.local', 'bin'), home && path.join(home, 'bin')].filter(Boolean)) {
    const dir = path.resolve(raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push({ dir, onPath: false });
  }
  return out;
}

async function findCommandOnPath(name: any, pathEnv: any) {
  const found = await findCommandsOnPath([name], pathEnv);
  return found[0]?.path || null;
}

async function findCommandsOnPath(names: any, pathEnv: any) {
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  const out: any[] = [];
  const seen = new Set();
  for (const dir of String(pathEnv || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      for (const suffix of suffixes) {
        const candidate = path.join(dir, `${name}${suffix}`);
        const key = path.resolve(candidate);
        if (seen.has(key) || !await exists(candidate)) continue;
        seen.add(key);
        out.push({ name, path: candidate });
      }
    }
  }
  return out;
}

export async function ensureGlobalContext7DuringInstall() {
  if (process.env.SKS_SKIP_POSTINSTALL_CONTEXT7 === '1') return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_CONTEXT7=1' };
  const codex = await getCodexInfo().catch(() => EMPTY_CODEX_INFO);
  if (!codex.bin) return { status: 'codex_missing' };
  const env = withoutSecretEnv(['CODEX_LB_API_KEY']);
  const existing = await context7GlobalMcpStatus(codex.bin, env);
  if (existing.present) return { status: 'present' };
  const add = await runProcess(codex.bin, ['mcp', 'add', 'context7', '--', 'npx', '-y', '@upstash/context7-mcp@latest'], { env, timeoutMs: 30000, maxOutputBytes: 64 * 1024 }).catch((err: any) => ({ code: 1, stdout: '', stderr: err.message }));
  if (add.code === 0) return { status: 'installed' };
  return { status: 'failed', error: `${add.stderr || add.stdout || 'codex mcp add failed'}`.trim() };
}

export async function context7GlobalMcpStatus(codexBin: any, env: any = process.env) {
  const list = await runProcess(codexBin, ['mcp', 'list'], { env, timeoutMs: 8000, maxOutputBytes: 32 * 1024 })
    .catch((err: any) => ({ code: 1, stderr: err.message, stdout: '' }));
  const output = `${list.stdout || ''}\n${list.stderr || ''}`;
  return {
    checked: true,
    ok: list.code === 0,
    present: list.code === 0 && /context7/i.test(output),
    stdout: list.stdout || '',
    stderr: list.stderr || ''
  };
}

function withoutSecretEnv(keys: any = []) {
  const env = { ...process.env };
  for (const key of keys) env[key] = '';
  return env;
}

export async function ensureGlobalCodexSkillsDuringInstall(opts: any = {}) {
  if (process.env.SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS === '1' && !opts.force) return { status: 'skipped', reason: 'SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS=1' };
  const home = opts.home || process.env.HOME || os.homedir();
  if (!home) return { status: 'skipped', reason: 'home directory unavailable' };
  const root = globalCodexSkillsRoot(home);
  try {
    const install = await installGlobalSkills(home);
    const skills = await checkRequiredSkills(home, root);
    return {
      status: skills.ok ? 'installed' : 'partial',
      root,
      installed_count: install.installed.length,
      removed_aliases: [],
      removed_stale_generated_skills: install.removed,
      missing_skills: skills.missing
    };
  } catch (err: any) {
    return { status: 'failed', root, error: err.message };
  }
}

export async function ensureGlobalGetdesignSkillDuringInstall() {
  return {
    status: 'skipped',
    reason: 'manual_install_only',
    install: GETDESIGN_REFERENCE.codex_skill_install,
    reviewed_ref: GETDESIGN_REFERENCE.codex_skill_ref
  };
}

export async function ensureCodexImagegenDuringInstall(opts: any = {}) {
  if (process.env.SKS_POSTINSTALL_SKIP_IMAGEGEN_REPAIR === '1' || opts.skip === true) {
    return { status: 'skipped', reason: 'SKS_POSTINSTALL_SKIP_IMAGEGEN_REPAIR' };
  }
  const report = await repairCodexImagegen({
    root: opts.root || process.cwd(),
    apply: opts.apply !== false,
    codexBin: opts.codexBin || null,
    autoInstallCodex: opts.autoInstallCodex === true || process.env.SKS_IMAGEGEN_AUTO_INSTALL_CODEX === '1'
  }).catch((err: any) => ({
    recovered: false,
    blockers: [err?.message || String(err)],
    before: null,
    after: null
  }));
  if ((report as any).before?.core_ready === true || ((report as any).after?.core_ready === true && (report as any).attempted === false)) {
    return { status: 'ready', report };
  }
  if ((report as any).recovered === true) return { status: 'recovered', report };
  return { status: 'blocked', blockers: (report as any).blockers || ['codex_imagegen_unavailable'], report };
}

export async function ensureProjectContext7Config(root: any, transport: any = 'local') {
  const configPath = path.join(root, '.codex', 'config.toml');
  await ensureDir(path.dirname(configPath));
  const current = await safeReadText(configPath);
  const block = context7ConfigToml(transport).trim();
  const existingBlock = /(^|\n)\[mcp_servers\.context7\]\n[\s\S]*?(?=\n\[[^\]]+\]|\s*$)/;
  if (existingBlock.test(current)) {
    return false;
  }
  if (hasContext7ConfigText(current)) return false;
  await writeCodexConfigGuarded({
    root,
    configPath,
    before: current,
    cause: 'context7-project-config',
    mutate: () => `${current.trimEnd()}${current.trim() ? '\n\n' : ''}${block}\n`
  });
  return true;
}

export async function checkRequiredSkills(root: any, skillRoot: any = root ? path.join(root, '.agents', 'skills') : globalCodexSkillsRoot()) {
  const missing: any[] = [];
  for (const name of [...DOLLAR_SKILL_NAMES, ...RECOMMENDED_SKILLS]) {
    if (!(await exists(path.join(skillRoot, name, 'SKILL.md')))) missing.push(name);
  }
  return { ok: missing.length === 0, root: skillRoot, missing };
}

export function globalCodexSkillsRoot(home: any = process.env.HOME || os.homedir()) {
  return path.join(home, '.agents', 'skills');
}

function isStableSksBin(candidate: any) {
  return Boolean(candidate) && !isTransientNpmBinPath(candidate);
}

function isTransientNpmBinPath(candidate: any) {
  const normalized = String(candidate || '').split(path.sep).join('/');
  return normalized.includes('/_npx/')
    || normalized.includes('/_cacache/tmp/')
    || /\/npm-cache\/_npx\//.test(normalized)
    || (/\/node_modules\/\.bin\/sks$/.test(normalized) && normalized.includes('/.npm-cache/'));
}

async function safeReadText(file: any, fallback: any = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}
