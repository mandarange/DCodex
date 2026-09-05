import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openRouterSecretPaths } from '../../providers/openrouter/openrouter-secret-store.js';
import { executeDesktopBridgeCommandV3 } from '../desktop-controller-v3.js';
import {
  activateCombinedBridgeCatalog,
  buildCombinedBridgeCatalog,
  combinedBridgeCatalogPath,
  bridgeRouteIndexPath
} from '../combined-catalog.js';
import {
  configureProviderCredential,
  recordProviderCredentialValidation,
  resolveAllProviderCredentials,
  resolveAllProviderCredentialsWithValidation
} from '../provider-credentials.js';
import {
  bridgeProviderRegistryPath,
  resolveBridgeProviderRegistry
} from '../provider-registry.js';
import {
  bridgeRoutePolicyPath,
  buildBridgeRoutingPolicy,
  writeBridgeRoutingPolicy
} from '../provider-route-policy.js';
import {
  DESKTOP_BRIDGE_SERVICE_SCHEMA,
  desktopBridgeServicePaths,
  readDesktopBridgeServiceSettings,
  type DesktopBridgeServiceStatus
} from '../desktop-service.js';

const CHECKED_AT = '2026-08-05T00:00:00.000Z';

async function fixture(t: test.TestContext, officialModel = false) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-mutation-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  const env = {
    HOME: home,
    CODEX_LB_API_KEY: '',
    CODEX_LB_BASE_URL: '',
    OPENROUTER_API_KEY: '',
    SKS_OPENROUTER_API_KEY: '',
    SKS_ALLOW_CODEX_LB_TEST_HOST: '1'
  } as NodeJS.ProcessEnv;
  await configureProviderCredential({
    provider_id: 'codex-lb',
    api_key: 'lb-provider-mutation-secret-123456789',
    host: 'https://lb.example.test/backend-api/codex',
    home,
    processEnv: env
  });
  await configureProviderCredential({
    provider_id: 'openrouter',
    api_key: 'or-provider-mutation-secret-987654321',
    home,
    processEnv: env
  });
  const raw = await resolveAllProviderCredentials({
    codexLb: { home, processEnv: env },
    openrouter: { home, processEnv: env }
  });
  for (const providerId of ['codex-lb', 'openrouter'] as const) {
    await recordProviderCredentialValidation({
      provider_id: providerId,
      credential: raw[providerId],
      state: 'ready',
      checked_at: CHECKED_AT,
      home
    });
  }
  const credentials = await resolveAllProviderCredentialsWithValidation({
    home,
    codexLb: { home, processEnv: env },
    openrouter: { home, processEnv: env }
  });
  const registry = await resolveBridgeProviderRegistry({ home, credentials });
  const build = buildCombinedBridgeCatalog(registry, {
    catalogs: {
      'codex-lb': {
        provider_id: 'codex-lb',
        state: 'verified',
        generation: 'lb-provider-mutation-generation',
        models: { models: [{ slug: 'lb-mutation-model', display_name: 'LB mutation model' }, ...(officialModel ? [{ slug: 'gpt-6-astra', display_name: 'Astra' }] : [])] }
      },
      openrouter: {
        provider_id: 'openrouter',
        state: 'verified',
        generation: 'or-provider-mutation-generation',
        models: [{ id: 'or-mutation-model', name: 'OR mutation model' }]
      }
    },
    created_at: CHECKED_AT
  });
  const catalogPath = combinedBridgeCatalogPath(path.join(home, '.codex'));
  const routeIndexPath = bridgeRouteIndexPath(path.join(home, '.codex'));
  const activation = await activateCombinedBridgeCatalog({ build, catalogPath, routeIndexPath });
  assert.equal(activation.activated, true, JSON.stringify(activation.blockers));
  const policy = buildBridgeRoutingPolicy({
    route_index: build.route_index,
    catalog_generation: build.catalog.generation,
    default_provider_id: 'codex-lb',
    changed_at: CHECKED_AT
  });
  await writeBridgeRoutingPolicy(
    bridgeRoutePolicyPath(path.join(home, '.codex')),
    policy,
    build.route_index
  );
  return { home, env };
}

function serviceStatus(home: string, running: boolean, blockers: string[] = []): DesktopBridgeServiceStatus {
  return {
    schema: DESKTOP_BRIDGE_SERVICE_SCHEMA,
    ok: running && blockers.length === 0,
    supported: true,
    installed: true,
    loaded: running,
    running,
    status: running ? 'running' : 'missing',
    service: 'gui/501/com.sneakoscope.desktop-bridge',
    paths: desktopBridgeServicePaths(home),
    state: null,
    settings: null,
    expected_config_generation: null,
    credential_source: null,
    blockers
  };
}

