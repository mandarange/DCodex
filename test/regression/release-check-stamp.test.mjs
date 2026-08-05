import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReleaseStampProof } from '../helpers/release-stamp-proof.mjs';
import { validateReleaseRealSkipProof } from '../../dist/core/release/release-real-contract.js';
import { releaseAuthorizationSnapshot } from '../../dist/core/release/release-authorization-snapshot.js';
import { releaseGateContractSnapshot } from '../../dist/core/release/release-gate-contract.js';
import { currentDistFreshness } from '../../dist/scripts/lib/ensure-dist-fresh.js';

const pkg = JSON.parse(fsSync.readFileSync('package.json', 'utf8'));

function setProofBeforeCurrentBuild(proof) {
  const buildStampMtimeMs = fsSync.statSync(currentDistFreshness().stamp_path).mtimeMs;
  const canonicalTime = new Date(buildStampMtimeMs - 2_000);
  const summaryTime = new Date(buildStampMtimeMs - 1_000);
  fsSync.utimesSync(proof.canonicalProofPath, canonicalTime, canonicalTime);
  fsSync.utimesSync(proof.summaryPath, summaryTime, summaryTime);
  assert.ok(fsSync.statSync(proof.summaryPath).mtimeMs < buildStampMtimeMs);
  assert.ok(fsSync.statSync(proof.canonicalProofPath).mtimeMs <= fsSync.statSync(proof.summaryPath).mtimeMs);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('release stamp fixtures stay in a non-selectable managed fixture subtree', (t) => {
  const proof = createReleaseStampProof();
  t.after(() => proof.cleanup());
  const releaseGateReports = path.resolve('.sneakoscope', 'reports', 'release-gates');
  const relative = path.relative(releaseGateReports, proof.summaryPath).split(path.sep);
  assert.equal(relative[0], '.fixtures');
  assert.equal(relative.at(-1), 'summary.json');
  assert.equal(fsSync.existsSync(path.join(releaseGateReports, '.fixtures', 'summary.json')), false);
  assert.ok(fsSync.existsSync(proof.summaryPath));
});

test('affected or synthetic checks cannot write a publish-authorizing stamp', () => {
  const tmp = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sks-release-stamp-reject-'));
  const stamp = path.join(tmp, 'stamp.json');
  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'write'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SKS_RELEASE_STAMP_PATH: stamp }
  });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /full release proof required/);
  assert.equal(fsSync.existsSync(stamp), false);
});

test('release-check stamp rejects an external artifact-root override against the production stamp', (t) => {
  const proof = createReleaseStampProof();
  const externalRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sks-release-external-proof-'));
  const externalRunDir = path.join(externalRoot, 'release-gates', 'external-run');
  const externalSummary = path.join(externalRunDir, 'summary.json');
  const productionStamp = path.resolve('.sneakoscope', 'reports', 'release-check-stamp.json');
  const productionBefore = fsSync.existsSync(productionStamp) ? fsSync.readFileSync(productionStamp) : null;
  t.after(() => {
    proof.cleanup();
    fsSync.rmSync(externalRoot, { recursive: true, force: true });
    if (productionBefore) fsSync.writeFileSync(productionStamp, productionBefore);
    else fsSync.rmSync(productionStamp, { force: true });
  });
  fsSync.mkdirSync(externalRunDir, { recursive: true });
  const summary = JSON.parse(fsSync.readFileSync(proof.summaryPath, 'utf8'));
  summary.run_id = 'external-run';
  summary.report_dir = externalRunDir;
  fsSync.writeFileSync(externalSummary, `${JSON.stringify(summary, null, 2)}\n`);

  const write = spawnSync(process.execPath, [
    'dist/scripts/release-check-stamp.js',
    'write', '--preset', 'release', '--full',
    '--artifact-root', externalRoot,
    '--summary', externalSummary,
    '--real-summary', proof.realSummaryPath,
    '--canonical-proof', proof.canonicalProofPath
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /release DAG summary is outside the managed report root/);
  const productionAfter = fsSync.existsSync(productionStamp) ? fsSync.readFileSync(productionStamp) : null;
  assert.deepEqual(productionAfter, productionBefore);
});

test('managed fixture DAG evidence cannot write the production release stamp', (t) => {
  const proof = createReleaseStampProof();
  const productionStamp = path.resolve('.sneakoscope', 'reports', 'release-check-stamp.json');
  const productionBefore = fsSync.existsSync(productionStamp) ? fsSync.readFileSync(productionStamp) : null;
  t.after(() => {
    proof.cleanup();
    if (productionBefore) fsSync.writeFileSync(productionStamp, productionBefore);
    else fsSync.rmSync(productionStamp, { force: true });
  });
  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /fixture release DAG evidence requires a stamp inside the same fixture root/);
  const productionAfter = fsSync.existsSync(productionStamp) ? fsSync.readFileSync(productionStamp) : null;
  assert.deepEqual(productionAfter, productionBefore);
});

