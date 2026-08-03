import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHITECTURE_HARDENING_CONTRACT_VERSION, type ProviderPolicySnapshot } from '../../../architecture-hardening/contracts/contracts.js';
import { assertSessionRequest, createSessionPin, forkSessionPin, resumeSessionPin, sessionPinHash } from '../session-pinning.js';

function policy(mode: ProviderPolicySnapshot['mode'] = 'codex-lb'): ProviderPolicySnapshot {
  return {
    schema: 'sks.provider-policy-snapshot.v1', contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION, mode,
    credential_class: mode === 'codex-lb' ? 'codex-lb-api-key' : mode === 'openrouter' ? 'openrouter-api-key' : 'codex-native-oauth',
    allowed_models: mode === 'openrouter' ? ['anthropic/claude-sonnet-4'] : ['gpt-5.6-codex'], child_policy_hash: 'a'.repeat(64), catalog_version: 'catalog-v1'
  };
}

test('create, fork and resume preserve immutable provider snapshots', () => {
  const pin = createSessionPin({ sessionId: 'session-1', policy: policy(), model: 'gpt-5.6-codex', lbAffinityToken: 'opaque-affinity' });
  const fork = forkSessionPin(pin, 'session-2');
  assert.equal(Object.isFrozen(pin), true);
  assert.equal(fork.parent_session_id, pin.session_id);
  assert.equal(sessionPinHash(fork), sessionPinHash(fork));
  assert.equal(resumeSessionPin(fork, policy()).ok, true);
});

test('global mode changes, request switches, and restore mismatch block without changing the pin', () => {
  const pin = createSessionPin({ sessionId: 'session-1', policy: policy(), model: 'gpt-5.6-codex', lbAffinityToken: 'opaque-affinity' });
  assert.equal(resumeSessionPin(pin, policy('openrouter')).status, 'blocked');
  assert.throws(() => assertSessionRequest(pin, { mode: 'openrouter', model: pin.model, childPolicyHash: pin.child_policy_hash }), /mode_switch_forbidden/);
  assert.equal(resumeSessionPin(null, policy()).status, 'migration_required');
});

test('LB affinity is mandatory and account failure cannot be papered over by a new pin', () => {
  assert.throws(() => createSessionPin({ sessionId: 'session-1', policy: policy(), model: 'gpt-5.6-codex' }), /lb_affinity_required/);
});