function commandOptions(setup: Awaited<ReturnType<typeof fixture>>, restartFails = false) {
  let running = true;
  const events: string[] = [];
  return {
    options: {
      home: setup.home,
      env: setup.env,
      platform: 'darwin' as const,
      serviceStatusImpl: async () => serviceStatus(setup.home, running),
      stopServiceImpl: async () => {
        events.push('stop');
        running = false;
        return serviceStatus(setup.home, false);
      },
      bootstrapServiceImpl: async () => {
        events.push('bootstrap');
        if (restartFails) return serviceStatus(setup.home, false, ['injected_provider_restart_failure']);
        running = true;
        return serviceStatus(setup.home, true);
      },
      now: () => new Date(CHECKED_AT),
      id: () => 'provider-mutation'
    },
    events,
    isRunning: () => running,
    setRestartFailure: (failed: boolean) => { restartFails = failed; }
  };
}

test('provider disable quiesces before settings adoption and remains stopped when adoption fails', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const invalidSettingsPath = path.join(setup.home, '.codex', 'sks', 'settings-is-a-directory');
  await fs.mkdir(invalidSettingsPath);
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.disable',
    provider_id: 'codex-lb'
  }, { ...runtime.options, settingsPath: invalidSettingsPath });
  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.ok(result.execution.blockers.includes('desktop_bridge_settings_not_regular_file'));
  assert.deepEqual(runtime.events, ['stop']);
  assert.equal(runtime.isRunning(), false);
  const registry = await resolveBridgeProviderRegistry({ home: setup.home });
  assert.equal(registry.profiles['codex-lb'].enabled, false);
});

test('provider disable leaves the old process stopped when the provider-state write fails', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  await fs.mkdir(bridgeProviderRegistryPath(setup.home));

  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.disable',
    provider_id: 'codex-lb'
  }, runtime.options);
  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.ok(result.execution.blockers.includes('provider_registry_not_regular_file'));
  assert.deepEqual(runtime.events, ['stop']);
  assert.equal(runtime.isRunning(), false);
});

test('credential removal refusal does not restart the already-quiesced process', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const envPath = path.join(setup.home, '.codex', 'sks-codex-lb.env');
  const metadataPath = path.join(setup.home, '.codex', 'sks-codex-lb.json');
  await fs.rm(envPath);
  await fs.mkdir(envPath);
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.remove-credential',
    provider_id: 'codex-lb',
    confirmed: true
  }, runtime.options);

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.ok(result.execution.blockers.includes('codex_lb_credential_path_not_regular_file'));
  assert.deepEqual(runtime.events, ['stop']);
  assert.equal(runtime.isRunning(), false);
  await fs.access(metadataPath);
});

test('credential removal never restores the secret and fails closed when restart fails', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup, true);
  const envPath = path.join(setup.home, '.codex', 'sks-codex-lb.env');
  const metadataPath = path.join(setup.home, '.codex', 'sks-codex-lb.json');
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.remove-credential',
    provider_id: 'codex-lb',
    confirmed: true
  }, runtime.options);
  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, false);
  assert.ok(result.execution.blockers.includes('injected_provider_restart_failure'));
  assert.deepEqual(runtime.events, ['stop', 'bootstrap', 'stop']);
  assert.equal(runtime.isRunning(), false);
  await assert.rejects(fs.access(envPath));
  await assert.rejects(fs.access(metadataPath));
});

test('provider disable adopts settings and restarts only after the alternate provider remains valid', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.disable',
    provider_id: 'codex-lb'
  }, runtime.options);

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.deepEqual(runtime.events, ['stop', 'bootstrap']);
  assert.equal(runtime.isRunning(), true);
  const settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.provider_registry.providers['codex-lb'].enabled, false);
  assert.equal(settings?.provider_registry.providers.openrouter.enabled, true);
});

test('credential removal adopts the revoked provider state before a successful restart', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.remove-credential',
    provider_id: 'codex-lb',
    confirmed: true
  }, runtime.options);

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.deepEqual(runtime.events, ['stop', 'bootstrap']);
  assert.equal(runtime.isRunning(), true);
  const settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.provider_registry.providers['codex-lb'].credential_state, 'not_configured');
  assert.equal(settings?.provider_registry.providers.openrouter.credential_state, 'ready');
});

test('OpenRouter removal is confined to the controller home and adopts before restart', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const secretPath = openRouterSecretPaths(setup.env).keyPath;
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.remove-credential',
    provider_id: 'openrouter',
    confirmed: true
  }, runtime.options);

  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(result.execution.ok, true);
  assert.deepEqual(runtime.events, ['stop', 'bootstrap']);
  assert.equal(runtime.isRunning(), true);
  await assert.rejects(fs.access(secretPath));
  const settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.provider_registry.providers['codex-lb'].credential_state, 'ready');
  assert.equal(settings?.provider_registry.providers.openrouter.credential_state, 'not_configured');
});

