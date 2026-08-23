import path from 'node:path';
import { removeDesktopBridgeManagedConfig } from '../../../cli/install-helpers-codex-lb-config.js';
import { safeWriteCodexConfigToml } from '../../codex-runtime/codex-desktop-config-policy.js';
import { exists, readText } from '../../fsx.js';
import type { BridgeProviderId, DesktopBridgeCommandResult, DesktopCapabilityReportV3 } from '../bridge-contracts.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  installAndStartDesktopBridgeService,
  readDesktopBridgeServiceSettings,
  resolveEffectiveOfficialModelsMode,
  stopDesktopBridgeService,
  type DesktopBridgeServiceStatus
} from '../desktop-service.js';
import { rollbackDesktopBridgeUnificationReceipt } from '../migration-receipt.js';
import { DESKTOP_BRIDGE_OFFICIAL_UPSTREAM_BASE_URL } from '../desktop-bridge/index.js';
import { resolveBridgeRequestRoute } from '../request-route-resolver.js';
import { applyOfficialModelPassthrough, buildBridgeRoutingPolicy, setBridgeRoutingDefault, writeBridgeRoutingPolicy } from '../provider-route-policy.js';
import { syncCatalogInternal } from './catalog.js';
import {
  commandResult,
  controllerPaths,
  nowIso,
  persistRuntimeSettings,
  providerCode,
  providerRegistrySnapshot,
  stringArray
} from './shared.js';
import { desktopBridgeStatusV3, loadCore, statusFromCore } from './status.js';
import type { DesktopBridgeControllerV3Options } from './types.js';
import { verifyDesktopBridgeV3 } from './verification.js';

export async function ensureDesktopBridge(
  options: DesktopBridgeControllerV3Options,
  operation: 'ensure' | 'repair'
): Promise<DesktopBridgeCommandResult> {
  const sync = await syncCatalogInternal(options);
  let core = await loadCore(options);
  if (!core.activeCatalog.ok || !core.policy) {
    return commandResult(operation, true, statusFromCore(core, options), { catalog_sync: sync }, syncResultBlockers(sync), options);
  }
  const service = await (options.installServiceImpl || installAndStartDesktopBridgeService)({
    ...options,
    home: core.paths.home,
    providerRegistry: providerRegistrySnapshot(core.registry, core.activeCatalog.route_index),
    routePolicy: core.policy
  });
  core = await loadCore(options);
  let report: DesktopCapabilityReportV3 | null = null;
  if (service.running) report = await verifyDesktopBridgeV3('shallow', options);
  const status = await desktopBridgeStatusV3(options);
  const outcome = desktopBridgeServiceCommandOutcome(service);
  return commandResult(operation, outcome.ok, status, { service, catalog_sync: sync, capabilities: report }, outcome.blockers, options);
}

export async function repairDesktopBridge(
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
  const outcome = desktopBridgeServiceCommandOutcome(service);
  return commandResult('repair', outcome.ok, status, { service, capabilities: report }, outcome.blockers, options);
}

export function desktopBridgeServiceCommandOutcome(
  service: Pick<DesktopBridgeServiceStatus, 'ok' | 'running' | 'blockers'>
): { ok: boolean; blockers: string[] } {
  const blockers = [...new Set(stringArray(service.blockers))];
  const ok = service.ok && service.running && blockers.length === 0;
  return {
    ok,
    blockers: ok ? [] : blockers.length > 0 ? blockers : ['desktop_bridge_service_not_running']
  };
}

export async function setDefaultProvider(
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
  await persistRuntimeSettings({ ...core, policy, policyBlockers: [] }, options);
  const status = await desktopBridgeStatusV3(options);
  return commandResult(
    'route.set-default',
    true,
    status,
    { provider_id: providerId, policy_generation: policy.policy_generation },
    [],
    options
  );
}

/**
 * Set the operator's DURABLE official-models routing choice and apply it now.
 * `passthrough` sends bare official-family turns to the official upstream with
 * the operator's own ChatGPT identity — the identity Codex Apps connector
 * links, conversation affinity, and plan quotas bind to; provider-prefixed
 * picks keep their gateway route. `gateway` rebuilds every route from the
 * active catalog's route index and PINS that choice: no update, sync, or
 * bridge restart will ever flip a deliberate gateway operator. `auto` (the
 * default) follows the host auth mode and is re-resolved on every bridge
 * start and catalog sync, so `sks update` converges without a manual flip.
 */
