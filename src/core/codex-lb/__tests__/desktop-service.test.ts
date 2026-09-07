import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  DESKTOP_BRIDGE_SETTINGS_SCHEMA,
  defaultDesktopBridgeServiceSettings,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  launchCommandForExecutable,
  readDesktopBridgeClientCapability,
  readDesktopBridgeServiceSettings,
  resolveDesktopBridgeActivationSettings,
  resolveDesktopBridgeRuntimeConfig,
  writeDesktopBridgeServiceSettings
} from '../desktop-service.js';
import { renderDesktopBridgeLaunchdPlist } from '../desktop-bridge/launchd.js';
import { createDesktopBridgePublicState, writeDesktopBridgeState } from '../desktop-bridge/index.js';

const CLIENT_CAPABILITY = Buffer.alloc(32, 0x49).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-service-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  return { home, paths: desktopBridgeServicePaths(home) };
}

test('first activation selects a random available high port and persists only nonsecret settings', async (t) => {
  const setup = await fixture(t);
  let selections = 0;
  const settings = await resolveDesktopBridgeActivationSettings({
    home: setup.home,
    selectAvailablePort: async (host) => {
      selections += 1;
      assert.equal(host, '127.0.0.1');
      return 54_321;
    }
  });

  assert.equal(settings.listen_port, 54_321);
  assert.equal(settings.route_policy.default_provider_id, null);
  assert.equal(settings.provider_registry.providers['codex-lb'].enabled, false);
  assert.equal(selections, 1);
  const clientCapability = await readDesktopBridgeClientCapability(setup.paths.client_capability_path);
  const capabilityStat = await fsp.stat(setup.paths.client_capability_path);
  assert.match(clientCapability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(capabilityStat.mode & 0o777, 0o600);
  if (typeof process.getuid === 'function') assert.equal(capabilityStat.uid, process.getuid());
  assert.equal(settings.client_capability_sha256, createHash('sha256').update(clientCapability).digest('hex'));
  await writeDesktopBridgeServiceSettings(setup.paths.settings_path, settings);
  const raw = await fsp.readFile(setup.paths.settings_path, 'utf8');
  const stat = await fsp.stat(setup.paths.settings_path);
  assert.equal(stat.mode & 0o077, 0);
  assert.doesNotMatch(raw, /"(?:api_key|secret|authorization|cookie|access_token|refresh_token)"\s*:|Bearer\s+[A-Za-z0-9._~-]{8,}/i);
  assert.equal(raw.includes(clientCapability), false);

  const state = createDesktopBridgePublicState({
    providerRegistry: settings.provider_registry,
    routePolicy: settings.route_policy,
    providerSessionPins: settings.provider_session_pins,
    resolveProviderCredential: async () => { throw new Error('not used'); },
    clientCapabilitySha256: settings.client_capability_sha256,
    listenHost: settings.listen_host,
    listenPort: settings.listen_port,
    allowedPathPrefixes: ['/v1/'],
    allowedOrigins: settings.allowed_origins,
    connectTimeoutMs: settings.connect_timeout_ms,
    idleTimeoutMs: settings.idle_timeout_ms
  });
  await writeDesktopBridgeState(setup.paths.state_path, state);
  const stateRaw = await fsp.readFile(setup.paths.state_path, 'utf8');
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: '/usr/local/bin/sks',
    arguments: ['bridge', 'serve', '--settings', setup.paths.settings_path],
    stdoutPath: setup.paths.stdout_log_path,
    stderrPath: setup.paths.stderr_log_path
  });
  assert.equal(stateRaw.includes(clientCapability), false);
  assert.equal(plist.includes(clientCapability), false);

  const reused = await resolveDesktopBridgeActivationSettings({
    home: setup.home,
    selectAvailablePort: async () => {
      throw new Error('persisted port must be reused');
    }
  });
  assert.equal(reused.listen_port, 54_321);
  assert.deepEqual(await readDesktopBridgeServiceSettings(setup.paths.settings_path), settings);
});

test('malformed, permissive, and symlinked client capability files fail closed', async (t) => {
  const setup = await fixture(t);
  await fsp.mkdir(path.dirname(setup.paths.client_capability_path), { recursive: true });

  await fsp.writeFile(setup.paths.client_capability_path, 'not-a-capability\n', { mode: 0o600 });
  await assert.rejects(
    readDesktopBridgeClientCapability(setup.paths.client_capability_path),
    /desktop_bridge_client_capability_invalid/
  );

  await fsp.writeFile(setup.paths.client_capability_path, `${CLIENT_CAPABILITY}\n`, { mode: 0o600 });
  await fsp.chmod(setup.paths.client_capability_path, 0o644);
  await assert.rejects(
    readDesktopBridgeClientCapability(setup.paths.client_capability_path),
    /desktop_bridge_client_capability_permissions_unsafe/
  );

  await fsp.unlink(setup.paths.client_capability_path);
  const symlinkTarget = path.join(setup.home, 'capability-target');
  await fsp.writeFile(symlinkTarget, `${CLIENT_CAPABILITY}\n`, { mode: 0o600 });
  await fsp.symlink(symlinkTarget, setup.paths.client_capability_path);
  await assert.rejects(readDesktopBridgeClientCapability(setup.paths.client_capability_path));
});

