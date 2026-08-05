import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ArchitectureContractError,
  MAX_AUDIT_PROJECTION_DEPTH,
  assertSafeAuditProjection,
  createSafeAuditProjection,
  decodeHistoricalSessionPinV1,
  stableArchitectureHash,
  validateCurrentProviderSessionPin,
  type HistoricalSessionPinDecodeContext,
  type HistoricalSessionPinV1
} from '../contracts.js';

const HASH = 'a'.repeat(64);

function historicalPin(overrides: Partial<HistoricalSessionPinV1> = {}): HistoricalSessionPinV1 {
  return {
    schema: 'sks.session-pin.v1',
    session_id: 'thread-123',
    mode: 'codex-lb',
    model: 'gpt-5.6-sol',
    credential_class: 'codex-lb-api-key',
    allowed_models: ['gpt-5.6-sol'],
    lb_affinity_token_hash: null,
    child_policy_hash: HASH,
    catalog_version: 'catalog-7',
    parent_session_id: null,
    ...overrides
  };
}

function decodeContext(overrides: Partial<HistoricalSessionPinDecodeContext> = {}): HistoricalSessionPinDecodeContext {
  return {
    current_provider_id: 'codex-lb',
    current_upstream_model: 'gpt-5.6-sol',
    current_catalog_generation: 'catalog-7',
    current_route_policy_generation: 'policy-9',
    expected_child_policy_hash: HASH,
    created_at: '2026-08-06T00:00:00.000Z',
    ...overrides
  };
}

test('historical session pin decodes only against explicit current bridge facts', () => {
  const result = decodeHistoricalSessionPinV1(historicalPin(), decodeContext());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.pin, {
    thread_id: 'thread-123',
    provider_id: 'codex-lb',
    public_model: 'gpt-5.6-sol',
    upstream_model: 'gpt-5.6-sol',
    catalog_generation: 'catalog-7',
    route_policy_generation: 'policy-9',
    created_at: '2026-08-06T00:00:00.000Z'
  });
  assert.equal(validateCurrentProviderSessionPin(result.pin), true);
});

test('historical session pin decoder fails closed for unsupported, stale, or lossy inputs', () => {
  assert.deepEqual(
    decodeHistoricalSessionPinV1(historicalPin({ mode: 'chatgpt-oauth', credential_class: 'codex-native-oauth' }), decodeContext()),
    { ok: false, pin: null, blocker: 'historical_session_pin_mode_unsupported' }
  );
  assert.equal(
    decodeHistoricalSessionPinV1(historicalPin({ parent_session_id: 'parent-1' }), decodeContext()).blocker,
    'historical_session_pin_semantics_unrepresentable'
  );
  assert.equal(
    decodeHistoricalSessionPinV1(historicalPin(), decodeContext({ current_catalog_generation: 'catalog-8' })).blocker,
    'historical_session_pin_catalog_stale'
  );
  assert.equal(
    decodeHistoricalSessionPinV1(historicalPin(), decodeContext({ current_provider_id: 'openrouter' })).blocker,
    'historical_session_pin_provider_mismatch'
  );
  assert.equal(
    decodeHistoricalSessionPinV1({ ...historicalPin(), unexpected: true }, decodeContext()).blocker,
    'historical_session_pin_unknown_field'
  );
});

test('current session pin validator rejects non-canonical or incomplete pins', () => {
  const decoded = decodeHistoricalSessionPinV1(historicalPin(), decodeContext());
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.equal(validateCurrentProviderSessionPin({ ...decoded.pin, public_model: 'GPT-5.6-SOL' }), false);
  assert.equal(validateCurrentProviderSessionPin({ ...decoded.pin, created_at: 'not-a-date' }), false);
  assert.equal(validateCurrentProviderSessionPin({ ...decoded.pin, extra: true }), false);
});

test('audit projection is deterministic JSON and strips object identity', () => {
  const source = { z: [{ b: true, a: null }], a: 'first', count: -0 };
  const projection = createSafeAuditProjection(source);
  assert.equal(JSON.stringify(projection), '{"a":"first","count":0,"z":[{"a":null,"b":true}]}');
  assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
  assert.notEqual(projection, source);
  assert.equal(stableArchitectureHash(source), stableArchitectureHash({ count: 0, a: 'first', z: [{ a: null, b: true }] }));
});

test('audit projection prohibits sensitive fields at any nesting level', () => {
  for (const field of ['api_key', 'openrouterApiKey', 'authorization', 'client-secret', 'access_token', 'credential_fingerprint']) {
    assert.throws(
      () => createSafeAuditProjection({ safe: { [field]: 'not-a-secret-value' } }),
      (error) => error instanceof ArchitectureContractError && error.code === 'audit_projection_prohibited_field'
    );
  }
});

test('audit projection rejects cycles, excess depth, and non-JSON values', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertSafeAuditProjection(cyclic), /audit_projection_cycle/);

  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index <= MAX_AUDIT_PROJECTION_DEPTH; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  assert.throws(() => assertSafeAuditProjection(root), /audit_projection_depth_exceeded/);
  assert.throws(() => assertSafeAuditProjection({ value: Number.NaN }), /audit_projection_number_invalid/);
  assert.throws(() => assertSafeAuditProjection({ value: undefined }), /audit_projection_value_unsupported/);
});
