import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, nowIso, readText, writeJsonAtomic } from '../fsx.js';
import { messageOf } from '../errors/message.js';

export const LEGACY_GLOBAL_HOOK_CLEANUP_SCHEMA = 'sks.legacy-global-hook-cleanup.v1';

export async function cleanupLegacyGlobalSksHooks(input: {
  root: string;
  home?: string;
  apply?: boolean;
  reportPath?: string | null;
}) {
  const root = path.resolve(input.root);
  const home = input.home || os.homedir();
  const globalPath = path.join(home, '.codex', 'hooks.json');
  const projectPath = path.join(root, '.codex', 'hooks.json');
  const globalParsed = await readHooks(globalPath);
  const projectParsed = await readHooks(projectPath);
  const warnings: string[] = [];
  const blockers: string[] = [];
  if (globalParsed.error) blockers.push(`global_hooks_json_invalid:${globalParsed.error}`);
  if (projectParsed.error) warnings.push(`project_hooks_json_invalid:${projectParsed.error}`);

  const projectRefs = projectParsed.value ? collectProjectSksHookRefs(projectParsed.value) : new Set<string>();
  const pruned = globalParsed.value
    ? pruneDuplicatedGlobalHooks(globalParsed.value, projectRefs)
    : { value: globalParsed.value, removed: [] as string[] };
  if (pruned.removed.length && projectRefs.size === 0) blockers.push('project_sks_hooks_missing_no_safe_global_cleanup');

  let backupPath: string | null = null;
  let rollbackPerformed = false;
  let applied = false;
  if (input.apply === true && pruned.removed.length && blockers.length === 0) {
    backupPath = `${globalPath}.sks-legacy-global-${Date.now().toString(36)}.bak`;
    try {
      await ensureDir(path.dirname(globalPath));
      await fs.copyFile(globalPath, backupPath);
      await writeJsonAtomic(globalPath, pruned.value);
      const postcheck = await readHooks(globalPath);
      const remaining = postcheck.value ? pruneDuplicatedGlobalHooks(postcheck.value, projectRefs).removed : [];
      if (postcheck.error || remaining.length) throw new Error(postcheck.error || `duplicate_hooks_remain:${remaining.join(',')}`);
      applied = true;
      await pruneOldBackups(globalPath, backupPath);
    } catch (err: unknown) {
      blockers.push(`legacy_global_hook_cleanup_failed:${messageOf(err)}`);
      if (backupPath) {
        try {
          await fs.copyFile(backupPath, globalPath);
          rollbackPerformed = true;
        } catch (rollbackErr: unknown) {
          blockers.push(`legacy_global_hook_cleanup_rollback_failed:${messageOf(rollbackErr)}`);
        }
      }
    }
  }

  let report: any = {
    schema: LEGACY_GLOBAL_HOOK_CLEANUP_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    root,
    apply: input.apply === true,
    global_hooks_path: globalPath,
    project_hooks_path: projectPath,
    project_sks_hook_count: projectRefs.size,
    duplicate_global_hooks: pruned.removed,
    removed_count: applied ? pruned.removed.length : 0,
    applied,
    backup_path: backupPath,
    rollback_performed: rollbackPerformed,
    non_sks_hooks_preserved: true,
    requires_new_task: applied,
    restart_app_if_stale: applied,
    next_actions: applied ? [
      'Start a new Codex/Work task so only the project-local SKS hooks are loaded.',
      'If duplicate hook output persists, restart the ChatGPT/Codex desktop app and retry in a new task.'
    ] : [],
    blockers,
    warnings
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'legacy-global-hook-cleanup.json');
    await writeJsonAtomic(reportPath, report).catch((err: unknown) => {
      report = { ...report, report_write_failed: true, warnings: [...warnings, `report_write_failed:${messageOf(err)}`] };
    });
    report.report_path = reportPath;
  }
  return report;
}

function collectProjectSksHookRefs(value: any) {
  const refs = new Set<string>();
  forEachHook(value, (event, matcher, hook) => {
    const command = projectSksHookCommand(hook?.command);
    if (command && hook?.type === 'command') refs.add(hookRef(event, matcher, command));
  });
  return refs;
}

function pruneDuplicatedGlobalHooks(value: any, projectRefs: Set<string>) {
  const next = structuredClone(value);
  const container = hookContainer(next);
  const removed: string[] = [];
  for (const [event, groups] of Object.entries(container)) {
    if (!Array.isArray(groups)) continue;
    const keptGroups = groups.flatMap((group: any) => {
      if (!group || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook: any) => {
        const command = legacyGlobalSksHookCommand(hook?.command);
        const ref = hookRef(event, group?.matcher, command || '');
        if (hook?.type !== 'command' || !command || !projectRefs.has(ref)) return true;
        removed.push(ref);
        return false;
      });
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (keptGroups.length) container[event] = keptGroups;
    else delete container[event];
  }
  return { value: next, removed };
}

function forEachHook(value: any, visit: (event: string, matcher: unknown, hook: any) => void) {
  for (const [event, groups] of Object.entries(hookContainer(value))) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups as any[]) {
      for (const hook of Array.isArray(group?.hooks) ? group.hooks : []) visit(event, group?.matcher, hook);
    }
  }
}

function hookContainer(value: any): Record<string, any> {
  return value?.hooks && typeof value.hooks === 'object' && !Array.isArray(value.hooks) ? value.hooks : value;
}

function legacyGlobalSksHookCommand(value: unknown) {
  const command = String(value || '').trim();
  if (/[;&|`$<>\r\n]/.test(command)) return null;
  return command.match(/^(?:\S*\/)?sks\s+hook\s+([a-z0-9-]+)$/i)?.[1] || null;
}

function projectSksHookCommand(value: unknown) {
  const command = String(value || '').trim();
  if (/[;&|`$<>\r\n]/.test(command)) return null;
  // `node ./dist/bin/sks.js` is the prefix used only inside this development
  // repository (see sksCommandPrefix in init.ts). Real installs write `sks` or
  // `node ./node_modules/sneakoscope/dist/bin/sks.js`, so neither matched and
  // the cleanup silently removed nothing and still reported ok. The shell
  // metacharacter reject above is unchanged and still gates every form.
  return command.match(/^(?:\S*[\\/])?(?:node\s+\S*sks\.js|sks)\s+hook\s+([a-z0-9-]+)$/i)?.[1] || null;
}

function hookRef(event: string, matcher: unknown, command: string) {
  return `${event}:${String(matcher ?? '')}:${command}`;
}

async function readHooks(file: string): Promise<{ value: any | null; error: string | null }> {
  const text = await readText(file, '');
  if (!text.trim()) return { value: null, error: null };
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? { value, error: null } : { value: null, error: 'root_not_object' };
  } catch (err: unknown) {
    return { value: null, error: messageOf(err) };
  }
}

async function pruneOldBackups(globalPath: string, keepPath: string) {
  const dir = path.dirname(globalPath);
  const prefix = `${path.basename(globalPath)}.sks-legacy-global-`;
  const directoryEntries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const entries = directoryEntries
    .filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.bak'))
    .map((entry) => path.join(dir, entry.name));
  const ranked = await Promise.all(entries.map(async (file) => ({ file, mtime: (await fs.stat(file)).mtimeMs })));
  ranked.sort((a, b) => b.mtime - a.mtime);
  for (const row of ranked.slice(3)) if (row.file !== keepPath) await fs.rm(row.file, { force: true }).catch(() => undefined);
}
