import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId } from '../bridge-contracts.js';
import type { DesktopBridgeConfig, DesktopBridgePublicState, DesktopBridgePublicStateV2 } from './types.js';
import { DESKTOP_BRIDGE_STATE_SCHEMA, DesktopBridgeError } from './types.js';

const DEFAULT_FRESHNESS_MS = 5 * 60_000;

export function desktopBridgeStatePath(home: string = os.homedir()): string {
  return path.join(home, '.codex', 'sks', 'codex-lb-desktop-bridge.json');
}
export function sha256Hex(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function desktopBridgeListenOrigin(config: Pick<DesktopBridgeConfig, 'listenHost' | 'listenPort'>): string {
  return `http://${config.listenHost === '::1' ? '[::1]' : config.listenHost}:${config.listenPort}`;
}

export function desktopBridgeConfigGeneration(config: DesktopBridgeConfig): string {
  const registry = config.providerRegistry;
  return sha256Hex(JSON.stringify({
    listen_host: config.listenHost, listen_port: config.listenPort,
    provider_registry_generation: registry.generation,
    provider_credential_generations: Object.fromEntries((Object.keys(registry.providers) as BridgeProviderId[]).map((id) => [id, registry.providers[id].credential_generation])),
    route_policy_generation: config.routePolicy.policy_generation,
    catalog_generation: config.routePolicy.catalog_generation,
    provider_session_pins: [...config.providerSessionPins].sort((a, b) => a.thread_id.localeCompare(b.thread_id)),
    allowed_paths: [...config.allowedPathPrefixes], allowed_origins: [...config.allowedOrigins].sort(),
    connect_timeout_ms: config.connectTimeoutMs, idle_timeout_ms: config.idleTimeoutMs,
  }));
}

export function createDesktopBridgePublicState(config: DesktopBridgeConfig, options: { pid?: number; now?: Date } = {}): DesktopBridgePublicStateV2 {
  const now = options.now ?? new Date(); const registry = config.providerRegistry;
  const enabled = (Object.keys(registry.providers) as BridgeProviderId[]).filter((id) => registry.providers[id].enabled);
  const credentialGenerations = Object.fromEntries((Object.keys(registry.providers) as BridgeProviderId[]).map((id) => [id, registry.providers[id].credential_generation])) as Record<BridgeProviderId, string>;
  const listen = desktopBridgeListenOrigin(config);
  return {
    schema: DESKTOP_BRIDGE_STATE_SCHEMA, runtime: 'desktop-bridge', pid: options.pid ?? process.pid,
    started_at: now.toISOString(), updated_at: now.toISOString(),
    stale_after: new Date(now.getTime() + (config.stateFreshnessMs ?? DEFAULT_FRESHNESS_MS)).toISOString(),
    listen_origin: listen, codex_base_url: `${listen}/backend-api/codex`, process_generation: randomUUID(),
    provider_registry_generation: registry.generation, route_policy_generation: config.routePolicy.policy_generation,
    catalog_generation: config.routePolicy.catalog_generation, enabled_providers: enabled,
    provider_credential_generations: credentialGenerations, last_verified_probe_ids: [], config_generation: desktopBridgeConfigGeneration(config),
  };
}

function isGeneration(value: unknown): boolean { return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\r\n\0]/.test(value); }
export function isDesktopBridgePublicState(value: unknown): value is DesktopBridgePublicStateV2 {
  if (!value || typeof value !== 'object') return false; const row = value as Record<string, unknown>;
  if (/"(?:api_?key|secret|authorization|cookie|access_token|refresh_token)"\s*:/i.test(JSON.stringify(row))) return false;
  const dates = ['started_at', 'updated_at', 'stale_after'].every((key) => typeof row[key] === 'string' && Number.isFinite(Date.parse(String(row[key]))));
  const credentialRows = row.provider_credential_generations;
  return row.schema === DESKTOP_BRIDGE_STATE_SCHEMA && row.runtime === 'desktop-bridge' && Number.isInteger(row.pid) && Number(row.pid) > 0 && dates
    && typeof row.listen_origin === 'string' && /^http:\/\/(?:127\.0\.0\.1|\[::1\]):\d+$/.test(row.listen_origin)
    && row.codex_base_url === `${row.listen_origin}/backend-api/codex` && isGeneration(row.process_generation)
    && isGeneration(row.provider_registry_generation) && isGeneration(row.route_policy_generation) && isGeneration(row.catalog_generation)
    && Array.isArray(row.enabled_providers) && row.enabled_providers.every((id) => id === 'codex-lb' || id === 'openrouter')
    && !!credentialRows && typeof credentialRows === 'object' && isGeneration((credentialRows as Record<string, unknown>)['codex-lb']) && isGeneration((credentialRows as Record<string, unknown>).openrouter)
    && Array.isArray(row.last_verified_probe_ids) && row.last_verified_probe_ids.every(isGeneration)
    && typeof row.config_generation === 'string' && /^[a-f0-9]{64}$/.test(row.config_generation);
}

export async function refreshDesktopBridgeState(
  file: string,
  state: DesktopBridgePublicStateV2,
  now: Date = new Date(),
  freshnessMs = DEFAULT_FRESHNESS_MS,
): Promise<boolean> {
  const current = await readDesktopBridgeState(file).catch(() => null);
  if (!current || current.schema !== DESKTOP_BRIDGE_STATE_SCHEMA || current.pid !== state.pid
    || current.process_generation !== state.process_generation || current.config_generation !== state.config_generation) return false;
  state.updated_at = now.toISOString();
  state.stale_after = new Date(now.getTime() + freshnessMs).toISOString();
  await writeDesktopBridgeState(file, state);
  return true;
}

export function isDesktopBridgeStateFresh(state: DesktopBridgePublicState, now: Date = new Date()): boolean {
  return Date.parse(state.stale_after) > now.getTime();
}

export async function writeDesktopBridgeState(file: string, state: DesktopBridgePublicState): Promise<void> {
  if (!isDesktopBridgePublicState(state)) throw new DesktopBridgeError('bridge_state_invalid');
  const directory = path.dirname(file); await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try { await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); await fsp.chmod(temp, 0o600); await fsp.rename(temp, file); await fsp.chmod(file, 0o600); }
  finally { await fsp.rm(temp, { force: true }).catch(() => undefined); }
}

export async function readDesktopBridgeState(file: string): Promise<DesktopBridgePublicState | null> {
  let stat; try { stat = await fsp.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new DesktopBridgeError('bridge_state_not_file');
  if ((stat.mode & 0o077) !== 0) throw new DesktopBridgeError('bridge_state_permissions_unsafe');
  const raw = await fsp.readFile(file, 'utf8'); if (raw.length > 64 * 1024) throw new DesktopBridgeError('bridge_state_too_large');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new DesktopBridgeError('bridge_state_invalid_json'); }
  if (!isDesktopBridgePublicState(value)) throw new DesktopBridgeError('bridge_state_invalid'); return value;
}

export async function removeDesktopBridgeStateIfOwned(file: string, expected: Pick<DesktopBridgePublicState, 'pid' | 'config_generation'>): Promise<boolean> {
  const current = await readDesktopBridgeState(file).catch(() => null);
  if (!current || current.pid !== expected.pid || current.config_generation !== expected.config_generation) return false;
  await fsp.unlink(file).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; }); return true;
}
