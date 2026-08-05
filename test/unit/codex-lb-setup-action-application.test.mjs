import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, exists, readText } from '../../dist/core/fsx.js';
import { CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION } from '../../dist/core/codex-lb/codex-lb-tool-output-recovery.js';

test('codex-lb setup applies selected actions and reports drift-free writes', async () => {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-lb-apply-'));
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/health') {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-app-version': CODEX_LB_TOOL_OUTPUT_RECOVERY_MIN_VERSION
      });
      response.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (request.url === '/backend-api/codex/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"models":[]}');
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
    const result = await runProcess(process.execPath, ['./dist/bin/sks.js', 'codex-lb', 'setup', '--host', baseUrl, '--allow-insecure-localhost', '--api-key-stdin', '--yes', '--no-keychain', '--no-launchctl', '--json'], {
      input: 'sk-clb-test\n',
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CI: 'true', SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_CODEX_LB_CHAIN_CHECK: '0', SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1' },
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024
    });
    const json = JSON.parse(result.stdout);
    const config = await readText(path.join(home, '.codex', 'config.toml'), '');
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.status, 'configured');
    assert.equal(json.mode, 'cli-provider');
    assert.equal(json.identity_plane, 'unchanged');
    assert.equal(json.routing_plane, 'cli_provider');
    assert.equal(json.oauth_preserved, true);
    assert.equal(json.auth_mutated, false);
    assert.equal(json.tool_output_recovery?.status, 'compatible');
    assert.ok(requests.includes('/health'));
    assert.equal(requests.includes('/backend-api/codex/models'), true);
    assert.equal(json.routing_active, true);
    assert.equal(json.routing_truth?.status, 'verified');
    assert.equal(await exists(path.join(home, '.codex', 'sks-codex-lb.env')), true);
    assert.match(config, /# sks-codex-lb-managed-provider-selection\nmodel_provider = "codex-lb"/);
    assert.match(config, /^\s*env_key\s*=\s*"CODEX_LB_API_KEY"$/m);
    assert.doesNotMatch(config, /X-Codex-LB-API-Key/);
    assert.match(config, /^\s*requires_openai_auth\s*=\s*false/m);
    assert.equal(json.tool_catalog?.status, 'not_bound_for_cli_provider');
    assert.deepEqual(json.drift, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fsp.rm(home, { recursive: true, force: true });
  }
});
