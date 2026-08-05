import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, exists, runProcess, which, writeTextAtomic } from '../fsx.js';
import { loadCodexLbEnv, readCodexLbModelCatalog, type CodexLbEnvLoadResult } from './codex-lb-env.js';
import { resolveOpenRouterApiKey } from '../providers/openrouter/openrouter-secret-store.js';
import type { BridgeProviderId, BridgeRoutingPolicy, ProviderSessionPin } from './bridge-contracts.js';
import {
  ARCHITECTURE_HARDENING_CONTRACT_VERSION, credentialClassForMode, stableArchitectureHash,
  type ChildPolicySnapshot, type CredentialReadiness, type ProviderPolicySnapshot, type SessionPin,
} from '../architecture-hardening/contracts/contracts.js';
import { createChildPolicySnapshot } from '../codex-app/child-policy/child-policy.js';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES, DESKTOP_BRIDGE_LAUNCHD_LABEL, desktopBridgeConfigGeneration,
  desktopBridgeLaunchdPlistPath, desktopBridgeProcessExists, desktopBridgeStatePath, getDesktopBridgeStatus,
  preflightDesktopBridge, readDesktopBridgeState, renderDesktopBridgeLaunchdPlist, safeBridgeErrorCode,
  selectAvailableDesktopBridgePort, startPreparedDesktopBridge,
  type DesktopBridgeConfig, type DesktopBridgeCredentialResolver, type DesktopBridgeHandle,
  type DesktopBridgeProviderRegistrySnapshot, type DesktopBridgeProviderSnapshot, type DesktopBridgePublicState,
  type DesktopBridgeRouteResolver, type DesktopBridgeStatus,
} from './desktop-bridge/index.js';
import { DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT, parseCodexLbGatewayAuthTransport, type CodexLbGatewayAuthTransport } from './desktop-mode.js';

export const DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST = '127.0.0.1' as const;
export const DEFAULT_CODEX_LB_DESKTOP_BRIDGE_PORT = 49_152;
export const CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA = 'sks.codex-lb-desktop-bridge-settings.v2' as const;
export const CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA = 'sks.codex-lb-desktop-bridge-service.v2' as const;
const LEGACY_SETTINGS_SCHEMA = 'sks.codex-lb-desktop-bridge-settings.v1';
const DEFAULT_ALLOWED_ORIGINS = ['app://codex'] as const;
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

type DesktopBridgeCredentialSource = CodexLbEnvLoadResult['source'] | 'openrouter-env' | 'openrouter-user-secret-store' | 'injected-registry';

export interface DesktopBridgeServiceSettings {
  schema: typeof CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA;
  listen_host: '127.0.0.1' | '::1';
  listen_port: number;
  provider_registry: DesktopBridgeProviderRegistrySnapshot;
  route_policy: BridgeRoutingPolicy;
  provider_session_pins: ProviderSessionPin[];
  allowed_origins: string[];
  connect_timeout_ms: number;
  idle_timeout_ms: number;
  /** Compatibility fields are read in memory but are never serialized by the v2 writer. */
  provider_mode?: 'codex-lb' | 'openrouter';
  allowed_models: string[];
  gateway_auth_transport: CodexLbGatewayAuthTransport;
  catalog_version?: string;
  registered_child_models?: string[];
  session_pins?: SessionPin[];
  require_session_pin?: boolean;
}

export interface DesktopBridgeServicePaths { settings_path: string; state_path: string; launch_agent_path: string; stdout_log_path: string; stderr_log_path: string; }
export interface DesktopBridgeServiceStatus {
  schema: typeof CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA | 'sks.codex-lb-desktop-bridge-service.v1';
  ok: boolean; supported: boolean; installed: boolean; loaded: boolean; running: boolean;
  status: DesktopBridgeStatus['status'] | 'unsupported' | 'settings_missing' | 'credentials_unavailable';
  service: string; paths: DesktopBridgeServicePaths; state: DesktopBridgePublicState | null;
  settings: DesktopBridgeServiceSettings | null; expected_config_generation: string | null;
  credential_source: DesktopBridgeCredentialSource | null;
  credential_sources?: Partial<Record<BridgeProviderId, DesktopBridgeCredentialSource>>;
  blockers: string[];
}

