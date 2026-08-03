import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compactOpenRouterModelsResult,
  listOpenRouterModels,
  OPENROUTER_MODEL_IDS_MAX_OUTPUT_BYTES,
  testOpenRouterConnection
} from '../openrouter-account.js';

test('OpenRouter account contracts use bearer auth and normalize bounded model rows', async () => {
  const key = 'sk-or-v1-fixture-account-key-abcdefghijklmnop';
  const calls: Array<{ url: string; authorization: string }> = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: String((init?.headers as Record<string, string>)?.Authorization || '') });
    if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { label: 'fixture' } }), { status: 200 });
    return new Response(JSON.stringify({
      data: [
        {
          id: 'openai/gpt-5.6-sol',
          name: 'GPT 5.6 Sol',
          context_length: 400000,
          pricing: { prompt: '0.000001', completion: '0.000002', ignored: { nested: true } },
          supported_parameters: ['tools', 'reasoning', 'response_format'],
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] }
        },
        { id: 'vendor/second', name: 'Second', context_length: 10 }
      ]
    }), { status: 200 });
  };
  const env = { HOME: '/tmp/openrouter-account-home', OPENROUTER_API_KEY: key } as NodeJS.ProcessEnv;

  const models = await listOpenRouterModels({ env, fetchImpl: fetchImpl as typeof fetch, limit: 1 });
  assert.equal(models.ok, true);
  assert.equal(models.model_count, 1);
  assert.equal(models.source_model_count, 2);
  assert.equal(models.truncated, true);
  assert.deepEqual(models.models[0], {
    id: 'openai/gpt-5.6-sol',
    name: 'GPT 5.6 Sol',
    context_length: 400000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['tools', 'reasoning', 'response_format'],
    features: {
      tools: true,
      reasoning: true,
      structured_outputs: true,
      vision: true,
      audio: false,
      input_modalities: ['text', 'image'],
      output_modalities: ['text']
    }
  });

  const tested = await testOpenRouterConnection({
    env,
    fetchImpl: fetchImpl as typeof fetch,
    model: 'openai/gpt-5.6-sol'
  });
  assert.equal(tested.ok, true);
  assert.equal(tested.key_accepted, true);
  assert.equal(tested.model_exists, true);
  assert.equal(calls.every((call) => call.authorization === `Bearer ${key}`), true);
  assert.equal(calls.some((call) => call.url.endsWith('/key')), true);
  assert.equal(calls.some((call) => call.url.endsWith('/models')), true);

  const compact = compactOpenRouterModelsResult(models);
  assert.equal(compact.schema, 'sks.openrouter-model-ids.v1');
  assert.deepEqual(compact.models, ['openai/gpt-5.6-sol']);
  assert.equal(compact.catalog_model_count, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(compact, null, 2), 'utf8') <= OPENROUTER_MODEL_IDS_MAX_OUTPUT_BYTES);
});

test('OpenRouter ids-only catalog stays below the Menu Bar output ceiling', () => {
  const rows = Array.from({ length: 1_000 }, (_, index) => ({
    id: `provider/${String(index).padStart(4, '0')}-${'x'.repeat(170)}`
  }));
  const compact = compactOpenRouterModelsResult({
    schema: 'sks.openrouter-models.v1',
    generated_at: '2026-07-22T00:00:00.000Z',
    ok: true,
    authenticated: true,
    models: rows as any,
    model_count: rows.length,
    source_model_count: rows.length,
    truncated: false,
    blockers: [],
    warnings: []
  }, 4_096);
  assert.equal(compact.models.length < rows.length, true);
  assert.equal(compact.truncated, true);
  assert.ok(compact.warnings.includes('openrouter_model_ids_truncated_for_client'));
  assert.ok(Buffer.byteLength(JSON.stringify(compact, null, 2), 'utf8') <= 4_096);
});

test('OpenRouter connection test fails closed and redacts rejected key material', async () => {
  const key = 'sk-or-v1-rejected-secret-abcdefghijklmnop';
  const result = await testOpenRouterConnection({
    env: { HOME: '/tmp/openrouter-rejected-home', OPENROUTER_API_KEY: key },
    model: 'openai/gpt-5.6-sol',
    fetchImpl: (async () => new Response(`api_key=${key}`, { status: 401 })) as typeof fetch
  });
  assert.equal(result.ok, false);
  assert.equal(result.key_accepted, false);
  assert.ok(result.blockers.includes('glm_openrouter_unauthorized'));
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('OpenRouter catalog is withdrawn and never claims authentication when /key rejects the saved key', async () => {
  const key = 'sk-or-v1-rejected-catalog-key-abcdefghijklmnop';
  const fetchImpl = async (input: string | URL | Request) => String(input).endsWith('/key')
    ? new Response(`api_key=${key}`, { status: 401 })
    : new Response(JSON.stringify({ data: [{ id: 'z-ai/glm-5.2', name: 'GLM 5.2' }] }), { status: 200 });
  const result = await listOpenRouterModels({
    env: { HOME: '/tmp/openrouter-catalog-rejected', OPENROUTER_API_KEY: key },
    fetchImpl: fetchImpl as typeof fetch
  });
  assert.equal(result.ok, false);
  assert.equal(result.authenticated, false);
  assert.deepEqual(result.models, []);
  assert.ok(result.blockers.includes('openrouter_authentication_failed:glm_openrouter_unauthorized'));
  assert.equal(result.authentication_error?.status, 401);
  assert.equal(JSON.stringify(result).includes(key), false);
});

test('OpenRouter model test proves the requested model exists instead of returning offline success', async () => {
  const fetchImpl = async (input: string | URL | Request) => String(input).endsWith('/key')
    ? new Response('{}', { status: 200 })
    : new Response(JSON.stringify({ data: [{ id: 'vendor/other', name: 'Other' }] }), { status: 200 });
  const result = await testOpenRouterConnection({
    env: { HOME: '/tmp/openrouter-missing-model', OPENROUTER_API_KEY: 'sk-or-v1-model-check-abcdefghijklmnop' },
    model: 'openai/gpt-5.6-sol',
    fetchImpl: fetchImpl as typeof fetch
  });
  assert.equal(result.ok, false);
  assert.equal(result.key_accepted, true);
  assert.equal(result.model_exists, false);
  assert.ok(result.blockers.includes('openrouter_model_not_found'));
});
