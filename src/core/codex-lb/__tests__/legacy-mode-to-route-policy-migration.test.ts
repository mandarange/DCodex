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
import { migrateLegacyModeToDesktopBridge } from '../legacy-migration.js';

const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';
const LB_KEY = 'sk-clb-preserve-this-value';
const OR_KEY = 'sk-or-preserve-this-value';

async function fixture(t: test.TestContext, config: string) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-unification-migration-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const lbCredentialPath = path.join(codexHome, 'sks-codex-lb.env');
  const orCredentialPath = path.join(home, '.sneakoscope', 'secrets', 'openrouter-api-key');
  const combinedCatalogPath = path.join(codexHome, 'sks', 'sks-bridge-catalog.json');
  const auth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-unification',
    tokens: { access_token: 'oauth-access-before', refresh_token: 'oauth-refresh-before' }
  }, null, 2)}\n`;
  await fsp.mkdir(path.dirname(orCredentialPath), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(configPath, config, { mode: 0o600 });
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(lbCredentialPath, `export CODEX_LB_API_KEY='${LB_KEY}'\n`, { mode: 0o600 });
  await fsp.writeFile(orCredentialPath, `${OR_KEY}\n`, { mode: 0o600 });
  return {
    home,
    configPath,
    authPath,
    lbCredentialPath,
    orCredentialPath,
    combinedCatalogPath,
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

test('R06/R33/R35: cli-provider migration preserves both credentials and second run is byte-no-op', async (t) => {
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
  const first = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    legacyDesktopMode: 'cli-provider',
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
  assert.equal(first.receipt?.credentials_deleted, false);
  assert.equal(first.receipt?.auth_before_sha256, first.receipt?.auth_after_sha256);

  const receiptEntriesBefore = await fsp.readdir(path.dirname(first.receipt_path!));
  const second = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    legacyDesktopMode: 'cli-provider'
  });
  assert.equal(second.ok, true);
  assert.equal(second.status, 'already_migrated');
  assert.equal(second.receipt_path, null);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), migratedConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  assert.deepEqual(await fsp.readFile(setup.lbCredentialPath), beforeLb);
  assert.deepEqual(await fsp.readFile(setup.orCredentialPath), beforeOr);
  assert.deepEqual(await fsp.readdir(path.dirname(first.receipt_path!)), receiptEntriesBefore);
});

test('R07: dual-auth migration retains the legacy LB header transport as profile intent', async (t) => {
  const config = [
    '# sks-codex-lb-managed-desktop-compat',
    'model_provider = "codex-lb"',
    ...lbTable(true)
  ].join('\n');
  const setup = await fixture(t, config);
  const result = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    legacyDesktopMode: 'desktop-dual-auth-compat'
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.migrated_profiles, ['codex-lb']);
  assert.equal(result.legacy_gateway_auth_transport, 'x-codex-lb-api-key');
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
  const result = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    legacyDesktopMode: 'desktop-native-bridge'
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
  const result = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blockers, ['legacy_user_owned_config_conflict']);
  assert.deepEqual(await Promise.all([
    fsp.readFile(setup.configPath),
    fsp.readFile(setup.authPath),
    fsp.readFile(setup.lbCredentialPath),
    fsp.readFile(setup.orCredentialPath)
  ]), before);
  await assert.rejects(fsp.access(path.join(setup.home, '.codex', 'sks-desktop-bridge-migrations')));
});