export interface DesktopBridgeServiceOptions {
  home?: string; env?: NodeJS.ProcessEnv; envPath?: string; metadataPath?: string;
  settings?: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>>;
  providerRegistry?: DesktopBridgeProviderRegistrySnapshot; routePolicy?: BridgeRoutingPolicy;
  providerSessionPins?: readonly ProviderSessionPin[]; resolveRequestRoute?: DesktopBridgeRouteResolver;
  resolveProviderCredential?: DesktopBridgeCredentialResolver;
  settingsPath?: string; statePath?: string; launchAgentPath?: string; stdoutLogPath?: string; stderrLogPath?: string;
  platform?: NodeJS.Platform; uid?: number; launchctl?: string; executablePath?: string; executableArguments?: string[];
  run?: typeof runProcess; processExists?: (pid: number) => boolean; selectAvailablePort?: typeof selectAvailableDesktopBridgePort;
}

export function desktopBridgeServicePaths(home = process.env.HOME || os.homedir()): DesktopBridgeServicePaths {
  const runtime = path.join(path.resolve(home), '.codex', 'sks'); const logs = path.join(runtime, 'logs');
  return { settings_path: path.join(runtime, 'codex-lb-desktop-bridge-settings.json'), state_path: desktopBridgeStatePath(path.resolve(home)), launch_agent_path: desktopBridgeLaunchdPlistPath(path.resolve(home)), stdout_log_path: path.join(logs, 'codex-lb-desktop-bridge.out.log'), stderr_log_path: path.join(logs, 'codex-lb-desktop-bridge.err.log') };
}

function fingerprint(secret: string): string { return createHash('sha256').update(secret).digest('hex').slice(0, 16); }
function generation(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function blankProvider(id: BridgeProviderId): DesktopBridgeProviderSnapshot {
  return { provider_id: id, enabled: false, base_url: id === 'openrouter' ? OPENROUTER_BASE_URL : 'https://invalid.codex-lb.local', allowed_origins: [id === 'openrouter' ? 'https://openrouter.ai' : 'https://invalid.codex-lb.local'], auth_transport: id === 'openrouter' ? 'openrouter-bearer' as const : 'x-codex-lb-api-key' as const, credential_state: 'not_configured' as const, credential_fingerprint: null, credential_generation: 'not-configured', catalog_generation: null };
}

function legacySnapshots(input: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>>): { registry: DesktopBridgeProviderRegistrySnapshot; policy: BridgeRoutingPolicy } {
  const mode = input.provider_mode || 'codex-lb'; const models = [...new Set(input.allowed_models || [])];
  const target = blankProvider(mode); target.enabled = true; target.credential_state = 'configured_unverified';
  if (mode === 'codex-lb') target.auth_transport = (input.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT) === 'x-codex-lb-api-key' ? 'x-codex-lb-api-key' : 'authorization-bearer';
  const providers = { 'codex-lb': blankProvider('codex-lb'), openrouter: blankProvider('openrouter'), [mode]: target } as DesktopBridgeProviderRegistrySnapshot['providers'];
  const catalogGeneration = input.catalog_version || `catalog-${generation({ mode, models }).slice(0, 24)}`;
  const routes = Object.fromEntries(models.map((model) => [model, { provider_id: mode, upstream_model: model }]));
  return {
    registry: { schema: 'sks.desktop-bridge-provider-registry.v1', generation: generation(providers), created_at: new Date(0).toISOString(), providers },
    policy: { schema: 'sks.bridge-routing-policy.v1', default_provider_id: mode, fallback: 'none', model_routes: routes, catalog_generation: catalogGeneration, policy_generation: generation(routes), changed_at: new Date(0).toISOString() },
  };
}

export function defaultDesktopBridgeServiceSettings(input: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>> = {}): DesktopBridgeServiceSettings {
  const legacy = legacySnapshots(input); const registry = input.provider_registry || legacy.registry; const policy = input.route_policy || legacy.policy;
  return validateDesktopBridgeServiceSettings({
    schema: CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA, listen_host: input.listen_host || DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST,
    listen_port: input.listen_port ?? DEFAULT_CODEX_LB_DESKTOP_BRIDGE_PORT, provider_registry: registry, route_policy: policy,
    provider_session_pins: [...(input.provider_session_pins || [])], allowed_origins: [...(input.allowed_origins || DEFAULT_ALLOWED_ORIGINS)],
    connect_timeout_ms: input.connect_timeout_ms ?? 10_000, idle_timeout_ms: input.idle_timeout_ms ?? 300_000,
    ...(input.provider_mode ? { provider_mode: input.provider_mode } : {}), allowed_models: [...(input.allowed_models || [])],
    gateway_auth_transport: input.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT, ...(input.catalog_version ? { catalog_version: input.catalog_version } : {}),
    ...(input.registered_child_models ? { registered_child_models: [...input.registered_child_models] } : {}), ...(input.session_pins ? { session_pins: [...input.session_pins] } : {}),
    ...(input.require_session_pin === undefined ? {} : { require_session_pin: input.require_session_pin }),
  });
}

/** Legacy architecture adapter. Active bridge routing does not consume this snapshot. */
export function desktopBridgeArchitecturePolicy(settings: DesktopBridgeServiceSettings): { policy: ProviderPolicySnapshot; credential: CredentialReadiness; child: ChildPolicySnapshot; sessionPins: readonly SessionPin[]; requireSessionPin: boolean } {
  const mode = settings.provider_mode || settings.route_policy.default_provider_id || 'codex-lb';
  const allowedModels = settings.allowed_models || Object.entries(settings.route_policy.model_routes).filter(([, route]) => route.provider_id === mode).map(([model]) => model);
  const seed: ProviderPolicySnapshot = { schema: 'sks.provider-policy-snapshot.v1', contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION, mode, credential_class: credentialClassForMode(mode), allowed_models: allowedModels, child_policy_hash: '0'.repeat(64), catalog_version: settings.catalog_version || settings.route_policy.catalog_generation };
  const child = createChildPolicySnapshot(seed, settings.registered_child_models || allowedModels); const policy = { ...seed, child_policy_hash: child.policy_hash };
  return { policy, credential: { status: 'ready', reason_code: null }, child, sessionPins: [...(settings.session_pins || [])], requireSessionPin: settings.require_session_pin === true };
}

export async function resolveDesktopBridgeActivationSettings(options: DesktopBridgeServiceOptions = {}): Promise<DesktopBridgeServiceSettings> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); const paths = overridePaths(desktopBridgeServicePaths(home), options);
  const persisted = await readDesktopBridgeServiceSettings(paths.settings_path); const merged = { ...(persisted || {}), ...(options.settings || {}) };
  const host = merged.listen_host || DEFAULT_CODEX_LB_DESKTOP_BRIDGE_HOST;
  const port = merged.listen_port ?? await (options.selectAvailablePort || selectAvailableDesktopBridgePort)(host);
  return defaultDesktopBridgeServiceSettings({ ...merged, ...(options.providerRegistry ? { provider_registry: options.providerRegistry } : {}), ...(options.routePolicy ? { route_policy: options.routePolicy } : {}), ...(options.providerSessionPins ? { provider_session_pins: [...options.providerSessionPins] } : {}), listen_host: host, listen_port: port });
}

