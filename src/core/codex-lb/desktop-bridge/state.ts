import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { DesktopBridgeConfig, DesktopBridgePublicState } from './types.js';
import { DESKTOP_BRIDGE_STATE_SCHEMA, DesktopBridgeError } from './types.js';

export function desktopBridgeStatePath(home: string = os.homedir()): string {
  return path.join(home, '.codex', 'sks', 'codex-lb-desktop-bridge.json');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function desktopBridgeListenOrigin(config: Pick<DesktopBridgeConfig, 'listenHost' | 'listenPort'>): string {
  const host = config.listenHost === '::1' ? '[::1]' : config.listenHost;
  return `http://${host}:${config.listenPort}`;
}

export function desktopBridgeConfigGeneration(config: DesktopBridgeConfig): string {
  const stable = JSON.stringify({
    listenHost: config.listenHost,
    listenPort: config.listenPort,
    remoteBaseUrl: new URL(config.remoteBaseUrl).toString().replace(/\/$/, ''),
    gatewayKeySha256: sha256Hex(config.gatewayKey),
    gatewayAuthTransport: config.gatewayAuthTransport,
    allowedPathPrefixes: [...config.allowedPathPrefixes],
    allowedOrigins: [...config.allowedOrigins],
    connectTimeoutMs: config.connectTimeoutMs,
    idleTimeoutMs: config.idleTimeoutMs,
  });
  return sha256Hex(stable);
}

export function createDesktopBridgePublicState(
  config: DesktopBridgeConfig,
  options: { pid?: number; now?: Date } = {},
): DesktopBridgePublicState {
  const listenOrigin = desktopBridgeListenOrigin(config);
  const remote = new URL(config.remoteBaseUrl);
  return {
    schema: DESKTOP_BRIDGE_STATE_SCHEMA,
    pid: options.pid ?? process.pid,
    started_at: (options.now ?? new Date()).toISOString(),
    listen_origin: listenOrigin,
    codex_base_url: `${listenOrigin}/backend-api/codex`,
    remote_origin_sha256: sha256Hex(remote.origin),
    gateway_key_sha256: sha256Hex(config.gatewayKey),
    gateway_auth_transport: config.gatewayAuthTransport,
    config_generation: desktopBridgeConfigGeneration(config),
  };
}

export function isDesktopBridgePublicState(value: unknown): value is DesktopBridgePublicState {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.schema === DESKTOP_BRIDGE_STATE_SCHEMA
    && Number.isInteger(row.pid)
    && Number(row.pid) > 0
    && typeof row.started_at === 'string'
    && Number.isFinite(Date.parse(row.started_at))
    && typeof row.listen_origin === 'string'
    && /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/.test(row.listen_origin)
    && typeof row.codex_base_url === 'string'
    && row.codex_base_url === `${row.listen_origin}/backend-api/codex`
    && typeof row.remote_origin_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(row.remote_origin_sha256)
    && typeof row.gateway_key_sha256 === 'string'
    && /^[a-f0-9]{64}$/.test(row.gateway_key_sha256)
    && (row.gateway_auth_transport === 'x-codex-lb-api-key' || row.gateway_auth_transport === 'authorization-bearer-compat')
    && typeof row.config_generation === 'string'
    && /^[a-f0-9]{64}$/.test(row.config_generation);
}

export async function writeDesktopBridgeState(file: string, state: DesktopBridgePublicState): Promise<void> {
  if (!isDesktopBridgePublicState(state)) throw new DesktopBridgeError('bridge_state_invalid');
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fsp.chmod(temp, 0o600);
    await fsp.rename(temp, file);
    await fsp.chmod(file, 0o600);
  } finally {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function readDesktopBridgeState(file: string): Promise<DesktopBridgePublicState | null> {
  let stat;
  try {
    stat = await fsp.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile()) throw new DesktopBridgeError('bridge_state_not_file');
  if ((stat.mode & 0o077) !== 0) throw new DesktopBridgeError('bridge_state_permissions_unsafe');
  const raw = await fsp.readFile(file, 'utf8');
  if (raw.length > 64 * 1024) throw new DesktopBridgeError('bridge_state_too_large');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new DesktopBridgeError('bridge_state_invalid_json');
  }
  if (!isDesktopBridgePublicState(value)) throw new DesktopBridgeError('bridge_state_invalid');
  return value;
}

export async function removeDesktopBridgeStateIfOwned(
  file: string,
  expected: Pick<DesktopBridgePublicState, 'pid' | 'config_generation'>,
): Promise<boolean> {
  const current = await readDesktopBridgeState(file).catch(() => null);
  if (!current || current.pid !== expected.pid || current.config_generation !== expected.config_generation) return false;
  await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return true;
}
