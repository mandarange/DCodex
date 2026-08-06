import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  removeDesktopBridgeManagedConfig,
  upsertDesktopBridgeManagedConfig
} from '../../../cli/install-helpers-codex-lb-config.js';
import {
  DESKTOP_BRIDGE_DIAGNOSTIC_PATH
} from '../desktop-bridge/index.js';
import { defaultDesktopBridgeServiceSettings } from '../desktop-service.js';
import {
  probeBridgeHttp,
  probeBridgeWebSocket,
  probeProviderText
} from '../desktop-controller-v3/live-probes.js';
import {
  bridgeBaseUrl,
  bridgeClientUrl,
  serializedSettings
} from '../desktop-controller-v3/shared.js';
import type { ControllerCore, ProbeContext } from '../desktop-controller-v3/types.js';

const CAPABILITY = 'A'.repeat(43);
const CAPABILITY_SHA256 = createHash('sha256').update(CAPABILITY).digest('hex');

async function fixture(t: test.TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-client-capability-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const capabilityPath = path.join(home, '.codex', 'sks', 'desktop-bridge-client-capability');
  await fs.mkdir(path.dirname(capabilityPath), { recursive: true });
  await fs.writeFile(capabilityPath, `${CAPABILITY}\n`, { mode: 0o600 });
  await fs.chmod(capabilityPath, 0o600);
  return { home, capabilityPath };
}

function context(): ProbeContext {
  return {
    requestedLevel: 'transport',
    checkedAt: '2026-08-06T00:00:00.000Z',
    reportId: 'report-client-capability',
    correlationId: 'correlation-client-capability',
    sessionId: 'session-client-capability',
    attemptId: 1
  };
}