test('provider.validate blocks private DNS and loopback rebinding before sending the exact Codex-LB credential', async (t) => {
  for (const testCase of [
    {
      host: 'https://private-name.example.test/backend-api/codex',
      addresses: [{ address: '10.23.45.67', family: 4 as const }],
      blocker: 'codex_lb_remote_dns_private_address'
    },
    {
      host: 'http://localhost:8787/backend-api/codex',
      addresses: [{ address: '93.184.216.34', family: 4 as const }],
      blocker: 'codex_lb_remote_dns_rebinding_blocked'
    }
  ]) {
    const setup = await fixture(t);
    const runtime = commandOptions(setup);
    const configured = await executeDesktopBridgeCommandV3({
      operation: 'provider.configure',
      provider_id: 'codex-lb',
      api_key: 'lb-provider-validation-secret-123456789',
      host: testCase.host
    }, runtime.options);
    assert.equal(configured.schema, 'sks.desktop-bridge-command-result.v1');
    let fetchCalls = 0;
    const result = await executeDesktopBridgeCommandV3({
      operation: 'provider.validate',
      provider_id: 'codex-lb'
    }, {
      ...runtime.options,
      codexLbLookup: async () => testCase.addresses,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({ data: [{ id: 'must-not-be-returned' }] }), { status: 200 });
      }
    });
    assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
    if (result.schema !== 'sks.desktop-bridge-command-result.v1') continue;
    assert.equal(fetchCalls, 0, testCase.host);
    assert.equal(result.execution.status, 'partial', JSON.stringify(result));
    assert.ok(result.execution.blockers.includes(testCase.blocker), JSON.stringify(result));
    assert.equal((result.result as Record<string, unknown>).validated, false, JSON.stringify(result));
  }
});

test('configure quiesces and successful exact-credential validation republishes settings before restart', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const secret = 'lb-provider-success-secret-123456789';
  const configured = await executeDesktopBridgeCommandV3({
    operation: 'provider.configure',
    provider_id: 'codex-lb',
    api_key: secret,
    host: 'https://lb.example.test/backend-api/codex'
  }, runtime.options);
  assert.equal(configured.schema, 'sks.desktop-bridge-command-result.v1');
  assert.deepEqual(runtime.events, ['stop']);
  assert.equal(runtime.isRunning(), false);

  let observedAuthorization = '';
  const validated = await executeDesktopBridgeCommandV3({
    operation: 'provider.validate',
    provider_id: 'codex-lb'
  }, {
    ...runtime.options,
    codexLbLookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchImpl: async (_input, init) => {
      observedAuthorization = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({ data: [{ id: 'lb-mutation-model' }] }), { status: 200 });
    }
  });
  assert.equal(validated.schema, 'sks.desktop-bridge-command-result.v1');
  if (validated.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal((validated.result as Record<string, unknown>).validated, true, JSON.stringify(validated));
  assert.equal(observedAuthorization, `Bearer ${secret}`);
  assert.deepEqual(runtime.events, ['stop', 'bootstrap']);
  assert.equal(runtime.isRunning(), true);
  const settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.provider_registry.providers['codex-lb'].credential_state, 'ready');
});

