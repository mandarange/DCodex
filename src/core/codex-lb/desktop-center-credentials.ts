import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists, runProcess, which } from '../fsx.js';
import {
  codexLbEnvPath,
  loadCodexLbEnv,
  type CodexLbEnvLoadResult
} from './codex-lb-env.js';
import type { CodexLbDesktopMode } from './desktop-mode.js';

/**
 * Center → official SKS store → live Desktop credential path.
 *
 * desktop-dual-auth-compat makes Codex Desktop read process/GUI env
 * `CODEX_LB_API_KEY` / `CODEX_LB_BASE_URL` via env_http_headers. Those values
 * must come from the official Center store (sks-codex-lb.env / keychain
 * sks-codex-lb), not a shell `source` or a twin file.
 */

export const CODEX_LB_STALE_ENV_TWINS = ['codex-lb.env', 'sks.env'] as const;
export const CODEX_LB_STALE_KEYCHAIN_SERVICES = ['CODEX_LB_API_KEY'] as const;
export const CODEX_LB_OFFICIAL_KEYCHAIN_SERVICE = 'sks-codex-lb' as const;

export type DesktopCenterCredentialSyncResult = {
  schema: 'sks.codex-lb-desktop-center-credentials.v1';
  ok: boolean;
  status: string;
  mode: CodexLbDesktopMode | string;
  api_key_fingerprint: string | null;
  base_url_present: boolean;
  launch_env: {
    api_key: 'set' | 'unset' | 'skipped' | 'failed';
    base_url: 'set' | 'unset' | 'skipped' | 'failed';
  };
  stale_twins_removed: string[];
  stale_keychain_cleared: string[];
  blockers: string[];
};

export async function loadOfficialCodexLbCredentials(opts: {
  home?: string;
  envPath?: string;
  metadataPath?: string;
  loadCodexLbEnvImpl?: typeof loadCodexLbEnv;
} = {}): Promise<CodexLbEnvLoadResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const load = opts.loadCodexLbEnvImpl || loadCodexLbEnv;
  // Ignore ambient process.env so a stale shell export cannot shadow Center.
  return load({
    home,
    processEnv: {},
    envPath: opts.envPath || codexLbEnvPath(home),
    ...(opts.metadataPath ? { metadataPath: opts.metadataPath } : {})
  });
}

export async function purgeStaleCodexLbCredentialTwins(opts: {
  home?: string;
  account?: string;
  securityBin?: string;
  runProcessImpl?: typeof runProcess;
} = {}): Promise<{ removed: string[]; keychain_cleared: string[]; blockers: string[] }> {
  const home = opts.home || process.env.HOME || os.homedir();
  const codexHome = path.join(home, '.codex');
  const removed: string[] = [];
  const blockers: string[] = [];
  for (const name of CODEX_LB_STALE_ENV_TWINS) {
    const target = path.join(codexHome, name);
    try {
      await fsp.lstat(target);
      await fsp.rm(target, { force: true });
      removed.push(target);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        blockers.push(`stale_twin_remove_failed:${name}`);
      }
    }
  }

  const keychainCleared: string[] = [];
  if (process.platform === 'darwin') {
    const security = opts.securityBin
      || await which('security').catch(() => null)
      || (await exists('/usr/bin/security') ? '/usr/bin/security' : null);
    const account = opts.account || process.env.USER || 'sks';
    const run = opts.runProcessImpl || runProcess;
    if (security) {
      for (const service of CODEX_LB_STALE_KEYCHAIN_SERVICES) {
        const result = await run(security, [
          'delete-generic-password',
          '-a',
          account,
          '-s',
          service
        ], { timeoutMs: 5000, maxOutputBytes: 8192 }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
        // errSecItemNotFound is success for purge.
        if (result.code === 0 || /could not be found|errSecItemNotFound|-25300/i.test(String(result.stderr || result.stdout || ''))) {
          if (result.code === 0) keychainCleared.push(service);
        }
      }
    }
  }

  return { removed, keychain_cleared: keychainCleared, blockers };
}

