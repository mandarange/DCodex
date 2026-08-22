import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
} from '../../../cli/install-helpers-codex-lb-config.js';
import {
  inspectHistoricalDesktopBridgeIntent,
  migrateDesktopBridgeConfig
} from '../desktop-bridge-migration.js';
import { authSemanticIdentityPreserved } from '../desktop-bridge-migration/receipt.js';

const CLIENT_CAPABILITY = 'A'.repeat(43);
const BRIDGE = `http://127.0.0.1:47821/__sks/client/${CLIENT_CAPABILITY}/backend-api/codex`;
const LB_KEY = 'sk-clb-preserve-this-value';
const OR_KEY = 'sk-or-preserve-this-value';

test('OAuth migration preservation keys on account identity, not bytes', () => {
  // Official identity passthrough means OAuth tokens legitimately rotate while
  // a sync is in flight: byte drift with the SAME account fingerprint is a
  // refresh, not a breach. Only an identity change, a mode flip, or an
  // unverifiable fingerprint still fails the invariant.
  const before = {
    path: '/tmp/auth.json', exists: true, sha256: 'before-bytes', semantic_fingerprint: 'same-account',
    mode: 'chatgpt_oauth' as const, has_refresh_token: true, has_access_token: true, has_api_key: false,
  };
  assert.equal(authSemanticIdentityPreserved(before, { ...before }), true);
  assert.equal(authSemanticIdentityPreserved(before, { ...before, sha256: 'different-bytes' }), true);
  assert.equal(authSemanticIdentityPreserved(before, { ...before, sha256: 'different-bytes', semantic_fingerprint: 'other-account' }), false);
  assert.equal(authSemanticIdentityPreserved(before, { ...before, semantic_fingerprint: null }), false);
  assert.equal(authSemanticIdentityPreserved(before, { ...before, mode: 'api_key' as never }), false);
  assert.equal(authSemanticIdentityPreserved(before, { ...before, exists: false }), false);
  // Non-OAuth snapshots carry no identity claims: bytes stay the only proof.
  const apiKey = { ...before, mode: 'api_key' as never, semantic_fingerprint: null };
  assert.equal(authSemanticIdentityPreserved(apiKey, { ...apiKey }), true);
  assert.equal(authSemanticIdentityPreserved(apiKey, { ...apiKey, sha256: 'different-bytes' }), false);
});

