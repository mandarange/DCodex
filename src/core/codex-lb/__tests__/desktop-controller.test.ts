import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type {
  CodexAppQuitResult,
  CodexAppRestartResult
} from '../../codex-app/codex-app-restart.js';
import {
  configureCodexLb,
  configureCodexLbDesktopRouting,
  repairCodexLbAuth
} from '../../../cli/install-helpers.js';
import { codexAuthChatgptBackupPath } from '../../../cli/install-helpers-codex-lb-shared.js';
import {
  buildCodexLbDoctorResult,
  codexLbSetupCapabilityDiagnosticOk,
  controllerOptions,
  formatCodexLbDesktopStatusText
} from '../../../commands/codex-lb.js';
import {
  activateCodexLbDesktopMode,
  buildCodexLbDesktopCapabilities,
  codexLbActivationPostcondition,
  codexLbDesktopStatusV2,
  configureCodexLbCliMode,
  disableCodexLbDesktopRouting,
  inferCodexLbDesktopModeFromConfig,
  migrateLegacyCodexLbDesktopMode,
  rollbackCodexLbDesktopMode
} from '../desktop-controller.js';
import { desktopBridgeServicePaths } from '../desktop-service.js';

const REMOTE = 'https://lb.example.test/backend-api/codex';
const API_KEY = 'sk-clb-controller-fixture';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-controller-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  await fsp.mkdir(codexHome, { recursive: true });
  const config = 'service_tier = "fast"\n';
  const auth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-controller',
    tokens: {
      access_token: 'access-controller',
      refresh_token: 'refresh-controller'
    }
  }, null, 2)}\n`;
  await fsp.writeFile(configPath, config);
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(
    envPath,
    `export CODEX_LB_BASE_URL='${REMOTE}'\nexport CODEX_LB_API_KEY='${API_KEY}'\n`,
    { mode: 0o600 }
  );
  return { home, codexHome, configPath, authPath, envPath, config, auth };
}

function bridgeStatus(home: string, port: number, running: boolean) {
  const paths = desktopBridgeServicePaths(home);
  const listenOrigin = `http://127.0.0.1:${port}`;
  return {
    schema: 'sks.codex-lb-desktop-bridge-service.v1' as const,
    ok: running,
    supported: true,
    installed: running,
    loaded: running,
    running,
    status: running ? 'running' as const : 'missing' as const,
    service: 'gui/501/com.sneakoscope.codex-lb-desktop-bridge',
    paths,
    state: running ? {
      schema: 'sks.codex-lb-desktop-bridge.v1' as const,
      pid: process.pid,
      started_at: '2026-07-28T00:00:00.000Z',
      listen_origin: listenOrigin,
      codex_base_url: `${listenOrigin}/backend-api/codex`,
      remote_origin_sha256: 'a'.repeat(64),
      gateway_key_sha256: 'b'.repeat(64),
      gateway_auth_transport: 'x-codex-lb-api-key' as const,
      config_generation: 'c'.repeat(64)
    } : null,
    settings: null,
    expected_config_generation: running ? 'c'.repeat(64) : null,
    credential_source: 'env-file' as const,
    blockers: running ? [] : ['desktop_bridge_state_missing']
  };
}