export async function readDesktopBridgeServiceSettings(file: string): Promise<DesktopBridgeServiceSettings | null> {
  let stat; try { stat = await fsp.lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('desktop_bridge_settings_not_regular_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('desktop_bridge_settings_permissions_unsafe');
  const raw = await fsp.readFile(file, 'utf8'); if (Buffer.byteLength(raw) > 256 * 1024) throw new Error('desktop_bridge_settings_too_large');
  let parsed: unknown; try { parsed = JSON.parse(raw); } catch { throw new Error('desktop_bridge_settings_invalid_json'); }
  return validateDesktopBridgeServiceSettings(parsed);
}

export async function writeDesktopBridgeServiceSettings(file: string, settings: DesktopBridgeServiceSettings | (Pick<DesktopBridgeServiceSettings, 'schema' | 'listen_host' | 'listen_port' | 'allowed_origins' | 'connect_timeout_ms' | 'idle_timeout_ms' | 'allowed_models' | 'gateway_auth_transport'> & { provider_mode: 'codex-lb' | 'openrouter' })): Promise<void> {
  const row = settings as unknown as Record<string, unknown>;
  const validated = validateDesktopBridgeServiceSettings(row.provider_registry ? row : legacySettings(row));
  const persisted = { schema: validated.schema, listen_host: validated.listen_host, listen_port: validated.listen_port, provider_registry: validated.provider_registry, route_policy: validated.route_policy, provider_session_pins: validated.provider_session_pins, allowed_origins: validated.allowed_origins, connect_timeout_ms: validated.connect_timeout_ms, idle_timeout_ms: validated.idle_timeout_ms };
  await writeTextAtomic(file, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 }); await fsp.chmod(file, 0o600);
}

async function runtimeCredentials(settings: DesktopBridgeServiceSettings, options: DesktopBridgeServiceOptions & { home: string }): Promise<{ registry: DesktopBridgeProviderRegistrySnapshot; resolver: DesktopBridgeCredentialResolver; sources: Partial<Record<BridgeProviderId, DesktopBridgeCredentialSource>>; loaded: CodexLbEnvLoadResult | null }> {
  if (options.resolveProviderCredential) {
    const sources = Object.fromEntries(
      (['codex-lb', 'openrouter'] as const)
        .filter((id) => settings.provider_registry.providers[id].credential_state === 'ready')
        .map((id) => [id, 'injected-registry' as const]),
    );
    return { registry: settings.provider_registry, resolver: options.resolveProviderCredential, sources, loaded: null };
  }
  const secrets = new Map<BridgeProviderId, { value: string; source: DesktopBridgeCredentialSource; fingerprint: string; generation: string }>();
  let loaded: CodexLbEnvLoadResult | null = null;
  try {
    loaded = await loadCodexLbEnv({ home: options.home, ...(options.envPath ? { envPath: options.envPath } : {}), ...(options.metadataPath ? { metadataPath: options.metadataPath } : {}), ...(options.env ? { processEnv: options.env } : {}) });
    if (loaded.configured && loaded.base_url && loaded.secret_api_key) secrets.set('codex-lb', { value: loaded.secret_api_key, source: loaded.source, fingerprint: fingerprint(loaded.secret_api_key), generation: generation({ value: loaded.secret_api_key }) });
  } catch { loaded = null; }
  const openrouter = await resolveOpenRouterApiKey({ env: options.env || process.env }).catch(() => ({ key: null, source: 'missing' as const }));
  if (openrouter.key) secrets.set('openrouter', { value: openrouter.key, source: openrouter.source === 'env' ? 'openrouter-env' : 'openrouter-user-secret-store', fingerprint: fingerprint(openrouter.key), generation: generation({ value: openrouter.key }) });
  const providers = { ...settings.provider_registry.providers };
  for (const id of ['codex-lb', 'openrouter'] as const) {
    const source = secrets.get(id); const current = providers[id];
    providers[id] = { ...current, ...(id === 'codex-lb' && loaded?.base_url ? { base_url: loaded.base_url, allowed_origins: [new URL(loaded.base_url).origin] } : {}), credential_state: source ? 'ready' : 'not_configured', credential_fingerprint: source?.fingerprint || null, credential_generation: source?.generation || 'not-configured' };
  }
  const registry: DesktopBridgeProviderRegistrySnapshot = { ...settings.provider_registry, generation: generation(providers), providers };
  const resolver: DesktopBridgeCredentialResolver = options.resolveProviderCredential || (async (id, expected) => {
    const secret = secrets.get(id); if (!secret) throw new Error(`${id.replace('-', '_')}_credential_missing`);
    if (secret.generation !== expected) throw new Error('bridge_provider_credential_generation_mismatch');
    return { provider_id: id, value: secret.value, source: secret.source, fingerprint: secret.fingerprint, generation: secret.generation };
  });
  return { registry, resolver, sources: Object.fromEntries([...secrets].map(([id, value]) => [id, value.source])), loaded };
}

export async function resolveDesktopBridgeRuntimeConfig(options: DesktopBridgeServiceOptions = {}): Promise<{ config: DesktopBridgeConfig; settings: DesktopBridgeServiceSettings; loaded_env: CodexLbEnvLoadResult | null; credential_source: DesktopBridgeCredentialSource; credential_sources: Partial<Record<BridgeProviderId, DesktopBridgeCredentialSource>>; paths: DesktopBridgeServicePaths }> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); const paths = overridePaths(desktopBridgeServicePaths(home), options);
  let settings = defaultDesktopBridgeServiceSettings({ ...((await readDesktopBridgeServiceSettings(paths.settings_path)) || {}), ...(options.settings || {}), ...(options.providerRegistry ? { provider_registry: options.providerRegistry } : {}), ...(options.routePolicy ? { route_policy: options.routePolicy } : {}), ...(options.providerSessionPins ? { provider_session_pins: [...options.providerSessionPins] } : {}) });
  const credentials = await runtimeCredentials(settings, { ...options, home });
  settings = defaultDesktopBridgeServiceSettings({ ...settings, provider_registry: credentials.registry });
  if (!Object.keys(settings.route_policy.model_routes).length && credentials.loaded) {
    const catalog = await readCodexLbModelCatalog({ loadedEnv: credentials.loaded, gatewayAuthTransport: settings.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT });
    if (catalog.ok && catalog.models.length) {
      const snapshot = legacySnapshots({ allowed_models: catalog.models, provider_mode: 'codex-lb', ...(settings.catalog_version ? { catalog_version: settings.catalog_version } : {}) });
      const providers = {
        ...credentials.registry.providers,
        'codex-lb': {
          ...credentials.registry.providers['codex-lb'],
          enabled: true,
          catalog_generation: snapshot.policy.catalog_generation,
        },
      };
      settings = defaultDesktopBridgeServiceSettings({
        ...settings,
        provider_registry: { ...credentials.registry, generation: generation(providers), providers },
        route_policy: snapshot.policy,
        allowed_models: catalog.models,
        provider_mode: 'codex-lb',
      });
    }
  }
  if (!Object.keys(settings.route_policy.model_routes).length) throw new Error('catalog_model_route_missing');
  const enabledRoutes = new Set(Object.values(settings.route_policy.model_routes).map((route) => route.provider_id));
  if (![...enabledRoutes].some((id) => credentials.registry.providers[id].credential_state === 'ready')) throw new Error('desktop_bridge_provider_credentials_unavailable');
  const config: DesktopBridgeConfig = { providerRegistry: settings.provider_registry, routePolicy: settings.route_policy, providerSessionPins: settings.provider_session_pins, ...(options.resolveRequestRoute ? { resolveRequestRoute: options.resolveRequestRoute } : {}), resolveProviderCredential: credentials.resolver, listenHost: settings.listen_host, listenPort: settings.listen_port, allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES, allowedOrigins: settings.allowed_origins, connectTimeoutMs: settings.connect_timeout_ms, idleTimeoutMs: settings.idle_timeout_ms };
  const primary = credentials.sources['codex-lb'] || credentials.sources.openrouter;
  if (!primary) throw new Error('desktop_bridge_provider_credentials_unavailable');
  return { config, settings, loaded_env: credentials.loaded, credential_source: primary, credential_sources: credentials.sources, paths };
}

