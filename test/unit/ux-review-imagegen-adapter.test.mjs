import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';
import { DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS, buildCalloutPrompt, createCodexAppImagegenAdapter, generateGptImage2CalloutReview, imagegenCapabilityBlocker } from '../../dist/core/image-ux-review/imagegen-adapter.js';

test('image generation allows the documented two-minute complex prompt window by default', () => {
  assert.equal(DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS, 180000);
});

test('Codex App imagegen adapter blocks honestly when host capability is unavailable', async () => {
  const adapter = createCodexAppImagegenAdapter();
  assert.equal(adapter.model, 'gpt-image-2');
  assert.equal(adapter.available, false);
  const result = await adapter.generateCalloutReview({});
  assert.equal(result.blocker, 'imagegen_capability_missing');
  assert.equal(imagegenCapabilityBlocker().model, 'gpt-image-2');
  assert.match(buildCalloutPrompt('screen-1'), /Text-only response is invalid/);
});

test('Codex App imagegen reports missing generated output separately from missing capability', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-imagegen-output-missing-');
  const outputDir = path.join(root, 'out');
  const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
    mission_id: null,
    source_screen_id: 'screen-1',
    source_image_path: imagePath,
    output_dir: outputDir,
    prompt: buildCalloutPrompt('screen-1'),
    requested_fidelity: 'original',
    privacy: 'local-only'
  }, {
    capability: { codexAppAvailable: true, env: { HOME: root }, configText: '', codexLbEnvText: '' },
    openai: { apiKey: null }
  }));

  assert.equal(result.ok, false);
  assert.equal(result.provider, 'codex_app_imagegen');
  assert.equal(result.blocker, 'codex_app_imagegen_output_missing');
});

