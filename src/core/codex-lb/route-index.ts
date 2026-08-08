import crypto from 'node:crypto';
import type {
  BridgeCatalogModel,
  BridgeProviderId,
  BridgeRouteIndex,
  BridgeRouteTarget
} from './bridge-contracts.js';

export interface RouteIndexProviderInput {
  readonly catalog_generation: string | null;
  readonly credential_fingerprint: string | null;
  readonly state: string;
}

export interface BridgeRouteIndexBuildResult {
  readonly route_index: BridgeRouteIndex;
  readonly digest: string;
  readonly route_count: number;
  readonly conflict_count: number;
  readonly blockers: readonly string[];
}

export function canonicalizeBridgeModelId(value: unknown): string | null {
  const model = String(value || '').trim().toLowerCase();
  if (!model || model.length > 240) return null;
  if (!/^[a-z0-9][a-z0-9._:/-]*$/.test(model)) return null;
  return model;
}

export function normalizeBridgeUpstreamModelId(value: unknown): string | null {
  const model = String(value || '').trim();
  if (!model || model.length > 240) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(model)) return null;
  return model;
}

export function providerRouteKey(providerId: BridgeProviderId, publicId: string): string {
  const model = canonicalizeBridgeModelId(publicId);
  if (!model) throw new Error('catalog_model_id_invalid');
  return `${providerId}:${model}`;
}

export function buildBridgeRouteIndex(input: {
  readonly models: readonly BridgeCatalogModel[];
  readonly providers: Record<BridgeProviderId, RouteIndexProviderInput>;
  readonly created_at?: string;
}): BridgeRouteIndexBuildResult {
  const grouped = new Map<string, BridgeCatalogModel[]>();
  const explicitRoutes = new Map<string, BridgeRouteTarget>();
  const blockers: string[] = [];

  for (const source of [...input.models].sort(compareModels)) {
    const publicId = canonicalizeBridgeModelId(source.public_id);
    const upstream = normalizeBridgeUpstreamModelId(source.upstream_model);
    if (!publicId || !upstream) {
      blockers.push('catalog_model_id_invalid');
      continue;
    }
    const model: BridgeCatalogModel = {
      ...source,
      public_id: publicId,
      slug: source.slug || publicId,
      upstream_model: upstream,
      capabilities: unique(source.capabilities).sort(),
      route_key: providerRouteKey(source.provider_id, publicId)
    };
    const rows = grouped.get(publicId) || [];
    rows.push(model);
    grouped.set(publicId, rows);
    const explicit = explicitRoutes.get(model.route_key);
    const target = { provider_id: model.provider_id, upstream_model: model.upstream_model } as const;
    if (explicit && !sameTarget(explicit, target)) blockers.push('catalog_model_route_ambiguous');
    else explicitRoutes.set(model.route_key, target);
  }

  const routes = new Map(explicitRoutes);
  const conflicts: BridgeRouteIndex['conflicts'] = [];
  for (const [publicId, rows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const targets = uniqueTargets(rows);
    if (targets.length === 1) {
      routes.set(publicId, targets[0]!);
      continue;
    }
    conflicts.push({
      public_id: publicId,
      providers: unique(rows.map((row) => row.provider_id)).sort() as BridgeProviderId[],
      blocker: 'catalog_model_route_ambiguous'
    });
  }

  const canonicalProviders = {
    'codex-lb': canonicalProvider(input.providers['codex-lb']),
    openrouter: canonicalProvider(input.providers.openrouter)
  };
  const canonicalRoutes = Object.fromEntries([...routes.entries()].sort(([left], [right]) => left.localeCompare(right)));
  const semantic = {
    providers: canonicalProviders,
    routes: canonicalRoutes,
    conflicts
  };
  const generation = sha256Stable(semantic);
  const routeIndex: BridgeRouteIndex = {
    schema: 'sks.bridge-route-index.v1',
    generation,
    created_at: input.created_at || new Date().toISOString(),
    providers: canonicalProviders,
    routes: canonicalRoutes,
    conflicts
  };
  return {
    route_index: routeIndex,
    digest: generation,
    route_count: Object.keys(canonicalRoutes).length,
    conflict_count: conflicts.length,
    blockers: unique([
      ...blockers,
      ...(conflicts.length > 0 ? ['catalog_model_route_ambiguous'] : [])
    ])
  };
}

export function routeIndexMatchesGeneration(index: BridgeRouteIndex, expectedGeneration: string): boolean {
  return index.schema === 'sks.bridge-route-index.v1'
    && index.generation === expectedGeneration
    && sha256Stable({
      providers: index.providers,
      routes: index.routes,
      conflicts: index.conflicts
    }) === index.generation;
}

export function stableJson(value: unknown): string {
  return `${stableStringify(value)}\n`;
}

export function sha256Stable(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function canonicalProvider(input: RouteIndexProviderInput): RouteIndexProviderInput {
  return {
    catalog_generation: input.catalog_generation,
    credential_fingerprint: input.credential_fingerprint,
    state: String(input.state || 'unknown')
  };
}

function uniqueTargets(rows: readonly BridgeCatalogModel[]): BridgeRouteTarget[] {
  const map = new Map<string, BridgeRouteTarget>();
  for (const row of rows) {
    const target = { provider_id: row.provider_id, upstream_model: row.upstream_model } as const;
    map.set(`${target.provider_id}\u0000${target.upstream_model}`, target);
  }
  return [...map.values()].sort((left, right) =>
    left.provider_id.localeCompare(right.provider_id)
      || left.upstream_model.localeCompare(right.upstream_model));
}

function compareModels(left: BridgeCatalogModel, right: BridgeCatalogModel): number {
  return left.public_id.localeCompare(right.public_id)
    || left.provider_id.localeCompare(right.provider_id)
    || left.upstream_model.localeCompare(right.upstream_model);
}

function sameTarget(left: BridgeRouteTarget, right: BridgeRouteTarget): boolean {
  return left.provider_id === right.provider_id && left.upstream_model === right.upstream_model;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
