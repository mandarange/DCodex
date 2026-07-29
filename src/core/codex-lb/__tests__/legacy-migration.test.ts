import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexAuthChatgptBackupPath } from '../../../cli/install-helpers-codex-lb-shared.js';
import {
  detectLegacyCodexLbDesktopState,
  migrateLegacyCodexLbDesktop
} from '../legacy-migration.js';
import { rollbackCodexLbMigrationReceipt } from '../migration-receipt.js';

const REMOTE = 'https://lb.example.test/backend-api/codex';
const BRIDGE = 'http://127.0.0.1:47821/backend-api/codex';
const LEGACY_KEY = 'sk-clb-legacy-fixture';
const LEGACY_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';

function cliProviderConfig(): string {
  return [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
}

function orphanedLegacyConfig(catalogPath: string): string {
  return [
    LEGACY_OPENAI_ROUTING_MARKER,
    `model_catalog_json = "${catalogPath}"`,
    '',
    cliProviderConfig()
  ].join('\n');
}

async function fixture(t: test.TestContext, withBackup = true) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-legacy-migration-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const authPath = path.join(codexHome, 'auth.json');
  const oauthBackupPath = codexAuthChatgptBackupPath(home);
  const catalogPath = path.join(codexHome, 'sks-codex-lb-tool-catalog.json');
  const config = [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${REMOTE}"`,
    `model_catalog_json = "${catalogPath}"`,
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    `base_url = "${REMOTE}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'requires_openai_auth = true',
    ''
  ].join('\n');
  const auth = `{"auth_mode":"apikey","OPENAI_API_KEY":"${LEGACY_KEY}"}\n`;
  const oauth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    account_id: 'acct-preserved',
    tokens: {
      access_token: 'oauth-before',
      refresh_token: 'refresh-before'
    }
  }, null, 2)}\n`;
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(configPath, config);
  await fsp.writeFile(authPath, auth, { mode: 0o600 });
  await fsp.writeFile(catalogPath, '{"models":[]}\n');
  if (withBackup) await fsp.writeFile(oauthBackupPath, oauth, { mode: 0o600 });
  return { home, codexHome, configPath, authPath, oauthBackupPath, catalogPath, config, auth, oauth };
}

test('legacy detection recognizes the explicit destructive provider-selection path', async (t) => {
  const setup = await fixture(t);
  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, true);
  assert.equal(detected.auth_mode, 'openai_api_key');
  assert.equal(detected.provider_selected, true);
  assert.equal(detected.managed_remote_routing, true);
  assert.equal(detected.oauth_backup_valid, true);
});

test('actual orphan state without a catalog marker remains an explicit migration candidate', async (t) => {
  const setup = await fixture(t);
  const config = orphanedLegacyConfig(setup.catalogPath);
  await fsp.writeFile(setup.configPath, config);

  assert.doesNotMatch(config, /^model_provider\s*=/m);
  assert.doesNotMatch(config, /^openai_base_url\s*=/m);
  assert.doesNotMatch(config, /sks-codex-lb-managed-model-catalog/);
  assert.match(config, /^\[model_providers\.codex-lb\]$/m);
  assert.match(config, /^requires_openai_auth\s*=\s*false$/m);

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, true);
  assert.equal(detected.auth_mode, 'openai_api_key');
  assert.equal(detected.provider_selected, false);
  assert.equal(detected.provider_base_url, REMOTE);
  assert.equal(detected.managed_openai_base_url, null);
  assert.equal(detected.managed_remote_routing, false);
  assert.equal(detected.oauth_backup_valid, true);
  assert.equal(detected.gateway_key_binding_checked, true);
  assert.equal(detected.gateway_key_matches, true);
  assert.deepEqual(detected.blockers, []);
});

