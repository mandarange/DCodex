import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertAllowedOrigin,
  assertAllowedPath,
  buildProviderUpstreamHeaders,
  createDesktopBridgePublicState,
  desktopBridgeConfigGeneration,
  getDesktopBridgeStatus,
  prepareDesktopBridgeConfig,
  readDesktopBridgeState,
  removeDesktopBridgeStateIfOwned,
  renderDesktopBridgeLaunchdPlist,
  rewriteLocationHeader,
  writeDesktopBridgeState,
  type DesktopBridgeConfig,
  type DesktopBridgeProviderAuthTransport,
} from '../index.js';

const CODEX_LB_SECRET = 'lb-key-unit-secret';
const CATALOG_GENERATION = 'catalog-generation';
const POLICY_GENERATION = 'policy-generation';
const CREDENTIAL_GENERATION = 'credential-generation';
const CREDENTIAL_FINGERPRINT = 'credential-fingerprint';

function config(transport: DesktopBridgeProviderAuthTransport = 'x-codex-lb-api-key'): DesktopBridgeConfig {
  const baseUrl = 'https://lb.example.com/backend-api/codex';
  return {
    listenHost: '127.0.0.1',
    listenPort: 55_000,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: 'registry-generation',
      created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin], auth_transport: transport,
          credential_state: 'ready', credential_fingerprint: CREDENTIAL_FINGERPRINT,
          credential_generation: CREDENTIAL_GENERATION, catalog_generation: CATALOG_GENERATION,
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'openrouter-credential-generation', catalog_generation: null,
        },
      },
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { 'public-model': { provider_id: 'codex-lb', upstream_model: 'upstream-model' } },
      catalog_generation: CATALOG_GENERATION, policy_generation: POLICY_GENERATION,
      changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: providerId === 'codex-lb' ? CODEX_LB_SECRET : 'unused-openrouter-secret',
      source: 'test',
      fingerprint: providerId === 'codex-lb' ? CREDENTIAL_FINGERPRINT : 'unused-openrouter-fingerprint',
      generation: expectedGeneration,
    }),
    allowedPathPrefixes: ['/backend-api/codex/', '/backend-api/files'],
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 30_000,
  };
}

function withCodexLbBaseUrl(input: DesktopBridgeConfig, baseUrl: string): DesktopBridgeConfig {
  return {
    ...input,
    providerRegistry: {
      ...input.providerRegistry,
      providers: {
        ...input.providerRegistry.providers,
        'codex-lb': {
          ...input.providerRegistry.providers['codex-lb'],
          base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin],
        },
      },
    },
  };
}

test('path and origin policy keeps identity/control surfaces outside the bridge', () => {
  assert.doesNotThrow(() => assertAllowedPath('/backend-api/codex/responses', config().allowedPathPrefixes));
  assert.doesNotThrow(() => assertAllowedPath('/backend-api/files/abc', config().allowedPathPrefixes));
  assert.throws(
    () => assertAllowedPath('/backend-api/accounts', config().allowedPathPrefixes),
    /bridge_path_not_allowed/,
  );
  assert.throws(
    () => assertAllowedPath('/backend-api/apps', config().allowedPathPrefixes),
    /bridge_path_not_allowed/,
  );
  assert.throws(
    () => assertAllowedPath('/backend-api/codex-escape', config().allowedPathPrefixes),
    /bridge_path_not_allowed/,
  );

  assert.doesNotThrow(() => assertAllowedOrigin({}, ['app://codex']));
  assert.doesNotThrow(() => assertAllowedOrigin({ origin: 'app://codex' }, ['app://codex']));
  assert.doesNotThrow(() => assertAllowedOrigin({ referer: 'app://codex/thread/1' }, ['app://codex']));
  assert.throws(
    () => assertAllowedOrigin({ origin: 'https://attacker.example' }, ['app://codex']),
    /bridge_origin_forbidden/,
  );
  assert.throws(
    () => assertAllowedOrigin({ referer: 'https://attacker.example/page' }, ['app://codex']),
    /bridge_origin_forbidden/,
  );
});

test('both current Codex-LB auth transports strip Desktop OAuth and cookies without fallback', () => {
  const inbound = {
    authorization: 'Bearer chatgpt-oauth-secret',
    cookie: 'session=desktop-secret',
    'x-codex-lb-api-key': 'attacker-key',
    'x-forwarded-for': '203.0.113.4',
    'content-type': 'application/json',
  };

  const preferred = buildProviderUpstreamHeaders(inbound, {
    providerId: 'codex-lb', authTransport: 'x-codex-lb-api-key',
    credential: { provider_id: 'codex-lb', value: CODEX_LB_SECRET, source: 'test', fingerprint: CREDENTIAL_FINGERPRINT, generation: CREDENTIAL_GENERATION },
  }, 'lb.example.com');
  assert.equal(preferred.authorization, undefined);
  assert.equal(preferred.cookie, undefined);
  assert.equal(preferred['x-codex-lb-api-key'], 'lb-key-unit-secret');
  assert.equal(preferred['content-type'], 'application/json');

  const bearer = buildProviderUpstreamHeaders(inbound, {
    providerId: 'codex-lb', authTransport: 'authorization-bearer',
    credential: { provider_id: 'codex-lb', value: CODEX_LB_SECRET, source: 'test', fingerprint: CREDENTIAL_FINGERPRINT, generation: CREDENTIAL_GENERATION },
  }, 'lb.example.com');
  assert.equal(bearer.authorization, `Bearer ${CODEX_LB_SECRET}`);
  assert.equal(bearer.cookie, undefined);
  assert.equal(bearer['x-codex-lb-api-key'], undefined);
  assert.notEqual(bearer.authorization, inbound.authorization);
});