test('managed fixture DAG evidence cannot write an unrelated external stamp', (t) => {
  const proof = createReleaseStampProof();
  const externalRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sks-release-unrelated-stamp-'));
  const externalStamp = path.join(externalRoot, 'release-check-stamp.json');
  t.after(() => {
    proof.cleanup();
    fsSync.rmSync(externalRoot, { recursive: true, force: true });
  });
  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SKS_RELEASE_STAMP_PATH: externalStamp }
  });
  assert.equal(write.status, 2);
  assert.match(write.stderr, /fixture release DAG evidence requires a stamp inside the same fixture root/);
  assert.equal(fsSync.existsSync(externalStamp), false);
});

test('release-check stamp can be written and verified without rerunning release:check', async () => {
  const proof = createReleaseStampProof();
  const stamp = proof.stampPath;
  const env = { ...process.env, ...proof.env };

  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /Release check stamp written/);

  const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /Release check stamp verified/);

  const parsed = JSON.parse(await fs.readFile(stamp, 'utf8'));
  assert.equal(parsed.schema, 'sks.release-check-stamp.v2');
  assert.equal(parsed.package_name, 'sneakoscope');
  assert.equal(parsed.package_version, pkg.version);
  assert.match(parsed.source_digest, /^[a-f0-9]{64}$/);
  assert.ok(parsed.source_file_count > 0);
  assert.match(parsed.package_files_sha256, /^[a-f0-9]{64}$/);
  assert.ok(parsed.package_file_count > 0);
  assert.match(parsed.release_gate_sha256, /^[a-f0-9]{64}$/);
  assert.match(parsed.dist_build_sha256, /^[a-f0-9]{64}$/);
  assert.ok(parsed.dist_file_count > 0);
  assert.equal(parsed.release_gate_proof.full, true);
  const summary = JSON.parse(await fs.readFile(proof.summaryPath, 'utf8'));
  const expectedGateIds = [...releaseGateContractSnapshot().ids].sort();
  assert.deepEqual([...summary.selected_gate_ids].sort(), expectedGateIds);
  assert.deepEqual([...summary.affected_selection.selected_gate_ids].sort(), expectedGateIds);
  proof.cleanup();
});

test('release-check stamp survives an unchanged rebuild with a newer build-stamp mtime', (t) => {
  const proof = createReleaseStampProof();
  t.after(() => proof.cleanup());
  const env = { ...process.env, ...proof.env };

  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(write.status, 0, write.stderr);

  setProofBeforeCurrentBuild(proof);

  const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(verify.status, 0, verify.stderr);
  assert.match(verify.stdout, /Release check stamp verified/);
});

