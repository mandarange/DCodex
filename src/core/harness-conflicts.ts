import path from 'node:path';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { writeCodexConfigGuarded } from './codex/codex-config-guard.js';
import { exists, readJson, readText, writeJsonAtomic } from './fsx.js';

export const OTHER_HARNESS_NAMES = ['OMX', 'DCodex'];

export async function scanHarnessConflicts(root: any, opts: any = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  const home = opts.home || process.env.HOME || '';
  const codexHomes = [...new Set([
    home ? path.join(home, '.codex') : '',
    opts.codexHome || process.env.CODEX_HOME || ''
  ].filter(Boolean).map((entry) => path.resolve(entry)))];
  const includeGlobal = opts.includeGlobal !== false;
  const conflicts: any[] = [];
  conflicts.push(...await scanProjectHarnessConflicts(projectRoot));
  if (includeGlobal && (home || codexHomes.length)) conflicts.push(...await scanGlobalHarnessConflicts(home, codexHomes));
  const hard = conflicts.filter((x: any) => x.hard_block);
  const repairable = conflicts.filter((x: any) => x.repairable && !x.hard_block);
  return {
    ok: hard.length === 0,
    hard_block: hard.length > 0,
    requires_human_approval: false,
    project_root: projectRoot,
    global_home: home || null,
    global_codex_homes: codexHomes,
    conflicts,
    hard,
    repairable
  };
}

/**
 * Remove OMX/DCodex harness markers from the live Codex surface.
 * Markers are moved out of the active tree (not left in place). A backup copy is kept under
 * `.sneakoscope/quarantine/other-harness/<runId>/` (project or global) before live removal.
 * Invoked by `sks conflicts cleanup --yes` and by the `sks update`
 * `other-harness-cleanup` migration stage.
 */
export async function cleanupOtherHarnessConflicts(root: any, opts: any = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const runId = String(opts.runId || `${Date.now()}-${process.pid}`);
  const before = await scanHarnessConflicts(projectRoot, { ...opts, home });
  if (!before.hard.length) {
    return {
      schema: 'sks.other-harness-cleanup.v1',
      ok: true,
      status: 'clean',
      project_root: projectRoot,
      run_id: runId,
      cleaned: [],
      remaining: [],
      errors: [],
      before,
      after: before
    };
  }

  const cleaned: Array<{ path: string; action: string; quarantine?: string | null }> = [];
  const errors: Array<{ path: string; error: string }> = [];
  const seen = new Set<string>();

  for (const conflict of before.hard) {
    const target = path.resolve(String(conflict.path || ''));
    if (!target || seen.has(target)) continue;
    seen.add(target);
    try {
      const result = await cleanupOneHardConflict({
        projectRoot,
        home,
        runId,
        conflict: { ...conflict, path: target }
      });
      cleaned.push(result);
    } catch (err: any) {
      errors.push({ path: target, error: err?.message || String(err) });
    }
  }

  const after = await scanHarnessConflicts(projectRoot, { ...opts, home });
  return {
    schema: 'sks.other-harness-cleanup.v1',
    ok: after.hard.length === 0 && errors.length === 0,
    status: after.hard.length === 0 && errors.length === 0 ? 'cleaned' : 'blocked',
    project_root: projectRoot,
    run_id: runId,
    cleaned,
    remaining: after.hard,
    errors,
    before,
    after
  };
}

async function cleanupOneHardConflict(input: {
  projectRoot: string;
  home: string;
  runId: string;
  conflict: { path: string; scope?: string; reason?: string };
}): Promise<{ path: string; action: string; quarantine?: string | null }> {
  const target = input.conflict.path;
  const basename = path.basename(target).toLowerCase();
  const quarantineRoot = quarantineRootFor(input.projectRoot, input.home, input.conflict.scope, input.runId);

  if (basename === 'package.json') {
    const quarantine = await quarantineCopy(target, quarantineRoot, input.projectRoot, input.home);
    await stripOtherHarnessPackages(target);
    return { path: target, action: 'stripped_other_harness_packages', quarantine };
  }

  if (basename === 'config.toml') {
    const quarantine = await quarantineCopy(target, quarantineRoot, input.projectRoot, input.home);
    await stripOtherHarnessConfigMarkers(target, input.projectRoot);
    return { path: target, action: 'stripped_other_harness_config_markers', quarantine };
  }

  if (basename === 'hooks.json') {
    const quarantine = await quarantineCopy(target, quarantineRoot, input.projectRoot, input.home);
    await fsp.rm(target, { force: true });
    return { path: target, action: 'quarantined_other_harness_hooks', quarantine };
  }

  // Marker directories/files (.omx, .dcodex, global config trees, Application Support folders).
  const quarantine = await quarantineMove(target, quarantineRoot, input.projectRoot, input.home);
  return { path: target, action: 'quarantined_other_harness_marker', quarantine };
}