test('native activation fails closed before config commit when the bridge cannot start', async (t) => {
  const setup = await fixture(t);
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    restartApp: false
  });

  assert.equal(result.ok, false);
  assert.equal(result.config_committed, false);
  assert.equal(result.routing_plane, 'unchanged');
  assert.equal(result.oauth_preserved, true);
  assert.deepEqual(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  assert.deepEqual(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('CLI ON verifies the remote route then atomically selects codex-lb', async (t) => {
  const setup = await fixture(t);
  let authorization = '';
  let gatewayApiKey = '';
  let syncedMode = '';
  const result = await configureCodexLbCliMode({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    fetchImpl: async (_url, init) => {
      authorization = String((init?.headers as Record<string, string>)?.Authorization || '');
      gatewayApiKey = String((init?.headers as Record<string, string>)?.['X-Codex-LB-API-Key'] || '');
      return new Response('{"data":[]}', { status: 200 });
    },
    syncCenterCredentialsImpl: async (options = { mode: 'disabled' }) => {
      syncedMode = String(options.mode);
      return {
        schema: 'sks.codex-lb-desktop-center-credentials.v1',
        ok: true,
        status: 'launch_env_synced',
        mode: options.mode,
        api_key_fingerprint: null,
        base_url_present: true,
        launch_env: { api_key: 'set', base_url: 'set' },
        stale_twins_removed: [],
        stale_twins_quarantined: [],
        stale_keychain_cleared: [],
        blockers: [],
        operator_actions: []
      };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.routing_active, true);
  assert.equal((result.routing_truth as Record<string, unknown>).auth_outcome, 'accepted');
  assert.equal((result.routing_truth as Record<string, unknown>).mode, 'cli-provider');
  assert.equal(syncedMode, 'cli-provider');
  assert.equal((result.center_credentials as Record<string, unknown>).ok, true);
  assert.equal(authorization, `Bearer ${API_KEY}`);
  assert.equal(gatewayApiKey, '');
  const config = await fsp.readFile(setup.configPath, 'utf8');
  assert.match(config, /# sks-codex-lb-managed-provider-selection\nmodel_provider = "codex-lb"/);
  assert.match(config, new RegExp(`base_url = "${REMOTE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('CLI ON leaves an existing selected route fail-closed when the endpoint is unreachable', async (t) => {
  const setup = await fixture(t);
  const selected = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  await fsp.writeFile(setup.configPath, selected);
  const result = await configureCodexLbCliMode({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    fetchImpl: async () => { throw new Error('offline'); }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'endpoint_unreachable');
  assert.equal(result.fail_closed, true);
  assert.equal(result.fallback_provider_selected, false);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), selected);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('repair preserves selected provider and failed measured truth for the native UI', async (t) => {
  const setup = await fixture(t);
  const selected = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  await fsp.writeFile(setup.configPath, selected);
  const repaired = await repairCodexLbAuth({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    processEnv: {},
    syncLaunchEnv: false,
    syncLaunchctl: false
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.codex_lb?.selected, true);
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /^model_provider = "codex-lb"$/m);

  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    routingTruthReceiptPath: path.join(setup.codexHome, 'routing-truth.json'),
    platform: 'linux',
    networkProbes: true,
    fetchImpl: async () => { throw new Error('fixture offline'); },
    bridgeStatusImpl: async () => bridgeStatus(setup.home, 49152, false)
  });
  const routingTruth = status.routing_truth as Record<string, unknown>;
  assert.deepEqual(status.secret_resolution, {
    source: 'env-file',
    path: setup.envPath,
    prompt_risk: 'none'
  });
  assert.match(
    formatCodexLbDesktopStatusText(status, { home: setup.home }),
    /Key source: env-file \(~\/.codex\/sks-codex-lb\.env\) · keychain: not used · prompt risk: none/
  );
  assert.equal(status.routing_active, false);
  assert.equal(routingTruth.selected, true);
  assert.equal(routingTruth.measured, true);
  assert.equal(routingTruth.ok, false);
  assert.equal(routingTruth.status, 'endpoint_unreachable');
  assert.deepEqual(routingTruth.blockers, ['codex_lb_endpoint_unreachable']);
});

test('selected CLI status with a missing key stays on codex-lb and reports no OAuth fallback', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  await fsp.writeFile(
    setup.envPath,
    `export CODEX_LB_BASE_URL='${REMOTE}'\n`,
    { mode: 0o600 }
  );
  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    env: { HOME: setup.home },
    platform: 'linux'
  });

  assert.equal(status.ok, false);
  assert.equal(status.routing_active, false);
  assert.equal(status.chatgpt_oauth_present, true);
  assert.deepEqual(status.provider, {
    id: 'codex-lb',
    built_in: false,
    contract: 'codex-lb-cli',
    contract_ok: true,
    selected: true
  });
  assert.equal((status.routing_truth as Record<string, unknown>).status, 'missing_api_key');
  assert.equal((status.routing_truth as Record<string, unknown>).selected, true);
  assert.deepEqual(status.guidance, [
    'Store the key in ~/.codex/sks-codex-lb.env (owner-only mode 0600).',
    'Run: sks codex-lb setup --host <domain> --api-key-stdin --yes',
    'Alternatively, provide CODEX_LB_API_KEY in the launching environment.',
    'Then activate the atomic CLI provider with: sks codex-lb use-cli'
  ]);
});

test('Keychain setup fails closed before mutation without a dedicated signed helper', async (t) => {
  const setup = await fixture(t);
  const configured = await configureCodexLb({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    host: REMOTE,
    apiKey: API_KEY,
    storeKeychain: true,
    forceMacos: true,
    platform: 'linux',
    toolOutputRecoveryFetch: async () => new Response('{}', {
      status: 200,
      headers: { 'x-app-version': '1.21.0-beta.3' }
    })
  });
  assert.equal(configured.ok, false);
  assert.equal(configured.status, 'keychain_acl_helper_unavailable');
  assert.equal(configured.keychain?.keychain_state_status, 'unchanged');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  assert.match(await fsp.readFile(setup.envPath, 'utf8'), new RegExp(API_KEY));
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('native activation rolls back when real loopback HTTP and WebSocket transport are unreachable', async (t) => {
  const setup = await fixture(t);
  const port = 49153;
  let running = false;
  let stops = 0;
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    restartApp: false,
    networkProbes: false,
    capabilityTimeoutMs: 250,
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, running),
    installBridgeImpl: async () => {
      running = true;
      return bridgeStatus(setup.home, port, true);
    },
    stopBridgeImpl: async () => {
      stops += 1;
      running = false;
      return bridgeStatus(setup.home, port, false);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.config_committed, false);
  assert.equal(stops, 1);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
  assert.ok((result.blockers as string[]).some((blocker) => (
    blocker.includes('websocket')
    || blocker.includes('transport')
  )));
});

test('native activation requires and records real loopback HTTP plus WebSocket handshakes', async (t) => {
  const setup = await fixture(t);
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/capabilities')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        schema_version: 'codex-lb.desktop-capabilities.v1',
        routes: { models: true }
      }));
      return;
    }
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"models":[]}');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  server.on('upgrade', (request, socket) => {
    const key = String(request.headers['sec-websocket-key'] || '');
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.end(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Connection: Upgrade\r\n'
      + 'Upgrade: websocket\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
      + '\r\n'
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  let running = false;
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    restartApp: false,
    networkProbes: false,
    fetchImpl: async () => new Response('{"models":[]}', { status: 200 }),
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, running),
    installBridgeImpl: async () => {
      running = true;
      return bridgeStatus(setup.home, port, true);
    },
    stopBridgeImpl: async () => {
      running = false;
      return bridgeStatus(setup.home, port, false);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.transport_capabilities_verified, true);
  assert.equal(
    ((result.capabilities as Record<string, any>).bridge as Record<string, unknown>).state,
    'verified'
  );
  const routingTruth = (
    result.post_activation_status as Record<string, any>
  ).routing_truth as Record<string, unknown>;
  assert.equal(routingTruth.measurement_path, 'direct');
  assert.equal(routingTruth.configured_host, 'lb.example.test');
  assert.equal(routingTruth.actual_host, 'lb.example.test');
});

test('native activation keeps working HTTP routing when the gateway does not proxy realtime WebSockets', async (t) => {
  const setup = await fixture(t);
  const server = http.createServer((request, response) => {
    if (request.url?.endsWith('/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"models":[]}');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{}');
  });
  // Real codex-lb deployments commonly refuse `/realtime` upgrades outright.
  server.on('upgrade', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const port = (server.address() as AddressInfo).port;
  let running = false;
  let stops = 0;
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    restartApp: false,
    capabilityTimeoutMs: 1_000,
    fetchImpl: async () => new Response('{"models":[]}', { status: 200 }),
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, running),
    installBridgeImpl: async () => {
      running = true;
      return bridgeStatus(setup.home, port, true);
    },
    stopBridgeImpl: async () => {
      stops += 1;
      running = false;
      return bridgeStatus(setup.home, port, false);
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.config_committed, true);
  assert.equal(stops, 0);
  // Truthful reporting is preserved: WebSocket transport stays unverified.
  assert.equal(result.transport_capabilities_verified, false);
  assert.ok((result.transport_warnings as string[]).includes('desktop_bridge_websocket_transport_failed'));
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /openai_base_url = "http:\/\/127\.0\.0\.1:/);
});

test('native activation aborts with an explicit transport blocker when the gateway rejects the configured auth', async (t) => {
  const setup = await fixture(t);
  const port = 49155;
  let running = false;
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    restartApp: false,
    capabilityTimeoutMs: 1_000,
    fetchImpl: async () => new Response(
      '{"error":{"message":"Missing API key in Authorization header"}}',
      { status: 401 }
    ),
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, running),
    installBridgeImpl: async () => {
      running = true;
      return bridgeStatus(setup.home, port, true);
    },
    stopBridgeImpl: async () => {
      running = false;
      return bridgeStatus(setup.home, port, false);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.config_committed, false);
  assert.ok((result.blockers as string[]).some((blocker) => (
    blocker.startsWith('codex_lb_gateway_auth_rejected_for_transport:')
  )));
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
});

test('codex-lb controller options only pin the gateway auth transport when a flag asks for it', () => {
  // SKS Center runs `codex-lb use-desktop-full` with no transport flag; a default
  // here would shadow the stored Center choice and force the custom header.
  assert.equal(controllerOptions(['use-desktop-full', '--json']).gatewayAuthTransport, undefined);
  assert.equal(
    controllerOptions(['use-desktop-full', '--gateway-auth', 'bearer-compat']).gatewayAuthTransport,
    'authorization-bearer-compat'
  );
  assert.equal(
    controllerOptions(['use-desktop-full', '--gateway-auth', 'custom-header']).gatewayAuthTransport,
    'x-codex-lb-api-key'
  );
  assert.equal(
    controllerOptions(['use-desktop-full', '--compat-bearer']).gatewayAuthTransport,
    'authorization-bearer-compat'
  );
});

test('status separates the stored Desktop transport from the effective CLI transport', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  const metadataPath = path.join(setup.codexHome, 'sks-codex-lb.json');
  await fsp.writeFile(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: REMOTE,
    updated_at: '2026-07-29T00:00:00.000Z',
    source: 'setup',
    desktop_mode: 'cli-provider',
    gateway_auth_transport: 'authorization-bearer-compat',
    api_key: { redacted: true, sha256: createHash('sha256').update(API_KEY).digest('hex') }
  }, null, 2)}\n`, { mode: 0o600 });
  const port = 49154;

  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    metadataPath,
    platform: 'linux',
    networkProbes: false,
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, false)
  });

  assert.equal(
    (status.bridge as Record<string, unknown>).gateway_auth_transport,
    null
  );
  assert.equal(status.stored_gateway_auth_transport, 'authorization-bearer-compat');
  assert.equal(status.gateway_auth_transport, 'authorization-bearer-compat');
});

test('compat activation rejects before transaction, bridge, routing, restart, or auth mutation', async (t) => {
  const setup = await fixture(t);
  const receiptDir = path.join(setup.home, 'receipts');
  let restarts = 0;
  let bridgeStarts = 0;
  let bridgeStops = 0;
  const result = await activateCodexLbDesktopMode({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    receiptDir,
    platform: 'linux',
    restartApp: false,
    installBridgeImpl: async () => {
      bridgeStarts += 1;
      return bridgeStatus(setup.home, 49152, true);
    },
    stopBridgeImpl: async () => {
      bridgeStops += 1;
      return bridgeStatus(setup.home, 49152, false);
    },
    restartAppImpl: async (): Promise<CodexAppRestartResult> => {
      restarts += 1;
      return {
        schema: 'sks.codex-app-restart.v1',
        ok: true,
        status: 'restarted',
        skipped: false,
        app_name: 'Codex',
        blockers: []
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'desktop_dual_auth_compat_unavailable');
  assert.equal(result.config_committed, false);
  assert.equal(result.restart_requested, false);
  assert.equal(result.restart_performed, false);
  assert.equal(bridgeStarts, 0);
  assert.equal(bridgeStops, 0);
  assert.equal(restarts, 0);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  await assert.rejects(fsp.access(receiptDir));
});

test('status v2 infers managed modes without conflating identity and routing', async (t) => {
  const setup = await fixture(t);
  const bridgeConfig = [
    '# sks-codex-lb-managed-desktop-bridge',
    'openai_base_url = "http://127.0.0.1:54321/backend-api/codex"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  await fsp.writeFile(setup.configPath, bridgeConfig);

  assert.equal(inferCodexLbDesktopModeFromConfig(bridgeConfig), 'desktop-native-bridge');
  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux'
  });
  assert.equal(status.mode, 'desktop-native-bridge');
  assert.equal(status.desktop_mode, 'desktop-native-bridge');
  assert.equal(status.chatgpt_oauth_present, true);
  assert.equal(status.legacy_codex_lb_selected, false);
  assert.equal((status.oauth as Record<string, unknown>).present, true);
  assert.equal((status.oauth as Record<string, unknown>).preserved, true);
  assert.equal((status.oauth as Record<string, unknown>).mode, 'chatgpt_oauth');
  assert.equal((status.provider as Record<string, unknown>).id, 'openai');
  assert.equal((status.provider as Record<string, unknown>).built_in, true);
  assert.equal((status.provider as Record<string, unknown>).selected, true);
  assert.equal(status.ok, false);
  assert.ok((status.blockers as string[]).includes('desktop_bridge_service_requires_macos'));
  const doctor = buildCodexLbDoctorResult(status, { ok: true });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.diagnostic_ok, false);
  assert.equal(codexLbSetupCapabilityDiagnosticOk({
    overall: 'blocked'
  } as any), false);
});

test('bridge status measures the remote upstream with its gateway transport and reuses the shared stamp', async (t) => {
  const setup = await fixture(t);
  const port = 54321;
  await fsp.writeFile(setup.configPath, [
    '# sks-codex-lb-managed-desktop-bridge',
    `openai_base_url = "http://127.0.0.1:${port}/backend-api/codex"`,
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  let fetchCalls = 0;
  let measuredUrl = '';
  let customHeader = '';
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    fetchCalls += 1;
    measuredUrl = String(url);
    customHeader = String(
      (init?.headers as Record<string, string> | undefined)?.['X-Codex-LB-API-Key'] || ''
    );
    return new Response('{"data":[]}', { status: 200 });
  }) as typeof fetch;
  const common = {
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux' as const,
    bridgeStatusImpl: async () => bridgeStatus(setup.home, port, true)
  };

  const measured = await codexLbDesktopStatusV2({
    ...common,
    networkProbes: true,
    fetchImpl
  });
  const reused = await codexLbDesktopStatusV2({
    ...common,
    networkProbes: false,
    fetchImpl
  });
  const firstTruth = measured.routing_truth as Record<string, unknown>;
  const secondTruth = reused.routing_truth as Record<string, unknown>;

  assert.equal(fetchCalls, 1);
  assert.equal(measuredUrl, `${REMOTE}/models`);
  assert.equal(customHeader, API_KEY);
  assert.equal(firstTruth.mode, 'bridge');
  assert.equal(firstTruth.auth_transport, 'x-codex-lb-api-key');
  assert.equal(firstTruth.configured_host, 'lb.example.test');
  assert.equal(secondTruth.checked_at, firstTruth.checked_at);
  assert.equal(secondTruth.actual_host, firstTruth.actual_host);
  assert.equal(secondTruth.auth_transport, firstTruth.auth_transport);
});

test('status v2 reports stored CLI credentials as ready but inactive with the effective CLI auth transport', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));

  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux'
  });

  assert.equal(status.status, 'ready_unselected');
  assert.equal(status.diagnostic_ok, true);
  assert.equal(status.ok, false);
  assert.equal(status.credentials_ready, true);
  assert.equal(status.routing_active, false);
  assert.equal(status.activation_required, true);
  assert.equal(status.gateway_auth_transport, 'authorization-bearer-compat');
  assert.equal((status.bridge as Record<string, unknown>).gateway_auth_transport, null);
});

