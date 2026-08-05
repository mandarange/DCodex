import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  BridgeProviderId,
  BridgeRouteIndex,
  BridgeRouteTarget,
  BridgeRoutingPolicy
} from './bridge-contracts.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  sha256Stable
} from './route-index.js';
import { writeJsonAtomic } from '../fsx.js';

export const BRIDGE_ROUTE_POLICY_FILENAME = 'sks-bridge-route-policy.json' as const;

export function bridgeRoutePolicyPath(codexHome: string = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')): string {
  return path.join(path.resolve(codexHome), 'sks', BRIDGE_ROUTE_POLICY_FILENAME);
}

export function buildBridgeRoutingPolicy(input: {
  readonly route_index: BridgeRouteIndex;
  readonly catalog_generation: string;
  readonly default_provider_id?: BridgeProviderId | null;
  readonly changed_at?: string;
}): BridgeRoutingPolicy {
  const routes = canonicalRoutes(input.route_index.routes);
  const semantic = {
    default_provider_id: input.default_provider_id ?? null,
    fallback: 'none' as const,
    model_routes: routes,
    catalog_generation: input.catalog_generation
  };
  return {
    schema: 'sks.bridge-routing-policy.v1',
    ...semantic,
    policy_generation: sha256Stable(semantic),
    changed_at: input.changed_at || new Date().toISOString()
  };
}

export function setBridgeRoutingDefault(
  policy: BridgeRoutingPolicy,
  providerId: BridgeProviderId | null,
  changedAt?: string
): BridgeRoutingPolicy {
  const semantic = {
    default_provider_id: providerId,
    fallback: 'none' as const,
    model_routes: canonicalRoutes(policy.model_routes),
    catalog_generation: policy.catalog_generation
  };
  return {
    schema: 'sks.bridge-routing-policy.v1',
    ...semantic,
    policy_generation: sha256Stable(semantic),
    changed_at: changedAt || new Date().toISOString()
  };
}

export function validateBridgeRoutingPolicy(
  policy: BridgeRoutingPolicy,
  routeIndex?: BridgeRouteIndex
): readonly string[] {
  const blockers: string[] = [];
  if (policy.schema !== 'sks.bridge-routing-policy.v1') blockers.push('bridge_route_policy_schema_invalid');
  if (policy.fallback !== 'none') blockers.push('bridge_route_policy_fallback_forbidden');
  if (!policy.catalog_generation) blockers.push('bridge_route_policy_catalog_generation_missing');
  const canonical = canonicalRoutes(policy.model_routes);
  const semantic = {
    default_provider_id: policy.default_provider_id,
    fallback: 'none' as const,
    model_routes: canonical,
    catalog_generation: policy.catalog_generation
  };
  if (sha256Stable(semantic) !== policy.policy_generation) blockers.push('bridge_route_policy_generation_invalid');
  if (Object.keys(canonical).length !== Object.keys(policy.model_routes).length) blockers.push('bridge_route_policy_model_invalid');
  if (routeIndex) {
    for (const [model, target] of Object.entries(canonical)) {
      const indexed = routeIndex.routes[model];
      if (!indexed || !sameTarget(indexed, target)) blockers.push('bridge_route_policy_route_index_mismatch');
    }
  }
  return unique(blockers);
}

export async function writeBridgeRoutingPolicy(
  file: string,
  policy: BridgeRoutingPolicy,
  routeIndex?: BridgeRouteIndex
): Promise<void> {
  const blockers = validateBridgeRoutingPolicy(policy, routeIndex);
  if (blockers.length > 0) throw new Error(blockers[0]);
  await writeJsonAtomic(file, policy, { mode: 0o600 });
}

export async function readBridgeRoutingPolicy(file: string): Promise<{
  readonly policy: BridgeRoutingPolicy | null;
  readonly blockers: readonly string[];
}> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { policy: null, blockers: ['bridge_route_policy_missing'] };
  if (!stat.isFile() || stat.isSymbolicLink()) return { policy: null, blockers: ['bridge_route_policy_not_regular_file'] };
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) return { policy: null, blockers: ['bridge_route_policy_owner_mismatch'] };
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    return { policy: null, blockers: ['bridge_route_policy_mode_insecure'] };
  }
  try {
    const policy = JSON.parse(await fs.readFile(file, 'utf8')) as BridgeRoutingPolicy;
    const blockers = validateBridgeRoutingPolicy(policy);
    return blockers.length > 0 ? { policy: null, blockers } : { policy, blockers: [] };
  } catch {
    return { policy: null, blockers: ['bridge_route_policy_json_invalid'] };
  }
}

function canonicalRoutes(routes: Record<string, BridgeRouteTarget>): Record<string, BridgeRouteTarget> {
  const rows: Array<[string, BridgeRouteTarget]> = [];
  for (const [model, target] of Object.entries(routes)) {
    const canonicalModel = canonicalizeBridgeModelId(model);
    const upstreamModel = normalizeBridgeUpstreamModelId(target.upstream_model);
    if (!canonicalModel || !upstreamModel || !isProviderId(target.provider_id)) continue;
    rows.push([canonicalModel, { provider_id: target.provider_id, upstream_model: upstreamModel }]);
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right)));
}

function isProviderId(value: unknown): value is BridgeProviderId {
  return value === 'codex-lb' || value === 'openrouter';
}

function sameTarget(left: BridgeRouteTarget, right: BridgeRouteTarget): boolean {
  return left.provider_id === right.provider_id && left.upstream_model === right.upstream_model;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
