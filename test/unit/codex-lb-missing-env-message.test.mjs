import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runProcess } from '../../dist/core/fsx.js';

test('fresh bridge status is structured and never prints raw missing env text', async () => {
  const entry = path.join(process.cwd(), 'dist', 'bin', 'sks.js');
  const result = await runProcess(process.execPath, [entry, 'bridge', 'status', '--json'], {
    env: { ...process.env, HOME: path.join(process.cwd(), '.sneakoscope', 'tmp', 'codex-lb-unit-home'), CI: 'true', CODEX_LB_API_KEY: '', CODEX_LB_BASE_URL: '' },
    timeoutMs: 15_000,
    maxOutputBytes: 128 * 1024
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Missing environment variable/i);
  const json = JSON.parse(result.stdout);
  assert.equal(json.schema, 'sks.desktop-bridge-status.v3');
  assert.equal(json.management.managed, false);
  assert.equal(json.providers['codex-lb'].credential.state, 'not_configured');
  assert.equal(json.readiness.ready, false);
});
