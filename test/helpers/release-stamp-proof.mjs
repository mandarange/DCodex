import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  RELEASE_REAL_CHECK_IDS,
  RELEASE_REAL_OPTIONAL_CHECK_IDS,
  RELEASE_REAL_REQUIRED_CHECK_IDS
} from '../../dist/core/release/release-real-contract.js';
import { releaseAuthorizationSnapshot } from '../../dist/core/release/release-authorization-snapshot.js';
import { releaseGateContractSnapshot } from '../../dist/core/release/release-gate-contract.js';
import { currentDistFreshness } from '../../dist/scripts/lib/ensure-dist-fresh.js';
import {
  CANONICAL_TEST_PROOF_SCHEMA,
  canonicalTestCorpus
} from '../../dist/core/release/canonical-test-proof.js';

export function createReleaseStampProof(root = process.cwd()) {
  const reportsRoot = path.join(root, '.sneakoscope', 'reports');
  const fixtureId = `stamp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const fixtureRoot = path.join(reportsRoot, 'release-gates', '.fixtures', fixtureId);
  const runId = `rg-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(fixtureRoot, runId);
  const summaryPath = path.join(dir, 'summary.json');
  const realSummaryPath = path.join(fixtureRoot, 'release-real-check.json');
  const stampPath = path.join(fixtureRoot, 'release-check-stamp.json');
  const canonicalProofPath = path.join(fixtureRoot, 'canonical-test-proof.json');
  const readinessReportDir = path.join(fixtureRoot, 'readiness');
  const publishAuthReportPath = path.join(fixtureRoot, 'release-publish-auth.json');
  fs.mkdirSync(dir, { recursive: true });
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(root, 'release-gates.v2.json'), 'utf8'));
  const releaseGateIds = [...releaseGateContractSnapshot().ids];
  const freshness = currentDistFreshness();
  const currentPackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const authorizationSnapshot = releaseAuthorizationSnapshot(root, currentPackage);
  const canonicalCorpus = canonicalTestCorpus(root);
  const completedAt = new Date();
  const startedAt = new Date(completedAt.getTime() - 1);
  fs.mkdirSync(path.dirname(canonicalProofPath), { recursive: true });
  fs.writeFileSync(canonicalProofPath, `${JSON.stringify({
    schema: CANONICAL_TEST_PROOF_SCHEMA,
    ok: true,
    package_version: currentPackage.version,
    node_version: process.version,
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: 1,
    ...canonicalCorpus,
    release_authorization_snapshot: authorizationSnapshot
  }, null, 2)}\n`);
  const canonicalProofSha256 = crypto.createHash('sha256').update(fs.readFileSync(canonicalProofPath)).digest('hex');
  const summaryBytes = Buffer.from(`${JSON.stringify({
    schema: 'sks.release-gate-dag-run.v1',
    ok: true,
    run_id: runId,
    report_dir: dir,
    selected_preset: 'release',
    total_gates: releaseManifest.gates.length,
    selected_gates: releaseGateIds.length,
    selected_gate_ids: releaseGateIds,
    completed: releaseGateIds.length,
    failed: 0,
    skipped_by_affected: [],
    affected_selection: { mode: 'full', selected_gate_ids: releaseGateIds, skipped_gate_ids: [] },
    release_authorization_snapshot: authorizationSnapshot,
    completion_certificate: {
      ok: true,
      confidence: 'full-release-proof',
      full_release_proof: 'current_run'
    }
  }, null, 2)}\n`);
  fs.writeFileSync(summaryPath, summaryBytes);
  const summarySha256 = crypto.createHash('sha256').update(summaryBytes).digest('hex');
  const requiredIds = new Set(RELEASE_REAL_REQUIRED_CHECK_IDS);
  const optionalIds = new Set(RELEASE_REAL_OPTIONAL_CHECK_IDS);
  const allChecks = RELEASE_REAL_CHECK_IDS.map((id) => ({
    id,
    ok: true,
    contract_ok: true,
    process_ok: true,
    release_blocking: false,
    required_for_release: requiredIds.has(id),
    requirement: optionalIds.has(id) ? 'live_optional' : 'release_authorizing',
    outcome: 'passed',
    passed: true
  }));
  const revalidation = {
    ok: true,
    run_id: runId,
    latest_summary_sha256: summarySha256,
    ...authorizationSnapshot,
    dist_source_digest: freshness.source_digest,
    dist_source_file_count: freshness.source_file_count,
    dist_stamp_source_digest: freshness.stamp?.source_digest || null,
    canonical_test_proof_path: path.relative(root, canonicalProofPath).split(path.sep).join('/'),
    canonical_test_proof_sha256: canonicalProofSha256,
    blockers: []
  };
  const skipProof = {
    ...revalidation,
    stable_through_real_checks: true,
    final_revalidation: { ...revalidation }
  };
  fs.writeFileSync(realSummaryPath, `${JSON.stringify({
    schema: 'sks.release-real-check.v1',
    generated_at: new Date().toISOString(),
    ok: true,
    task_contract: { ok: true, actual_ids: [...RELEASE_REAL_CHECK_IDS] },
    release_check: {
      id: 'release:check',
      ok: true,
      outcome: 'passed',
      required_for_release: true,
      proof: skipProof
    },
    skip_release_check_proof: skipProof,
    all_checks: allChecks,
    release_authorizing_checks: allChecks.filter((row) => row.required_for_release),
    blockers: [],
    warnings: []
  }, null, 2)}\n`);
  const writeArgs = [
    'write',
    '--preset', 'release',
    '--full',
    '--summary', summaryPath,
    '--real-summary', realSummaryPath,
    '--canonical-proof', canonicalProofPath
  ];
  return {
    summaryPath,
    realSummaryPath,
    stampPath,
    canonicalProofPath,
    readinessReportDir,
    publishAuthReportPath,
    env: {
      SKS_RELEASE_STAMP_PATH: stampPath,
      SKS_RELEASE_READINESS_REPORT_DIR: readinessReportDir,
      SKS_RELEASE_PUBLISH_AUTH_REPORT_PATH: publishAuthReportPath
    },
    writeArgs,
    writeCommand: [JSON.stringify(process.execPath), './dist/scripts/release-check-stamp.js', ...writeArgs.map((value) => JSON.stringify(value))].join(' '),
    cleanup() {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
      try { fs.rmdirSync(path.dirname(fixtureRoot)); } catch {}
    }
  };
}
