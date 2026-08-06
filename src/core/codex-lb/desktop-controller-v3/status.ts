import {
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
} from '../../../cli/install-helpers-codex-lb-config.js';
import type {
  BridgeProviderId,
  BridgeProviderProfileStatus,
  BridgeRoutingPolicy,
  CatalogSyncState,
  CombinedCatalogSyncStatus,
  DesktopBridgeRuntimeState,
  DesktopBridgeStatusV3
} from '../bridge-contracts.js';
import { readActiveCombinedBridgeCatalog } from '../combined-catalog.js';
import { desktopBridgeServiceStatus, type DesktopBridgeServiceStatus } from '../desktop-service.js';
import { captureCodexAuthSnapshot } from '../desktop-auth-invariant.js';
import { readText } from '../../fsx.js';
import { resolveBridgeProviderRegistry, type BridgeProviderRegistry } from '../provider-registry.js';
import {
  readBridgeRoutingPolicy,
  validateBridgeRoutingPolicy
} from '../provider-route-policy.js';
import { sha256Stable } from '../route-index.js';
import { assertDesktopBridgeStatusV3 } from '../bridge-runtime-validation.js';
import { desktopBridgeReportReadinessV3, readLastDiagnostic } from './diagnostics.js';
import {
  activeProviderIds,
  controllerPaths,
  emptyScope,
  makeId,
  providerCode,
  providerRegistrySnapshot,
  recoveryActions,
  resolveValidatedCredentials,
  serviceLoopbackOrigin,
  unique
} from './shared.js';
import type { ControllerCore, DesktopBridgeControllerV3Options } from './types.js';

export async function desktopBridgeStatusV3(
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopBridgeStatusV3> {
  const core = await loadCore(options);
  const status = statusFromCore(core, options);
  assertDesktopBridgeStatusV3(status);
  return status;
}

export async function loadCore(options: DesktopBridgeControllerV3Options): Promise<ControllerCore> {
  const paths = controllerPaths(options);
  const checkedAt = (options.now ? options.now() : new Date()).toISOString();
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
  const catalogSync = desktopBridgeCatalogStatusV3(activeCatalog, registry, policy, policyBlockers, checkedAt);
  const diagnostic = await readLastDiagnostic(
    paths.diagnosticPath,
    catalogSync.generation,
    service.state?.process_generation || null,
    service.state?.last_verified_probe_ids || []
  );
  return { paths, checkedAt, config, credentials, registry, activeCatalog, policy, policyBlockers, service, auth, catalogSync, diagnostic };
}

export function statusFromCore(
  core: ControllerCore,
  options: DesktopBridgeControllerV3Options
): DesktopBridgeStatusV3 {
  const managedConfig = isManagedConfig(core.config);
  const serviceState = serviceRuntimeState(core.service);
  const managed = managedConfig || core.service.installed || core.service.running;
  const management = managed
    ? { managed: true as const, runtime: 'desktop-bridge' as const, state: serviceState, reason: null }
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
  const reportReadiness = desktopBridgeReportReadinessV3(lastReport);
  const bridgeReady = core.service.running && reportReadiness.bridge_ready;
  const activeRoutesReady = activeCatalogReady
    && activeProviders.every((providerId) => core.registry.profiles[providerId].state === 'ready')
    && reportReadiness.active_routes_ready;
  const ready = managedConfig && bridgeReady && activeRoutesReady && oauthConfigured;
  const readinessState: DesktopBridgeStatusV3['readiness']['state'] = !managed
    ? 'unmanaged'
    : activeProviders.length === 0
      ? 'awaiting_provider'
      : ready
        ? 'ready'
        : core.service.running && activeCatalogReady ? 'degraded' : 'blocked';
  const providerSetupActions = activeProviders.length === 0
    ? ['configure_codex_lb_credential', 'configure_openrouter_credential']
    : [];
  return {
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
    recovery_actions: unique([
      ...providerSetupActions,
      ...recoveryActions(unique(activeBlockers))
    ])
  };
}

function providerProfileStatus(core: ControllerCore, providerId: BridgeProviderId): BridgeProviderProfileStatus {
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
    capabilities: core.diagnostic?.report.providers[providerId] || emptyScope(`provider:${providerId}`, core.checkedAt)
  };
}

