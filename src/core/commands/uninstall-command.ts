import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { ensureDir, exists, readJson, readText, runProcess, writeJsonAtomic } from '../fsx.js';
import { ui as cliUi } from '../../cli/cli-theme.js';
import { uninstallSksMenuBar } from '../codex-app/menubar/index.js';
import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { sweepSksTempDirs } from '../retention.js';
import { reconcileSkills } from '../init/skills.js';
import { removeTriwikiAgentsMdBlocks } from '../triwiki/agents-md-projector.js';

interface UninstallInventoryItem {
  id: string;
  path: string;
  action: string;
  exists: boolean;
  bytes: number;
  flag: string;
}

export async function uninstallCommand(args: string[] = []) {
  const opts = {
    yes: hasFlag(args, '--yes') || hasFlag(args, '-y'),
    dryRun: hasFlag(args, '--dry-run'),
    json: hasFlag(args, '--json'),
    keepConfig: hasFlag(args, '--keep-config'),
    keepData: hasFlag(args, '--keep-data'),
    purgeProjects: hasFlag(args, '--purge-projects'),
    home: readOption(args, '--home', os.homedir()),
    root: process.cwd()
  };
  const inventory = await collectSksInventory(opts);
  if (opts.dryRun) {
    const result = { schema: 'sks.uninstall.v1', ok: true, dry_run: true, inventory };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    else {
      cliUi.banner('uninstall');
      cliUi.warn('dry run only');
      printInventoryTable(inventory);
    }
    return result;
  }
  if (!opts.yes && !(await confirmUninstall())) {
    const result = { schema: 'sks.uninstall.v1', ok: true, aborted: true, inventory };
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    return result;
  }

  const report: any = { schema: 'sks.uninstall.v1', ok: true, removed: [], skipped: [], errors: [], inventory };
  await step(report, 'menubar', () => uninstallSksMenuBar({ home: opts.home, root: opts.root }));
  await step(report, 'launchctl-env', () => unsetLaunchctlEnv(['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY', 'CODEX_LB_BASE_URL']));
  await step(report, 'global-skills', () => removeGlobalSksSkills(path.join(opts.home, '.agents', 'skills')));
  await step(report, 'lazycodex-agents', () => removeLazycodexAgents(path.join(opts.home, '.codex', 'agents')));
  if (!opts.keepData) {
    await step(report, 'sks-home', async () => {
      await fsp.rm(path.join(opts.home, '.sneakoscope'), { recursive: true, force: true });
      await fsp.rm(path.join(opts.home, '.sneakoscope-global'), { recursive: true, force: true });
    });
  } else {
    report.skipped.push({ id: 'sks-home', reason: '--keep-data' });
  }
  await step(report, 'tmp', () => sweepUninstallTemp(opts.root));
  if (!opts.keepConfig) {
    await step(report, 'codex-config', () => stripSksOwnedConfig(path.join(opts.home, '.codex', 'config.toml'), opts.root));
    await step(report, 'hooks-json', () => removeSksEntriesFromHooksJson(path.join(opts.home, '.codex', 'hooks.json')));
  } else {
    report.skipped.push({ id: 'codex-config', reason: '--keep-config' });
    report.skipped.push({ id: 'hooks-json', reason: '--keep-config' });
  }
  if (opts.purgeProjects) await step(report, 'project-artifacts', () => purgeProjectArtifacts(report, opts));
  else report.skipped.push({ id: 'project-artifacts', reason: 'requires --purge-projects' });
  report.final_step = 'npm uninstall -g sneakoscope';
  await writeJsonAtomic(path.join(os.tmpdir(), 'sks-uninstall-report.json'), report).catch(() => undefined);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else {
    cliUi.banner('uninstall');
    report.ok ? cliUi.ok('removed configured SKS surfaces') : cliUi.fail('uninstall completed with errors');
    console.log('SKS uninstall complete.');
    console.log('Final package removal command: npm uninstall -g sneakoscope');
  }
  if (report.errors.length) process.exitCode = 1;
  return report;
}

