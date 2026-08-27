import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  BRIDGE_OFFICIAL_ROUTE_ID,
  type BridgeProviderId,
  type BridgeRouteIndex,
  type BridgeRouteTarget,
  type BridgeRoutingPolicy
} from './bridge-contracts.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  sha256Stable
} from './route-index.js';
import { writeJsonAtomic } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';

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
      // Official passthrough targets deliberately diverge from the provider
      // route index: the flip rewrites a provider-indexed model to `openai`.
      if (target.provider_id === BRIDGE_OFFICIAL_ROUTE_ID) continue;
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
  await withFileLock({
    lockPath: `${path.resolve(file)}.lock`,
    timeoutMs: 10_000,
    staleMs: 60_000
  }, () => writeJsonAtomic(file, policy, { mode: 0o600 }));
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
    if (!canonicalModel || !upstreamModel || !isRouteTargetId(target.provider_id)) continue;
    rows.push([canonicalModel, { provider_id: target.provider_id, upstream_model: upstreamModel }]);
  }
  return Object.fromEntries(rows.sort(([left], [right]) => left.localeCompare(right)));
}

function isProviderId(value: unknown): value is BridgeProviderId {
  return value === 'codex-lb' || value === 'openrouter';
}

function isRouteTargetId(value: unknown): value is BridgeRouteTarget['provider_id'] {
  return isProviderId(value) || value === BRIDGE_OFFICIAL_ROUTE_ID;
}

/**
 * Which BARE official model ids `applyOfficialModelPassthrough` rewrites to the
 * official `openai` identity route — the same rule OpenCodex uses
 * (`isBareOpenAiFamilyModel` → `OPENAI_CODEX_PROVIDER_ID`). Provider-prefixed
 * spellings (`codex-lb:gpt-5.6-sol`) are the operator's explicit gateway picks
 * and are never touched; SKS-internal gateway models (`codex-auto-review`)
 * stay on their provider route.
 */
export const OFFICIAL_MODEL_ID_PATTERN = /^(?:gpt-[0-9]|o[0-9]|codex-mini)/;

/**
 * Applies the operator's official-models routing mode to bare official-family
 * routes, in BOTH directions. `passthrough` rewrites bare official ids to the
 * `openai` identity route, so those turns carry the operator's own ChatGPT
 * identity — the one Codex Apps connector links, conversation affinity, and
 * plan quotas are bound to — instead of a substituted gateway key. `gateway`
 * restores any bare official id still sitting on `openai` back to the target
 * its provider-prefixed gateway twin (`codex-lb:<id>`) names, so a stale flip
 * converges instead of surviving every later start (the 2026-08-27 shape: one
 * start resolved `auto` off a transient not-ready registry snapshot, flipped
 * gpt-5.6-* to official OAuth, and the then one-directional apply kept them
 * there while SKS Center showed a healthy registered gateway). Returns the
 * policy object unchanged when no route needs rewriting; otherwise regenerates
 * policy_generation so the change is a first-class policy change.
 */
export function applyOfficialModelPassthrough(
  policy: BridgeRoutingPolicy,
  input: { mode: 'passthrough' | 'gateway'; changedAt?: string } = { mode: 'passthrough' },
): BridgeRoutingPolicy {
  const routes: Record<string, BridgeRouteTarget> = {};
  let changed = false;
  for (const [model, target] of Object.entries(policy.model_routes)) {
    const next = input.mode === 'passthrough'
      ? passthroughRouteTarget(model, target)
      : gatewayRouteTarget(model, target, policy);
    routes[model] = next;
    if (next !== target) changed = true;
  }
  if (!changed) return policy;
  const semantic = {
    default_provider_id: policy.default_provider_id,
    fallback: 'none' as const,
    model_routes: canonicalRoutes(routes),
    catalog_generation: policy.catalog_generation
  };
  return {
    schema: 'sks.bridge-routing-policy.v1',
    ...semantic,
    policy_generation: sha256Stable(semantic),
    changed_at: input.changedAt || new Date().toISOString()
  };
}

function passthroughRouteTarget(model: string, target: BridgeRouteTarget): BridgeRouteTarget {
  if (!OFFICIAL_MODEL_ID_PATTERN.test(model) || model.includes(':')) return target;
  if (target.provider_id === BRIDGE_OFFICIAL_ROUTE_ID && target.upstream_model === model) return target;
  return { provider_id: BRIDGE_OFFICIAL_ROUTE_ID, upstream_model: model };
}

/**
 * The gateway target a flipped bare official id converges back to: the route
 * its `codex-lb:<id>` twin names. The twin is authored by the same route index
 * build that authored the bare id (explicit `provider:public_id` keys are
 * always emitted), so it carries the catalog's real upstream model — including
 * aliases the flip erased. A bare `openai` route with no twin has no provable
 * gateway route and is left as the operator's passthrough.
 */
function gatewayRouteTarget(
  model: string,
  target: BridgeRouteTarget,
  policy: BridgeRoutingPolicy
): BridgeRouteTarget {
  if (target.provider_id !== BRIDGE_OFFICIAL_ROUTE_ID) return target;
  if (!OFFICIAL_MODEL_ID_PATTERN.test(model) || model.includes(':')) return target;
  const twin = policy.model_routes[`codex-lb:${model}`];
  if (!twin || twin.provider_id !== 'codex-lb') return target;
  return { provider_id: twin.provider_id, upstream_model: twin.upstream_model };
}

function sameTarget(left: BridgeRouteTarget, right: BridgeRouteTarget): boolean {
  return left.provider_id === right.provider_id && left.upstream_model === right.upstream_model;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
