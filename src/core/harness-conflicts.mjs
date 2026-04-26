import path from 'node:path';
import fsp from 'node:fs/promises';
import { exists, readJson, readText } from './fsx.mjs';

export const OTHER_HARNESS_NAMES = ['OMX', 'DCodex'];

export async function scanHarnessConflicts(root, opts = {}) {
  const projectRoot = path.resolve(root || process.cwd());
  const home = opts.home || process.env.HOME || '';
  const includeGlobal = opts.includeGlobal !== false;
  const conflicts = [];
  conflicts.push(...await scanProjectHarnessConflicts(projectRoot));
  if (includeGlobal && home) conflicts.push(...await scanGlobalHarnessConflicts(home));
  const hard = conflicts.filter((x) => x.hard_block);
  const repairable = conflicts.filter((x) => x.repairable && !x.hard_block);
  return {
    ok: hard.length === 0,
    hard_block: hard.length > 0,
    requires_human_approval: conflicts.some((x) => x.requires_human_approval),
    project_root: projectRoot,
    global_home: home || null,
    conflicts,
    hard,
    repairable
  };
}

async function scanProjectHarnessConflicts(root) {
  const out = [];
  for (const marker of [
    { rel: '.omx', name: 'OMX' },
    { rel: '.dcodex', name: 'DCodex' }
  ]) {
    const abs = path.join(root, marker.rel);
    if (await exists(abs)) out.push(blockingConflict('project', abs, `${marker.name} project harness marker exists`, `${marker.name} must be removed before SKS can be installed.`));
  }

  const hooksPath = path.join(root, '.codex', 'hooks.json');
  const hooksText = await readText(hooksPath, null);
  if (typeof hooksText === 'string') {
    const lower = hooksText.toLowerCase();
    if (/\bomx\b|\.omx|omx[-_ ]?harness/.test(lower)) {
      out.push(blockingConflict('project', hooksPath, 'OMX Codex hook detected', 'OMX hooks cannot coexist with SKS hooks.'));
    } else if (/\bdcodex\b|\.dcodex|dcodex[-_ ]?harness/.test(lower)) {
      out.push(blockingConflict('project', hooksPath, 'DCodex hook detected', 'DCodex hooks cannot coexist with SKS hooks.'));
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
    out.push(blockingConflict('project', path.join(root, '.codex', 'config.toml'), 'Other harness marker detected in Codex config', 'Remove the other harness config before SKS setup.'));
  }

  const pkg = await readJson(path.join(root, 'package.json'), null);
  if (pkg) {
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
    for (const name of Object.keys(deps)) {
      if (isOtherHarnessPackage(name)) {
        out.push(blockingConflict('project', path.join(root, 'package.json'), `Other Codex harness package dependency detected: ${name}`, 'Remove the conflicting package before SKS setup.'));
      }
    }
  }
  return out;
}

async function scanGlobalHarnessConflicts(home) {
  const out = [];
  for (const rel of [
    '.omx',
    '.omxrc',
    '.config/omx',
    'Library/Application Support/OMX',
    '.dcodex',
    '.dcodexrc',
    '.config/dcodex',
    'Library/Application Support/DCodex'
  ]) {
    const abs = path.join(home, rel);
    if (await exists(abs)) {
      const name = rel.toLowerCase().includes('omx') ? 'OMX' : 'DCodex';
      out.push(blockingConflict('global', abs, `${name} global harness marker exists`, `${name} must be removed globally before SKS can be installed.`));
    }
  }

  const globalCodex = path.join(home, '.codex', 'config.toml');
  const configText = await readText(globalCodex, null);
  if (typeof configText === 'string' && /\bomx\b|\.omx|\bdcodex\b|\.dcodex/i.test(configText)) {
    out.push(blockingConflict('global', globalCodex, 'Other harness marker detected in global Codex config', 'Remove the other harness global config before SKS setup.'));
  }
  return out;
}

function blockingConflict(scope, filePath, reason, recommendation) {
  return {
    id: reason.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
    scope,
    path: filePath,
    severity: 'blocker',
    reason,
    recommendation,
    hard_block: true,
    repairable: false,
    requires_human_approval: true
  };
}

function hasForeignCodexHooks(text) {
  const parsed = safeJson(text);
  if (!parsed?.hooks) return false;
  const commands = [];
  collectHookCommands(parsed.hooks, commands);
  if (!commands.length) return false;
  return commands.some((cmd) => !/\b(sks|sneakoscope)\b|node\s+\S*node_modules\/sneakoscope\/bin\/sks\.mjs|node\s+\S*bin\/sks\.mjs/i.test(cmd));
}

function collectHookCommands(value, out) {
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

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function isOtherHarnessPackage(name) {
  return /(^|[-_@/])(omx|dcodex)([-_@/]|$)/i.test(String(name || ''));
}

export function formatHarnessConflictReport(scan, opts = {}) {
  if (!scan?.conflicts?.length) return 'No conflicting Codex harness detected.';
  const lines = [];
  lines.push('Conflicting Codex harness detected. SKS installation/setup is blocked until it is removed with human approval.');
  for (const item of scan.conflicts) {
    lines.push(`- [${item.severity}] ${item.scope}: ${item.path}`);
    lines.push(`  reason: ${item.reason}`);
    lines.push(`  action: ${item.recommendation}`);
  }
  if (scan.hard_block) {
    lines.push('');
    lines.push('If you do not approve removing the conflicting harness, SKS cannot be installed in this environment.');
  }
  if (opts.includePrompt !== false) {
    lines.push('');
    lines.push('Cleanup prompt for an LLM operator:');
    lines.push(llmHarnessCleanupPrompt(scan));
  }
  return lines.join('\n');
}

export function llmHarnessCleanupPrompt(scan) {
  const paths = (scan?.conflicts || []).map((x) => `- ${x.scope}: ${x.path} (${x.reason})`).join('\n') || '- No paths supplied. Re-run `sks doctor --json` first.';
  return `Use GPT-5.5 with reasoning effort high.

Goal: completely remove the conflicting Codex harnesses before installing Sneakoscope Codex.

Rules:
- You must ask the human for explicit approval before any destructive command.
- If approval is denied, stop and state that Sneakoscope Codex cannot be installed while the conflicting harness remains.
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

export async function repairSksGeneratedArtifacts(root, opts = {}) {
  const removed = [];
  const rels = [
    '.codex/hooks.json',
    '.codex/config.toml',
    '.codex/SNEAKOSCOPE.md',
    '.codex/agents',
    '.agents/skills',
    '.codex/skills',
    '.sneakoscope/manifest.json',
    '.sneakoscope/policy.json',
    '.sneakoscope/db-safety.json',
    '.sneakoscope/harness-guard.json'
  ];
  for (const rel of rels) {
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