test('activation postcondition rejects success when the selected route is not observable', () => {
  const result = codexLbActivationPostcondition({
    mode: 'desktop-native-bridge',
    configured: true,
    chatgpt_oauth_present: true,
    routing_active: false,
    provider: { contract_ok: true, selected: true },
    bridge: { running: false }
  }, 'desktop-native-bridge');

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, [
    'codex_lb_activation_bridge_not_running',
    'codex_lb_activation_route_not_active'
  ]);
});

test('orphaned legacy API-key state blocks status and Desktop activation before bridge mutation', async (t) => {
  const setup = await fixture(t);
  const catalogPath = path.join(setup.codexHome, 'sks-codex-lb-tool-catalog.json');
  const orphanedConfig = [
    '# sks-codex-lb-managed-openai-base-url',
    `model_catalog_json = "${catalogPath}"`,
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  await fsp.writeFile(setup.configPath, orphanedConfig);
  await fsp.writeFile(
    setup.authPath,
    `{"auth_mode":"apikey","OPENAI_API_KEY":"${API_KEY}"}\n`
  );
  await fsp.writeFile(codexAuthChatgptBackupPath(setup.home), setup.auth, { mode: 0o600 });
  await fsp.writeFile(catalogPath, '{"models":[]}\n', { mode: 0o600 });

  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    env: { HOME: setup.home },
    platform: 'linux'
  });
  assert.equal(status.ok, false);
  assert.equal((status.oauth as Record<string, unknown>).mode, 'openai_api_key');
  assert.ok(
    (status.blockers as string[]).includes('legacy_codex_lb_desktop_config_requires_migration')
  );
  assert.deepEqual(status.guidance, ['Run: sks codex-lb migrate-legacy-desktop --restart-app']);

  let bridgeStarts = 0;
  const activation = await activateCodexLbDesktopMode({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    env: { HOME: setup.home },
    platform: 'linux',
    restartApp: false,
    installBridgeImpl: async () => {
      bridgeStarts += 1;
      return bridgeStatus(setup.home, 49152, true);
    }
  });
  assert.equal(activation.ok, false);
  assert.equal(activation.status, 'legacy_migration_required');
  assert.equal(activation.config_committed, false);
  assert.equal(bridgeStarts, 0);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), orphanedConfig);
  assert.match(await fsp.readFile(setup.authPath, 'utf8'), /OPENAI_API_KEY/);
});

