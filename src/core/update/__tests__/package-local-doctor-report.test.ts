import '../../__tests__/helpers/isolated-test-home.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPackageLocalDoctor } from '../update-migration-state.js';
import { updateNestedProcessEnvironment } from '../../update-check.js';

test('updater suppresses postinstall bootstrap while preserving caller preferences', () => {
  const env = { SKS_POSTINSTALL_BOOTSTRAP: '1', SKS_FAST_MODE: '0', CODEX_HOME: '/custom/codex' };
  const nested = updateNestedProcessEnvironment(env);
  assert.equal(nested.SKS_POSTINSTALL_NO_BOOTSTRAP, '1');
  assert.equal(nested.SKS_FAST_MODE, '0');
  assert.equal(nested.CODEX_HOME, env.CODEX_HOME);
  assert.equal(env.SKS_POSTINSTALL_BOOTSTRAP, '1');
});

test('package-local doctor rejects an old success report when the child emits no fresh report', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-report-'));
  const entrypoint = path.join(root, 'doctor.mjs');
  const report = path.join(root, 'report.json');
  try {
    await fs.writeFile(entrypoint, 'process.exit(0);\n');
    await fs.writeFile(report, JSON.stringify({ ok: true }));
    const result = await runPackageLocalDoctor({ root, entrypoint, args: ['doctor', '--report-file', report], env: { HOME: root }, timeoutMs: 5_000 });
    assert.equal(result.exit_code, 0);
    assert.equal(result.ok, false);
    assert.equal(result.parsed_ok, null);
    await assert.rejects(fs.access(report));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('package-local doctor accepts a fresh child report and rejects a timed-out child', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-fresh-report-'));
  const entrypoint = path.join(root, 'doctor.mjs');
  const report = path.join(root, 'report.json');
  try {
    await fs.writeFile(entrypoint, `import fs from 'node:fs';\nfs.writeFileSync(process.argv.at(-1), JSON.stringify({ ok: true }));\nif (process.env.SKS_REPORT_HANG === '1') setInterval(() => {}, 1000);\n`);
    const args = ['doctor', '--report-file', report];
    const fresh = await runPackageLocalDoctor({ root, entrypoint, args, env: { HOME: root }, timeoutMs: 5_000 });
    assert.equal(fresh.ok, true, fresh.error || 'doctor failed');
    const timeout = await runPackageLocalDoctor({ root, entrypoint, args, env: { HOME: root, SKS_REPORT_HANG: '1' }, timeoutMs: 500 });
    assert.equal(timeout.timed_out, true);
    assert.equal(timeout.ok, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