test('launchd plist rejects secret-bearing arguments and contains no secret environment', () => {
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: '/usr/local/bin/sks',
    arguments: ['bridge', 'serve', '--settings', '/tmp/settings.json'],
    stdoutPath: '/tmp/bridge.out.log',
    stderrPath: '/tmp/bridge.err.log'
  });
  assert.match(plist, /com\.sneakoscope\.desktop-bridge/);
  assert.doesNotMatch(plist, /EnvironmentVariables|CODEX_LB_API_KEY|X-Codex-LB-API-Key/);
  assert.throws(
    () => renderDesktopBridgeLaunchdPlist({
      executablePath: '/usr/local/bin/sks',
      arguments: ['bridge', 'serve', '--api-key=secret'],
      stdoutPath: '/tmp/bridge.out.log',
      stderrPath: '/tmp/bridge.err.log'
    }),
    /bridge_launchd_secret_argument_forbidden/
  );
});

test('desktop bridge service is explicitly unsupported away from macOS', async (t) => {
  const setup = await fixture(t);
  await writeDesktopBridgeServiceSettings(
    setup.paths.settings_path,
    defaultDesktopBridgeServiceSettings({ listen_port: 54_321 })
  );
  const status = await desktopBridgeServiceStatus({
    home: setup.home,
    platform: 'linux'
  });
  assert.equal(status.ok, false);
  assert.equal(status.supported, false);
  assert.equal(status.status, 'unsupported');
  assert.deepEqual(status.blockers, ['desktop_bridge_service_requires_macos']);
});

test('runtime session pins persist atomically without changing the static service generation', async (t) => {
  const setup = await fixture(t);
  const base = defaultDesktopBridgeServiceSettings({
    listen_port: 54_321,
    client_capability_sha256: CLIENT_CAPABILITY_SHA256
  });
  const settings = defaultDesktopBridgeServiceSettings({
    ...base,
    provider_registry: {
      ...base.provider_registry,
      generation: 'registry-session-pin',
      providers: {
        ...base.provider_registry.providers,
        'codex-lb': {
          ...base.provider_registry.providers['codex-lb'],
          enabled: true,
          base_url: 'https://lb.example.test/backend-api/codex',
          allowed_origins: ['https://lb.example.test'],
          credential_state: 'ready',
          credential_fingerprint: 'fingerprint-session-pin',
          credential_generation: 'credential-session-pin',
          source_catalog_generation: 'catalog-session-pin'
        }
      }
    },
    route_policy: {
      schema: 'sks.bridge-routing-policy.v1',
      default_provider_id: 'codex-lb',
      fallback: 'none',
      model_routes: {
        'public-model': { provider_id: 'codex-lb', upstream_model: 'upstream-model' }
      },
      catalog_generation: 'catalog-session-pin',
      policy_generation: 'policy-session-pin',
      changed_at: '2026-08-05T00:00:00.000Z'
    }
  });
  await writeDesktopBridgeServiceSettings(setup.paths.settings_path, settings);
  const runtime = await resolveDesktopBridgeRuntimeConfig({
    home: setup.home,
    settingsPath: setup.paths.settings_path,
    clientCapability: CLIENT_CAPABILITY,
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: 'fixture-secret-not-persisted',
      source: 'test',
      fingerprint: 'fingerprint-session-pin',
      generation: expectedGeneration
    })
  });
  const pin = {
    thread_id: 'thread-session-pin',
    provider_id: 'codex-lb' as const,
    public_model: 'public-model',
    upstream_model: 'upstream-model',
    catalog_generation: 'catalog-session-pin',
    route_policy_generation: 'policy-session-pin',
    created_at: '2026-08-05T00:00:00.000Z'
  };

  await runtime.config.persistProviderSessionPins?.([pin]);
  const persisted = await readDesktopBridgeServiceSettings(setup.paths.settings_path);
  assert.deepEqual(persisted?.provider_session_pins, [pin]);
  assert.equal(persisted?.provider_registry.generation, settings.provider_registry.generation);
  assert.equal(persisted?.route_policy.policy_generation, settings.route_policy.policy_generation);
  assert.doesNotMatch(await fsp.readFile(setup.paths.settings_path, 'utf8'), /fixture-secret-not-persisted/);
});