test('selected cli-provider after openai_base_url strip remains migratable (restore orphan)', async (t) => {
  const setup = await fixture(t);
  const config = [
    'model_provider = "codex-lb"',
    LEGACY_OPENAI_ROUTING_MARKER,
    `model_catalog_json = "${setup.catalogPath}"`,
    '',
    cliProviderConfig()
  ].join('\n');
  await fsp.writeFile(setup.configPath, config);

  assert.match(config, /^model_provider\s*=\s*"codex-lb"$/m);
  assert.doesNotMatch(config, /^openai_base_url\s*=/m);
  assert.match(config, /^env_key\s*=\s*"CODEX_LB_API_KEY"$/m);

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    remoteBaseUrl: REMOTE,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, true);
  assert.equal(detected.provider_selected, true);
  assert.equal(detected.managed_remote_routing, false);
  assert.equal(detected.managed_openai_base_url, null);
  assert.equal(detected.gateway_key_matches, true);
  assert.equal(detected.oauth_backup_valid, true);
  assert.deepEqual(detected.blockers, []);
});

test('fully stripped router orphan is recoverable only when the shared key matches codex-lb', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, cliProviderConfig());

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    remoteBaseUrl: REMOTE,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, true);
  assert.equal(detected.provider_selected, false);
  assert.equal(detected.gateway_key_matches, true);
  assert.deepEqual(detected.blockers, []);
});

test('foreign API-key auth with a provider-like CLI block is not legacy when key binding mismatches', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, cliProviderConfig());
  const beforeConfig = await fsp.readFile(setup.configPath);
  const beforeAuth = await fsp.readFile(setup.authPath);

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    remoteBaseUrl: REMOTE,
    expectedGatewayApiKey: 'sk-clb-different-fixture'
  });
  assert.equal(detected.legacy_destructive_mode, false);
  assert.equal(detected.auth_mode, 'openai_api_key');
  assert.equal(detected.provider_selected, false);
  assert.equal(detected.managed_openai_base_url, null);
  assert.equal(detected.managed_remote_routing, false);
  assert.deepEqual(detected.blockers, [
    'legacy_gateway_key_mismatch',
    'legacy_codex_lb_provider_not_selected',
    'legacy_managed_remote_openai_routing_missing'
  ]);

  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: 'sk-clb-different-fixture'
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_legacy');
  assert.deepEqual(await fsp.readFile(setup.configPath), beforeConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
});

test('ordinary v2 CLI-provider config with active ChatGPT OAuth is never destructive legacy', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(setup.configPath, cliProviderConfig());
  await fsp.writeFile(setup.authPath, setup.oauth, { mode: 0o600 });
  const beforeConfig = await fsp.readFile(setup.configPath);
  const beforeAuth = await fsp.readFile(setup.authPath);

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, false);
  assert.equal(detected.auth_mode, 'chatgpt_oauth');
  assert.equal(detected.provider_selected, false);
  assert.equal(detected.managed_remote_routing, false);
  assert.ok(detected.blockers.includes('legacy_auth_not_api_key_only'));

  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'not_legacy');
  assert.deepEqual(await fsp.readFile(setup.configPath), beforeConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
});

test('SKS-owned orphan state without an OAuth backup requires codex login without mutating files', async (t) => {
  const setup = await fixture(t, false);
  const receiptDir = path.join(setup.codexHome, 'sks-codex-lb-migrations');
  await fsp.writeFile(setup.configPath, orphanedLegacyConfig(setup.catalogPath));
  const beforeConfig = await fsp.readFile(setup.configPath);
  const beforeAuth = await fsp.readFile(setup.authPath);

  const detected = await detectLegacyCodexLbDesktopState({
    home: setup.home,
    receiptDir,
    expectedGatewayApiKey: LEGACY_KEY
  });
  assert.equal(detected.legacy_destructive_mode, true);
  assert.equal(detected.oauth_backup_valid, false);
  assert.equal(detected.recovery_evidence, false);
  assert.deepEqual(detected.blockers, ['legacy_oauth_recovery_evidence_missing']);

  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    receiptDir
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'oauth_login_required');
  assert.deepEqual(result.blockers, ['valid_chatgpt_oauth_backup_required', 'run_codex_login']);
  assert.deepEqual(await fsp.readFile(setup.configPath), beforeConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  await assert.rejects(fsp.access(receiptDir));
});

