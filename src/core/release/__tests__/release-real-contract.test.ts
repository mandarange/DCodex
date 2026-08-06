import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  buildReleaseRealLiveCoverage,
  dependencyReleaseRealResult,
  normalizeReleaseRealProcessResult,
  RELEASE_REAL_CHECK_IDS,
  RELEASE_REAL_OPTIONAL_CHECK_IDS,
  RELEASE_REAL_REQUIRED_CHECK_IDS,
  releaseDagSummaryIdentityBlockers,
  summarizeReleaseRealPhases,
  validateReleaseRealTaskIds,
  validateReleaseRealSkipProof,
  type ReleaseRealTaskLike,
  type ReleaseRealTaskPolicy
} from '../release-real-contract.js'

const terminal = ['failed', 'blocked', 'skipped', 'integration_optional', 'optional']

test('release-real contract records Desktop Bridge evidence without blocking direct publication', () => {
  assert.equal(RELEASE_REAL_REQUIRED_CHECK_IDS.includes('desktop-bridge:real-evidence'), false)
  assert.ok(RELEASE_REAL_OPTIONAL_CHECK_IDS.includes('desktop-bridge:real-evidence'))
  const missing = validateReleaseRealTaskIds(
    RELEASE_REAL_CHECK_IDS.filter((id) => id !== 'desktop-bridge:real-evidence')
  )
  assert.equal(missing.ok, false)
  assert.ok(missing.missing_ids.includes('desktop-bridge:real-evidence'))
})

test('release DAG summary identity binds run id, directory, and summary path', () => {
  const reportsRoot = path.resolve('/tmp/release-gates')
  const runId = 'rg-2026-07-18T00-00-00-000Z-1'
  const runDir = path.join(reportsRoot, runId)
  const summaryPath = path.join(runDir, 'summary.json')
  assert.deepEqual(releaseDagSummaryIdentityBlockers({ run_id: runId, report_dir: runDir }, summaryPath, reportsRoot), [])
  assert.ok(releaseDagSummaryIdentityBlockers({ run_id: runId, report_dir: reportsRoot }, summaryPath, reportsRoot)
    .includes('release_dag_summary_report_dir_identity_mismatch'))
  assert.ok(releaseDagSummaryIdentityBlockers({ run_id: runId, report_dir: runDir }, path.join(reportsRoot, 'other', 'summary.json'), reportsRoot)
    .includes('release_dag_summary_path_identity_mismatch'))
})

function policy(requirement: ReleaseRealTaskPolicy['requirement'], options: Partial<ReleaseRealTaskPolicy> = {}): ReleaseRealTaskPolicy {
  return {
    requirement,
    expectedSchemas: ['sks.test-result.v1'],
    statusRequired: options.statusRequired ?? false,
    passStatuses: options.passStatuses || [],
    allowedStatuses: options.allowedStatuses || terminal
  }
}

function task(taskPolicy: ReleaseRealTaskPolicy, overrides: Partial<ReleaseRealTaskLike> = {}): ReleaseRealTaskLike {
  return {
    id: overrides.id || 'test:gate',
    script: overrides.script || 'test:gate',
    group: overrides.group || 'environment_required',
    phase: overrides.phase || 'parallel_processing',
    deps: overrides.deps || [],
    command: overrides.command || null,
    policy: taskPolicy
  }
}

function normalize(taskPolicy: ReleaseRealTaskPolicy, input: Partial<Parameters<typeof normalizeReleaseRealProcessResult>[0]> = {}) {
  return normalizeReleaseRealProcessResult({
    task: input.task || task(taskPolicy),
    commandLine: input.commandLine || ['node', 'gate.js'],
    code: input.code === undefined ? 0 : input.code,
    signal: input.signal || null,
    error: input.error || null,
    stdout: input.stdout === undefined ? JSON.stringify({ schema: 'sks.test-result.v1', ok: true }) : input.stdout,
    stderr: input.stderr || '',
    durationMs: input.durationMs || 1,
    attempt: input.attempt || 1
  })
}

