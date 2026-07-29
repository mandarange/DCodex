import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runProcess } from '../../dist/core/fsx.js';

const rawMissingEnvPattern = new RegExp(['Missing environment variable:', '\\s*`?CODEX_LB_API_KEY`?'].join(''), 'i');

test('fresh codex-lb HOME reports setup_needed through structured env loader output', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-env-loader-'));
  const result = await runProcess(process.execPath, ['./dist/bin/sks.js', 'codex-lb', 'status', '--json'], {
    env: { ...process.env, HOME: home, CI: 'true', CODEX_LB_API_KEY: '', CODEX_LB_BASE_URL: '' },
    timeoutMs: 20_000,
    maxOutputBytes: 256 * 1024
  });
  assert.equal(result.code, 1, result.stderr || result.stdout);
  const text = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(text, rawMissingEnvPattern);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schema, 'sks.codex-lb-status.v2');
  assert.equal(json.setup_needed, true);
});

test('loadCodexLbEnv ignores reserved *.example.test process base URLs unless explicitly allowed', async () => {
  const { loadCodexLbEnv } = await import('../../dist/core/codex-lb/codex-lb-env.js');
  const { createHash } = await import('node:crypto');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-codex-lb-env-ignore-'));
  const apiKey = 'sk-clb-fixture-key';
  const sha256 = createHash('sha256').update(apiKey).digest('hex');
  await fs.mkdir(path.join(home, '.codex'), { recursive: true });
  await fs.writeFile(
    path.join(home, '.codex', 'sks-codex-lb.env'),
    `export CODEX_LB_BASE_URL='https://codex.hyper-lab.xyz/backend-api/codex'\nexport CODEX_LB_API_KEY='${apiKey}'\n`
  );
  await fs.writeFile(path.join(home, '.codex', 'sks-codex-lb.json'), JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: 'https://codex.hyper-lab.xyz/backend-api/codex',
    api_key: { sha256 }
  }));

  const polluted = await loadCodexLbEnv({
    home,
    processEnv: {
      CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex',
      CODEX_LB_API_KEY: ''
    }
  });
  assert.equal(polluted.base_url, 'https://codex.hyper-lab.xyz/backend-api/codex');
  assert.equal(polluted.configured, true);
  assert.equal(polluted.credential_binding.status, 'matched');

  const allowed = await loadCodexLbEnv({
    home,
    processEnv: {
      CODEX_LB_BASE_URL: 'https://lb.example.test/backend-api/codex',
      SKS_ALLOW_CODEX_LB_TEST_HOST: '1',
      CODEX_LB_API_KEY: ''
    }
  });
  // Official Center env-file wins over ambient process.env even when test hosts are allowed.
  assert.equal(allowed.base_url, 'https://codex.hyper-lab.xyz/backend-api/codex');
  assert.equal(allowed.configured, true);
  assert.equal(allowed.credential_binding.status, 'matched');
});
