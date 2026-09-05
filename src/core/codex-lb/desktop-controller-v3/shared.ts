import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { codexAuthPath, codexLbConfigPath } from '../../../cli/install-helpers-codex-lb-shared.js';
import type {
  BridgeProviderId,
  DesktopBridgeCommandOperation,
  DesktopBridgeCommandResult,
  DesktopBridgeStatusV3,
  ScopeCapabilitySummary
} from '../bridge-contracts.js';
import {
  bridgeRouteIndexPath,
  combinedBridgeCatalogPath,
  readActiveCombinedBridgeCatalog
} from '../combined-catalog.js';
import { codexLbEnvPath, codexLbMetadataPath } from '../codex-lb-env.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths,
  readDesktopBridgeClientCapability,
  resolveDesktopBridgeActivationSettings,
  stopDesktopBridgeService,
  writeDesktopBridgeServiceSettings,
  type DesktopBridgeServiceSettings,
  type DesktopBridgeServiceStatus
} from '../desktop-service.js';
import { desktopBridgeClientPath, type DesktopBridgeProviderRegistrySnapshot } from '../desktop-bridge/index.js';
import { desktopBridgeUnificationReceiptDir } from '../migration-receipt.js';
import {
  providerCredentialValidationPath,
  resolveAllProviderCredentials,
  resolveAllProviderCredentialsWithValidation,
  type ResolvedProviderCredential
} from '../provider-credentials.js';
import type { BridgeProviderRegistry } from '../provider-registry.js';
import { bridgeRoutePolicyPath } from '../provider-route-policy.js';
import { sha256Stable } from '../route-index.js';
import type { ControllerCore, ControllerPaths, DesktopBridgeControllerV3Options } from './types.js';

export function controllerPaths(options: DesktopBridgeControllerV3Options): ControllerPaths {
  const env = controllerEnv(options);
  const home = path.resolve(options.home || env.HOME || os.homedir());
  const codexHome = path.join(home, '.codex');
  return {
    home,
    codexHome,
    configPath: path.resolve(options.configPath || codexLbConfigPath(home)),
    authPath: path.resolve(options.authPath || codexAuthPath(home)),
    receiptDir: path.resolve(options.receiptDir || desktopBridgeUnificationReceiptDir(home)),
    catalogPath: path.resolve(options.catalogPath || combinedBridgeCatalogPath(codexHome)),
    routeIndexPath: path.resolve(options.routeIndexPath || bridgeRouteIndexPath(codexHome)),
    routePolicyPath: path.resolve(options.routePolicyPath || bridgeRoutePolicyPath(codexHome)),
    validationPath: path.resolve(options.validationPath || providerCredentialValidationPath(home)),
    diagnosticPath: path.resolve(options.diagnosticPath || path.join(codexHome, 'sks', 'sks-desktop-bridge-last-diagnostic.json'))
  };
}

export async function resolveRawCredentials(
  options: DesktopBridgeControllerV3Options,
  paths: ControllerPaths
): Promise<Record<BridgeProviderId, ResolvedProviderCredential>> {
  const env = controllerEnv(options);
  return resolveAllProviderCredentials({
    codexLb: {
      home: paths.home,
      processEnv: env,
      codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
      codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
    },
    openrouter: { home: paths.home, processEnv: env }
  });
}

export async function resolveValidatedCredentials(
  options: DesktopBridgeControllerV3Options,
  paths: ControllerPaths
): Promise<Record<BridgeProviderId, ResolvedProviderCredential>> {
  const env = controllerEnv(options);
  return resolveAllProviderCredentialsWithValidation({
    home: paths.home,
    validationPath: paths.validationPath,
    codexLb: {
      home: paths.home,
      processEnv: env,
      codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
      codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
    },
    openrouter: { home: paths.home, processEnv: env }
  });
}

export function activeProviderIds(core: Pick<ControllerCore, 'policy' | 'registry'>): BridgeProviderId[] {
  if (!core.policy) return [];
  return (['codex-lb', 'openrouter'] as const).filter((providerId) =>
    core.registry.profiles[providerId].enabled
      && core.registry.profiles[providerId].state === 'ready'
      && Object.values(core.policy!.model_routes).some((route) => route.provider_id === providerId));
}