export async function setOfficialModelsMode(
  mode: 'passthrough' | 'gateway' | 'auto',
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const core = await loadCore(options);
  if (!core.policy || !core.activeCatalog.ok) throw new Error('bridge_route_policy_missing');
  const settingsPath = options.settingsPath || desktopBridgeServicePaths(core.paths.home).settings_path;
  const persisted = await readDesktopBridgeServiceSettings(settingsPath).catch(() => null);
  const nextOfficial = {
    enabled: persisted?.official_passthrough?.enabled ?? true,
    base_url: persisted?.official_passthrough?.base_url || DESKTOP_BRIDGE_OFFICIAL_UPSTREAM_BASE_URL,
    models: mode,
  };
  const effective = mode === 'auto'
    ? await resolveEffectiveOfficialModelsMode(nextOfficial, {
      home: core.paths.home,
      codexLbRegistered: core.registry.profiles['codex-lb'].enabled && core.registry.profiles['codex-lb'].state === 'ready',
    })
    : mode;
  const policy = effective === 'passthrough'
    ? applyOfficialModelPassthrough(core.policy, { mode: 'passthrough', changedAt: nowIso(options) })
    : buildBridgeRoutingPolicy({
      route_index: core.activeCatalog.route_index,
      catalog_generation: core.policy.catalog_generation,
      default_provider_id: core.policy.default_provider_id,
      changed_at: nowIso(options)
    });
  await writeBridgeRoutingPolicy(core.paths.routePolicyPath, policy, core.activeCatalog.route_index);
  await persistRuntimeSettings({ ...core, policy, policyBlockers: [] }, {
    ...options,
    settings: { ...(options.settings || {}), official_passthrough: nextOfficial },
  });
  const status = await desktopBridgeStatusV3(options);
  const officialModels = Object.entries(policy.model_routes)
    .filter(([, route]) => route.provider_id === 'openai')
    .map(([model]) => model);
  return commandResult(
    'route.official-models',
    true,
    status,
    { mode, effective_mode: effective, official_models: officialModels, policy_generation: policy.policy_generation },
    [],
    options
  );
}

export async function explainRoute(
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
  return commandResult('route.explain', true, statusFromCore(core, options), { explanation }, [], options);
}

export async function unmanageDesktopBridge(
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const current = await readText(paths.configPath, '');
  const next = removeDesktopBridgeManagedConfig(current);
  const serviceBefore = await currentServiceStatus(options, paths.home);
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home: paths.home
  });
  requireStopped(stopped, 'unmanage');
  let write: Awaited<ReturnType<typeof safeWriteCodexConfigToml>>;
  try {
    write = await (options.safeWriteConfigImpl || safeWriteCodexConfigToml)(
      paths.configPath,
      current,
      next,
      'desktop-bridge-unmanage',
      { verifyUnchangedBeforeWrite: true }
    );
  } catch (error: unknown) {
    await restartPreservedService(serviceBefore, error, options, paths.home);
    throw error;
  }
  if (!write.ok) {
    const error = new Error(`desktop_bridge_unmanage_config_${write.status}`);
    const recovery = await restartPreservedService(serviceBefore, error, options, paths.home);
    const status = await desktopBridgeStatusV3(options);
    return commandResult(
      'unmanage',
      false,
      status,
      { write, service: stopped, recovery },
      [error.message],
      options
    );
  }
  const cleaned = await removePreservedServiceArtifacts(options, paths.home, 'unmanage');
  const status = await desktopBridgeStatusV3(options);
  requireUnmanaged(status.management.managed, 'unmanage');
  return commandResult('unmanage', true, status, {
    unmanaged: true,
    credentials_deleted: false,
    service: cleaned,
    stopped_service: stopped,
    config_backup_path: write.backup_path || null
  }, [], options);
}

