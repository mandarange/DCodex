import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHITECTURE_HARDENING_CONTRACT_VERSION, type ProviderPolicySnapshot } from '../../../architecture-hardening/contracts/contracts.js';
import {
  classifyProviderRouteFailure,
  decideProviderRoute,
  emptyProviderCatalogForCredential,
  resolveCredentialForRoute
} from '../provider-router.js';

function policy(mode: ProviderPolicySnapshot['mode']): ProviderPolicySnapshot {
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

test('mode, key state and model family are enforced without fallback', () => {
  for (const mode of ['chatgpt-oauth', 'codex-lb', 'openrouter'] as const) {
    const model = mode === 'openrouter' ? 'anthropic/claude-sonnet-4' : 'gpt-5.6-codex';
    assert.equal(decideProviderRoute({ policy: policy(mode), credential: { status: 'ready', reason_code: null }, requestedMode: mode, model }).ok, true);
    assert.deepEqual(decideProviderRoute({ policy: policy(mode), credential: { status: 'not_found', reason_code: 'credential_not_found' }, requestedMode: mode, model }).blockers, ['provider_route_credential_not_found']);
  }
  assert.deepEqual(decideProviderRoute({ policy: policy('codex-lb'), credential: { status: 'ready', reason_code: null }, requestedMode: 'openrouter', model: 'gpt-5.6-codex' }).blockers, ['provider_route_cross_mode_forbidden']);
  assert.deepEqual(decideProviderRoute({ policy: policy('openrouter'), credential: { status: 'ready', reason_code: null }, requestedMode: 'openrouter', model: 'gpt-5.6-codex' }).blockers, ['provider_route_model_family_mismatch']);
});

test('credential resolution reads only the selected credential class', async () => {
  const reads: string[] = [];
  const decision = decideProviderRoute({ policy: policy('openrouter'), credential: { status: 'ready', reason_code: null }, requestedMode: 'openrouter', model: 'anthropic/claude-sonnet-4' });
  const value = await resolveCredentialForRoute(decision, {
    readCredential: async (credentialClass) => {
      reads.push(credentialClass);
      return 'ephemeral-secret';
    }
  });
  assert.equal(value, 'ephemeral-secret');
  assert.deepEqual(reads, ['openrouter-api-key']);
});

test('revoked credentials withdraw models and quota/5xx never permit account failover', () => {
  assert.deepEqual(emptyProviderCatalogForCredential({ mode: 'codex-lb', credential: { status: 'locked', reason_code: 'keychain_locked' }, models: ['gpt-5.6-codex'] }), []);
  assert.equal(classifyProviderRouteFailure(429).failover_allowed, false);
  assert.equal(classifyProviderRouteFailure(503).retry_allowed, false);
});