test('release-check stamp rejects summary authorization drift even when the summary is newer than the build', (t) => {
  const proof = createReleaseStampProof();
  t.after(() => proof.cleanup());
  const env = { ...process.env, ...proof.env };

  const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(write.status, 0, write.stderr);

  const summary = JSON.parse(fsSync.readFileSync(proof.summaryPath, 'utf8'));
  summary.release_authorization_snapshot.dist_build_sha256 = '0'.repeat(64);
  const summaryBytes = Buffer.from(`${JSON.stringify(summary, null, 2)}\n`);
  const summarySha256 = sha256(summaryBytes);
  fsSync.writeFileSync(proof.summaryPath, summaryBytes);

  const real = JSON.parse(fsSync.readFileSync(proof.realSummaryPath, 'utf8'));
  real.skip_release_check_proof.latest_summary_sha256 = summarySha256;
  real.skip_release_check_proof.final_revalidation.latest_summary_sha256 = summarySha256;
  real.release_check.proof = real.skip_release_check_proof;
  const realBytes = Buffer.from(`${JSON.stringify(real, null, 2)}\n`);
  fsSync.writeFileSync(proof.realSummaryPath, realBytes);

  const stamp = JSON.parse(fsSync.readFileSync(proof.stampPath, 'utf8'));
  stamp.release_gate_proof.summary_sha256 = summarySha256;
  stamp.release_gate_proof.real_check_sha256 = sha256(realBytes);
  fsSync.writeFileSync(proof.stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
  const buildStampMtimeMs = fsSync.statSync(currentDistFreshness().stamp_path).mtimeMs;
  assert.ok(fsSync.statSync(proof.summaryPath).mtimeMs > buildStampMtimeMs);

  const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(verify.status, 2, verify.stdout);
  assert.match(verify.stderr, /release_gate_proof:summary_authorization_mismatch:dist_build_sha256/);
  assert.doesNotMatch(verify.stderr, /summary_predates_current_build|summary_hash_mismatch|real_skip_proof_summary_hash_mismatch/);
});

test('release-check stamp write rejects a missing canonical test proof', () => {
  const proof = createReleaseStampProof();
  const original = fsSync.readFileSync(proof.canonicalProofPath);
  try {
    fsSync.rmSync(proof.canonicalProofPath);
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 2);
    assert.match(write.stderr, /canonical test proof is not current|canonical_test_proof_missing/);
  } finally {
    fsSync.writeFileSync(proof.canonicalProofPath, original);
    proof.cleanup();
  }
});

test('release-check stamp verify rejects a changed canonical test proof hash', () => {
  const proof = createReleaseStampProof();
  const original = fsSync.readFileSync(proof.canonicalProofPath);
  try {
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 0, write.stderr);
    const canonical = JSON.parse(original.toString('utf8'));
    const completed = new Date(Date.parse(canonical.completed_at) + 1_000);
    const started = new Date(completed.getTime() - 1);
    canonical.started_at = started.toISOString();
    canonical.completed_at = completed.toISOString();
    canonical.duration_ms = 1;
    fsSync.writeFileSync(proof.canonicalProofPath, `${JSON.stringify(canonical, null, 2)}\n`);
    const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(verify.status, 2);
    assert.match(verify.stderr, /canonical_test_proof_hash_mismatch/);
  } finally {
    fsSync.writeFileSync(proof.canonicalProofPath, original);
    proof.cleanup();
  }
});

test('release-check stamp verify rejects a stale canonical test proof', () => {
  const proof = createReleaseStampProof();
  const original = fsSync.readFileSync(proof.canonicalProofPath);
  try {
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 0, write.stderr);
    const canonical = JSON.parse(original.toString('utf8'));
    canonical.release_authorization_snapshot = {
      ...canonical.release_authorization_snapshot,
      source_digest: '0'.repeat(64)
    };
    fsSync.writeFileSync(proof.canonicalProofPath, `${JSON.stringify(canonical, null, 2)}\n`);
    const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(verify.status, 2);
    assert.match(verify.stderr, /canonical_test_proof_authorization_stale/);
  } finally {
    fsSync.writeFileSync(proof.canonicalProofPath, original);
    proof.cleanup();
  }
});

