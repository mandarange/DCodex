import path from 'node:path';
import fsp from 'node:fs/promises';
import { ensureDir, packageRoot, runProcess, writeTextAtomic } from '../core/fsx.js';
import { initProject } from '../core/init.js';
import {
  hasCodexUnstableFeatureWarningSuppression,
  hasDeprecatedCodexHooksFeatureFlag,
  hasTopLevelCodexModeLock
} from './install-tool-helpers.js';
import {
  configureCodexLb,
  maybePromptCodexLbSetupForLaunch
} from './install-helpers.js';
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
  await writeTextAtomic(codexLbFakeCodex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex-cli 99.0.0\"; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo \"logged in with browser auth\"; exit 0; fi\nif [ \"$1\" = \"login\" ] && [ \"$2\" = \"--with-api-key\" ]; then mkdir -p \"$HOME/.codex\"; printf '%s\\n' \"forbidden\" >> \"$HOME/.codex/login-calls.log\"; echo \"codex-lb must not replace shared Codex auth\" >&2; exit 97; fi\necho \"fake codex unsupported\" >&2\nexit 1\n");
  await fsp.chmod(codexLbFakeCodex, 0o755);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `model_reasoning_effort = "low"\nservice_tier = "fast"\nsuppress_unstable_features_warning = true\n\n[profiles.custom]\nmodel_reasoning_effort = "low"\n\n[notice]\nfast_default_opt_out = true\n\n[features]\nhooks = true\n`);
  const codexLbInitialAuth = `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'oauth-id-initial',
      access_token: 'oauth-access-initial',
      refresh_token: 'oauth-refresh-initial'
    }
  }, null, 2)}\n`;
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), codexLbInitialAuth);
  const codexLbEnvForSelftest = {
    HOME: codexLbHome,
    SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-global'),
    PATH: `${codexLbFakeBin}${path.delimiter}${process.env.PATH || ''}`,
    CODEX_LB_API_KEY: '',
    CODEX_LB_BASE_URL: '',
    OPENAI_API_KEY: '',
    SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
    SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '1',
    SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1',
    SKS_CODEX_MODEL: 'selftest-codex-model'
  };
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
  if (
    !codexLbSetupJson.ok
    || codexLbSetupJson.base_url !== 'https://lb.example.test/backend-api/codex'
    || hasTopLevelCodexLbSelected(codexLbConfig)
    || !codexLbConfig.includes('[model_providers.codex-lb]')
    || !codexLbEnv.includes("CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'")
    || !codexLbEnv.includes("CODEX_LB_API_KEY='sk-test'")
    || codexLbSetupJson.codex_environment?.ok !== true
    || codexLbSetupJson.codex_login?.status !== 'not_required'
    || codexLbSetupJson.desktop_auth_mutated !== false
    || codexLbAuth !== codexLbInitialAuth
  ) throw new Error('selftest: codex-lb setup must store an unselected CLI provider without changing ChatGPT OAuth');
  if (!codexLbConfig.includes('requires_openai_auth = false') || !codexLbConfig.includes('name = "codex-lb"')) throw new Error('selftest: codex-lb setup did not write the isolated CLI provider contract');
  const codexLbFailLaunchctl = path.join(codexLbFakeBin, 'launchctl-fail');
  await writeTextAtomic(codexLbFailLaunchctl, '#!/bin/sh\necho "launchctl denied" >&2\nexit 7\n');
  await fsp.chmod(codexLbFailLaunchctl, 0o755);
  const codexLbFailedLaunchEnv = await configureCodexLb({
    home: path.join(tmp, 'codex-lb-launch-fail-home'),
    host: 'lb.example.test',
    apiKey: 'sk-fail',
    forceLaunchEnv: true,
    syncLaunchEnv: true,
    launchctlBin: codexLbFailLaunchctl,
    allowUnverifiedToolOutputRecovery: true
  });
  if (codexLbFailedLaunchEnv.ok || codexLbFailedLaunchEnv.status !== 'launch_env_failed' || !/launchctl denied/.test(codexLbFailedLaunchEnv.error || '')) throw new Error('selftest: codex-lb setup must expose launch-env failure');
  if (!hasCodexUnstableFeatureWarningSuppression(codexLbConfig)) throw new Error('selftest: codex-lb setup did not suppress Codex unstable feature warning');
  await initProject(codexLbHome, {
    installScope: 'global',
    force: true,
    repair: true,
    home: codexLbHome
  });
  const codexLbRepairSetupConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  if (hasTopLevelCodexLbSelected(codexLbRepairSetupConfig) || !codexLbRepairSetupConfig.includes('[model_providers.codex-lb]') || !codexLbRepairSetupConfig.includes('https://lb.example.test/backend-api/codex') || codexLbRepairSetupConfig.includes('sk-test')) throw new Error('selftest: init codex-lb');
  if (!codexLbRepairSetupConfig.includes('requires_openai_auth = false') || !codexLbRepairSetupConfig.includes('name = "codex-lb"')) throw new Error('selftest: init codex-lb did not preserve the isolated CLI provider contract');
  if (!hasCodexUnstableFeatureWarningSuppression(codexLbRepairSetupConfig)) throw new Error('selftest: init codex-lb did not suppress Codex unstable feature warning');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), `${codexLbConfig}\n[mcp_servers.supabase]\nurl = "https://mcp.supabase.com/mcp?project_ref=ref&read_only=true&features=database,docs"\n`);
  const ptmp = path.join(tmp, 'codex-lb-project-config'), prevHome = process.env.HOME;
  try { process.env.HOME = codexLbHome; await initProject(ptmp, { installScope: 'global' }); }
  finally { if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome; }
  const pcfg = await safeReadText(path.join(ptmp, '.codex', 'config.toml'));
  if (hasTopLevelCodexLbSelected(pcfg) || !pcfg.includes('[model_providers.codex-lb]') || !pcfg.includes('[mcp_servers.supabase]') || !pcfg.includes('read_only=true')) throw new Error('selftest: project codex-lb');
  if (!pcfg.includes('requires_openai_auth = false') || !pcfg.includes('name = "codex-lb"')) throw new Error('selftest: project codex-lb did not copy the isolated CLI provider contract');
  if (!hasCodexUnstableFeatureWarningSuppression(pcfg)) throw new Error('selftest: project codex-lb config did not suppress Codex unstable feature warning');
  const browserMarkerAuth = '{"auth_mode":"browser"}\n';
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), browserMarkerAuth);
  const codexLbRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'repair', '--json'], { cwd: tmp, env: codexLbEnvForSelftest, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbRepair.code !== 0) throw new Error(`selftest: codex-lb repair exited ${codexLbRepair.code}: ${codexLbRepair.stderr}`);
  const codexLbRepairJson = JSON.parse(codexLbRepair.stdout);
  const codexLbRepairedAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (
    !codexLbRepairJson.ok
    || !['present_unselected', 'repaired'].includes(String(codexLbRepairJson.status || ''))
    || codexLbRepairJson.codex_lb?.selected === true
    || codexLbRepairJson.codex_environment?.ok !== true
    || codexLbRepairJson.codex_login?.status !== 'not_required'
    || codexLbRepairedAuth !== browserMarkerAuth
  ) {
    throw new Error(`selftest: codex-lb repair must preserve shared Codex auth (${JSON.stringify({
      ok: codexLbRepairJson.ok,
      status: codexLbRepairJson.status,
      environment_ok: codexLbRepairJson.codex_environment?.ok,
      environment_status: codexLbRepairJson.codex_environment?.status,
      login_status: codexLbRepairJson.codex_login?.status,
      globally_selected: codexLbRepairJson.codex_lb?.selected,
      auth_unchanged: codexLbRepairedAuth === browserMarkerAuth
    })})`);
  }
  const codexLbLegacyRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'repair', '--json'], { cwd: tmp, env: { ...codexLbEnvForSelftest, SKS_CODEX_LB_SYNC_CODEX_LOGIN: '1' }, timeoutMs: 15000, maxOutputBytes: 64 * 1024 });
  if (codexLbLegacyRepair.code !== 0) throw new Error(`selftest: codex-lb legacy login repair exited ${codexLbLegacyRepair.code}: ${codexLbLegacyRepair.stderr}`);
  const codexLbLegacyRepairJson = JSON.parse(codexLbLegacyRepair.stdout);
  const codexLbLegacyAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  if (!codexLbLegacyRepairJson.ok || codexLbLegacyRepairJson.codex_login?.status !== 'not_required' || codexLbLegacyAuth !== browserMarkerAuth || await codexLbLoginCallCount(codexLbHome) !== 0) throw new Error('selftest: legacy login-sync environment must not switch Codex auth');
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
  if (!String(codexLbPostinstall.stdout || '').includes('codex-lb auth: preserved but not selected') || codexLbPostinstallAuth !== browserMarkerAuth || codexLbLoginCallsAfterPostinstall !== codexLbLoginCallsBeforePostinstall) throw new Error('selftest: postinstall auth');
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
  if (codexLbPostBootstrapAuth !== browserMarkerAuth || codexLbLoginCallsAfterBootstrap !== codexLbLoginCallsBeforeBootstrap) throw new Error('selftest: postinstall drift auth');
  if (hasTopLevelCodexLbSelected(codexLbPostBootstrapConfig) || !codexLbPostBootstrapConfig.includes('[model_providers.codex-lb]') || !codexLbPostBootstrapConfig.includes('https://lb.example.test/backend-api/codex') || codexLbPostBootstrapConfig.includes('sk-test')) throw new Error('selftest: postinstall drift config');
  if (!codexLbPostBootstrapConfig.includes('requires_openai_auth = false') || !codexLbPostBootstrapConfig.includes('name = "codex-lb"')) throw new Error('selftest: postinstall drift config did not restore the isolated CLI provider contract');
  // Ordinary install/repair must never perform the old OAuth↔LB auth switch. A
  // legacy destructive state is left byte-for-byte intact for the explicit
  // migrate-legacy-desktop transaction.
  const legacyOauthBackup = `${JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      id_token: 'oauth-id-backup',
      access_token: 'oauth-access-backup',
      refresh_token: 'oauth-refresh-backup'
    }
  }, null, 2)}\n`;
  const legacyApiKeyAuth = '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}\n';
  const legacyDesktopConfig = [
    'model_provider = "codex-lb"',
    '# sks-codex-lb-managed-openai-base-url',
    'openai_base_url = "https://lb.example.test/backend-api/codex"',
    '',
    '[model_providers.codex-lb]',
    'name = "OpenAI"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
    'supports_websockets = true',
    'requires_openai_auth = true',
    ''
  ].join('\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), legacyApiKeyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json'), legacyOauthBackup);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), legacyDesktopConfig);
  const legacyRepair = await runProcess(process.execPath, [packagedSksEntrypoint(), 'codex-lb', 'repair', '--json'], {
    cwd: tmp,
    env: codexLbEnvForSelftest,
    timeoutMs: 15000,
    maxOutputBytes: 64 * 1024
  });
  const legacyRepairJson = JSON.parse(legacyRepair.stdout || '{}');
  if (
    (legacyRepair.code !== 0 && legacyRepair.code !== 1)
    || legacyRepairJson.status !== 'legacy_migration_required'
    || legacyRepairJson.codex_login?.status !== 'not_required'
    || await safeReadText(path.join(codexLbHome, '.codex', 'auth.json')) !== legacyApiKeyAuth
    || await safeReadText(path.join(codexLbHome, '.codex', 'auth.chatgpt-backup.json')) !== legacyOauthBackup
    || await safeReadText(path.join(codexLbHome, '.codex', 'config.toml')) !== legacyDesktopConfig
  ) throw new Error('selftest: ordinary repair must leave legacy Desktop auth routing untouched and require explicit migration');
  const legacyPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  if (
    legacyPostinstall.code !== 0
    || !String(legacyPostinstall.stdout || '').includes('legacy Desktop auth routing was left unchanged')
    || await safeReadText(path.join(codexLbHome, '.codex', 'auth.json')) !== legacyApiKeyAuth
    || await safeReadText(path.join(codexLbHome, '.codex', 'config.toml')) !== legacyDesktopConfig
  ) throw new Error('selftest: postinstall must fail closed on legacy Desktop auth routing');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), browserMarkerAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), codexLbConfig);
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
  const codexLbMalformedLines = String(codexLbMalformedPostinstall.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('codex-lb'))
    .slice(-8);
  if (
    codexLbMalformedPostinstall.code !== 0
    || !String(codexLbMalformedPostinstall.stdout || '').includes('codex-lb auth: stored key missing')
    || codexLbLoginCallsAfterMalformed !== codexLbLoginCallsBeforeMalformed
  ) {
    throw new Error(`selftest: bad codex-lb env (${JSON.stringify({
      code: codexLbMalformedPostinstall.code,
      stored_key_missing_reported: String(codexLbMalformedPostinstall.stdout || '').includes('codex-lb auth: stored key missing'),
      login_calls_unchanged: codexLbLoginCallsAfterMalformed === codexLbLoginCallsBeforeMalformed,
      codex_lb_lines: codexLbMalformedLines
    })})`);
  }
  await fsp.rm(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), { force: true });
  const sharedApiKeyOnlyAuth = '{"auth_mode":"apikey","key":"sk-shared-codex-only"}\n';
  const unselectedCliProviderConfig = [
    '[model_providers.codex-lb]',
    'name = "codex-lb"',
    'base_url = "https://lb.example.test/backend-api/codex"',
    'wire_api = "responses"',
    'env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }',
    'supports_websockets = true',
    'requires_openai_auth = false',
    ''
  ].join('\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), unselectedCliProviderConfig);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), sharedApiKeyOnlyAuth);
  const codexLbLoginCallsBeforeLegacyPostinstall = await codexLbLoginCallCount(codexLbHome);
  const codexLbLegacyPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  const codexLbLegacyPostinstallEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbLegacyPostinstallAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbLoginCallsAfterLegacyPostinstall = await codexLbLoginCallCount(codexLbHome);
  if (
    codexLbLegacyPostinstall.code !== 0
    || !String(codexLbLegacyPostinstall.stdout || '').includes('legacy Desktop auth routing was left unchanged')
    || codexLbLegacyPostinstallEnv
    || codexLbLegacyPostinstallAuth !== sharedApiKeyOnlyAuth
    || codexLbLoginCallsAfterLegacyPostinstall !== codexLbLoginCallsBeforeLegacyPostinstall
  ) throw new Error('selftest: postinstall must not infer a gateway credential from shared Codex API-key auth');
  await fsp.rm(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), { force: true });
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), unselectedCliProviderConfig);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), sharedApiKeyOnlyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), sharedApiKeyOnlyAuth);
  const codexLbLoginCallsBeforeEnvOnlyPostinstall = await codexLbLoginCallCount(codexLbHome);
  const codexLbEnvOnlyPostinstall = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: codexLbPostinstallEnv(codexLbEnvForSelftest),
    timeoutMs: 15000,
    maxOutputBytes: 128 * 1024
  });
  const codexLbEnvOnlyPostinstallEnv = await safeReadText(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'));
  const codexLbEnvOnlyPostinstallConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbEnvOnlyPostinstallAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbLoginCallsAfterEnvOnlyPostinstall = await codexLbLoginCallCount(codexLbHome);
  const codexLbEnvOnlyPostinstallLines = String(codexLbEnvOnlyPostinstall.stdout || '')
    .split(/\r?\n/)
    .filter((line) => line.includes('codex-lb'))
    .slice(-8);
  if (
    codexLbEnvOnlyPostinstall.code !== 0
    || !String(codexLbEnvOnlyPostinstall.stdout || '').includes('legacy Desktop auth routing was left unchanged')
    || codexLbEnvOnlyPostinstallEnv !== "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n"
    || hasTopLevelCodexLbSelected(codexLbEnvOnlyPostinstallConfig)
    || (
      codexLbEnvOnlyPostinstallConfig.includes('[model_providers.codex-lb]')
      && (
        !codexLbEnvOnlyPostinstallConfig.includes('name = "codex-lb"')
        || !codexLbEnvOnlyPostinstallConfig.includes('env_http_headers = { "X-Codex-LB-API-Key" = "CODEX_LB_API_KEY" }')
        || !codexLbEnvOnlyPostinstallConfig.includes('requires_openai_auth = false')
      )
    )
    || !codexLbEnvOnlyPostinstallConfig.includes('service_tier = "fast"')
    || codexLbEnvOnlyPostinstallAuth !== sharedApiKeyOnlyAuth
    || codexLbLoginCallsAfterEnvOnlyPostinstall !== codexLbLoginCallsBeforeEnvOnlyPostinstall
  ) {
    throw new Error(`selftest: base-URL-only state must require a separate gateway key (${JSON.stringify({
      code: codexLbEnvOnlyPostinstall.code,
      migration_reported: String(codexLbEnvOnlyPostinstall.stdout || '').includes('legacy Desktop auth routing was left unchanged'),
      env_unchanged: codexLbEnvOnlyPostinstallEnv === "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n",
      config_selected: hasTopLevelCodexLbSelected(codexLbEnvOnlyPostinstallConfig),
      provider_configured: codexLbEnvOnlyPostinstallConfig.includes('[model_providers.codex-lb]'),
      fast_preserved: codexLbEnvOnlyPostinstallConfig.includes('service_tier = "fast"'),
      auth_unchanged: codexLbEnvOnlyPostinstallAuth === sharedApiKeyOnlyAuth,
      login_calls_unchanged: codexLbLoginCallsAfterEnvOnlyPostinstall === codexLbLoginCallsBeforeEnvOnlyPostinstall,
      codex_lb_lines: codexLbEnvOnlyPostinstallLines
    })})`);
  }
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), 'service_tier = "fast"\n');
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), sharedApiKeyOnlyAuth);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'sks-codex-lb.env'), "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='sk-test'\n");
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'config.toml'), unselectedCliProviderConfig);
  await writeTextAtomic(path.join(codexLbHome, '.codex', 'auth.json'), browserMarkerAuth);
  const codexLbLoginCallsBeforeMissingCli = await codexLbLoginCallCount(codexLbHome);
  const codexLbMissingCli = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: {
      HOME: codexLbHome,
      SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-missing-cli-global'),
      PATH: '',
      CODEX_LB_API_KEY: '',
      CODEX_LB_BASE_URL: '',
      OPENAI_API_KEY: '',
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
  const codexLbMissingCliOutput = String(codexLbMissingCli.stdout || '');
  const codexLbMissingCliAuth = await safeReadText(path.join(codexLbHome, '.codex', 'auth.json'));
  const codexLbMissingCliConfig = await safeReadText(path.join(codexLbHome, '.codex', 'config.toml'));
  const codexLbLoginCallsAfterMissingCli = await codexLbLoginCallCount(codexLbHome);
  if (
    codexLbMissingCli.code !== 0
    || codexLbMissingCliOutput.includes('codex_missing')
    || codexLbMissingCliAuth !== browserMarkerAuth
    || codexLbLoginCallsAfterMissingCli !== codexLbLoginCallsBeforeMissingCli
    || hasTopLevelCodexLbSelected(codexLbMissingCliConfig)
  ) {
    throw new Error(`selftest: codex-lb provider auth should not require Codex CLI login (${JSON.stringify({
      code: codexLbMissingCli.code,
      auth_preserved_reported: codexLbMissingCliOutput.includes('codex-lb auth: preserved'),
      codex_missing_reported: codexLbMissingCliOutput.includes('codex_missing'),
      auth_unchanged: codexLbMissingCliAuth === browserMarkerAuth,
      login_calls_unchanged: codexLbLoginCallsAfterMissingCli === codexLbLoginCallsBeforeMissingCli,
      globally_selected: hasTopLevelCodexLbSelected(codexLbMissingCliConfig),
      codex_lb_lines: codexLbMissingCliOutput.split(/\r?\n/).filter((line) => line.includes('codex-lb')).slice(-8)
    })})`);
  }
  const codexLbNotConfiguredHome = path.join(tmp, 'codex-lb-not-configured-home');
  const codexLbNotConfigured = await runProcess(process.execPath, [packagedSksEntrypoint(), 'postinstall'], {
    cwd: tmp,
    env: {
      HOME: codexLbNotConfiguredHome,
      SKS_GLOBAL_ROOT: path.join(tmp, 'codex-lb-not-configured-global'),
      PATH: '',
      CODEX_LB_API_KEY: '',
      CODEX_LB_BASE_URL: '',
      OPENAI_API_KEY: '',
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
  if (!String(codexLbStatusText.stdout || '').includes('ChatGPT OAuth:') || !String(codexLbStatusText.stdout || '').includes('Mode: cli-provider')) throw new Error('selftest: codex-lb status did not separate OAuth identity from CLI routing');
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
  if (!nonInteractiveLaunch.ok || nonInteractiveLaunch.status !== 'continued_to_codex' || nonInteractiveLaunch.chain_health !== undefined || nonInteractiveLaunchChainCalls.length !== 0) throw new Error('selftest: ordinary launch preparation must not run an implicit codex-lb network probe');
  await runCodexLbLaunchChainSelftest({ tmp, codexLbHome, codexLbFakeBin, codexLbConfig });
}