test('remote preflight pins DNS and blocks insecure or private-origin targets', async () => {
  const prepared = await prepareDesktopBridgeConfig(config(), async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(prepared.providers['codex-lb'].remote.address, '93.184.216.34');
  assert.equal(prepared.providers['codex-lb'].remote.hostname, 'lb.example.com');
  assert.equal(prepared.providers['codex-lb'].remote.tlsServername, 'lb.example.com');

  await assert.rejects(
    prepareDesktopBridgeConfig(config(), async () => [{ address: '127.0.0.1', family: 4 }]),
    /bridge_remote_dns_private_address/,
  );
  await assert.rejects(
    prepareDesktopBridgeConfig(withCodexLbBaseUrl(config(), 'http://lb.example.com/backend-api/codex')),
    /bridge_remote_transport_forbidden/,
  );
  await assert.rejects(
    prepareDesktopBridgeConfig(
      withCodexLbBaseUrl(config(), 'http://localhost:8443/backend-api/codex'),
      async () => [{ address: '93.184.216.34', family: 4 }],
    ),
    /bridge_remote_dns_rebinding_blocked/,
  );
});

test('Location rewrite accepts only the configured HTTP/WebSocket endpoint family', () => {
  assert.equal(
    rewriteLocationHeader(
      'wss://lb.example.com/backend-api/codex/call-1?token=opaque',
      'https://lb.example.com/backend-api/codex',
      'http://127.0.0.1:55000',
    ),
    'ws://127.0.0.1:55000/backend-api/codex/call-1?token=opaque',
  );
  assert.throws(
    () => rewriteLocationHeader(
      'wss://evil.example/backend-api/codex/call-1',
      'https://lb.example.com/backend-api/codex',
      'http://127.0.0.1:55000',
    ),
    /bridge_location_origin_forbidden/,
  );
});

test('0600 v2 public state contains registry, route, and credential generations but no provider secret', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-state-'));
  const file = path.join(temp, 'state.json');
  try {
    const currentConfig = config('authorization-bearer');
    const state = createDesktopBridgePublicState(currentConfig, {
      pid: 42,
      now: new Date(),
    });
    await writeDesktopBridgeState(file, state);
    const raw = await fsp.readFile(file, 'utf8');
    const stat = await fsp.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(raw.includes(CODEX_LB_SECRET), false);
    assert.equal(state.provider_registry_generation, currentConfig.providerRegistry.generation);
    assert.equal(state.route_policy_generation, currentConfig.routePolicy.policy_generation);
    assert.equal(state.catalog_generation, currentConfig.routePolicy.catalog_generation);
    assert.equal(state.provider_credential_generations['codex-lb'], CREDENTIAL_GENERATION);
    assert.deepEqual(await readDesktopBridgeState(file), state);

    const generation = desktopBridgeConfigGeneration(currentConfig);
    assert.equal((await getDesktopBridgeStatus({
      statePath: file,
      expectedConfigGeneration: generation,
      processExists: () => true,
    })).status, 'running');
    assert.equal((await getDesktopBridgeStatus({
      statePath: file,
      expectedConfigGeneration: '0'.repeat(64),
      processExists: () => true,
    })).status, 'configuration_mismatch');
    assert.equal((await getDesktopBridgeStatus({
      statePath: file,
      processExists: () => false,
    })).status, 'stale');
    assert.equal(await removeDesktopBridgeStateIfOwned(file, {
      pid: 99,
      config_generation: state.config_generation,
    }), false);
    assert.deepEqual(await readDesktopBridgeState(file), state);
    assert.equal(await removeDesktopBridgeStateIfOwned(file, state), true);
    assert.equal(await readDesktopBridgeState(file), null);
  } finally {
    await fsp.rm(temp, { recursive: true, force: true });
  }
});

test('launchd rendering contains no environment/key material and rejects secret arguments', () => {
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: '/usr/local/bin/sks',
    arguments: ['bridge', 'serve', '--settings', '/Users/test/.codex/sks/bridge-settings.json'],
    stdoutPath: '/Users/test/Library/Logs/sks-bridge.out.log',
    stderrPath: '/Users/test/Library/Logs/sks-bridge.err.log',
  });
  assert.match(plist, /com\.sneakoscope\.codex-lb-desktop-bridge/);
  assert.equal(plist.includes('EnvironmentVariables'), false);
  assert.equal(plist.includes('lb-key-unit-secret'), false);
  for (const forbidden of [
    '--gateway-key=secret',
    '--api-key',
    '--access-token=secret',
    '--authorization=Bearer secret',
    'CODEX_LB_API_KEY=secret',
  ]) {
    assert.throws(
      () => renderDesktopBridgeLaunchdPlist({
        executablePath: '/usr/local/bin/sks',
        arguments: [forbidden],
        stdoutPath: '/tmp/out',
        stderrPath: '/tmp/err',
      }),
      /bridge_launchd_secret_argument_forbidden/,
    );
  }
});