test('release-check stamp rejects HEAD-only identity drift', async () => {
  const proof = createReleaseStampProof();
  try {
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 0, write.stderr);
    const stamp = JSON.parse(await fs.readFile(proof.stampPath, 'utf8'));
    stamp.git_commit = '0'.repeat(40);
    await fs.writeFile(proof.stampPath, `${JSON.stringify(stamp, null, 2)}\n`);
    const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(verify.status, 2);
    assert.match(verify.stderr, /git_commit/);
  } finally {
    proof.cleanup();
  }
});

test('release-check stamp rejects real proof that is not bound to current source and dist', () => {
  const proof = createReleaseStampProof();
  try {
    const real = JSON.parse(fsSync.readFileSync(proof.realSummaryPath, 'utf8'));
    real.skip_release_check_proof.final_revalidation.source_digest = 'f'.repeat(64);
    real.skip_release_check_proof.final_revalidation.dist_build_sha256 = 'e'.repeat(64);
    real.release_check.proof = real.skip_release_check_proof;
    fsSync.writeFileSync(proof.realSummaryPath, `${JSON.stringify(real, null, 2)}\n`);
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 2);
    assert.match(write.stderr, /real_skip_final_(?:source|dist)_/);
  } finally {
    proof.cleanup();
  }
});

test('DAG-to-real proof rejects same-id release gate command drift in an isolated fixture repo', () => {
  const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sks-release-dag-drift-'));
  const fixturePkg = {
    name: 'release-drift-fixture',
    version: '1.0.0',
    files: ['dist', 'release-gates.v2.json'],
    scripts: { 'release:check': 'node release.js', prepublishOnly: 'node prepublish.js' }
  };
  const manifestPath = path.join(root, 'release-gates.v2.json');
  fsSync.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fsSync.writeFileSync(path.join(root, 'package.json'), JSON.stringify(fixturePkg, null, 2) + '\n');
  fsSync.writeFileSync(path.join(root, 'dist', 'index.js'), 'export const ready = true;\n');
  fsSync.writeFileSync(path.join(root, 'infra-harness-gates.json'), '{"gates":[]}\n');
  fsSync.writeFileSync(manifestPath, JSON.stringify({
    schema: 'sks.release-gates.v2',
    gates: [{ id: 'same:id', command: 'node check-a.js', preset: ['release'] }]
  }, null, 2) + '\n');
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['config', 'user.name', 'Fixture'],
    ['add', '.'],
    ['commit', '-qm', 'fixture']
  ]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
  }

  try {
    const authorizationBefore = releaseAuthorizationSnapshot(root, fixturePkg);
    const summary = {
      schema: 'sks.release-gate-dag-run.v1',
      ok: true,
      run_id: 'fixture-full',
      selected_preset: 'release',
      selected_gates: 1,
      selected_gate_ids: ['same:id'],
      completed: 1,
      failed: 0,
      affected_selection: { mode: 'full' },
      release_authorization_snapshot: authorizationBefore,
      completion_certificate: { confidence: 'full-release-proof', full_release_proof: 'current_run' }
    };
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, 'utf8'));
    manifest.gates[0].command = 'node check-b.js';
    fsSync.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const authorizationAfter = releaseAuthorizationSnapshot(root, fixturePkg);
    const proof = validateReleaseRealSkipProof({
      summary,
      expectedReleaseGateIds: ['same:id'],
      summaryPath: 'summary.json',
      summaryMtimeMs: 2_000,
      summarySha256: 'a'.repeat(64),
      distStamp: { schema: 'sks.dist-build-stamp.v1', source_digest: 'b'.repeat(64), source_file_count: 3 },
      distStampPath: 'dist/.sks-build-stamp.json',
      distStampMtimeMs: 1_000,
      canonicalTestProof: { schema: 'sks.canonical-test-proof.v1', ok: true, release_authorization_snapshot: { ...authorizationAfter } },
      canonicalTestProofPath: '.sneakoscope/reports/canonical-test-proof.json',
      canonicalTestProofSha256: '8'.repeat(64),
      canonicalTestProofMtimeMs: 1_500,
      canonicalTestProofBlockers: [],
      authorizationSnapshot: authorizationAfter,
      currentDistSourceDigest: 'b'.repeat(64),
      currentDistSourceFileCount: 3,
      nowMs: 3_000,
      maxAgeMs: 10_000
    });
    assert.equal(proof.ok, false);
    assert.ok(proof.blockers.includes('release_real_skip_full_summary_authorization_mismatch:release_gate_sha256'));
  } finally {
    fsSync.rmSync(root, { recursive: true, force: true });
  }
});