test('managed config accepts only a capability-scoped loopback base URL while historical cleanup stays available', () => {
  const catalogPath = '/tmp/sks-bridge-catalog.json';
  const unprotected = 'http://127.0.0.1:49152/backend-api/codex';
  assert.throws(
    () => upsertDesktopBridgeManagedConfig('', { bridgeBaseUrl: unprotected, combinedCatalogPath: catalogPath }),
    /desktop_bridge_loopback_base_url_required/
  );

  const tokenized = `http://127.0.0.1:49152/__sks/client/${CAPABILITY}/backend-api/codex`;
  const managed = upsertDesktopBridgeManagedConfig('', {
    bridgeBaseUrl: tokenized,
    combinedCatalogPath: catalogPath
  });
  assert.match(managed, new RegExp(tokenized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  const historicalManaged = [
    '# sks-desktop-bridge-managed',
    'model_provider = "openai"',
    '# sks-desktop-bridge-managed-base-url',
    `openai_base_url = "${unprotected}"`,
    '# sks-desktop-bridge-managed-model-catalog',
    `model_catalog_json = "${catalogPath}"`,
    ''
  ].join('\n');
  assert.equal(removeDesktopBridgeManagedConfig(historicalManaged), '');
});

test('controller URL helpers read the 0600 capability and bind managed config to the settings hash', async (t) => {
  const setup = await fixture(t);
  const settings = defaultDesktopBridgeServiceSettings({
    listen_port: 51_234,
    client_capability_sha256: CAPABILITY_SHA256
  });
  const options = { home: setup.home, clientCapabilityPath: setup.capabilityPath };

  assert.equal(
    await bridgeBaseUrl(settings, options),
    `http://127.0.0.1:51234/__sks/client/${CAPABILITY}/backend-api/codex`
  );
  assert.equal(
    await bridgeClientUrl('ws://127.0.0.1:51234', DESKTOP_BRIDGE_DIAGNOSTIC_PATH, options),
    `ws://127.0.0.1:51234/__sks/client/${CAPABILITY}${DESKTOP_BRIDGE_DIAGNOSTIC_PATH}`
  );
  const persisted = serializedSettings(settings);
  assert.match(persisted, new RegExp(CAPABILITY_SHA256));
  assert.doesNotMatch(persisted, new RegExp(CAPABILITY));

  const mismatched = { ...settings, client_capability_sha256: '0'.repeat(64) };
  await assert.rejects(
    bridgeBaseUrl(mismatched, options),
    /desktop_bridge_client_capability_mismatch/
  );
  await assert.rejects(
    bridgeClientUrl('https://example.com:51234', '/backend-api/codex', options),
    /desktop_bridge_loopback_origin_invalid/
  );
});

test('provider Responses and diagnostic HTTP probes use tokenized client paths without returning the token', async (t) => {
  const setup = await fixture(t);
  const seen: Array<{ url: string; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    seen.push({ url: String(input), body });
    if (String(input).endsWith('/__sks/diagnostics/health')) {
      return new Response(JSON.stringify({ schema: 'sks.desktop-bridge-health.v1', runtime: 'desktop-bridge' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ id: 'response-fixture' }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const core = {
    policy: {
      model_routes: {
        'openrouter-model': { provider_id: 'openrouter', upstream_model: 'openrouter/model' }
      }
    }
  } as unknown as ControllerCore;
  const options = {
    home: setup.home,
    clientCapabilityPath: setup.capabilityPath,
    fetchImpl
  };

  const provider = await probeProviderText(
    core,
    'openrouter',
    'http://127.0.0.1:51234',
    context(),
    options
  );
  const http = await probeBridgeHttp('http://127.0.0.1:51234', options);

  assert.equal(provider.state, 'verified');
  assert.equal(http.state, 'verified');
  assert.equal(
    seen[0]?.url,
    `http://127.0.0.1:51234/__sks/client/${CAPABILITY}/backend-api/codex/responses`
  );
  assert.deepEqual(seen[0]?.body, {
    model: 'openrouter-model',
    input: 'Reply with OK.',
    max_output_tokens: 1,
    store: false,
    provider: { allow_fallbacks: false }
  });
  assert.equal(
    seen[1]?.url,
    `http://127.0.0.1:51234/__sks/client/${CAPABILITY}/__sks/diagnostics/health`
  );
  assert.doesNotMatch(JSON.stringify({ provider, http }), new RegExp(CAPABILITY));
});

test('missing client capability fails provider, HTTP, and WebSocket probes closed with structured blockers', async (t) => {
  const setup = await fixture(t);
  const missingPath = path.join(setup.home, 'missing-client-capability');
  let fetchCalls = 0;
  const options = {
    home: setup.home,
    clientCapabilityPath: missingPath,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('fetch_must_not_run_without_client_capability');
    }
  };
  const core = {
    policy: {
      model_routes: {
        model: { provider_id: 'codex-lb', upstream_model: 'model' }
      }
    }
  } as unknown as ControllerCore;

  const provider = await probeProviderText(core, 'codex-lb', 'http://127.0.0.1:51234', context(), options);
  const http = await probeBridgeHttp('http://127.0.0.1:51234', options);
  const websocket = await probeBridgeWebSocket('http://127.0.0.1:51234', 'transport', options);

  assert.equal(fetchCalls, 0);
  for (const result of [provider, http, websocket]) {
    assert.equal(result.root_cause, 'desktop_bridge_client_capability_missing');
    assert.deepEqual(result.blockers, ['desktop_bridge_client_capability_missing']);
  }

  const invalidPath = path.join(setup.home, 'invalid-client-capability');
  await fs.writeFile(invalidPath, 'not-a-valid-capability\n', { mode: 0o600 });
  const invalid = await probeBridgeHttp('http://127.0.0.1:51234', {
    ...options,
    clientCapabilityPath: invalidPath
  });
  assert.equal(invalid.root_cause, 'desktop_bridge_client_capability_invalid');
  assert.deepEqual(invalid.blockers, ['desktop_bridge_client_capability_invalid']);
  assert.equal(fetchCalls, 0);
});