export async function rollbackDesktopBridge(
  receiptId: string,
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(receiptId)) throw new Error('desktop_bridge_receipt_id_invalid');
  const paths = controllerPaths(options);
  const receiptPath = path.resolve(paths.receiptDir, `${receiptId.replace(/\.json$/i, '')}.json`);
  if (!receiptPath.startsWith(`${path.resolve(paths.receiptDir)}${path.sep}`)) {
    throw new Error('desktop_bridge_receipt_path_invalid');
  }
  const serviceBefore = await currentServiceStatus(options, paths.home);
  const stopped = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home: paths.home
  });
  requireStopped(stopped, 'rollback');
  let rollback: Awaited<ReturnType<typeof rollbackDesktopBridgeUnificationReceipt>>;
  try {
    rollback = await (options.rollbackReceiptImpl || rollbackDesktopBridgeUnificationReceipt)({ receiptPath });
  } catch (error: unknown) {
    await restartPreservedService(serviceBefore, error, options, paths.home);
    throw error;
  }
  if (!rollback.ok) {
    const error = new Error(`desktop_bridge_rollback_${rollback.status}`);
    const recovery = await restartPreservedService(serviceBefore, error, options, paths.home);
    const status = await desktopBridgeStatusV3(options);
    return commandResult(
      'rollback',
      false,
      status,
      { rollback, service: stopped, recovery },
      [rollback.status],
      options
    );
  }
  const cleaned = await removePreservedServiceArtifacts(options, paths.home, 'rollback');
  const observed = await desktopBridgeStatusV3(options);
  if (observed.management.managed) throw new Error('desktop_bridge_rollback_final_state_managed');
  const status = {
    ...observed,
    management: {
      ...observed.management,
      reason: 'rollback_complete' as const
    }
  };
  return commandResult(
    'rollback',
    true,
    status,
    { rollback, service: cleaned, stopped_service: stopped },
    [],
    options
  );
}

async function currentServiceStatus(
  options: DesktopBridgeControllerV3Options,
  home: string
): Promise<DesktopBridgeServiceStatus> {
  return (options.serviceStatusImpl || desktopBridgeServiceStatus)({ ...options, home });
}

function requireStopped(service: DesktopBridgeServiceStatus, operation: 'unmanage' | 'rollback'): void {
  if (service.running) throw new Error(`desktop_bridge_${operation}_service_stop_failed`);
}

async function removePreservedServiceArtifacts(
  options: DesktopBridgeControllerV3Options,
  home: string,
  operation: 'unmanage' | 'rollback'
): Promise<DesktopBridgeServiceStatus> {
  const cleaned = await (options.stopServiceImpl || stopDesktopBridgeService)({
    ...options,
    home,
    removePlist: true,
    removeSettings: true
  });
  const artifactsRemain = await Promise.all([
    exists(cleaned.paths.launch_agent_path),
    exists(cleaned.paths.settings_path)
  ]);
  if (cleaned.running || cleaned.installed || cleaned.settings || artifactsRemain.some(Boolean)) {
    throw new Error(`desktop_bridge_${operation}_service_cleanup_failed`);
  }
  return cleaned;
}

async function restartPreservedService(
  serviceBefore: DesktopBridgeServiceStatus,
  originalError: unknown,
  options: DesktopBridgeControllerV3Options,
  home: string
): Promise<DesktopBridgeServiceStatus | null> {
  if (!serviceBefore.running) return null;
  try {
    const recovery = await (options.bootstrapServiceImpl || bootstrapExistingDesktopBridgeService)({
      ...options,
      home
    });
    if (!recovery.running) {
      throw new Error(`desktop_bridge_lifecycle_recovery_not_running:${recovery.blockers.join(',')}`);
    }
    return recovery;
  } catch (recoveryError: unknown) {
    const message = originalError instanceof Error ? originalError.message : String(originalError || 'desktop_bridge_lifecycle_failed');
    throw new Error(message, { cause: recoveryError });
  }
}

function requireUnmanaged(managed: boolean, operation: 'unmanage' | 'rollback'): void {
  if (managed) throw new Error(`desktop_bridge_${operation}_final_state_managed`);
}

function syncResultBlockers(result: Record<string, unknown>): string[] {
  if (result.ok === true) return [];
  const activation = result.activation && typeof result.activation === 'object' && !Array.isArray(result.activation)
    ? result.activation as Record<string, unknown>
    : {};
  const blockers = stringArray(activation.blockers);
  return blockers.length > 0 ? blockers : ['combined_catalog_sync_failed'];
}