test('validation CAS rejects a credential rotated while the exact prior secret is in flight', async (t) => {
  const setup = await fixture(t);
  const runtime = commandOptions(setup);
  const original = 'lb-provider-cas-original-secret-123456789';
  const rotated = 'lb-provider-cas-rotated-secret-987654321';
  await executeDesktopBridgeCommandV3({
    operation: 'provider.configure',
    provider_id: 'codex-lb',
    api_key: original,
    host: 'https://lb.example.test/backend-api/codex'
  }, runtime.options);

  let observedAuthorization = '';
  const result = await executeDesktopBridgeCommandV3({
    operation: 'provider.validate',
    provider_id: 'codex-lb'
  }, {
    ...runtime.options,
    codexLbLookup: async () => [{ address: '93.184.216.34', family: 4 as const }],
    fetchImpl: async (_input, init) => {
      observedAuthorization = new Headers(init?.headers).get('authorization') || '';
      await configureProviderCredential({
        provider_id: 'codex-lb',
        api_key: rotated,
        host: 'https://lb.example.test/backend-api/codex',
        home: setup.home,
        processEnv: setup.env
      });
      return new Response(JSON.stringify({ data: [{ id: 'lb-mutation-model' }] }), { status: 200 });
    }
  });
  assert.equal(result.schema, 'sks.desktop-bridge-command-result.v1');
  if (result.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(observedAuthorization, `Bearer ${original}`);
  assert.equal(result.execution.ok, false, JSON.stringify(result));
  assert.ok(result.execution.blockers.includes('codex_lb_credential_validation_conflict'), JSON.stringify(result));
  const current = await resolveAllProviderCredentialsWithValidation({
    home: setup.home,
    codexLb: { home: setup.home, processEnv: setup.env },
    openrouter: { home: setup.home, processEnv: setup.env }
  });
  assert.equal(current['codex-lb'].state, 'configured_unverified');
});


test('authentication priority persists across controller restarts and restores the prior official mode', async (t) => {
  const setup = await fixture(t, true);
  const runtime = commandOptions(setup);
  const authPath = path.join(setup.home, '.codex', 'auth.json');
  const authBytes = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'unchanged-chatgpt-secret', account_id: 'fixture-account' } });
  await fs.writeFile(authPath, authBytes, { mode: 0o600 });
  const original = await executeDesktopBridgeCommandV3({ operation: 'route.official-models', mode: 'passthrough' }, runtime.options);
  assert.equal(original.schema, 'sks.desktop-bridge-command-result.v1');
  if (original.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(original.ok, true, JSON.stringify(original));
  const enabled = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.set', enabled: true }, runtime.options);
  assert.equal(enabled.schema, 'sks.desktop-bridge-command-result.v1');
  if (enabled.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(enabled.ok, true, JSON.stringify(enabled));
  assert.deepEqual(enabled.result.auth_priority, { enabled: true, state: 'active', error: null });
  let settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.auth_priority_enabled, true);
  assert.equal(settings?.official_passthrough.models, 'passthrough');
  assert.equal(settings?.route_policy.model_routes['gpt-6-astra']?.provider_id, 'codex-lb');
  assert.equal(settings?.route_policy.model_routes['codex-lb:gpt-6-astra']?.provider_id, 'codex-lb');
  const restarted = commandOptions(setup);
  const status = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.status' }, restarted.options);
  assert.equal(status.schema, 'sks.desktop-bridge-command-result.v1');
  if (status.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.deepEqual(status.result.auth_priority, enabled.result.auth_priority);
  const disabled = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.set', enabled: false }, restarted.options);
  assert.equal(disabled.schema, 'sks.desktop-bridge-command-result.v1');
  if (disabled.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(disabled.ok, true, JSON.stringify(disabled));
  settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.auth_priority_enabled, false);
  assert.equal(settings?.official_passthrough.models, 'passthrough');
  assert.equal(settings?.route_policy.model_routes['gpt-6-astra']?.provider_id, 'openai');
  assert.equal(settings?.route_policy.model_routes['codex-lb:gpt-6-astra']?.provider_id, 'codex-lb');
  assert.equal(await fs.readFile(authPath, 'utf8'), authBytes);
  assert.doesNotMatch(JSON.stringify([enabled, status, disabled, settings]), /unchanged-chatgpt-secret|lb-provider-mutation-secret|or-provider-mutation-secret/);
  assert.deepEqual(restarted.events, ['bootstrap']);
});


test('saved authentication priority reports unavailable after restart failure and becomes active after recovery', async (t) => {
  const setup = await fixture(t, true);
  const runtime = commandOptions(setup, true);
  const failed = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.set', enabled: true }, runtime.options);
  assert.equal(failed.schema, 'sks.desktop-bridge-command-result.v1');
  if (failed.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.execution.blockers, ['injected_provider_restart_failure']);
  assert.deepEqual(runtime.events, ['bootstrap', 'stop']);
  assert.equal(runtime.isRunning(), false);
  const settings = await readDesktopBridgeServiceSettings(desktopBridgeServicePaths(setup.home).settings_path);
  assert.equal(settings?.auth_priority_enabled, true);
  const unavailable = { enabled: true, state: 'unavailable', error: 'desktop_bridge_not_running' };
  assert.deepEqual(failed.status?.auth_priority, unavailable);
  assert.deepEqual(failed.result.auth_priority, unavailable);
  const observed = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.status' }, runtime.options);
  assert.equal(observed.schema, 'sks.desktop-bridge-command-result.v1');
  if (observed.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.deepEqual(observed.result.auth_priority, unavailable);
  runtime.setRestartFailure(false);
  const recovered = await executeDesktopBridgeCommandV3({ operation: 'auth-priority.set', enabled: true }, runtime.options);
  assert.equal(recovered.schema, 'sks.desktop-bridge-command-result.v1');
  if (recovered.schema !== 'sks.desktop-bridge-command-result.v1') return;
  assert.equal(recovered.ok, true, JSON.stringify(recovered));
  assert.deepEqual(recovered.result.auth_priority, { enabled: true, state: 'active', error: null });
  assert.equal(runtime.isRunning(), true);
  assert.deepEqual(runtime.events, ['bootstrap', 'stop', 'bootstrap']);
  assert.doesNotMatch(JSON.stringify([failed, observed, recovered]), /lb-provider-mutation-secret|or-provider-mutation-secret/);
});
