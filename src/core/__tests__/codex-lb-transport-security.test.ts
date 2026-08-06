import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexLbBaseUrlSecurityBlocker,
  loadCodexLbEnv,
  readCodexLbModelCatalog,
  type CodexLbEnvLoadResult
} from '../codex-lb/codex-lb-env.js';

function loaded(baseUrl: string): CodexLbEnvLoadResult {
  return {
    schema: 'sks.codex-lb-env.v1',
    configured: true,
    missing: [],
    source: 'env-file',
    source_priority: ['env-file'],
    base_url: baseUrl,
    api_key: { present: true, usable: true, source: 'env-file', redacted: true, fingerprint: 'fixture' },
    secret_api_key: 'sk-clb-fixture-secret',
    credential_binding: {
      checked: false,
      present: false,
      valid: false,
      status: 'missing',
      metadata_path: '/tmp/sks-codex-lb.json',
      api_key_matches: null,
      base_url_matches: null,
      blockers: []
    },
    env_paths: [],
    keychain: { checked: false, available: false, status: 'not_checked' }
  };
}

test('codex-lb never sends bearer credentials over insecure remote transport', async () => {
  let called = false;
  const result = await readCodexLbModelCatalog({
    loadedEnv: loaded('http://remote.example/backend-api/codex'),
    fetchImpl: (async () => {
      called = true;
      throw new Error('must not fetch');
    }) as typeof fetch
  });

  assert.equal(called, false);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('codex_lb_insecure_base_url'));
  assert.equal(codexLbBaseUrlSecurityBlocker('https://remote.example/backend-api/codex'), null);
  assert.equal(codexLbBaseUrlSecurityBlocker('http://127.0.0.1:8787/backend-api/codex'), null);
  assert.equal(codexLbBaseUrlSecurityBlocker('https://user:pass@remote.example/backend-api/codex'), 'codex_lb_base_url_userinfo_forbidden');
});

test('codex-lb catalog validation rejects private literal and DNS-resolved targets before credentials leave the process', async () => {
  for (const [baseUrl, lookup, blocker] of [
    ['https://10.0.0.7/backend-api/codex', undefined, 'codex_lb_remote_dns_private_address'],
    ['https://[fd00::7]/backend-api/codex', undefined, 'codex_lb_remote_dns_private_address'],
    [
      'https://gateway.example.test/backend-api/codex',
      async () => [{ address: '169.254.169.254', family: 4 as const }],
      'codex_lb_remote_dns_private_address'
    ],
    [
      'http://localhost:8787/backend-api/codex',
      async () => [{ address: '93.184.216.34', family: 4 as const }],
      'codex_lb_remote_dns_rebinding_blocked'
    ]
  ] as const) {
    let called = false;
    const result = await readCodexLbModelCatalog({
      loadedEnv: loaded(baseUrl),
      ...(lookup ? { lookup } : {}),
      fetchImpl: (async () => {
        called = true;
        return new Response(JSON.stringify({ data: [{ id: 'must-not-be-returned' }] }), { status: 200 });
      }) as typeof fetch
    });
    assert.equal(called, false, baseUrl);
    assert.equal(result.ok, false, baseUrl);
    assert.ok(result.blockers.includes(blocker), `${baseUrl}: ${result.blockers.join(',')}`);
  }
});

test('production catalog validation connects to the policy-resolved address without a second fetch resolver', async (t) => {
  let authorization = '';
  const server = createServer((request, response) => {
    authorization = String(request.headers.authorization || '');
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'pinned-model' }] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const result = await readCodexLbModelCatalog({
    loadedEnv: loaded(`http://127.0.0.1:${address.port}/backend-api/codex`)
  });
  assert.equal(result.ok, true, result.blockers.join(','));
  assert.deepEqual(result.models, ['pinned-model']);
  assert.equal(authorization, 'Bearer sk-clb-fixture-secret');
});

test('codex-lb loader suppresses a persisted secret when metadata fingerprint or URL binding drifts', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-binding-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json');
  const apiKey = 'sk-clb-binding-fixture';
  const baseUrl = 'https://bound.example.test/backend-api/codex';
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${baseUrl}'\nexport CODEX_LB_API_KEY='${apiKey}'\n`, { mode: 0o600 });
  await fsp.writeFile(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    api_key: { redacted: true, sha256: createHash('sha256').update(apiKey).digest('hex') }
  })}\n`, { mode: 0o600 });

  const matched = await loadCodexLbEnv({ home, processEnv: {}, securityBin: '/bin/false' });
  assert.equal(matched.configured, true);
  assert.equal(matched.credential_binding.status, 'matched');
  assert.equal(matched.secret_api_key, apiKey);

  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='https://mutated.example.test/backend-api/codex'\nexport CODEX_LB_API_KEY='${apiKey}'\n`, { mode: 0o600 });
  const urlMismatch = await loadCodexLbEnv({ home, processEnv: {}, securityBin: '/bin/false' });
  assert.equal(urlMismatch.configured, false);
  assert.equal(urlMismatch.credential_binding.status, 'base_url_mismatch');
  assert.equal(urlMismatch.secret_api_key, null);
  assert.equal(urlMismatch.base_url, baseUrl);

  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${baseUrl}'\nexport CODEX_LB_API_KEY='sk-clb-different-fixture'\n`, { mode: 0o600 });
  const keyMismatch = await loadCodexLbEnv({ home, processEnv: {}, securityBin: '/bin/false' });
  assert.equal(keyMismatch.configured, false);
  assert.equal(keyMismatch.credential_binding.status, 'api_key_mismatch');
  assert.equal(keyMismatch.secret_api_key, null);
});

test('codex-lb loader binds the explicit HOME credential before an unrelated macOS keychain item', async (t) => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-source-'));
  t.after(() => fsp.rm(home, { recursive: true, force: true }));
  const codexHome = path.join(home, '.codex');
  const envPath = path.join(codexHome, 'sks-codex-lb.env');
  const metadataPath = path.join(codexHome, 'sks-codex-lb.json');
  const securityStub = path.join(home, 'security-stub');
  const apiKey = 'sk-clb-home-fixture';
  const baseUrl = 'https://home-bound.example.test/backend-api/codex';
  await fsp.mkdir(codexHome, { recursive: true });
  await fsp.writeFile(envPath, `export CODEX_LB_BASE_URL='${baseUrl}'\nexport CODEX_LB_API_KEY='${apiKey}'\n`, { mode: 0o600 });
  await fsp.writeFile(securityStub, "#!/bin/sh\nprintf '%s\\n' 'sk-clb-unrelated-keychain-fixture'\n", { mode: 0o700 });

  const withoutMetadata = await loadCodexLbEnv({
    home,
    processEnv: {},
    forceMacos: true,
    securityBin: securityStub
  });
  assert.equal(withoutMetadata.configured, true);
  assert.equal(withoutMetadata.api_key.source, 'env-file');
  assert.equal(withoutMetadata.secret_api_key, apiKey);

  await fsp.writeFile(metadataPath, `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    api_key: { redacted: true, sha256: createHash('sha256').update(apiKey).digest('hex') }
  })}\n`, { mode: 0o600 });
  const withMetadata = await loadCodexLbEnv({
    home,
    processEnv: {},
    forceMacos: true,
    securityBin: securityStub
  });
  assert.equal(withMetadata.configured, true);
  assert.equal(withMetadata.api_key.source, 'env-file');
  assert.equal(withMetadata.credential_binding.status, 'matched');
  assert.equal(withMetadata.secret_api_key, apiKey);
});
