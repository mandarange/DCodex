import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BridgeProviderId, ProviderSessionPin } from '../bridge-contracts.js';
import { buildCombinedBridgeCatalog } from '../combined-catalog.js';
import { resolveAllProviderCredentials } from '../provider-credentials.js';
import { buildBridgeRoutingPolicy } from '../provider-route-policy.js';
import { resolveBridgeProviderRegistry, type BridgeProviderRegistry } from '../provider-registry.js';
import { resolveBridgeRequestRoute } from '../request-route-resolver.js';

async function fixture() {
  const credentials = await resolveAllProviderCredentials({
    codexLb: {
      loadCodexLbEnvImpl: async () => ({
        schema: 'sks.codex-lb-env.v1',
        configured: true,
        missing: [],
        source: 'env-file',
        source_priority: ['env-file'],
        base_url: 'https://lb.example.test/backend-api/codex',
        api_key: { present: true, usable: true, source: 'env-file', redacted: true, fingerprint: '1111111111111111' },
        secret_api_key: 'lb-route-secret',
        credential_binding: {
          checked: true,
          present: true,
          valid: true,
          status: 'matched',
          metadata_path: '/fixture/lb.json',
          api_key_matches: true,
          base_url_matches: true,
          blockers: []
        },
        env_paths: ['/fixture/lb.env'],
        keychain: { checked: false, available: false, status: 'not_used' }
      }),
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    },
    openrouter: {
      resolveOpenRouterApiKeyImpl: async () => ({
        key: 'or-route-secret',
        source: 'user-secret-store',
        key_preview: 'or-...cret',
        blockers: [],
        warnings: []
      }),
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    }
  });
  const registry = await resolveBridgeProviderRegistry({
    registryPath: '/path/that/does/not/exist/provider-registry.json',
    credentials
  });
  const build = buildCombinedBridgeCatalog(registry, {
    created_at: '2026-08-05T00:00:00.000Z',
    catalogs: {
      'codex-lb': {
        provider_id: 'codex-lb',
        state: 'verified',
        generation: 'lb-catalog-1',
        models: { models: [{ slug: 'Vendor/LB-Slash-Model', display_name: 'LB slash model' }] }
      },
      openrouter: {
        provider_id: 'openrouter',
        state: 'verified',
        generation: 'or-catalog-1',
        models: [{ id: 'openrouter-noslash', name: 'OpenRouter no slash' }]
      }
    }
  });
  assert.equal(build.ok, true, JSON.stringify(build.blockers));
  const policy = buildBridgeRoutingPolicy({
    route_index: build.route_index,
    catalog_generation: build.catalog.generation,
    default_provider_id: 'codex-lb',
    changed_at: '2026-08-05T00:00:00.000Z'
  });
  return { registry, build, policy };
}

test('R27/R45: route index, not slash shape or default provider, selects the provider and never falls back', async () => {
  const setup = await fixture();
  const lb = resolveBridgeRequestRoute({ model: 'vendor/lb-slash-model' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    active_catalog_generation: setup.build.catalog.generation
  });
  assert.equal(lb.ok, true);
  assert.equal(lb.route?.provider_id, 'codex-lb');
  assert.equal(lb.route?.upstream_model, 'Vendor/LB-Slash-Model');

  const openrouter = resolveBridgeRequestRoute({ model: 'openrouter-noslash' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    active_catalog_generation: setup.build.catalog.generation
  });
  assert.equal(openrouter.ok, true);
  assert.equal(openrouter.route?.provider_id, 'openrouter');
  assert.equal(openrouter.fallback, 'none');

  const missing = resolveBridgeRequestRoute({ model: 'unknown/model' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.blockers, ['catalog_model_route_missing']);
  assert.equal(missing.route, null);
});

test('R44/R28: session pins preserve exact provider generations and stale pins block', async () => {
  const setup = await fixture();
  const first = resolveBridgeRequestRoute({ model: 'openrouter-noslash', thread_id: 'thread-1' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    active_catalog_generation: setup.build.catalog.generation,
    now: () => '2026-08-05T00:00:00.000Z'
  });
  assert.equal(first.ok, true);
  assert.ok(first.proposed_session_pin);
  const pin = first.proposed_session_pin as ProviderSessionPin;
  const pinned = resolveBridgeRequestRoute({ model: 'openrouter-noslash', thread_id: 'thread-1' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    session_pins: [pin]
  });
  assert.equal(pinned.source, 'session_pin');
  assert.equal(pinned.route?.provider_id, 'openrouter');

  const switched = resolveBridgeRequestRoute({ model: 'vendor/lb-slash-model', thread_id: 'thread-1' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    session_pins: [pin],
    now: () => '2026-08-05T00:02:00.000Z'
  });
  assert.equal(switched.ok, true);
  assert.equal(switched.route?.provider_id, 'codex-lb');
  assert.equal(switched.proposed_session_pin?.provider_id, 'codex-lb');

  const stalePin = { ...pin, catalog_generation: 'old-generation' };
  const stale = resolveBridgeRequestRoute({ model: 'openrouter-noslash', thread_id: 'thread-1' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    session_pins: [stalePin]
  });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.blockers, ['session_pin_route_unavailable']);

  const staleIndex = resolveBridgeRequestRoute({ model: 'openrouter-noslash' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry,
    active_catalog_generation: 'stale-active-generation'
  });
  assert.deepEqual(staleIndex.blockers, ['catalog_route_index_stale']);
});

