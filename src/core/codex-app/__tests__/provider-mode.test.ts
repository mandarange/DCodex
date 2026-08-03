import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertProviderModeModel,
  codexProviderModeState,
  readExplicitCodexProviderMode,
  upsertExplicitCodexProviderMode
} from '../provider-mode.js';

test('exclusive provider mode must be explicit and keep the built-in OpenAI identity', () => {
  const config = upsertExplicitCodexProviderMode(
    'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:55000/api/v1"\n',
    'openrouter'
  );
  assert.equal(readExplicitCodexProviderMode(config).mode, 'openrouter');
  assert.deepEqual(codexProviderModeState(config).blockers, []);
  assert.equal(codexProviderModeState(config).auxiliary_oauth_required, true);

  const customProvider = config.replace('model_provider = "openai"', 'model_provider = "openrouter"');
  assert.deepEqual(codexProviderModeState(customProvider).blockers, ['provider_mode_requires_builtin_openai']);
});

test('mode markers fail closed on missing, duplicate, or invalid values', () => {
  assert.deepEqual(readExplicitCodexProviderMode('model_provider = "openai"\n').blockers, ['provider_mode_not_explicit']);
  assert.deepEqual(readExplicitCodexProviderMode(
    '# sks-managed-provider-mode:codex-lb\n# sks-managed-provider-mode:openrouter\n'
  ).blockers, ['provider_mode_marker_conflict']);
  assert.deepEqual(readExplicitCodexProviderMode('# sks-managed-provider-mode:auto\n').blockers, ['provider_mode_marker_invalid']);
});

test('model family and allowlist cannot cross provider modes', () => {
  assert.equal(assertProviderModeModel('codex-lb', 'gpt-5.6-codex', ['gpt-5.6-codex']), 'gpt-5.6-codex');
  assert.equal(assertProviderModeModel('openrouter', 'anthropic/claude-sonnet-4', ['anthropic/claude-sonnet-4']), 'anthropic/claude-sonnet-4');
  assert.throws(() => assertProviderModeModel('codex-lb', 'anthropic/claude-sonnet-4', ['anthropic/claude-sonnet-4']), /family_mismatch/);
  assert.throws(() => assertProviderModeModel('openrouter', 'gpt-5.6-codex', ['gpt-5.6-codex']), /family_mismatch/);
  assert.throws(() => assertProviderModeModel('openrouter', 'openai/gpt-5', ['anthropic/claude-sonnet-4']), /not_allowed/);
  assert.throws(() => assertProviderModeModel('openrouter', 'openai/gpt-5', []), /catalog_empty/);
});

test('OAuth mode rejects a leftover loopback instead of silently routing through it', () => {
  const config = upsertExplicitCodexProviderMode(
    'model_provider = "openai"\nopenai_base_url = "http://127.0.0.1:55000/backend-api/codex"\n',
    'chatgpt-oauth'
  );
  assert.deepEqual(codexProviderModeState(config).blockers, ['chatgpt_oauth_mode_loopback_still_configured']);
});