test('release-check stamp rejects a self-asserted truncated release DAG', () => {
  const proof = createReleaseStampProof();
  try {
    const summary = JSON.parse(fsSync.readFileSync(proof.summaryPath, 'utf8'));
    summary.selected_gate_ids = summary.selected_gate_ids.slice(0, 2);
    summary.selected_gates = 2;
    summary.completed = 2;
    summary.affected_selection.selected_gate_ids = summary.selected_gate_ids;
    fsSync.writeFileSync(proof.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 2);
    assert.match(write.stderr, /selected_gate_ids_not_release_manifest|release_preset_gate_count_mismatch/);
  } finally {
    proof.cleanup();
  }
});

test('release-check stamp rejects a DAG summary whose report_dir does not match its run path', () => {
  const proof = createReleaseStampProof();
  try {
    const summary = JSON.parse(fsSync.readFileSync(proof.summaryPath, 'utf8'));
    summary.report_dir = path.dirname(path.dirname(proof.summaryPath));
    fsSync.writeFileSync(proof.summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 2);
    assert.match(write.stderr, /release_dag_summary_report_dir_identity_mismatch/);
  } finally {
    proof.cleanup();
  }
});

test('release-check stamp rejects an incomplete release-real check list', () => {
  const proof = createReleaseStampProof();
  try {
    const real = JSON.parse(fsSync.readFileSync(proof.realSummaryPath, 'utf8'));
    real.all_checks = real.all_checks.slice(0, 1);
    real.release_authorizing_checks = real.all_checks;
    fsSync.writeFileSync(proof.realSummaryPath, `${JSON.stringify(real, null, 2)}\n`);
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, ...proof.env }
    });
    assert.equal(write.status, 2);
    assert.match(write.stderr, /real_check_ids_not_contract|real_authorizing_check_ids_not_contract/);
  } finally {
    proof.cleanup();
  }
});

test('release-check stamp ensure refreshes a stale publish stamp', async () => {
  const proof = createReleaseStampProof();
  const stamp = proof.stampPath;
  await fs.writeFile(stamp, '{"schema":"stale","package_version":"0.0.0"}\n');
  const env = {
    ...process.env,
    ...proof.env,
    SKS_RELEASE_CHECK_REFRESH_COMMAND: proof.writeCommand
  };

  const ensure = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'ensure'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env
  });
  assert.equal(ensure.status, 0, ensure.stderr);
  assert.match(ensure.stderr, /Release check stamp is not current/);
  assert.match(ensure.stdout, /Release check stamp verified/);

  const parsed = JSON.parse(await fs.readFile(stamp, 'utf8'));
  assert.equal(parsed.schema, 'sks.release-check-stamp.v2');
  assert.equal(parsed.package_version, pkg.version);
  proof.cleanup();
});

test('release-check stamp ignores dist root json files excluded from npm package files', async () => {
  const volatileDistJson = path.join(process.cwd(), 'dist', '__release-check-stamp-volatile-test.json');
  const proof = createReleaseStampProof();
  const env = { ...process.env, ...proof.env };

  await fs.writeFile(volatileDistJson, '{"attempt":1}\n');
  try {
    const write = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', ...proof.writeArgs], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(write.status, 0, write.stderr);

    await fs.writeFile(volatileDistJson, '{"attempt":2}\n');
    const verify = spawnSync(process.execPath, ['dist/scripts/release-check-stamp.js', 'verify'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env
    });
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /Release check stamp verified/);
  } finally {
    await fs.rm(volatileDistJson, { force: true });
    proof.cleanup();
  }
});