export function desktopBridgeCatalogStatusV3(
  active: Awaited<ReturnType<typeof readActiveCombinedBridgeCatalog>>,
  registry: BridgeProviderRegistry,
  policy: BridgeRoutingPolicy | null,
  policyBlockers: readonly string[],
  checkedAt: string
): CombinedCatalogSyncStatus {
  const providerRows = Object.fromEntries((['codex-lb', 'openrouter'] as const).map((providerId) => {
    const profile = registry.profiles[providerId];
    const models = active.ok ? active.catalog.models.filter((model) => model.provider_id === providerId) : [];
    const indexed = active.ok ? active.route_index.providers[providerId] : null;
    const persisted = active.ok ? active.catalog.provider_statuses[providerId] : null;
    const expired = Boolean(persisted?.expires_at && Date.parse(persisted.expires_at) <= Date.parse(checkedAt));
    const state: CatalogSyncState['state'] = !active.ok
      ? 'not_started'
      : !profile.enabled ? 'not_started'
        : expired ? 'stale'
          : indexed?.state === 'ready' && models.length > 0
            && persisted?.state === 'verified' && persisted.generation === indexed.catalog_generation
            ? 'verified'
            : profile.state === 'ready' ? 'failed' : 'degraded';
    const blockers = state === 'stale'
      ? [`${providerCode(providerId)}_catalog_stale`]
      : state === 'failed' ? [`${providerCode(providerId)}_catalog_not_verified`]
        : state === 'degraded' ? [...profile.blockers] : [];
    const row: CatalogSyncState = {
      schema: 'sks.catalog-sync-state.v2',
      provider_id: providerId,
      state,
      source: providerId === 'codex-lb' ? 'gateway' : 'openrouter',
      generation: indexed?.catalog_generation || null,
      digest: models.length > 0 ? sha256Stable({ provider_id: providerId, models }) : null,
      model_count: models.length,
      checked_at: persisted?.checked_at || (active.ok ? active.catalog.created_at : null),
      expires_at: persisted?.expires_at || null,
      blockers: unique(blockers),
      warnings: [],
      recovery_action: blockers.length > 0 ? 'retry_catalog_sync' : null
    };
    return [providerId, row];
  })) as Record<BridgeProviderId, CatalogSyncState>;
  const enabled = (['codex-lb', 'openrouter'] as const).filter((id) => registry.profiles[id].enabled);
  const verified = enabled.filter((id) => providerRows[id].state === 'verified');
  const stale = enabled.filter((id) => providerRows[id].state === 'stale');
  const conflicts = active.ok ? active.route_index.conflicts.length : 0;
  const generationMatches = Boolean(active.ok && policy && policy.catalog_generation === active.catalog.generation);
  const state: CombinedCatalogSyncStatus['state'] = !active.ok ? 'not_started'
    : conflicts > 0 ? 'failed'
      : !generationMatches ? 'stale'
        : verified.length === 0 && stale.length > 0 ? 'stale'
          : verified.length === 0 ? 'failed'
            : verified.length < enabled.length ? 'degraded' : 'verified';
  const blockers = unique([
    ...active.blockers,
    ...policyBlockers,
    ...(conflicts > 0 ? ['catalog_model_route_ambiguous'] : []),
    ...(active.ok && !generationMatches ? ['catalog_route_index_stale'] : []),
    ...(state === 'stale' ? enabled.flatMap((id) => providerRows[id].blockers) : []),
    ...(state === 'failed' && conflicts === 0 ? enabled.flatMap((id) => providerRows[id].blockers) : [])
  ]);
  const warnings = unique(enabled.filter((id) => providerRows[id].state !== 'verified')
    .flatMap((id) => providerRows[id].blockers.map((item) => `provider_catalog:${id}:${item}`)));
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
