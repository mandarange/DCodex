import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNativeFeaturePassthrough,
  buildProviderUpstreamHeaders,
  createNativeOpenAiTransportContract,
  preserveNativeMetadata
} from '../transport.js';

test('native OpenAI identity and loopback are mandatory', () => {
  const contract = createNativeOpenAiTransportContract({
    nativeProviderId: 'openai',
    mode: 'codex-lb',
    listenOrigin: 'http://127.0.0.1:55123'
  });
  assert.equal(contract.native_provider_id, 'openai');
  assert.throws(() => createNativeOpenAiTransportContract({ ...contract, nativeProviderId: 'openrouter', listenOrigin: contract.listen_origin }), /external_provider_forbidden/);
  assert.throws(() => createNativeOpenAiTransportContract({ nativeProviderId: 'openai', mode: 'codex-lb', listenOrigin: 'https://example.com' }), /loopback_required/);
});

test('user OAuth and inbound provider credentials are stripped before replacement', () => {
  const contract = createNativeOpenAiTransportContract({ nativeProviderId: 'openai', mode: 'codex-lb', listenOrigin: 'http://[::1]:55123' });
  const headers = buildProviderUpstreamHeaders(contract, {
    authorization: 'Bearer user-oauth',
    'x-codex-lb-api-key': 'stale',
    'content-type': 'application/json',
    'x-native-feature': 'responses'
  }, 'gateway-secret');
  assert.equal(headers.authorization, undefined);
  assert.equal(headers['x-codex-lb-api-key'], 'gateway-secret');
  assert.equal(headers['x-native-feature'], 'responses');
});

test('HTTP/WS policy and metadata preservation are mode-aware and byte-stable', () => {
  const lb = createNativeOpenAiTransportContract({ nativeProviderId: 'openai', mode: 'codex-lb', listenOrigin: 'http://localhost:55123' });
  const openRouter = createNativeOpenAiTransportContract({ nativeProviderId: 'openai', mode: 'openrouter', listenOrigin: 'http://127.0.0.1:55124' });
  assert.doesNotThrow(() => assertNativeFeaturePassthrough(lb, { protocol: 'websocket', path: '/backend-api/codex/responses' }));
  assert.throws(() => assertNativeFeaturePassthrough(openRouter, { protocol: 'websocket', path: '/api/v1/responses' }), /websocket_unsupported/);
  const metadata = { catalog: { model: 'gpt-5.6-codex' }, feature: ['image', 'search'] };
  assert.equal(JSON.stringify(preserveNativeMetadata(metadata)), JSON.stringify(metadata));
});
