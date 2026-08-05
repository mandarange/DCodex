#!/usr/bin/env node
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {
  buildCombinedBridgeCatalog,
} from '../../dist/core/codex-lb/combined-catalog.js';
import {
  resolveAllProviderCredentials,
} from '../../dist/core/codex-lb/provider-credentials.js';
import {
  resolveBridgeProviderRegistry,
} from '../../dist/core/codex-lb/provider-registry.js';
import {
  buildBridgeRoutingPolicy,
  validateBridgeRoutingPolicy,
} from '../../dist/core/codex-lb/provider-route-policy.js';
import {
  resolveBridgeRequestRoute,
} from '../../dist/core/codex-lb/request-route-resolver.js';
import { sha256Stable } from '../../dist/core/codex-lb/route-index.js';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  desktopBridgeConfigGeneration,
  getDesktopBridgeStatus,
  readDesktopBridgeState,
  selectAvailableDesktopBridgePort,
  startDesktopBridge,
  stopDesktopBridge,
} from '../../dist/core/codex-lb/desktop-bridge/index.js';

const sentinels = {
  lb: 'sandbox-lb-credential-do-not-log',
  openrouter: 'sandbox-openrouter-credential-do-not-log',
  oauth: 'sandbox-desktop-oauth-do-not-forward',
  forged: 'sandbox-forged-provider-key-do-not-forward',
};
const root = requiredAbsolutePath('SKS_ARCHITECTURE_SANDBOX_ROOT');
const home = requiredInsideRoot('HOME');
const codexHome = requiredInsideRoot('CODEX_HOME');
const sksHome = requiredInsideRoot('SKS_HOME');
const globalRoot = requiredInsideRoot('SKS_GLOBAL_ROOT');
const tempRoot = requiredInsideRoot('TMPDIR');
const scenarioPath = requiredAbsolutePath('SKS_ARCHITECTURE_SCENARIOS');
const scenarios = JSON.parse(await fsp.readFile(scenarioPath, 'utf8'));
assert.equal(scenarios.schema, 'sks.desktop-bridge-hermetic-scenarios.v1');
assert.deepEqual(Object.keys(scenarios.providers).sort(), ['codex-lb', 'openrouter']);
assert.equal(new Set([home, codexHome, sksHome, globalRoot, tempRoot]).size, 5);
for (const name of ['CODEX_LB_API_KEY', 'OPENROUTER_API_KEY', 'OPENAI_API_KEY', 'CODEX_OAUTH_TOKEN']) {
  assert.equal(process.env[name], undefined, `${name}_must_not_cross_sandbox_boundary`);
}

const writeTargets = [
  path.join(codexHome, 'sandbox-install.json'),
  path.join(sksHome, 'desktop-bridge-state.json'),
  path.join(root, 'evidence', 'bridge-report.json'),
];
assert.equal(writeTargets.every((candidate) => inside(candidate, root)), true);
await fsp.writeFile(
  writeTargets[0],
  `${JSON.stringify({ schema: 'sks.desktop-bridge-sandbox-install.v1' })}\n`,
  { mode: 0o600 },
);

const upstreams = await Promise.all([
  startUpstream('codex-lb'),
  startUpstream('openrouter'),
]);
let bridge = null;

