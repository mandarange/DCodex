import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  createDesktopBridgePublicState,
  readDesktopBridgeState,
  refreshDesktopBridgeState,
  writeDesktopBridgeState,
  type DesktopBridgeConfig,
} from '../index.js';

const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(Buffer.alloc(32, 0x45)).digest('hex');

function config(): DesktopBridgeConfig {
  const baseUrl = 'https://lb.example.com/backend-api/codex';
  return {
    listenHost: '127.0.0.1',
    listenPort: 55_100,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: 'registry-generation',
      created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin], auth_transport: 'x-codex-lb-api-key',
          credential_state: 'ready', credential_fingerprint: 'credential-fingerprint',
          credential_generation: 'credential-generation', source_catalog_generation: 'catalog-generation',
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'openrouter-credential-generation', source_catalog_generation: null,
        },
      },
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { 'public-model': { provider_id: 'codex-lb', upstream_model: 'public-model' } },
      catalog_generation: 'catalog-generation', policy_generation: 'policy-generation',
      changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId, value: 'unused', source: 'test', fingerprint: 'credential-fingerprint', generation: expectedGeneration,
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
  };
}

test('the serving process heartbeat keeps the verifier-written probe ids instead of erasing them', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-bridge-state-heartbeat-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'desktop-bridge-state.json');
  // The serving process's own in-memory state: verified probe ids start — and
  // stay — empty, because only the verifier ever learns them.
  const live = createDesktopBridgePublicState(config(), { pid: 4242, now: new Date('2026-09-02T06:00:00.000Z') });
  await writeDesktopBridgeState(file, live);

  // A `bridge verify --level transport` run records its live probe ids.
  const verified = ['report-transport-001', 'report-transport-001:bridge:http_health'];
  assert.equal(await refreshDesktopBridgeState(file, { ...live, last_verified_probe_ids: verified }, new Date('2026-09-02T06:01:00.000Z')), true);
  assert.deepEqual((await readDesktopBridgeState(file))?.last_verified_probe_ids, verified);

  // The next heartbeat tick, ~100 s later, rewrites the whole document from the
  // in-memory copy. Preserving is what keeps the transport diagnostic bound to
  // this process; the in-memory copy adopts the ids so later writes keep them too.
  assert.deepEqual(live.last_verified_probe_ids, []);
  assert.equal(await refreshDesktopBridgeState(file, live, new Date('2026-09-02T06:02:40.000Z'), 300_000, { preserveVerifiedProbeIds: true }), true);
  assert.deepEqual((await readDesktopBridgeState(file))?.last_verified_probe_ids, verified);
  assert.deepEqual(live.last_verified_probe_ids, verified);
  assert.equal((await readDesktopBridgeState(file))?.updated_at, '2026-09-02T06:02:40.000Z');

  // The verifier's own refresh still writes exactly what it passes (an empty
  // set clears stale ids), so a report that verified nothing binds nothing.
  assert.equal(await refreshDesktopBridgeState(file, { ...live, last_verified_probe_ids: [] }, new Date('2026-09-02T06:03:00.000Z')), true);
  assert.deepEqual((await readDesktopBridgeState(file))?.last_verified_probe_ids, []);
});
