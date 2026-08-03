import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ARCHITECTURE_HARDENING_CONTRACT_VERSION,
  ArchitectureContractError,
  assertProviderPolicyCompatible,
  assertSafeAuditProjection,
  jsonRoundTrip,
  parseProviderPolicySnapshot,
  stableArchitectureHash,
  validateArchitectureConfiguration,
  type ArchitectureConfiguration,
  type ProviderPolicySnapshot
} from '../contracts.js';

function policy(mode: ProviderPolicySnapshot['mode'] = 'codex-lb'): ProviderPolicySnapshot {
  return {
    schema: 'sks.provider-policy-snapshot.v1',
    contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION,
    mode,
    credential_class: mode === 'chatgpt-oauth' ? 'codex-native-oauth' : mode === 'codex-lb' ? 'codex-lb-api-key' : 'openrouter-api-key',
    allowed_models: mode === 'openrouter' ? ['anthropic/claude-sonnet-4'] : ['gpt-5.6-codex'],
    child_policy_hash: 'a'.repeat(64),
    catalog_version: 'catalog-v1'
  };
}

test('provider modes are exhaustive, exclusive, strict, and JSON stable', () => {
  for (const mode of ['chatgpt-oauth', 'codex-lb', 'openrouter'] as const) {
    const source = policy(mode);
    assert.deepEqual(parseProviderPolicySnapshot(jsonRoundTrip(source)), source);
    assert.equal(stableArchitectureHash(source), stableArchitectureHash(jsonRoundTrip(source)));
  }
  assert.throws(
    () => parseProviderPolicySnapshot({ ...policy(), mode: 'automatic' }),
    (error) => error instanceof ArchitectureContractError && error.code === 'provider_policy_mode_invalid'
  );
  assert.throws(
    () => parseProviderPolicySnapshot({ ...policy(), unexpected: true }),
    /provider_policy_unknown_field/
  );
});

test('mode, credential, child policy, catalog and allowlist mismatches fail with stable codes', () => {
  assert.throws(() => assertProviderPolicyCompatible(policy('codex-lb'), policy('openrouter')), /provider_policy_mode_mismatch/);
  assert.throws(
    () => assertProviderPolicyCompatible(policy(), { ...policy(), child_policy_hash: 'b'.repeat(64) }),
    /provider_policy_child_mismatch/
  );
  assert.throws(
    () => assertProviderPolicyCompatible(policy(), { ...policy(), catalog_version: 'catalog-v2' }),
    /provider_policy_catalog_mismatch/
  );
});

test('architecture configuration rejects credential material at the schema boundary', () => {
  const configuration: ArchitectureConfiguration = {
    schema: 'sks.architecture-configuration.v1',
    policy: policy(),
    credential: { status: 'ready', reason_code: null },
    catalog: {
      schema: 'sks.catalog-snapshot.v1',
      version: 'catalog-v1',
      models: ['gpt-5.6-codex'],
      checked_at: '2026-08-02T00:00:00.000Z'
    },
    features: []
  };
  assert.deepEqual(validateArchitectureConfiguration(jsonRoundTrip(configuration)), configuration);
  assert.throws(() => assertSafeAuditProjection({ nested: { credential_fingerprint: 'nope' } }), /audit_projection_prohibited_field/);
  assert.throws(
    () => validateArchitectureConfiguration({ ...configuration, api_key: 'must-not-cross-boundary' }),
    /architecture_configuration_unknown_field/
  );
});

test('audit projections reject cyclic and excessively deep structures with stable codes', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => assertSafeAuditProjection(cyclic), /audit_projection_cycle/);

  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < 66; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.next = next;
    cursor = next;
  }
  assert.throws(() => assertSafeAuditProjection(root), /audit_projection_depth_exceeded/);
});