function quarantineRootFor(projectRoot: string, home: string, scope: string | undefined, runId: string): string {
  if (scope === 'global') {
    return path.join(home, '.sneakoscope-global', 'quarantine', 'other-harness', runId);
  }
  return path.join(projectRoot, '.sneakoscope', 'quarantine', 'other-harness', runId);
}

async function quarantineCopy(source: string, quarantineRoot: string, projectRoot: string, home: string): Promise<string> {
  const dest = await uniqueQuarantinePath(source, quarantineRoot, projectRoot, home);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.cp(source, dest, { recursive: true, force: true });
  return dest;
}

async function quarantineMove(source: string, quarantineRoot: string, projectRoot: string, home: string): Promise<string> {
  const dest = await uniqueQuarantinePath(source, quarantineRoot, projectRoot, home);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fsp.rename(source, dest);
  } catch {
    await fsp.cp(source, dest, { recursive: true, force: true });
    await fsp.rm(source, { recursive: true, force: true });
  }
  return dest;
}

async function uniqueQuarantinePath(source: string, quarantineRoot: string, projectRoot: string, home: string): Promise<string> {
  const relative = relativeQuarantineName(source, projectRoot, home);
  let dest = path.join(quarantineRoot, relative);
  let index = 0;
  while (await exists(dest)) {
    index += 1;
    dest = path.join(quarantineRoot, `${relative}.keep-${index}`);
  }
  return dest;
}

