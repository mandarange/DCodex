import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
  removeDesktopBridgeManagedConfig
} from '../../cli/install-helpers-codex-lb-config.js';
import { codexAuthPath, codexLbConfigPath } from '../../cli/install-helpers-codex-lb-shared.js';
import { safeWriteCodexConfigToml } from '../codex-runtime/codex-desktop-config-policy.js';
import { readText, writeJsonAtomic, writeTextAtomic } from '../fsx.js';
import { listOpenRouterModels, testOpenRouterConnection } from '../providers/openrouter/openrouter-account.js';
import type {
  BridgeProviderId,
  BridgeProviderProfileStatus,
  BridgeRoutingPolicy,
  CapabilityProbeResultV3,
  CapabilityRequestedLevel,
  CatalogSyncState,
  CombinedCatalogSyncStatus,
  DesktopBridgeCommandOperation,
  DesktopBridgeCommandResult,
  DesktopBridgeStatusV3,
  DesktopBridgeRuntimeState,
  DesktopCapabilityReportV3,
  HttpProbeResult,
  ScopeCapabilitySummary,
  WebSocketProbeResult
} from './bridge-contracts.js';
import {
  activateCombinedBridgeCatalog,
  bridgeRouteIndexPath,
  buildCombinedBridgeCatalog,
  combinedBridgeCatalogPath,
  readActiveCombinedBridgeCatalog,
  type ProviderCatalogBuildInput
} from './combined-catalog.js';
import {
  codexLbEnvPath,
  codexLbMetadataPath,
  loadCodexLbEnv,
  readCodexLbModelCatalog
} from './codex-lb-env.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  installAndStartDesktopBridgeService,
  resolveDesktopBridgeActivationSettings,
  stopDesktopBridgeService,
  writeDesktopBridgeServiceSettings,
  type DesktopBridgeServiceOptions,
  type DesktopBridgeServiceSettings,
  type DesktopBridgeServiceStatus
} from './desktop-service.js';
import {
  DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH,
  DESKTOP_BRIDGE_DIAGNOSTIC_PATH,
  probeDesktopBridgeWebSocket,
  type DesktopBridgeProviderRegistrySnapshot
} from './desktop-bridge/index.js';
import { captureCodexAuthSnapshot } from './desktop-auth-invariant.js';
import {
  migrateLegacyModeToDesktopBridge
} from './legacy-migration.js';
import {
  desktopBridgeUnificationReceiptDir,
  rollbackDesktopBridgeUnificationReceipt
} from './migration-receipt.js';
import {
  configureProviderCredential,
  providerCredentialValidationPath,
  recordProviderCredentialValidation,
  removeProviderCredential,
  resolveAllProviderCredentials,
  resolveAllProviderCredentialsWithValidation,
  type ResolvedProviderCredential
} from './provider-credentials.js';
import {
  configureBridgeProviderProfile,
  resolveBridgeProviderRegistry,
  setBridgeProviderEnabled,
  type BridgeProviderRegistry
} from './provider-registry.js';
import {
  bridgeRoutePolicyPath,
  buildBridgeRoutingPolicy,
  readBridgeRoutingPolicy,
  setBridgeRoutingDefault,
  validateBridgeRoutingPolicy,
  writeBridgeRoutingPolicy
} from './provider-route-policy.js';
import { resolveBridgeRequestRoute } from './request-route-resolver.js';
import { sha256Stable } from './route-index.js';
import { runDesktopCapabilityReportV3 } from './capability-runner.js';
import {
  assertDesktopBridgeStatusV3,
  assertDesktopCapabilityReportV3,
  validateDesktopCapabilityReportV3
} from './bridge-runtime-validation.js';
import { runBridgeProbeV3 } from './probes/bridge-probe.js';
import { capabilityProbeResultV3 } from './probes/probe-evidence.js';

const LAST_DIAGNOSTIC_SCHEMA = 'sks.desktop-bridge-last-diagnostic.v1' as const;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

export type DesktopBridgeControllerRequestV3 =
  | { operation: 'status' }
  | { operation: 'ensure' }
  | { operation: 'repair' }
  | { operation: 'verify'; level: CapabilityRequestedLevel }
  | { operation: 'provider.list' }
  | { operation: 'provider.configure'; provider_id: BridgeProviderId; api_key: string; host?: string }
  | { operation: 'provider.validate'; provider_id: BridgeProviderId }
  | { operation: 'provider.enable'; provider_id: BridgeProviderId }
  | { operation: 'provider.disable'; provider_id: BridgeProviderId }
  | { operation: 'provider.remove-credential'; provider_id: BridgeProviderId; confirmed: true }
  | { operation: 'catalog.sync' }
  | { operation: 'catalog.status' }
  | { operation: 'route.list' }
  | { operation: 'route.set-default'; provider_id: BridgeProviderId }
  | { operation: 'route.explain'; model: string }
  | { operation: 'unmanage'; confirmed: true }
  | { operation: 'rollback'; receipt_id: string; confirmed: true };

export interface DesktopBridgeControllerV3Options extends DesktopBridgeServiceOptions {
  configPath?: string;
  authPath?: string;
  receiptDir?: string;
  catalogPath?: string;
  routeIndexPath?: string;
  routePolicyPath?: string;
  validationPath?: string;
  diagnosticPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
  id?: () => string;
  serviceStatusImpl?: typeof desktopBridgeServiceStatus;
  installServiceImpl?: typeof installAndStartDesktopBridgeService;
  bootstrapServiceImpl?: typeof bootstrapExistingDesktopBridgeService;
  stopServiceImpl?: typeof stopDesktopBridgeService;
}

type ControllerPaths = {
  home: string;
  codexHome: string;
  configPath: string;
  authPath: string;
  receiptDir: string;
  catalogPath: string;
  routeIndexPath: string;
  routePolicyPath: string;
  validationPath: string;
  diagnosticPath: string;
};

type ControllerCore = {
  paths: ControllerPaths;
  checkedAt: string;
  config: string;
  credentials: Record<BridgeProviderId, ResolvedProviderCredential>;
  registry: BridgeProviderRegistry;
  activeCatalog: Awaited<ReturnType<typeof readActiveCombinedBridgeCatalog>>;
  policy: BridgeRoutingPolicy | null;
  policyBlockers: readonly string[];
  service: DesktopBridgeServiceStatus;
  auth: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>;
  catalogSync: CombinedCatalogSyncStatus;
  diagnostic: LastDiagnostic | null;
};

type LastDiagnostic = {
  schema: typeof LAST_DIAGNOSTIC_SCHEMA;
  checked_at: string;
  catalog_generation: string | null;
  report: DesktopCapabilityReportV3;
  http_probe: HttpProbeResult | null;
  websocket_probe: WebSocketProbeResult | null;
};