export function providerRegistrySnapshot(
  registry: BridgeProviderRegistry,
  routeIndex: Awaited<ReturnType<typeof readActiveCombinedBridgeCatalog>>['route_index']
): DesktopBridgeProviderRegistrySnapshot {
  const provider = (providerId: BridgeProviderId) => {
    const profile = registry.profiles[providerId];
    const baseUrl = profile.endpoint.url
      || (providerId === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://invalid.codex-lb.local');
    return {
      provider_id: providerId,
      enabled: profile.enabled,
      base_url: baseUrl,
      allowed_origins: [...profile.endpoint.allowed_origins],
      auth_transport: profile.endpoint.auth_transport,
      credential_state: profile.credential.state,
      credential_fingerprint: profile.credential.fingerprint,
      credential_generation: profile.profile_generation,
      source_catalog_generation: routeIndex.providers[providerId].catalog_generation
    };
  };
  const providers: DesktopBridgeProviderRegistrySnapshot['providers'] = {
    'codex-lb': provider('codex-lb'),
    openrouter: provider('openrouter')
  };
  return {
    schema: 'sks.desktop-bridge-provider-registry.v1',
    generation: sha256Stable(providers),
    created_at: new Date().toISOString(),
    providers
  };
}

export async function persistRuntimeSettings(
  core: ControllerCore,
  options: DesktopBridgeControllerV3Options,
  behavior: { restartService?: boolean; failClosedRestart?: boolean } = {}
): Promise<void> {
  if (!core.activeCatalog.ok || !core.policy) return;
  const snapshot = providerRegistrySnapshot(core.registry, core.activeCatalog.route_index);
  const settings = await resolveDesktopBridgeActivationSettings({
    ...options,
    home: core.paths.home,
    providerRegistry: snapshot,
    routePolicy: core.policy
  });
  await writeDesktopBridgeServiceSettings(
    options.settingsPath || desktopBridgeServicePaths(core.paths.home).settings_path,
    settings
  );
  const restartService = behavior.restartService ?? (core.service.installed || core.service.running);
  if (!restartService) return;
  const restartOptions = {
    ...options,
    home: core.paths.home,
    providerRegistry: snapshot,
    routePolicy: core.policy
  };
  let restarted: DesktopBridgeServiceStatus;
  try {
    restarted = await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)(restartOptions);
  } catch (error) {
    await stopAfterFailedRestart(restartOptions, options);
    throw error;
  }
  if (!restarted.ok || !restarted.running) {
    await stopAfterFailedRestart(restartOptions, options);
    const rootCause = restarted.blockers.find((blocker) => blocker === 'desktop_bridge_entry_macos_protected_folder');
    throw new Error(rootCause || restarted.blockers[0] || 'desktop_bridge_restart_failed');
  }
}

export async function quiesceRunningBridge(
  core: ControllerCore,
  options: DesktopBridgeControllerV3Options
): Promise<boolean> {
  if (!core.service.running) return false;
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home: core.paths.home
  });
  if (stopped.running) {
    throw new Error(stopped.blockers[0] || 'desktop_bridge_process_still_running');
  }
  return true;
}

async function stopAfterFailedRestart(
  restartOptions: DesktopBridgeControllerV3Options,
  options: DesktopBridgeControllerV3Options
): Promise<void> {
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)(restartOptions);
  if (stopped.running) throw new Error(stopped.blockers[0] || 'desktop_bridge_process_still_running');
}

export function serializedSettings(settings: DesktopBridgeServiceSettings): string {
  return `${JSON.stringify({
    schema: settings.schema,
    listen_host: settings.listen_host,
    listen_port: settings.listen_port,
    provider_registry: settings.provider_registry,
    route_policy: settings.route_policy,
    provider_session_pins: settings.provider_session_pins,
    client_capability_sha256: settings.client_capability_sha256,
    allowed_origins: settings.allowed_origins,
    connect_timeout_ms: settings.connect_timeout_ms,
    idle_timeout_ms: settings.idle_timeout_ms,
    // Dropping this field here silently erased a pinned official-models
    // choice on the next catalog sync — the durability the setting exists for.
    auth_priority_enabled: settings.auth_priority_enabled ?? false,
    official_passthrough: settings.official_passthrough
  }, null, 2)}\n`;
}

export async function bridgeBaseUrl(
  settings: DesktopBridgeServiceSettings,
  options: DesktopBridgeControllerV3Options
): Promise<string> {
  const host = settings.listen_host === '::1' ? '[::1]' : settings.listen_host;
  return bridgeClientUrl(
    `http://${host}:${settings.listen_port}`,
    '/backend-api/codex',
    options,
    settings.client_capability_sha256
  );
}

