import type {
  BridgeProviderId,
  BridgeRouteIndex,
  BridgeRouteTarget,
  BridgeRoutingPolicy,
  ProviderSessionPin
} from './bridge-contracts.js';
import type { BridgeProviderRegistry } from './provider-registry.js';
import { providerEndpointSecurityBlocker } from './provider-registry.js';
import { validateBridgeRoutingPolicy } from './provider-route-policy.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  routeIndexMatchesGeneration
} from './route-index.js';

export interface BridgeRequestRouteResolution {
  readonly schema: 'sks.bridge-request-route-resolution.v1';
  readonly ok: boolean;
  readonly requested_model: string | null;
  readonly route: BridgeRouteTarget | null;
  readonly endpoint_url: string | null;
  readonly source: 'session_pin' | 'route_index' | null;
  readonly fallback: 'none';
  readonly catalog_generation: string;
  readonly route_policy_generation: string;
  readonly proposed_session_pin: ProviderSessionPin | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly recovery_action: string | null;
}

export function resolveBridgeRequestRoute(
  request: {
    readonly model: string;
    readonly thread_id?: string | null;
    readonly requested_endpoint_origin?: string | null;
  },
  policy: BridgeRoutingPolicy,
  options: {
    readonly route_index: BridgeRouteIndex;
    readonly registry: BridgeProviderRegistry;
    readonly session_pins?: ReadonlyMap<string, ProviderSessionPin> | readonly ProviderSessionPin[];
    readonly active_catalog_generation?: string;
    readonly now?: () => string;
  }
): BridgeRequestRouteResolution {
  const model = canonicalizeBridgeModelId(request.model);
  const base = {
    schema: 'sks.bridge-request-route-resolution.v1' as const,
    requested_model: model,
    fallback: 'none' as const,
    catalog_generation: policy.catalog_generation,
    route_policy_generation: policy.policy_generation,
    warnings: [] as string[]
  };
  if (!model) return blocked(base, 'catalog_model_route_missing');
  const policyBlockers = validateBridgeRoutingPolicy(policy, options.route_index);
  if (policyBlockers.length > 0) return blocked(base, policyBlockers[0]!);
  if (!routeIndexMatchesGeneration(options.route_index, options.route_index.generation)) {
    return blocked(base, 'catalog_route_index_generation_invalid');
  }
  if (options.active_catalog_generation && options.active_catalog_generation !== policy.catalog_generation) {
    return blocked(base, 'catalog_route_index_stale');
  }

  const threadPin = request.thread_id ? findSessionPin(options.session_pins, request.thread_id) : null;
  const pin = threadPin && canonicalizeBridgeModelId(threadPin.public_model) === model ? threadPin : null;
  // A pin that cannot be replayed exactly as recorded still constrains the
  // request: the fresh route has to keep the thread on the same provider and
  // upstream model. `null` here means there is nothing to keep it on.
  const pinAffinity = pin ? sessionPinAffinity(pin, policy, options.route_index, options.registry) : null;
  if (pinAffinity === 'unprovable') return blocked(base, 'session_pin_route_unavailable');
  // The route a stale pin still owes this thread, or null when there is no pin
  // or the pin was replayed verbatim below.
  const pinClaim = pinAffinity && pinAffinity !== 'honored' ? pinAffinity : null;
  if (pin && pinAffinity === 'honored') {
    const route = { provider_id: pin.provider_id, upstream_model: pin.upstream_model } as const;
    const providerBlocker = validateProviderRoute(route, request.requested_endpoint_origin, options.registry, options.route_index);
    if (providerBlocker) return blocked(base, providerBlocker);
    return {
      ...base,
      ok: true,
      route,
      endpoint_url: options.registry.profiles[route.provider_id].endpoint.url,
      source: 'session_pin',
      proposed_session_pin: pin,
      blockers: [],
      recovery_action: null
    };
  }

  const conflict = options.route_index.conflicts.find((entry) =>
    canonicalizeBridgeModelId(entry.public_id) === model);
  if (conflict) return blocked(base, 'catalog_model_route_ambiguous');
  const indexed = options.route_index.routes[model];
  const policyTarget = policy.model_routes[model];
  if (!indexed || !policyTarget) return blocked(base, 'catalog_model_route_missing');
  if (policyTarget.provider_id === 'openai') {
    // Official identity passthrough: the policy deliberately diverges from the
    // provider route index for this model. There is no provider endpoint, no
    // credential, and no pin — the bridge forwards the client's own identity.
    return {
      ...base,
      ok: true,
      route: policyTarget,
      endpoint_url: null,
      source: 'route_index',
      proposed_session_pin: null,
      blockers: [],
      recovery_action: null
    };
  }
  if (indexed.provider_id === 'openai') return blocked(base, 'catalog_route_provider_unknown');
  if (!sameTarget(indexed, policyTarget)) return blocked(base, 'bridge_route_policy_route_index_mismatch');
  // Stale bookkeeping is not the same as a thread losing its provider.
  // `policy_generation` digests the entire route map, so any unrelated catalog
  // churn invalidates every live pin at once — failing outright is what made
  // that churn surface as an intermittent `session_pin_route_unavailable`.
  // Re-pin when the fresh route is the one the pin already named; refuse only
  // when the thread really would move.
  if (pinClaim && !sameTarget(indexed, pinClaim)) return blocked(base, 'session_pin_route_unavailable');
  const providerBlocker = validateProviderRoute(indexed, request.requested_endpoint_origin, options.registry, options.route_index);
  if (providerBlocker) return blocked(base, providerBlocker);
  const proposedPin = request.thread_id
    ? {
        thread_id: request.thread_id,
        provider_id: indexed.provider_id,
        public_model: model,
        upstream_model: indexed.upstream_model,
        catalog_generation: policy.catalog_generation,
        route_policy_generation: policy.policy_generation,
        created_at: (options.now || (() => new Date().toISOString()))()
      } satisfies ProviderSessionPin
    : null;
  return {
    ...base,
    ok: true,
    route: indexed,
    endpoint_url: options.registry.profiles[indexed.provider_id].endpoint.url,
    source: 'route_index',
    proposed_session_pin: proposedPin,
    blockers: [],
    recovery_action: null
  };
}