function relativeQuarantineName(source: string, projectRoot: string, home: string): string {
  const abs = path.resolve(source);
  for (const root of [projectRoot, home]) {
    const rel = path.relative(root, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return abs.replace(/^[/\\]+/, '').replace(/[/\\:]+/g, '__');
}

async function stripOtherHarnessPackages(packageJsonPath: string): Promise<void> {
  const pkg = await readJson<any>(packageJsonPath, null);
  if (!pkg || typeof pkg !== 'object') throw new Error('other_harness_package_json_unreadable');
  let changed = false;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const bag = pkg[field];
    if (!bag || typeof bag !== 'object') continue;
    for (const name of Object.keys(bag)) {
      if (!isOtherHarnessPackage(name)) continue;
      delete bag[name];
      changed = true;
    }
    if (!Object.keys(bag).length) delete pkg[field];
  }
  if (changed) await writeJsonAtomic(packageJsonPath, pkg);
}

async function stripOtherHarnessConfigMarkers(configPath: string, projectRoot: string): Promise<void> {
  const before = await readText(configPath, '');
  const lines = String(before || '').split('\n');
  const next: string[] = [];
  let skippingTable = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^\s*\[.+\]\s*$/.test(trimmed)) {
      skippingTable = /\bomx\b|\.omx|\bdcodex\b|\.dcodex/i.test(trimmed);
      if (skippingTable) continue;
      next.push(line);
      continue;
    }
    if (skippingTable) continue;
    if (/\bomx\b|\.omx|\bdcodex\b|\.dcodex/i.test(line)) continue;
    next.push(line);
  }
  const text = `${next.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
  const write = await writeCodexConfigGuarded({
    root: projectRoot,
    configPath,
    before,
    cause: 'other-harness-cleanup',
    backupTag: 'other-harness-cleanup',
    ownershipVerified: true,
    verifyUnchangedBeforeWrite: true,
    expectedBeforeExists: true,
    preserveTextFormatting: true,
    mutate: () => text
  });
  if (!write.ok) throw new Error(`other_harness_config_write_${write.status}`);
}

async function scanProjectHarnessConflicts(root: any) {
  const out: any[] = [];
  for (const marker of [
    { rel: '.omx', name: 'OMX' },
    { rel: '.dcodex', name: 'DCodex' }
  ]) {
    const abs = path.join(root, marker.rel);
    if (await exists(abs)) out.push(blockingConflict('project', abs, `${marker.name} project harness marker exists`, `${marker.name} must be quarantined via \`sks conflicts cleanup --yes\` before SKS setup/update/doctor --fix.`));
  }

  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const hooksText = await readText(hooksPath, null);
  if (typeof hooksText === 'string') {
    const lower = hooksText.toLowerCase();
    if (/\bomx\b|\.omx|omx[-_ ]?harness/.test(lower)) {
      out.push(blockingConflict('project', hooksPath, 'OMX Codex hook detected', 'OMX hooks must be quarantined via `sks conflicts cleanup --yes`; SKS will reinstall managed hooks after cleanup.'));
    } else if (/\bdcodex\b|\.dcodex|dcodex[-_ ]?harness/.test(lower)) {
      out.push(blockingConflict('project', hooksPath, 'DCodex hook detected', 'DCodex hooks must be quarantined via `sks conflicts cleanup --yes`; SKS will reinstall managed hooks after cleanup.'));
    } else if (hasForeignCodexHooks(hooksText)) {
      out.push({
        id: 'foreign_codex_hooks',
        scope: 'project',
        path: hooksPath,
        severity: 'warning',
        reason: 'Existing Codex hooks are not SKS-managed.',
        recommendation: 'sks doctor --fix will replace generated Codex hook config with the current installed SKS template.',
        hard_block: false,
        repairable: true,
        requires_human_approval: false
      });
    }
  }

  const configText = await readText(path.join(root, '.codex', 'config.toml'), null);
  if (typeof configText === 'string' && /\bomx\b|\.omx|\bdcodex\b|\.dcodex/i.test(configText)) {
    out.push(blockingConflict('project', path.join(root, '.codex', 'config.toml'), 'Other harness marker detected in Codex config', 'Conflicting harness markers must be stripped via `sks conflicts cleanup --yes`.'));
  }

  const pkg = await readJson(path.join(root, 'package.json'), null);
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const name of Object.keys(deps)) {
      if (isOtherHarnessPackage(name)) {
        out.push(blockingConflict('project', path.join(root, 'package.json'), `Other Codex harness package dependency detected: ${name}`, 'Conflicting package dependencies must be removed via `sks conflicts cleanup --yes`.'));
      }
    }
  }
  return out;
}

async function scanGlobalHarnessConflicts(home: any, codexHomes: string[]) {
  const out: any[] = [];
  for (const rel of home ? [
    '.omx',
    '.omxrc',
    '.config/omx',
    'Library/Application Support/OMX',
    '.dcodex',
    '.dcodexrc',
    '.config/dcodex',
    'Library/Application Support/DCodex'
  ] : []) {
    const abs = path.join(home, rel);
    if (await exists(abs)) {
      const name = rel.toLowerCase().includes('omx') ? 'OMX' : 'DCodex';
      out.push(blockingConflict('global', abs, `${name} global harness marker exists`, `${name} global markers must be quarantined via \`sks conflicts cleanup --yes\` before SKS setup/update/doctor --fix.`));
    }
  }

  for (const codexHome of codexHomes) {
    const globalCodex = path.join(codexHome, 'config.toml');
    const configText = await readText(globalCodex, null);
    if (typeof configText === 'string' && /\bomx\b|\.omx|\bdcodex\b|\.dcodex/i.test(configText)) {
      out.push(blockingConflict('global', globalCodex, 'Other harness marker detected in global Codex config', 'Conflicting harness markers must be stripped via `sks conflicts cleanup --yes`.'));
    }
  }
  return out;
}

function blockingConflict(scope: any, filePath: any, reason: any, recommendation: any) {
  return {
    id: reason.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    scope,
    path: filePath,
    severity: 'blocker',
    reason,
    recommendation,
    hard_block: true,
    repairable: true,
    requires_human_approval: false
  };
}

