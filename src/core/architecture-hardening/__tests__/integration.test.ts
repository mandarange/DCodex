import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { BridgeProviderId, ProviderSessionPin } from '../../codex-lb/bridge-contracts.js';
import { buildCombinedBridgeCatalog } from '../../codex-lb/combined-catalog.js';
import type { ResolvedProviderCredential } from '../../codex-lb/provider-credentials.js';
import { buildBridgeRoutingPolicy } from '../../codex-lb/provider-route-policy.js';
import { resolveBridgeProviderRegistry } from '../../codex-lb/provider-registry.js';
import { resolveBridgeRequestRoute } from '../../codex-lb/request-route-resolver.js';
import { sha256Stable } from '../../codex-lb/route-index.js';
import {
  buildProviderUpstreamHeaders,
  createDesktopBridgePublicState,
  desktopBridgeConfigGeneration,
  type DesktopBridgeConfig,
  type DesktopBridgeProviderRegistrySnapshot,
} from '../../codex-lb/desktop-bridge/index.js';

const LB_SECRET = 'integration-lb-secret-do-not-serialize';
const OPENROUTER_SECRET = 'integration-openrouter-secret-do-not-serialize';
const CLIENT_CAPABILITY = Buffer.alloc(32, 0x41).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');
const credentials: Record<BridgeProviderId, ResolvedProviderCredential> = {
  'codex-lb': credential('codex-lb', LB_SECRET, 'lb-fingerprint', 'https://lb.example.test/backend-api/codex'),
  openrouter: credential('openrouter', OPENROUTER_SECRET, 'openrouter-fingerprint', 'https://openrouter.ai/api/v1'),
};

test('Desktop Bridge seam keeps simultaneous provider routes explicit, pinned, isolated, and generation-bound', async () => {
  const registry = await resolveBridgeProviderRegistry({
    credentials,
    storedRegistry: {
      schema: 'sks.bridge-provider-registry.v1',
      profiles: {
        'codex-lb': {
          enabled: true,
          endpoint_url: credentials['codex-lb'].endpoint_url,
          allowed_origins: ['https://lb.example.test'],
          auth_transport: 'x-codex-lb-api-key',
        },
        openrouter: {
          enabled: true,
          endpoint_url: credentials.openrouter.endpoint_url,
          allowed_origins: ['https://openrouter.ai'],
          auth_transport: 'openrouter-bearer',
        },
      },
    },
  });
  assert.deepEqual(
    Object.values(registry.profiles).map((profile) => profile.state),
    ['ready', 'ready'],
  );

  const first = catalog(registry, 'first');
  const policy = buildBridgeRoutingPolicy({
    route_index: first.route_index,
    catalog_generation: first.catalog.generation,
    default_provider_id: null,
    changed_at: '2026-08-06T00:00:00.000Z',
  });
  assert.equal(policy.fallback, 'none');
  const lbRoute = resolveBridgeRequestRoute({ model: 'codex-lb:vendor/lb-integration' }, policy, {
    route_index: first.route_index,
    registry,
  });
  const openRouterRoute = resolveBridgeRequestRoute({
    model: 'openrouter:openrouter-integration',
    thread_id: 'integration-thread',
  }, policy, {
    route_index: first.route_index,
    registry,
    now: () => '2026-08-06T00:01:00.000Z',
  });
  assert.equal(lbRoute.route?.provider_id, 'codex-lb');
  assert.equal(openRouterRoute.route?.provider_id, 'openrouter');
  assert.ok(openRouterRoute.proposed_session_pin);
  const pin = openRouterRoute.proposed_session_pin;
  assert.equal(resolveBridgeRequestRoute({
    model: pin.public_model,
    thread_id: pin.thread_id,
  }, policy, {
    route_index: first.route_index,
    registry,
    session_pins: [pin],
  }).source, 'session_pin');
  const tampered = resolveBridgeRequestRoute({ model: pin.public_model, thread_id: pin.thread_id }, policy, {
    route_index: first.route_index,
    registry,
    session_pins: [{ ...pin, provider_id: 'codex-lb' }],
  });
  assert.deepEqual(tampered.blockers, ['session_pin_route_unavailable']);
  assert.equal(tampered.fallback, 'none');

  const inbound = {
    authorization: 'Bearer desktop-oauth-secret',
    cookie: 'desktop=session',
    'x-codex-lb-api-key': 'forged-provider-key',
    'thread-id': pin.thread_id,
    'session-id': pin.thread_id,
    'x-codex-turn-metadata': JSON.stringify({ thread_id: pin.thread_id, session_id: pin.thread_id }),
  };
  const lbHeaders = buildProviderUpstreamHeaders(inbound, {
    providerId: 'codex-lb',
    authTransport: 'x-codex-lb-api-key',
    credential: runtimeCredential('codex-lb', LB_SECRET, 'lb-fingerprint', registry.profiles['codex-lb'].profile_generation),
  }, 'lb.example.test');
  const openRouterHeaders = buildProviderUpstreamHeaders(inbound, {
    providerId: 'openrouter',
    authTransport: 'openrouter-bearer',
    credential: runtimeCredential('openrouter', OPENROUTER_SECRET, 'openrouter-fingerprint', registry.profiles.openrouter.profile_generation),
  }, 'openrouter.ai');
  assert.equal(lbHeaders['x-codex-lb-api-key'], LB_SECRET);
  assert.equal(lbHeaders.authorization, undefined);
  assert.equal(openRouterHeaders.authorization, `Bearer ${OPENROUTER_SECRET}`);
  assert.equal(openRouterHeaders['x-codex-lb-api-key'], undefined);
  for (const headers of [lbHeaders, openRouterHeaders]) {
    assert.equal(headers.cookie, undefined);
    assert.equal(headers['thread-id'], undefined);
    assert.equal(headers['session-id'], undefined);
    assert.equal(headers['x-codex-turn-metadata'], undefined);
    assert.doesNotMatch(JSON.stringify(headers), /desktop-oauth-secret|forged-provider-key/);
  }

  const firstConfig = bridgeConfig(registrySnapshot(registry, first.route_index), policy, pin);
  const firstState = createDesktopBridgePublicState(firstConfig, {
    pid: 42,
    now: new Date('2026-08-06T00:02:00.000Z'),
  });
  assert.equal(firstState.runtime, 'desktop-bridge');
  assert.deepEqual(new Set(firstState.enabled_providers), new Set(['codex-lb', 'openrouter']));
  assert.doesNotMatch(JSON.stringify(firstState), new RegExp(`${LB_SECRET}|${OPENROUTER_SECRET}`));

  const restarted = catalog(registry, 'restarted');
  const restartedPolicy = buildBridgeRoutingPolicy({
    route_index: restarted.route_index,
    catalog_generation: restarted.catalog.generation,
    default_provider_id: null,
    changed_at: '2026-08-06T00:03:00.000Z',
  });
  assert.notEqual(restartedPolicy.catalog_generation, policy.catalog_generation);
  assert.deepEqual(resolveBridgeRequestRoute({ model: pin.public_model, thread_id: pin.thread_id }, restartedPolicy, {
    route_index: restarted.route_index,
    registry,
    session_pins: [pin],
  }).blockers, ['session_pin_route_unavailable']);
  const restartedConfig = bridgeConfig(registrySnapshot(registry, restarted.route_index), restartedPolicy, null);
  assert.notEqual(desktopBridgeConfigGeneration(restartedConfig), desktopBridgeConfigGeneration(firstConfig));
});

