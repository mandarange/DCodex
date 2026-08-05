import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';
import {
  DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS,
  buildCalloutPrompt,
  createCodexAppImagegenAdapter,
  generateGptImage2CalloutReview,
  imagegenCapabilityBlocker
} from '../../dist/core/image-ux-review/imagegen-adapter.js';

const ONE_PX_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/l/5gVQAAAABJRU5ErkJggg==';

test('image generation preserves the app-native path and documented timeout', async () => {
  assert.equal(DEFAULT_IMAGEGEN_FETCH_TIMEOUT_MS, 180000);
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
  const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
    imagegenRequest(imagePath, path.join(root, 'out')),
    { capability: { codexAppAvailable: true, env: { HOME: root }, desktopBridgeStatus: null } }
  ));
  assert.equal(result.ok, false);
  assert.equal(result.provider, 'codex_app_imagegen');
  assert.equal(result.blocker, 'codex_app_imagegen_output_missing');
});

test('managed ImageGen fails closed without an explicit current-route model', async () => {
  const { root, imagePath } = await tempImageRoot('sks-bridge-imagegen-model-missing-');
  const outputDir = path.join(root, 'out');
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected fetch'); };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      bridgeOptions(root, null)
    ));
    const response = JSON.parse(await fs.readFile(path.join(outputDir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'desktop_bridge_imagegen_model_missing');
    assert.equal(calls, 0);
    assert.equal(response.setup_guidance, 'Run `sks bridge status --json` to inspect Desktop Bridge provider readiness.');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('managed ImageGen sends only the explicit public model to verified Desktop Bridge loopback', async () => {
  const { root, imagePath } = await tempImageRoot('sks-bridge-imagegen-loopback-');
  const outputDir = path.join(root, 'out');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: { ...(init?.headers || {}) },
      body: JSON.parse(String(init?.body || '{}'))
    });
    return imageResponse('bridge-image-1');
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      bridgeOptions(root)
    ));
    const response = JSON.parse(await fs.readFile(path.join(outputDir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'desktop_bridge_responses_image_generation');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:18765/backend-api/codex/responses');
    assert.equal(calls[0].headers['x-sks-model'], 'public-image-model');
    assert.equal(calls[0].headers.authorization, undefined);
    assert.equal(calls[0].headers['X-Codex-LB-API-Key'], undefined);
    assert.equal(calls[0].body.model, 'public-image-model');
    assert.equal(response.evidence_class, 'mock_fixture');
    assert.equal(response.output_source, null);
    assert.equal(response.desktop_bridge_route_provider, 'codex-lb');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('ambient provider secrets never override a managed Desktop Bridge route', async () => {
  const { root, imagePath } = await tempImageRoot('sks-bridge-imagegen-ambient-secret-');
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: { ...(init?.headers || {}) } });
    return imageResponse('bridge-image-2');
  };
  try {
    const result = await withoutImagegenOutputEnv(async () => {
      process.env.OPENAI_API_KEY = 'ambient-openai-secret';
      process.env.CODEX_LB_API_KEY = 'ambient-provider-secret';
      return generateGptImage2CalloutReview(
        imagegenRequest(imagePath, path.join(root, 'out')),
        bridgeOptions(root)
      );
    });
    assert.equal(result.ok, true);
    assert.equal(calls[0].url, 'http://127.0.0.1:18765/backend-api/codex/responses');
    assert.doesNotMatch(JSON.stringify(calls[0]), /ambient-openai-secret|ambient-provider-secret/);
    assert.equal(calls[0].headers.authorization, undefined);
  } finally {
    delete process.env.CODEX_LB_API_KEY;
    globalThis.fetch = previousFetch;
  }
});

