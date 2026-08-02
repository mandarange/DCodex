import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA,
  CODEX_LB_STALE_TWIN_PROVENANCE_MARKER,
  codexLbLegacyKeychainMigrationStampPath,
  inspectDesktopCenterLaunchCredentials,
  inspectCodexLbLegacyKeychainMigration,
  loadOfficialCodexLbCredentials,
  purgeStaleCodexLbCredentialTwins,
  repairCodexLbLegacyKeychainMigration,
  syncDesktopCenterLaunchCredentials,
  verifyCodexLbLegacyKeychainReplacementStore
} from '../desktop-center-credentials.js';

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-creds-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  await fsp.mkdir(codexHome, { recursive: true });
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const key = 'sk-clb-center-official-fixture';
  const base = 'https://lb.example.test/backend-api/codex';
  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${base}'\nexport CODEX_LB_API_KEY='${key}'\n`, { mode: 0o600 });
  await fsp.writeFile(path.join(codexHome, 'sks-codex-lb.json'), `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: base,
    updated_at: new Date().toISOString(),
    source: 'test',
    api_key: { redacted: true, sha256: await sha256(key) }
  }, null, 2)}\n`, { mode: 0o600 });
  return { home, codexHome, envPath, key, base };
}

async function sha256(value: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(value).digest('hex');
}

test('official loader prefers Center store over stale process.env', async (t) => {
  const setup = await fixture(t);
  process.env.CODEX_LB_API_KEY = 'sk-clb-stale-shell-export-should-lose';
  process.env.CODEX_LB_BASE_URL = 'https://stale.example.test/backend-api/codex';
  t.after(() => {
    delete process.env.CODEX_LB_API_KEY;
    delete process.env.CODEX_LB_BASE_URL;
  });
  const loaded = await loadOfficialCodexLbCredentials({ home: setup.home });
  assert.equal(loaded.configured, true);
  assert.equal(loaded.api_key.source, 'env-file');
  assert.equal(loaded.secret_api_key, setup.key);
  assert.equal(loaded.base_url, setup.base);
});

test('purge quarantines only provenance-marked stale twin env files', async (t) => {
  const setup = await fixture(t);
  const twin = path.join(setup.codexHome, 'codex-lb.env');
  const legacy = path.join(setup.codexHome, 'sks.env');
  await fsp.writeFile(twin, `${CODEX_LB_STALE_TWIN_PROVENANCE_MARKER}\nexport CODEX_LB_API_KEY='sk-clb-twin'\n`);
  await fsp.writeFile(legacy, `${CODEX_LB_STALE_TWIN_PROVENANCE_MARKER}\nexport CODEX_LB_API_KEY='sk-clb-legacy'\n`);
  const result = await purgeStaleCodexLbCredentialTwins({ home: setup.home });
  assert.ok(result.removed.some((entry) => entry.endsWith('codex-lb.env')));
  assert.ok(result.removed.some((entry) => entry.endsWith('sks.env')));
  await assert.rejects(fsp.access(twin));
  await assert.rejects(fsp.access(legacy));
  assert.equal(result.quarantined.length, 2);
  for (const entry of result.quarantined) {
    assert.equal(await fsp.access(entry).then(() => true, () => false), true);
    assert.equal((await fsp.stat(entry)).mode & 0o777, 0o600);
  }
  assert.equal(await fsp.access(setup.envPath).then(() => true, () => false), true);
});

test('unprovenanced stale twins are preserved and block cleanup', async (t) => {
  const setup = await fixture(t);
  const twin = path.join(setup.codexHome, 'codex-lb.env');
  await fsp.writeFile(twin, "export CODEX_LB_API_KEY='user-owned-value'\n");

  const result = await purgeStaleCodexLbCredentialTwins({ home: setup.home });

  assert.ok(result.blockers.includes('stale_twin_unprovenanced:codex-lb.env'));
  assert.equal(await fsp.readFile(twin, 'utf8'), "export CODEX_LB_API_KEY='user-owned-value'\n");
});