test('required JSON-contract checks fail closed instead of trusting exit code', () => {
  const required = policy('release_authorizing')
  const passed = normalize(required, { stdout: `log before\n${JSON.stringify({ schema: 'sks.test-result.v1', ok: true })}\nlog after` })
  assert.equal(passed.outcome, 'passed')
  assert.equal(passed.contract_ok, true)
  assert.equal(passed.ok, true)

  const fixtureNegativeEvidence = normalize(required, {
    stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: true, blockers: [], invalid_fixture: { blockers: ['expected_fixture_failure'] } })
  })
  assert.deepEqual(fixtureNegativeEvidence.blockers, [])

  const parsedFailure = normalize(required, { stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: false }) })
  assert.equal(parsedFailure.process_ok, true)
  assert.equal(parsedFailure.outcome, 'failed')
  assert.equal(parsedFailure.release_blocking, true)
  assert.equal(parsedFailure.ok, false)

  const missing = normalize(required, { stdout: 'plain text success' })
  assert.equal(missing.contract_ok, false)
  assert.equal(missing.ok, false)
  assert.ok(missing.blockers.includes('release_real_json_contract_missing'))
  assert.ok(missing.blockers.includes('release_real_json_schema_missing'))
  assert.ok(missing.blockers.includes('release_real_json_ok_missing'))
})

test('required optional outcome blocks, while declared live-optional coverage remains non-authorizing', () => {
  const required = policy('release_authorizing', {
    statusRequired: true,
    passStatuses: ['proven'],
    allowedStatuses: ['proven', ...terminal]
  })
  const requiredOptional = normalize(required, {
    stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: true, status: 'integration_optional' })
  })
  assert.equal(requiredOptional.outcome, 'optional')
  assert.equal(requiredOptional.ok, false)
  assert.ok(requiredOptional.blockers.includes('release_required_outcome_not_passed:optional'))

  const booleanOptionalMarker = normalize(policy('release_authorizing'), {
    stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: true, integration_optional: true })
  })
  assert.equal(booleanOptionalMarker.parsed_status, 'integration_optional')
  assert.equal(booleanOptionalMarker.ok, false)

  const unknownStatus = normalize(required, {
    stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: true, status: 'mystery_success' })
  })
  assert.equal(unknownStatus.contract_ok, false)
  assert.ok(unknownStatus.blockers.includes('release_real_json_status_unexpected:mystery_success'))

  const liveOptional = policy('live_optional', {
    statusRequired: true,
    passStatuses: ['passed'],
    allowedStatuses: ['passed', ...terminal]
  })
  const skipped = normalize(liveOptional, {
    stdout: JSON.stringify({ schema: 'sks.test-result.v1', ok: true, status: 'skipped', reason: 'credential absent' })
  })
  assert.equal(skipped.outcome, 'skipped')
  assert.equal(skipped.passed, false)
  assert.equal(skipped.required_for_release, false)
  assert.equal(skipped.release_blocking, false)
  assert.equal(skipped.ok, true)

  const malformedOptional = normalize(liveOptional, { stdout: JSON.stringify({ ok: true, status: 'skipped' }) })
  assert.equal(malformedOptional.contract_ok, false)
  assert.equal(malformedOptional.release_blocking, true)
  assert.equal(malformedOptional.ok, false)
})

test('stderr failure envelopes preserve detail.blockers and nested report blockers', () => {
  const required = policy('release_authorizing')
  const stderr = `warning before\n${JSON.stringify({
    ok: false,
    message: 'probe failed',
    detail: {
      schema: 'sks.test-result.v1',
      overall_ok: false,
      blockers: ['interrupt_event_missing'],
      report: { blockers: ['sandbox_preservation_missing'] }
    }
  }, null, 2)}\nwarning after`
  const result = normalize(required, { code: 1, stdout: '', stderr })
  assert.equal(result.parsed_schema, 'sks.test-result.v1')
  assert.equal(result.parsed_ok, false)
  assert.equal(result.contract_ok, true)
  assert.ok(result.blockers.includes('interrupt_event_missing'))
  assert.ok(result.blockers.includes('sandbox_preservation_missing'))
  assert.doesNotMatch(result.blockers.join('\n'), /release_real_process_exit/)
})