test('partial-only Desktop Bridge SSE output is never generated or live evidence', async () => {
  const { root, imagePath } = await tempImageRoot('sks-bridge-imagegen-partial-');
  const outputDir = path.join(root, 'out');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody([
    {
      type: 'response.image_generation_call.partial_image',
      item_id: 'partial-image',
      partial_image_b64: ONE_PX_PNG
    },
    { type: 'response.completed', response: { id: 'partial-response', status: 'completed', output: [] } }
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, outputDir),
      bridgeOptions(root)
    ));
    const response = JSON.parse(await fs.readFile(path.join(outputDir, 'image-ux-gpt-image-2-response.json'), 'utf8'));
    assert.equal(result.ok, false);
    assert.equal(result.blocker, 'missing_b64_image_output');
    assert.notEqual(response.evidence_class, 'codex_lb_provider_imagegen');
    assert.equal(response.payload_summary.image_output_partial_frame, true);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('explicit non-managed OpenAI fallback still retries rate limits', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-openai-retry-');
  let calls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls <= 2) {
      return new Response(JSON.stringify({ error: { type: 'rate_limit_exceeded', message: 'slow down' } }), {
        status: 429,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ data: [{ b64_json: ONE_PX_PNG }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, path.join(root, 'out')),
      {
        capability: { codexBin: path.join(root, 'missing-codex'), env: { HOME: root }, desktopBridgeStatus: null },
        openai: { apiKey: 'explicit-openai-key', retrySleep: async () => {} },
        allowApiFallback: true
      }
    ));
    assert.equal(calls, 3);
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'openai_images_api');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('OPENAI_API_KEY alone never auto-enables the non-managed fallback', async () => {
  const { root, imagePath } = await tempImageRoot('sks-imagegen-no-auto-openai-');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('unexpected OpenAI fallback fetch'); };
  try {
    const result = await withoutImagegenOutputEnv(() => generateGptImage2CalloutReview(
      imagegenRequest(imagePath, path.join(root, 'out')),
      {
        capability: { codexBin: path.join(root, 'missing-codex'), env: { HOME: root }, desktopBridgeStatus: null },
        openai: { apiKey: 'explicit-but-not-enabled' }
      }
    ));
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'codex_app_imagegen');
    assert.equal(result.blocker, 'imagegen_capability_missing');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

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

function bridgeOptions(root, model = 'public-image-model') {
  return {
    capability: {
      codexBin: path.join(root, 'missing-codex'),
      timeoutMs: 100,
      env: { HOME: root },
      desktopBridgeStatus: bridgeStatus()
    },
    openai: model ? { responsesModel: model, retrySleep: async () => {} } : { retrySleep: async () => {} }
  };
}

function bridgeStatus() {
  const imageCapability = { state: 'verified', blockers: [], warnings: [] };
  return {
    schema: 'sks.desktop-bridge-status.v3',
    checked_at: '2026-08-06T00:00:00.000Z',
    management: { managed: true, runtime: 'desktop-bridge', state: 'ready', reason: null },
    service: {
      state: 'ready',
      running: true,
      loopback_origin: 'http://127.0.0.1:18765',
      blockers: [],
      warnings: []
    },
    routing: {
      policy: {
        fallback: 'none',
        default_provider_id: 'codex-lb',
        model_routes: {
          'public-image-model': { provider_id: 'codex-lb', upstream_model: 'provider-image-model' }
        }
      }
    },
    providers: {
      'codex-lb': {
        enabled: true,
        credential: { state: 'ready', source: 'provider-store', blockers: [], warnings: [] },
        endpoint: { configured: true, origin_redacted: 'https://provider.invalid', auth_transport: 'authorization-bearer' },
        capabilities: { capabilities: { image_generation: imageCapability } }
      },
      openrouter: {
        enabled: false,
        credential: { state: 'not_configured', source: null, blockers: [], warnings: [] },
        capabilities: { capabilities: {} }
      }
    },
    catalog_sync: { state: 'verified', blockers: [], warnings: [] },
    readiness: { bridge_ready: true, blockers: [], warnings: [] },
    recovery_actions: []
  };
}

function imageResponse(id) {
  return new Response(JSON.stringify({
    id: `response-${id}`,
    output: [{ id, type: 'image_generation_call', status: 'completed', result: ONE_PX_PNG }]
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function sseBody(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n`).join('\n');
}

async function withoutImagegenOutputEnv(fn) {
  const previous = {
    openai: process.env.OPENAI_API_KEY,
    codexLb: process.env.CODEX_LB_API_KEY,
    output: process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT,
    fake: process.env.SKS_TEST_FAKE_IMAGEGEN
  };
  delete process.env.OPENAI_API_KEY;
  delete process.env.CODEX_LB_API_KEY;
  delete process.env.SKS_CODEX_APP_IMAGEGEN_OUTPUT;
  delete process.env.SKS_TEST_FAKE_IMAGEGEN;
  try {
    return await fn();
  } finally {
    restoreEnv('OPENAI_API_KEY', previous.openai);
    restoreEnv('CODEX_LB_API_KEY', previous.codexLb);
    restoreEnv('SKS_CODEX_APP_IMAGEGEN_OUTPUT', previous.output);
    restoreEnv('SKS_TEST_FAKE_IMAGEGEN', previous.fake);
  }
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