export async function syncDesktopCenterLaunchCredentials(opts: {
  mode: CodexLbDesktopMode | string;
  home?: string;
  loadedEnv?: CodexLbEnvLoadResult;
  launchctlBin?: string;
  force?: boolean;
  skipPurge?: boolean;
  platform?: NodeJS.Platform;
  loadCodexLbEnvImpl?: typeof loadCodexLbEnv;
  runProcessImpl?: typeof runProcess;
} = { mode: 'disabled' }): Promise<DesktopCenterCredentialSyncResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const mode = String(opts.mode || 'disabled');
  const platform = opts.platform || process.platform;
  const purge = opts.skipPurge
    ? { removed: [] as string[], keychain_cleared: [] as string[], blockers: [] as string[] }
    : await purgeStaleCodexLbCredentialTwins({
        home,
        ...(opts.runProcessImpl ? { runProcessImpl: opts.runProcessImpl } : {})
      });
  const loaded = opts.loadedEnv || await loadOfficialCodexLbCredentials({
    home,
    ...(opts.loadCodexLbEnvImpl ? { loadCodexLbEnvImpl: opts.loadCodexLbEnvImpl } : {})
  });
  const fingerprint = loaded.api_key.fingerprint;
  const basePresent = Boolean(loaded.base_url);

  if (platform !== 'darwin' && !opts.force) {
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok: true,
      status: 'not_macos',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: basePresent,
      launch_env: { api_key: 'skipped', base_url: 'skipped' },
      stale_twins_removed: purge.removed,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: purge.blockers
    };
  }

  const launchctl = opts.launchctlBin
    || await which('launchctl').catch(() => null)
    || (await exists('/bin/launchctl') ? '/bin/launchctl' : null);
  if (!launchctl) {
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok: false,
      status: 'launchctl_missing',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: basePresent,
      launch_env: { api_key: 'failed', base_url: 'failed' },
      stale_twins_removed: purge.removed,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: ['launchctl_missing', ...purge.blockers]
    };
  }

  const run = opts.runProcessImpl || runProcess;
  const setEnv = async (key: string, value: string) => {
    const result = await run(launchctl, ['setenv', key, value], { timeoutMs: 5000, maxOutputBytes: 8192 });
    return result.code === 0;
  };
  const unsetEnv = async (key: string) => {
    const result = await run(launchctl, ['unsetenv', key], { timeoutMs: 5000, maxOutputBytes: 8192 });
    return result.code === 0;
  };

  if (mode === 'desktop-dual-auth-compat') {
    if (!loaded.secret_api_key || !loaded.base_url) {
      return {
        schema: 'sks.codex-lb-desktop-center-credentials.v1',
        ok: false,
        status: 'center_credentials_unavailable',
        mode,
        api_key_fingerprint: fingerprint,
        base_url_present: basePresent,
        launch_env: { api_key: 'failed', base_url: 'failed' },
        stale_twins_removed: purge.removed,
        stale_keychain_cleared: purge.keychain_cleared,
        blockers: [
          ...(loaded.missing.length ? loaded.missing.map((item) => `codex_lb_missing:${item}`) : ['codex_lb_not_configured']),
          ...purge.blockers
        ]
      };
    }
    const keyOk = await setEnv('CODEX_LB_API_KEY', loaded.secret_api_key);
    const baseOk = await setEnv('CODEX_LB_BASE_URL', loaded.base_url);
    // OpenRouter never uses launchd secrets; keep that invariant.
    await unsetEnv('OPENROUTER_API_KEY');
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok: keyOk && baseOk,
      status: keyOk && baseOk ? 'desktop_compat_launch_env_synced' : 'desktop_compat_launch_env_failed',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: true,
      launch_env: {
        api_key: keyOk ? 'set' : 'failed',
        base_url: baseOk ? 'set' : 'failed'
      },
      stale_twins_removed: purge.removed,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: [
        ...(keyOk ? [] : ['launchctl_setenv_CODEX_LB_API_KEY_failed']),
        ...(baseOk ? [] : ['launchctl_setenv_CODEX_LB_BASE_URL_failed']),
        ...purge.blockers
      ]
    };
  }

  // Bridge / CLI / disabled / OpenRouter: Desktop must not inherit a lingering LB key.
  const keyUnset = await unsetEnv('CODEX_LB_API_KEY');
  const openRouterUnset = await unsetEnv('OPENROUTER_API_KEY');
  let baseStatus: 'set' | 'unset' | 'skipped' | 'failed' = 'skipped';
  if (loaded.base_url && (mode === 'desktop-native-bridge' || mode === 'cli-provider')) {
    baseStatus = await setEnv('CODEX_LB_BASE_URL', loaded.base_url) ? 'set' : 'failed';
  } else if (mode === 'disabled') {
    baseStatus = await unsetEnv('CODEX_LB_BASE_URL') ? 'unset' : 'failed';
  }
  const ok = keyUnset && openRouterUnset && baseStatus !== 'failed';
  return {
    schema: 'sks.codex-lb-desktop-center-credentials.v1',
    ok,
    status: ok ? 'desktop_secret_launch_env_cleared' : 'desktop_launch_env_cleanup_failed',
    mode,
    api_key_fingerprint: fingerprint,
    base_url_present: basePresent,
    launch_env: {
      api_key: keyUnset ? 'unset' : 'failed',
      base_url: baseStatus
    },
    stale_twins_removed: purge.removed,
    stale_keychain_cleared: purge.keychain_cleared,
    blockers: [
      ...(keyUnset ? [] : ['launchctl_unsetenv_CODEX_LB_API_KEY_failed']),
      ...(openRouterUnset ? [] : ['launchctl_unsetenv_OPENROUTER_API_KEY_failed']),
      ...(baseStatus === 'failed' ? ['launchctl_base_url_sync_failed'] : []),
      ...purge.blockers
    ]
  };
}