/**
 * What a session pin still entitles its thread to.
 *
 *  - `honored`: the pin matches the live catalog exactly and is replayed as-is.
 *  - `unprovable`: the pin names a provider or upstream model this resolver
 *    cannot even compare, so no fresh route can be shown to preserve the
 *    thread's affinity.
 *  - a route target: the pin's own bookkeeping is stale, but the thread is
 *    still owed this exact provider and upstream model. The caller re-pins only
 *    when the fresh route matches it.
 */
function sessionPinAffinity(
  pin: ProviderSessionPin,
  policy: BridgeRoutingPolicy,
  routeIndex: BridgeRouteIndex,
  registry: BridgeProviderRegistry
): 'honored' | 'unprovable' | BridgeRouteTarget {
  if (!isProviderId(pin.provider_id) || !registry.profiles[pin.provider_id]) return 'unprovable';
  const model = canonicalizeBridgeModelId(pin.public_model);
  const upstream = normalizeBridgeUpstreamModelId(pin.upstream_model);
  if (!model || !upstream) return 'unprovable';
  const claim = { provider_id: pin.provider_id, upstream_model: upstream } as const;
  if (pin.catalog_generation !== policy.catalog_generation
    || pin.route_policy_generation !== policy.policy_generation) {
    return claim;
  }
  const indexed = routeIndex.routes[model] || routeIndex.routes[`${pin.provider_id}:${model}`];
  if (!indexed || !sameTarget(indexed, claim)) return claim;
  return 'honored';
}

function validateProviderRoute(
  route: BridgeRouteTarget,
  requestedOrigin: string | null | undefined,
  registry: BridgeProviderRegistry,
  routeIndex: BridgeRouteIndex
): string | null {
  if (!isProviderId(route.provider_id)) return 'catalog_route_provider_unknown';
  const profile = registry.profiles[route.provider_id];
  if (!profile) return 'catalog_route_provider_unknown';
  if (routeIndex.providers[route.provider_id].state !== 'ready') {
    return `${providerCode(route.provider_id)}_catalog_route_not_ready`;
  }
  if (!profile.enabled) return `${providerCode(route.provider_id)}_provider_disabled`;
  if (profile.state === 'not_configured') return `${providerCode(route.provider_id)}_credential_missing`;
  if (profile.state !== 'ready') return `${providerCode(route.provider_id)}_route_not_ready`;
  const endpointBlocker = providerEndpointSecurityBlocker(
    route.provider_id,
    profile.endpoint.url,
    profile.endpoint.allowed_origins
  );
  if (endpointBlocker) return endpointBlocker;
  if (requestedOrigin) {
    let origin = '';
    try {
      origin = new URL(requestedOrigin).origin;
    } catch {
      return 'provider_endpoint_origin_not_allowlisted';
    }
    if (origin !== profile.endpoint.origin || !profile.endpoint.allowed_origins.includes(origin)) {
      return 'provider_endpoint_origin_not_allowlisted';
    }
  }
  return null;
}

function findSessionPin(
  pins: ReadonlyMap<string, ProviderSessionPin> | readonly ProviderSessionPin[] | undefined,
  threadId: string
): ProviderSessionPin | null {
  if (!pins) return null;
  if (Array.isArray(pins)) return pins.find((pin: ProviderSessionPin) => pin.thread_id === threadId) || null;
  return (pins as ReadonlyMap<string, ProviderSessionPin>).get(threadId) || null;
}

function blocked(
  base: Pick<
    BridgeRequestRouteResolution,
    'schema' | 'requested_model' | 'fallback' | 'catalog_generation' | 'route_policy_generation' | 'warnings'
  >,
  blocker: string
): BridgeRequestRouteResolution {
  return {
    ...base,
    ok: false,
    route: null,
    endpoint_url: null,
    source: null,
    proposed_session_pin: null,
    blockers: [blocker],
    recovery_action: recoveryAction(blocker)
  };
}

function recoveryAction(blocker: string): string {
  if (blocker === 'catalog_model_route_ambiguous') return 'resolve_catalog_route_conflict';
  if (blocker === 'catalog_model_route_missing') return 'refresh_catalog_or_select_supported_model';
  if (blocker === 'session_pin_route_unavailable' || blocker === 'catalog_route_index_stale') {
    return 'select_supported_model_and_refresh_session_pin';
  }
  if (blocker === 'codex_lb_credential_missing') return 'configure_codex_lb_credential';
  if (blocker === 'openrouter_credential_missing') return 'configure_openrouter_credential';
  if (blocker.includes('origin_not_allowlisted')) return 'review_provider_endpoint_configuration';
  return 'review_bridge_route_status';
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function isProviderId(value: unknown): value is BridgeProviderId {
  return value === 'codex-lb' || value === 'openrouter';
}

function sameTarget(left: BridgeRouteTarget, right: BridgeRouteTarget): boolean {
  return left.provider_id === right.provider_id && left.upstream_model === right.upstream_model;
}
