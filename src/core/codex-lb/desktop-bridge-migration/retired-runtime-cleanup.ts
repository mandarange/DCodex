import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess } from '../../fsx.js';

const RETIRED_LAUNCHD_LABEL = 'com.sneakoscope.codex-lb-desktop-bridge';
const RETIRED_SETTINGS_SCHEMA = 'sks.codex-lb-desktop-bridge-settings.v2';
const RETIRED_STATE_SCHEMA = 'sks.codex-lb-desktop-bridge.v2';
const SETTINGS_KEYS = new Set([
  'schema', 'listen_host', 'listen_port', 'provider_registry', 'route_policy',
  'provider_session_pins', 'client_capability_sha256', 'allowed_origins',
  'connect_timeout_ms', 'idle_timeout_ms',
]);

interface RetiredRuntimePaths {
  settings: string;
  state: string;
  plist: string;
  stdout: string;
  stderr: string;
}

export interface RetiredDesktopBridgePreparation {
  present: boolean;
  settings: Record<string, unknown> | null;
  paths: RetiredRuntimePaths;
}

function retiredPaths(home: string): RetiredRuntimePaths {
  const resolvedHome = path.resolve(home);
  const runtime = path.join(resolvedHome, '.codex', 'sks');
  return {
    settings: path.join(runtime, 'codex-lb-desktop-bridge-settings.json'),
    state: path.join(runtime, 'codex-lb-desktop-bridge.json'),
    plist: path.join(resolvedHome, 'Library', 'LaunchAgents', `${RETIRED_LAUNCHD_LABEL}.plist`),
    stdout: path.join(runtime, 'logs', 'codex-lb-desktop-bridge.out.log'),
    stderr: path.join(runtime, 'logs', 'codex-lb-desktop-bridge.err.log'),
  };
}

async function regularFileExists(file: string): Promise<boolean> {
  try {
    const stat = await fsp.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('desktop_bridge_retired_runtime_path_unsafe');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function readRetiredSettings(file: string): Promise<Record<string, unknown> | null> {
  if (!(await regularFileExists(file))) return null;
  const stat = await fsp.stat(file);
  if ((stat.mode & 0o077) !== 0 || stat.size > 256 * 1024) {
    throw new Error('desktop_bridge_retired_settings_unsafe');
  }
  let value: unknown;
  try { value = JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { throw new Error('desktop_bridge_retired_settings_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('desktop_bridge_retired_settings_invalid');
  }
  const row = value as Record<string, unknown>;
  if (row.schema !== RETIRED_SETTINGS_SCHEMA || Object.keys(row).some((key) => !SETTINGS_KEYS.has(key))) {
    throw new Error('desktop_bridge_retired_settings_invalid');
  }
  if (/"(?:api_?key|secret|authorization|cookie|access_token|refresh_token)"\s*:/i.test(JSON.stringify(row))) {
    throw new Error('desktop_bridge_retired_settings_secret_forbidden');
  }
  const { schema: _schema, ...settings } = row;
  return settings;
}

function launchDomain(uid = typeof process.getuid === 'function' ? process.getuid() : 0): string {
  return `gui/${uid}`;
}

export async function prepareRetiredDesktopBridgeRuntime(options: {
  home: string;
  uid?: number;
  launchctl?: string;
  run?: typeof runProcess;
}): Promise<RetiredDesktopBridgePreparation> {
  const paths = retiredPaths(options.home);
  const present = (await Promise.all(Object.values(paths).map(regularFileExists))).some(Boolean);
  if (!present) return { present: false, settings: null, paths };
  const run = options.run || runProcess;
  const launchctl = options.launchctl || '/bin/launchctl';
  const service = `${launchDomain(options.uid)}/${RETIRED_LAUNCHD_LABEL}`;
  const before = await run(launchctl, ['print', service], {
    timeoutMs: 3_000, maxOutputBytes: 16 * 1024,
  }).catch(() => null);
  if (before?.code === 0) {
    await run(launchctl, ['bootout', service], {
      timeoutMs: 8_000, maxOutputBytes: 32 * 1024,
    }).catch(() => null);
  }
  const after = await run(launchctl, ['print', service], {
    timeoutMs: 3_000, maxOutputBytes: 16 * 1024,
  }).catch(() => null);
  if (after?.code === 0) throw new Error('desktop_bridge_retired_launchd_still_loaded');
  return { present: true, settings: await readRetiredSettings(paths.settings), paths };
}

export async function cleanupRetiredDesktopBridgeRuntime(
  preparation: RetiredDesktopBridgePreparation,
): Promise<void> {
  if (!preparation.present) return;
  if (await regularFileExists(preparation.paths.settings)) {
    const raw = JSON.parse(await fsp.readFile(preparation.paths.settings, 'utf8')) as Record<string, unknown>;
    if (raw.schema !== RETIRED_SETTINGS_SCHEMA) throw new Error('desktop_bridge_retired_settings_changed');
  }
  if (await regularFileExists(preparation.paths.state)) {
    const raw = JSON.parse(await fsp.readFile(preparation.paths.state, 'utf8')) as Record<string, unknown>;
    if (raw.schema !== RETIRED_STATE_SCHEMA) throw new Error('desktop_bridge_retired_state_changed');
  }
  for (const file of Object.values(preparation.paths)) {
    if (await regularFileExists(file)) await fsp.unlink(file);
  }
}