test('runtime never promotes an unvalidated or rotated OpenRouter credential to ready', async (t) => {
  const setup = await fixture(t);
  const key = 'sk-or-v1-runtime-validation-fixture';
  const rotated = 'sk-or-v2-runtime-validation-fixture';
  const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 16);
  const base = defaultDesktopBridgeServiceSettings({
    listen_port: 54_322,
    client_capability_sha256: CLIENT_CAPABILITY_SHA256
  });
  const settingsFor = (state: 'configured_unverified' | 'ready') => defaultDesktopBridgeServiceSettings({
    ...base,
    provider_registry: {
      ...base.provider_registry,
      generation: `registry-${state}`,
      providers: {
        ...base.provider_registry.providers,
        openrouter: {
          ...base.provider_registry.providers.openrouter,
          enabled: true,
          credential_state: state,
          credential_fingerprint: fingerprint(key),
          credential_generation: `validated-profile-${state}`,
          source_catalog_generation: 'openrouter-catalog'
        }
      }
    },
    route_policy: {
      schema: 'sks.bridge-routing-policy.v1',
      default_provider_id: 'openrouter',
      fallback: 'none',
      model_routes: { 'public-model': { provider_id: 'openrouter', upstream_model: 'vendor/model' } },
      catalog_generation: 'combined-catalog',
      policy_generation: 'route-policy',
      changed_at: '2026-08-05T00:00:00.000Z'
    }
  });

  await assert.rejects(
    resolveDesktopBridgeRuntimeConfig({
      home: setup.home,
      clientCapability: CLIENT_CAPABILITY,
      settings: settingsFor('configured_unverified'),
      env: { HOME: setup.home, OPENROUTER_API_KEY: key }
    }),
    /desktop_bridge_provider_credentials_unavailable/
  );

  const validated = await resolveDesktopBridgeRuntimeConfig({
    home: setup.home,
    clientCapability: CLIENT_CAPABILITY,
    settings: settingsFor('ready'),
    env: { HOME: setup.home, OPENROUTER_API_KEY: key }
  });
  assert.equal(validated.config.providerRegistry.providers.openrouter.credential_state, 'ready');
  assert.equal(validated.config.providerRegistry.providers.openrouter.credential_generation, 'validated-profile-ready');

  await assert.rejects(
    resolveDesktopBridgeRuntimeConfig({
      home: setup.home,
      clientCapability: CLIENT_CAPABILITY,
      settings: settingsFor('ready'),
      env: { HOME: setup.home, OPENROUTER_API_KEY: rotated }
    }),
    /desktop_bridge_provider_credentials_unavailable/
  );
});

test('launchd bootstrap retries only after the previous service instance is fully removed', async () => {
  const { bootstrapLaunchdWithRetry } = await import('../desktop-service.js');
  const calls: string[][] = [];
  let printsUntilGone = 2;
  let bootstrapAttempts = 0;
  const run = async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[0] === 'print') {
      printsUntilGone -= 1;
      return { code: printsUntilGone >= 0 ? 0 : 1, stdout: printsUntilGone >= 0 ? 'state = running\npid = 1' : '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false };
    }
    if (args[0] === 'bootstrap') {
      assert.equal(printsUntilGone < 0, true, 'bootstrap must wait until launchd reports the service removed');
      bootstrapAttempts += 1;
      return { code: bootstrapAttempts === 1 ? 5 : 0, stdout: '', stderr: bootstrapAttempts === 1 ? 'Bootstrap failed: 5: Input/output error' : '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false };
    }
    return { code: 0, stdout: '', stderr: '', stdoutBytes: 0, stderrBytes: 0, truncated: false, timedOut: false };
  };
  const result = await bootstrapLaunchdWithRetry(
    { platform: 'darwin', run: run as never },
    'gui/501',
    'gui/501/com.sneakoscope.desktop-bridge',
    '/tmp/plist'
  );
  assert.equal(result.code, 0);
  assert.equal(bootstrapAttempts, 2);
  assert.deepEqual(calls.filter((args) => args[0] === 'bootout').length, 1);
});

test('a PATH-resolved JavaScript sks entry is launched through the current interpreter', () => {
  // launchd's PATH has no `node`, so the bin symlink's `#!/usr/bin/env node`
  // shebang cannot start the service; the entry must ride the running binary.
  const symlinked = launchCommandForExecutable('/opt/nvm/bin/sks', '/opt/nvm/lib/node_modules/sneakoscope/dist/bin/sks.js', '/opt/nvm/bin/node');
  assert.deepEqual(symlinked, { executable: '/opt/nvm/bin/node', arguments: ['/opt/nvm/lib/node_modules/sneakoscope/dist/bin/sks.js'] });
  const native = launchCommandForExecutable('/usr/local/bin/sks', '/usr/local/bin/sks', '/opt/nvm/bin/node');
  assert.deepEqual(native, { executable: '/usr/local/bin/sks', arguments: [] });
  const plist = renderDesktopBridgeLaunchdPlist({
    executablePath: symlinked.executable,
    arguments: [...symlinked.arguments, 'bridge', 'serve'],
    stdoutPath: '/tmp/sks-out.log',
    stderrPath: '/tmp/sks-err.log'
  });
  assert.match(plist, /<string>\/opt\/nvm\/bin\/node<\/string>\n\s*<string>\/opt\/nvm\/lib\/node_modules\/sneakoscope\/dist\/bin\/sks\.js<\/string>/);
});
