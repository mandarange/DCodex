import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exists, runProcess } from '../../../fsx.js';
import type { SksMenuBarTargetCheck } from '../types.js';

export async function resolveSksEntryForInstall(
  explicit: string | undefined,
  root: string
): Promise<SksMenuBarTargetCheck> {
  const packaged = fileURLToPath(new URL('../../../../bin/sks.js', import.meta.url));
  const requested = explicit ? path.resolve(explicit) : null;
  const candidate = requested || packaged;
  const found = await exists(candidate);
  const relative = path.relative(path.resolve(root), candidate);
  return {
    requested, resolved: found ? candidate : null, packaged, exists: found,
    project_local: relative === '' || (Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative)),
    used_previous_script: false
  };
}

export async function toolVersion(tool: string, args: string[]): Promise<string> {
  const result = await runProcess(tool, args, { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return result.code === 0 ? String(result.stdout || result.stderr).trim().split(/\r?\n/)[0] || 'unknown' : 'unknown';
}

export function realUserHome(): string {
  try { return path.resolve(os.userInfo().homedir); } catch { return path.resolve(os.homedir()); }
}