try {
  const credentials = await fixtureCredentials();
  const registry = await resolveBridgeProviderRegistry({
    credentials,
    storedRegistry: {
      schema: 'sks.bridge-provider-registry.v1',
      profiles: {
        'codex-lb': {
          enabled: true,
          endpoint_url: 'https://lb.example.test/backend-api/codex',
          allowed_origins: ['https://lb.example.test'],
          auth_transport: 'x-codex-lb-api-key',
        },
        openrouter: {
          enabled: true,
          endpoint_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'],
          auth_transport: 'openrouter-bearer',
        },
      },
    },
  });
  assert.equal(registry.profiles['codex-lb'].state, 'ready');
  assert.equal(registry.profiles.openrouter.state, 'ready');

  const firstBuild = buildCatalog(registry, scenarios, 'generation-1');
  const firstPolicy = buildBridgeRoutingPolicy({
    route_index: firstBuild.route_index,
    catalog_generation: firstBuild.catalog.generation,
    default_provider_id: null,
    changed_at: '2026-08-06T00:00:00.000Z',
  });
  assert.deepEqual(validateBridgeRoutingPolicy(firstPolicy, firstBuild.route_index), []);
  assert.equal(firstPolicy.fallback, 'none');
  for (const providerId of ['codex-lb', 'openrouter']) {
    const routeKey = scenarios.providers[providerId].route_key;
    assert.equal(firstBuild.route_index.routes[routeKey].provider_id, providerId);
    assert.deepEqual(firstPolicy.model_routes[routeKey], firstBuild.route_index.routes[routeKey]);
  }

  const routed = {};
  for (const providerId of ['codex-lb', 'openrouter']) {
    const scenario = scenarios.providers[providerId];
    routed[providerId] = resolveBridgeRequestRoute({ model: scenario.route_key }, firstPolicy, {
      route_index: firstBuild.route_index,
      registry,
      active_catalog_generation: firstBuild.catalog.generation,
    });
    assert.equal(routed[providerId].ok, true);
    assert.equal(routed[providerId].route.provider_id, providerId);
    assert.equal(routed[providerId].fallback, 'none');
  }
  const missing = resolveBridgeRequestRoute({ model: 'missing-sandbox-route' }, firstPolicy, {
    route_index: firstBuild.route_index,
    registry,
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.blockers, ['catalog_model_route_missing']);
  assert.equal(missing.fallback, 'none');

  const pinSeed = resolveBridgeRequestRoute({
    model: scenarios.providers.openrouter.route_key,
    thread_id: 'sandbox-thread-openrouter',
  }, firstPolicy, {
    route_index: firstBuild.route_index,
    registry,
    active_catalog_generation: firstBuild.catalog.generation,
    now: () => '2026-08-06T00:01:00.000Z',
  });
  assert.equal(pinSeed.ok, true);
  assert.ok(pinSeed.proposed_session_pin);
  const pin = pinSeed.proposed_session_pin;
  const pinned = resolveBridgeRequestRoute({
    model: scenarios.providers.openrouter.route_key,
    thread_id: pin.thread_id,
  }, firstPolicy, {
    route_index: firstBuild.route_index,
    registry,
    session_pins: [pin],
  });
  assert.equal(pinned.source, 'session_pin');
  assert.equal(pinned.route.provider_id, 'openrouter');
  const tamperedPin = resolveBridgeRequestRoute({
    model: scenarios.providers.openrouter.route_key,
    thread_id: pin.thread_id,
  }, firstPolicy, {
    route_index: firstBuild.route_index,
    registry,
    session_pins: [{ ...pin, upstream_model: 'tampered/upstream' }],
  });
  assert.equal(tamperedPin.ok, false);
  assert.deepEqual(tamperedPin.blockers, ['session_pin_route_unavailable']);
  assert.equal(tamperedPin.fallback, 'none');

  const firstPort = await selectAvailableDesktopBridgePort('127.0.0.1');
  const firstConfig = bridgeConfig({
    registry,
    routeIndex: firstBuild.route_index,
    policy: firstPolicy,
    credentials,
    upstreams,
    listenPort: firstPort,
    pins: [pin],
  });
  bridge = await startDesktopBridge(firstConfig, { statePath: writeTargets[1] });
  const firstHealth = await getJson(firstPort, '/__sks/diagnostics/health');
  assert.equal(firstHealth.runtime, 'desktop-bridge');
  assert.equal(firstHealth.state, 'ready');
  assert.equal(bridge.state.enabled_providers.length, 2);
  assert.deepEqual(new Set(bridge.state.enabled_providers), new Set(['codex-lb', 'openrouter']));

  await Promise.all(['codex-lb', 'openrouter'].map((providerId) =>
    postBridge(firstPort, scenarios.providers[providerId].route_key)));
  assert.equal(upstreams[0].requests.length, 1);
  assert.equal(upstreams[1].requests.length, 1);
  assertForwarding(upstreams, scenarios);

  const firstState = await readDesktopBridgeState(writeTargets[1]);
  assert.ok(firstState);
  const firstConfigGeneration = desktopBridgeConfigGeneration(firstConfig);
  assert.equal(firstState.config_generation, firstConfigGeneration);
  await stopDesktopBridge(bridge);
  bridge = null;
  assert.equal(await readDesktopBridgeState(writeTargets[1]), null);

  const secondBuild = buildCatalog(registry, scenarios, 'generation-2');
  const secondPolicy = buildBridgeRoutingPolicy({
    route_index: secondBuild.route_index,
    catalog_generation: secondBuild.catalog.generation,
    default_provider_id: null,
    changed_at: '2026-08-06T00:02:00.000Z',
  });
  assert.notEqual(secondPolicy.catalog_generation, firstPolicy.catalog_generation);
  assert.notEqual(secondPolicy.policy_generation, firstPolicy.policy_generation);
  const stalePin = resolveBridgeRequestRoute({
    model: scenarios.providers.openrouter.route_key,
    thread_id: pin.thread_id,
  }, secondPolicy, {
    route_index: secondBuild.route_index,
    registry,
    session_pins: [pin],
  });
  assert.equal(stalePin.ok, false);
  assert.deepEqual(stalePin.blockers, ['session_pin_route_unavailable']);

  const recovered = resolveBridgeRequestRoute({
    model: scenarios.providers.openrouter.route_key,
    thread_id: pin.thread_id,
  }, secondPolicy, {
    route_index: secondBuild.route_index,
    registry,
    active_catalog_generation: secondBuild.catalog.generation,
    now: () => '2026-08-06T00:03:00.000Z',
  });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.source, 'route_index');
  assert.equal(recovered.proposed_session_pin.catalog_generation, secondPolicy.catalog_generation);

  const secondPort = await selectAvailableDesktopBridgePort('127.0.0.1');
  const secondConfig = bridgeConfig({
    registry,
    routeIndex: secondBuild.route_index,
    policy: secondPolicy,
    credentials,
    upstreams,
    listenPort: secondPort,
    pins: [recovered.proposed_session_pin],
  });
  bridge = await startDesktopBridge(secondConfig, { statePath: writeTargets[1] });
  const secondHealth = await getJson(secondPort, '/__sks/diagnostics/health');
  assert.equal(secondHealth.catalog_generation, secondPolicy.catalog_generation);
  const status = await getDesktopBridgeStatus({
    statePath: writeTargets[1],
    expectedConfigGeneration: firstConfigGeneration,
    processExists: () => true,
  });
  assert.equal(status.status, 'configuration_mismatch');
  const currentState = await readDesktopBridgeState(writeTargets[1]);
  assert.ok(currentState);
  assert.notEqual(currentState.process_generation, firstState.process_generation);
  assert.notEqual(currentState.config_generation, firstState.config_generation);

  const files = await listFiles(root);
  const report = {
    schema: 'sks.desktop-bridge-hermetic-worker-report.v1',
    ok: true,
    isolation: {
      roots_isolated: true,
      ambient_credentials_visible: false,
      user_state_access: 'none_by_construction',
      all_writes_inside_sandbox: writeTargets.every((candidate) => inside(candidate, root)),
      files_created: files,
    },
    bridge_contract: {
      runtime: 'desktop-bridge',
      runtime_count: 1,
      simultaneous_profiles: ['codex-lb', 'openrouter'],
      explicit_route_index: true,
      fallback: 'none',
      pin_affinity: 'passed',
      pin_tamper_fail_closed: 'passed',
      ambient_auth_stripping: 'passed',
      provider_credential_isolation: 'passed',
      restart_generation_recovery: 'passed',
      stale_generation_fail_closed: 'passed',
      state_secret_free: true,
      state_mode: (await fsp.stat(writeTargets[1])).mode & 0o777,
    },
  };
  assert.deepEqual(
    new Set(scenarios.required_assertions),
    new Set([
      'isolated_roots',
      'single_bridge_runtime',
      'simultaneous_provider_profiles',
      'explicit_route_index_no_fallback',
      'pin_affinity_tamper_fail_closed',
      'restart_generation_recovery',
      'ambient_credential_stripping',
      'write_confinement',
      'secret_free_output_and_state',
    ]),
  );
  assert.equal(report.bridge_contract.state_mode, 0o600);
  await assertSecretSafe(report, root, Object.values(sentinels));
  await fsp.mkdir(path.dirname(writeTargets[2]), { recursive: true, mode: 0o700 });
  await fsp.writeFile(writeTargets[2], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await assertSecretSafe(report, root, Object.values(sentinels));
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (bridge) await stopDesktopBridge(bridge).catch(() => undefined);
  await Promise.all(upstreams.map((upstream) => closeServer(upstream.server)));
}

async function fixtureCredentials() {
  const checkedAt = '2026-08-06T00:00:00.000Z';
  return resolveAllProviderCredentials({
    codexLb: {
      processEnv: {},
      validation: { state: 'ready', checked_at: checkedAt },
      loadCodexLbEnvImpl: async () => ({
        schema: 'sks.codex-lb-env.v1',
        configured: true,
        missing: [],
        source: 'env-file',
        source_priority: ['env-file'],
        base_url: 'https://lb.example.test/backend-api/codex',
        api_key: {
          present: true,
          usable: true,
          source: 'env-file',
          redacted: true,
          fingerprint: 'sandbox-lb-fingerprint',
        },
        secret_api_key: sentinels.lb,
        credential_binding: {
          checked: true,
          present: true,
          valid: true,
          status: 'matched',
          metadata_path: '/sandbox/credential-metadata.json',
          api_key_matches: true,
          base_url_matches: true,
          blockers: [],
        },
        env_paths: ['/sandbox/provider.env'],
        keychain: { checked: false, available: false, status: 'not_used' },
      }),
    },
    openrouter: {
      processEnv: {},
      validation: { state: 'ready', checked_at: checkedAt },
      resolveOpenRouterApiKeyImpl: async () => ({
        key: sentinels.openrouter,
        source: 'user-secret-store',
        key_preview: 'sandbox-...-log',
        blockers: [],
        warnings: [],
      }),
    },
  });
}

function buildCatalog(registry, scenarios, generation) {
  const result = buildCombinedBridgeCatalog(registry, {
    created_at: generation === 'generation-1'
      ? '2026-08-06T00:00:00.000Z'
      : '2026-08-06T00:02:00.000Z',
    catalogs: {
      'codex-lb': {
        provider_id: 'codex-lb',
        state: 'verified',
        generation: `lb-${generation}`,
        models: {
          models: [{
            slug: scenarios.providers['codex-lb'].upstream_model,
            display_name: 'Sandbox Codex LB model',
          }],
        },
      },
      openrouter: {
        provider_id: 'openrouter',
        state: 'verified',
        generation: `openrouter-${generation}`,
        models: [{
          id: scenarios.providers.openrouter.upstream_model,
          name: 'Sandbox OpenRouter model',
        }],
      },
    },
  });
  assert.equal(result.ok, true, JSON.stringify(result.blockers));
  return result;
}

function bridgeConfig(input) {
  const endpoints = Object.fromEntries(input.upstreams.map((upstream) => [upstream.name, upstream.origin]));
  const providers = {};
  for (const providerId of ['codex-lb', 'openrouter']) {
    const profile = input.registry.profiles[providerId];
    providers[providerId] = {
      provider_id: providerId,
      enabled: true,
      base_url: endpoints[providerId],
      allowed_origins: [endpoints[providerId]],
      auth_transport: profile.endpoint.auth_transport,
      credential_state: profile.credential.state,
      credential_fingerprint: profile.credential.fingerprint,
      credential_generation: profile.profile_generation,
      source_catalog_generation: input.routeIndex.providers[providerId].catalog_generation,
    };
  }
  return {
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: sha256Stable(providers),
      created_at: '2026-08-06T00:00:00.000Z',
      providers,
    },
    routePolicy: input.policy,
    providerSessionPins: input.pins,
    resolveProviderCredential: async (providerId, expectedGeneration) => {
      const profile = input.registry.profiles[providerId];
      const credential = input.credentials[providerId];
      assert.equal(expectedGeneration, profile.profile_generation);
      assert.ok(credential.secret);
      return {
        provider_id: providerId,
        value: credential.secret,
        source: credential.source || 'sandbox-fixture',
        fingerprint: credential.fingerprint,
        generation: expectedGeneration,
      };
    },
    listenHost: '127.0.0.1',
    listenPort: input.listenPort,
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 5_000,
  };
}

