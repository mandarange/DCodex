import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { openRouterStatus, useOpenRouter } from '../openrouter-activate.js';
import { OPENROUTER_DEFAULT_MODEL, OPENROUTER_PROVIDER_ID, openRouterAuthCommandArgs } from '../openrouter-provider.js';
import { openRouterSecretPaths, writeStoredOpenRouterKey } from '../../providers/openrouter/openrouter-secret-store.js';
import { ensureStoredOpenRouterProviderDuringInstall } from '../../../cli/install-helpers-codex-lb-config.js';
import { validateCodexConfigRoundTrip } from '../../codex/codex-config-toml.js';
import { readCodexModelCatalogFile } from '../codex-model-catalog.js';

const execFile = promisify(execFileCallback);

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function makeTempOpenRouterHarness() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-openrouter-activate-'));
  const root = path.join(temp, 'repo');
  const home = path.join(temp, 'home');
  const sksHome = path.join(temp, 'sks-home');
  const configPath = path.join(home, '.codex', 'config.toml');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const env = {
    HOME: home,
    SKS_HOME: sksHome,
    OPENROUTER_API_KEY: 'or-test-key-openrouter-activate',
    SKS_SKIP_CODEX_APP_RESTART: '1'
  } as NodeJS.ProcessEnv;
  return { temp, root, home, configPath, env };
}

test('openRouterStatus reports missing key and provider before activation', async (t) => {
  const { temp, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });
  delete env.OPENROUTER_API_KEY;
  await fs.writeFile(configPath, '', 'utf8');

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.ok, false);
  assert.equal(status.key_present, false);
  assert.equal(status.provider_present, false);
  assert.equal(status.selected, false);
  assert.ok(status.blockers.includes('openrouter_key_missing'));
  assert.ok(status.blockers.includes('openrouter_provider_missing'));
});

test('OpenRouter activation and status never invent GLM 5.2 when no model was selected', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(configPath, [
    'model_provider = "openrouter"',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    ''
  ].join('\n'));

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.ok, false);
  assert.equal(status.selected, true);
  assert.equal(status.model, null);
  assert.equal(status.model_source, null);
  assert.ok(status.blockers.includes('openrouter_model_missing'));

  const activation = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: '',
    restartApp: false
  });
  assert.equal(activation.ok, false);
  assert.deepEqual(activation.blockers, ['openrouter_model_invalid']);
  assert.match(String(activation.hint), /Choose a catalog model/);
});