async function collectSksInventory(opts: any): Promise<UninstallInventoryItem[]> {
  const home = opts.home;
  const rows: Array<[string, string, string, string]> = [
    ['menubar-dir', path.join(home, '.codex', 'sks-menubar'), 'remove', 'default'],
    ['menubar-plist', path.join(home, 'Library', 'LaunchAgents', 'com.sneakoscope.sks-menubar.plist'), 'remove', 'default'],
    ['global-skills', path.join(home, '.agents', 'skills'), 'remove', 'default'],
    ['lazycodex-agents', path.join(home, '.codex', 'agents'), 'remove lazycodex-*.toml', 'default'],
    ['codex-config', path.join(home, '.codex', 'config.toml'), 'strip SKS-owned TOML', '--keep-config'],
    ['hooks-json', path.join(home, '.codex', 'hooks.json'), 'strip SKS-managed hooks', '--keep-config'],
    ['sks-home', path.join(home, '.sneakoscope'), 'remove', '--keep-data'],
    ['sks-global-home', path.join(home, '.sneakoscope-global'), 'remove', '--keep-data'],
    ['agents-md-memory-block', path.join(opts.root, 'AGENTS.md'), 'strip SKS Project Memory block', '--purge-projects'],
    ['tmp', os.tmpdir(), 'sweep sks temp dirs', 'default']
  ];
  const out: UninstallInventoryItem[] = [];
  for (const [id, file, action, flag] of rows) {
    out.push({ id, path: file, action, flag, exists: await exists(file), bytes: id === 'tmp' ? 0 : await pathBytes(file) });
  }
  if (opts.purgeProjects) {
    for (const root of await knownProjectRoots(home, opts.root)) {
      out.push({ id: 'project-artifacts', path: root, action: 'purge SKS project artifacts', flag: '--purge-projects', exists: await exists(root), bytes: 0 });
    }
  }
  return out;
}

function printInventoryTable(inventory: UninstallInventoryItem[]) {
  console.log('SKS uninstall inventory');
  for (const item of inventory) {
    console.log(`${item.exists ? 'yes' : ' no'}  ${item.id.padEnd(18)} ${item.action.padEnd(28)} ${item.path}`);
  }
}

async function confirmUninstall() {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question('위 SKS 항목을 제거합니다. 계속할까요? [y/N] ');
    return /^y(?:es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function step(report: any, id: string, run: () => Promise<any>) {
  try {
    const result = await run();
    report.removed.push({ id, result: summarizeStepResult(result) });
  } catch (err: any) {
    report.ok = false;
    report.errors.push({ id, error: err?.message || String(err) });
  }
}

function summarizeStepResult(result: any) {
  if (!result || typeof result !== 'object') return result ?? 'ok';
  return {
    ok: result.ok ?? true,
    status: result.status || null,
    actions: Array.isArray(result.actions) ? result.actions.length : undefined,
    blockers: Array.isArray(result.blockers) ? result.blockers : undefined
  };
}

async function unsetLaunchctlEnv(names: string[]) {
  for (const name of names) {
    await runProcess('launchctl', ['unsetenv', name], { timeoutMs: 2000, maxOutputBytes: 4096 }).catch(() => null);
  }
}

async function removeLazycodexAgents(dir: string) {
  const rows = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const row of rows) {
    if (row.isFile() && /^lazycodex-.*\.toml$/.test(row.name)) await fsp.rm(path.join(dir, row.name), { force: true });
  }
}

async function removeGlobalSksSkills(skillsDir: string) {
  const rows = await fsp.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
  const removed: string[] = [];
  const preserved: string[] = [];
  for (const row of rows) {
    if (!row.isDirectory()) continue;
    const dir = path.join(skillsDir, row.name);
    const text = await readText(path.join(dir, 'SKILL.md'), null);
    if (typeof text !== 'string') continue;
    if (/BEGIN SKS (?:IMMUTABLE CORE|MANAGED) SKILL|Sneakoscope|Dollar-command route|Codex App pipeline activation|SKS managed/i.test(text)) {
      await fsp.rm(dir, { recursive: true, force: true });
      removed.push(row.name);
    } else {
      preserved.push(row.name);
    }
  }
  await fsp.rm(path.join(skillsDir, '.sks-generated.json'), { force: true }).catch(() => null);
  await fsp.rm(path.join(skillsDir, 'skills-manifest.json'), { force: true }).catch(() => null);
  return { ok: true, status: 'reconciled', removed, preserved };
}

async function stripSksOwnedConfig(configPath: string, root: string) {
  if (!(await exists(configPath))) return { ok: true, status: 'absent' };
  return writeCodexConfigGuarded({
    root,
    configPath,
    cause: 'sks-uninstall',
    backupTag: 'pre-uninstall',
    preserveFastUiKeys: false,
    mutate: (before) => stripSksOwnedToml(before)
  });
}

function stripSksOwnedToml(text: string) {
  let next = removeTomlTables(String(text || ''), [
    /^model_providers\.codex-lb$/,
    /^profiles\.sks-/,
    /^user\.fast_mode$/,
    /^hooks\.state\./,
    /^agents\.lazycodex-/
  ]);
  next = next.split(/\r?\n/).filter((line) => {
    if (/^\s*default_profile\s*=\s*"sks-[^"]*"/.test(line)) return false;
    if (/^\s*service_tier\s*=\s*"fast"/.test(line)) return false;
    return true;
  }).join('\n');
  return `${next.trim()}\n`;
}

function removeTomlTables(text: string, patterns: RegExp[]) {
  const lines = String(text || '').split(/\r?\n/);
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) skipping = patterns.some((pattern) => pattern.test(header[1] || ''));
    if (!skipping) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

async function removeSksEntriesFromHooksJson(hooksPath: string) {
  const hooks = await readJson<any>(hooksPath, null).catch(() => null);
  if (!hooks || typeof hooks !== 'object') return { ok: true, status: 'absent_or_invalid' };
  const next = pruneHooksValue(hooks);
  await ensureDir(path.dirname(hooksPath));
  await writeJsonAtomic(hooksPath, next);
  return { ok: true, status: 'written' };
}

function pruneHooksValue(value: any): any {
  if (Array.isArray(value)) {
    return value
      .map((item) => pruneHooksValue(item))
      .filter((item) => !isSksHookEntry(item));
  }
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [key, child] of Object.entries(value)) {
      const pruned = pruneHooksValue(child);
      if (Array.isArray(pruned) && pruned.length === 0) out[key] = pruned;
      else out[key] = pruned;
    }
    return out;
  }
  return value;
}