test('stale twin quarantine restores a concurrent unprovenanced replacement', async (t) => {
  const setup = await fixture(t);
  const twin = path.join(setup.codexHome, 'codex-lb.env');
  const original = `${twin}.original`;
  const concurrent = "export CODEX_LB_API_KEY='user-concurrent-value'\n";
  await fsp.writeFile(twin, `${CODEX_LB_STALE_TWIN_PROVENANCE_MARKER}\nexport CODEX_LB_API_KEY='managed-old-value'\n`);

  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    beforeTwinRename: async ({ target }) => {
      if (target !== twin) return;
      await fsp.rename(target, original);
      await fsp.writeFile(target, concurrent, { mode: 0o640 });
    }
  });

  assert.ok(result.blockers.includes('stale_twin_concurrent_change:codex-lb.env'));
  assert.equal(await fsp.readFile(twin, 'utf8'), concurrent);
  assert.equal((await fsp.stat(twin)).mode & 0o777, 0o640);
  assert.match(await fsp.readFile(original, 'utf8'), /managed-old-value/);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.quarantined, []);
});

test('stale twin quarantine restores a symlink swap without following its target', async (t) => {
  const setup = await fixture(t);
  const twin = path.join(setup.codexHome, 'codex-lb.env');
  const original = `${twin}.original`;
  const external = path.join(setup.home, 'external-user-file');
  await fsp.writeFile(twin, `${CODEX_LB_STALE_TWIN_PROVENANCE_MARKER}\nexport CODEX_LB_API_KEY='managed-old-value'\n`);
  await fsp.writeFile(external, 'external-user-bytes\n', { mode: 0o644 });

  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    beforeTwinRename: async ({ target }) => {
      if (target !== twin) return;
      await fsp.rename(target, original);
      await fsp.symlink(external, target);
    }
  });

  assert.ok(result.blockers.includes('stale_twin_concurrent_change:codex-lb.env'));
  assert.equal((await fsp.lstat(twin)).isSymbolicLink(), true);
  assert.equal(await fsp.readlink(twin), external);
  assert.equal(await fsp.readFile(external, 'utf8'), 'external-user-bytes\n');
  assert.equal((await fsp.stat(external)).mode & 0o777, 0o644);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.quarantined, []);
});

