import assert from 'node:assert/strict';
import test from 'node:test';
import { decideAuxiliaryOAuthRoute } from '../auxiliary-oauth-policy.js';
import {
  assertProviderSessionRequest,
  classifyPinnedProviderFailure,
  createProviderSessionPin,
  providerSessionStatus
} from '../provider-session-policy.js';

test('resume, fork, and child execution retain the session provider snapshot', () => {
  const parent = createProviderSessionPin({
    sessionId: 'parent', mode: 'openrouter', model: 'anthropic/claude-sonnet-4',
    allowedModels: ['anthropic/claude-sonnet-4'], createdAt: '2026-08-02T00:00:00.000Z'
  });
  const child = createProviderSessionPin({
    sessionId: 'child', mode: parent.mode, model: parent.model,
    allowedModels: parent.allowed_models, parent
  });
  assert.equal(child.parent_session_id, 'parent');
  assert.doesNotThrow(() => assertProviderSessionRequest(child, { mode: 'openrouter', model: parent.model }));
  assert.throws(() => assertProviderSessionRequest(child, { mode: 'codex-lb', model: 'gpt-5.6-codex' }), /mode_switch_forbidden/);
  assert.throws(() => createProviderSessionPin({
    sessionId: 'bad-fork', mode: 'codex-lb', model: 'gpt-5.6-codex',
    allowedModels: ['gpt-5.6-codex'], parent
  }), /fork_mode_mismatch/);
});

test('global default changes are visible without mutating an existing session', () => {
  const pin = createProviderSessionPin({ sessionId: 's1', mode: 'codex-lb', model: 'gpt-5.6-codex', allowedModels: ['gpt-5.6-codex'] });
  const status = providerSessionStatus({ pin, globalDefaultMode: 'openrouter' });
  assert.equal(status.status, 'pinned_while_default_changed');
  assert.equal(status.session_mode, 'codex-lb');
  assert.equal(status.new_session_default_mode, 'openrouter');
  assert.equal(providerSessionStatus({ pin: null, globalDefaultMode: 'openrouter' }).status, 'migration_required');
});

test('LB auth, quota, and upstream failures stop instead of silently failing over', () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const decision = classifyPinnedProviderFailure(status);
    assert.equal(decision.retry_allowed, false);
    assert.equal(decision.stop_session, true);
  }
});

test('auxiliary OAuth is feature-scoped, explicit, audited, and never changes session mode', () => {
  const contract = { feature: 'future-feature', request_path: '/future', protocol_verified: true, proxy_supported: false };
  assert.equal(decideAuxiliaryOAuthRoute({ mode: 'codex-lb', contract, oauthConnected: false, userAllowed: true }).status, 'oauth_required');
  assert.equal(decideAuxiliaryOAuthRoute({ mode: 'codex-lb', contract, oauthConnected: true, userAllowed: false }).status, 'permission_required');
  const routed = decideAuxiliaryOAuthRoute({ mode: 'codex-lb', contract, oauthConnected: true, userAllowed: true });
  assert.equal(routed.status, 'auxiliary_oauth');
  assert.equal(routed.session_mode_changed, false);
  assert.equal(routed.audit_event?.credential_path, 'chatgpt-oauth');
  assert.equal(decideAuxiliaryOAuthRoute({
    mode: 'codex-lb', contract: { ...contract, proxy_supported: true }, oauthConnected: true, userAllowed: true
  }).status, 'proxy_supported');
});
