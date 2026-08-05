import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBridgeRequestRoute } from '../security.js';
import type { BridgeRoutingPolicy } from '../../bridge-contracts.js';

const policy: BridgeRoutingPolicy = {
  schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
  model_routes: {
    'plain-openrouter-model': { provider_id: 'openrouter', upstream_model: 'vendor/model' },
    'lb/model-with-slash': { provider_id: 'codex-lb', upstream_model: 'lb-upstream' },
  },
  catalog_generation: 'catalog-1', policy_generation: 'policy-1', changed_at: '2026-08-05T00:00:00.000Z',
};

test('route index—not slash shape or default provider—selects the provider', () => {
  const base = { session_id: null, pathname: '/v1/responses', transport: 'http' as const, headers: {} };
  assert.equal(resolveBridgeRequestRoute({ ...base, public_model: 'plain-openrouter-model' }, policy, []).provider_id, 'openrouter');
  assert.equal(resolveBridgeRequestRoute({ ...base, public_model: 'lb/model-with-slash' }, policy, []).provider_id, 'codex-lb');
});

test('unknown routes fail explicitly and never use the default provider', () => {
  assert.throws(() => resolveBridgeRequestRoute({ public_model: 'unknown', session_id: null, pathname: '/v1/responses', transport: 'http', headers: {} }, policy, []), /catalog_model_route_missing/);
});
