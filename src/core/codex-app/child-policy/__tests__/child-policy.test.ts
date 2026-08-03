import assert from 'node:assert/strict';
import test from 'node:test';
import { ARCHITECTURE_HARDENING_CONTRACT_VERSION, type ProviderPolicySnapshot } from '../../../architecture-hardening/contracts/contracts.js';
import { createSessionPin } from '../../session-policy/session-pinning.js';
import { createChildPolicySnapshot, decideChildSelection } from '../child-policy.js';

function provider(mode: ProviderPolicySnapshot['mode'], models: readonly string[]): ProviderPolicySnapshot {
  const provisional: ProviderPolicySnapshot = {
    schema: 'sks.provider-policy-snapshot.v1', contract_version: ARCHITECTURE_HARDENING_CONTRACT_VERSION, mode,
    credential_class: mode === 'chatgpt-oauth' ? 'codex-native-oauth' : mode === 'codex-lb' ? 'codex-lb-api-key' : 'openrouter-api-key',
    allowed_models: models, child_policy_hash: '0'.repeat(64), catalog_version: 'catalog-v1'
  };
  const child = createChildPolicySnapshot(provisional, models);
  return { ...provisional, child_policy_hash: child.policy_hash };
}

test('OAuth owns allocation and rejects SKS model overrides', () => {
  const policy = provider('chatgpt-oauth', ['gpt-5.6-codex']);
  const child = createChildPolicySnapshot(policy);
  const session = createSessionPin({ sessionId: 'oauth-1', policy, model: 'gpt-5.6-codex' });
  assert.equal(decideChildSelection({ session, policy: child }).ok, true);
  assert.deepEqual(decideChildSelection({ session, policy: child, requestedModel: 'gpt-5.6-codex' }).blockers, ['child_policy_oauth_override_forbidden']);
});

test('LB dynamic selection and OpenRouter registration stay inside the parent snapshot', () => {
  const lbPolicy = provider('codex-lb', ['gpt-5.6-codex']);
  const lbChild = createChildPolicySnapshot(lbPolicy);
  const lbSession = createSessionPin({ sessionId: 'lb-1', policy: lbPolicy, model: 'gpt-5.6-codex', lbAffinityToken: 'account-affinity' });
  assert.equal(decideChildSelection({ session: lbSession, policy: lbChild }).owner, 'codex-lb');

  const orPolicy = provider('openrouter', ['anthropic/claude-sonnet-4']);
  const orChild = createChildPolicySnapshot(orPolicy, ['anthropic/claude-sonnet-4']);
  const orSession = createSessionPin({ sessionId: 'or-1', policy: orPolicy, model: 'anthropic/claude-sonnet-4' });
  assert.equal(decideChildSelection({ session: orSession, policy: orChild, requestedModel: 'anthropic/claude-sonnet-4' }).ok, true);
  assert.deepEqual(decideChildSelection({ session: orSession, policy: orChild, requestedModel: 'openai/gpt-5' }).blockers, ['child_policy_openrouter_model_unregistered']);
});
