import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { BridgeRoutingPolicy } from '../bridge-contracts.js';
import { applyOfficialModelPassthrough, OFFICIAL_MODEL_ID_PATTERN, validateBridgeRoutingPolicy } from '../provider-route-policy.js';
import { validateRouting } from '../bridge-runtime-validation/status.js';
import {
  defaultDesktopBridgeServiceSettings,
  desktopBridgeSkewRestartSuppressed,
  DESKTOP_BRIDGE_SKEW_RESTART_COOLDOWN_MS,
  resolveEffectiveOfficialModelsMode,
} from '../desktop-service.js';
import { serializedSettings } from '../desktop-controller-v3/shared.js';
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

test('status routing accepts official openai targets including gpt-5.6-luna', () => {
  const flipped = applyOfficialModelPassthrough(policyFixture(), {
    mode: 'passthrough',
    changedAt: '2026-08-23T01:00:00.000Z',
  });
  const issues: string[] = [];
  validateRouting({
    policy: flipped,
    selected_model: 'gpt-5.6-luna',
    selected_route: flipped.model_routes['gpt-5.6-luna'],
    session_pin: null,
    fallback: 'none',
    blockers: [],
    warnings: [],
  }, '$.routing', issues);
  assert.deepEqual(issues, []);
  assert.equal(flipped.model_routes['gpt-5.6-luna']!.provider_id, 'openai');
});

test('status routing still rejects unknown route provider ids', () => {
  const issues: string[] = [];
  validateRouting({
    policy: null,
    selected_model: 'gpt-5.6-luna',
    selected_route: { provider_id: 'not-a-provider', upstream_model: 'gpt-5.6-luna' },
    session_pin: null,
    fallback: 'none',
    blockers: [],
    warnings: [],
  }, '$.routing', issues);
  assert.ok(issues.includes('$.routing.selected_route.provider_id:enum'));
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

test('official-models mode defaults to auto and explicit choices are durable', async () => {
  // The settings default: no operator choice yet.
  assert.equal(defaultDesktopBridgeServiceSettings().official_passthrough.models, 'auto');

  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-official-mode-'));
  try {
    const codexHome = path.join(home, '.codex');
    await fsp.mkdir(codexHome, { recursive: true });

    // Explicit choices win regardless of host auth — a gateway operator's pick
    // is never flipped by an update, and a passthrough pick needs no auth probe.
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'gateway' }, { home }), 'gateway');
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'passthrough' }, { home }), 'passthrough');
    // Disabled passthrough can never serve official traffic.
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: false, models: 'passthrough' }, { home }), 'gateway');

    // auto with no auth.json (gateway/API-key era machine) stays on the gateway.
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'auto' }, { home }), 'gateway');
    // auto with ChatGPT OAuth follows the operator identity.
    await fsp.writeFile(path.join(codexHome, 'auth.json'), `${JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: { access_token: 'a', refresh_token: 'r', id_token: 'i', account_id: 'acct' },
    })}\n`, { mode: 0o600 });
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'auto' }, { home }), 'passthrough');
    assert.equal(await resolveEffectiveOfficialModelsMode(null, { home }), 'passthrough');
    // Registering + enabling codex-lb IS choosing the gateway: auto keeps the
    // registered provider serving even on a ChatGPT-OAuth host, and
    // un-registering ("인증을 풀면") converges back onto the official identity.
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'auto' }, { home, codexLbRegistered: true }), 'gateway');
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'auto' }, { home, codexLbRegistered: false }), 'passthrough');
    // An explicit pin still beats registration in both directions.
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'passthrough' }, { home, codexLbRegistered: true }), 'passthrough');
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'gateway' }, { home, codexLbRegistered: false }), 'gateway');
    // API-key auth resolves auto to the gateway (passthrough would 401).
    await fsp.writeFile(path.join(codexHome, 'auth.json'), `${JSON.stringify({
      auth_mode: 'apikey', OPENAI_API_KEY: 'sk-test-not-a-real-key',
    })}\n`, { mode: 0o600 });
    assert.equal(await resolveEffectiveOfficialModelsMode({ enabled: true, models: 'auto' }, { home }), 'gateway');
  } finally {
    await fsp.rm(home, { recursive: true, force: true });
  }
});

test('a pinned official-models choice survives the sync settings serializer', () => {
  // Field evidence from this machine: the catalog-sync writer (serializedSettings
  // via migrateDesktopBridgeConfig metadata updates) enumerated settings keys
  // and silently dropped official_passthrough — so an explicit gateway pin was
  // erased on the next sync, which is exactly the durability the setting
  // exists to provide. Every settings writer must round-trip the field.
  const pinned = defaultDesktopBridgeServiceSettings({
    official_passthrough: { enabled: true, base_url: 'https://chatgpt.com/backend-api/codex', models: 'gateway' },
  });
  const persisted = JSON.parse(serializedSettings(pinned)) as { official_passthrough?: { models?: string } };
  assert.equal(persisted.official_passthrough?.models, 'gateway');
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