test('launchctl key is set only for selected cli-provider mode and is unset elsewhere', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const priorKey = process.env.CODEX_LB_API_KEY;
  const priorOpenRouterKey = process.env.OPENROUTER_API_KEY;
  process.env.CODEX_LB_API_KEY = 'replacement-key-must-not-reach-child';
  process.env.OPENROUTER_API_KEY = 'openrouter-key-must-not-reach-child';
  t.after(() => {
    if (priorKey === undefined) delete process.env.CODEX_LB_API_KEY;
    else process.env.CODEX_LB_API_KEY = priorKey;
    if (priorOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = priorOpenRouterKey;
  });
  const runProcessImpl = async (_bin: string, args: string[], options: any) => {
    calls.push(args);
    assert.equal(options.envMode, 'replace');
    assert.equal(options.env?.CODEX_LB_API_KEY, undefined);
    assert.equal(options.env?.OPENROUTER_API_KEY, undefined);
    return { code: 0, stdout: '', stderr: '' };
  };
  const synced = await syncDesktopCenterLaunchCredentials({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    skipPurge: true,
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(synced.ok, false);
  assert.equal(synced.status, 'desktop_dual_auth_compat_unavailable');
  assert.equal(synced.launch_env.api_key, 'unset');
  assert.equal(synced.launch_env.base_url, 'unset');
  assert.ok(synced.blockers.includes('desktop_dual_auth_compat_requires_global_secret_environment'));
  assert.ok(!calls.some((args) => args[0] === 'setenv' && args[1] === 'CODEX_LB_API_KEY'));
  assert.ok(!calls.some((args) => args[0] === 'setenv' && args[1] === 'CODEX_LB_BASE_URL'));
  assert.ok(calls.some((args) => args[0] === 'unsetenv' && args[1] === 'OPENROUTER_API_KEY'));

  calls.length = 0;
  const cleared = await syncDesktopCenterLaunchCredentials({
    mode: 'disabled',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    skipPurge: true,
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.launch_env.api_key, 'unset');
  assert.ok(calls.some((args) => args[0] === 'unsetenv' && args[1] === 'CODEX_LB_API_KEY'));
  assert.ok(!calls.some((args) => args[0] === 'setenv' && args[1] === 'CODEX_LB_API_KEY'));

  calls.length = 0;
  const cli = await syncDesktopCenterLaunchCredentials({
    mode: 'cli-provider',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    skipPurge: true,
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(cli.ok, true);
  assert.equal(cli.status, 'cli_provider_launch_credentials_set');
  assert.equal(cli.launch_env.api_key, 'set');
  assert.ok(calls.some((args) => args[0] === 'setenv'
    && args[1] === 'CODEX_LB_API_KEY'
    && args[2] === setup.key));
});

test('launchctl inspection reports only hashes and detects selection drift', async (t) => {
  const setup = await fixture(t);
  const matching = await inspectDesktopCenterLaunchCredentials({
    mode: 'cli-provider',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: async () => ({ code: 0, stdout: `${setup.key}\n`, stderr: '' } as any)
  });
  assert.equal(matching.ok, true);
  assert.equal(matching.expected_api_key_sha256, await sha256(setup.key));
  assert.equal(matching.launch_api_key_sha256, await sha256(setup.key));
  assert.ok(!JSON.stringify(matching).includes(setup.key));

  const stale = await inspectDesktopCenterLaunchCredentials({
    mode: 'desktop-native-bridge',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: async () => ({ code: 0, stdout: 'stale-launch-key\n', stderr: '' } as any)
  });
  assert.equal(stale.ok, false);
  assert.ok(stale.blockers.includes('codex_lb_launchd_key_present_while_unselected'));
  assert.ok(!JSON.stringify(stale).includes('stale-launch-key'));
});

test('cli-provider sync fails explicitly with canonical storage guidance when the key is unavailable', async (t) => {
  const setup = await fixture(t);
  const missing = await loadOfficialCodexLbCredentials({
    home: setup.home,
    loadCodexLbEnvImpl: async () => ({
      schema: 'sks.codex-lb-env.v1',
      configured: false,
      missing: ['CODEX_LB_API_KEY'],
      source: 'missing',
      source_priority: ['env-file', 'keychain', 'process.env'],
      base_url: setup.base,
      api_key: { present: false, usable: false, source: null, redacted: true, fingerprint: null },
      secret_api_key: null,
      credential_binding: {
        checked: false,
        present: false,
        valid: false,
        status: 'missing',
        metadata_path: '',
        api_key_matches: null,
        base_url_matches: null,
        blockers: []
      },
      env_paths: [],
      keychain: { checked: false, available: false, status: 'missing' }
    })
  });
  const result = await syncDesktopCenterLaunchCredentials({
    mode: 'cli-provider',
    home: setup.home,
    loadedEnv: missing,
    force: true,
    skipPurge: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: async () => ({ code: 0, stdout: '', stderr: '' } as any)
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'center_credentials_unavailable');
  assert.ok(result.operator_actions.some((entry) => entry.includes('sks-codex-lb.env')));
  assert.ok(result.operator_actions.some((entry) => entry.includes('sks codex-lb setup')));
  assert.ok(result.operator_actions.some((entry) => entry.includes('CODEX_LB_API_KEY')));
});

test('unexpected stale Keychain cleanup errors surface and do not report deletion', async (t) => {
  const setup = await fixture(t);
  const replacement = await verifyCodexLbLegacyKeychainReplacementStore({
    home: setup.home,
    expectedApiKeySha256: await sha256(setup.key)
  });
  assert.equal(replacement.ok, true);
  assert.ok(replacement.receipt);
  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    legacyKeychainMigrationReceipt: replacement.receipt!,
    runProcessImpl: async () => ({ code: 1, stdout: '', stderr: 'interaction not allowed' } as any)
  });
  assert.deepEqual(result.keychain_cleared, []);
  assert.ok(result.blockers.includes('stale_keychain_cleanup_failed:sks-codex-lb'));
});

test('legacy Keychain item is preserved without an exact verified migration receipt', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return { code: 0, stdout: 'legacy item metadata', stderr: '' } as any;
    }
  });

  assert.deepEqual(result.keychain_cleared, []);
  assert.ok(result.blockers.includes('legacy_keychain_migration_required:sks-codex-lb'));
  assert.ok(calls.some((args) => args[0] === 'find-generic-password' && args.includes('sks-codex-lb')));
  assert.ok(!calls.some((args) => args[0] === 'delete-generic-password'));
});