test('disable restores the previous routing when restart fails', async (t) => {
  const setup = await fixture(t);
  const enabled = await configureCodexLbDesktopRouting({
    mode: 'desktop-native-bridge',
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    bridgeBaseUrl: 'http://127.0.0.1:49152/backend-api/codex',
    remoteBaseUrl: REMOTE,
    gatewayAuthTransport: 'x-codex-lb-api-key'
  });
  assert.equal(enabled.ok, true);
  const beforeDisable = await fsp.readFile(setup.configPath, 'utf8');
  let restarts = 0;
  const result = await disableCodexLbDesktopRouting({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    env: { HOME: setup.home },
    platform: 'linux',
    restartApp: true,
    bridgeStatusImpl: async () => bridgeStatus(setup.home, 49152, false),
    stopBridgeImpl: async () => ({
      ...bridgeStatus(setup.home, 49152, false),
      ok: true,
      blockers: []
    }),
    restartAppImpl: async (): Promise<CodexAppRestartResult> => {
      restarts += 1;
      return {
        schema: 'sks.codex-app-restart.v1',
        ok: false,
        status: 'blocked',
        app_name: 'Codex',
        blockers: ['codex_app_open_failed']
      };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.config_committed, false);
  assert.equal((result.rollback as Record<string, unknown>).ok, true);
  assert.equal(restarts, 2);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), beforeDisable);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('legacy migration quiesces the app, verifies bridge transport, and reports Desktop adoption separately', async (t) => {
  const setup = await fixture(t);
  const legacyConfig = [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${REMOTE}"`,
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].join('\n');
  await fsp.writeFile(setup.configPath, legacyConfig);
  await fsp.writeFile(
    setup.authPath,
    `{"auth_mode":"apikey","OPENAI_API_KEY":"${API_KEY}"}\n`
  );
  await fsp.writeFile(codexAuthChatgptBackupPath(setup.home), setup.auth, { mode: 0o600 });
  let running = false;
  let httpChecks = 0;
  let webSocketChecks = 0;
  let quits = 0;
  let stops = 0;
  const result = await migrateLegacyCodexLbDesktopMode({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    env: { HOME: setup.home },
    restartApp: true,
    quitAppImpl: async (): Promise<CodexAppQuitResult> => {
      quits += 1;
      assert.equal(running, false);
      assert.match(await fsp.readFile(setup.authPath, 'utf8'), /OPENAI_API_KEY/);
      return {
        schema: 'sks.codex-app-quit.v1',
        ok: true,
        status: 'quit',
        app_name: 'Codex',
        blockers: []
      };
    },
    settings: { listen_host: '127.0.0.1', listen_port: 49152 },
    bridgeStatusImpl: async () => bridgeStatus(setup.home, 49152, running),
    installBridgeImpl: async () => {
      running = true;
      return bridgeStatus(setup.home, 49152, true);
    },
    stopBridgeImpl: async () => {
      stops += 1;
      running = false;
      return {
        ...bridgeStatus(setup.home, 49152, false),
        ok: true,
        blockers: []
      };
    },
    restartAppImpl: async (): Promise<CodexAppRestartResult> => ({
      schema: 'sks.codex-app-restart.v1',
      ok: true,
      status: 'restarted',
      app_name: 'Codex',
      blockers: []
    }),
    fetchImpl: async (request) => {
      httpChecks += 1;
      const url = String(request);
      return new Response(
        url.endsWith('/models')
          ? '{"models":[]}'
          : '{"schema_version":"codex-lb.desktop-capabilities.v1"}',
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    },
    webSocketProbeImpl: async () => {
      webSocketChecks += 1;
      return { ok: true, blocker: null, status_code: 101 };
    }
  });

  assert.equal(result.ok, true);
  assert.equal((result.detection as Record<string, unknown>).managed_openai_base_url, REMOTE);
  assert.equal((result.detection as Record<string, unknown>).provider_base_url, REMOTE);
  assert.deepEqual((result.detection as Record<string, unknown>).blockers, []);
  assert.equal(result.status, 'migrated');
  assert.equal(
    (result.capability_summary as Record<string, unknown>).desktop_adoption,
    'unverified'
  );
  assert.equal(quits, 1);
  assert.ok(httpChecks >= 2);
  assert.equal(webSocketChecks, 1);
  assert.equal(stops, 0);
  assert.match(
    await fsp.readFile(setup.configPath, 'utf8'),
    /sks-codex-lb-managed-desktop-bridge/
  );
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('cli-provider capabilities verify the CLI plane with Bearer env_key auth and a real image probe', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, [
    'service_tier = "fast"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  const fetchCalls: Array<{ url: string; auth: string | null; customHeader: string | null; method: string }> = [];
  let responsesPosts = 0;
  const fetchImpl = (async (request: any, init: any = {}) => {
    const url = String(request);
    const headers = (init.headers || {}) as Record<string, string>;
    fetchCalls.push({
      url,
      auth: headers.authorization || headers.Authorization || null,
      customHeader: headers['X-Codex-LB-API-Key'] || null,
      method: String(init.method || 'GET')
    });
    if (url.endsWith('/capabilities')) {
      return new Response('{"error":{"message":"Not Found"}}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({
        data: [{
          id: 'gpt-5.6-sol',
          display_name: 'GPT 5.6 Sol',
          supported_in_api: true,
          supported_reasoning_levels: [{ effort: 'high' }],
          truncation_policy: { mode: 'tokens' },
          use_responses_lite: false,
          additional_speed_tiers: ['fast'],
          service_tiers: [{ id: 'priority' }]
        }]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.endsWith('/responses')) {
      responsesPosts += 1;
      const id = responsesPosts === 1 ? 'resp_cli_1' : 'resp_cli_2';
      const sse = `data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id,
          status: 'completed',
          requested_service_tier: 'priority',
          service_tier: 'priority',
          output: []
        }
      })}\ndata: [DONE]\n`;
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response('{"error":"unexpected"}', { status: 500 });
  }) as typeof fetch;
  let imageProbeCalls = 0;

  const report = await buildCodexLbDesktopCapabilities({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    level: 'transport',
    networkProbes: true,
    fetchImpl,
    cliImageProbeImpl: async () => {
      imageProbeCalls += 1;
      return {
        ok: true,
        status: 'image_generated' as const,
        http_status: 200,
        response_id: 'resp_img_cli',
        events: [{ type: 'response.image_generation_call.completed', result: 'aW1n' }],
        tool_accepted: true,
        image_event_seen: true,
        artifact_materialized: true,
        forced_tool_choice_used: true,
        blockers: [],
        error: null
      };
    }
  });

  assert.equal(report.mode, 'cli-provider');
  assert.equal(report.gateway_auth_transport.state, 'verified');
  assert.equal(report.gateway_auth_transport.evidence.preferred_authorization_bearer, true);
  assert.equal(report.provider_identity.state, 'verified');
  assert.equal(report.catalog.state, 'verified');
  assert.equal(report.model_picker.state, 'verified');
  assert.equal(report.fast_mode.state, 'verified');
  assert.equal(report.text_responses.state, 'verified');
  assert.equal(report.image_generation.state, 'verified');
  assert.equal(report.image_generation.evidence.cli_transport_accepted, true);
  assert.equal(report.overall, 'verified');
  assert.equal(imageProbeCalls, 1);
  const modelsCall = fetchCalls.find((call) => call.url.endsWith('/models'));
  assert.equal(modelsCall?.auth, `Bearer ${API_KEY}`);
  assert.equal(modelsCall?.customHeader, null);
  const responsesCall = fetchCalls.find((call) => call.url.endsWith('/responses'));
  assert.equal(responsesCall?.auth, `Bearer ${API_KEY}`);
  assert.equal(responsesCall?.customHeader, null);
});

test('rollback command rejects receipt traversal before touching the filesystem', async (t) => {
  const setup = await fixture(t);
  const result = await rollbackCodexLbDesktopMode('../outside', {
    home: setup.home,
    receiptDir: path.join(setup.codexHome, 'receipts'),
    platform: 'linux'
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'invalid_receipt_id');
  assert.deepEqual(result.blockers, ['invalid_receipt_id']);
});

test('rollback validates receipt conflicts before stopping a valid bridge', async (t) => {
  const setup = await fixture(t);
  const receiptDir = path.join(setup.codexHome, 'receipts');
  const receiptId = 'conflict-before-stop';
  await fsp.mkdir(receiptDir, { recursive: true });
  await fsp.writeFile(path.join(receiptDir, `${receiptId}.json`), `${JSON.stringify({
    schema: 'sks.codex-lb-migration-receipt.v1',
    id: receiptId,
    created_at: '2026-07-28T00:00:00.000Z',
    from_mode: 'disabled',
    to_mode: 'desktop-native-bridge',
    files: [{
      path: setup.configPath,
      before_sha256: null,
      after_sha256: createHash('sha256').update('different config').digest('hex'),
      backup_path: null,
      owned_by_sks: false
    }],
    bridge_state_path: null,
    oauth_preserved: true,
    capability_summary: {}
  }, null, 2)}\n`);
  let stops = 0;
  const result = await rollbackCodexLbDesktopMode(receiptId, {
    home: setup.home,
    receiptDir,
    stopBridgeImpl: async () => {
      stops += 1;
      return bridgeStatus(setup.home, 49152, false);
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'rollback_conflict');
  assert.equal(stops, 0);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
});

test('retired compat config is reported blocked and never active', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'requires_openai_auth = true',
    'supports_websockets = true',
    '',
    '[model_providers.codex-lb.env_http_headers]',
    '"X-Codex-LB-API-Key" = "CODEX_LB_API_KEY"',
    ''
  ].join('\n'));

  const status = await codexLbDesktopStatusV2({
    home: setup.home,
    configPath: setup.configPath,
    authPath: setup.authPath,
    envPath: setup.envPath,
    platform: 'linux',
    networkProbes: false,
    bridgeStatusImpl: async () => bridgeStatus(setup.home, 49152, false)
  });

  assert.equal(status.mode, 'desktop-dual-auth-compat');
  assert.equal(status.ok, false);
  assert.equal(status.status, 'blocked');
  assert.equal(status.routing_active, false);
  assert.ok((status.blockers as string[]).includes('desktop_dual_auth_compat_unavailable'));
});
