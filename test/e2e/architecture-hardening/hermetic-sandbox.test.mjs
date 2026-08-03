import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

test('architecture hardening sandbox covers the complete mock matrix without ambient credentials', async () => {
  const report = await runSandbox();
  assert.equal(report.ok, true);
  assert.equal(report.isolation.temp_roots_active, true);
  assert.equal(report.isolation.user_state_access, 'none_by_construction');
  assert.equal(report.isolation.all_writes_inside_sandbox, true);
  assert.equal(report.mock_contract.modes.length, 3);
  assert.equal(report.mock_contract.modes.every((mode) => mode.exclusive && mode.session_pinned), true);
  assert.equal(report.mock_contract.credential_withdrawal, 'passed');
  assert.equal(report.mock_contract.four_stage_apply.partial_failure, 'passed');
  assert.equal(report.mock_contract.offline_restart.restart_restored, true);
  assert.equal(report.mock_contract.pause_resume.manual_resume, true);
  assert.equal(report.mock_contract.graph_writer_gate.acquired, true);
  assert.equal(report.mock_contract.mock_servers.every((server) => server.requests > 0), true);
  assert.deepEqual(report.live, { status: 'not_verified', reason: 'secret_injection_required' });
});

function runSandbox() {
  return new Promise((resolve, reject) => {
    const script = path.resolve('scripts/architecture-hardening-sandbox/run.mjs');
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      SKS_ARCHITECTURE_LIVE_APPROVED: '0',
      CODEX_LB_API_KEY: '',
      CODEX_LB_BASE_URL: ''
    };
    const child = spawn(process.execPath, [script], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) return reject(new Error(`sandbox_failed:${stderr.trim()}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error('sandbox_report_invalid')); }
    });
  });
}