test('exact verified migration receipt authorizes only the exact legacy Keychain deletion', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const replacement = await verifyCodexLbLegacyKeychainReplacementStore({
    home: setup.home,
    expectedApiKeySha256: await sha256(setup.key)
  });
  assert.equal(replacement.ok, true);
  assert.equal(replacement.receipt?.schema, CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA);
  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    legacyKeychainMigrationReceipt: replacement.receipt!,
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return args[0] === 'delete-generic-password'
        ? { code: 0, stdout: '', stderr: '' } as any
        : { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
    }
  });

  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.keychain_cleared, ['sks-codex-lb']);
  assert.deepEqual(calls, [[
    'delete-generic-password',
    '-a',
    process.env.USER || 'sks',
    '-s',
    'sks-codex-lb'
  ], [
    'find-generic-password',
    '-a',
    process.env.USER || 'sks',
    '-s',
    'sks-codex-lb'
  ]]);
});

test('legacy Keychain deletion is not reported until absence is verified', async (t) => {
  const setup = await fixture(t);
  const replacement = await verifyCodexLbLegacyKeychainReplacementStore({
    home: setup.home,
    expectedApiKeySha256: await sha256(setup.key)
  });
  const result = await purgeStaleCodexLbCredentialTwins({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    legacyKeychainMigrationReceipt: replacement.receipt!,
    runProcessImpl: async () => ({ code: 0, stdout: 'legacy item still present', stderr: '' } as any)
  });

  assert.deepEqual(result.keychain_cleared, []);
  assert.ok(result.blockers.includes('stale_keychain_cleanup_verification_failed:sks-codex-lb'));
});

test('replacement-store verification rejects loose permissions and metadata drift', async (t) => {
  const setup = await fixture(t);
  await fsp.chmod(setup.envPath, 0o640);
  const loose = await verifyCodexLbLegacyKeychainReplacementStore({ home: setup.home });
  assert.equal(loose.ok, false);
  assert.equal(loose.receipt, null);

  await fsp.chmod(setup.envPath, 0o600);
  const metadataPath = path.join(setup.codexHome, 'sks-codex-lb.json');
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  metadata.api_key.sha256 = await sha256('different-key');
  await fsp.writeFile(metadataPath, `${JSON.stringify(metadata)}\n`, { mode: 0o600 });
  const drift = await verifyCodexLbLegacyKeychainReplacementStore({ home: setup.home });
  assert.equal(drift.ok, false);
  assert.ok(drift.blockers.includes('replacement_store_metadata_key_mismatch'));
});

test('deferred legacy Keychain cleanup does not inspect or mutate the legacy item', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const result = await syncDesktopCenterLaunchCredentials({
    mode: 'disabled',
    home: setup.home,
    force: true,
    platform: 'darwin',
    launchctlBin: '/bin/launchctl',
    deferLegacyKeychainCleanup: true,
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '' } as any;
    }
  });

  assert.equal(result.ok, true);
  assert.ok(!calls.some((args) => args.includes('find-generic-password')));
  assert.ok(!calls.some((args) => args.includes('delete-generic-password')));
});

test('normal credential sync is blocked by purge blockers', async (t) => {
  const setup = await fixture(t);
  await fsp.writeFile(path.join(setup.codexHome, 'codex-lb.env'), "export CODEX_LB_API_KEY='user-owned'\n");

  const result = await syncDesktopCenterLaunchCredentials({
    mode: 'disabled',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: async () => ({ code: 0, stdout: '', stderr: '' } as any)
  });

  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('stale_twin_unprovenanced:codex-lb.env'));
});

