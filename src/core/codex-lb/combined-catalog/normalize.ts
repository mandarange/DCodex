import type { BridgeCatalogModel, BridgeProviderId, CatalogSyncState } from '../bridge-contracts.js';
import { normalizeCodexLbBridgeCatalogModels } from '../codex-lb-tool-catalog.js';
import type { BridgeProviderRegistry } from '../provider-registry.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  sha256Stable
} from '../route-index.js';
import type { ProviderCatalogBuildInput } from './contracts.js';
import { unique } from './shared.js';

export interface NormalizedProviderCatalog {
  readonly state: CatalogSyncState['state'];
  readonly models: BridgeCatalogModel[];
  readonly blockers: string[];
  readonly warnings: string[];
}

export function normalizeProviderCatalog(input: ProviderCatalogBuildInput): NormalizedProviderCatalog {
  if (input.state !== 'verified') {
    return {
      state: input.state,
      models: [],
      blockers: unique([
        ...(input.blockers || []),
        ...(input.state === 'not_started' ? [] : [`${providerCode(input.provider_id)}_catalog_not_verified`])
      ]),
      warnings: unique(input.warnings || [])
    };
  }
  if (input.provider_id === 'codex-lb') {
    const normalized = normalizeCodexLbBridgeCatalogModels(
      normalizeCodexLbCatalogRows(input.models),
      input.generation || 'unknown'
    );
    return {
      state: input.state,
      models: normalized.models.map(canonicalModel).filter(isModel),
      blockers: unique([...(input.blockers || []), ...normalized.blockers]),
      warnings: unique(input.warnings || [])
    };
  }
  const rows = catalogRows(input.models);
  const blockers = [...(input.blockers || [])];
  const models = rows.map((row: any) => {
    const sourceId = row?.id || row?.model || row?.slug || row?.name;
    const publicId = canonicalizeBridgeModelId(sourceId);
    const upstreamModel = normalizeBridgeUpstreamModelId(sourceId);
    if (!publicId || !upstreamModel) return null;
    const features = row?.features && typeof row.features === 'object' ? row.features : {};
    const capabilities = [
      ...(features.tools === true ? ['tools'] : []),
      ...(features.reasoning === true ? ['reasoning'] : []),
      ...(features.vision === true ? ['vision'] : []),
      ...(features.audio === true ? ['audio'] : [])
    ];
    return canonicalModel({
      public_id: publicId,
      provider_id: 'openrouter',
      upstream_model: upstreamModel,
      display_name: String(row?.name || publicId).trim(),
      supported_in_api: row?.supported_in_api !== false,
      capabilities,
      source_catalog_generation: input.generation || 'unknown',
      route_key: `openrouter:${publicId}`
    });
  }).filter(isModel);
  if (models.length === 0) blockers.push('openrouter_model_catalog_empty');
  return {
    state: input.state,
    models,
    blockers: unique(blockers),
    warnings: unique(input.warnings || [])
  };
}

export function routeProviderState(
  registry: BridgeProviderRegistry,
  catalog: ProviderCatalogBuildInput
): string {
  const profile = registry.profiles[catalog.provider_id];
  return profile.state === 'ready' && catalog.state === 'verified' ? 'ready' : catalog.state;
}

export function providerCatalogStatus(
  input: ProviderCatalogBuildInput,
  normalized: NormalizedProviderCatalog
): CatalogSyncState {
  const semantic = { provider_id: input.provider_id, models: normalized.models };
  return {
    schema: 'sks.catalog-sync-state.v2',
    provider_id: input.provider_id,
    state: input.state,
    source: input.provider_id === 'codex-lb' ? 'gateway' : 'openrouter',
    generation: input.generation,
    digest: normalized.models.length > 0 ? sha256Stable(semantic) : null,
    model_count: normalized.models.length,
    checked_at: input.checked_at || null,
    expires_at: input.expires_at || null,
    blockers: normalized.blockers,
    warnings: normalized.warnings,
    recovery_action: normalized.blockers.length > 0 ? 'retry_catalog_sync' : null
  };
}

function catalogRows(value: unknown): any[] {
  return Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.models)
      ? (value as any).models
      : Array.isArray((value as any)?.data)
        ? (value as any).data
        : [];
}

function normalizeCodexLbCatalogRows(value: unknown): unknown {
  return {
    models: catalogRows(value).map((row: unknown) => typeof row === 'string'
      ? { id: row, slug: row, display_name: row, supported_in_api: true }
      : row)
  };
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function canonicalModel(model: BridgeCatalogModel): BridgeCatalogModel | null {
  const publicId = canonicalizeBridgeModelId(model.public_id);
  const upstream = normalizeBridgeUpstreamModelId(model.upstream_model);
  if (!publicId || !upstream) return null;
  return {
    public_id: publicId,
    provider_id: model.provider_id,
    upstream_model: upstream,
    display_name: String(model.display_name || publicId).trim().slice(0, 240),
    supported_in_api: model.supported_in_api !== false,
    capabilities: unique(model.capabilities).sort(),
    source_catalog_generation: String(model.source_catalog_generation || 'unknown'),
    route_key: `${model.provider_id}:${publicId}`
  };
}

function isModel(value: BridgeCatalogModel | null): value is BridgeCatalogModel {
  return value !== null;
}