test('legacy migration restores OAuth, preserves semantic identity across token rotation, and writes SHA receipt', async (t) => {
  const setup = await fixture(t);
  const bridgeSettingsPath = path.join(setup.codexHome, 'sks', 'bridge-settings.json');
  const bridgeLaunchAgentPath = path.join(setup.home, 'Library', 'LaunchAgents', 'bridge.plist');
  const bridgeStatePath = path.join(setup.codexHome, 'sks', 'bridge-state.json');
  const order: string[] = [];
  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    bridgeSettingsPath,
    bridgeLaunchAgentPath,
    bridgeStatePath,
    gatewayAuthTransport: 'authorization-bearer-compat',
    quitApp: async () => {
      order.push('quit');
      assert.match(await fsp.readFile(setup.authPath, 'utf8'), /OPENAI_API_KEY/);
      return { ok: true, status: 'quit' };
    },
    startBridge: async () => {
      order.push('bridge');
      assert.doesNotMatch(await fsp.readFile(setup.authPath, 'utf8'), /OPENAI_API_KEY/);
      await fsp.mkdir(path.dirname(bridgeSettingsPath), { recursive: true });
      await fsp.mkdir(path.dirname(bridgeLaunchAgentPath), { recursive: true });
      await fsp.writeFile(bridgeSettingsPath, '{"ok":true}\n');
      await fsp.writeFile(bridgeLaunchAgentPath, '<plist/>\n');
      await fsp.writeFile(bridgeStatePath, '{"running":true}\n');
      return { ok: true, status: 'started' };
    },
    restartApp: async () => {
      order.push('restart');
      await fsp.writeFile(setup.authPath, `${JSON.stringify({
        auth_mode: 'chatgpt',
        account_id: 'acct-preserved',
        tokens: {
          access_token: 'oauth-rotated',
          refresh_token: 'refresh-rotated'
        }
      })}\n`);
      return { ok: true, status: 'restarted' };
    },
    verifyCapabilities: async () => ({
      ok: true,
      summary: { responses: 'ok', websocket: 'ok' }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'migrated');
  assert.equal(result.identity_plane, 'chatgpt_oauth');
  assert.equal(result.routing_plane, 'desktop_native_bridge');
  assert.equal(result.gateway_auth_transport, 'authorization-bearer-compat');
  assert.equal(result.oauth_preserved, true);
  assert.deepEqual(order, ['quit', 'bridge', 'restart']);
  assert.ok(result.receipt_path);
  assert.ok(result.receipt);
  assert.equal(result.receipt?.oauth_preserved, true);
  assert.ok(result.receipt?.files.every((file) => file.after_sha256 !== undefined));
  assert.ok(result.receipt?.files.some((file) => file.path === bridgeSettingsPath));
  assert.ok(result.receipt?.files.some((file) => file.path === bridgeLaunchAgentPath));
  assert.ok(result.receipt?.files.some((file) => file.path === bridgeStatePath));
  const config = await fsp.readFile(setup.configPath, 'utf8');
  assert.doesNotMatch(config, /^model_provider\s*=\s*"codex-lb"/m);
  assert.match(config, new RegExp(`openai_base_url = "${BRIDGE}"`));
  assert.doesNotMatch(config, /^model_catalog_json\s*=/m);
  assert.match(await fsp.readFile(setup.authPath, 'utf8'), /oauth-rotated/);

  const rollback = await rollbackCodexLbMigrationReceipt({ receipt: result.receipt });
  assert.equal(rollback.ok, true);
  assert.equal(rollback.status, 'rolled_back');
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
  await assert.rejects(fsp.access(bridgeSettingsPath));
  await assert.rejects(fsp.access(bridgeLaunchAgentPath));
  await assert.rejects(fsp.access(bridgeStatePath));
});

test('legacy migration requires an actual app restart callback before mutating files or writing a receipt', async (t) => {
  const setup = await fixture(t);
  const receiptDir = path.join(setup.codexHome, 'sks-codex-lb-migrations');
  const beforeConfig = await fsp.readFile(setup.configPath);
  const beforeAuth = await fsp.readFile(setup.authPath);
  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    receiptDir,
    startBridge: async () => ({ ok: true, status: 'started' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'restart_required');
  assert.deepEqual(result.blockers, ['codex_app_restart_required', 'rerun_with_restart_app']);
  assert.equal(result.receipt_path, null);
  assert.deepEqual(await fsp.readFile(setup.configPath), beforeConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  await assert.rejects(fsp.access(receiptDir));
});

test('legacy migration refuses to mutate until Codex App quiescence is verified', async (t) => {
  const setup = await fixture(t);
  const receiptDir = path.join(setup.codexHome, 'sks-codex-lb-migrations');
  const beforeConfig = await fsp.readFile(setup.configPath);
  const beforeAuth = await fsp.readFile(setup.authPath);
  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    receiptDir,
    quitApp: async () => ({
      ok: false,
      status: 'blocked'
    }),
    restartApp: async () => ({ ok: true, status: 'restarted' })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.blockers, ['codex_app_quiescence_required']);
  assert.deepEqual(await fsp.readFile(setup.configPath), beforeConfig);
  assert.deepEqual(await fsp.readFile(setup.authPath), beforeAuth);
  await assert.rejects(fsp.access(receiptDir));
});

test('post-restart verification failure requiesces the app before bridge stop and rollback', async (t) => {
  const setup = await fixture(t);
  const events: string[] = [];
  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    quitApp: async () => {
      events.push('quit');
      return { ok: true, status: 'quit' };
    },
    startBridge: async () => {
      events.push('bridge-start');
      return { ok: true, status: 'started' };
    },
    stopBridge: async () => {
      events.push('bridge-stop');
      return { ok: true, status: 'stopped' };
    },
    restartApp: async () => {
      events.push('restart');
      return { ok: true, status: 'restarted' };
    },
    verifyCapabilities: async () => ({
      ok: false,
      blockers: ['fixture_transport_failed']
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.deepEqual(events, ['quit', 'bridge-start', 'restart', 'quit', 'bridge-stop']);
  assert.equal((result.rollback as { ok?: boolean }).ok, true);
  assert.equal(await fsp.readFile(setup.configPath, 'utf8'), setup.config);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.auth);
});

test('rollback leaves the coherent OAuth plus bridge state intact when bridge stop is unverified', async (t) => {
  const setup = await fixture(t);
  const result = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    quitApp: async () => ({ ok: true, status: 'quit' }),
    startBridge: async () => ({ ok: true, status: 'started' }),
    stopBridge: async () => ({
      ok: false,
      status: 'blocked',
      running: true
    }),
    restartApp: async () => ({ ok: true, status: 'restarted' }),
    verifyCapabilities: async () => ({
      ok: false,
      blockers: ['fixture_transport_failed']
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(result.identity_plane, 'chatgpt_oauth');
  assert.equal(result.routing_plane, 'desktop_native_bridge');
  assert.equal(result.oauth_preserved, true);
  assert.equal(result.rollback, undefined);
  assert.ok(result.blockers.includes('legacy_migration_bridge_stop_unverified'));
  assert.ok(result.blockers.includes('legacy_migration_manual_recovery_required'));
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /sks-codex-lb-managed-desktop-bridge/);
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), setup.oauth);
});

test('rollback refuses to overwrite user edits made after migration', async (t) => {
  const setup = await fixture(t);
  const migrated = await migrateLegacyCodexLbDesktop({
    home: setup.home,
    bridgeBaseUrl: BRIDGE,
    remoteBaseUrl: REMOTE,
    gatewayApiKey: LEGACY_KEY,
    quitApp: async () => ({ ok: true, status: 'quit' }),
    restartApp: async () => ({ ok: true, status: 'restarted' })
  });
  assert.equal(migrated.ok, true);
  assert.ok(migrated.receipt);
  await fsp.appendFile(setup.configPath, '# user edit after migration\n');
  const authBeforeRollback = await fsp.readFile(setup.authPath, 'utf8');
  const rollback = await rollbackCodexLbMigrationReceipt({ receipt: migrated.receipt });
  assert.equal(rollback.ok, false);
  assert.equal(rollback.status, 'rollback_conflict');
  assert.equal(await fsp.readFile(setup.authPath, 'utf8'), authBeforeRollback);
  assert.match(await fsp.readFile(setup.configPath, 'utf8'), /user edit after migration/);
});