test('compat cleanup unsets every global credential before returning missing-credential failure', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const missing = await loadOfficialCodexLbCredentials({
    home: setup.home,
    loadCodexLbEnvImpl: async () => ({
      schema: 'sks.codex-lb-env.v1',
      configured: false,
      missing: ['CODEX_LB_API_KEY', 'CODEX_LB_BASE_URL'],
      source: 'missing',
      source_priority: ['env-file', 'keychain', 'process.env'],
      base_url: null,
      api_key: { present: false, usable: false, source: null, redacted: true, fingerprint: null },
      secret_api_key: null,
      credential_binding: {
        checked: false,
        present: false,
        valid: false,
        status: 'missing',
        metadata_path: '',
        api_key_matches: null,
        base_url_matches: null,
        blockers: []
      },
      env_paths: [],
      keychain: { checked: false, available: false, status: 'missing' }
    })
  });

  const result = await syncDesktopCenterLaunchCredentials({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    loadedEnv: missing,
    force: true,
    skipPurge: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return { code: 0, stdout: '', stderr: '' } as any;
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'center_credentials_unavailable');
  for (const key of ['CODEX_LB_API_KEY', 'CODEX_LB_BASE_URL', 'OPENROUTER_API_KEY']) {
    assert.ok(calls.some((args) => args[0] === 'unsetenv' && args[1] === key));
  }
});

test('repair migrates a legacy Keychain-only value once, writes private files, deletes it, and stamps the outcome', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-keychain-transfer-'));
  const codexHome = path.join(home, '.codex');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json');
  const key = 'sk-clb-one-time-transfer-fixture';
  const calls: string[][] = [];
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(codexHome, { recursive: true });

  const runProcessImpl = async (_bin: string, args: string[], options: any) => {
    calls.push([...args]);
    assert.equal(options.envMode, 'replace');
    assert.equal(options.env?.MIGRATION_ENV_SENTINEL, 'preserved');
    assert.equal(options.env?.CODEX_LB_API_KEY, undefined);
    assert.equal(options.env?.OPENROUTER_API_KEY, undefined);
    if (args[0] === 'find-generic-password' && args.includes('-w')) {
      return { code: 0, stdout: `${key}\n`, stderr: '' } as any;
    }
    if (args[0] === 'delete-generic-password') return { code: 0, stdout: '', stderr: '' } as any;
    const deleteAlreadyRan = calls.some((entry) => entry[0] === 'delete-generic-password');
    return deleteAlreadyRan
      ? { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any
      : { code: 0, stdout: 'legacy item attributes only', stderr: '' } as any;
  };
  const migrated = await repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: runProcessImpl as any,
    env: {
      HOME: home,
      USER: 'fixture-user',
      PATH: '/usr/bin:/bin',
      MIGRATION_ENV_SENTINEL: 'preserved',
      CODEX_LB_API_KEY: 'must-not-reach-security',
      OPENROUTER_API_KEY: 'must-not-reach-security'
    }
  });

  assert.equal(migrated.ok, true);
  assert.equal(migrated.status, 'migrated');
  assert.equal(migrated.keychain_deleted, true);
  assert.equal(calls.filter((args) => args[0] === 'find-generic-password' && args.includes('-w')).length, 1);
  assert.ok(calls.some((args) => args[0] === 'delete-generic-password'));
  assert.equal((await fsp.stat(envPath)).mode & 0o777, 0o600);
  assert.equal((await fsp.stat(metadataPath)).mode & 0o777, 0o600);
  assert.match(await fsp.readFile(envPath, 'utf8'), /CODEX_LB_API_KEY='sk-clb-one-time-transfer-fixture'/);
  const metadata = JSON.parse(await fsp.readFile(metadataPath, 'utf8'));
  assert.equal(metadata.api_key.sha256, await sha256(key));
  assert.notEqual(metadata.api_key.preview, key);
  const stampPath = codexLbLegacyKeychainMigrationStampPath(home);
  assert.equal((await fsp.stat(stampPath)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fsp.readFile(stampPath, 'utf8')).outcome, 'migrated');
  assert.ok(!JSON.stringify(migrated).includes(key));

  calls.length = 0;
  const repeated = await repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: runProcessImpl as any,
    env: {
      HOME: home,
      USER: 'fixture-user',
      PATH: '/usr/bin:/bin',
      MIGRATION_ENV_SENTINEL: 'preserved',
      CODEX_LB_API_KEY: 'must-not-reach-security',
      OPENROUTER_API_KEY: 'must-not-reach-security'
    }
  });
  assert.equal(repeated.status, 'already_attempted');
  assert.equal(repeated.stamp_outcome, 'migrated');
  assert.equal(calls.length, 0);
});

