import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertAllowedOrigin,
  assertAllowedPath,
  buildUpstreamHeaders,
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
  type DesktopBridgeGatewayAuthTransport,
} from '../index.js';

function config(transport: DesktopBridgeGatewayAuthTransport = 'x-codex-lb-api-key'): DesktopBridgeConfig {
  return {
    listenHost: '127.0.0.1',
    listenPort: 55_000,
    remoteBaseUrl: 'https://lb.example.com/backend-api/codex',
    gatewayKey: 'lb-key-unit-secret',
    gatewayAuthTransport: transport,
    allowedPathPrefixes: ['/backend-api/codex/', '/backend-api/files'],
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 30_000,
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

test('both explicit gateway transports strip Desktop OAuth and cookies without fallback', () => {
  const inbound = {
    authorization: 'Bearer chatgpt-oauth-secret',
    cookie: 'session=desktop-secret',
    'x-codex-lb-api-key': 'attacker-key',
    'x-forwarded-for': '203.0.113.4',
    'content-type': 'application/json',
  };

  const preferred = buildUpstreamHeaders(inbound, config('x-codex-lb-api-key'), 'lb.example.com');
  assert.equal(preferred.authorization, undefined);
  assert.equal(preferred.cookie, undefined);
  assert.equal(preferred['x-codex-lb-api-key'], 'lb-key-unit-secret');
  assert.equal(preferred['content-type'], 'application/json');

  const compat = buildUpstreamHeaders(inbound, config('authorization-bearer-compat'), 'lb.example.com');
  assert.equal(compat.authorization, 'Bearer lb-key-unit-secret');
  assert.equal(compat.cookie, undefined);
  assert.equal(compat['x-codex-lb-api-key'], undefined);
  assert.notEqual(compat.authorization, inbound.authorization);
});

test('remote preflight pins DNS and blocks insecure or private-origin targets', async () => {
  const prepared = await prepareDesktopBridgeConfig(config(), async () => [{ address: '93.184.216.34', family: 4 }]);
  assert.equal(prepared.remote.address, '93.184.216.34');
  assert.equal(prepared.remote.hostname, 'lb.example.com');
  assert.equal(prepared.remote.tlsServername, 'lb.example.com');

  await assert.rejects(
    prepareDesktopBridgeConfig(config(), async () => [{ address: '127.0.0.1', family: 4 }]),
    /bridge_remote_dns_private_address/,
  );
  await assert.rejects(
    prepareDesktopBridgeConfig({ ...config(), remoteBaseUrl: 'http://lb.example.com/backend-api/codex' }),
    /bridge_remote_transport_forbidden/,
  );
  await assert.rejects(
    prepareDesktopBridgeConfig(
      { ...config(), remoteBaseUrl: 'http://localhost:8443/backend-api/codex' },
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

test('0600 public state contains hashes and explicit auth transport but no gateway secret', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-state-'));
  const file = path.join(temp, 'state.json');
  try {
    const state = createDesktopBridgePublicState(config('authorization-bearer-compat'), {
      pid: 42,
      now: new Date('2026-07-28T00:00:00.000Z'),
    });
    await writeDesktopBridgeState(file, state);
    const raw = await fsp.readFile(file, 'utf8');
    const stat = await fsp.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(raw.includes('lb-key-unit-secret'), false);
    assert.equal(raw.includes('authorization-bearer-compat'), true);
    assert.deepEqual(await readDesktopBridgeState(file), state);

    const generation = desktopBridgeConfigGeneration(config('authorization-bearer-compat'));
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
    arguments: ['codex-lb', 'desktop-bridge', 'serve', '--config', '/Users/test/.codex/sks/bridge-config.json'],
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
