import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { loadCodexLbEnv } from '../codex-lb-env.js';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function fixtureHome(apiKey: string | null, metadataKey: string | null): Promise<string> {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-keychain-disabled-'));
  await fsp.mkdir(path.join(home, '.codex'), { recursive: true });
  if (apiKey) {
    await fsp.writeFile(
      path.join(home, '.codex', 'sks-codex-lb.env'),
      'CODEX_LB_BASE_URL=http://127.0.0.1:8787\n' + `CODEX_LB_API_KEY=${apiKey}\n`,
      { mode: 0o600 }
    );
  }
  if (metadataKey) {
    await fsp.writeFile(path.join(home, '.codex', 'sks-codex-lb.json'), JSON.stringify({
      schema: 'sks.codex-lb-metadata.v1',
      base_url: 'http://127.0.0.1:8787/backend-api/codex',
      api_key: { sha256: sha256(metadataKey) }
    }), { mode: 0o600 });
  }
  return home;
}

test('Keychain is skipped when the owner-only env file already holds the metadata-bound key', async (t) => {
  const key = 'sk-clb-canonical';
  const home = await fixtureHome(key, key);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));

  const result = await loadCodexLbEnv({
    forceMacos: true,
    securityBin: '/bin/false',
    home,
    processEnv: {}
  });

  assert.equal(result.keychain.status, 'not_used');
  assert.equal(result.keychain.checked, false);
  assert.equal(result.source, 'env-file');
  assert.equal(result.configured, true);
  assert.equal(result.secret_api_key, key);
  assert.deepEqual(result.source_priority, ['env-file', 'process.env']);
});

test('missing env-file credentials never invoke a generic Keychain reader', async (t) => {
  const home = await fixtureHome(null, null);
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-security-not-invoked-'));
  t.after(async () => {
    await fsp.rm(home, { recursive: true, force: true });
    await fsp.rm(temp, { recursive: true, force: true });
  });
  const invoked = path.join(temp, 'invoked');
  const security = path.join(temp, 'security');
  await fsp.writeFile(
    security,
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(invoked)}\nprintf '%s\\n' 'sk-clb-should-not-load'\n`,
    { mode: 0o755 }
  );

  const result = await loadCodexLbEnv({
    forceMacos: true,
    securityBin: security,
    home,
    processEnv: {}
  });

  assert.equal(result.keychain.status, 'not_used');
  assert.equal(result.keychain.checked, false);
  assert.equal(result.source, 'missing');
  assert.equal(result.configured, false);
  assert.ok(result.missing.includes('CODEX_LB_API_KEY'));
  assert.ok(result.credential_binding.blockers.includes('codex_lb_api_key_missing'));
  assert.match(result.guidance?.[0] || '', /sks codex-lb setup/);
  assert.match(result.guidance?.[0] || '', /export CODEX_LB_API_KEY/);
  t.diagnostic(`missing-key blocker: codex_lb_api_key_missing — ${result.guidance?.[0]}`);
  await assert.rejects(fsp.access(invoked), { code: 'ENOENT' });
});

test('a fresh home without a .codex directory reports only the honest missing-key blocker', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-fresh-home-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));

  const result = await loadCodexLbEnv({ home, processEnv: {} });

  assert.equal(result.configured, false);
  assert.ok(result.blockers?.includes('codex_lb_api_key_missing'));
  assert.ok(!result.missing.includes('CODEX_LB_CREDENTIAL_FILE'));
  assert.ok(!(result.blockers || []).some((blocker) => blocker.startsWith('codex_lb_env_file_')));
});

test('metadata mismatch is blocked instead of falling back to an untrusted Keychain executable', async (t) => {
  const home = await fixtureHome('sk-clb-stale', 'sk-clb-canonical');
  t.after(() => fsp.rm(home, { recursive: true, force: true }));

  const result = await loadCodexLbEnv({
    forceMacos: true,
    securityBin: '/bin/true',
    home,
    processEnv: {}
  });

  assert.equal(result.keychain.status, 'not_used');
  assert.equal(result.configured, false);
  assert.equal(result.secret_api_key, null);
  assert.ok(result.credential_binding.blockers.includes('codex_lb_credential_key_fingerprint_mismatch'));
  assert.ok(!result.credential_binding.blockers.includes('codex_lb_keychain_acl_helper_unavailable'));
});

test('metadata never lets an ambient process key outrank a present env-file key', async (t) => {
  const envFileKey = 'sk-clb-env-file-first';
  const ambientKey = 'sk-clb-ambient-metadata-match';
  const home = await fixtureHome(envFileKey, ambientKey);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));

  const result = await loadCodexLbEnv({
    home,
    processEnv: {
      CODEX_LB_API_KEY: ambientKey,
      CODEX_LB_BASE_URL: 'http://127.0.0.1:8787'
    }
  });

  assert.equal(result.source, 'env-file');
  assert.equal(result.api_key.source, 'env-file');
  assert.equal(result.secret_api_key, null);
  assert.ok(result.credential_binding.blockers.includes('codex_lb_credential_key_fingerprint_mismatch'));
});

test('canonical env file with loose permissions fails closed with chmod guidance', async (t) => {
  const key = 'sk-clb-loose-mode';
  const home = await fixtureHome(key, key);
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.chmod(path.join(home, '.codex', 'sks-codex-lb.env'), 0o644);

  const result = await loadCodexLbEnv({ home, processEnv: {} });

  assert.equal(result.configured, false);
  assert.equal(result.secret_api_key, null);
  assert.ok(result.blockers?.includes('codex_lb_env_file_mode_not_0600'));
  assert.match(result.guidance?.join('\n') || '', /chmod 600/);
  assert.match(result.guidance?.join('\n') || '', /sks doctor --fix/);
});

test('symlinked canonical env file is rejected without following the target', async (t) => {
  const home = await fixtureHome(null, null);
  const external = path.join(home, 'external.env');
  const envPath = path.join(home, '.codex', 'sks-codex-lb.env');
  const content = 'CODEX_LB_BASE_URL=http://127.0.0.1:8787\nCODEX_LB_API_KEY=sk-clb-external\n';
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  await fsp.writeFile(external, content, { mode: 0o600 });
  await fsp.symlink(external, envPath);

  const result = await loadCodexLbEnv({ home, processEnv: {} });

  assert.equal(result.configured, false);
  assert.equal(result.secret_api_key, null);
  assert.ok(result.blockers?.includes('codex_lb_env_file_not_regular'));
  assert.equal(await fsp.readFile(external, 'utf8'), content);
});
