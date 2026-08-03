import assert from 'node:assert/strict';
import test from 'node:test';
import { decideProviderChildModel } from '../provider-child-policy.js';
import { providerOperationResult } from '../provider-operation-stages.js';
import { createProviderSessionPin } from '../provider-session-policy.js';

test('child allocation has three independent provider strategies', () => {
  const oauth = createProviderSessionPin({ sessionId: 'oauth', mode: 'chatgpt-oauth', model: 'gpt-5.6', allowedModels: ['gpt-5.6'] });
  assert.equal(decideProviderChildModel({ session: oauth }).strategy, 'native-oauth');
  assert.equal(decideProviderChildModel({ session: oauth, requestedModel: 'gpt-5.6-mini' }).ok, false);

  const lb = createProviderSessionPin({ sessionId: 'lb', mode: 'codex-lb', model: 'gpt-5.6-sol', allowedModels: ['gpt-5.6-sol', 'gpt-5.6-terra'] });
  assert.equal(decideProviderChildModel({ session: lb, requestedModel: 'gpt-5.6-terra' }).ok, true);
  assert.equal(decideProviderChildModel({ session: lb, requestedModel: 'anthropic/claude-sonnet-4' }).ok, false);

  const or = createProviderSessionPin({ sessionId: 'or', mode: 'openrouter', model: 'anthropic/claude-sonnet-4', allowedModels: ['anthropic/claude-sonnet-4', 'google/gemini-2.5-pro'] });
  assert.equal(decideProviderChildModel({ session: or, requestedModel: 'google/gemini-2.5-pro', registeredOpenRouterModels: ['google/gemini-2.5-pro'] }).ok, true);
  assert.equal(decideProviderChildModel({ session: or, requestedModel: 'anthropic/claude-sonnet-4', registeredOpenRouterModels: ['google/gemini-2.5-pro'] }).ok, false);
});

test('provider operation is successful only after all four independently verified stages', () => {
  const stages = [
    { stage: 'config_saved', status: 'succeeded', reason: null },
    { stage: 'proxy_applied', status: 'failed', reason: 'bridge_not_running' },
    { stage: 'catalog_refreshed', status: 'succeeded', reason: null },
    { stage: 'new_session_ready', status: 'pending', reason: null }
  ] as const;
  const failed = providerOperationResult({ stages, existingSessionMode: 'codex-lb', newSessionMode: 'openrouter' });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.existing_session_unchanged, true);
  const complete = providerOperationResult({
    stages: stages.map((stage) => ({ ...stage, status: 'succeeded' as const, reason: null })),
    existingSessionMode: 'codex-lb', newSessionMode: 'openrouter'
  });
  assert.equal(complete.ok, true);
});