export async function bridgeClientUrl(
  loopbackOrigin: string,
  canonicalPath: string,
  options: DesktopBridgeControllerV3Options,
  expectedCapabilitySha256?: string
): Promise<string> {
  const origin = validatedBridgeClientOrigin(loopbackOrigin);
  const home = path.resolve(options.home || controllerEnv(options).HOME || os.homedir());
  const capabilityPath = path.resolve(
    options.clientCapabilityPath || desktopBridgeServicePaths(home).client_capability_path
  );
  const capability = await readDesktopBridgeClientCapability(capabilityPath);
  if (expectedCapabilitySha256
    && createHash('sha256').update(capability).digest('hex') !== expectedCapabilitySha256) {
    throw new Error('desktop_bridge_client_capability_mismatch');
  }
  return `${origin}${desktopBridgeClientPath(capability, canonicalPath)}`;
}

function validatedBridgeClientOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(String(value || '')); }
  catch { throw new Error('desktop_bridge_loopback_origin_invalid'); }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = Number(parsed.port);
  if (!['http:', 'ws:'].includes(parsed.protocol)
    || !['127.0.0.1', '::1', 'localhost'].includes(hostname)
    || !Number.isInteger(port)
    || port < 49_152
    || port > 65_535
    || parsed.username
    || parsed.password
    || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search
    || parsed.hash) {
    throw new Error('desktop_bridge_loopback_origin_invalid');
  }
  return parsed.origin;
}

export function serviceLoopbackOrigin(service: DesktopBridgeServiceStatus): string | null {
  if (service.state?.listen_origin) return service.state.listen_origin;
  const settings = service.settings;
  if (!settings) return null;
  const host = settings.listen_host === '::1' ? '[::1]' : settings.listen_host;
  return `http://${host}:${settings.listen_port}`;
}

export function commandResult(
  operation: DesktopBridgeCommandOperation,
  executionOk: boolean,
  status: DesktopBridgeStatusV3 | null,
  result: Record<string, unknown>,
  blockers: readonly string[],
  options: DesktopBridgeControllerV3Options
): DesktopBridgeCommandResult {
  const checkedAt = nowIso(options);
  const readiness = status?.readiness || { ready: false, blockers: [...blockers], warnings: [] };
  return {
    schema: 'sks.desktop-bridge-command-result.v1',
    operation,
    operation_id: makeId('operation', options),
    correlation_id: status?.correlation_id || makeId('correlation', options),
    checked_at: checkedAt,
    ok: executionOk,
    execution: {
      ok: executionOk,
      status: executionOk ? (blockers.length > 0 ? 'partial' : 'completed') : 'failed',
      blockers: unique(blockers)
    },
    readiness: {
      ready: readiness.ready,
      blockers: [...readiness.blockers],
      warnings: [...readiness.warnings]
    },
    status,
    result,
    recovery_action: blockers.length > 0 ? recoveryActions(blockers)[0] || 'review_bridge_status' : null
  };
}

export function emptyScope(scope: ScopeCapabilitySummary['scope'], checkedAt: string): ScopeCapabilitySummary {
  return {
    schema: 'sks.scope-capability-summary.v1',
    scope,
    state: 'not_attempted',
    checked_at: checkedAt,
    capabilities: {},
    blockers: [],
    warnings: []
  };
}

export function recoveryActions(blockers: readonly string[]): string[] {
  return unique(blockers.map((blocker) => {
    if (blocker.includes('credential') && blocker.includes('codex')) return 'configure_codex_lb_credential';
    if (blocker.includes('credential') && blocker.includes('openrouter')) return 'configure_openrouter_credential';
    if (blocker.includes('catalog') || blocker.includes('route')) return 'retry_catalog_sync';
    if (blocker.includes('oauth')) return 'review_desktop_authentication';
    if (blocker.includes('bridge')) return 'repair_bridge_service';
    return 'review_bridge_status';
  }));
}

export function controllerEnv(options: DesktopBridgeControllerV3Options): NodeJS.ProcessEnv {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  return { ...process.env, ...(options.env || {}), HOME: home };
}

export function timeoutMs(options: DesktopBridgeControllerV3Options): number {
  return Math.max(500, Math.min(30_000, Number(options.timeoutMs || 10_000)));
}

export function nowIso(options: DesktopBridgeControllerV3Options): string {
  return (options.now ? options.now() : new Date()).toISOString();
}

export function makeId(prefix: string, options: DesktopBridgeControllerV3Options): string {
  return `${prefix}-${options.id ? options.id() : randomUUID()}`;
}

export function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

export function safeCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^[a-z0-9_:/.-]{1,240}$/i.test(message) ? message : fallback;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

export function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