export async function executeDesktopBridgeCommandV3(
  request: DesktopBridgeControllerRequestV3,
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopBridgeStatusV3 | DesktopCapabilityReportV3 | DesktopBridgeCommandResult> {
  if (request.operation === 'status') return desktopBridgeStatusV3(options);
  if (request.operation === 'verify') return verifyDesktopBridgeV3(request.level, options);

  try {
    if (request.operation === 'ensure') return ensureDesktopBridge(options, 'ensure');
    if (request.operation === 'repair') return repairDesktopBridge(options);
    if (request.operation === 'provider.list') {
      const status = await desktopBridgeStatusV3(options);
      return commandResult('provider.list', true, status, { providers: status.providers }, [], options);
    }
    if (request.operation === 'provider.configure') {
      return configureProvider(request, options);
    }
    if (request.operation === 'provider.validate') {
      return validateProvider(request.provider_id, options);
    }
    if (request.operation === 'provider.enable' || request.operation === 'provider.disable') {
      return setProviderState(
        request.provider_id,
        request.operation === 'provider.enable',
        request.operation,
        options
      );
    }
    if (request.operation === 'provider.remove-credential') {
      return removeCredential(request.provider_id, options);
    }
    if (request.operation === 'catalog.sync') return syncCatalog(options);
    if (request.operation === 'catalog.status') {
      const status = await desktopBridgeStatusV3(options);
      return commandResult('catalog.status', true, status, { catalog_sync: status.catalog_sync }, [], options);
    }
    if (request.operation === 'route.list') {
      const status = await desktopBridgeStatusV3(options);
      return commandResult('route.list', true, status, { routing: status.routing }, [], options);
    }
    if (request.operation === 'route.set-default') {
      return setDefaultProvider(request.provider_id, options);
    }
    if (request.operation === 'route.explain') return explainRoute(request.model, options);
    if (request.operation === 'unmanage') return unmanageDesktopBridge(options);
    return rollbackDesktopBridge(request.receipt_id, options);
  } catch (error) {
    const blocker = safeCode(error, 'desktop_bridge_command_failed');
    const status = await desktopBridgeStatusV3(options).catch(() => null);
    return commandResult(
      request.operation as DesktopBridgeCommandOperation,
      false,
      status,
      {},
      [blocker],
      options
    );
  }
}

export async function desktopBridgeStatusV3(
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopBridgeStatusV3> {
  const core = await loadCore(options);
  const status = statusFromCore(core, options);
  assertDesktopBridgeStatusV3(status);
  return status;
}

export async function verifyDesktopBridgeV3(
  requestedLevel: CapabilityRequestedLevel,
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopCapabilityReportV3> {
  const core = await loadCore(options);
  const status = statusFromCore(core, options);
  const reportId = makeId('report', options);
  const correlationId = makeId('correlation', options);
  const sessionId = makeId('session', options);
  const checkedAt = nowIso(options);
  let httpProbe: HttpProbeResult | undefined;
  let websocketProbe: WebSocketProbeResult | undefined;
  if (requestedLevel !== 'shallow') {
    [httpProbe, websocketProbe] = await Promise.all([
      probeBridgeHttp(status.service.loopback_origin, options),
      probeBridgeWebSocket(status.service.loopback_origin, requestedLevel, options)
    ]);
  }
  const probeContext = {
    requestedLevel,
    checkedAt,
    reportId,
    correlationId,
    sessionId,
    attemptId: 1
  } as const;
  const results: CapabilityProbeResultV3[] = [
    ...runBridgeProbeV3({
      ...probeContext,
      configured: status.management.managed,
      processRunning: status.service.running,
      ...(httpProbe ? { httpProbe } : {}),
      ...(websocketProbe ? { websocketProbe } : {})
    }),
    nativeIdentityProbe(core, probeContext),
    combinedRoutePolicyProbe(core, probeContext),
    combinedModelRouteProbe(core, status, probeContext)
  ];
  const activeProviders = activeProviderIds(core);
  const enabledProviders = (['codex-lb', 'openrouter'] as const)
    .filter((providerId) => core.registry.profiles[providerId].enabled);
  for (const providerId of ['codex-lb', 'openrouter'] as const) {
    results.push(
      providerCredentialProbe(core, providerId, probeContext),
      providerAuthProbe(core, providerId, probeContext),
      providerModelRouteProbe(core, providerId, probeContext)
    );
  }
  if (requestedLevel !== 'shallow') {
    const textResults = await Promise.all(activeProviders.map((providerId) =>
      probeProviderText(core, providerId, status.service.loopback_origin, probeContext, options)));
    results.push(...textResults);
  }
  const report = runDesktopCapabilityReportV3({
    requestedLevel,
    reportId,
    correlationId,
    sessionId,
    checkedAt,
    activeProviderIds: activeProviders,
    enabledProviderIds: enabledProviders,
    catalogSync: core.catalogSync,
    results,
    executionBlockers: [],
    executionWarnings: status.service.running ? [] : ['bridge_service_not_running']
  });
  assertDesktopCapabilityReportV3(report);
  await writeLastDiagnostic(core.paths.diagnosticPath, {
    schema: LAST_DIAGNOSTIC_SCHEMA,
    checked_at: checkedAt,
    catalog_generation: report.catalog_generation,
    report,
    http_probe: httpProbe || null,
    websocket_probe: websocketProbe || null
  });
  return report;
}

async function ensureDesktopBridge(
  options: DesktopBridgeControllerV3Options,
  operation: 'ensure' | 'repair'
): Promise<DesktopBridgeCommandResult> {
  const sync = await syncCatalogInternal(options);
  let core = await loadCore(options);
  if (!core.activeCatalog.ok || !core.policy) {
    const status = statusFromCore(core, options);
    return commandResult(operation, true, status, { catalog_sync: sync }, [], options);
  }
  const snapshot = providerRegistrySnapshot(core.registry, core.activeCatalog.route_index);
  const service = await (options.installServiceImpl || installAndStartDesktopBridgeService)({
    ...options,
    home: core.paths.home,
    providerRegistry: snapshot,
    routePolicy: core.policy
  });
  core = await loadCore(options);
  let report: DesktopCapabilityReportV3 | null = null;
  if (service.running) report = await verifyDesktopBridgeV3('shallow', options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult(operation, true, status, { service, catalog_sync: sync, capabilities: report }, [], options);
}

async function repairDesktopBridge(
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  let core = await loadCore(options);
  if (!core.activeCatalog.ok || !core.policy) return ensureDesktopBridge(options, 'repair');
  await persistRuntimeSettings(core, options);
  const service = await (options.installServiceImpl || installAndStartDesktopBridgeService)({
    ...options,
    home: core.paths.home,
    providerRegistry: providerRegistrySnapshot(core.registry, core.activeCatalog.route_index),
    routePolicy: core.policy
  });
  core = await loadCore(options);
  const report = service.running ? await verifyDesktopBridgeV3('shallow', options) : null;
  const status = await desktopBridgeStatusV3(options);
  return commandResult('repair', true, status, { service, capabilities: report }, [], options);
}

async function configureProvider(
  request: Extract<DesktopBridgeControllerRequestV3, { operation: 'provider.configure' }>,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const configured = await configureProviderCredential({
    provider_id: request.provider_id,
    api_key: request.api_key,
    ...(request.host ? { host: request.host } : {}),
    home: paths.home,
    processEnv: controllerEnv(options),
    codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
    codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
  });
  const rawCredentials = await resolveRawCredentials(options, paths);
  const endpoint = request.provider_id === 'codex-lb'
    ? rawCredentials['codex-lb'].endpoint_url
    : 'https://openrouter.ai/api/v1';
  if (!endpoint) throw new Error(`${providerCode(request.provider_id)}_endpoint_missing`);
  const registry = await configureBridgeProviderProfile({
    provider_id: request.provider_id,
    endpoint_url: endpoint,
    enabled: true,
    home: paths.home,
    credentials: rawCredentials
  });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings({ ...core, registry }, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('provider.configure', true, status, { configuration: configured }, [], options);
}

async function validateProvider(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const credentials = await resolveRawCredentials(options, paths);
  const credential = credentials[providerId];
  if (!credential.secret || !credential.fingerprint || !credential.endpoint_url) {
    const status = await desktopBridgeStatusV3(options);
    return commandResult(
      'provider.validate',
      true,
      status,
      { provider_id: providerId, validated: false },
      [`${providerCode(providerId)}_credential_missing`],
      options
    );
  }
  const result = providerId === 'codex-lb'
    ? await validateCodexLbCredential(paths, options)
    : await testOpenRouterConnection({
      env: controllerEnv(options),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: timeoutMs(options)
    });
  const ok = result.ok === true;
  const blockers = stringArray((result as Record<string, unknown>).blockers);
  await recordProviderCredentialValidation({
    provider_id: providerId,
    credential,
    state: ok ? 'ready' : validationFailureState(blockers),
    checked_at: nowIso(options),
    blockers,
    warnings: stringArray((result as Record<string, unknown>).warnings),
    home: paths.home,
    validationPath: paths.validationPath
  });
  const status = await desktopBridgeStatusV3(options);
  return commandResult(
    'provider.validate',
    true,
    status,
    { provider_id: providerId, validated: ok, validation: publicValidationResult(result) },
    [],
    options
  );
}

async function setProviderState(
  providerId: BridgeProviderId,
  enabled: boolean,
  operation: 'provider.enable' | 'provider.disable',
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  await setBridgeProviderEnabled({ provider_id: providerId, enabled, home: paths.home });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings(core, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult(operation, true, status, { provider_id: providerId, enabled }, [], options);
}

async function removeCredential(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const removal = await removeProviderCredential({
    provider_id: providerId,
    confirmed: true,
    home: paths.home,
    codexLbEnvPath: options.envPath || codexLbEnvPath(paths.home),
    codexLbMetadataPath: options.metadataPath || codexLbMetadataPath(paths.home)
  });
  const core = await loadCore(options);
  if (core.activeCatalog.ok && core.policy) await persistRuntimeSettings(core, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('provider.remove-credential', removal.blockers.length === 0, status, { removal }, removal.blockers, options);
}

async function syncCatalog(
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const result = await syncCatalogInternal(options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('catalog.sync', true, status, { catalog_sync: result }, [], options);
}

async function syncCatalogInternal(
  options: DesktopBridgeControllerV3Options
): Promise<Record<string, unknown>> {
  const paths = controllerPaths(options);
  const beforePointer = await snapshotOwnedFile(activePointerPath(paths.catalogPath));
  const rawCredentials = await resolveRawCredentials(options, paths);
  const initialRegistry = await resolveBridgeProviderRegistry({ home: paths.home, credentials: rawCredentials });
  const catalogs = await fetchProviderCatalogs(initialRegistry, rawCredentials, paths, options);
  const credentials = await resolveValidatedCredentials(options, paths);
  const registry = await resolveBridgeProviderRegistry({ home: paths.home, credentials });
  const build = buildCombinedBridgeCatalog(registry, {
    catalogs,
    created_at: nowIso(options)
  });
  const activation = await activateCombinedBridgeCatalog({
    build,
    catalogPath: paths.catalogPath,
    routeIndexPath: paths.routeIndexPath
  });
  if (!activation.activated || !activation.catalog_path) {
    return { build, activation, migration: null };
  }
  const priorPolicy = await readBridgeRoutingPolicy(paths.routePolicyPath);
  const readyProviders = (['codex-lb', 'openrouter'] as const).filter((providerId) =>
    registry.profiles[providerId].enabled
      && registry.profiles[providerId].state === 'ready'
      && Object.values(build.route_index.routes).some((route) => route.provider_id === providerId));
  const previousDefault = priorPolicy.policy?.default_provider_id || null;
  const defaultProvider = previousDefault && readyProviders.includes(previousDefault)
    ? previousDefault
    : readyProviders.length === 1
      ? readyProviders[0] || null
      : null;
  const policy = buildBridgeRoutingPolicy({
    route_index: build.route_index,
    catalog_generation: build.catalog.generation,
    default_provider_id: defaultProvider,
    changed_at: nowIso(options)
  });
  const settings = await resolveDesktopBridgeActivationSettings({
    ...options,
    home: paths.home,
    providerRegistry: providerRegistrySnapshot(registry, build.route_index),
    routePolicy: policy
  });
  const migration = await migrateLegacyModeToDesktopBridge({
    home: paths.home,
    configPath: paths.configPath,
    authPath: paths.authPath,
    receiptDir: paths.receiptDir,
    bridgeBaseUrl: bridgeBaseUrl(settings),
    combinedCatalogPath: activation.catalog_path,
    newCatalogGeneration: build.catalog.generation,
    metadataUpdates: [
      { kind: 'route_policy', path: paths.routePolicyPath, text: `${JSON.stringify(policy, null, 2)}\n` },
      { kind: 'bridge_settings', path: desktopBridgeServicePaths(paths.home).settings_path, text: serializedSettings(settings) }
    ]
  });
  if (!migration.ok) {
    await restoreOwnedFile(activePointerPath(paths.catalogPath), beforePointer);
    return { build, activation, migration, active_generation_restored: true };
  }
  const serviceBefore = await (options.serviceStatusImpl || desktopBridgeServiceStatus)({ ...options, home: paths.home });
  if (serviceBefore.installed || serviceBefore.running) {
    await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)({
      ...options,
      home: paths.home,
      providerRegistry: providerRegistrySnapshot(registry, build.route_index),
      routePolicy: policy
    });
  }
  return { build, activation, migration };
}

async function setDefaultProvider(
  providerId: BridgeProviderId,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const core = await loadCore(options);
  if (!core.policy || !core.activeCatalog.ok) throw new Error('bridge_route_policy_missing');
  if (!core.registry.profiles[providerId].enabled) throw new Error(`${providerCode(providerId)}_provider_disabled`);
  if (!Object.values(core.policy.model_routes).some((route) => route.provider_id === providerId)) {
    throw new Error(`${providerCode(providerId)}_catalog_route_not_ready`);
  }
  const policy = setBridgeRoutingDefault(core.policy, providerId, nowIso(options));
  await writeBridgeRoutingPolicy(core.paths.routePolicyPath, policy, core.activeCatalog.route_index);
  const next = { ...core, policy, policyBlockers: [] };
  await persistRuntimeSettings(next, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('route.set-default', true, status, { provider_id: providerId, policy_generation: policy.policy_generation }, [], options);
}

async function explainRoute(
  model: string,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const core = await loadCore(options);
  if (!core.policy || !core.activeCatalog.ok) throw new Error('bridge_route_policy_missing');
  const explanation = resolveBridgeRequestRoute({ model }, core.policy, {
    route_index: core.activeCatalog.route_index,
    registry: core.registry,
    active_catalog_generation: core.activeCatalog.catalog.generation
  });
  const status = statusFromCore(core, options);
  return commandResult('route.explain', true, status, { explanation }, [], options);
}

async function unmanageDesktopBridge(
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const current = await readText(paths.configPath, '');
  const next = removeDesktopBridgeManagedConfig(current);
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home: paths.home,
    removePlist: true,
    removeSettings: true
  });
  const write = await safeWriteCodexConfigToml(
    paths.configPath,
    current,
    next,
    'desktop-bridge-unmanage',
    { verifyUnchangedBeforeWrite: true }
  );
  if (!write.ok) {
    await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)({ ...options, home: paths.home }).catch(() => undefined);
    throw new Error(`desktop_bridge_unmanage_config_${write.status}`);
  }
  const status = await desktopBridgeStatusV3(options);
  return commandResult('unmanage', true, status, {
    unmanaged: true,
    credentials_deleted: false,
    service: stopped,
    config_backup_path: write.backup_path || null
  }, [], options);
}

async function rollbackDesktopBridge(
  receiptId: string,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(receiptId)) throw new Error('desktop_bridge_receipt_id_invalid');
  const paths = controllerPaths(options);
  const receiptPath = path.resolve(paths.receiptDir, `${receiptId.replace(/\.json$/i, '')}.json`);
  if (!receiptPath.startsWith(`${path.resolve(paths.receiptDir)}${path.sep}`)) {
    throw new Error('desktop_bridge_receipt_path_invalid');
  }
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home: paths.home,
    removePlist: true
  });
  const rollback = await rollbackDesktopBridgeUnificationReceipt({ receiptPath });
  if (!rollback.ok) {
    await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)({ ...options, home: paths.home }).catch(() => undefined);
  }
  const status = await desktopBridgeStatusV3(options);
  return commandResult('rollback', rollback.ok, status, { rollback, service: stopped }, rollback.ok ? [] : [rollback.status], options);
}

async function loadCore(options: DesktopBridgeControllerV3Options): Promise<ControllerCore> {
  const paths = controllerPaths(options);
  const checkedAt = nowIso(options);
  const [config, credentials, activeCatalog, policyRead, auth] = await Promise.all([
    readText(paths.configPath, ''),
    resolveValidatedCredentials(options, paths),
    readActiveCombinedBridgeCatalog(paths.catalogPath, paths.routeIndexPath),
    readBridgeRoutingPolicy(paths.routePolicyPath),
    captureCodexAuthSnapshot({ home: paths.home, authPath: paths.authPath })
  ]);
  const registry = await resolveBridgeProviderRegistry({ home: paths.home, credentials });
  const policyBlockers = policyRead.policy && activeCatalog.ok
    ? validateBridgeRoutingPolicy(policyRead.policy, activeCatalog.route_index)
    : policyRead.blockers;
  const policy = policyBlockers.length === 0 ? policyRead.policy : null;
  const snapshot = activeCatalog.ok
    ? providerRegistrySnapshot(registry, activeCatalog.route_index)
    : undefined;
  const service = await (options.serviceStatusImpl || desktopBridgeServiceStatus)({
    ...options,
    home: paths.home,
    ...(snapshot ? { providerRegistry: snapshot } : {}),
    ...(policy ? { routePolicy: policy } : {})
  });
  const catalogSync = catalogStatus(activeCatalog, registry, policy, policyBlockers, checkedAt);
  const diagnostic = await readLastDiagnostic(paths.diagnosticPath, catalogSync.generation);
  return {
    paths,
    checkedAt,
    config,
    credentials,
    registry,
    activeCatalog,
    policy,
    policyBlockers,
    service,
    auth,
    catalogSync,
    diagnostic
  };
}

function statusFromCore(
  core: ControllerCore,
  options: DesktopBridgeControllerV3Options
): DesktopBridgeStatusV3 {
  const managedConfig = isManagedConfig(core.config);
  const serviceState = serviceRuntimeState(core.service);
  const managed = managedConfig || core.service.installed || Boolean(core.service.settings);
  const management = managed
    ? {
        managed: true as const,
        runtime: 'desktop-bridge' as const,
        state: serviceState,
        reason: null
      }
    : {
        managed: false as const,
        runtime: null,
        state: core.service.installed ? 'stopped' as const : 'not_installed' as const,
        reason: core.config.trim() ? 'uninstalled' as const : 'never_configured' as const
      };
  const activeProviders = activeProviderIds(core);
  const activeBlockers: string[] = [];
  const warnings: string[] = [];
  if (managedConfig && !core.service.running) activeBlockers.push(...core.service.blockers);
  if (activeProviders.length === 0) activeBlockers.push('bridge_active_route_not_selected');
  for (const providerId of ['codex-lb', 'openrouter'] as const) {
    const profile = core.registry.profiles[providerId];
    const problems = unique([...profile.blockers, ...core.catalogSync.providers[providerId].blockers]);
    if (activeProviders.includes(providerId)) activeBlockers.push(...problems);
    else warnings.push(...problems.map((problem) => `inactive_provider:${providerId}:${problem}`));
  }
  const activeCatalogReady = activeProviders.length > 0 && activeProviders.every((providerId) =>
    core.catalogSync.providers[providerId].state === 'verified'
      && core.policy
      && Object.values(core.policy.model_routes).some((route) => route.provider_id === providerId));
  if (!activeCatalogReady) activeBlockers.push(...core.catalogSync.blockers);
  const oauthConfigured = core.auth.mode === 'chatgpt_oauth' || core.auth.mode === 'mixed';
  if (managedConfig && !oauthConfigured) activeBlockers.push('chatgpt_oauth_required_for_desktop');
  const lastReport = core.diagnostic?.report || null;
  const bridgeReady = core.service.running && (lastReport?.summary.bridge_ready ?? false);
  const activeRoutesReady = activeCatalogReady
    && activeProviders.every((providerId) => core.registry.profiles[providerId].state === 'ready');
  const ready = managedConfig && bridgeReady && activeRoutesReady && oauthConfigured;
  const readinessState: DesktopBridgeStatusV3['readiness']['state'] = !managed
    ? 'unmanaged'
    : activeProviders.length === 0
      ? 'awaiting_provider'
      : ready
        ? 'ready'
        : core.service.running && activeCatalogReady
          ? 'degraded'
          : 'blocked';
  const status: DesktopBridgeStatusV3 = {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: core.checkedAt,
    correlation_id: makeId('status', options),
    management,
    service: {
      state: serviceState,
      installed: core.service.installed,
      loaded: core.service.loaded,
      running: core.service.running,
      loopback_origin: serviceLoopbackOrigin(core.service),
      pid: core.service.state?.pid || null,
      checked_at: core.checkedAt,
      blockers: [...core.service.blockers],
      warnings: []
    },
    http_probe: core.diagnostic?.http_probe || null,
    websocket_probe: core.diagnostic?.websocket_probe || null,
    native_identity: {
      state: oauthConfigured ? 'verified' : 'blocked',
      configured: oauthConfigured,
      // Current OAuth presence proves identity availability, not before/after
      // preservation. Only a migration receipt can make the latter claim, and
      // status deliberately does not infer it from one current snapshot.
      semantic_identity_preserved: null,
      checked_at: core.checkedAt,
      blockers: oauthConfigured ? [] : ['chatgpt_oauth_required_for_desktop'],
      warnings: []
    },
    providers: {
      'codex-lb': providerProfileStatus(core, 'codex-lb'),
      openrouter: providerProfileStatus(core, 'openrouter')
    },
    routing: {
      policy: core.policy,
      selected_model: null,
      selected_route: null,
      session_pin: null,
      fallback: 'none',
      blockers: [...core.policyBlockers],
      warnings: []
    },
    catalog_sync: core.catalogSync,
    capabilities: lastReport,
    readiness: {
      ready,
      state: readinessState,
      bridge_ready: bridgeReady,
      active_routes_ready: activeRoutesReady,
      combined_catalog_ready: activeCatalogReady,
      blockers: unique(activeBlockers),
      warnings: unique([...warnings, ...core.catalogSync.warnings])
    },
    recovery_actions: recoveryActions(unique(activeBlockers))
  };
  return status;
}

function providerProfileStatus(
  core: ControllerCore,
  providerId: BridgeProviderId
): BridgeProviderProfileStatus {
  const profile = core.registry.profiles[providerId];
  return {
    schema: 'sks.bridge-provider-profile-status.v1',
    provider_id: providerId,
    enabled: profile.enabled,
    credential: {
      state: profile.credential.state,
      source: profile.credential.source,
      fingerprint: profile.credential.fingerprint,
      checked_at: profile.credential.checked_at,
      blockers: [...profile.credential.blockers],
      warnings: [...profile.credential.warnings]
    },
    endpoint: {
      configured: profile.endpoint.configured,
      origin_redacted: profile.endpoint.origin_redacted,
      auth_transport: profile.endpoint.auth_transport
    },
    catalog: core.catalogSync.providers[providerId],
    capabilities: core.diagnostic?.report.providers[providerId]
      || emptyScope(`provider:${providerId}`, core.checkedAt)
  };
}

function catalogStatus(
  active: Awaited<ReturnType<typeof readActiveCombinedBridgeCatalog>>,
  registry: BridgeProviderRegistry,
  policy: BridgeRoutingPolicy | null,
  policyBlockers: readonly string[],
  checkedAt: string
): CombinedCatalogSyncStatus {
  const providerRows = Object.fromEntries((['codex-lb', 'openrouter'] as const).map((providerId) => {
    const profile = registry.profiles[providerId];
    const models = active.ok
      ? active.catalog.models.filter((model) => model.provider_id === providerId)
      : [];
    const indexed = active.ok ? active.route_index.providers[providerId] : null;
    const state: CatalogSyncState['state'] = !active.ok
      ? 'not_started'
      : !profile.enabled
        ? 'not_started'
        : indexed?.state === 'ready' && models.length > 0
          ? 'verified'
          : profile.state === 'ready'
            ? 'failed'
            : 'degraded';
    const blockers = state === 'failed'
      ? [`${providerCode(providerId)}_catalog_not_verified`]
      : state === 'degraded'
        ? [...profile.blockers]
        : [];
    const row: CatalogSyncState = {
      schema: 'sks.catalog-sync-state.v2',
      provider_id: providerId,
      state,
      source: providerId === 'codex-lb' ? 'gateway' : 'openrouter',
      generation: indexed?.catalog_generation || null,
      digest: models.length > 0 ? sha256Stable({ provider_id: providerId, models }) : null,
      model_count: models.length,
      checked_at: active.ok ? active.catalog.created_at : null,
      expires_at: null,
      blockers: unique(blockers),
      warnings: [],
      recovery_action: blockers.length > 0 ? 'retry_catalog_sync' : null
    };
    return [providerId, row];
  })) as Record<BridgeProviderId, CatalogSyncState>;
  const enabled = (['codex-lb', 'openrouter'] as const).filter((providerId) => registry.profiles[providerId].enabled);
  const verified = enabled.filter((providerId) => providerRows[providerId].state === 'verified');
  const conflicts = active.ok ? active.route_index.conflicts.length : 0;
  const generationMatches = Boolean(active.ok && policy && policy.catalog_generation === active.catalog.generation);
  const state: CombinedCatalogSyncStatus['state'] = !active.ok
    ? 'not_started'
    : conflicts > 0
      ? 'failed'
      : !generationMatches
        ? 'stale'
        : verified.length === 0
          ? 'failed'
          : verified.length < enabled.length
            ? 'degraded'
            : 'verified';
  const blockers = unique([
    ...active.blockers,
    ...policyBlockers,
    ...(conflicts > 0 ? ['catalog_model_route_ambiguous'] : []),
    ...(active.ok && !generationMatches ? ['catalog_route_index_stale'] : []),
    ...(state === 'failed' && conflicts === 0 ? enabled.flatMap((providerId) => providerRows[providerId].blockers) : [])
  ]);
  const warnings = unique(enabled
    .filter((providerId) => providerRows[providerId].state !== 'verified')
    .flatMap((providerId) => providerRows[providerId].blockers.map((item) => `provider_catalog:${providerId}:${item}`)));
  return {
    schema: 'sks.combined-catalog-sync.v1',
    state,
    generation: active.ok ? active.catalog.generation : null,
    digest: active.ok ? active.catalog.digest : null,
    model_count: active.ok ? active.catalog.models.length : null,
    route_count: active.ok ? Object.keys(active.route_index.routes).length : null,
    conflict_count: conflicts,
    checked_at: active.ok ? active.catalog.created_at : checkedAt,
    providers: providerRows,
    blockers,
    warnings,
    recovery_action: state === 'verified' ? null : conflicts > 0 ? 'resolve_catalog_route_conflict' : 'retry_catalog_sync'
  };
}

async function fetchProviderCatalogs(
  registry: BridgeProviderRegistry,
  credentials: Record<BridgeProviderId, ResolvedProviderCredential>,
  paths: ControllerPaths,
  options: DesktopBridgeControllerV3Options
): Promise<Record<BridgeProviderId, ProviderCatalogBuildInput>> {
  const checkedAt = nowIso(options);
  const expiresAt = new Date(new Date(checkedAt).getTime() + 15 * 60_000).toISOString();
  const rows = await Promise.all((['codex-lb', 'openrouter'] as const).map(async (providerId) => {
    const profile = registry.profiles[providerId];
    const credential = credentials[providerId];
    if (!profile.enabled) {
      return [providerId, emptyProviderCatalog(providerId, 'not_started', checkedAt, [])] as const;
    }
    if (!credential.secret) {
      return [providerId, emptyProviderCatalog(
        providerId,
        'failed',
        checkedAt,
        [`${providerCode(providerId)}_credential_missing`]
      )] as const;
    }
    if (providerId === 'codex-lb') {
      const loaded = await loadCodexLbEnv({
        home: paths.home,
        envPath: options.envPath || codexLbEnvPath(paths.home),
        metadataPath: options.metadataPath || codexLbMetadataPath(paths.home),
        processEnv: controllerEnv(options)
      });
      const result = await readCodexLbModelCatalog({
        loadedEnv: loaded,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        timeoutMs: timeoutMs(options),
        gatewayAuthTransport: 'authorization-bearer'
      });
      await recordProviderCredentialValidation({
        provider_id: providerId,
        credential,
        state: result.ok ? 'ready' : validationFailureState(result.blockers),
        checked_at: checkedAt,
        blockers: result.blockers,
        home: paths.home,
        validationPath: paths.validationPath
      });
      const generation = result.ok ? sha256Stable({ provider_id: providerId, models: result.models }) : null;
      return [providerId, {
        provider_id: providerId,
        state: result.ok ? 'verified' : 'failed',
        generation,
        models: { models: result.models },
        checked_at: checkedAt,
        expires_at: expiresAt,
        blockers: result.blockers,
        warnings: []
      } satisfies ProviderCatalogBuildInput] as const;
    }
    const result = await listOpenRouterModels({
      env: controllerEnv(options),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      timeoutMs: timeoutMs(options)
    });
    await recordProviderCredentialValidation({
      provider_id: providerId,
      credential,
      state: result.ok ? 'ready' : validationFailureState(result.blockers),
      checked_at: checkedAt,
      blockers: result.blockers,
      warnings: result.warnings,
      home: paths.home,
      validationPath: paths.validationPath
    });
    const generation = result.ok ? sha256Stable({ provider_id: providerId, models: result.models }) : null;
    return [providerId, {
      provider_id: providerId,
      state: result.ok ? 'verified' : 'failed',
      generation,
      models: result.models,
      checked_at: checkedAt,
      expires_at: expiresAt,
      blockers: result.blockers,
      warnings: result.warnings
    } satisfies ProviderCatalogBuildInput] as const;
  }));
  return Object.fromEntries(rows) as Record<BridgeProviderId, ProviderCatalogBuildInput>;
}

function emptyProviderCatalog(
  providerId: BridgeProviderId,
  state: ProviderCatalogBuildInput['state'],
  checkedAt: string,
  blockers: readonly string[]
): ProviderCatalogBuildInput {
  return {
    provider_id: providerId,
    state,
    generation: null,
    models: [],
    checked_at: checkedAt,
    expires_at: null,
    blockers,
    warnings: []
  };
}

async function persistRuntimeSettings(
  core: ControllerCore,
  options: DesktopBridgeControllerV3Options
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
    desktopBridgeServicePaths(core.paths.home).settings_path,
    settings
  );
  if (core.service.installed || core.service.running) {
    await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)({
      ...options,
      home: core.paths.home,
      providerRegistry: snapshot,
      routePolicy: core.policy
    });
  }
}