async function fixture(t: test.TestContext, config: string) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-unification-migration-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const lbCredentialPath = path.join(codexHome, 'sks-codex-lb.env');
  const orCredentialPath = path.join(home, '.sneakoscope', 'secrets', 'openrouter-api-key');
  const combinedCatalogPath = path.join(codexHome, 'sks', 'sks-bridge-catalog.json');
  const providerProfilePath = path.join(codexHome, 'sks', 'provider-registry.json');
  const auth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-unification',
    tokens: { access_token: 'oauth-access-before', refresh_token: 'oauth-refresh-before' }
  }, null, 2)}\n`;
  await fsp.mkdir(path.dirname(orCredentialPath), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.mkdir(path.dirname(combinedCatalogPath), { recursive: true });
  await fsp.writeFile(configPath, config, { mode: 0o600 });
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(lbCredentialPath, `export CODEX_LB_API_KEY='${LB_KEY}'\n`, { mode: 0o600 });
  await fsp.writeFile(orCredentialPath, `${OR_KEY}\n`, { mode: 0o600 });
  await fsp.writeFile(combinedCatalogPath, '{"schema":"fixture-catalog","models":[]}\n', { mode: 0o600 });
  await fsp.writeFile(providerProfilePath, '{"schema":"fixture-provider-registry"}\n', { mode: 0o600 });
  return {
    home,
    configPath,
    authPath,
    lbCredentialPath,
    orCredentialPath,
    combinedCatalogPath,
    providerProfilePath,
    config,
    auth
  };
}

function lbTable(requiresOpenAiAuth = false): string[] {
  return [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example/backend-api/codex"',
    'env_key = "CODEX_LB_API_KEY"',
    `requires_openai_auth = ${requiresOpenAiAuth}`,
    ''
  ];
}

function openRouterTable(): string[] {
  return [
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'requires_openai_auth = false',
    ''
  ];
}

test('historical intent: native bridge preserves bearer endpoint intent without reading secrets', () => {
  const config = [
    '# sks-managed-provider-mode:codex-lb',
    'model_provider = "openai"',
    '# sks-codex-lb-managed-desktop-bridge',
    `openai_base_url = "${BRIDGE}"`,
    ...lbTable(false),
    'credential = "must-not-escape"'
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, []);
  assert.deepEqual(intent.providers['codex-lb'], {
    present: true,
    enabled: true,
    endpoint_url: 'https://lb.example/backend-api/codex',
    auth_transport: 'authorization-bearer'
  });
  assert.deepEqual(intent.providers.openrouter, {
    present: false,
    enabled: false,
    endpoint_url: null,
    auth_transport: null
  });
  assert.equal(intent.default_provider_id, 'codex-lb');
  assert.doesNotMatch(JSON.stringify(intent), /must-not-escape|CODEX_LB_API_KEY/);
});

test('historical intent: native bridge accepts omitted OpenAI selection as the Codex default', () => {
  const config = [
    '# sks-managed-provider-mode:codex-lb',
    '# sks-codex-lb-managed-desktop-bridge',
    `openai_base_url = "${BRIDGE}"`,
    ...lbTable(false)
  ].join('\n');

  const intent = inspectHistoricalDesktopBridgeIntent(config);

  assert.deepEqual(intent.blockers, []);
  assert.equal(intent.providers['codex-lb'].enabled, true);
  assert.equal(intent.default_provider_id, 'codex-lb');
});

test('historical intent: dual-auth compatibility preserves custom-header transport', () => {
  const config = [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    ...lbTable(true),
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }'
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, []);
  assert.equal(intent.providers['codex-lb'].auth_transport, 'x-codex-lb-api-key');
  assert.equal(intent.providers['codex-lb'].endpoint_url, 'https://lb.example/backend-api/codex');
  assert.equal(intent.default_provider_id, 'codex-lb');
});

test('historical intent: CLI provider selection preserves bearer transport and default', () => {
  const config = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    ...lbTable(false)
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, []);
  assert.equal(intent.providers['codex-lb'].present, true);
  assert.equal(intent.providers['codex-lb'].enabled, true);
  assert.equal(intent.providers['codex-lb'].auth_transport, 'authorization-bearer');
  assert.equal(intent.default_provider_id, 'codex-lb');
});

test('historical intent: OpenRouter selection accepts only its canonical endpoint', () => {
  const config = [
    'model_provider = "openrouter"',
    ...openRouterTable()
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, []);
  assert.deepEqual(intent.providers.openrouter, {
    present: true,
    enabled: true,
    endpoint_url: 'https://openrouter.ai/api/v1',
    auth_transport: 'openrouter-bearer'
  });
  assert.equal(intent.default_provider_id, 'openrouter');

  const nonCanonical = inspectHistoricalDesktopBridgeIntent(
    config.replace('https://openrouter.ai/api/v1', 'https://proxy.example/openrouter')
  );
  assert.deepEqual(nonCanonical.blockers, ['historical_openrouter_endpoint_not_canonical']);
  assert.equal(nonCanonical.providers.openrouter.enabled, false);
  assert.equal(nonCanonical.providers.openrouter.endpoint_url, null);
  assert.equal(nonCanonical.default_provider_id, null);
});

test('historical intent: combined router enables both known profiles without inventing a default', () => {
  const config = [
    'model_provider = "sks-router"',
    '',
    '[model_providers.sks-router]',
    'name = "SKS Router"',
    'base_url = "http://127.0.0.1:47821/backend-api/codex"',
    '',
    ...lbTable(false),
    ...openRouterTable()
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, []);
  assert.equal(intent.providers['codex-lb'].enabled, true);
  assert.equal(intent.providers.openrouter.enabled, true);
  assert.equal(intent.default_provider_id, null);
});

test('historical intent: ambiguous custom user provider selection fails closed', () => {
  const config = [
    'model_provider = "my-private-proxy"',
    '',
    '[model_providers.my-private-proxy]',
    'base_url = "https://private.example/v1"',
    'api_key = "must-not-escape"'
  ].join('\n');
  const intent = inspectHistoricalDesktopBridgeIntent(config);
  assert.deepEqual(intent.blockers, ['historical_user_owned_provider_selection_conflict']);
  assert.equal(intent.providers['codex-lb'].enabled, false);
  assert.equal(intent.providers.openrouter.enabled, false);
  assert.equal(intent.default_provider_id, null);
  assert.doesNotMatch(JSON.stringify(intent), /must-not-escape|private\.example/);
});

test('R06/R33/R35: historical provider selection preserves credentials and the second run is a receipt-free byte no-op', async (t) => {
  const config = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '# sks-managed-provider-mode:codex-lb',
    ...lbTable(),
    ...openRouterTable()
  ].join('\n');
  const setup = await fixture(t, config);
  const beforeAuth = await fsp.readFile(setup.authPath);
  const beforeLb = await fsp.readFile(setup.lbCredentialPath);
  const beforeOr = await fsp.readFile(setup.orCredentialPath);
  const beforeCatalog = await fsp.readFile(setup.combinedCatalogPath);
  const beforeProfiles = await fsp.readFile(setup.providerProfilePath);
  const first = await migrateDesktopBridgeConfig({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    now: new Date('2026-08-05T12:00:00.000Z')
  });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'migrated');
  assert.deepEqual(first.migrated_profiles, ['codex-lb', 'openrouter']);
  const migratedConfig = await fsp.readFile(setup.configPath, 'utf8');
  assert.match(migratedConfig, new RegExp(`${DESKTOP_BRIDGE_MANAGED_MARKER}\\nmodel_provider = "openai"`));
  assert.match(migratedConfig, new RegExp(`${DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER}\\nopenai_base_url = "${BRIDGE}"`));
  assert.match(migratedConfig, new RegExp(`${DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER}\\nmodel_catalog_json = `));
  assert.doesNotMatch(migratedConfig, /# sks-managed-provider-mode:/);
  assert.match(migratedConfig, /\[model_providers\.codex-lb\]/);
  assert.match(migratedConfig, /\[model_providers\.openrouter\]/);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  assert.deepEqual(await fsp.readFile(setup.lbCredentialPath), beforeLb);
  assert.deepEqual(await fsp.readFile(setup.orCredentialPath), beforeOr);

  const receiptText = await fsp.readFile(first.receipt_path!, 'utf8');
  assert.doesNotMatch(receiptText, new RegExp(LB_KEY));
  assert.doesNotMatch(receiptText, new RegExp(OR_KEY));
  assert.doesNotMatch(receiptText, /oauth-(?:access|refresh)-before/);
  assert.doesNotMatch(receiptText, /"provider_mode"/);
  assert.doesNotMatch(receiptText, new RegExp(CLIENT_CAPABILITY));
  assert.equal(first.receipt?.credentials_deleted, false);
  assert.equal(first.receipt?.auth_before_sha256, first.receipt?.auth_after_sha256);
  assert.equal(first.receipt?.historical_state.historical_provider_selection, 'codex-lb');

  const receiptEntriesBefore = await fsp.readdir(path.dirname(first.receipt_path!));
  const second = await migrateDesktopBridgeConfig({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    now: new Date('2026-08-05T12:01:00.000Z')
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'already_migrated');
  assert.equal(second.receipt_path, null);
  assert.equal(second.receipt, undefined);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), migratedConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  assert.deepEqual(await fsp.readFile(setup.lbCredentialPath), beforeLb);
  assert.deepEqual(await fsp.readFile(setup.orCredentialPath), beforeOr);
  assert.deepEqual(await fsp.readFile(setup.combinedCatalogPath), beforeCatalog);
  assert.deepEqual(await fsp.readFile(setup.providerProfilePath), beforeProfiles);
  const receiptEntriesAfter = await fsp.readdir(path.dirname(first.receipt_path!));
  assert.deepEqual(receiptEntriesAfter.sort(), receiptEntriesBefore.sort());
  assert.equal(await fsp.readFile(first.receipt_path!, 'utf8'), receiptText);
});

test('R07: historical custom-header configuration is decoded as profile intent', async (t) => {
  const config = [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    ...lbTable(true)
  ].join('\n');
  const setup = await fixture(t, config);
  const result = await migrateDesktopBridgeConfig({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.migrated_profiles, ['codex-lb']);
  assert.equal(result.historical_gateway_auth_transport, 'x-codex-lb-api-key');
  assert.deepEqual(await fsp.readFile(setup.authPath), Buffer.from(setup.auth));
});

test('R08: SKS OpenRouter selection migrates to the combined catalog without deleting either key', async (t) => {
  const config = [
    'model_provider = "openrouter"',
    'model_catalog_json = "/Users/op/.codex/sks-openrouter-catalog.json"',
    ...openRouterTable(),
    ...lbTable()
  ].join('\n');
  const setup = await fixture(t, config);
  const beforeLb = await fsp.readFile(setup.lbCredentialPath);
  const beforeOr = await fsp.readFile(setup.orCredentialPath);
  const result = await migrateDesktopBridgeConfig({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.migrated_profiles, ['codex-lb', 'openrouter']);
  const migrated = await fsp.readFile(setup.configPath, 'utf8');
  assert.match(migrated, /^model_provider = "openai"$/m);
  assert.match(migrated, new RegExp(`^model_catalog_json = "${setup.combinedCatalogPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'));
  assert.deepEqual(await fsp.readFile(setup.lbCredentialPath), beforeLb);
  assert.deepEqual(await fsp.readFile(setup.orCredentialPath), beforeOr);
});

test('R09: custom provider and custom catalog fail closed byte-for-byte', async (t) => {
  const config = [
    'model_provider = "my-private-proxy"',
    'model_catalog_json = "/Users/op/private-models.json"',
    '',
    '[model_providers.my-private-proxy]',
    'base_url = "https://private.example/v1"',
    ''
  ].join('\n');
  const setup = await fixture(t, config);
  const before = await Promise.all([
    fsp.readFile(setup.configPath),
    fsp.readFile(setup.authPath),
    fsp.readFile(setup.lbCredentialPath),
    fsp.readFile(setup.orCredentialPath)
  ]);
  const result = await migrateDesktopBridgeConfig({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers, ['historical_user_owned_config_conflict']);
  assert.deepEqual(await Promise.all([
    fsp.readFile(setup.configPath),
    fsp.readFile(setup.authPath),
    fsp.readFile(setup.lbCredentialPath),
    fsp.readFile(setup.orCredentialPath)
  ]), before);
  await assert.rejects(fsp.access(path.join(setup.home, '.codex', 'sks-desktop-bridge-migrations')));
});
