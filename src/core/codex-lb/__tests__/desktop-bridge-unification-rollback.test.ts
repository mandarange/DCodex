import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyModeToDesktopBridge } from '../legacy-migration.js';
import {
  rollbackDesktopBridgeUnificationReceipt,
  type StoredDesktopBridgeUnificationReceipt
} from '../migration-receipt.js';

const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-unification-rollback-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const lbCredentialPath = path.join(codexHome, 'sks-codex-lb.env');
  const orCredentialPath = path.join(home, '.sneakoscope', 'secrets', 'openrouter-api-key');
  const routePolicyPath = path.join(codexHome, 'sks', 'bridge-route-policy.json');
  const bridgeSettingsPath = path.join(codexHome, 'sks', 'bridge-settings.json');
  const combinedCatalogPath = path.join(codexHome, 'sks', 'sks-bridge-catalog.json');
  const config = [
    '# sks-codex-lb-managed-provider-selection',
    'model_provider = "codex-lb"',
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example/backend-api/codex"',
    'env_key = "CODEX_LB_API_KEY"',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  const auth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-rollback',
    tokens: { access_token: 'oauth-old-access', refresh_token: 'oauth-old-refresh' }
  }, null, 2)}\n`;
  await fsp.mkdir(path.dirname(orCredentialPath), { recursive: true });
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(configPath, config, { mode: 0o600 });
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(lbCredentialPath, "export CODEX_LB_API_KEY='lb-before'\n", { mode: 0o600 });
  await fsp.writeFile(orCredentialPath, 'or-before\n', { mode: 0o600 });
  return {
    home,
    configPath,
    authPath,
    lbCredentialPath,
    orCredentialPath,
    routePolicyPath,
    bridgeSettingsPath,
    combinedCatalogPath,
    config,
    auth
  };
}

test('R34/R35: receipt rollback restores metadata but never overwrites rotated credentials or OAuth', async (t) => {
  const setup = await fixture(t);
  const routePolicy = '{"schema":"sks.bridge-routing-policy.v1","fallback":"none"}\n';
  const bridgeSettings = '{"schema":"sks.desktop-bridge-settings.v2"}\n';
  const migration = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath,
    legacyDesktopMode: 'cli-provider',
    metadataUpdates: [
      { kind: 'route_policy', path: setup.routePolicyPath, text: routePolicy },
      { kind: 'bridge_settings', path: setup.bridgeSettingsPath, text: bridgeSettings }
    ]
  });
  assert.equal(migration.ok, true);
  assert.equal(await fsp.readFile(setup.routePolicyPath, 'utf8'), routePolicy);
  assert.equal(await fsp.readFile(setup.bridgeSettingsPath, 'utf8'), bridgeSettings);

  const rotatedAuth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-rollback',
    tokens: { access_token: 'oauth-rotated-access', refresh_token: 'oauth-rotated-refresh' }
  }, null, 2)}\n`;
  await fsp.writeFile(setup.authPath, rotatedAuth, { mode: 0o600 });
  await fsp.writeFile(setup.lbCredentialPath, "export CODEX_LB_API_KEY='lb-rotated'\n", { mode: 0o600 });
  await fsp.writeFile(setup.orCredentialPath, 'or-rotated\n', { mode: 0o600 });

  const rollback = await rollbackDesktopBridgeUnificationReceipt({ receiptPath: migration.receipt_path! });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(rollback.credentials_overwritten, false);
  assert.equal(rollback.auth_overwritten, false);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  await assert.rejects(fsp.access(setup.routePolicyPath));
  await assert.rejects(fsp.access(setup.bridgeSettingsPath));
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), rotatedAuth);
  assert.equal(await fsp.readFile(setup.lbCredentialPath, 'utf8'), "export CODEX_LB_API_KEY='lb-rotated'\n");
  assert.equal(await fsp.readFile(setup.orCredentialPath, 'utf8'), 'or-rotated\n');

  const receiptText = await fsp.readFile(migration.receipt_path!, 'utf8');
  for (const secret of [
    'lb-before',
    'or-before',
    'oauth-old-access',
    'oauth-old-refresh',
    'lb-rotated',
    'or-rotated',
    'oauth-rotated-access',
    'oauth-rotated-refresh'
  ]) assert.doesNotMatch(receiptText, new RegExp(secret));
});

test('rollback fails closed when managed config changed after migration', async (t) => {
  const setup = await fixture(t);
  const migration = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath
  });
  assert.equal(migration.ok, true);
  const userEdited = `${await fsp.readFile(setup.configPath, 'utf8')}\n# user edit after migration\n`;
  await fsp.writeFile(setup.configPath, userEdited, { mode: 0o600 });
  await fsp.writeFile(setup.lbCredentialPath, "export CODEX_LB_API_KEY='lb-latest'\n", { mode: 0o600 });

  const rollback = await rollbackDesktopBridgeUnificationReceipt({ receipt: migration.receipt! });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.status, 'rollback_conflict');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), userEdited);
  assert.equal(await fsp.readFile(setup.lbCredentialPath, 'utf8'), "export CODEX_LB_API_KEY='lb-latest'\n");
});

test('rollback receipt validator rejects auth or secret-store targets', async (t) => {
  const setup = await fixture(t);
  const migration = await migrateLegacyModeToDesktopBridge({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    combinedCatalogPath: setup.combinedCatalogPath
  });
  assert.equal(migration.ok, true);
  const malicious = JSON.parse(JSON.stringify(migration.receipt)) as StoredDesktopBridgeUnificationReceipt;
  malicious.rollback_metadata.files.push({
    kind: 'route_policy',
    path: setup.authPath,
    before_sha256: null,
    after_sha256: null,
    backup_path: null,
    owned_by_sks: false
  });
  const rollback = await rollbackDesktopBridgeUnificationReceipt({ receipt: malicious });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.status, 'invalid_receipt');
  assert.match(rollback.error || '', /desktop_bridge_rollback_secret_file_forbidden/);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});