function providerRegistrySnapshot(
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
      catalog_generation: routeIndex.providers[providerId].catalog_generation
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

function serializedSettings(settings: DesktopBridgeServiceSettings): string {
  return `${JSON.stringify({
    schema: settings.schema,
    listen_host: settings.listen_host,
    listen_port: settings.listen_port,
    provider_registry: settings.provider_registry,
    route_policy: settings.route_policy,
    provider_session_pins: settings.provider_session_pins,
    allowed_origins: settings.allowed_origins,
    connect_timeout_ms: settings.connect_timeout_ms,
    idle_timeout_ms: settings.idle_timeout_ms
  }, null, 2)}\n`;
}

function bridgeBaseUrl(settings: DesktopBridgeServiceSettings): string {
  const host = settings.listen_host === '::1' ? '[::1]' : settings.listen_host;
  return `http://${host}:${settings.listen_port}/backend-api/codex`;
}

function nativeIdentityProbe(
  core: ControllerCore,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const oauth = core.auth.mode === 'chatgpt_oauth' || core.auth.mode === 'mixed';
  return capabilityProbeResultV3({
    ...context,
    capability: 'oauth_identity',
    scope: 'native-identity',
    stage: 'preflight',
    state: oauth ? 'verified' : 'blocked',
    terminal: !oauth,
    rootCause: oauth ? null : 'chatgpt_oauth_required_for_desktop',
    blockers: oauth ? [] : ['chatgpt_oauth_required_for_desktop'],
    retryable: false,
    recoveryAction: oauth ? null : 'review_desktop_authentication',
    source: 'config',
    evidence: {
      oauth_present: oauth,
      semantic_identity_available: Boolean(core.auth.semantic_fingerprint),
      oauth_requirement: 'required'
    }
  });
}

function combinedRoutePolicyProbe(core: ControllerCore, context: ProbeContext): CapabilityProbeResultV3 {
  const verified = Boolean(core.policy && core.activeCatalog.ok
    && core.policy.catalog_generation === core.activeCatalog.catalog.generation
    && core.policyBlockers.length === 0);
  return capabilityProbeResultV3({
    ...context,
    capability: 'route_policy',
    scope: 'catalog:combined',
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'blocked',
    terminal: !verified,
    rootCause: verified ? null : String(core.policyBlockers[0] || 'bridge_route_policy_missing'),
    blockers: verified ? [] : [...core.policyBlockers],
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      catalog_generation: core.activeCatalog.ok ? core.activeCatalog.catalog.generation : null,
      route_policy_generation: core.policy?.policy_generation || null,
      fallback: 'none'
    }
  });
}

