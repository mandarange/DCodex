import { readText, writeJsonAtomic } from '../../fsx.js';
import { readTopLevelTomlString } from '../../codex-app/codex-model-catalog.js';
import {
  BRIDGE_MODEL_SELECTION_SCHEMA,
  MAX_SELECTED_OPENROUTER_MODELS,
  bridgeAvailableModelsPath,
  pruneSelection,
  readBridgeModelSelectionState,
  type BridgeModelSelection,
  writeBridgeModelSelection
} from '../combined-catalog/model-selection.js';
import { listOpenRouterModels } from '../../providers/openrouter/openrouter-account.js';
import type { BridgeProviderId, DesktopBridgeCommandResult } from '../bridge-contracts.js';
import {
  buildCombinedBridgeCatalog,
  readActiveCombinedBridgeCatalog,
  stageCombinedBridgeCatalog,
  type CombinedCatalogStagingResult,
  type ProviderCatalogBuildInput
} from '../combined-catalog.js';
import { COMBINED_BRIDGE_CATALOG_TTL_MS } from '../combined-catalog/contracts.js';
import { codexLbEnvPath, codexLbMetadataPath, loadCodexLbEnv, readCodexLbModelCatalog } from '../codex-lb-env.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  readDesktopBridgeServiceSettings,
  resolveDesktopBridgeActivationSettings,
  resolveEffectiveOfficialModelsMode
} from '../desktop-service.js';
import { inspectHistoricalDesktopBridgeIntent, migrateDesktopBridgeConfig } from '../desktop-bridge-migration.js';
import { rollbackDesktopBridgeUnificationReceipt } from '../migration-receipt.js';
import {
  recordProviderCredentialValidation,
  type ResolvedProviderCredential
} from '../provider-credentials.js';
import {
  bridgeProviderRegistryPath,
  buildStoredBridgeProviderRegistry,
  loadStoredBridgeProviderRegistry,
  resolveBridgeProviderRegistry,
  serializeStoredBridgeProviderRegistry,
  type BridgeProviderRegistry
} from '../provider-registry.js';
import { applyOfficialModelPassthrough, buildBridgeRoutingPolicy, readBridgeRoutingPolicy } from '../provider-route-policy.js';
import { sha256Stable } from '../route-index.js';
import {
  bridgeBaseUrl,
  commandResult,
  controllerEnv,
  controllerPaths,
  nowIso,
  providerCode,
  providerRegistrySnapshot,
  resolveRawCredentials,
  resolveValidatedCredentials,
  safeCode,
  serializedSettings,
  stringArray,
  timeoutMs,
  unique
} from './shared.js';
import { desktopBridgeStatusV3 } from './status.js';
import type { ControllerPaths, DesktopBridgeControllerV3Options } from './types.js';

export async function syncCatalog(options: DesktopBridgeControllerV3Options): Promise<DesktopBridgeCommandResult> {
  const result = await syncCatalogInternal(options);
  const status = await desktopBridgeStatusV3(options);
  const activation = result.activation && typeof result.activation === 'object'
    ? result.activation as Record<string, unknown>
    : {};
  return commandResult(
    'catalog.sync',
    result.ok === true,
    status,
    { catalog_sync: result },
    result.ok === true ? [] : stringArray(activation.blockers),
    options
  );
}