export async function desktopBridgeServiceStatus(options: DesktopBridgeServiceOptions = {}): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); const paths = overridePaths(desktopBridgeServicePaths(home), options); const service = launchService(options.uid);
  const settings = await readDesktopBridgeServiceSettings(paths.settings_path).catch(() => null);
  if ((options.platform || process.platform) !== 'darwin') return { schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA, ok: false, supported: false, installed: await exists(paths.launch_agent_path), loaded: false, running: false, status: 'unsupported', service, paths, state: await readDesktopBridgeState(paths.state_path).catch(() => null), settings, expected_config_generation: null, credential_source: null, blockers: ['desktop_bridge_service_requires_macos'] };
  let expected: string | null = null; let source: DesktopBridgeCredentialSource | null = null; let sources: Partial<Record<BridgeProviderId, DesktopBridgeCredentialSource>> = {}; const blockers: string[] = [];
  if (!settings) blockers.push('desktop_bridge_settings_missing');
  else try { const runtime = await resolveDesktopBridgeRuntimeConfig({ ...options, home, settingsPath: paths.settings_path }); expected = desktopBridgeConfigGeneration(runtime.config); source = runtime.credential_source; sources = runtime.credential_sources; } catch (error) { blockers.push(safeServiceError(error)); }
  const bridge = await getDesktopBridgeStatus({ statePath: paths.state_path, ...(expected ? { expectedConfigGeneration: expected } : {}), ...(options.processExists ? { processExists: options.processExists } : {}) });
  const launchd = await inspectLaunchd(options, service); if (bridge.status !== 'running') blockers.push(bridgeStatusBlocker(bridge)); if (launchd.loaded && !launchd.running) blockers.push('desktop_bridge_launchd_not_running');
  return { schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA, ok: bridge.status === 'running' && blockers.length === 0, supported: true, installed: await exists(paths.launch_agent_path), loaded: launchd.loaded, running: bridge.status === 'running', status: !settings ? 'settings_missing' : blockers.some((b) => b.includes('credential')) ? 'credentials_unavailable' : bridge.status, service, paths, state: bridge.state, settings, expected_config_generation: expected, credential_source: source, credential_sources: sources, blockers: [...new Set(blockers.filter(Boolean))] };
}