function combinedModelRouteProbe(
  core: ControllerCore,
  status: DesktopBridgeStatusV3,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const active = activeProviderIds(core);
  const verified = active.length > 0 && active.every((providerId) =>
    Boolean(core.policy && Object.values(core.policy.model_routes).some((route) => route.provider_id === providerId)));
  return capabilityProbeResultV3({
    ...context,
    capability: 'model_route',
    scope: 'catalog:combined',
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'blocked',
    terminal: !verified,
    rootCause: verified ? null : 'catalog_model_route_missing',
    blockers: verified ? [] : ['catalog_model_route_missing'],
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      active_provider_ids: active,
      route_count: status.catalog_sync.route_count,
      fallback: 'none'
    }
  });
}

function providerCredentialProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const profile = core.registry.profiles[providerId];
  const ready = profile.credential.state === 'ready';
  const blocked = ['rejected', 'unavailable', 'stale'].includes(profile.credential.state);
  const root = blocked ? profile.credential.blockers[0] || `${providerCode(providerId)}_credential_unavailable` : null;
  return capabilityProbeResultV3({
    ...context,
    capability: 'credential',
    scope: `provider:${providerId}`,
    stage: 'preflight',
    state: ready ? 'verified' : blocked ? 'blocked' : 'not_attempted',
    terminal: blocked,
    rootCause: root,
    blockers: root ? [root] : [],
    warnings: profile.credential.warnings,
    retryable: blocked,
    recoveryAction: ready ? null : providerId === 'codex-lb' ? 'configure_codex_lb_credential' : 'configure_openrouter_credential',
    source: ready ? 'transport' : 'config',
    evidence: {
      provider_id: providerId,
      credential_state: profile.credential.state,
      credential_fingerprint: profile.credential.fingerprint,
      route: providerId
    }
  });
}

function providerAuthProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const profile = core.registry.profiles[providerId];
  const verified = profile.credential.state === 'ready' && core.catalogSync.providers[providerId].state === 'verified';
  const blocked = profile.enabled && ['rejected', 'unavailable', 'stale'].includes(profile.credential.state);
  const root = blocked ? profile.credential.blockers[0] || `${providerCode(providerId)}_auth_rejected` : null;
  return capabilityProbeResultV3({
    ...context,
    capability: 'provider_auth',
    scope: `provider:${providerId}`,
    stage: verified ? 'complete' : 'provider_auth',
    state: verified ? 'verified' : blocked ? 'blocked' : 'not_attempted',
    terminal: blocked,
    rootCause: root,
    blockers: root ? [root] : [],
    retryable: blocked,
    recoveryAction: verified ? null : providerId === 'codex-lb' ? 'configure_codex_lb_credential' : 'configure_openrouter_credential',
    source: verified || blocked ? 'transport' : 'config',
    evidence: {
      provider_id: providerId,
      auth_transport: profile.endpoint.auth_transport,
      credential_fingerprint: profile.credential.fingerprint,
      oauth_forwarded: false
    }
  });
}

function providerModelRouteProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const route = core.policy
    ? Object.entries(core.policy.model_routes).find(([, target]) => target.provider_id === providerId)
    : null;
  const verified = Boolean(route && core.catalogSync.providers[providerId].state === 'verified');
  return capabilityProbeResultV3({
    ...context,
    capability: 'model_route',
    scope: `provider:${providerId}`,
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'not_attempted',
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      provider_id: providerId,
      public_model: route?.[0] || null,
      upstream_model: route?.[1].upstream_model || null,
      catalog_generation: core.policy?.catalog_generation || null,
      fallback: 'none'
    }
  });
}

