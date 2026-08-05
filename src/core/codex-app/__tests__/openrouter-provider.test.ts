import test from 'node:test';
import assert from 'node:assert/strict';
import * as provider from '../openrouter-provider.js';

test('OpenRouter metadata is limited to shared Desktop Bridge model data', () => {
  assert.equal(provider.OPENROUTER_DEFAULT_MODEL, 'z-ai/glm-5.2');
  assert.equal('buildGlmCodexAppModelProfile' in provider, false);
  assert.equal('GLM_CODEX_CONFIG_PROVIDER_ID' in provider, false);
  assert.equal('OPENROUTER_DEFAULT_PROFILE_ID' in provider, false);
  assert.equal('OPENROUTER_SELECTABLE_REASONING_EFFORTS' in provider, false);
});

test('OpenRouter model normalization accepts catalog ids and rejects invalid values', () => {
  assert.equal(provider.normalizeOpenRouterModelId('z-ai/glm-5.2'), 'z-ai/glm-5.2');
  assert.equal(provider.normalizeOpenRouterModelId(''), null);
  assert.equal(provider.normalizeOpenRouterModelId('bad model'), null);
});
