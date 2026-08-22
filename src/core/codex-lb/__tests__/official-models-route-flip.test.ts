import assert from 'node:assert/strict';
import test from 'node:test';
import type { BridgeRoutingPolicy } from '../bridge-contracts.js';
import { applyOfficialModelPassthrough, OFFICIAL_MODEL_ID_PATTERN, validateBridgeRoutingPolicy } from '../provider-route-policy.js';
import { desktopBridgeSkewRestartSuppressed, DESKTOP_BRIDGE_SKEW_RESTART_COOLDOWN_MS } from '../desktop-service.js';
import { buildOfficialPassthroughHeaders, buildOfficialPassthroughWebSocketHeaders } from '../desktop-bridge/header-policy.js';
import { sha256Stable } from '../route-index.js';

function policyFixture(): BridgeRoutingPolicy {
  const modelRoutes = {
    'codex-auto-review': { provider_id: 'codex-lb' as const, upstream_model: 'codex-auto-review' },
    'codex-lb:gpt-5.6-sol': { provider_id: 'codex-lb' as const, upstream_model: 'gpt-5.6-sol' },
    'gpt-5.6-luna': { provider_id: 'codex-lb' as const, upstream_model: 'gpt-5.6-luna' },
    'gpt-5.6-sol': { provider_id: 'codex-lb' as const, upstream_model: 'gpt-5.6-sol' },
    'anthropic/claude-sonnet-4.5': { provider_id: 'openrouter' as const, upstream_model: 'anthropic/claude-sonnet-4.5' },
  };
  const semantic = {
    default_provider_id: 'codex-lb' as const,
    fallback: 'none' as const,
    model_routes: modelRoutes,
    catalog_generation: 'catalog-generation',
  };
  return {
    schema: 'sks.bridge-routing-policy.v1',
    ...semantic,
    policy_generation: sha256Stable(semantic),
    changed_at: '2026-08-23T00:00:00.000Z',
  };
}

test('official-model flip rewrites bare official ids only and regenerates the policy generation', () => {
  const policy = policyFixture();
  const flipped = applyOfficialModelPassthrough(policy, { mode: 'passthrough', changedAt: '2026-08-23T01:00:00.000Z' });
  assert.equal(flipped.model_routes['gpt-5.6-sol']!.provider_id, 'openai');
  assert.equal(flipped.model_routes['gpt-5.6-luna']!.provider_id, 'openai');
  // The prefixed spelling is the operator's explicit gateway pick.
  assert.equal(flipped.model_routes['codex-lb:gpt-5.6-sol']!.provider_id, 'codex-lb');
  // SKS-internal gateway models do not match the official family pattern.
  assert.equal(flipped.model_routes['codex-auto-review']!.provider_id, 'codex-lb');
  assert.equal(flipped.model_routes['anthropic/claude-sonnet-4.5']!.provider_id, 'openrouter');
  assert.notEqual(flipped.policy_generation, policy.policy_generation);
  // The regenerated policy self-validates: generation matches its semantics.
  assert.deepEqual(validateBridgeRoutingPolicy(flipped), []);
  // Gateway mode is the identity transform.
  assert.equal(applyOfficialModelPassthrough(policy, { mode: 'gateway' }), policy);
});

test('official model pattern separates official families from SKS-internal ids', () => {
  assert.ok(OFFICIAL_MODEL_ID_PATTERN.test('gpt-5.6-sol'));
  assert.ok(OFFICIAL_MODEL_ID_PATTERN.test('o3'));
  assert.ok(OFFICIAL_MODEL_ID_PATTERN.test('codex-mini-latest'));
  assert.ok(!OFFICIAL_MODEL_ID_PATTERN.test('codex-auto-review'));
  assert.ok(!OFFICIAL_MODEL_ID_PATTERN.test('anthropic/claude-sonnet-4.5'));
  assert.ok(!OFFICIAL_MODEL_ID_PATTERN.test('z-ai/glm-5.2'));
});

test('a supervised skew restart is suppressed only for the exact recently-restarted version pair', () => {
  const marker = { running: '9.1.1', installed: '9.2.0', at: '2026-08-23T00:00:00.000Z' };
  const now = Date.parse('2026-08-23T00:05:00.000Z');
  // The 2026-08-19 storm shape: the restart brought back the SAME stale code.
  assert.equal(desktopBridgeSkewRestartSuppressed(marker, '9.1.1', '9.2.0', now), true);
  // Either side moving means convergence is possible again.
  assert.equal(desktopBridgeSkewRestartSuppressed(marker, '9.2.0', '9.2.0', now), false);
  assert.equal(desktopBridgeSkewRestartSuppressed(marker, '9.1.1', '9.2.1', now), false);
  // Cooldown expiry re-allows one attempt.
  assert.equal(desktopBridgeSkewRestartSuppressed(marker, '9.1.1', '9.2.0', now + DESKTOP_BRIDGE_SKEW_RESTART_COOLDOWN_MS), false);
  assert.equal(desktopBridgeSkewRestartSuppressed(null, '9.1.1', '9.2.0', now), false);
});

test('official passthrough headers keep the client identity and never a bridge credential', () => {
  const headers = buildOfficialPassthroughHeaders({
    authorization: 'Bearer client-token',
    'chatgpt-account-id': 'acct-1',
    cookie: 'session=abc',
    'content-type': 'application/json',
    'x-codex-lb-api-key': 'must-die',
    'x-api-key': 'must-die',
    'x-forwarded-for': '10.0.0.1',
    'x-sks-model': 'internal',
    connection: 'keep-alive',
    host: '127.0.0.1:1234',
  }, 'chatgpt.com');
  assert.equal(headers.authorization, 'Bearer client-token');
  assert.equal(headers['chatgpt-account-id'], 'acct-1');
  assert.equal(headers.cookie, 'session=abc');
  assert.equal(headers.host, 'chatgpt.com');
  assert.equal(headers['x-codex-lb-api-key'], undefined);
  assert.equal(headers['x-api-key'], undefined);
  assert.equal(headers['x-forwarded-for'], undefined);
  assert.equal(headers['x-sks-model'], undefined);
  const ws = buildOfficialPassthroughWebSocketHeaders({
    authorization: 'Bearer client-token',
    'sec-websocket-key': 'k', 'sec-websocket-version': '13',
    connection: 'Upgrade', upgrade: 'websocket',
  }, 'chatgpt.com');
  assert.equal(ws.authorization, 'Bearer client-token');
  assert.equal(ws.connection, 'Upgrade');
  assert.equal(ws.upgrade, 'websocket');
  assert.equal(ws['sec-websocket-key'], 'k');
});