async function probeProviderText(
  core: ControllerCore,
  providerId: BridgeProviderId,
  loopbackOrigin: string | null,
  context: ProbeContext,
  options: DesktopBridgeControllerV3Options
): Promise<CapabilityProbeResultV3> {
  const route = core.policy
    ? Object.entries(core.policy.model_routes).find(([, target]) => target.provider_id === providerId)
    : null;
  if (!loopbackOrigin || !route) {
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: 'feature_request',
      state: 'not_attempted',
      retryable: true,
      recoveryAction: 'repair_bridge_service',
      source: 'transport',
      evidence: { provider_id: providerId, reason: 'bridge_or_route_unavailable' }
    });
  }
  const publicModel = route[0];
  const request = options.fetchImpl || globalThis.fetch;
  const endpoint = providerId === 'codex-lb'
    ? `${loopbackOrigin}/backend-api/codex/responses`
    : `${loopbackOrigin}/api/v1/chat/completions`;
  const body = providerId === 'codex-lb'
    ? { model: publicModel, input: 'Reply with OK.', max_output_tokens: 1, store: false }
    : {
        model: publicModel,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        provider: { allow_fallbacks: false }
      };
  try {
    const response = await request(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'app://codex',
        'x-sks-model': publicModel
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs(options))
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('provider_text_response_too_large');
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const valid = response.ok && payload !== null && typeof payload === 'object';
    const root = valid ? null : `${providerCode(providerId)}_text_response_failed`;
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: valid ? 'complete' : 'feature_response',
      state: valid ? 'verified' : 'blocked',
      terminal: !valid,
      rootCause: root,
      blockers: root ? [root] : [],
      retryable: !valid,
      recoveryAction: valid ? null : 'retry_provider_transport_probe',
      source: 'transport',
      evidence: {
        provider_id: providerId,
        public_model: publicModel,
        http_status: response.status,
        response_object: valid,
        fallback: 'none'
      }
    });
  } catch (error) {
    const root = safeCode(error, `${providerCode(providerId)}_text_response_failed`);
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: 'feature_request',
      state: 'failed',
      terminal: true,
      rootCause: root,
      blockers: [root],
      retryable: true,
      recoveryAction: 'retry_provider_transport_probe',
      source: 'transport',
      evidence: { provider_id: providerId, public_model: publicModel, fallback: 'none' }
    });
  }
}