test('useOpenRouter installs provider, selects OpenRouter model, and openRouterStatus agrees', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  const missingKey = await useOpenRouter({
    root,
    home,
    configPath,
    env: { ...env, OPENROUTER_API_KEY: '' },
    model: OPENROUTER_DEFAULT_MODEL,
    restartApp: false
  });
  assert.equal(missingKey.ok, false);
  assert.deepEqual(missingKey.blockers, ['openrouter_key_missing']);

  const invalidModel = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: '!!!bad!!!',
    restartApp: false
  });
  assert.equal(invalidModel.ok, false);
  assert.deepEqual(invalidModel.blockers, ['openrouter_model_invalid']);

  const storedKey = 'sk-or-v1-stored-desktop-auth-abcdefghijklmnop';
  await writeStoredOpenRouterKey(storedKey, { paths: openRouterSecretPaths(env) });
  delete env.OPENROUTER_API_KEY;
  const selectedModel = 'moonshotai/kimi-k3';

  const activated = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: selectedModel,
    restartApp: false
  });
  assert.equal(activated.ok, true, JSON.stringify(activated.blockers || activated));
  assert.equal(activated.status, 'active');
  assert.equal(activated.model, selectedModel);
  assert.equal((activated.profile as any)?.profile?.model, selectedModel);

  const config = await fs.readFile(configPath, 'utf8');
  assert.match(config, new RegExp(`model_provider\\s*=\\s*"${OPENROUTER_PROVIDER_ID}"`));
  assert.match(config, new RegExp(`model\\s*=\\s*"${selectedModel.replace('/', '\\/')}"`));
  assert.match(config, /\[model_providers\.openrouter\]/);
  assert.match(config, /\[model_providers\.openrouter\.auth\]/);
  assert.match(config, /command\s*=\s*"\/bin\/sh"/);
  assert.doesNotMatch(config, /^\s*env_key\s*=/m);
  assert.match(config, new RegExp(JSON.stringify(path.join(env.SKS_HOME!, 'secrets', 'openrouter-api-key')).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(config.includes(storedKey), false);
  const tokenCommand = await execFile('/bin/sh', [...openRouterAuthCommandArgs(openRouterSecretPaths(env).keyPath)], { env: {} });
  assert.equal(tokenCommand.stdout.trim(), storedKey);
  assert.doesNotMatch(config, /\[profiles\.sks-glm-52-/);

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.ok, true);
  assert.equal(status.key_present, true);
  assert.equal(status.provider_present, true);
  assert.equal(status.provider_env_key_present, false);
  assert.equal(status.provider_auth_present, true);
  assert.equal(status.provider_auth_conflict, false);
  assert.equal(status.provider_auth_valid, true);
  assert.equal(status.selected, true);
  assert.equal(status.model, selectedModel);
  assert.equal(status.model_source, 'config');
  assert.equal(status.model_catalog_bound, true);

  // Desktop feature UI: activation must bind a full ModelInfo catalog row and
  // ensure the [features] table so third-party models keep all feature UI.
  assert.match(config, new RegExp(`^model_catalog_json = "${escapeForRegExp(status.model_catalog_path)}"$`, 'm'));
  assert.match(config, /^\[features\]$/m);
  assert.match(config, /^apps = true$/m);
  assert.match(config, /^computer_use = true$/m);
  assert.match(config, /^image_generation = true$/m);
  assert.match(config, /^\[features\.multi_agent_v2\]$/m);
  assert.match(config, /^suppress_unstable_features_warning = true$/m);
  const catalog = await readCodexModelCatalogFile({ filePath: status.model_catalog_path, configured: true });
  assert.equal(catalog.ok, true, JSON.stringify(catalog.blockers));
  const row = catalog.models.find((entry) => entry.model === selectedModel);
  assert.ok(row, JSON.stringify(catalog.models));
  assert.equal(row?.multi_agent_version, 'v2');
  assert.ok((row?.reasoning_efforts || []).includes('high'));
});

test('useOpenRouter reports config_applied independently from restart failure', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const result = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: OPENROUTER_DEFAULT_MODEL,
    restartApp: true,
    restartImpl: async () => ({
      schema: 'sks.codex-app-restart.v1',
      ok: false,
      status: 'blocked',
      app_name: 'Codex',
      blockers: ['fixture_restart_failed']
    })
  });
  assert.equal(result.ok, true);
  assert.equal(result.config_applied, true);
  assert.equal(result.restart_ok, false);
  assert.equal(result.status, 'active_restart_blocked');
  assert.deepEqual(result.blockers, []);
  assert.ok((result.warnings as string[]).includes('restart:fixture_restart_failed'));
});