test('optional imagegen dependency does not execute downstream optional UX/PPT as a passed result', () => {
  const optionalPolicy = policy('live_optional', {
    statusRequired: true,
    passStatuses: ['passed'],
    allowedStatuses: ['passed', ...terminal]
  })
  const upstream = { id: 'imagegen:real-smoke', outcome: 'skipped' as const, ok: true }
  for (const id of ['ux-review:real-imagegen-smoke', 'ppt:real-imagegen-smoke']) {
    const downstream = dependencyReleaseRealResult(task(optionalPolicy, { id, deps: [upstream.id] }), [upstream])
    assert.equal(downstream.outcome, 'optional')
    assert.equal(downstream.process_ok, null)
    assert.equal(downstream.passed, false)
    assert.equal(downstream.ok, true)
    assert.deepEqual(downstream.dependency_outcomes, [{ id: upstream.id, outcome: 'skipped' }])
    assert.ok(downstream.blockers.includes(`optional_by_dependency:${upstream.id}:skipped`))
  }
})

test('phase pass counts exclude optional ok=true rows and live coverage owns those outcomes', () => {
  const requiredPassed = {
    id: 'required', phase: 'parallel_processing', required_for_release: true,
    requirement: 'release_authorizing', outcome: 'passed', ok: true, duration_ms: 5
  }
  const optionalSkipped = {
    id: 'optional', phase: 'parallel_processing', required_for_release: false,
    requirement: 'live_optional', outcome: 'skipped', ok: true, contract_ok: true,
    process_ok: true, parsed_status: 'skipped', reason: 'not configured', blockers: [], duration_ms: 2
  }
  const phases = summarizeReleaseRealPhases(
    ['design', 'parallel_processing'],
    [requiredPassed, optionalSkipped],
    { id: 'design', phase: 'design', required_for_release: true, outcome: 'passed', ok: true }
  )
  const parallel = phases.at(1)!
  assert.equal(parallel.passed, 1)
  assert.equal(parallel.release_authorizing_passed, 1)
  assert.equal(parallel.outcome_counts.skipped, 1)
  assert.equal(parallel.live_optional_total, 1)
  assert.equal(parallel.live_optional_covered, 0)

  const coverage = buildReleaseRealLiveCoverage([requiredPassed, optionalSkipped])
  assert.equal(coverage.total, 1)
  assert.equal(coverage.skipped, 1)
  assert.equal(coverage.complete, false)
  assert.equal(coverage.excluded_from_release_authorizing_pass_count, true)
})

