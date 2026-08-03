import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { runProcess } from '../../dist/core/fsx.js';
import { createReleaseStampProof } from '../helpers/release-stamp-proof.mjs';

test('black-box release readiness writes no P0 gaps', async () => {
  const proof = createReleaseStampProof();
  const env = { ...process.env, ...proof.env, CI: 'true' };
  try {
    const stamp = await runProcess(process.execPath, ['./dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024
    });
    assert.equal(stamp.code, 0, `${stamp.stdout}\n${stamp.stderr}`);
    const result = await runProcess(process.execPath, ['./dist/scripts/release-readiness-report.js'], {
      env,
      timeoutMs: 90_000,
      maxOutputBytes: 2 * 1024 * 1024
    });
    assert.equal(result.code, 0);
    const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'));
    const json = JSON.parse(await fs.readFile(`${proof.readinessReportDir}/release-readiness-${pkg.version}.json`, 'utf8'));
    assert.equal(json.ok, true);
    assert.deepEqual(json.remaining_p0_gaps, []);
    assert.equal(json.evidence_scope, 'fixture');
    assert.equal(json.publish_ready, false);
  } finally {
    proof.cleanup();
  }
});
