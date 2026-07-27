import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, exists, packageRoot, runProcess, tmpdir, writeTextAtomic } from '../core/fsx.js';
import { initProject } from '../core/init.js';
import {
  hasCodexUnstableFeatureWarningSuppression,
  hasDeprecatedCodexHooksFeatureFlag,
  hasTopLevelCodexModeLock
} from './install-tool-helpers.js';
import {
  configureCodexLb,
  maybePromptCodexLbSetupForLaunch,
  type ConfigureCodexLbResult
} from './install-helpers.js';
import { checkCodexLbResponseChain } from './install-helpers-codex-lb-chain.js';
import { hasTopLevelCodexLbSelected } from './install-helpers-codex-lb-shared.js';
import { postinstall } from './install-helpers.js';
import { runCodexLbLaunchChainSelftest } from './install-helpers-codex-lb-selftest-chain.js';

function packagedSksEntrypoint() {
  return path.join(packageRoot(), 'dist', 'bin', 'sks.js');
}

async function safeReadText(file: any, fallback: any = '') {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
}

async function codexLbLoginCallCount(home: any) {
  return (await safeReadText(path.join(home, '.codex', 'login-calls.log'))).trim().split(/\r?\n/).filter(Boolean).length;
}

function codexLbPostinstallEnv(baseEnv: any, overrides: any = {}) {
  return {
    ...baseEnv,
    SKS_POSTINSTALL_BOOTSTRAP: '1',
    SKS_POSTINSTALL_NO_BOOTSTRAP: '',
    SKS_SKIP_POSTINSTALL_SHIM: '1',
    SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
    SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
    SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
    SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '0',
    SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
    SKS_SKIP_CODEX_APP_UPGRADE_REPAIR: '1',
    ...overrides
  };
}

