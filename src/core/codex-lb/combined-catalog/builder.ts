import type { CombinedCatalogSyncStatus } from '../bridge-contracts.js';
import type { BridgeProviderRegistry } from '../provider-registry.js';
import { buildBridgeRouteIndex, sha256Stable } from '../route-index.js';
import {
  COMBINED_BRIDGE_CATALOG_SCHEMA,
  type CombinedBridgeCatalogArtifact,
  type CombinedCatalogBuildResult,
  type ProviderCatalogBuildInput
} from './contracts.js';
import {
  normalizeProviderCatalog,
  providerCatalogStatus,
  routeProviderState
} from './normalize.js';
import { compareModels, unique } from './shared.js';
import {
  applyBridgeModelSelection,
  availableModelRows,
  emptyBridgeModelSelection,
  type AvailableBridgeModelRow,
  type BridgeModelSelection
} from './model-selection.js';

export function buildCombinedBridgeCatalog(
  registry: BridgeProviderRegistry,
  options: {
    readonly catalogs: Record<'codex-lb' | 'openrouter', ProviderCatalogBuildInput>;
    readonly created_at?: string;
    /**
     * Curated OpenRouter picks. Omitting it exposes every model: curation is
     * opt-in and only the desktop-controller sync path supplies a selection,
     * so callers that never curate keep the full catalog.
     */
    readonly selection?: BridgeModelSelection;
  }
): CombinedCatalogBuildResult & { readonly available_openrouter_models: AvailableBridgeModelRow[] } {
  const createdAt = options.created_at || new Date().toISOString();
  const normalized = {
    'codex-lb': normalizeProviderCatalog(options.catalogs['codex-lb']),
    openrouter: normalizeProviderCatalog(options.catalogs.openrouter)
  };
  const selection = options.selection || emptyBridgeModelSelection(createdAt);
  const allModels = [...normalized['codex-lb'].models, ...normalized.openrouter.models]
    .sort(compareModels);
  const availableOpenRouterModels = availableModelRows(allModels, selection);
  // The active catalog is what Codex Desktop reads, so it carries every
  // codex-lb model plus only the OpenRouter models the operator selected.
  const models = options.selection ? applyBridgeModelSelection(allModels, selection) : allModels;
  const routeBuild = buildBridgeRouteIndex({
    models,
    providers: {
      'codex-lb': {
        catalog_generation: options.catalogs['codex-lb'].generation,
        credential_fingerprint: registry.profiles['codex-lb'].credential.fingerprint,
        state: routeProviderState(registry, options.catalogs['codex-lb'])
      },
      openrouter: {
        catalog_generation: options.catalogs.openrouter.generation,
        credential_fingerprint: registry.profiles.openrouter.credential.fingerprint,
        state: routeProviderState(registry, options.catalogs.openrouter)
      }
    },
    created_at: createdAt
  });
  const providerStatuses = {
    'codex-lb': providerCatalogStatus(options.catalogs['codex-lb'], normalized['codex-lb']),
    openrouter: providerCatalogStatus(options.catalogs.openrouter, normalized.openrouter)
  };
  const digest = sha256Stable({ models });
  const catalog: CombinedBridgeCatalogArtifact = {
    schema: COMBINED_BRIDGE_CATALOG_SCHEMA,
    generation: digest,
    created_at: createdAt,
    digest,
    models,
    provider_statuses: providerStatuses
  };
  const blockers = unique([
    ...normalized['codex-lb'].blockers,
    ...normalized.openrouter.blockers,
    ...routeBuild.blockers
  ]);
  const enabledProviders = (['codex-lb', 'openrouter'] as const)
    .filter((providerId) => registry.profiles[providerId].enabled);
  const enabledReadyCount = enabledProviders.filter((providerId) =>
    normalized[providerId].state === 'verified' && normalized[providerId].models.length > 0).length;
  const conflicts = routeBuild.conflict_count;
  const state: CombinedCatalogSyncStatus['state'] = conflicts > 0 || enabledReadyCount === 0
    ? 'failed'
    : blockers.length > 0 || enabledReadyCount < enabledProviders.length
      ? 'degraded'
      : 'verified';
  const status: CombinedCatalogSyncStatus = {
    schema: 'sks.combined-catalog-sync.v1',
    state,
    generation: state === 'failed' ? null : catalog.generation,
    digest: state === 'failed' ? null : catalog.digest,
    model_count: models.length,
    route_count: routeBuild.route_count,
    conflict_count: conflicts,
    checked_at: createdAt,
    providers: providerStatuses,
    blockers,
    warnings: unique([
      ...normalized['codex-lb'].warnings,
      ...normalized.openrouter.warnings
    ]),
    recovery_action: conflicts > 0
      ? 'resolve_catalog_route_conflict'
      : state === 'failed'
        ? 'retry_catalog_sync'
        : null
  };
  return {
    schema: 'sks.bridge-combined-catalog-build.v1',
    ok: state !== 'failed',
    catalog,
    route_index: routeBuild.route_index,
    status,
    blockers,
    warnings: status.warnings,
    available_openrouter_models: availableOpenRouterModels
  };
}
