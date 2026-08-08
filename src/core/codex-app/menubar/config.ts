import path from 'node:path';
import { findCodexApp } from '../../codex-app.js';
import { readJson, runProcess, which, writeJsonAtomic } from '../../fsx.js';
import type { SksMenuBarConfig } from './types.js';

export async function readMenuBarConfig(configPath: string): Promise<SksMenuBarConfig> {
  const value = await readJson<(Partial<SksMenuBarConfig> & { quit_with_codex?: boolean }) | null>(configPath, null);
  return {
    schema: 'sks.sks-menubar-config.v2',
    codex_bundle_id: typeof value?.codex_bundle_id === 'string' && value.codex_bundle_id.trim()
      ? value.codex_bundle_id.trim() : null,
    follow_codex_lifecycle: value?.follow_codex_lifecycle === true || value?.quit_with_codex === true
  };
}

export async function writeDefaultMenuBarConfig(configPath: string, codexBundleId: string | null): Promise<SksMenuBarConfig> {
  const previous = await readMenuBarConfig(configPath);
  const value: SksMenuBarConfig = {
    schema: 'sks.sks-menubar-config.v2',
    codex_bundle_id: codexBundleId || previous.codex_bundle_id,
    follow_codex_lifecycle: previous.follow_codex_lifecycle
  };
  await writeJsonAtomic(configPath, value);
  return value;
}

export async function resolveCodexBundleId(input: {
  home: string;
  env: NodeJS.ProcessEnv;
  warnings: string[];
}): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const appPath = await findCodexApp({ home: input.home, env: input.env }).catch(() => null);
  if (!appPath) {
    input.warnings.push('codex_app_not_found_for_bundle_sync');
    return null;
  }
  const mdls = input.env.SKS_MENUBAR_MDLS || await which('mdls').catch(() => null) || '/usr/bin/mdls';
  const metadata = await runProcess(mdls, ['-name', 'kMDItemCFBundleIdentifier', '-raw', appPath], {
    timeoutMs: 3_000, maxOutputBytes: 8 * 1024
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const metadataValue = String(metadata.stdout || '').trim();
  if (metadata.code === 0 && metadataValue && metadataValue !== '(null)' && metadataValue !== 'null') return metadataValue;
  const defaults = input.env.SKS_MENUBAR_DEFAULTS || await which('defaults').catch(() => null) || '/usr/bin/defaults';
  const plist = await runProcess(defaults, ['read', path.join(appPath, 'Contents', 'Info'), 'CFBundleIdentifier'], {
    timeoutMs: 3_000, maxOutputBytes: 8 * 1024
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return plist.code === 0 && String(plist.stdout || '').trim() ? String(plist.stdout).trim() : null;
}

export async function isCodexAppRunningByBundleId(bundleId: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (process.platform !== 'darwin' || !bundleId) return false;
  const osascript = env.SKS_MENUBAR_OSASCRIPT || await which('osascript').catch(() => null) || '/usr/bin/osascript';
  const result = await runProcess(osascript, ['-e', `application id "${bundleId.replace(/"/g, '\\"')}" is running`], {
    timeoutMs: 2_000, maxOutputBytes: 8 * 1024
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  return result.code === 0 && String(result.stdout || '').trim().toLowerCase() === 'true';
}
