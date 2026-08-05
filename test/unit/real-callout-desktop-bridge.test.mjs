import test from 'node:test';
import assert from 'node:assert/strict';
import { tempImageRoot } from '../helpers/ux-review-1-0-8-fixtures.mjs';
import { extractRealCallouts } from '../../dist/core/image-ux-review/real-callout-extractor.js';

test('callout extraction without a Codex session fails closed before network when no explicit bridge model exists', async () => {
  const { root, imagePath } = await tempImageRoot('sks-callout-bridge-model-missing-');
  let calls = 0;
  const previousFetch = globalThis.fetch;
  const previousModel = process.env.OPENAI_STRUCTURED_OUTPUT_MODEL;
  const previousImagegenModel = process.env.SKS_IMAGEGEN_RESPONSES_MODEL;
  delete process.env.OPENAI_STRUCTURED_OUTPUT_MODEL;
  delete process.env.SKS_IMAGEGEN_RESPONSES_MODEL;
  globalThis.fetch = async () => { calls += 1; throw new Error('unexpected fetch'); };
  try {
    const result = await extractRealCallouts({ root, generatedImagePath: imagePath }, {
      env: {},
      desktopBridgeStatus: bridgeStatus()
    });
    assert.equal(result.ok, false);
    assert.equal(result.provider, 'desktop_bridge_structured_extractor');
    assert.equal(result.blocker.reason, 'desktop_bridge_imagegen_model_missing');
    assert.equal(result.blocker.detail, 'Run `sks bridge status --json` to inspect Desktop Bridge provider readiness.');
    assert.equal(result.source, 'mock_fixture');
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv('OPENAI_STRUCTURED_OUTPUT_MODEL', previousModel);
    restoreEnv('SKS_IMAGEGEN_RESPONSES_MODEL', previousImagegenModel);
  }
});

function bridgeStatus() {
  return {
    schema: 'sks.desktop-bridge-status.v3',
    management: { managed: true },
    service: { state: 'ready', running: true, loopback_origin: 'http://127.0.0.1:18765' },
    routing: {
      policy: {
        fallback: 'none',
        model_routes: {
          'public-image-model': { provider_id: 'codex-lb', upstream_model: 'provider-image-model' }
        }
      }
    },
    providers: {
      'codex-lb': {
        enabled: true,
        credential: { state: 'ready', blockers: [] },
        capabilities: { capabilities: { image_generation: { state: 'verified', blockers: [] } } }
      }
    },
    catalog_sync: { state: 'verified', blockers: [] },
    readiness: { bridge_ready: true, blockers: [] }
  };
}

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