export async function installAndStartDesktopBridgeService(options: DesktopBridgeServiceOptions = {}): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); const platform = options.platform || process.platform;
  if (platform !== 'darwin') return desktopBridgeServiceStatus({ ...options, home, platform });
  const paths = overridePaths(desktopBridgeServicePaths(home), options); const settings = await resolveDesktopBridgeActivationSettings({ ...options, home, settingsPath: paths.settings_path });
  let runtime; try { runtime = await resolveDesktopBridgeRuntimeConfig({ ...options, home, settings: settings, settingsPath: paths.settings_path }); await preflightDesktopBridge(runtime.config); }
  catch (error) { return failedStatus(paths, settings, launchService(options.uid), 'credentials_unavailable', safeServiceError(error)); }
  const command = await resolveLaunchCommand(options); if (!command) return failedStatus(paths, settings, launchService(options.uid), 'settings_missing', 'desktop_bridge_sks_executable_missing');
  await Promise.all([ensureDir(path.dirname(paths.settings_path)), ensureDir(path.dirname(paths.launch_agent_path)), ensureDir(path.dirname(paths.stdout_log_path))]);
  await writeDesktopBridgeServiceSettings(paths.settings_path, { ...settings, provider_registry: runtime.config.providerRegistry!, route_policy: runtime.config.routePolicy! });
  await writeTextAtomic(paths.launch_agent_path, renderDesktopBridgeLaunchdPlist({ executablePath: command.executable, arguments: [...command.arguments, 'codex-lb', 'bridge', 'serve', '--settings', paths.settings_path, '--json'], stdoutPath: paths.stdout_log_path, stderrPath: paths.stderr_log_path }), { mode: 0o600 });
  const run = options.run || runProcess; const ctl = options.launchctl || '/bin/launchctl'; const service = launchService(options.uid); const domain = launchDomain(options.uid);
  await run(ctl, ['bootout', service], { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }).catch(() => undefined); await removeStaleState(paths.state_path, options.processExists);
  const bootstrap = await run(ctl, ['bootstrap', domain, paths.launch_agent_path], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }).catch((error) => failedProcess(error));
  if (bootstrap.code !== 0 && !bootstrap.timedOut) return failedStatus(paths, settings, service, 'missing', 'desktop_bridge_launchd_bootstrap_failed');
  await run(ctl, ['kickstart', '-k', service], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }).catch(() => undefined);
  const status = await waitForBridge({ ...options, home }); if (!status.ok) await run(ctl, ['bootout', service], { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }).catch(() => undefined); return status;
}