test('R11-R12/R46: disabled providers and endpoint-origin tampering block without cross-provider fallback', async () => {
  const setup = await fixture();
  const tampered = resolveBridgeRequestRoute({
    model: 'openrouter-noslash',
    requested_endpoint_origin: 'https://attacker.example.test'
  }, setup.policy, {
    route_index: setup.build.route_index,
    registry: setup.registry
  });
  assert.equal(tampered.ok, false);
  assert.deepEqual(tampered.blockers, ['provider_endpoint_origin_not_allowlisted']);

  const disabled = disable(setup.registry, 'openrouter');
  const blocked = resolveBridgeRequestRoute({ model: 'openrouter-noslash' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: disabled
  });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blockers, ['openrouter_provider_disabled']);
  assert.equal(blocked.route, null);
  assert.equal(blocked.fallback, 'none');

  const lbStillRoutes = resolveBridgeRequestRoute({ model: 'vendor/lb-slash-model' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: disabled
  });
  assert.equal(lbStillRoutes.ok, true);
  assert.equal(lbStillRoutes.route?.provider_id, 'codex-lb');

  const lbDisabled = disable(setup.registry, 'codex-lb');
  const openRouterStillRoutes = resolveBridgeRequestRoute({ model: 'openrouter-noslash' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: lbDisabled
  });
  assert.equal(openRouterStillRoutes.ok, true);
  assert.equal(openRouterStillRoutes.route?.provider_id, 'openrouter');
});

test('R24-R25: auth failure blocks its active route without contaminating another provider route', async () => {
  const setup = await fixture();
  const failedLb: BridgeProviderRegistry = {
    ...setup.registry,
    profiles: {
      ...setup.registry.profiles,
      'codex-lb': {
        ...setup.registry.profiles['codex-lb'],
        credential: {
          ...setup.registry.profiles['codex-lb'].credential,
          state: 'rejected',
          blockers: ['codex_lb_credential_rejected']
        },
        state: 'blocked',
        blockers: ['codex_lb_credential_rejected']
      }
    }
  };
  const lb = resolveBridgeRequestRoute({ model: 'vendor/lb-slash-model' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: failedLb
  });
  assert.equal(lb.ok, false);
  assert.deepEqual(lb.blockers, ['codex_lb_route_not_ready']);
  const openrouter = resolveBridgeRequestRoute({ model: 'openrouter-noslash' }, setup.policy, {
    route_index: setup.build.route_index,
    registry: failedLb
  });
  assert.equal(openrouter.ok, true);
  assert.equal(openrouter.route?.provider_id, 'openrouter');
});

function disable(registry: BridgeProviderRegistry, providerId: BridgeProviderId): BridgeProviderRegistry {
  const profile = registry.profiles[providerId];
  return {
    ...registry,
    profiles: {
      ...registry.profiles,
      [providerId]: { ...profile, enabled: false, state: 'disabled' }
    }
  };
}