test('migration stamp is written before a cancelled value read and prevents another prompt', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-keychain-cancel-'));
  const codexHome = path.join(home, '.codex');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json');
  const calls: string[][] = [];
  let deleted = false;
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(codexHome, { recursive: true });
  const runProcessImpl = async (_bin: string, args: string[]) => {
    calls.push([...args]);
    if (args.includes('-w')) {
      const pending = JSON.parse(await fsp.readFile(codexLbLegacyKeychainMigrationStampPath(home), 'utf8'));
      assert.equal(pending.attempted, true);
      assert.equal(pending.outcome, 'pending');
      return { code: 128, stdout: '', stderr: 'cancelled' } as any;
    }
    if (args[0] === 'delete-generic-password') {
      deleted = true;
      return { code: 0, stdout: '', stderr: '' } as any;
    }
    return deleted
      ? { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any
      : { code: 0, stdout: 'legacy item attributes only', stderr: '' } as any;
  };

  const first = await repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(first.status, 'keychain_read_failed_or_cancelled');
  assert.equal(first.attempted, true);
  assert.equal(JSON.parse(await fsp.readFile(codexLbLegacyKeychainMigrationStampPath(home), 'utf8')).attempted, true);

  calls.length = 0;
  const second = await repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(second.status, 'already_attempted');
  assert.equal(calls.length, 0);

  const configuredKey = 'sk-clb-configured-after-cancel';
  await fsp.writeFile(envPath, "export CODEX_LB_BASE_URL='https://lb.example.test/backend-api/codex'\n"
    + `export CODEX_LB_API_KEY='${configuredKey}'\n`, { mode: 0o600 });
  await fsp.writeFile(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: 'https://lb.example.test/backend-api/codex',
    api_key: { redacted: true, sha256: await sha256(configuredKey) }
  })}\n`, { mode: 0o600 });
  calls.length = 0;
  const cleanup = await repairCodexLbLegacyKeychainMigration({
    home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    expectedApiKeySha256: await sha256(configuredKey),
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(cleanup.status, 'legacy_keychain_removed');
  assert.ok(calls.some((args) => args[0] === 'delete-generic-password'));
  assert.ok(!calls.some((args) => args.includes('-w')));
});

test('valid env key repair verifies and deletes without reading the Keychain value', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const result = await repairCodexLbLegacyKeychainMigration({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    expectedApiKeySha256: await sha256(setup.key),
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return args[0] === 'delete-generic-password'
        ? { code: 0, stdout: '', stderr: '' } as any
        : { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'legacy_keychain_removed');
  assert.ok(calls.some((args) => args[0] === 'delete-generic-password'));
  assert.ok(!calls.some((args) => args.includes('-w')));
});

test('concurrent repairs claim the migration stamp exclusively and invoke one value read', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-keychain-concurrent-'));
  const codexHome = path.join(home, '.codex');
  const calls: string[][] = [];
  let initialProbes = 0;
  let deleted = false;
  let releaseProbes!: () => void;
  const probeGate = new Promise<void>((resolve) => { releaseProbes = resolve; });
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(codexHome, { recursive: true });
  const runProcessImpl = async (_bin: string, args: string[]) => {
    calls.push([...args]);
    if (args.includes('-w')) return { code: 0, stdout: 'sk-clb-concurrent-fixture\n', stderr: '' } as any;
    if (args[0] === 'delete-generic-password') {
      deleted = true;
      return { code: 0, stdout: '', stderr: '' } as any;
    }
    if (!deleted && initialProbes < 2) {
      initialProbes += 1;
      if (initialProbes === 2) releaseProbes();
      await probeGate;
      return { code: 0, stdout: 'legacy item attributes only', stderr: '' } as any;
    }
    return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
  };

  const results = await Promise.all([
    repairCodexLbLegacyKeychainMigration({
      home,
      baseUrl: 'https://lb.example.test/backend-api/codex',
      platform: 'darwin',
      securityBin: '/fixture/security',
      runProcessImpl: runProcessImpl as any
    }),
    repairCodexLbLegacyKeychainMigration({
      home,
      baseUrl: 'https://lb.example.test/backend-api/codex',
      platform: 'darwin',
      securityBin: '/fixture/security',
      runProcessImpl: runProcessImpl as any
    })
  ]);

  assert.equal(calls.filter((args) => args.includes('-w')).length, 1);
  assert.equal(results.filter((entry) => entry.status === 'migrated').length, 1);
  assert.ok(results.some((entry) => entry.status === 'already_attempted'));
});

test('pending stamp is fully written before atomic exclusive publication', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-keychain-atomic-stamp-'));
  const codexHome = path.join(home, '.codex');
  const stampPath = codexLbLegacyKeychainMigrationStampPath(home);
  let deleted = false;
  let markPublishReady!: () => void;
  let continuePublish!: () => void;
  const publishReady = new Promise<void>((resolve) => { markPublishReady = resolve; });
  const publishRelease = new Promise<void>((resolve) => { continuePublish = resolve; });
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(codexHome, { recursive: true });

  const repair = repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: async (_bin, args) => {
      if (args.includes('-w')) return { code: 0, stdout: 'sk-clb-atomic-stamp-fixture\n', stderr: '' } as any;
      if (args[0] === 'delete-generic-password') {
        deleted = true;
        return { code: 0, stdout: '', stderr: '' } as any;
      }
      return deleted
        ? { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any
        : { code: 0, stdout: 'legacy item attributes only', stderr: '' } as any;
    },
    testHooks: {
      beforeStampPublish: async (tempPath) => {
        assert.equal((await fsp.stat(tempPath)).mode & 0o777, 0o600);
        assert.equal(JSON.parse(await fsp.readFile(tempPath, 'utf8')).outcome, 'pending');
        await assert.rejects(fsp.access(stampPath), { code: 'ENOENT' });
        markPublishReady();
        await publishRelease;
      }
    }
  });

  await publishReady;
  await assert.rejects(fsp.access(stampPath), { code: 'ENOENT' });
  continuePublish();
  const result = await repair;
  assert.equal(result.status, 'migrated');
  assert.equal(JSON.parse(await fsp.readFile(stampPath, 'utf8')).outcome, 'migrated');
});

test('a failed final stamp update reports partial migration state without claiming persisted success', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-center-keychain-stamp-failure-'));
  const codexHome = path.join(home, '.codex');
  let deleted = false;
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.mkdir(codexHome, { recursive: true });
  const result = await repairCodexLbLegacyKeychainMigration({
    home,
    baseUrl: 'https://lb.example.test/backend-api/codex',
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: async (_bin, args) => {
      if (args.includes('-w')) return { code: 0, stdout: 'sk-clb-stamp-failure-fixture\n', stderr: '' } as any;
      if (args[0] === 'delete-generic-password') {
        deleted = true;
        return { code: 0, stdout: '', stderr: '' } as any;
      }
      return deleted
        ? { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any
        : { code: 0, stdout: 'legacy item attributes only', stderr: '' } as any;
    },
    testHooks: {
      beforeStampOutcomeWrite: () => { throw new Error('synthetic stamp write failure'); }
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'migration_stamp_outcome_write_failed');
  assert.equal(result.stamp_outcome, 'pending');
  assert.equal(result.keychain_deleted, true);
  assert.equal(JSON.parse(await fsp.readFile(codexLbLegacyKeychainMigrationStampPath(home), 'utf8')).outcome, 'pending');
});

test('inspect is report-only and mode repair tightens a regular owner-matched env file', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  await fsp.chmod(setup.envPath, 0o644);
  const inspected = await inspectCodexLbLegacyKeychainMigration({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
    }
  });
  assert.equal(inspected.status, 'env_file_unsafe');
  assert.equal(calls.length, 0);
  assert.equal((await fsp.stat(setup.envPath)).mode & 0o777, 0o644);

  const repaired = await repairCodexLbLegacyKeychainMigration({
    home: setup.home,
    platform: 'darwin',
    securityBin: '/fixture/security',
    expectedApiKeySha256: await sha256(setup.key),
    runProcessImpl: async (_bin, args) => {
      calls.push([...args]);
      return { code: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' } as any;
    }
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.env_key_valid, true);
  assert.equal((await fsp.stat(setup.envPath)).mode & 0o777, 0o600);
  assert.ok(!calls.some((args) => args.includes('-w')));
});