export async function syncCatalogInternal(
  options: DesktopBridgeControllerV3Options
): Promise<Record<string, unknown>> {
  const paths = controllerPaths(options);
  const historicalIntent = inspectHistoricalDesktopBridgeIntent(await readText(paths.configPath, ''));
  if (historicalIntent.blockers.length > 0) return blockedSync(historicalIntent, historicalIntent.blockers);
  const rawCredentials = await resolveRawCredentials(options, paths);
  const storedRegistryRead = await loadStoredBridgeProviderRegistry({ home: paths.home });
  if (storedRegistryRead.blockers.length > 0) return blockedSync(historicalIntent, storedRegistryRead.blockers);
  const storedRegistry = storedRegistryRead.registry || buildStoredBridgeProviderRegistry({
    credentials: rawCredentials,
    overrides: historicalIntent.providers
  });
  const initialRegistry = await resolveBridgeProviderRegistry({
    home: paths.home,
    credentials: rawCredentials,
    storedRegistry
  });
  const catalogs = await fetchProviderCatalogs(initialRegistry, rawCredentials, paths, options);
  const credentials = await resolveValidatedCredentials(options, paths);
  const registry = await resolveBridgeProviderRegistry({ home: paths.home, credentials, storedRegistry });
  const selectionState = await readBridgeModelSelectionState(paths.home, nowIso(options));
  // First curation run: keep whatever OpenRouter model the operator is already
  // configured to use, so enabling curation never removes the active model.
  const selection = selectionState.stored
    ? selectionState.selection
    : seedSelectionFromConfiguredModel(selectionState.selection, await readText(paths.configPath, ''));
  const build = buildCombinedBridgeCatalog(registry, { catalogs, created_at: nowIso(options), selection });
  if (!selectionState.stored) await writeBridgeModelSelection(paths.home, selection).catch(() => undefined);
  // The available list is what SKS Center offers for curation; persisting it on
  // every sync keeps the picker choices in step with what OpenRouter serves.
  await writeJsonAtomic(bridgeAvailableModelsPath(paths.home), {
    schema: 'sks.bridge-available-models.v1',
    updated_at: nowIso(options),
    openrouter: build.available_openrouter_models
  }, { mode: 0o600 }).catch(() => undefined);
  const pruned = pruneSelection(selection, build.available_openrouter_models);
  if (pruned !== selection) await writeBridgeModelSelection(paths.home, pruned).catch(() => undefined);
  const staging = await stageCombinedBridgeCatalog({
    build,
    catalogPath: paths.catalogPath,
    routeIndexPath: paths.routeIndexPath
  });
  if (!staging.staged || !staging.catalog_path || !staging.pointer_text) {
    return { ok: false, build, activation: activationResult(staging, false), migration: null };
  }
  const priorPolicy = await readBridgeRoutingPolicy(paths.routePolicyPath);
  const readyProviders = (['codex-lb', 'openrouter'] as const).filter((providerId) =>
    registry.profiles[providerId].enabled
      && registry.profiles[providerId].state === 'ready'
      && Object.values(build.route_index.routes).some((route) => route.provider_id === providerId));
  const previousDefault = priorPolicy.policy?.default_provider_id || null;
  const historicalDefault = historicalIntent.default_provider_id;
  const defaultProvider = previousDefault && readyProviders.includes(previousDefault)
    ? previousDefault
    : historicalDefault && readyProviders.includes(historicalDefault) ? historicalDefault
      : readyProviders.length === 1 ? readyProviders[0] || null : null;
  // The official-models mode is resolved from the operator's durable choice
  // (settings.official_passthrough.models), with 'auto' following the host
  // auth mode — so a catalog refresh can neither silently return a
  // ChatGPT-OAuth operator's models to the gateway identity (the swap that
  // broke Codex Apps connector links and conversation affinity) nor flip a
  // deliberate gateway operator onto passthrough.
  const persistedSettings = await readDesktopBridgeServiceSettings(
    desktopBridgeServicePaths(paths.home).settings_path,
  ).catch(() => null);
  const officialModelsMode = await resolveEffectiveOfficialModelsMode(
    persistedSettings?.official_passthrough,
    {
      home: paths.home,
      authPath: paths.authPath,
      // Registering + enabling codex-lb IS the operator choosing the gateway;
      // un-registering converges a ChatGPT-OAuth host back onto its identity.
      codexLbRegistered: registry.profiles['codex-lb'].enabled && registry.profiles['codex-lb'].state === 'ready',
    },
  );
  const policy = applyOfficialModelPassthrough(buildBridgeRoutingPolicy({
    route_index: build.route_index,
    catalog_generation: build.catalog.generation,
    default_provider_id: defaultProvider,
    changed_at: nowIso(options)
  }), { mode: officialModelsMode, changedAt: nowIso(options) });
  let settings: Awaited<ReturnType<typeof resolveDesktopBridgeActivationSettings>>;
  let managedBridgeBaseUrl: string;
  try {
    settings = await resolveDesktopBridgeActivationSettings({
      ...options,
      home: paths.home,
      providerRegistry: providerRegistrySnapshot(registry, build.route_index),
      routePolicy: policy
    });
    managedBridgeBaseUrl = await bridgeBaseUrl(settings, { ...options, home: paths.home });
  } catch (error: unknown) {
    const blocker = safeCode(error, 'desktop_bridge_client_capability_invalid');
    return {
      ok: false,
      build,
      activation: activationResult(staging, false, [blocker]),
      migration: null,
      active_generation_preserved: true
    };
  }
  const migration = await migrateDesktopBridgeConfig({
    home: paths.home,
    configPath: paths.configPath,
    authPath: paths.authPath,
    receiptDir: paths.receiptDir,
    bridgeBaseUrl: managedBridgeBaseUrl,
    combinedCatalogPath: staging.catalog_path,
    newCatalogGeneration: build.catalog.generation,
    metadataUpdates: [
      {
        kind: 'provider_registry',
        path: bridgeProviderRegistryPath(paths.home),
        text: serializeStoredBridgeProviderRegistry(storedRegistry)
      },
      { kind: 'catalog_binding', path: staging.pointer_path, text: staging.pointer_text },
      { kind: 'route_policy', path: paths.routePolicyPath, text: `${JSON.stringify(policy, null, 2)}\n` },
      { kind: 'bridge_settings', path: desktopBridgeServicePaths(paths.home).settings_path, text: serializedSettings(settings) }
    ]
  });
  if (!migration.ok) {
    return {
      ok: false,
      build,
      activation: activationResult(staging, false, migration.blockers),
      migration,
      active_generation_preserved: true
    };
  }
  const active = await readActiveCombinedBridgeCatalog(paths.catalogPath, paths.routeIndexPath);
  if (!active.ok
    || active.catalog.generation !== build.catalog.generation
    || active.route_index.generation !== build.route_index.generation) {
    const rollback = migration.receipt
      ? await rollbackDesktopBridgeUnificationReceipt({ receipt: migration.receipt })
      : null;
    return {
      ok: false,
      build,
      activation: activationResult(staging, false, ['combined_catalog_activation_verification_failed']),
      migration,
      rollback,
      active_generation_preserved: rollback?.ok === true
    };
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
  return { ok: true, build, activation: activationResult(staging, true), migration };
}

function blockedSync(historicalIntent: unknown, blockers: readonly string[]): Record<string, unknown> {
  return {
    ok: false,
    historical_intent: historicalIntent,
    activation: {
      schema: 'sks.bridge-combined-catalog-activation.v1',
      activated: false,
      blockers
    },
    migration: null
  };
}

function activationResult(
  staging: CombinedCatalogStagingResult,
  activated: boolean,
  blockers: readonly string[] = staging.blockers
): Record<string, unknown> {
  return {
    schema: 'sks.bridge-combined-catalog-activation.v1',
    activated,
    generation: activated ? staging.generation : null,
    previous_generation: staging.previous_generation,
    catalog_path: activated ? staging.catalog_path : null,
    route_index_path: activated ? staging.route_index_path : null,
    pointer_path: staging.pointer_path,
    blockers: unique(blockers)
  };
}

async function fetchProviderCatalogs(
  registry: BridgeProviderRegistry,
  credentials: Record<BridgeProviderId, ResolvedProviderCredential>,
  paths: ControllerPaths,
  options: DesktopBridgeControllerV3Options
): Promise<Record<BridgeProviderId, ProviderCatalogBuildInput>> {
  const checkedAt = nowIso(options);
  const expiresAt = new Date(new Date(checkedAt).getTime() + COMBINED_BRIDGE_CATALOG_TTL_MS).toISOString();
  const rows = await Promise.all((['codex-lb', 'openrouter'] as const).map(async (providerId) => {
    const profile = registry.profiles[providerId];
    const credential = credentials[providerId];
    if (!profile.enabled) return [providerId, emptyProviderCatalog(providerId, 'not_started', checkedAt, [])] as const;
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
        ...(options.codexLbLookup ? { lookup: options.codexLbLookup } : {}),
        timeoutMs: timeoutMs(options),
        gatewayAuthTransport: profile.endpoint.auth_transport === 'x-codex-lb-api-key'
          ? 'x-codex-lb-api-key' : 'authorization-bearer'
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
      // Feed the full upstream ModelInfo rows when the gateway returned them so
      // reasoning levels, service tiers, and tool mode survive into the catalog.
      const codexLbModels = result.model_rows.length > 0 ? result.model_rows : result.models;
      return [providerId, {
        provider_id: providerId,
        state: result.ok ? 'verified' : 'failed',
        generation: result.ok ? sha256Stable({ provider_id: providerId, models: codexLbModels }) : null,
        models: { models: codexLbModels },
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
    return [providerId, {
      provider_id: providerId,
      state: result.ok ? 'verified' : 'failed',
      generation: result.ok ? sha256Stable({ provider_id: providerId, models: result.models }) : null,
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

function validationFailureState(blockers: readonly string[]): 'rejected' | 'unavailable' {
  return blockers.some((blocker) => /(?:401|403|auth|rejected|invalid_key|unauthorized)/i.test(blocker))
    ? 'rejected' : 'unavailable';
}

/** Read-only view of every OpenRouter model plus the operator's current picks. */
export async function listSelectableModels(
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const selection = (await readBridgeModelSelectionState(paths.home, nowIso(options))).selection;
  const available = await readText(bridgeAvailableModelsPath(paths.home), '');
  let rows: unknown[] = [];
  try {
    const parsed = available ? JSON.parse(available) : null;
    if (parsed && Array.isArray(parsed.openrouter)) rows = parsed.openrouter;
  } catch { rows = []; }
  const selected = new Set(selection.openrouter.public_ids);
  const status = await desktopBridgeStatusV3(options);
  return commandResult('models.list', true, status, {
    codex_lb_exposure: 'all',
    openrouter: {
      mode: 'selected',
      selected_count: selection.openrouter.public_ids.length,
      max_selected: MAX_SELECTED_OPENROUTER_MODELS,
      available_count: rows.length,
      models: rows.map((row: any) => ({
        public_id: String(row?.public_id || ''),
        display_name: String(row?.display_name || row?.public_id || ''),
        selected: selected.has(String(row?.public_id || ''))
      })).filter((row) => row.public_id)
    }
  }, rows.length === 0 ? ['bridge_available_models_unknown'] : [], options);
}

/**
 * Replaces the OpenRouter selection and rebuilds the active catalog so the
 * Codex Desktop picker reflects the choice on its next read. codex-lb models
 * are never filtered.
 */
export async function selectExposedModels(
  publicIds: readonly string[],
  options: DesktopBridgeControllerV3Options
): Promise<DesktopBridgeCommandResult> {
  const paths = controllerPaths(options);
  const requested = [...new Set(publicIds.map((id) => String(id || '').trim()).filter(Boolean))].sort();
  if (requested.length > MAX_SELECTED_OPENROUTER_MODELS) {
    throw new Error('bridge_model_selection_limit_exceeded');
  }
  await writeBridgeModelSelection(paths.home, {
    schema: BRIDGE_MODEL_SELECTION_SCHEMA,
    updated_at: nowIso(options),
    openrouter: { mode: 'selected', public_ids: requested }
  });
  const sync = await syncCatalogInternal(options);
  const status = await desktopBridgeStatusV3(options);
  const activation = sync.activation && typeof sync.activation === 'object'
    ? sync.activation as Record<string, unknown>
    : {};
  return commandResult(
    'models.select',
    sync.ok === true,
    status,
    { selected_count: requested.length, catalog_sync: sync },
    sync.ok === true ? [] : stringArray(activation.blockers),
    options
  );
}

/** An OpenRouter public id always carries a vendor prefix (`vendor/model`). */
function seedSelectionFromConfiguredModel(
  selection: BridgeModelSelection,
  configText: string
): BridgeModelSelection {
  const configured = readTopLevelTomlString(configText, 'model');
  if (!configured || !configured.includes('/')) return selection;
  return { ...selection, openrouter: { mode: 'selected', public_ids: [configured] } };
}
