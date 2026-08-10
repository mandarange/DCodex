import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBridgeRequestRoute } from '../security.js';
import type { BridgeRoutingPolicy, ProviderSessionPin } from '../../bridge-contracts.js';

const policy: BridgeRoutingPolicy = { schema: 'sks.bridge-routing-policy.v1', default_provider_id: null, fallback: 'none', model_routes: { public: { provider_id: 'openrouter', upstream_model: 'vendor/public' }, alternate: { provider_id: 'codex-lb', upstream_model: 'vendor/alternate' } }, catalog_generation: 'catalog-1', policy_generation: 'policy-1', changed_at: '2026-08-05T00:00:00.000Z' };
const pin: ProviderSessionPin = { thread_id: 'thread-1', provider_id: 'openrouter', public_model: 'public', upstream_model: 'vendor/public', catalog_generation: 'catalog-1', route_policy_generation: 'policy-1', created_at: '2026-08-05T00:00:00.000Z' };
const request = { public_model: 'public', session_id: 'thread-1', pathname: '/v1/responses', transport: 'http' as const, headers: {} };

test('session pin preserves exact provider/model/generations', () => {
  const route = resolveBridgeRequestRoute(request, policy, [pin]);
  assert.equal(route.provider_id, 'openrouter'); assert.equal(route.upstream_model, 'vendor/public'); assert.equal(route.session_pin, pin);
});

test('first session request creates a provider pin and an explicit model change proposes its replacement', () => {
  const first = resolveBridgeRequestRoute({ ...request, session_id: 'thread-new' }, policy, []);
  assert.deepEqual(first.session_pin, {
    thread_id: 'thread-new',
    provider_id: 'openrouter',
    public_model: 'public',
    upstream_model: 'vendor/public',
    catalog_generation: 'catalog-1',
    route_policy_generation: 'policy-1',
    created_at: first.session_pin?.created_at,
  });
  assert.ok(Number.isFinite(Date.parse(first.session_pin?.created_at || '')));

  const changed = resolveBridgeRequestRoute({
    ...request,
    public_model: 'alternate',
  }, policy, [pin]);
  assert.equal(changed.provider_id, 'codex-lb');
  assert.equal(changed.upstream_model, 'vendor/alternate');
  assert.equal(changed.session_pin?.thread_id, 'thread-1');
  assert.equal(changed.session_pin?.public_model, 'alternate');
});

test('live forwarding canonicalizes public IDs exactly like route explain while preserving upstream case', () => {
  const casePolicy: BridgeRoutingPolicy = {
    ...policy,
    model_routes: {
      'gpt-5.6': { provider_id: 'openrouter', upstream_model: 'Vendor/GPT-5.6' },
    },
  };
  const resolved = resolveBridgeRequestRoute({
    ...request,
    public_model: '  GPT-5.6  ',
    session_id: 'thread-case',
  }, casePolicy, []);

  assert.equal(resolved.public_model, 'gpt-5.6');
  assert.equal(resolved.upstream_model, 'Vendor/GPT-5.6');
  assert.equal(resolved.session_pin?.public_model, 'gpt-5.6');
});

test('a changed same-model session pin fails instead of silently moving providers', () => {
  assert.throws(
    () => resolveBridgeRequestRoute(request, {
      ...policy,
      model_routes: { ...policy.model_routes, public: { provider_id: 'codex-lb', upstream_model: 'different' } }
    }, [pin]),
    /session_pin_route_unavailable/
  );
});

test('an aged session pin whose route is unchanged is re-pinned, not refused', () => {
  // `policy_generation` digests the whole route map, so a catalog change to any
  // *other* model ages this pin without touching the route it names. Refusing
  // there is what made long-lived sessions fail intermittently; the thread is
  // still owed openrouter/vendor/public, and it still gets exactly that.
  const aged = resolveBridgeRequestRoute(request, {
    ...policy,
    policy_generation: 'policy-2',
    model_routes: { ...policy.model_routes, alternate: { provider_id: 'codex-lb', upstream_model: 'vendor/alternate-v2' } }
  }, [pin]);

  assert.equal(aged.provider_id, 'openrouter');
  assert.equal(aged.upstream_model, 'vendor/public');
  // The context and the replacement pin both carry the live generations, so the
  // downstream re-check cannot reject the drift this just forgave.
  assert.equal(aged.route_policy_generation, 'policy-2');
  assert.equal(aged.session_pin?.route_policy_generation, 'policy-2');
  assert.equal(aged.session_pin?.thread_id, 'thread-1');
  assert.equal(aged.session_pin?.created_at, pin.created_at);
});
