import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { runProcess } from '../../dist/core/fsx.js';

function catalogModel(slug) {
  return { slug, display_name: slug, supported_reasoning_levels: [], shell_type: 'shell_command', visibility: 'list', supported_in_api: true, priority: 1, base_instructions: '', supports_reasoning_summaries: true, support_verbosity: true, truncation_policy: { mode: 'tokens', limit: 10_000 }, supports_parallel_tool_calls: true, experimental_supported_tools: [], service_tiers: ['priority'], tool_mode: 'code_mode_only' };
}

test('codex-lb noninteractive setup configures env loader and metadata', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-it-codex-lb-noninteractive-'));
  const apiKey = 'fixture-key-from-stdin';
  const requests = [];
  const models = [catalogModel('gpt-5.6-luna'), catalogModel('gpt-5.6-terra'), catalogModel('gpt-5.6-sol')];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-app-version': '1.21.0-beta.3' });
      response.end('{"ok":true}');
      return;
    }
    if (request.url === '/backend-api/codex/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ models }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const host = `http://127.0.0.1:${address.port}`;
    const result = await runProcess(process.execPath, [path.resolve('dist/bin/sks.js'), 'codex-lb', 'setup', '--host', host, '--allow-insecure-localhost', '--api-key-stdin', '--yes', '--no-restart-app', '--json'], {
      cwd: home,
      env: { ...process.env, HOME: home, CODEX_HOME: path.join(home, '.codex'), CODEX_LB_API_KEY: '', CODEX_LB_BASE_URL: '', CI: 'true', SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global'), SKS_UPDATE_MIGRATION_GATE_DISABLED: '1', SKS_ALLOW_UNVERIFIED_CODEX_LB_RECOVERY: '', SKS_CODEX_LB_CHAIN_CHECK: '0', SKS_SKIP_CODEX_LB_LAUNCH_ENV: '1' },
      input: `${apiKey}\n`,
      timeoutMs: 20_000,
      maxOutputBytes: 256 * 1024
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(apiKey));
    const json = JSON.parse(result.stdout);
    assert.equal(json.ok, true);
    assert.equal(json.base_url, `${host}/backend-api/codex`);
    assert.equal(json.tool_output_recovery.status, 'compatible');
    assert.equal(json.provider_ready, true);
    assert.equal(json.routing_active, true);
    assert.equal(json.codex_lb.selected, true);
    assert.ok(requests.some((request) => request.url === '/health'));
    assert.ok(requests.some((request) => request.url === '/backend-api/codex/models' && request.authorization === `Bearer ${apiKey}`));
    const metadata = JSON.parse(await fs.readFile(path.join(home, '.codex', 'sks-codex-lb.json'), 'utf8'));
    assert.equal(metadata.api_key.redacted, true);
    assert.ok(metadata.api_key.sha256);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
});