test('upgrade repair adds stored-key auth to an existing OpenRouter provider without selecting it', async (t) => {
  const { temp, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  delete env.OPENROUTER_API_KEY;
  const storedKey = 'sk-or-v1-upgrade-repair-abcdefghijklmnop';
  await writeStoredOpenRouterKey(storedKey, { paths: openRouterSecretPaths(env) });
  await fs.writeFile(configPath, [
    'model = "openai/gpt-5.6-sol"',
    'model_provider = "openai"',
    '',
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'env_key = "OPENROUTER_API_KEY"',
    'requires_openai_auth = false',
    ''
  ].join('\n'));

  const repaired = await ensureStoredOpenRouterProviderDuringInstall({ home, configPath, env });
  assert.equal(repaired.ok, true, JSON.stringify(repaired));
  assert.equal(repaired.key_present, true);
  assert.equal(repaired.key_source, 'user-secret-store');
  const config = await fs.readFile(configPath, 'utf8');
  assert.match(config, /model\s*=\s*"openai\/gpt-5\.6-sol"/);
  assert.match(config, /model_provider\s*=\s*"openai"/);
  assert.match(config, /\[model_providers\.openrouter\.auth\]/);
  assert.match(config, /command\s*=\s*"\/bin\/sh"/);
  assert.doesNotMatch(config, /^\s*env_key\s*=/m);
  assert.equal(validateCodexConfigRoundTrip(config).ok, true);
  assert.equal(config.includes(storedKey), false);

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.key_present, true);
  assert.equal(status.provider_present, true);
  assert.equal(status.provider_auth_present, true);
  assert.equal(status.selected, false);

  const repairedAgain = await ensureStoredOpenRouterProviderDuringInstall({ home, configPath, env });
  assert.equal(repairedAgain.ok, true, JSON.stringify(repairedAgain));
  assert.equal(repairedAgain.status, 'present');
  assert.equal((repairedAgain as { repair?: { changed?: boolean; backup_path?: string | null } }).repair?.changed, false);
  assert.equal((repairedAgain as { repair?: { changed?: boolean; backup_path?: string | null } }).repair?.backup_path, null);
  assert.equal(await fs.readFile(configPath, 'utf8'), config);
});

test('OpenRouter status and shared config validation reject env_key plus command auth', async (t) => {
  const { temp, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const storedKey = 'sk-or-v1-conflict-detection-abcdefghijklmnop';
  await writeStoredOpenRouterKey(storedKey, { paths: openRouterSecretPaths(env) });
  delete env.OPENROUTER_API_KEY;
  const authArgs = openRouterAuthCommandArgs(openRouterSecretPaths(env).keyPath);
  const config = [
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    'wire_api = "responses"',
    'env_key = "OPENROUTER_API_KEY"',
    'requires_openai_auth = false',
    '',
    '[model_providers.openrouter.auth]',
    'command = "/bin/sh"',
    `args = [${authArgs.map((value) => JSON.stringify(value)).join(', ')}]`,
    'timeout_ms = 5000',
    'refresh_interval_ms = 300000',
    ''
  ].join('\n');
  await fs.writeFile(configPath, config, 'utf8');

  const validation = validateCodexConfigRoundTrip(config);
  assert.equal(validation.ok, false);
  assert.deepEqual(validation.blockers, ['model_provider_auth_env_key_conflict:openrouter']);

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.ok, false);
  assert.equal(status.provider_env_key_present, true);
  assert.equal(status.provider_auth_present, true);
  assert.equal(status.provider_auth_conflict, true);
  assert.equal(status.provider_auth_valid, false);
  assert.ok(status.blockers.includes('openrouter_provider_auth_env_key_conflict'));
});

test('re-activating OpenRouter preserves the cross-provider routing snapshot', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const storedKey = 'sk-or-v1-stored-desktop-auth-abcdefghijklmnop';
  await writeStoredOpenRouterKey(storedKey, { paths: openRouterSecretPaths(env) });
  delete env.OPENROUTER_API_KEY;
  await fs.writeFile(configPath, [
    'model_provider = "codex-lb"',
    'model = "gpt-5.6-sol"',
    ''
  ].join('\n'));

  const first = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: 'moonshotai/kimi-k3',
    restartApp: false
  });
  assert.equal(first.ok, true, JSON.stringify(first.blockers || first));
  const snapshotFile = path.join(home, '.codex', 'sks-previous-desktop-routing.json');
  const firstSnapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
  assert.equal(firstSnapshot.model_provider, 'codex-lb');
  assert.equal(firstSnapshot.model, 'gpt-5.6-sol');
  assert.equal(first.previous_routing_restore_available, true);

  // Second activation runs with OpenRouter already selected (Center
  // "Refresh Models" re-runs use-openrouter) and must not clobber the
  // codex-lb snapshot with a self-referential openrouter->openrouter one.
  const second = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: 'moonshotai/kimi-k3',
    restartApp: false
  });
  assert.equal(second.ok, true, JSON.stringify(second.blockers || second));
  const secondSnapshot = JSON.parse(await fs.readFile(snapshotFile, 'utf8'));
  assert.equal(secondSnapshot.model_provider, 'codex-lb');
  assert.equal(secondSnapshot.model, 'gpt-5.6-sol');
  assert.equal(second.previous_routing_restore_available, true);
  assert.equal(
    (second.routing_snapshot_write as any)?.skipped,
    'preserved_existing_cross_provider_snapshot'
  );
});