test('skip proof requires the latest full receipt to postdate a matching current-source build stamp', () => {
  const authorizationSnapshot = {
    git_commit: 'a'.repeat(40),
    source_digest: 'c'.repeat(64),
    source_file_count: 80,
    package_files_sha256: 'e'.repeat(64),
    package_file_count: 60,
    release_gate_sha256: 'f'.repeat(64),
    dist_build_sha256: 'd'.repeat(64),
    dist_file_count: 42
  }
  const base = {
    summary: {
      schema: 'sks.release-gate-dag-run.v1',
      ok: true,
      run_id: 'full-1',
      selected_preset: 'release',
      selected_gates: 3,
      selected_gate_ids: ['gate:a', 'gate:b', 'gate:c'],
      completed: 3,
      failed: 0,
      affected_selection: { mode: 'full' },
      release_authorization_snapshot: { ...authorizationSnapshot },
      completion_certificate: { confidence: 'full-release-proof', full_release_proof: 'current_run' }
    },
    expectedReleaseGateIds: ['gate:a', 'gate:b', 'gate:c'],
    summaryPath: '.sneakoscope/reports/release-gates/full-1/summary.json',
    summaryMtimeMs: 2_000,
    summarySha256: 'a'.repeat(64),
    distStamp: { schema: 'sks.dist-build-stamp.v1', source_digest: 'b'.repeat(64), source_file_count: 9 },
    distStampPath: 'dist/.sks-build-stamp.json',
    distStampMtimeMs: 1_000,
    canonicalTestProof: { schema: 'sks.canonical-test-proof.v1', ok: true, release_authorization_snapshot: { ...authorizationSnapshot } },
    canonicalTestProofPath: '.sneakoscope/reports/canonical-test-proof.json',
    canonicalTestProofSha256: '8'.repeat(64),
    canonicalTestProofMtimeMs: 1_500,
    canonicalTestProofBlockers: [],
    authorizationSnapshot,
    currentDistSourceDigest: 'b'.repeat(64),
    currentDistSourceFileCount: 9,
    nowMs: 3_000,
    maxAgeMs: 10_000
  }
  const valid = validateReleaseRealSkipProof(base)
  assert.equal(valid.ok, true)
  assert.equal(valid.git_commit, base.authorizationSnapshot.git_commit)
  assert.equal(valid.source_digest, base.authorizationSnapshot.source_digest)
  assert.equal(valid.package_files_sha256, base.authorizationSnapshot.package_files_sha256)
  assert.equal(valid.release_gate_sha256, base.authorizationSnapshot.release_gate_sha256)

  const dagGateCommandDrift = validateReleaseRealSkipProof({
    ...base,
    authorizationSnapshot: { ...base.authorizationSnapshot, release_gate_sha256: '9'.repeat(64) }
  })
  assert.equal(dagGateCommandDrift.ok, false)
  assert.ok(dagGateCommandDrift.blockers.includes('release_real_skip_full_summary_authorization_mismatch:release_gate_sha256'))

  const staleDistSource = validateReleaseRealSkipProof({ ...base, currentDistSourceDigest: '7'.repeat(64) })
  assert.equal(staleDistSource.ok, false)
  assert.ok(staleDistSource.blockers.includes('release_real_skip_dist_source_digest_mismatch'))

  const missingDistDigest = validateReleaseRealSkipProof({
    ...base,
    authorizationSnapshot: { ...base.authorizationSnapshot, dist_build_sha256: null }
  })
  assert.equal(missingDistDigest.ok, false)
  assert.ok(missingDistDigest.blockers.includes('release_real_skip_dist_digest_missing'))

  const missingGateDigest = validateReleaseRealSkipProof({
    ...base,
    authorizationSnapshot: { ...base.authorizationSnapshot, release_gate_sha256: '' }
  })
  assert.equal(missingGateDigest.ok, false)
  assert.ok(missingGateDigest.blockers.includes('release_real_skip_release_gate_digest_missing'))

  const predated = validateReleaseRealSkipProof({ ...base, summaryMtimeMs: 500 })
  assert.equal(predated.ok, false)
  assert.ok(predated.blockers.includes('release_real_skip_full_summary_predates_current_build'))
  assert.ok(predated.blockers.includes('release_real_skip_full_summary_predates_canonical_test_proof'))

  const missingCanonical = validateReleaseRealSkipProof({
    ...base,
    canonicalTestProof: null,
    canonicalTestProofPath: null,
    canonicalTestProofSha256: null,
    canonicalTestProofMtimeMs: null
  })
  assert.equal(missingCanonical.ok, false)
  assert.ok(missingCanonical.blockers.includes('release_real_skip_canonical_test_proof_missing'))

  const tamperedCanonical = validateReleaseRealSkipProof({
    ...base,
    canonicalTestProof: { ...base.canonicalTestProof, schema: 'tampered' }
  })
  assert.equal(tamperedCanonical.ok, false)
  assert.ok(tamperedCanonical.blockers.includes('release_real_skip_canonical_test_proof_schema_invalid'))

  const staleCanonical = validateReleaseRealSkipProof({
    ...base,
    canonicalTestProofBlockers: ['canonical_test_proof_authorization_stale']
  })
  assert.equal(staleCanonical.ok, false)
  assert.ok(staleCanonical.blockers.includes('release_real_skip_canonical_test_proof_invalid'))

  const expired = validateReleaseRealSkipProof({ ...base, nowMs: 20_001 })
  assert.equal(expired.ok, false)
  assert.ok(expired.blockers.includes('release_real_skip_full_summary_expired'))

  const truncated = validateReleaseRealSkipProof({ ...base, expectedReleaseGateIds: ['gate:a', 'gate:b', 'gate:c', 'gate:d'] })
  assert.equal(truncated.ok, false)
  assert.ok(truncated.blockers.includes('release_real_skip_full_summary_gate_ids_mismatch'))
})
