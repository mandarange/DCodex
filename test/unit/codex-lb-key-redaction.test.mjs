import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runProcess } from '../../dist/core/fsx.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../../dist/core/codex-lb/codex-lb-tool-output-recovery.js';

test('codex-lb setup output redacts API key and writes only metadata fingerprint', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-unit-codex-lb-redaction-'));
  const secret = 'sk-redaction-secret';
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    const result = await runProcess(process.execPath, ['./dist/bin/sks.js', 'codex-lb', 'setup', '--host', baseUrl, '--allow-insecure-localhost', '--api-key-stdin', '--yes', '--json'], {
      input: `${secret}\n`,
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: path.join(home, '.codex'),
        CODEX_LB_API_KEY: secret,
        CODEX_LB_BASE_URL: baseUrl,
        CI: 'true',
        SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
        SKS_CODEX_LB_CHAIN_CHECK: '0',
        SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1'
      },
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.ok(requests.some((request) => request.url === '/health' && request.authorization === undefined));
    const modelRequests = requests.filter((request) => request.url === '/backend-api/codex/models');
    assert.equal(modelRequests.length, 0);
    const metadata = JSON.parse(await fs.readFile(path.join(home, '.codex', 'sks-codex-lb.json'), 'utf8'));
    assert.equal(metadata.api_key.redacted, true);
    assert.ok(metadata.api_key.sha256);
    assert.notEqual(metadata.api_key.sha256, secret);
    assert.doesNotMatch(JSON.stringify(metadata), new RegExp(secret));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});
