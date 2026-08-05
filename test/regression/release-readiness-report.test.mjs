import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createReleaseStampProof } from '../helpers/release-stamp-proof.mjs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

test('release readiness report writes current readiness artifacts', () => {
  const proof = createReleaseStampProof();
  const workspaceStampPath = '.sneakoscope/reports/release-check-stamp.json';
  const workspaceStampBefore = fs.existsSync(workspaceStampPath) ? fs.readFileSync(workspaceStampPath, 'utf8') : null;
  const workspaceReportPath = `.sneakoscope/reports/release-readiness-${pkg.version}.json`;
  const workspaceReportBefore = fs.existsSync(workspaceReportPath) ? fs.readFileSync(workspaceReportPath, 'utf8') : null;
  // Readiness must probe the operator's REAL codex environment (imagegen
  // capability, desktop state), so under the canonical runner's home isolation
  // restore the real home for these read-only probes. SKS_TEST_FORBID_REAL_HOME
  // stays set, so any attempted config write to the real ~/.codex still throws.
  const realHome = process.env.SKS_TEST_REAL_HOME;
  const env = {
    ...process.env,
    ...proof.env,
    ...(realHome ? { HOME: realHome, USERPROFILE: realHome } : {})
  };
  try {
    const stamp = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(stamp.status, 0, `${stamp.stdout}\n${stamp.stderr}`);
    const result = spawnSync(process.execPath, ['dist/scripts/release-readiness-report.js'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const json = JSON.parse(result.stdout);
    assert.equal(json.schema, 'sks.release-readiness.v1');
    assert.equal(json.package.version, pkg.version);
    assert.equal(json.scope.gate, `${pkg.version} current release DAG`);
    assert.match(json.scope.ok_means, new RegExp(`current ${pkg.version.replaceAll('.', '\\.')} release contract`));
    assert.deepEqual(json.remaining_p0_gaps, []);
    assert.equal(json.ok, true);
    assert.equal(json.codex_current.status, 'present');
    assert.equal(json.codex_desktop_capabilities.status, 'present');
    assert.equal(json.voxel_triwiki.status, 'present');
    assert.equal(json.image_ux_review.status, 'present');
    assert.equal(json.ppt_imagegen_review.status, 'present');
    assert.equal(json.dfix.status, 'present');
    assert.equal(json.scope.legacy_report_surfaces_removed, true);
    assert.equal(json.evidence_scope, 'fixture');
    assert.equal(json.stage_dispatch_ready, false);
    assert.equal(json.publish_ready, false);
    assert.ok(json.publish_blockers.includes('release_evidence_scope_is_fixture'));
    assert.equal(json.release_gate_last_pass_stamp.source_digest, JSON.parse(fs.readFileSync(proof.stampPath, 'utf8')).source_digest);
  } finally {
    proof.cleanup();
  }
  const workspaceStampAfter = fs.existsSync(workspaceStampPath) ? fs.readFileSync(workspaceStampPath, 'utf8') : null;
  assert.equal(workspaceStampAfter, workspaceStampBefore, 'release readiness test must preserve the workspace release stamp');
  const workspaceReportAfter = fs.existsSync(workspaceReportPath) ? fs.readFileSync(workspaceReportPath, 'utf8') : null;
  assert.equal(workspaceReportAfter, workspaceReportBefore, 'fixture readiness must preserve the canonical workspace report');
});
