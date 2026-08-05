import '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  removeProviderCredential,
  resolveAllProviderCredentials
} from '../provider-credentials.js';
import {
  bridgeProviderRegistryPath,
  resolveBridgeProviderRegistry,
  setBridgeProviderEnabled
} from '../provider-registry.js';
import { buildBridgeRoutingPolicy, setBridgeRoutingDefault } from '../provider-route-policy.js';
import { buildBridgeRouteIndex } from '../route-index.js';
import {
  openRouterSecretPaths,
  resolveOpenRouterApiKey,
  writeStoredOpenRouterKey
} from '../../providers/openrouter/openrouter-secret-store.js';

async function credentialFixture(t: test.TestContext) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-coexist-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  const lbKey = 'lb-secret-coexistence-fixture-123456789';
  const lbEndpoint = 'https://lb.example.test/backend-api/codex';
  const lbEnvPath = path.join(codexHome, 'sks-codex-lb.env');
  const lbMetadataPath = path.join(codexHome, 'sks-codex-lb.json');
  await fs.writeFile(lbEnvPath, [
    `export CODEX_LB_BASE_URL='${lbEndpoint}'`,
    `export CODEX_LB_API_KEY='${lbKey}'`,
    ''
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(lbMetadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: lbEndpoint,
    api_key: { sha256: sha256(lbKey), redacted: true },
    gateway_auth_transport: 'authorization-bearer-compat'
  }, null, 2)}\n`, { mode: 0o600 });
  const openRouterKey = 'or-secret-coexistence-fixture-987654321';
  const openRouterPaths = openRouterSecretPaths({ HOME: home } as NodeJS.ProcessEnv);
  await writeStoredOpenRouterKey(openRouterKey, { paths: openRouterPaths });
  return {
    home,
    lbKey,
    lbEnvPath,
    lbMetadataPath,
    openRouterKey,
    openRouterPaths,
    registryPath: bridgeProviderRegistryPath(home)
  };
}

test('R01-R05: provider credentials coexist and serialize only stable redacted metadata', async (t) => {
  const fixture = await credentialFixture(t);
  const credentials = await resolveAllProviderCredentials({
    codexLb: {
      home: fixture.home,
      processEnv: {},
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    },
    openrouter: {
      processEnv: { HOME: fixture.home },
      openRouterPaths: fixture.openRouterPaths,
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    }
  });
  assert.equal(credentials['codex-lb'].secret, fixture.lbKey);
  assert.equal(credentials.openrouter.secret, fixture.openRouterKey);
  assert.equal(credentials['codex-lb'].state, 'ready');
  assert.equal(credentials.openrouter.state, 'ready');

  const registry = await resolveBridgeProviderRegistry({
    home: fixture.home,
    registryPath: fixture.registryPath,
    credentials
  });
  assert.equal(registry.profiles['codex-lb'].state, 'ready');
  assert.equal(registry.profiles.openrouter.state, 'ready');
  const serialized = JSON.stringify({ credentials, registry });
  assert.equal(serialized.includes(fixture.lbKey), false);
  assert.equal(serialized.includes(fixture.openRouterKey), false);
  assert.equal(serialized.includes('"secret"'), false);

  const noCredentials = await resolveAllProviderCredentials({
    codexLb: { home: path.join(fixture.home, 'absent'), processEnv: {} },
    openrouter: {
      processEnv: { HOME: path.join(fixture.home, 'absent') },
      openRouterPaths: openRouterSecretPaths({ HOME: path.join(fixture.home, 'absent') } as NodeJS.ProcessEnv)
    }
  });
  assert.equal(noCredentials['codex-lb'].state, 'not_configured');
  assert.equal(noCredentials.openrouter.state, 'not_configured');
  assert.equal(noCredentials['codex-lb'].secret, null);
  assert.equal(noCredentials.openrouter.secret, null);

  const lbOnly = await resolveAllProviderCredentials({
    codexLb: {
      home: fixture.home,
      processEnv: {},
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    },
    openrouter: {
      processEnv: { HOME: path.join(fixture.home, 'absent') },
      openRouterPaths: openRouterSecretPaths({ HOME: path.join(fixture.home, 'absent') } as NodeJS.ProcessEnv)
    }
  });
  assert.equal(lbOnly['codex-lb'].state, 'ready');
  assert.equal(lbOnly.openrouter.state, 'not_configured');

  const openRouterOnly = await resolveAllProviderCredentials({
    codexLb: { home: path.join(fixture.home, 'absent'), processEnv: {} },
    openrouter: {
      processEnv: { HOME: fixture.home },
      openRouterPaths: fixture.openRouterPaths,
      validation: { state: 'ready', checked_at: '2026-08-05T00:00:00.000Z' }
    }
  });
  assert.equal(openRouterOnly['codex-lb'].state, 'not_configured');
  assert.equal(openRouterOnly.openrouter.state, 'ready');
});

test('R10-R13/R31: enable/default changes preserve both stores and removal is explicit and provider-local', async (t) => {
  const fixture = await credentialFixture(t);
  const credentials = await resolveAllProviderCredentials({
    codexLb: { home: fixture.home, processEnv: {} },
    openrouter: { processEnv: { HOME: fixture.home }, openRouterPaths: fixture.openRouterPaths }
  });
  const beforeLb = await fs.readFile(fixture.lbEnvPath);
  const beforeOr = await fs.readFile(fixture.openRouterPaths.keyPath);
  const disabled = await setBridgeProviderEnabled({
    provider_id: 'codex-lb',
    enabled: false,
    home: fixture.home,
    registryPath: fixture.registryPath,
    credentials
  });
  assert.equal(disabled.profiles['codex-lb'].enabled, false);
  assert.equal(disabled.profiles.openrouter.enabled, true);
  assert.deepEqual(await fs.readFile(fixture.lbEnvPath), beforeLb);
  assert.deepEqual(await fs.readFile(fixture.openRouterPaths.keyPath), beforeOr);

  const index = buildBridgeRouteIndex({
    models: [],
    providers: {
      'codex-lb': { catalog_generation: 'lb-1', credential_fingerprint: credentials['codex-lb'].fingerprint, state: 'ready' },
      openrouter: { catalog_generation: 'or-1', credential_fingerprint: credentials.openrouter.fingerprint, state: 'ready' }
    },
    created_at: '2026-08-05T00:00:00.000Z'
  }).route_index;
  const policy = buildBridgeRoutingPolicy({ route_index: index, catalog_generation: 'catalog-1' });
  const changed = setBridgeRoutingDefault(policy, 'openrouter', '2026-08-05T00:01:00.000Z');
  assert.equal(changed.default_provider_id, 'openrouter');
  assert.deepEqual(await fs.readFile(fixture.lbEnvPath), beforeLb);
  assert.deepEqual(await fs.readFile(fixture.openRouterPaths.keyPath), beforeOr);

  const unconfirmed = await removeProviderCredential({
    provider_id: 'codex-lb',
    confirmed: false,
    home: fixture.home
  });
  assert.equal(unconfirmed.removed, false);
  assert.deepEqual(await fs.readFile(fixture.lbEnvPath), beforeLb);

  const removed = await removeProviderCredential({
    provider_id: 'codex-lb',
    confirmed: true,
    home: fixture.home
  });
  assert.equal(removed.removed, true);
  await assert.rejects(fs.access(fixture.lbEnvPath));
  assert.deepEqual(await fs.readFile(fixture.openRouterPaths.keyPath), beforeOr);
  const resolvedOr = await resolveOpenRouterApiKey({
    env: { HOME: fixture.home },
    paths: fixture.openRouterPaths
  });
  assert.equal(resolvedOr.key, fixture.openRouterKey);
  const afterRemoval = await resolveAllProviderCredentials({
    codexLb: { home: fixture.home, processEnv: {} },
    openrouter: { processEnv: { HOME: fixture.home }, openRouterPaths: fixture.openRouterPaths }
  });
  assert.equal(afterRemoval['codex-lb'].state, 'not_configured');
  assert.equal(afterRemoval.openrouter.state, 'configured_unverified');
});

test('R31: rotating one key changes only that provider profile generation', async (t) => {
  const fixture = await credentialFixture(t);
  const options = () => ({
    codexLb: {
      home: fixture.home,
      processEnv: {},
      validation: { state: 'ready' as const, checked_at: '2026-08-05T00:00:00.000Z' }
    },
    openrouter: {
      processEnv: { HOME: fixture.home },
      openRouterPaths: fixture.openRouterPaths,
      validation: { state: 'ready' as const, checked_at: '2026-08-05T00:00:00.000Z' }
    }
  });
  const beforeCredentials = await resolveAllProviderCredentials(options());
  const before = await resolveBridgeProviderRegistry({ registryPath: fixture.registryPath, credentials: beforeCredentials });
  const rotated = 'lb-secret-rotated-fixture-000000000';
  const endpoint = 'https://lb.example.test/backend-api/codex';
  await fs.writeFile(fixture.lbEnvPath, [
    `export CODEX_LB_BASE_URL='${endpoint}'`,
    `export CODEX_LB_API_KEY='${rotated}'`,
    ''
  ].join('\n'), { mode: 0o600 });
  await fs.writeFile(fixture.lbMetadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: endpoint,
    api_key: { sha256: sha256(rotated), redacted: true },
    gateway_auth_transport: 'authorization-bearer-compat'
  }, null, 2)}\n`, { mode: 0o600 });
  const afterCredentials = await resolveAllProviderCredentials(options());
  const after = await resolveBridgeProviderRegistry({ registryPath: fixture.registryPath, credentials: afterCredentials });
  assert.notEqual(after.profiles['codex-lb'].profile_generation, before.profiles['codex-lb'].profile_generation);
  assert.equal(after.profiles.openrouter.profile_generation, before.profiles.openrouter.profile_generation);
});

test('provider registry reports an invalid stored endpoint instead of throwing during status', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-provider-invalid-endpoint-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const credential = (provider_id: 'codex-lb' | 'openrouter', endpoint_url: string) => ({
    schema: 'sks.provider-credential-status.v1' as const,
    provider_id,
    state: 'configured_unverified' as const,
    source: 'fixture',
    fingerprint: 'fixture-fingerprint',
    checked_at: null,
    blockers: [],
    warnings: [],
    endpoint_url,
    secret: null
  });

  const registry = await resolveBridgeProviderRegistry({
    home,
    credentials: {
      'codex-lb': credential('codex-lb', 'not a valid URL'),
      openrouter: credential('openrouter', 'https://openrouter.ai/api/v1')
    }
  });

  assert.equal(registry.profiles['codex-lb'].state, 'blocked');
  assert.ok(registry.profiles['codex-lb'].blockers.includes('provider_endpoint_invalid'));
  assert.equal(registry.profiles.openrouter.state, 'configured_unverified');
});

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
