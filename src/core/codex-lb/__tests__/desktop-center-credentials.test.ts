import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadOfficialCodexLbCredentials,
  purgeStaleCodexLbCredentialTwins,
  syncDesktopCenterLaunchCredentials
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

test('purge removes stale twin env files', async (t) => {
  const setup = await fixture(t);
  const twin = path.join(setup.codexHome, 'codex-lb.env');
  const legacy = path.join(setup.codexHome, 'sks.env');
  await fsp.writeFile(twin, "export CODEX_LB_API_KEY='sk-clb-twin'\n");
  await fsp.writeFile(legacy, "export CODEX_LB_API_KEY='sk-clb-legacy'\n");
  const result = await purgeStaleCodexLbCredentialTwins({ home: setup.home });
  assert.ok(result.removed.some((entry) => entry.endsWith('codex-lb.env')));
  assert.ok(result.removed.some((entry) => entry.endsWith('sks.env')));
  await assert.rejects(fsp.access(twin));
  await assert.rejects(fsp.access(legacy));
  assert.equal(await fsp.access(setup.envPath).then(() => true, () => false), true);
});

test('dual-auth compat syncs Center key into launchctl; other modes unset it', async (t) => {
  const setup = await fixture(t);
  const calls: string[][] = [];
  const runProcessImpl = async (_bin: string, args: string[]) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const synced = await syncDesktopCenterLaunchCredentials({
    mode: 'desktop-dual-auth-compat',
    home: setup.home,
    force: true,
    launchctlBin: '/bin/launchctl',
    runProcessImpl: runProcessImpl as any
  });
  assert.equal(synced.ok, true);
  assert.equal(synced.status, 'desktop_compat_launch_env_synced');
  assert.equal(synced.launch_env.api_key, 'set');
  assert.equal(synced.launch_env.base_url, 'set');
  assert.ok(calls.some((args) => args[0] === 'setenv' && args[1] === 'CODEX_LB_API_KEY' && args[2] === setup.key));
  assert.ok(calls.some((args) => args[0] === 'setenv' && args[1] === 'CODEX_LB_BASE_URL' && args[2] === setup.base));
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
});
