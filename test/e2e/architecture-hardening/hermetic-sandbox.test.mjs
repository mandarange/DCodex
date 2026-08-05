import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

const hostileAmbientSecrets = [
  'ambient-lb-secret-must-not-cross',
  'ambient-openrouter-secret-must-not-cross',
  'ambient-openai-secret-must-not-cross',
  'ambient-oauth-secret-must-not-cross',
];

test('Desktop Bridge hermetic matrix confines state and fails closed across provider generations', async () => {
  const { report, stdout } = await runSandbox();
  assert.equal(report.schema, 'sks.desktop-bridge-hermetic-sandbox-report.v1');
  assert.equal(report.ok, true);
  assert.equal(report.isolation.roots_isolated, true);
  assert.equal(report.isolation.ambient_credentials_visible, false);
  assert.equal(report.isolation.user_state_access, 'none_by_construction');
  assert.equal(report.isolation.all_writes_inside_sandbox, true);
  assert.equal(report.bridge_contract.runtime, 'desktop-bridge');
  assert.equal(report.bridge_contract.runtime_count, 1);
  assert.deepEqual(report.bridge_contract.simultaneous_profiles, ['codex-lb', 'openrouter']);
  assert.equal(report.bridge_contract.explicit_route_index, true);
  assert.equal(report.bridge_contract.fallback, 'none');
  assert.equal(report.bridge_contract.pin_affinity, 'passed');
  assert.equal(report.bridge_contract.pin_tamper_fail_closed, 'passed');
  assert.equal(report.bridge_contract.ambient_auth_stripping, 'passed');
  assert.equal(report.bridge_contract.provider_credential_isolation, 'passed');
  assert.equal(report.bridge_contract.restart_generation_recovery, 'passed');
  assert.equal(report.bridge_contract.stale_generation_fail_closed, 'passed');
  assert.equal(report.bridge_contract.state_secret_free, true);
  assert.equal(report.bridge_contract.state_mode, 0o600);
  assert.equal('live' in report, false);
  for (const secret of hostileAmbientSecrets) assert.equal(stdout.includes(secret), false);
  assert.equal(/authorization\s*[:=]\s*bearer\s+\S+/i.test(stdout), false);
});

function runSandbox() {
  return new Promise((resolve, reject) => {
    const script = path.resolve('scripts/architecture-hardening-sandbox/run.mjs');
    const child = spawn(process.execPath, [script], {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH || '/usr/bin:/bin',
        CODEX_LB_API_KEY: hostileAmbientSecrets[0],
        OPENROUTER_API_KEY: hostileAmbientSecrets[1],
        OPENAI_API_KEY: hostileAmbientSecrets[2],
        CODEX_OAUTH_TOKEN: hostileAmbientSecrets[3],
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('desktop_bridge_sandbox_timeout'));
    }, 70_000);
    timeout.unref?.();
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`desktop_bridge_sandbox_failed:${code}:${stderr.trim().slice(0, 800)}`));
        return;
      }
      try { resolve({ report: JSON.parse(stdout), stdout }); }
      catch { reject(new Error('desktop_bridge_sandbox_report_invalid')); }
    });
  });
}