// codex-lb is not a detour around Codex: when it is the selected provider,
// Codex App's own $imagegen answers through that same proxy, so requiring an
// opt-in flag there left the only reachable path switched off. The escape hatch
// is the explicit disable, which must still keep every request local.
test('gpt-image-2 does not call codex-lb when the fallback is explicitly disabled', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-no-silent-fallback-');
  const outputDir = path.join(root, 'out');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('unexpected fetch fallback');
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      allowCodexLbApiFallback: false,
      capability: {
        codexBin: path.join(root, 'missing-codex'),
        timeoutMs: 100,
        env: { HOME: root },
        codexLbEnvText: 'CODEX_LB_API_KEY=sk-clb-test\n',
        configText: codexLbConfig()
      },
      openai: { codexLbApiKey: 'sk-clb-test' }
    }));
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'codex_app_imagegen');
    assert.equal(result.blocker, 'imagegen_capability_missing');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('gpt-image-2 fallback uses codex-lb key only when explicitly enabled', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-imagegen-');
  const outputDir = path.join(root, 'out');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: init?.headers?.authorization || init?.headers?.Authorization || '' });
    return new Response(JSON.stringify({
      id: 'resp_lb_1',
      output: [{
        id: 'ig_lb_1',
        type: 'image_generation_call',
        status: 'completed',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg=='
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: {
        codexBin: path.join(root, 'missing-codex'),
        timeoutMs: 100,
        env: { HOME: root },
        codexLbEnvText: 'CODEX_LB_API_KEY=sk-clb-test\n',
        configText: codexLbConfig()
      },
      openai: { codexLbApiKey: 'sk-clb-test', responsesModel: 'gpt-5.6-terra' },
      allowApiFallback: true,
      allowCodexLbApiFallback: true
    }));

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai_responses_image_generation');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://lb.example.test/backend-api/codex/responses');
    assert.equal(calls[0].authorization, 'Bearer sk-clb-test');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('selected codex-lb without a bound base URL fails closed before fetch', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-missing-base-url-');
  const outputDir = path.join(root, 'out');
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    throw new Error('codex-lb key must not be sent to a public fallback endpoint');
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: {
        codexBin: path.join(root, 'missing-codex'),
        timeoutMs: 100,
        env: { HOME: root },
        configText: codexLbConfig(),
        codexLbEnvText: ''
      },
      openai: { codexLbApiKey: 'sk-clb-test', responsesModel: 'gpt-5.6-terra' },
      allowApiFallback: true,
      allowCodexLbApiFallback: true
    }));

    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'codex_lb_base_url_missing');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('selecting codex-lb as the provider is enough to reach image generation', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-selected-imagegen-');
  const outputDir = path.join(root, 'out');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
    return new Response(JSON.stringify({
      id: 'resp_lb_2',
      output: [{
        id: 'ig_lb_2',
        type: 'image_generation_call',
        status: 'completed',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg=='
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // No SKS_IMAGEGEN_* opt-in and no explicit allow flag: provider selection alone.
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: {
        codexBin: path.join(root, 'missing-codex'),
        timeoutMs: 100,
        env: { HOME: root, CODEX_LB_API_KEY: 'sk-clb-test' },
        configText: codexLbConfig()
      },
      codexLbTarget: {
        selected: true,
        base_url: 'https://lb.example.test/backend-api/codex',
        api_key: 'sk-clb-test',
        api_key_source: 'env-file',
        model: 'gpt-5.6-sol',
        model_source: 'catalog_default',
        blocker: null
      }
    }));

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai_responses_image_generation');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://lb.example.test/backend-api/codex/responses');
    // The served catalog slug, not config.toml's `model`, which the key may not allow.
    assert.equal(calls[0].body.model, 'gpt-5.6-sol');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a selected codex-lb provider wins over an unrelated OPENAI_API_KEY', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-selected-with-openai-key-');
  const outputDir = path.join(root, 'out');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      authorization: init?.headers?.authorization || init?.headers?.Authorization || '',
      body: JSON.parse(String(init?.body || '{}'))
    });
    return new Response(JSON.stringify({
      id: 'resp_lb_3',
      output: [{
        id: 'ig_lb_3',
        type: 'image_generation_call',
        status: 'completed',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg=='
      }]
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await withoutImagegenOutputEnv(async () => {
      process.env.OPENAI_API_KEY = 'test-key';
      return generateGptImage2CalloutReview({
        mission_id: null,
        source_screen_id: 'screen-1',
        source_image_path: imagePath,
        output_dir: outputDir,
        prompt: buildCalloutPrompt('screen-1'),
        requested_fidelity: 'original',
        privacy: 'local-only'
      }, {
        capability: {
          codexBin: path.join(root, 'missing-codex'),
          timeoutMs: 100,
          env: { HOME: root, CODEX_LB_API_KEY: 'sk-clb-test' },
          configText: codexLbConfig()
        },
        codexLbTarget: {
          selected: true,
          base_url: 'https://lb.example.test/backend-api/codex',
          api_key: 'sk-clb-test',
          api_key_source: 'env-file',
          model: 'gpt-5.6-sol',
          model_source: 'catalog_default',
          blocker: null
        }
      });
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai_responses_image_generation');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://lb.example.test/backend-api/codex/responses');
    assert.equal(calls[0].authorization, 'Bearer sk-clb-test');
    assert.equal(calls[0].body.model, 'gpt-5.6-sol');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a final codex-lb SSE image is full evidence with stream provenance', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-final-sse-');
  const outputDir = path.join(root, 'out');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    {
      type: 'response.output_item.done',
      item: {
        id: 'ig_sse_final',
        type: 'image_generation_call',
        result: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg=='
      }
    },
    { type: 'response.completed', response: { id: 'resp_sse_final', status: 'completed', output: [] } }
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      selectedCodexLbOptions(root)
    ));
    const response = JSON.parse(await fs.readFile(path.join(outputDir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(response.evidence_class, 'codex_lb_provider_imagegen');
    assert.equal(response.image_output_recovered_from_stream, true);
    assert.equal(response.image_output_provenance, 'response.output_item.done');
    assert.equal(response.image_output_partial_frame, false);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('a partial-only codex-lb SSE image is not generated or full evidence', async () => {
  const { root, imagePath } = await tempImageRoot('sks-codex-lb-partial-sse-');
  const outputDir = path.join(root, 'out');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    {
      type: 'response.image_generation_call.partial_image',
      item_id: 'ig_sse_partial',
      partial_image_b64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg=='
    },
    { type: 'response.completed', response: { id: 'resp_sse_partial', status: 'completed', output: [] } }
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      selectedCodexLbOptions(root)
    ));
    const response = JSON.parse(await fs.readFile(path.join(outputDir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
    assert.equal(result.ok, false);
    assert.equal(result.generated_image_path, null);
    assert.equal(result.blocker, 'missing_b64_image_output');
    assert.notEqual(response.evidence_class, 'codex_lb_provider_imagegen');
    assert.equal(response.payload_summary.image_output_partial_frame, true);
    assert.equal(response.payload_summary.partial_image_output_present, true);
    assert.equal(response.payload_summary.output_count, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('gpt-image-2 retries a rate-limited OpenAI images call then succeeds', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-retry-429-');
  const outputDir = path.join(root, 'out');
  const onePxPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg==';
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (calls.length <= 2) {
      return new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: onePxPng }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: { codexBin: path.join(root, 'missing-codex'), timeoutMs: 100, env: { HOME: root }, configText: '', codexLbEnvText: '' },
      // Direct OpenAI key path is non-Codex evidence and must be explicit.
      openai: { apiKey: 'sk-test-openai-key', retrySleep: async () => {} },
      allowApiFallback: true
    }));

    assert.equal(calls.length, 3, 'should retry the two 429s before the 200');
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai_images_api');
    assert.ok(result.generated_image_path);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('gpt-image-2 does not auto-enable OpenAI API fallback from OPENAI_API_KEY alone', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-no-auto-openai-');
  const outputDir = path.join(root, 'out');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('unexpected OpenAI fallback fetch');
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: { codexBin: path.join(root, 'missing-codex'), timeoutMs: 100, env: { HOME: root }, configText: '', codexLbEnvText: '' },
      openai: { apiKey: 'sk-test-openai-key', retrySleep: async () => {} }
    }));

    assert.equal(result.ok, false);
    assert.equal(result.provider, 'codex_app_imagegen');
    assert.equal(result.blocker, 'imagegen_capability_missing');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('gpt-image-2 gives up after exhausting retries on persistent 503', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-retry-503-');
  const outputDir = path.join(root, 'out');
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } }), { status: 503, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview({
      mission_id: null,
      source_screen_id: 'screen-1',
      source_image_path: imagePath,
      output_dir: outputDir,
      prompt: buildCalloutPrompt('screen-1'),
      requested_fidelity: 'original',
      privacy: 'local-only'
    }, {
      capability: { codexBin: path.join(root, 'missing-codex'), timeoutMs: 100, env: { HOME: root }, configText: '', codexLbEnvText: '' },
      openai: { apiKey: 'sk-test-openai-key', retrySleep: async () => {} },
      allowApiFallback: true
    }));

    assert.equal(calls, 4, 'should attempt the policy max (4) before giving up');
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'openai_images_api');
    assert.equal(result.blocker, 'imagegen_remote_rate_limited');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('gpt-image-2 retries a timed-out response body and aborts every attempt', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-response-timeout-');
  const outputDir = path.join(root, 'out');
  const signals = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    signals.push(init.signal);
    return new Response(new ReadableStream({
      start() {}
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      {
        ...selectedCodexLbOptions(root),
        openai: { fetchTimeoutMs: 10, retrySleep: async () => {} }
      }
    ));

    assert.equal(signals.length, 4);
    assert.ok(signals.every((signal) => signal.aborted === true));
    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'imagegen_remote_timeout');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function codexLbConfig() {
  return `model_provider = "codex-lb"

[model_providers.codex-lb]
name = "OpenAI"
base_url = "https://lb.example.test/backend-api/codex"
wire_api = "responses"
env_key = "CODEX_LB_API_KEY"
supports_websockets = true
requires_openai_auth = true
`;
}

function imagegenRequest(imagePath, outputDir) {
  return {
    mission_id: null,
    source_screen_id: 'screen-1',
    source_image_path: imagePath,
    output_dir: outputDir,
    prompt: buildCalloutPrompt('screen-1'),
    requested_fidelity: 'original',
    privacy: 'local-only'
  };
}

function selectedCodexLbOptions(root) {
  return {
    capability: {
      codexBin: path.join(root, 'missing-codex'),
      timeoutMs: 100,
      env: { HOME: root, CODEX_LB_API_KEY: 'sk-clb-test' },
      configText: codexLbConfig()
    },
    codexLbTarget: {
      selected: true,
      base_url: 'https://lb.example.test/backend-api/codex',
      api_key: 'sk-clb-test',
      api_key_source: 'env-file',
      model: 'gpt-5.6-sol',
      model_source: 'catalog_default',
      blocker: null
    }
  };
}

function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n');
}

async function withoutImagegenOutputEnv(fn) {
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  const previousOutput = process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT;
  const previousFake = process.env.SKS_TEST_FAKE_IMAGEGEN;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT;
  delete process.env.SKS_TEST_FAKE_IMAGEGEN;
  try {
    return await fn();
  } finally {
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
    if (previousOutput === undefined) delete process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT;
    else process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT = previousOutput;
    if (previousFake === undefined) delete process.env.SKS_TEST_FAKE_IMAGEGEN;
    else process.env.SKS_TEST_FAKE_IMAGEGEN = previousFake;
  }
}