function isSksHookEntry(entry: any) {
  const text = JSON.stringify(entry || {});
  return /\bsks\s+hook\b|Sneakoscope|SKS/i.test(text);
}

async function sweepUninstallTemp(root: string) {
  if (process.env.SKS_UNINSTALL_SKIP_TMP_SWEEP === '1') return { ok: true, skipped: true, reason: 'SKS_UNINSTALL_SKIP_TMP_SWEEP=1', actions: [] };
  const report = await sweepSksTempDirs(root, { maxAgeHours: 0 });
  const tmp = os.tmpdir();
  const rows = await fsp.readdir(tmp, { withFileTypes: true }).catch(() => []);
  for (const row of rows) {
    if (!/^(?:sks|opensks-)/.test(row.name)) continue;
    await fsp.rm(path.join(tmp, row.name), { recursive: true, force: true }).catch(() => null);
  }
  return report;
}

async function purgeProjectArtifacts(report: any, opts: any) {
  for (const root of await knownProjectRoots(opts.home, opts.root)) {
    await reconcileSkills({ targetDir: path.join(root, '.agents', 'skills'), scope: 'project', fix: true }).catch((err: any) => {
      report.errors.push({ id: 'project-skills', root, error: err?.message || String(err) });
    });
    await fsp.rm(path.join(root, '.codex'), { recursive: true, force: true }).catch(() => null);
    const removedBlocks = await removeTriwikiAgentsMdBlocks(root).catch((err: any) => {
      report.errors.push({ id: 'agents-md-memory-block', root, error: err?.message || String(err) });
      return [];
    });
    if (removedBlocks.length) report.removed.push({ id: 'agents-md-memory-block', root, result: { ok: true, files: removedBlocks.length } });
    await fsp.rm(path.join(root, 'SNEAKOSCOPE.md'), { force: true }).catch(() => null);
    if (!opts.keepData) await fsp.rm(path.join(root, '.sneakoscope'), { recursive: true, force: true }).catch(() => null);
  }
}

async function knownProjectRoots(home: string, cwd: string) {
  const roots = new Set<string>([cwd]);
  const config = await readText(path.join(home, '.codex', 'config.toml'), '').catch(() => '');
  const re = /^\s*\[projects\."([^"]+)"\]\s*$/gm;
  for (const match of config.matchAll(re)) roots.add(match[1] || '');
  return [...roots].filter(Boolean);
}

async function pathBytes(file: string): Promise<number> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  const rows = await fsp.readdir(file, { withFileTypes: true }).catch(() => []);
  for (const row of rows) total += await pathBytes(path.join(file, row.name));
  return total;
}

function hasFlag(args: string[], name: string) {
  return args.includes(name);
}

function readOption(args: string[], name: string, fallback: string) {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? String(args[idx + 1]) : fallback;
}