export async function bootstrapExistingDesktopBridgeService(options: DesktopBridgeServiceOptions = {}): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); const paths = overridePaths(desktopBridgeServicePaths(home), options);
  if ((options.platform || process.platform) !== 'darwin' || !(await exists(paths.launch_agent_path)) || !(await exists(paths.settings_path))) return desktopBridgeServiceStatus({ ...options, home });
  const run = options.run || runProcess; const ctl = options.launchctl || '/bin/launchctl'; const service = launchService(options.uid);
  await run(ctl, ['bootout', service], { timeoutMs: 5_000, maxOutputBytes: 16 * 1024 }).catch(() => undefined);
  const result = await run(ctl, ['bootstrap', launchDomain(options.uid), paths.launch_agent_path], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }).catch((error) => failedProcess(error));
  if (result.code === 0 || result.timedOut) await run(ctl, ['kickstart', '-k', service], { timeoutMs: 10_000, maxOutputBytes: 32 * 1024 }).catch(() => undefined);
  return waitForBridge({ ...options, home });
}

export async function stopDesktopBridgeService(options: DesktopBridgeServiceOptions & { removePlist?: boolean; removeSettings?: boolean } = {}): Promise<DesktopBridgeServiceStatus> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir(); if ((options.platform || process.platform) !== 'darwin') return desktopBridgeServiceStatus({ ...options, home });
  const paths = overridePaths(desktopBridgeServicePaths(home), options); await (options.run || runProcess)(options.launchctl || '/bin/launchctl', ['bootout', launchService(options.uid)], { timeoutMs: 8_000, maxOutputBytes: 32 * 1024 }).catch(() => undefined);
  for (let attempt = 0; attempt < 20; attempt += 1) { const state = await readDesktopBridgeState(paths.state_path).catch(() => null); if (!state || !(options.processExists || desktopBridgeProcessExists)(state.pid)) break; await delay(100); }
  await removeStaleState(paths.state_path, options.processExists); if (options.removePlist) await fsp.unlink(paths.launch_agent_path).catch(() => undefined); if (options.removeSettings) await fsp.unlink(paths.settings_path).catch(() => undefined);
  const status = await desktopBridgeServiceStatus({ ...options, home }); return { ...status, ok: !status.running, blockers: status.running ? ['desktop_bridge_process_still_running'] : [] };
}

