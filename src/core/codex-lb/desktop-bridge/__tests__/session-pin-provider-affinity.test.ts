import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBridgeRequestRoute } from '../security.js';
import type { BridgeRoutingPolicy, ProviderSessionPin } from '../../bridge-contracts.js';

const policy: BridgeRoutingPolicy = { schema: 'sks.bridge-routing-policy.v1', default_provider_id: null, fallback: 'none', model_routes: { public: { provider_id: 'openrouter', upstream_model: 'vendor/public' } }, catalog_generation: 'catalog-1', policy_generation: 'policy-1', changed_at: '2026-08-05T00:00:00.000Z' };
const pin: ProviderSessionPin = { thread_id: 'thread-1', provider_id: 'openrouter', public_model: 'public', upstream_model: 'vendor/public', catalog_generation: 'catalog-1', route_policy_generation: 'policy-1', created_at: '2026-08-05T00:00:00.000Z' };
const request = { public_model: 'public', session_id: 'thread-1', pathname: '/v1/responses', transport: 'http' as const, headers: {} };

test('session pin preserves exact provider/model/generations', () => {
  const route = resolveBridgeRequestRoute(request, policy, [pin]);
  assert.equal(route.provider_id, 'openrouter'); assert.equal(route.upstream_model, 'vendor/public'); assert.equal(route.session_pin, pin);
});

test('stale, changed, and unknown session pins fail instead of silently moving providers', () => {
  assert.throws(() => resolveBridgeRequestRoute(request, { ...policy, policy_generation: 'policy-2' }, [pin]), /session_pin_route_unavailable/);
  assert.throws(() => resolveBridgeRequestRoute(request, { ...policy, model_routes: { public: { provider_id: 'codex-lb', upstream_model: 'different' } } }, [pin]), /session_pin_route_unavailable/);
  assert.throws(() => resolveBridgeRequestRoute({ ...request, session_id: 'missing' }, policy, [pin]), /session_pin_route_unavailable/);
});