test('activating OpenRouter while already selected without a snapshot does not fabricate restore availability', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const storedKey = 'sk-or-v1-stored-desktop-auth-abcdefghijklmnop';
  await writeStoredOpenRouterKey(storedKey, { paths: openRouterSecretPaths(env) });
  delete env.OPENROUTER_API_KEY;
  await fs.writeFile(configPath, [
    'model_provider = "openrouter"',
    'model = "moonshotai/kimi-k3"',
    ''
  ].join('\n'));

  const activated = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: 'moonshotai/kimi-k3',
    restartApp: false
  });
  assert.equal(activated.ok, true, JSON.stringify(activated.blockers || activated));
  assert.equal(activated.previous_routing_restore_available, false);
  assert.equal(
    (activated.routing_snapshot_write as any)?.skipped,
    'self_referential_snapshot_not_written'
  );
  const snapshotFile = path.join(home, '.codex', 'sks-previous-desktop-routing.json');
  await assert.rejects(fs.access(snapshotFile));
  assert.ok(
    (activated.warnings as string[]).includes(
      'routing_snapshot_not_written:self_referential_snapshot_not_written'
    )
  );

  const status = await openRouterStatus({ home, configPath, env });
  assert.equal(status.previous_routing_restore_available, false);
  assert.equal(status.warnings.includes('desktop_routing_snapshot_restore_available'), false);
});

test('OpenRouter activation cannot expose a shared codex-lb key by removing its routing guard', async (t) => {
  const { temp, root, home, configPath, env } = await makeTempOpenRouterHarness();
  t.after(async () => fs.rm(temp, { recursive: true, force: true }));
  const codexHome = path.dirname(configPath);
  const gatewayKey = 'sk-clb-openrouter-shared-auth';
  const remote = 'https://lb.example.test/backend-api/codex';
  const managedCatalog = path.join(codexHome, 'sks-codex-lb-tool-catalog.json');
  const authPath = path.join(codexHome, 'auth.json');
  const auth = `{"auth_mode":"apikey","OPENAI_API_KEY":"${gatewayKey}"}\n`;
  await fs.writeFile(configPath, [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    `openai_base_url = "${remote}"`,
    `model_catalog_json = ${JSON.stringify(managedCatalog)}`,
    '',
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    `base_url = "${remote}"`,
    'wire_api = "responses"',
    'env_key = "CODEX_LB_API_KEY"',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n'));
  await fs.writeFile(managedCatalog, '{"models":[]}\n', { mode: 0o600 });
  await fs.writeFile(
    path.join(codexHome, 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL=${JSON.stringify(remote)}\nexport CODEX_LB_API_KEY=${JSON.stringify(gatewayKey)}\n`,
    { mode: 0o600 }
  );
  await fs.writeFile(authPath, auth, { mode: 0o600 });

  const result = await useOpenRouter({
    root,
    home,
    configPath,
    env,
    model: OPENROUTER_DEFAULT_MODEL,
    restartApp: false
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.blockers, ['legacy_codex_lb_desktop_config_requires_migration']);
  const config = await fs.readFile(configPath, 'utf8');
  assert.match(config, /^model_provider = "codex-lb"$/m);
  assert.match(config, /^openai_base_url = "https:\/\/lb\.example\.test\/backend-api\/codex"$/m);
  assert.equal(await fs.readFile(authPath, 'utf8'), auth);
});