export async function serveDesktopBridge(options: DesktopBridgeServiceOptions = {}): Promise<{ schema: 'sks.codex-lb-desktop-bridge-serve.v1'; ok: boolean; status: 'stopped' | 'failed'; state: DesktopBridgePublicState | null; blocker?: string }> {
  let handle: DesktopBridgeHandle | null = null;
  try { const runtime = await resolveDesktopBridgeRuntimeConfig(options); handle = await startPreparedDesktopBridge(await preflightDesktopBridge(runtime.config), { statePath: runtime.paths.state_path }); process.stdout.write(`${JSON.stringify({ schema: 'sks.codex-lb-desktop-bridge-log.v2', event: 'sks.desktop_bridge.started', pid: handle.state.pid, process_generation: handle.state.schema === 'sks.codex-lb-desktop-bridge.v2' ? handle.state.process_generation : null, provider_registry_generation: runtime.config.providerRegistry?.generation, route_policy_generation: runtime.config.routePolicy?.policy_generation, secret_fields_redacted: true })}\n`); await waitForShutdown(handle); return { schema: 'sks.codex-lb-desktop-bridge-serve.v1', ok: true, status: 'stopped', state: handle.state }; }
  catch (error) { return { schema: 'sks.codex-lb-desktop-bridge-serve.v1', ok: false, status: 'failed', state: handle?.state || null, blocker: safeServiceError(error) }; }
  finally { if (handle) await handle.stop().catch(() => undefined); }
}

function validateDesktopBridgeServiceSettings(value: unknown): DesktopBridgeServiceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_bridge_settings_invalid'); const row = value as Record<string, unknown>;
  const input = row.schema === LEGACY_SETTINGS_SCHEMA ? legacySettings(row) : row; if (input.schema !== CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA) throw new Error('desktop_bridge_settings_schema_invalid');
  const serialized = JSON.stringify(input);
  if (/"(?:api_?key|secret|authorization|cookie|access_token|refresh_token|gatewayKey)"\s*:/i.test(serialized) || /Bearer\s+[A-Za-z0-9._~-]{8,}/i.test(serialized)) {
    throw new Error('desktop_bridge_settings_secret_forbidden');
  }
  const host = input.listen_host; const port = Number(input.listen_port); if (host !== '127.0.0.1' && host !== '::1') throw new Error('desktop_bridge_settings_listen_host_invalid'); if (!Number.isInteger(port) || port < 49_152 || port > 65_535) throw new Error('desktop_bridge_settings_listen_port_invalid');
  const registry = input.provider_registry as DesktopBridgeProviderRegistrySnapshot; const policy = input.route_policy as BridgeRoutingPolicy;
  if (!registry || registry.schema !== 'sks.desktop-bridge-provider-registry.v1' || !registry.providers?.['codex-lb'] || !registry.providers.openrouter) throw new Error('desktop_bridge_settings_provider_registry_invalid');
  if (!policy || policy.schema !== 'sks.bridge-routing-policy.v1' || policy.fallback !== 'none') throw new Error('desktop_bridge_settings_route_policy_invalid');
  const pins = Array.isArray(input.provider_session_pins) ? input.provider_session_pins as ProviderSessionPin[] : []; if (pins.length > 10_000) throw new Error('desktop_bridge_settings_session_pins_invalid');
  const origins = Array.isArray(input.allowed_origins) ? input.allowed_origins.map(String).filter(Boolean) : []; if (!origins.length) throw new Error('desktop_bridge_settings_allowed_origins_empty');
  const connect = Number(input.connect_timeout_ms); const idle = Number(input.idle_timeout_ms); if (!Number.isFinite(connect) || connect < 100 || connect > 120_000) throw new Error('desktop_bridge_settings_connect_timeout_invalid'); if (!Number.isFinite(idle) || idle < 1_000 || idle > 86_400_000) throw new Error('desktop_bridge_settings_idle_timeout_invalid');
  return { schema: CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA, listen_host: host, listen_port: port, provider_registry: registry, route_policy: policy, provider_session_pins: pins, allowed_origins: [...new Set(origins)], connect_timeout_ms: connect, idle_timeout_ms: idle, ...(input.provider_mode === 'codex-lb' || input.provider_mode === 'openrouter' ? { provider_mode: input.provider_mode } : {}), allowed_models: Array.isArray(input.allowed_models) ? input.allowed_models.map(String) : [], gateway_auth_transport: parseCodexLbGatewayAuthTransport(input.gateway_auth_transport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT), ...(typeof input.catalog_version === 'string' ? { catalog_version: input.catalog_version } : {}), ...(Array.isArray(input.registered_child_models) ? { registered_child_models: input.registered_child_models.map(String) } : {}), ...(Array.isArray(input.session_pins) ? { session_pins: input.session_pins as SessionPin[] } : {}), ...(input.require_session_pin === true ? { require_session_pin: true } : {}) };
}