async function probeBridgeHttp(
  loopbackOrigin: string | null,
  options: DesktopBridgeControllerV3Options
): Promise<HttpProbeResult> {
  const started = Date.now();
  if (!loopbackOrigin) return httpFailure('desktop_bridge_tcp_connect_failed', 'tcp_connect', null, started);
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(
      `${loopbackOrigin}${DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH}`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', origin: 'app://codex' },
        signal: AbortSignal.timeout(timeoutMs(options))
      }
    );
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) return httpFailure('desktop_bridge_http_health_failed', 'http_health', response.status, started);
    if (payload?.schema !== 'sks.desktop-bridge-health.v1' || payload.runtime !== 'desktop-bridge') {
      return httpFailure('desktop_bridge_http_health_invalid', 'http_health', response.status, started);
    }
    return {
      schema: 'sks.desktop-bridge-http-probe.v1',
      state: 'verified',
      terminal_stage: 'complete',
      root_cause: null,
      status_code: response.status,
      latency_ms: Date.now() - started,
      blockers: [],
      warnings: []
    };
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return httpFailure(timeout ? 'desktop_bridge_http_health_timeout' : 'desktop_bridge_tcp_connect_failed', timeout ? 'http_health' : 'tcp_connect', null, started);
  }
}

function httpFailure(
  rootCause: string,
  stage: HttpProbeResult['terminal_stage'],
  statusCode: number | null,
  started: number
): HttpProbeResult {
  return {
    schema: 'sks.desktop-bridge-http-probe.v1',
    state: 'failed',
    terminal_stage: stage,
    root_cause: rootCause,
    status_code: statusCode,
    latency_ms: Date.now() - started,
    blockers: [rootCause],
    warnings: []
  };
}

async function probeBridgeWebSocket(
  loopbackOrigin: string | null,
  level: CapabilityRequestedLevel,
  options: DesktopBridgeControllerV3Options
): Promise<WebSocketProbeResult> {
  if (!loopbackOrigin) {
    return {
      schema: 'sks.desktop-bridge-websocket-probe.v2',
      state: 'failed',
      terminal_stage: 'tcp_connect',
      root_cause: 'desktop_bridge_tcp_connect_failed',
      status_code: null,
      negotiated_protocol: null,
      upgrade_verified: false,
      protocol_verified: false,
      frame_round_trip_verified: false,
      clean_close_verified: false,
      latency_ms: null,
      blockers: ['desktop_bridge_tcp_connect_failed'],
      warnings: []
    };
  }
  const websocketOrigin = loopbackOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return probeDesktopBridgeWebSocket({
    url: `${websocketOrigin}${DESKTOP_BRIDGE_DIAGNOSTIC_PATH}`,
    origin: 'app://codex',
    requestedLevel: level,
    maxRetries: 2,
    totalTimeoutMs: timeoutMs(options)
  });
}