export async function selftestCodexLb(tmp: any) {
  const codexLbHome = path.join(tmp, 'codex-lb-home');
  await ensureDir(path.join(codexLbHome, '.codex'));
  const codexLbFakeBin = path.join(tmp, 'codex-lb-fake-bin');
  await ensureDir(codexLbFakeBin);
  const codexLbFakeCodex = path.join(codexLbFakeBin, 'codex');
  // NOTE: printf format uses literal double-quotes inside single-quoted shell strings so the
  // fake login writes proper JSON in both bash and dash (where `\"` is a non-standard printf
  // escape that dash emits literally and bash collapses to `"`).
  await writeTextAtomic(codexLbFakeCodex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 99.0.0\"; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo \"logged in with browser auth\"; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"--with-api-key\" ]; then read key; mkdir -p \"$HOME/.codex\"; printf '{\"auth_mode\":\"apikey\",\"OPENAI_API_KEY\":\"%s\"}\\n' \"$key\" > \"$HOME/.codex/auth.json\"; printf '%s\\n' \"$key\" >> \"$HOME/.codex/login-calls.log\"; exit 0; fi\necho \"fake codex unsupported\" >&2\nexit 1\n");
  await fsp.chmod(codexLbFakeCodex, 0o755);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `model_reasoning_effort = "low"\nservice_tier = "fast"\nsuppress_unstable_features_warning = true\n\n[profiles.custom]\nmodel_reasoning_effort = "low"\n\n[notice]\nfast_default_opt_out = true\n\n[features]\nhooks = true\n`);
  const codexLbEnvForSelftest = { HOME: codexLbHome, SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-global'), PATH: `${codexLbFakeBin}${path.delimiter}${process.env.PATH || ''}`, SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '1', SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1', SKS_CODEX_MODEL: 'selftest-codex-model' };
  const codexLbSetup = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'setup', '--host', 'lb.example.test', '--api-key-stdin', '--json'], {
    cwd: tmp,
    env: codexLbEnvForSelftest,
    input: 'sk-test\n',
    timeoutMs: 15000,
    maxOutputBytes: 64 * 1024
  });
  if (codexLbSetup.code !== 0) throw new Error(`selftest: codex-lb setup exited ${codexLbSetup.code}: ${codexLbSetup.stderr}`);
  const codexLbSetupJson = JSON.parse(codexLbSetup.stdout);
  const codexLbConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbSetupJson.ok || codexLbSetupJson.base_url !== 'https://lb.example.test/backend-api/codex' || !hasTopLevelCodexLbSelected(codexLbConfig) || !codexLbConfig.includes('[model_providers.codex-lb]') || !codexLbEnv.includes("CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'") || !codexLbEnv.includes("CODEX_LB_API_KEY='sk-test'") || codexLbSetupJson.codex_environment?.ok !== true || codexLbSetupJson.codex_login?.status !== 'apikey_forced' || !codexLbAuth.includes('OPENAI_API_KEY') || !codexLbAuth.includes('sk-test')) throw new Error('selftest: codex-lb setup');
  if (!codexLbConfig.includes('requires_openai_auth = true') || !codexLbConfig.includes('name = "openai"')) throw new Error('selftest: codex-lb setup did not write current codex-lb App provider contract');
  const codexLbFailLaunchctl = path.join(codexLbFakeBin, 'launchctl-fail');
  await writeTextAtomic(codexLbFailLaunchctl, '#!/bin/sh\necho "launchctl denied" >&2\nexit 7\n');
  await fsp.chmod(codexLbFailLaunchctl, 0o755);
  const codexLbFailedLaunchEnv = await configureCodexLb({ home: path.join(tmp, 'codex-lb-launch-fail-home'), host: 'lb.example.test', apiKey: 'sk-fail', forceLaunchEnv: true, launchctlBin: codexLbFailLaunchctl });
  if (codexLbFailedLaunchEnv.ok || codexLbFailedLaunchEnv.status !== 'launch_env_failed' || !/launchctl denied/.test(codexLbFailedLaunchEnv.error || '')) throw new Error('selftest: codex-lb setup must expose launch-env failure');
  if (!hasCodexUnstableFeatureWarningSuppression(codexLbConfig)) throw new Error('selftest: codex-lb setup did not suppress Codex unstable feature warning');
  await initProject(codexLbHome, { installScope: 'global', force: true, repair: true });
  const codexLbRepairSetupConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (!hasTopLevelCodexLbSelected(codexLbRepairSetupConfig) || !codexLbRepairSetupConfig.includes('[model_providers.codex-lb]') || !codexLbRepairSetupConfig.includes('https://lb.example.test/backend-api/codex') || codexLbRepairSetupConfig.includes('sk-test')) throw new Error('selftest: init codex-lb');
  if (!codexLbRepairSetupConfig.includes('requires_openai_auth = true') || !codexLbRepairSetupConfig.includes('name = "openai"')) throw new Error('selftest: init codex-lb did not preserve current App provider contract');
  if (!hasCodexUnstableFeatureWarningSuppression(codexLbRepairSetupConfig)) throw new Error('selftest: init codex-lb did not suppress Codex unstable feature warning');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `${codexLbConfig}\n[mcp_servers.supabase]\nurl = "https://mcp.supabase.com/mcp?project_ref=ref&read_only=true&features=database,docs"\n`);
  const ptmp = path.join(tmp, 'codex-lb-project-config'), prevHome = process.env.HOME;
  try { process.env.HOME = codexLbHome; await initProject(ptmp, { installScope: 'global' }); }
  finally { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
  const pcfg = await safeReadText(path.join(ptmp, '.codex', 'config.toml'));
  if (!hasTopLevelCodexLbSelected(pcfg) || !pcfg.includes('[model_providers.codex-lb]') || !pcfg.includes('[mcp_servers.supabase]') || !pcfg.includes('read_only=true')) throw new Error('selftest: project codex-lb');
  if (!pcfg.includes('requires_openai_auth = true') || !pcfg.includes('name = "openai"')) throw new Error('selftest: project codex-lb did not copy current App provider contract');
  if (!hasCodexUnstableFeatureWarningSuppression(pcfg)) throw new Error('selftest: project codex-lb config did not suppress Codex unstable feature warning');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"browser"}\n');
  const codexLbRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'auth', 'repair', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbRepair.code !== 0) throw new Error(`selftest: codex-lb repair exited ${codexLbRepair.code}: ${codexLbRepair.stderr}`);
  const codexLbRepairJson = JSON.parse(codexLbRepair.stdout);
  const codexLbRepairedAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbRepairJson.ok || codexLbRepairJson.status !== 'repaired' || codexLbRepairJson.codex_environment?.ok !== true || codexLbRepairJson.codex_login?.status !== 'skipped' || !codexLbRepairedAuth.includes('"auth_mode":"browser"') || codexLbRepairedAuth.includes('sk-test')) throw new Error('selftest: codex-lb repair');
  const codexLbLegacyRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'auth', 'repair', '--json'], { cwd: tmp, env: { ...codexLbEnvForSelftest, SKS_CODEX_LB_SYNC_CODEX_LOGIN: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbLegacyRepair.code !== 0) throw new Error(`selftest: codex-lb legacy login repair exited ${codexLbLegacyRepair.code}: ${codexLbLegacyRepair.stderr}`);
  const codexLbLegacyRepairJson = JSON.parse(codexLbLegacyRepair.stdout);
  const codexLbLegacyAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbLegacyRepairJson.ok || codexLbLegacyRepairJson.codex_login?.status !== 'synced' || !codexLbLegacyAuth.includes('"auth_mode":"apikey"') || !codexLbLegacyAuth.includes('sk-test')) throw new Error('selftest: codex-lb legacy login repair');
  const codexLbLoginCallsBeforePostinstall = await codexLbLoginCallCount(codexLbHome);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"browser"}\n');
  const codexLbPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbPostinstall.code !== 0) throw new Error(`selftest: codex-lb postinstall auth preservation exited ${codexLbPostinstall.code}: ${codexLbPostinstall.stderr}`);
  const codexLbPostinstallAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbLoginCallsAfterPostinstall = await codexLbLoginCallCount(codexLbHome);
  if (!String(codexLbPostinstall.stdout || '').includes('codex-lb auth: preserved') || !codexLbPostinstallAuth.includes('"auth_mode":"browser"') || codexLbPostinstallAuth.includes('sk-test') || codexLbLoginCallsAfterPostinstall !== codexLbLoginCallsBeforePostinstall) throw new Error('selftest: postinstall auth');
  const postinstallEnvKeys = ['HOME', 'PATH', 'INIT_CWD', 'SKS_GLOBAL_ROOT', 'SKS_POSTINSTALL_BOOTSTRAP', 'SKS_POSTINSTALL_NO_BOOTSTRAP', 'SKS_SKIP_POSTINSTALL_SHIM', 'SKS_SKIP_POSTINSTALL_CONTEXT7', 'SKS_SKIP_POSTINSTALL_GETDESIGN', 'SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS', 'SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH', 'SKS_SKIP_CODEX_LB_LAUNCH_ENV', 'SKS_SKIP_CODEX_APP_UPGRADE_REPAIR', 'SKS_CODEX_LB_SYNC_CODEX_LOGIN'];
  const postinstallEnvBefore = Object.fromEntries(postinstallEnvKeys.map((key: any) => [key, process.env[key]]));
  const codexLbLoginCallsBeforeBootstrap = await codexLbLoginCallCount(codexLbHome);
  try {
    for (const key of postinstallEnvKeys) delete process.env[key];
    Object.assign(process.env, {
      HOME: codexLbHome,
      PATH: `${codexLbFakeBin}${path.delimiter}${postinstallEnvBefore.PATH || ''}`,
      INIT_CWD: tmp,
      SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-postinstall-global'),
      SKS_POSTINSTALL_BOOTSTRAP: '1',
      SKS_SKIP_POSTINSTALL_SHIM: '1',
      SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
      SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
      SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
      SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '0',
      SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
      SKS_SKIP_CODEX_APP_UPGRADE_REPAIR: '1'
    });
    await postinstall({
      bootstrap: async () => {
        await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"browser"}\n');
        await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `service_tier = "fast"\nsuppress_unstable_features_warning = true\n\n[features]\nhooks = true\n`);
      }
    });
  } finally {
    for (const key of postinstallEnvKeys) {
      if (postinstallEnvBefore[key] === undefined) delete process.env[key];
      else process.env[key] = postinstallEnvBefore[key];
    }
  }
  const codexLbPostBootstrapAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbPostBootstrapConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbLoginCallsAfterBootstrap = await codexLbLoginCallCount(codexLbHome);
  if (!codexLbPostBootstrapAuth.includes('"auth_mode":"browser"') || codexLbPostBootstrapAuth.includes('sk-test') || codexLbLoginCallsAfterBootstrap !== codexLbLoginCallsBeforeBootstrap) throw new Error('selftest: postinstall drift auth');
  if (!hasTopLevelCodexLbSelected(codexLbPostBootstrapConfig) || !codexLbPostBootstrapConfig.includes('[model_providers.codex-lb]') || !codexLbPostBootstrapConfig.includes('https://lb.example.test/backend-api/codex') || codexLbPostBootstrapConfig.includes('sk-test')) throw new Error('selftest: postinstall drift config');
  if (!codexLbPostBootstrapConfig.includes('requires_openai_auth = true') || !codexLbPostBootstrapConfig.includes('name = "openai"')) throw new Error('selftest: postinstall drift config did not restore current App provider contract');
  const doctorProject = tmpdir();
  await ensureDir(path.join(doctorProject, '.git'));
  await writeTextAtomic(path.join(doctorProject, 'package.json'), '{"name":"codex-lb-doctor-project","version":"0.0.0"}\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-test'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"browser"}\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `service_tier = "fast"\nsuppress_unstable_features_warning = true\n\n[features]\nhooks = true\n`);
  const codexLbDoctorRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'doctor', '--fix', '--json'], {
    cwd: doctorProject,
    env: { ...codexLbEnvForSelftest, SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-doctor-global') },
    timeoutMs: 30000,
    maxOutputBytes: 256 * 1024
  });
  if (codexLbDoctorRepair.code !== 0) throw new Error(`selftest: doctor --fix codex-lb repair exited ${codexLbDoctorRepair.code}: ${codexLbDoctorRepair.stderr}`);
  const codexLbDoctorJson = JSON.parse(codexLbDoctorRepair.stdout);
  const codexLbDoctorAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbDoctorConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (!codexLbDoctorJson.repair?.codex_lb?.ok || !codexLbDoctorJson.repair.codex_lb.config_repaired || !codexLbDoctorJson.codex_lb?.ok || !codexLbDoctorAuth.includes('"auth_mode":"browser"') || codexLbDoctorAuth.includes('sk-test') || !hasTopLevelCodexLbSelected(codexLbDoctorConfig) || !codexLbDoctorConfig.includes('https://lb.example.test/backend-api/codex') || !hasCodexUnstableFeatureWarningSuppression(codexLbDoctorConfig)) throw new Error('selftest: doctor codex-lb');
  if (!codexLbDoctorConfig.includes('requires_openai_auth = true') || !codexLbDoctorConfig.includes('name = "openai"')) throw new Error('selftest: doctor codex-lb did not restore current App provider contract');
  // codex-lb auth: ChatGPT OAuth ↔ codex-lb env_key conflict reconciliation.
  const oauthAuthJson = JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: { id_token: 'oauth-id', access_token: 'oauth-access', refresh_token: 'oauth-refresh' },
    last_refresh: '2026-01-01T00:00:00Z'
  });
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), `${oauthAuthJson}\n`);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-test'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'model_provider = "codex-lb"\n\n[model_providers.codex-lb]\nname = "openai"\nbase_url = "https://lb.example.test/backend-api/codex"\nwire_api = "responses"\nenv_key = "CODEX_LB_API_KEY"\nsupports_websockets = true\nrequires_openai_auth = true\n');
  await fsp.rm(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), { force: true });
  const codexLbReconcileRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'auth', 'repair', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbReconcileRepair.code !== 0) throw new Error(`selftest: codex-lb oauth reconcile repair exited ${codexLbReconcileRepair.code}: ${codexLbReconcileRepair.stderr}`);
  const codexLbReconcileJson = JSON.parse(codexLbReconcileRepair.stdout);
  const codexLbReconcileAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbReconcileBackup = await safeReadText(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'));
  if (codexLbReconcileJson.auth_reconcile?.status !== 'oauth_preserved' || !codexLbReconcileAuth.includes('oauth-id') || !codexLbReconcileAuth.includes('oauth-refresh') || codexLbReconcileAuth.includes('sk-test') || !codexLbReconcileBackup.includes('oauth-id') || !codexLbReconcileBackup.includes('oauth-refresh')) throw new Error('selftest: codex-lb oauth reconcile should preserve ChatGPT OAuth and back it up');
  // Opt-out path: SKS_CODEX_LB_NO_AUTH_RECONCILE=1 keeps auth.json untouched but still backs up the OAuth blob.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), `${oauthAuthJson}\n`);
  await fsp.rm(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), { force: true });
  const codexLbReconcileOptOutRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'auth', 'repair', '--json'], { cwd: tmp, env: { ...codexLbEnvForSelftest, SKS_CODEX_LB_NO_AUTH_RECONCILE: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbReconcileOptOutRepair.code !== 0) throw new Error(`selftest: codex-lb oauth reconcile opt-out repair exited ${codexLbReconcileOptOutRepair.code}: ${codexLbReconcileOptOutRepair.stderr}`);
  const codexLbReconcileOptOutJson = JSON.parse(codexLbReconcileOptOutRepair.stdout);
  const codexLbReconcileOptOutAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbReconcileOptOutBackup = await safeReadText(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'));
  if (codexLbReconcileOptOutJson.auth_reconcile?.status !== 'backup_only' || !codexLbReconcileOptOutAuth.includes('oauth-id') || !codexLbReconcileOptOutBackup.includes('oauth-id')) throw new Error('selftest: codex-lb oauth reconcile opt-out should back up but not rewrite auth.json');
  // Restore path: older SKS versions could leave the codex-lb API key in auth.json. Repair should
  // restore the ChatGPT OAuth backup and clear codex-lb provider selection for coherent routing.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), `${oauthAuthJson}\n`);
  const codexLbReconcileRestoreRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'auth', 'repair', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbReconcileRestoreRepair.code !== 0) throw new Error(`selftest: codex-lb oauth restore repair exited ${codexLbReconcileRestoreRepair.code}: ${codexLbReconcileRestoreRepair.stderr}`);
  const codexLbReconcileRestoreJson = JSON.parse(codexLbReconcileRestoreRepair.stdout);
  const codexLbReconcileRestoreAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbReconcileRestoreConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (codexLbReconcileRestoreJson.auth_reconcile?.status !== 'oauth_restored' || !codexLbReconcileRestoreAuth.includes('oauth-id') || codexLbReconcileRestoreAuth.includes('sk-test') || hasTopLevelCodexLbSelected(codexLbReconcileRestoreConfig) || /sks-codex-lb-managed-openai-base-url/.test(codexLbReconcileRestoreConfig)) throw new Error('selftest: codex-lb oauth restore should replace apikey auth.json with ChatGPT OAuth backup and leave an unselected, unpinned provider state');
  // codex-lb auth: release flow — restore ChatGPT OAuth from backup so the user can return to
  // the official ChatGPT account login. Default deselects model_provider; keeping codex-lb
  // selected with shared OAuth is rejected because it would route OAuth credentials to the LB.
  const codexLbReleaseConfig = 'model_provider = "codex-lb"\n\n[model_providers.codex-lb]\nname = "openai"\nbase_url = "https://lb.example.test/backend-api/codex"\nwire_api = "responses"\nenv_key = "CODEX_LB_API_KEY"\nsupports_websockets = true\nrequires_openai_auth = true\n';
  const codexLbReleaseEnv = "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-test'\n";
  const codexLbReleaseApikeyAuth = '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}\n';
  const codexLbReleaseOauthBackup = `${oauthAuthJson}\n`;
  // Happy path: deselect model_provider and preserve backup file.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbReleaseApikeyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), codexLbReleaseOauthBackup);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), codexLbReleaseEnv);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbReleaseConfig);
  const codexLbReleaseRun = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'release', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbReleaseRun.code !== 0) throw new Error(`selftest: codex-lb release exited ${codexLbReleaseRun.code}: ${codexLbReleaseRun.stderr}`);
  const codexLbReleaseJson = JSON.parse(codexLbReleaseRun.stdout);
  const codexLbReleaseAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbReleaseBackupAfter = await safeReadText(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'));
  const codexLbReleaseConfigAfter = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (codexLbReleaseJson.status !== 'released' || codexLbReleaseJson.provider_unselected !== true || codexLbReleaseJson.backup_removed !== false || !codexLbReleaseAuth.includes('oauth-id') || !codexLbReleaseAuth.includes('oauth-refresh') || codexLbReleaseAuth.includes('apikey') || !codexLbReleaseBackupAfter.includes('oauth-id') || hasTopLevelCodexLbSelected(codexLbReleaseConfigAfter)) throw new Error('selftest: codex-lb release happy path did not restore OAuth, preserve backup, and deselect model_provider');
  // --keep-provider is unsafe with shared OpenAI auth and must fail without changing either file.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbReleaseApikeyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), codexLbReleaseOauthBackup);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbReleaseConfig);
  const codexLbReleaseKeepRun = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'release', '--keep-provider', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const codexLbReleaseKeepJson = JSON.parse(codexLbReleaseKeepRun.stdout);
  const codexLbReleaseKeepConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbReleaseKeepAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (codexLbReleaseKeepRun.code === 0 || codexLbReleaseKeepJson.status !== 'failed' || codexLbReleaseKeepJson.reason !== 'keep_provider_unsafe_with_shared_auth' || !hasTopLevelCodexLbSelected(codexLbReleaseKeepConfig) || !codexLbReleaseKeepAuth.includes('apikey')) throw new Error('selftest: codex-lb release --keep-provider should fail closed without changing the coherent codex-lb state');
  // --delete-backup: restore auth.json and remove the backup file.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbReleaseApikeyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), codexLbReleaseOauthBackup);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbReleaseConfig);
  const codexLbReleaseDeleteRun = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'release', '--delete-backup', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbReleaseDeleteRun.code !== 0) throw new Error(`selftest: codex-lb release --delete-backup exited ${codexLbReleaseDeleteRun.code}: ${codexLbReleaseDeleteRun.stderr}`);
  const codexLbReleaseDeleteJson = JSON.parse(codexLbReleaseDeleteRun.stdout);
  const codexLbReleaseDeleteBackupExists = await exists(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'));
  if (codexLbReleaseDeleteJson.status !== 'released' || codexLbReleaseDeleteJson.backup_removed !== true || codexLbReleaseDeleteBackupExists) throw new Error('selftest: codex-lb release --delete-backup should remove the backup file after restore');
  // No backup: release should refuse and exit 1.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbReleaseApikeyAuth);
  await fsp.rm(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), { force: true });
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbReleaseConfig);
  const codexLbReleaseMissingRun = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'release', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const codexLbReleaseMissingJson = JSON.parse(codexLbReleaseMissingRun.stdout || '{}');
  const codexLbReleaseMissingAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (codexLbReleaseMissingRun.code === 0 || codexLbReleaseMissingJson.status !== 'no_backup' || !codexLbReleaseMissingAuth.includes('apikey')) throw new Error('selftest: codex-lb release with no backup should exit non-zero and report no_backup without touching auth.json');
  // unselect must refuse while the shared auth store still contains the codex-lb key.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbReleaseApikeyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbReleaseConfig);
  const codexLbUnselectRun = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'unselect', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  const codexLbUnselectJson = JSON.parse(codexLbUnselectRun.stdout);
  const codexLbUnselectConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbUnselectAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (codexLbUnselectRun.code === 0 || codexLbUnselectJson.status !== 'failed' || codexLbUnselectJson.reason !== 'shared_codex_lb_auth_active' || !hasTopLevelCodexLbSelected(codexLbUnselectConfig) || !codexLbUnselectAuth.includes('apikey')) throw new Error('selftest: codex-lb unselect should fail closed while shared codex-lb auth is active');
  // Restore the doctor-test auth.json shape so downstream selftest assertions still hold.
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"browser"}\n');
  await fsp.rm(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), { force: true });
  const codexLbContext7Bin = path.join(tmp, 'codex-lb-context7-bin');
  await ensureDir(codexLbContext7Bin);
  await writeTextAtomic(path.join(codexLbContext7Bin, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 99.0.0"; exit 0; fi\nif [ "$CODEX_LB_API_KEY" ]; then echo "context7 leaked CODEX_LB_API_KEY" >&2; exit 77; fi\nif [ "$1" = "mcp" ] && [ "$2" = "list" ]; then echo ""; exit 0; fi\nif [ "$1" = "mcp" ] && [ "$2" = "add" ]; then echo "context7 added"; exit 0; fi\necho "unexpected codex $*" >&2\nexit 2\n');
  await fsp.chmod(path.join(codexLbContext7Bin, 'codex'), 0o755);
  const codexLbContext7Postinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: {
      ...codexLbEnvForSelftest,
      PATH: `${codexLbContext7Bin}${path.delimiter}${process.env.PATH || ''}`,
      CODEX_LB_API_KEY: 'sk-test',
      SKS_POSTINSTALL_NO_BOOTSTRAP: '1',
      SKS_SKIP_POSTINSTALL_SHIM: '1',
      SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
      SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
      SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '1'
    },
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbContext7Postinstall.code !== 0 || String(`${codexLbContext7Postinstall.stdout}\n${codexLbContext7Postinstall.stderr}`).includes('leaked CODEX_LB_API_KEY')) throw new Error('selftest: Context7 key leak');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_API_KEY='unterminated\n");
  const codexLbLoginCallsBeforeMalformed = await codexLbLoginCallCount(codexLbHome);
  const codexLbMalformedPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  const codexLbLoginCallsAfterMalformed = await codexLbLoginCallCount(codexLbHome);
  if (codexLbMalformedPostinstall.code !== 0 || !String(codexLbMalformedPostinstall.stdout || '').includes('codex-lb auth: stored key missing') || codexLbLoginCallsAfterMalformed !== codexLbLoginCallsBeforeMalformed) throw new Error('selftest: bad codex-lb env');
  await fsp.rm(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), { force: true });
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), '[model_providers.codex-lb]\nname = "openai"\nbase_url = "https://lb.example.test/backend-api/codex"\nwire_api = "responses"\nsupports_websockets = true\nrequires_openai_auth = true\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"apikey","key":"sk-legacy"}\n');
  const codexLbLoginCallsBeforeLegacyPostinstall = await codexLbLoginCallCount(codexLbHome);
  const codexLbLegacyPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbLegacyPostinstall.code !== 0) throw new Error(`selftest: legacy codex-lb postinstall restore exited ${codexLbLegacyPostinstall.code}: ${codexLbLegacyPostinstall.stderr}`);
  const codexLbLegacyPostinstallEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbLegacyPostinstallAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbLoginCallsAfterLegacyPostinstall = await codexLbLoginCallCount(codexLbHome);
  if (!String(codexLbLegacyPostinstall.stdout || '').includes('codex-lb auth: restored from existing Codex login cache') || !codexLbLegacyPostinstallEnv.includes("CODEX_LB_API_KEY='sk-legacy'") || !codexLbLegacyPostinstallEnv.includes("CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'") || !codexLbLegacyPostinstallAuth.includes('"auth_mode":"apikey"') || !codexLbLegacyPostinstallAuth.includes('sk-legacy') || codexLbLoginCallsAfterLegacyPostinstall !== codexLbLoginCallsBeforeLegacyPostinstall) throw new Error('selftest: legacy codex-lb postinstall restore');
  await fsp.rm(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), { force: true });
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'model_provider = "codex-lb"\n\n[model_providers.codex-lb]\nname = "openai"\nbase_url = "https://lb.example.test/backend-api/codex"\nwire_api = "responses"\nsupports_websockets = true\nrequires_openai_auth = true\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"apikey","key":"sk-legacy-doctor"}\n');
  const codexLbLegacyDoctorProject = tmpdir();
  await ensureDir(path.join(codexLbLegacyDoctorProject, '.git'));
  await writeTextAtomic(path.join(codexLbLegacyDoctorProject, 'package.json'), '{"name":"codex-lb-legacy-doctor-project","version":"0.0.0"}\n');
  const codexLbLegacyDoctorRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'doctor', '--fix', '--json'], {
    cwd: codexLbLegacyDoctorProject,
    env: { ...codexLbEnvForSelftest, SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-legacy-doctor-global'), SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1' },
    timeoutMs: 30000,
    maxOutputBytes: 256 * 1024
  });
  if (codexLbLegacyDoctorRepair.code !== 0) throw new Error(`selftest: legacy doctor --fix codex-lb restore exited ${codexLbLegacyDoctorRepair.code}: ${codexLbLegacyDoctorRepair.stderr}`);
  const codexLbLegacyDoctorJson = JSON.parse(codexLbLegacyDoctorRepair.stdout);
  const codexLbLegacyDoctorEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbLegacyDoctorConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbLegacyDoctorAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbLegacyDoctorJson.repair?.codex_lb?.ok || !codexLbLegacyDoctorJson.repair.codex_lb.legacy_auth_migrated || !codexLbLegacyDoctorEnv.includes("CODEX_LB_API_KEY='sk-legacy-doctor'") || !codexLbLegacyDoctorAuth.includes('"auth_mode":"apikey"') || !codexLbLegacyDoctorAuth.includes('sk-legacy-doctor') || !hasTopLevelCodexLbSelected(codexLbLegacyDoctorConfig) || !codexLbLegacyDoctorConfig.includes('env_key = "CODEX_LB_API_KEY"')) throw new Error('selftest: legacy doctor codex-lb restore');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"apikey","key":"sk-env-only"}\n');
  const codexLbLoginCallsBeforeEnvOnlyPostinstall = await codexLbLoginCallCount(codexLbHome);
  const codexLbEnvOnlyPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbEnvOnlyPostinstall.code !== 0) throw new Error(`selftest: env-only codex-lb postinstall restore exited ${codexLbEnvOnlyPostinstall.code}: ${codexLbEnvOnlyPostinstall.stderr}`);
  const codexLbEnvOnlyPostinstallEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbEnvOnlyPostinstallConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbEnvOnlyPostinstallAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbLoginCallsAfterEnvOnlyPostinstall = await codexLbLoginCallCount(codexLbHome);
  if (!String(codexLbEnvOnlyPostinstall.stdout || '').includes('codex-lb auth: restored from existing Codex login cache') || !codexLbEnvOnlyPostinstallEnv.includes("CODEX_LB_API_KEY='sk-env-only'") || !codexLbEnvOnlyPostinstallConfig.includes('env_key = "CODEX_LB_API_KEY"') || !hasTopLevelCodexLbSelected(codexLbEnvOnlyPostinstallConfig) || !codexLbEnvOnlyPostinstallAuth.includes('sk-env-only') || codexLbLoginCallsAfterEnvOnlyPostinstall !== codexLbLoginCallsBeforeEnvOnlyPostinstall) throw new Error('selftest: env-only codex-lb postinstall restore');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), '{"auth_mode":"apikey","key":"sk-env-only-doctor"}\n');
  const codexLbEnvOnlyDoctorProject = tmpdir();
  await ensureDir(path.join(codexLbEnvOnlyDoctorProject, '.git'));
  await writeTextAtomic(path.join(codexLbEnvOnlyDoctorProject, 'package.json'), '{"name":"codex-lb-env-only-doctor-project","version":"0.0.0"}\n');
  const codexLbEnvOnlyDoctorRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'doctor', '--fix', '--json'], {
    cwd: codexLbEnvOnlyDoctorProject,
    env: { ...codexLbEnvForSelftest, SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-env-only-doctor-global'), SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1' },
    timeoutMs: 30000,
    maxOutputBytes: 256 * 1024
  });
  if (codexLbEnvOnlyDoctorRepair.code !== 0) throw new Error(`selftest: env-only doctor --fix codex-lb restore exited ${codexLbEnvOnlyDoctorRepair.code}: ${codexLbEnvOnlyDoctorRepair.stderr}`);
  const codexLbEnvOnlyDoctorJson = JSON.parse(codexLbEnvOnlyDoctorRepair.stdout);
  const codexLbEnvOnlyDoctorEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbEnvOnlyDoctorConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbEnvOnlyDoctorAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbEnvOnlyDoctorJson.repair?.codex_lb?.ok || !codexLbEnvOnlyDoctorJson.repair.codex_lb.legacy_auth_migrated || !codexLbEnvOnlyDoctorEnv.includes("CODEX_LB_API_KEY='sk-env-only-doctor'") || !codexLbEnvOnlyDoctorConfig.includes('env_key = "CODEX_LB_API_KEY"') || !hasTopLevelCodexLbSelected(codexLbEnvOnlyDoctorConfig) || !codexLbEnvOnlyDoctorAuth.includes('sk-env-only-doctor')) throw new Error('selftest: env-only doctor codex-lb restore');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_API_KEY='sk-test'\n");
  const codexLbMissingCli = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: {
      HOME: codexLbHome,
      SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-missing-cli-global'),
      PATH: '',
      SKS_POSTINSTALL_NO_BOOTSTRAP: '1',
      SKS_SKIP_POSTINSTALL_SHIM: '1',
      SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
      SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
      SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
      SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '0',
      SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1'
    },
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbMissingCli.code !== 0 || !String(codexLbMissingCli.stdout || '').includes('codex-lb auth: preserved') || String(codexLbMissingCli.stdout || '').includes('codex_missing')) throw new Error('selftest: codex-lb provider auth should not require Codex CLI login');
  const codexLbNotConfiguredHome = path.join(tmp, 'codex-lb-not-configured-home');
  const codexLbNotConfigured = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: {
      HOME: codexLbNotConfiguredHome,
      SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-not-configured-global'),
      PATH: '',
      SKS_POSTINSTALL_NO_BOOTSTRAP: '1',
      SKS_SKIP_POSTINSTALL_SHIM: '1',
      SKS_SKIP_POSTINSTALL_CONTEXT7: '1',
      SKS_SKIP_POSTINSTALL_GETDESIGN: '1',
      SKS_SKIP_POSTINSTALL_GLOBAL_SKILLS: '1',
      SKS_SKIP_POSTINSTALL_CODEX_LB_AUTH: '0'
    },
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (codexLbNotConfigured.code !== 0 || String(codexLbNotConfigured.stdout || '').includes('codex-lb auth:')) throw new Error('selftest: postinstall should stay quiet when codex-lb is not configured');
  const codexLbStatusText = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'status'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (!String(codexLbStatusText.stdout || '').includes('Codex App auth:') || !String(codexLbStatusText.stdout || '').includes('sks codex-lb repair')) throw new Error('selftest: codex-lb status did not advertise App auth state and repair command');
  const nonInteractiveLaunchChainCalls: any[] = [];
  const nonInteractiveLaunch = await maybePromptCodexLbSetupForLaunch([], {
    home: codexLbHome,
    apiKey: 'sk-test',
    codexBin: path.join(codexLbFakeBin, 'codex'),
    syncLaunchEnv: false,
    timeoutMs: 1000,
    fetch: async (url: any, init: any) => {
      nonInteractiveLaunchChainCalls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ id: nonInteractiveLaunchChainCalls.length === 1 ? 'resp_noninteractive_1' : 'resp_noninteractive_2' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  if (!nonInteractiveLaunch.ok || nonInteractiveLaunch.status !== 'present' || nonInteractiveLaunch.chain_health?.status !== 'chain_ok' || nonInteractiveLaunchChainCalls.length !== 2 || nonInteractiveLaunchChainCalls[1].body.previous_response_id !== 'resp_noninteractive_1') throw new Error('selftest: non-interactive codex-lb launch path did not run response-chain preflight');
  const nonInteractiveBrokenLaunch = (await maybePromptCodexLbSetupForLaunch([], {
    home: codexLbHome,
    apiKey: 'sk-test',
    codexBin: path.join(codexLbFakeBin, 'codex'),
    syncLaunchEnv: false,
    timeoutMs: 1000,
    fetch: async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      if (!body.previous_response_id) return new Response(JSON.stringify({ id: 'resp_noninteractive_broken' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', code: 'previous_response_not_found', message: 'Previous response not found.', param: 'previous_response_id' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
  })) as ConfigureCodexLbResult;
  if (nonInteractiveBrokenLaunch.status !== 'present' || nonInteractiveBrokenLaunch.bypass_codex_lb === true || nonInteractiveBrokenLaunch.chain_health?.status !== 'previous_response_not_found') throw new Error('selftest: previous_response_not_found should keep codex-lb active (stateless LB is normal), not silently bypass to ChatGPT OAuth');
  // Hard chain failure (e.g. 500) in non-interactive context should still keep codex-lb by default — the user explicitly configured it, so don't silently swap providers.
  const hardBrokenLaunchCalls: any[] = [];
  const hardBrokenLaunch = (await maybePromptCodexLbSetupForLaunch([], {
    home: codexLbHome,
    apiKey: 'sk-test',
    codexBin: path.join(codexLbFakeBin, 'codex'),
    syncLaunchEnv: false,
    timeoutMs: 1000,
    fetch: async (_url: any, init: any) => {
      hardBrokenLaunchCalls.push({ body: JSON.parse(init.body) });
      if (!hardBrokenLaunchCalls[hardBrokenLaunchCalls.length - 1].body.previous_response_id) return new Response(JSON.stringify({ id: 'resp_hardbroken_first' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ error: { type: 'server_error', code: 'internal_error', message: 'simulated upstream failure' } }), { status: 500, headers: { 'content-type': 'application/json' } });
    }
  })) as ConfigureCodexLbResult;
  if (hardBrokenLaunch.status !== 'present' || hardBrokenLaunch.bypass_codex_lb === true || hardBrokenLaunch.chain_health?.status !== 'second_request_failed') throw new Error('selftest: hard codex-lb chain failure in non-interactive launch should default to keeping codex-lb active, not silently bypass');
  await runCodexLbLaunchChainSelftest({ tmp, codexLbHome, codexLbFakeBin, codexLbConfig });
}