function hasForeignCodexHooks(text: any) {
  const parsed = safeJson(text);
  if (!parsed?.hooks) return false;
  const commands: any[] = [];
  collectHookCommands(parsed.hooks, commands);
  if (!commands.length) return false;
  return commands.some((cmd: any) => !/\b(sks|sneakoscope)\b|node\s+\S*node_modules\/sneakoscope\/bin\/sks\.js|node\s+\S*bin\/sks\.js/i.test(cmd));
}

function collectHookCommands(value: any, out: any) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectHookCommands(item, out);
    return;
  }
  if (typeof value === 'object') {
    if (typeof value.command === 'string') out.push(value.command);
    for (const child of Object.values(value)) collectHookCommands(child, out);
  }
}

function safeJson(text: any) {
  try { return JSON.parse(text); } catch { return null; }
}

function isOtherHarnessPackage(name: any) {
  return /(^|[-_@/])(omx|dcodex)([-_@/]|$)/i.test(String(name || ''));
}

export function formatHarnessConflictReport(scan: any, opts: any = {}) {
  if (!scan?.conflicts?.length) return 'No conflicting Codex harness detected.';
  const lines: any[] = [];
  lines.push('Conflicting Codex harness detected. Run `sks conflicts cleanup --yes` to quarantine OMX/DCodex markers before setup, update, or doctor --fix.');
  for (const item of scan.conflicts) {
    lines.push(`- [${item.severity}] ${item.scope}: ${item.path}`);
    lines.push(`  reason: ${item.reason}`);
    lines.push(`  action: ${item.recommendation}`);
  }
  if (opts.includePrompt !== false) {
    lines.push('');
    lines.push('Cleanup prompt for an LLM operator:');
    lines.push(llmHarnessCleanupPrompt(scan));
  }
  return lines.join('\n');
}

export function llmHarnessCleanupPrompt(scan: any) {
  const paths = (scan?.conflicts || []).map((x: any) => `- ${x.scope}: ${x.path} (${x.reason})`).join('\n') || '- No paths supplied. Re-run `sks doctor --json` first.';
  return `Use GPT-5.6 with reasoning effort high.

Goal: completely remove the conflicting Codex harnesses before installing Sneakoscope Codex.

Rules:
- Prefer \`sks conflicts cleanup --yes\`, which quarantines OMX/DCodex markers with backup under \`.sneakoscope/quarantine/other-harness/\`.
- Remove only the conflicting harness artifacts listed below and any directly connected global/repo-level install traces you verify.
- Do not delete application source files, user project code, unrelated .codex settings, secrets, git history, or package manager caches unless they are verified harness-owned artifacts.
- Prefer moving questionable files to a timestamped backup folder before permanent deletion.
- After cleanup, verify with: sks doctor --fix, sks guard check, sks context7 check, and sks selftest --mock.

Conflicting artifacts:
${paths}

Expected final report:
1. What was removed or backed up.
2. What was intentionally preserved.
3. Verification commands and results.
4. Whether SKS installation is now allowed.`;
}

export async function repairSksGeneratedArtifacts(root: any, opts: any = {}) {
  const removed: any[] = [];
  const rels = [
    '.codex/hooks.json',
    '.codex/config.toml',
    '.codex/SNEAKOSCOPE.md',
    '.codex/agents',
    '.codex/skills',
    '.sneakoscope/manifest.json',
    '.sneakoscope/policy.json',
    '.sneakoscope/db-safety.json',
    '.sneakoscope/harness-guard.json'
  ];
  for (const rel of rels) {
    if (rel === '.codex/agents' && opts.preserveCodexAgents === true) continue;
    const abs = path.join(root, rel);
    if (!(await exists(abs))) continue;
    await fsp.rm(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  if (opts.resetState) {
    const current = path.join(root, '.sneakoscope', 'state', 'current.json');
    if (await exists(current)) {
      await fsp.rm(current, { force: true });
      removed.push('.sneakoscope/state/current.json');
    }
  }
  return { removed };
}