async function validateCodexLbCredential(
  paths: ControllerPaths,
  options: DesktopBridgeControllerV3Options
): Promise<Record<string, unknown>> {
  const loaded = await loadCodexLbEnv({
    home: paths.home,
    envPath: options.envPath || codexLbEnvPath(paths.home),
    metadataPath: options.metadataPath || codexLbMetadataPath(paths.home),
    processEnv: controllerEnv(options)
  });
  const result = await readCodexLbModelCatalog({
    loadedEnv: loaded,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    timeoutMs: timeoutMs(options),
    gatewayAuthTransport: 'authorization-bearer'
  });
  return {
    schema: 'sks.codex-lb-provider-validation.v1',
    ok: result.ok,
    authenticated: result.ok,
    model_count: result.models.length,
    http_status: result.http_status,
    blockers: result.blockers,
    warnings: []
  };
}

async function resolveRawCredentials(
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

async function resolveValidatedCredentials(
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

function controllerPaths(options: DesktopBridgeControllerV3Options): ControllerPaths {
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

function activeProviderIds(core: Pick<ControllerCore, 'policy' | 'registry'>): BridgeProviderId[] {
  if (!core.policy) return [];
  const preferred = core.policy.default_provider_id;
  if (preferred
    && core.registry.profiles[preferred].enabled
    && Object.values(core.policy.model_routes).some((route) => route.provider_id === preferred)) {
    return [preferred];
  }
  const candidates = (['codex-lb', 'openrouter'] as const).filter((providerId) =>
    core.registry.profiles[providerId].enabled
      && core.registry.profiles[providerId].state === 'ready'
      && Object.values(core.policy!.model_routes).some((route) => route.provider_id === providerId));
  return candidates.length === 1 ? candidates : [];
}

function serviceLoopbackOrigin(service: DesktopBridgeServiceStatus): string | null {
  if (service.state?.listen_origin) return service.state.listen_origin;
  const settings = service.settings;
  if (!settings) return null;
  const host = settings.listen_host === '::1' ? '[::1]' : settings.listen_host;
  return `http://${host}:${settings.listen_port}`;
}

function serviceRuntimeState(service: DesktopBridgeServiceStatus): DesktopBridgeRuntimeState {
  if (service.running && service.ok) return 'ready';
  if (service.running) return 'degraded';
  if (service.status === 'stale') return 'stale';
  if (!service.installed && !service.settings) return 'not_installed';
  if (service.blockers.length > 0) return 'blocked';
  return 'stopped';
}

function isManagedConfig(config: string): boolean {
  const top = String(config || '').split(/\n\s*\[/)[0] || '';
  return [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ].every((marker) => top.split(/\r?\n/).some((line) => line.trim() === marker))
    && /^\s*model_provider\s*=\s*"openai"\s*(?:#.*)?$/m.test(top);
}

function commandResult(
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

function emptyScope(scope: ScopeCapabilitySummary['scope'], checkedAt: string): ScopeCapabilitySummary {
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

async function writeLastDiagnostic(file: string, value: LastDiagnostic): Promise<void> {
  await writeJsonAtomic(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function readLastDiagnostic(
  file: string,
  currentCatalogGeneration: string | null
): Promise<LastDiagnostic | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.size > MAX_DIAGNOSTIC_BYTES
    || (expectedUid !== null && stat.uid !== expectedUid)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) return null;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as LastDiagnostic;
    const validation = validateDesktopCapabilityReportV3(value.report);
    if (value.schema !== LAST_DIAGNOSTIC_SCHEMA
      || !validation.ok
      || value.catalog_generation !== currentCatalogGeneration) return null;
    return value;
  } catch {
    return null;
  }
}

type OwnedFileSnapshot = { exists: boolean; text: string };

async function snapshotOwnedFile(file: string): Promise<OwnedFileSnapshot> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { exists: false, text: '' };
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (expectedUid !== null && stat.uid !== expectedUid)) {
    throw new Error('desktop_bridge_owned_file_snapshot_invalid');
  }
  return { exists: true, text: await fs.readFile(file, 'utf8') };
}

async function restoreOwnedFile(file: string, snapshot: OwnedFileSnapshot): Promise<void> {
  if (snapshot.exists) {
    await writeTextAtomic(file, snapshot.text, { mode: 0o600 });
    return;
  }
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (expectedUid !== null && stat.uid !== expectedUid)) {
    throw new Error('desktop_bridge_owned_file_restore_invalid');
  }
  await fs.unlink(file);
}

function activePointerPath(catalogPath: string): string {
  return path.join(path.dirname(catalogPath), 'sks-bridge-active-generation.json');
}

function publicValidationResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const row = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(row).filter(([key]) =>
    !/(?:api.?key|secret|token|authorization|cookie|headers?|env)/i.test(key)));
}

function validationFailureState(blockers: readonly string[]): 'rejected' | 'unavailable' {
  return blockers.some((blocker) => /(?:401|403|auth|rejected|invalid_key|unauthorized)/i.test(blocker))
    ? 'rejected'
    : 'unavailable';
}

function recoveryActions(blockers: readonly string[]): string[] {
  const actions = blockers.map((blocker) => {
    if (blocker.includes('credential') && blocker.includes('codex')) return 'configure_codex_lb_credential';
    if (blocker.includes('credential') && blocker.includes('openrouter')) return 'configure_openrouter_credential';
    if (blocker.includes('catalog') || blocker.includes('route')) return 'retry_catalog_sync';
    if (blocker.includes('oauth')) return 'review_desktop_authentication';
    if (blocker.includes('bridge')) return 'repair_bridge_service';
    return 'review_bridge_status';
  });
  return unique(actions);
}

function controllerEnv(options: DesktopBridgeControllerV3Options): NodeJS.ProcessEnv {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  return { ...process.env, ...(options.env || {}), HOME: home };
}

function timeoutMs(options: DesktopBridgeControllerV3Options): number {
  return Math.max(500, Math.min(30_000, Number(options.timeoutMs || 10_000)));
}

function nowIso(options: DesktopBridgeControllerV3Options): string {
  return (options.now ? options.now() : new Date()).toISOString();
}

function makeId(prefix: string, options: DesktopBridgeControllerV3Options): string {
  return `${prefix}-${options.id ? options.id() : randomUUID()}`;
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function safeCode(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error || '');
  return /^[a-z0-9_:/.-]{1,240}$/i.test(message) ? message : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

type ProbeContext = {
  requestedLevel: CapabilityRequestedLevel;
  checkedAt: string;
  reportId: string;
  correlationId: string;
  sessionId: string;
  attemptId: number;
};