function credential(
  providerId: BridgeProviderId,
  secret: string,
  fingerprint: string,
  endpointUrl: string,
): ResolvedProviderCredential {
  return {
    schema: 'sks.provider-credential-status.v1',
    provider_id: providerId,
    state: 'ready',
    source: 'integration-fixture',
    fingerprint,
    checked_at: '2026-08-06T00:00:00.000Z',
    blockers: [],
    warnings: [],
    secret,
    endpoint_url: endpointUrl,
  };
}

function catalog(registry: Awaited<ReturnType<typeof resolveBridgeProviderRegistry>>, suffix: string) {
  const result = buildCombinedBridgeCatalog(registry, {
    created_at: suffix === 'first' ? '2026-08-06T00:00:00.000Z' : '2026-08-06T00:03:00.000Z',
    catalogs: {
      'codex-lb': {
        provider_id: 'codex-lb',
        state: 'verified',
        generation: `lb-${suffix}`,
        models: { models: [{ slug: 'Vendor/LB-Integration', display_name: 'LB integration' }] },
      },
      openrouter: {
        provider_id: 'openrouter',
        state: 'verified',
        generation: `openrouter-${suffix}`,
        models: [{ id: 'openrouter-integration', name: 'OpenRouter integration' }],
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  return result;
}

function registrySnapshot(
  registry: Awaited<ReturnType<typeof resolveBridgeProviderRegistry>>,
  routeIndex: ReturnType<typeof catalog>['route_index'],
): DesktopBridgeProviderRegistrySnapshot {
  const providers = Object.fromEntries((['codex-lb', 'openrouter'] as const).map((providerId) => {
    const profile = registry.profiles[providerId];
    return [providerId, {
      provider_id: providerId,
      enabled: profile.enabled,
      base_url: profile.endpoint.url!,
      allowed_origins: profile.endpoint.allowed_origins,
      auth_transport: profile.endpoint.auth_transport,
      credential_state: profile.credential.state,
      credential_fingerprint: profile.credential.fingerprint,
      credential_generation: profile.profile_generation,
      source_catalog_generation: routeIndex.providers[providerId].catalog_generation,
    }];
  })) as DesktopBridgeProviderRegistrySnapshot['providers'];
  return {
    schema: 'sks.desktop-bridge-provider-registry.v1',
    generation: sha256Stable(providers),
    created_at: '2026-08-06T00:00:00.000Z',
    providers,
  };
}

function bridgeConfig(
  providerRegistry: DesktopBridgeProviderRegistrySnapshot,
  routePolicy: ReturnType<typeof buildBridgeRoutingPolicy>,
  pin: ProviderSessionPin | null,
): DesktopBridgeConfig {
  return {
    providerRegistry,
    routePolicy,
    providerSessionPins: pin ? [pin] : [],
    resolveProviderCredential: async (providerId, generation) => runtimeCredential(
      providerId,
      providerId === 'codex-lb' ? LB_SECRET : OPENROUTER_SECRET,
      credentials[providerId].fingerprint!,
      generation,
    ),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    listenHost: '127.0.0.1',
    listenPort: 55_000,
    allowedPathPrefixes: ['/v1/'],
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
  };
}

function runtimeCredential(providerId: BridgeProviderId, value: string, fingerprint: string, generation: string) {
  return { provider_id: providerId, value, source: 'integration-fixture', fingerprint, generation };
}