async function startUpstream(name) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.once('end', () => {
      requests.push({
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return { name, server, requests, origin: `http://127.0.0.1:${address.port}` };
}

function postBridge(port, model) {
  const body = JSON.stringify({ model, input: 'sandbox' });
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        authorization: `Bearer ${sentinels.oauth}`,
        cookie: 'desktop=sandbox-session-cookie',
        'x-api-key': sentinels.forged,
        'x-codex-lb-api-key': sentinels.forged,
        'x-sks-internal-sentinel': sentinels.forged,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(body)),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`sandbox_bridge_request_failed:${response.statusCode}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: pathname }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.once('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('sandbox_bridge_health_invalid')); }
      });
    });
    request.once('error', reject);
  });
}

function assertForwarding(upstreams, scenarios) {
  const lb = upstreams.find((upstream) => upstream.name === 'codex-lb').requests[0];
  const openrouter = upstreams.find((upstream) => upstream.name === 'openrouter').requests[0];
  assert.equal(JSON.parse(lb.body).model, scenarios.providers['codex-lb'].upstream_model);
  assert.equal(JSON.parse(openrouter.body).model, scenarios.providers.openrouter.upstream_model);
  assert.equal(lb.headers['x-codex-lb-api-key'], sentinels.lb);
  assert.equal(lb.headers.authorization, undefined);
  assert.equal(openrouter.headers.authorization, `Bearer ${sentinels.openrouter}`);
  assert.equal(openrouter.headers['x-codex-lb-api-key'], undefined);
  for (const request of [lb, openrouter]) {
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-api-key'], undefined);
    assert.equal(request.headers['x-sks-internal-sentinel'], undefined);
    assert.equal(JSON.stringify(request).includes(sentinels.oauth), false);
    assert.equal(JSON.stringify(request).includes(sentinels.forged), false);
  }
}

async function assertSecretSafe(report, sandboxRoot, secrets) {
  const texts = [JSON.stringify(report)];
  for (const relative of await listFiles(sandboxRoot)) {
    const absolute = path.join(sandboxRoot, relative);
    const stat = await fsp.stat(absolute);
    if (stat.size <= 1_000_000) texts.push(await fsp.readFile(absolute, 'utf8').catch(() => ''));
  }
  const joined = texts.join('\n');
  for (const secret of secrets) assert.equal(joined.includes(secret), false);
  assert.equal(/authorization\s*[:=]\s*bearer\s+\S+/i.test(joined), false);
}

async function listFiles(directory) {
  const output = [];
  async function walk(current, depth = 0) {
    if (depth > 32) throw new Error('sandbox_file_walk_depth_exceeded');
    for (const entry of await fsp.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute, depth + 1);
      else output.push(path.relative(directory, absolute));
    }
  }
  await walk(directory);
  return output.sort();
}

function requiredAbsolutePath(name) {
  const value = process.env[name] || '';
  if (!path.isAbsolute(value)) throw new Error(`sandbox_${name.toLowerCase()}_invalid`);
  return path.resolve(value);
}

function requiredInsideRoot(name) {
  const value = requiredAbsolutePath(name);
  if (!inside(value, root)) throw new Error(`sandbox_${name.toLowerCase()}_escaped`);
  return value;
}

function inside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}