function legacySettings(row: Record<string, unknown>): Record<string, unknown> {
  const input: Partial<Omit<DesktopBridgeServiceSettings, 'schema'>> = { allowed_models: Array.isArray(row.allowed_models) ? row.allowed_models.map(String) : [], ...(row.provider_mode === 'codex-lb' || row.provider_mode === 'openrouter' ? { provider_mode: row.provider_mode } : {}), ...(row.gateway_auth_transport ? { gateway_auth_transport: row.gateway_auth_transport as CodexLbGatewayAuthTransport } : {}), ...(typeof row.catalog_version === 'string' ? { catalog_version: row.catalog_version } : {}) };
  const snapshots = legacySnapshots(input); return { ...row, schema: CODEX_LB_DESKTOP_BRIDGE_SETTINGS_SCHEMA, provider_registry: snapshots.registry, route_policy: snapshots.policy, provider_session_pins: [] };
}
function overridePaths(base: DesktopBridgeServicePaths, options: DesktopBridgeServiceOptions): DesktopBridgeServicePaths { return { settings_path: options.settingsPath || base.settings_path, state_path: options.statePath || base.state_path, launch_agent_path: options.launchAgentPath || base.launch_agent_path, stdout_log_path: options.stdoutLogPath || base.stdout_log_path, stderr_log_path: options.stderrLogPath || base.stderr_log_path }; }
function launchDomain(uid = typeof process.getuid === 'function' ? process.getuid() : 0): string { return `gui/${uid}`; }
function launchService(uid?: number): string { return `${launchDomain(uid)}/${DESKTOP_BRIDGE_LAUNCHD_LABEL}`; }
async function resolveLaunchCommand(options: DesktopBridgeServiceOptions): Promise<{ executable: string; arguments: string[] } | null> { if (options.executablePath) return await exists(path.resolve(options.executablePath)) ? { executable: path.resolve(options.executablePath), arguments: [...(options.executableArguments || [])] } : null; const entry = String(process.argv[1] || ''); if (entry && ['sks', 'sneakoscope'].includes(path.basename(entry).replace(/\.js$/i, '')) && await exists(entry)) return { executable: path.resolve(process.execPath), arguments: [path.resolve(entry)] }; const sks = await which('sks').catch(() => null); return sks ? { executable: path.resolve(sks), arguments: [] } : null; }
async function inspectLaunchd(options: DesktopBridgeServiceOptions, service: string): Promise<{ loaded: boolean; running: boolean }> { if ((options.platform || process.platform) !== 'darwin') return { loaded: false, running: false }; const result = await (options.run || runProcess)(options.launchctl || '/bin/launchctl', ['print', service], { timeoutMs: 3_000, maxOutputBytes: 32 * 1024 }).catch(() => null); if (!result || result.code !== 0) return { loaded: false, running: false }; const text = `${result.stdout}\n${result.stderr}`; return { loaded: true, running: /state = running/.test(text) && /pid = \d+/.test(text) }; }
async function waitForBridge(options: DesktopBridgeServiceOptions): Promise<DesktopBridgeServiceStatus> { let status = await desktopBridgeServiceStatus(options); for (let i = 0; i < 40 && !status.ok; i += 1) { await delay(100); status = await desktopBridgeServiceStatus(options); } return status; }
async function removeStaleState(file: string, probe?: (pid: number) => boolean): Promise<void> { const state = await readDesktopBridgeState(file).catch(() => null); if (!state || !(probe || desktopBridgeProcessExists)(state.pid)) await fsp.unlink(file).catch(() => undefined); }
async function waitForShutdown(handle: DesktopBridgeHandle): Promise<void> { await new Promise<void>((resolve) => { const done = (): void => { process.off('SIGINT', done); process.off('SIGTERM', done); resolve(); }; process.once('SIGINT', done); process.once('SIGTERM', done); handle.server.once('close', done); }); }
function failedStatus(paths: DesktopBridgeServicePaths, settings: DesktopBridgeServiceSettings, service: string, status: DesktopBridgeServiceStatus['status'], blocker: string): DesktopBridgeServiceStatus { return { schema: CODEX_LB_DESKTOP_BRIDGE_SERVICE_SCHEMA, ok: false, supported: true, installed: false, loaded: false, running: false, status, service, paths, state: null, settings, expected_config_generation: null, credential_source: null, blockers: [blocker] }; }
function bridgeStatusBlocker(status: DesktopBridgeStatus): string { return status.status === 'missing' ? 'desktop_bridge_state_missing' : status.status === 'running' ? '' : status.blocker; }
function safeServiceError(error: unknown): string { const bridge = safeBridgeErrorCode(error); if (bridge !== 'bridge_upstream_unavailable') return bridge; const message = error instanceof Error ? error.message : String(error); return /^[a-z0-9_:-]+$/i.test(message) ? message : 'desktop_bridge_service_failed'; }
function failedProcess(error: unknown) { return { code: 1, stdout: '', stderr: safeServiceError(error), stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false }; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
