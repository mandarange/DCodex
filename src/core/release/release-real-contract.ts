import path from 'node:path'
import {
  RELEASE_AUTHORIZATION_SNAPSHOT_KEYS,
  sameReleaseAuthorizationSnapshot,
  type ReleaseAuthorizationSnapshot
} from './release-authorization-snapshot.js'
import { uniqueValues as unique } from '../text/strings.js'

export const RELEASE_REAL_RESULT_CONTRACT_SCHEMA = 'sks.release-real-result-contract.v1'
export const RELEASE_REAL_LIVE_COVERAGE_SCHEMA = 'sks.release-real-live-coverage.v1'
export const RELEASE_REAL_SKIP_PROOF_SCHEMA = 'sks.release-real-skip-proof.v1'
export const RELEASE_REAL_REQUIRED_CHECK_IDS = Object.freeze([
  'codex:actual-config-load-probe',
  'codex:0144-core-real-probes:require-real',
  'codex:0144:app-server-v2:real',
  'codex:0144:capability:real',
  'doctor:actual',
  'release:pack-receipt',
  'naruto:worktree-coding:blackbox',
  'codex-sdk:real-smoke'
])
export const RELEASE_REAL_OPTIONAL_CHECK_IDS = Object.freeze([
  'codex-lb:desktop-real-evidence',
  'imagegen:real-smoke',
  'ux-review:real-imagegen-smoke',
  'ppt:real-imagegen-smoke'
])
export const RELEASE_REAL_CHECK_IDS = Object.freeze([
  ...RELEASE_REAL_REQUIRED_CHECK_IDS,
  ...RELEASE_REAL_OPTIONAL_CHECK_IDS
])

export function releaseDagSummaryIdentityBlockers(summary: any, summaryPath: string, releaseGateReportsRoot: string): string[] {
  const blockers: string[] = []
  const runId = String(summary?.run_id || '')
  const reportsRoot = path.resolve(releaseGateReportsRoot)
  const expectedRunDir = path.resolve(reportsRoot, runId)
  const expectedSummaryPath = path.join(expectedRunDir, 'summary.json')
  if (!runId) blockers.push('release_dag_summary_run_id_missing')
  if (runId && !/^rg-\d{4}-/.test(runId)) blockers.push('release_dag_summary_run_id_prefix_invalid')
  if (runId && path.basename(expectedRunDir) !== runId) blockers.push('release_dag_summary_run_id_path_invalid')
  if (path.resolve(summaryPath) !== expectedSummaryPath) blockers.push('release_dag_summary_path_identity_mismatch')
  if (!summary?.report_dir || path.resolve(String(summary.report_dir)) !== expectedRunDir) blockers.push('release_dag_summary_report_dir_identity_mismatch')
  return blockers
}

export type ReleaseRealOutcome = 'passed' | 'failed' | 'blocked' | 'skipped' | 'optional'
export type ReleaseRealRequirement = 'release_authorizing' | 'live_optional'

export interface ReleaseRealTaskPolicy {
  requirement: ReleaseRealRequirement
  expectedSchemas: string[]
  statusRequired?: boolean
  allowedStatuses?: string[]
  passStatuses?: string[]
}

export interface ReleaseRealTaskLike {
  id: string
  script: string
  group: string
  phase: string
  deps?: string[]
  command?: string[] | null
  policy: ReleaseRealTaskPolicy
}

export interface ReleaseRealProcessInput {
  task: ReleaseRealTaskLike
  commandLine: string[]
  code: number | null
  signal: string | null
  error: unknown
  stdout: string
  stderr: string
  durationMs: number
  attempt: number
}

const SKIPPED_STATUSES = new Set(['skipped', 'not_run', 'not_requested'])
const OPTIONAL_STATUSES = new Set(['integration_optional', 'optional', 'not_required', 'skipped_optional_unavailable'])
const FAILED_STATUSES = new Set(['failed', 'blocked', 'error', 'unavailable', 'real_required_missing'])

export function normalizeReleaseRealProcessResult(input: ReleaseRealProcessInput) {
  const parsedOutput = parseReleaseRealJsonOutput(input.stdout, input.stderr)
  const parsed = parsedOutput.primary
  const schema = contractSchema(parsed)
  const parsedOk = contractOk(parsed)
  const status = contractStatus(parsed)
  const reason = contractReason(parsed)
  const contractBlockers = validateJsonContract(input.task.policy, { parsed, schema, parsedOk, status })
  const contractValid = contractBlockers.length === 0
  const processOk = input.code === 0 && !input.error
  const outcome = contractValid
    ? classifyReleaseRealOutcome({ processOk, parsedOk: parsedOk as boolean, status, policy: input.task.policy })
    : 'failed'
  const requiredForRelease = input.task.policy.requirement === 'release_authorizing'
  const releaseBlocking = !contractValid || (requiredForRelease && outcome !== 'passed')
  const parsedBlockers = unique([
    ...extractContractStringLists(parsedOutput.stdoutEnvelope, 'blockers'),
    ...extractContractStringLists(parsedOutput.stderrEnvelope, 'blockers')
  ])
  const parsedWarnings = unique([
    ...extractContractStringLists(parsedOutput.stdoutEnvelope, 'warnings'),
    ...extractContractStringLists(parsedOutput.stderrEnvelope, 'warnings')
  ])
  const blockers = unique([
    ...parsedBlockers,
    ...contractBlockers,
    ...(!processOk && parsedBlockers.length === 0 ? [`release_real_process_exit:${input.code ?? 'spawn_error'}`] : []),
    ...(requiredForRelease && contractValid && outcome !== 'passed' ? [`release_required_outcome_not_passed:${outcome}`] : [])
  ])

  return {
    id: input.task.id,
    script: input.task.script,
    group: input.task.group,
    phase: input.task.phase,
    deps: input.task.deps || [],
    command: input.commandLine,
    contract_schema: RELEASE_REAL_RESULT_CONTRACT_SCHEMA,
    requirement: input.task.policy.requirement,
    required_for_release: requiredForRelease,
    release_blocking: releaseBlocking,
    outcome,
    passed: outcome === 'passed',
    ok: !releaseBlocking,
    process_ok: processOk,
    contract_ok: contractValid,
    attempt: input.attempt,
    exit_code: input.code,
    signal: input.signal,
    duration_ms: input.durationMs,
    error: input.error,
    parsed_schema: schema,
    parsed_ok: parsedOk,
    parsed_status: status,
    reason,
    expected_schemas: [...input.task.policy.expectedSchemas],
    status_required: input.task.policy.statusRequired === true,
    blockers,
    warnings: parsedWarnings,
    stdout_tail: tail(input.stdout),
    stderr_tail: tail(input.stderr)
  }
}

export function dependencyReleaseRealResult(
  task: ReleaseRealTaskLike,
  dependencies: Array<{ id: string; outcome?: ReleaseRealOutcome; ok?: boolean }>,
) {
  const requiredForRelease = task.policy.requirement === 'release_authorizing'
  const dependencyOutcomes = dependencies.map((row) => ({
    id: row.id,
    outcome: normalizeOutcome(row.outcome, row.ok)
  }))
  const hardFailure = dependencyOutcomes.some((row) => row.outcome === 'failed' || row.outcome === 'blocked')
  const outcome: ReleaseRealOutcome = requiredForRelease
    ? 'blocked'
    : hardFailure ? 'blocked' : 'optional'
  const blockers = dependencyOutcomes.map((row) => `${outcome === 'blocked' ? 'blocked' : 'optional'}_by_dependency:${row.id}:${row.outcome}`)
  return {
    id: task.id,
    script: task.script,
    group: task.group,
    phase: task.phase,
    deps: task.deps || [],
    command: task.command || ['npm', 'run', task.script, '--silent'],
    contract_schema: RELEASE_REAL_RESULT_CONTRACT_SCHEMA,
    requirement: task.policy.requirement,
    required_for_release: requiredForRelease,
    release_blocking: requiredForRelease,
    outcome,
    passed: false,
    ok: !requiredForRelease,
    process_ok: null,
    contract_ok: true,
    blocked: outcome === 'blocked',
    dependency_outcomes: dependencyOutcomes,
    exit_code: null,
    signal: null,
    duration_ms: 0,
    error: null,
    parsed_schema: null,
    parsed_ok: null,
    parsed_status: null,
    reason: 'dependency did not produce a passed outcome',
    expected_schemas: [...task.policy.expectedSchemas],
    status_required: task.policy.statusRequired === true,
    blockers,
    warnings: [],
    stdout_tail: '',
    stderr_tail: blockers.join('\n')
  }
}

export function releaseRealDependencySatisfied(result: { outcome?: ReleaseRealOutcome; ok?: boolean }): boolean {
  return normalizeOutcome(result.outcome, result.ok) === 'passed'
}

export function summarizeReleaseRealPhases(
  phases: string[],
  results: any[],
  releaseCheck: any,
) {
  return phases.map((phase) => {
    const rows = phase === 'design' ? [releaseCheck].filter(Boolean) : results.filter((row) => row.phase === phase)
    const requiredRows = rows.filter((row) => row.required_for_release !== false)
    const liveOptionalRows = rows.filter((row) => row.requirement === 'live_optional')
    const requiredOutcomes = countOutcomes(requiredRows)
    return {
      phase,
      total: rows.length,
      ...requiredOutcomes,
      outcome_counts: countOutcomes(rows),
      release_authorizing_total: requiredRows.length,
      release_authorizing_passed: requiredRows.filter((row) => row.outcome === 'passed').length,
      live_optional_total: liveOptionalRows.length,
      live_optional_covered: liveOptionalRows.filter((row) => row.outcome === 'passed').length,
      release_blocking: rows.filter((row) => row.release_blocking === true).length,
      duration_ms: rows.reduce((sum, row) => sum + Number(row.duration_ms || 0), 0)
    }
  })
}

export function buildReleaseRealLiveCoverage(results: any[]) {
  const checks = results
    .filter((row) => row.requirement === 'live_optional')
    .map((row) => ({
      id: row.id,
      outcome: row.outcome,
      process_ok: row.process_ok,
      contract_ok: row.contract_ok,
      status: row.parsed_status,
      reason: row.reason,
      blockers: row.blockers || []
    }))
  const outcomes = countOutcomes(checks)
  return {
    schema: RELEASE_REAL_LIVE_COVERAGE_SCHEMA,
    release_authorizing: false,
    excluded_from_release_authorizing_pass_count: true,
    complete: checks.length > 0 && checks.every((row) => row.outcome === 'passed'),
    total: checks.length,
    ...outcomes,
    checks
  }
}

export interface ReleaseRealSkipProofInput {
  summary: any
  expectedReleaseGateIds: string[]
  summaryPath: string | null
  summaryMtimeMs: number | null
  summarySha256: string | null
  distStamp: any
  distStampPath: string | null
  distStampMtimeMs: number | null
  canonicalTestProof: any
  canonicalTestProofPath: string | null
  canonicalTestProofSha256: string | null
  canonicalTestProofMtimeMs: number | null
  canonicalTestProofBlockers: string[]
  authorizationSnapshot: ReleaseAuthorizationSnapshot
  currentDistSourceDigest: string | null
  currentDistSourceFileCount: number | null
  nowMs: number
  maxAgeMs: number
}

export function validateReleaseRealSkipProof(input: ReleaseRealSkipProofInput) {
  const blockers: string[] = []
  const summary = input.summary
  const stamp = input.distStamp
  const canonicalTestProof = input.canonicalTestProof
  const canonicalTestProofBlockers = Array.isArray(input.canonicalTestProofBlockers) ? input.canonicalTestProofBlockers : []
  const authorization = input.authorizationSnapshot
  const summaryAuthorization = summary?.release_authorization_snapshot
  if (!input.summaryPath || !summary) blockers.push('release_real_skip_full_summary_missing')
  if (summary?.schema !== 'sks.release-gate-dag-run.v1') blockers.push('release_real_skip_full_summary_schema_invalid')
  if (summary?.ok !== true) blockers.push('release_real_skip_full_summary_not_ok')
  if (summary?.selected_preset !== 'release') blockers.push('release_real_skip_full_summary_preset_invalid')
  if (summary?.affected_selection?.mode !== 'full') blockers.push('release_real_skip_full_summary_not_full')
  if (summary?.completion_certificate?.confidence !== 'full-release-proof') blockers.push('release_real_skip_full_summary_confidence_invalid')
  if (summary?.completion_certificate?.full_release_proof !== 'current_run') blockers.push('release_real_skip_full_summary_not_current_run')
  if (!summary?.run_id) blockers.push('release_real_skip_full_summary_run_id_missing')
  if (!Number.isInteger(summary?.selected_gates) || summary.selected_gates <= 0) blockers.push('release_real_skip_full_summary_empty')
  if (!Array.isArray(summary?.selected_gate_ids) || summary.selected_gate_ids.length !== summary?.selected_gates) blockers.push('release_real_skip_full_summary_gate_ids_incomplete')
  const expectedReleaseGateIds = unique((input.expectedReleaseGateIds || []).map(String).filter(Boolean)).sort()
  const selectedReleaseGateIds = unique<string>(
    (Array.isArray(summary?.selected_gate_ids) ? summary.selected_gate_ids : [])
      .map((value: unknown) => String(value))
      .filter(Boolean)
  ).sort()
  if (!expectedReleaseGateIds.length) blockers.push('release_real_skip_expected_release_gate_ids_missing')
  if (expectedReleaseGateIds.length && !sameStringList(expectedReleaseGateIds, selectedReleaseGateIds)) blockers.push('release_real_skip_full_summary_gate_ids_mismatch')
  if (summary?.failed !== 0 || summary?.completed !== summary?.selected_gates) blockers.push('release_real_skip_full_summary_incomplete')
  if (!/^[a-f0-9]{64}$/i.test(String(input.summarySha256 || ''))) blockers.push('release_real_skip_full_summary_hash_missing')
  if (!input.canonicalTestProofPath || !canonicalTestProof) blockers.push('release_real_skip_canonical_test_proof_missing')
  if (!/^[a-f0-9]{64}$/i.test(String(input.canonicalTestProofSha256 || ''))) blockers.push('release_real_skip_canonical_test_proof_hash_missing')
  if (canonicalTestProof?.schema !== 'sks.canonical-test-proof.v1') blockers.push('release_real_skip_canonical_test_proof_schema_invalid')
  if (canonicalTestProof?.ok !== true || canonicalTestProofBlockers.length > 0) {
    blockers.push('release_real_skip_canonical_test_proof_invalid')
    blockers.push(...canonicalTestProofBlockers.map((blocker) => `release_real_skip_canonical_test_proof:${blocker}`))
  }
  if (!/^[a-f0-9]{40,64}$/i.test(String(authorization?.git_commit || ''))) blockers.push('release_real_skip_git_commit_missing')
  if (!/^[a-f0-9]{64}$/i.test(String(authorization?.source_digest || ''))) blockers.push('release_real_skip_current_source_digest_missing')
  if (!Number.isInteger(authorization?.source_file_count) || Number(authorization?.source_file_count) <= 0) blockers.push('release_real_skip_source_file_count_missing')
  if (!/^[a-f0-9]{64}$/i.test(String(authorization?.package_files_sha256 || ''))) blockers.push('release_real_skip_package_files_digest_missing')
  if (!Number.isInteger(authorization?.package_file_count) || Number(authorization?.package_file_count) <= 0) blockers.push('release_real_skip_package_file_count_missing')
  if (!/^[a-f0-9]{64}$/i.test(String(authorization?.release_gate_sha256 || ''))) blockers.push('release_real_skip_release_gate_digest_missing')
  if (!/^[a-f0-9]{64}$/i.test(String(authorization?.dist_build_sha256 || ''))) blockers.push('release_real_skip_dist_digest_missing')
  if (!Number.isInteger(authorization?.dist_file_count) || Number(authorization?.dist_file_count) <= 0) blockers.push('release_real_skip_dist_file_count_missing')
  if (!summaryAuthorization || typeof summaryAuthorization !== 'object') {
    blockers.push('release_real_skip_full_summary_authorization_snapshot_missing')
  } else if (!sameReleaseAuthorizationSnapshot(summaryAuthorization, authorization)) {
    for (const key of RELEASE_AUTHORIZATION_SNAPSHOT_KEYS) {
      if (summaryAuthorization[key] !== authorization?.[key]) blockers.push(`release_real_skip_full_summary_authorization_mismatch:${key}`)
    }
  }
  if (!canonicalTestProof?.release_authorization_snapshot || !sameReleaseAuthorizationSnapshot(canonicalTestProof.release_authorization_snapshot, authorization)) {
    blockers.push('release_real_skip_canonical_test_proof_authorization_mismatch')
  }
  if (!/^[a-f0-9]{64}$/i.test(String(input.currentDistSourceDigest || ''))) blockers.push('release_real_skip_dist_source_digest_missing')
  if (!stamp || !stamp.source_digest) blockers.push('release_real_skip_dist_source_stamp_missing')
  if (stamp && !['sks.dist-build-stamp.v1', 'sks.dist-build.v2'].includes(String(stamp.schema || ''))) blockers.push('release_real_skip_dist_source_stamp_schema_invalid')
  if (stamp?.source_digest && input.currentDistSourceDigest && stamp.source_digest !== input.currentDistSourceDigest) blockers.push('release_real_skip_dist_source_digest_mismatch')
  if (!Number.isInteger(input.currentDistSourceFileCount) || !Number.isInteger(stamp?.source_file_count)) blockers.push('release_real_skip_dist_source_file_count_missing')
  if (Number.isInteger(input.currentDistSourceFileCount) && Number.isInteger(stamp?.source_file_count) && stamp.source_file_count !== input.currentDistSourceFileCount) blockers.push('release_real_skip_dist_source_file_count_mismatch')
  if (!Number.isFinite(input.summaryMtimeMs) || !Number.isFinite(input.distStampMtimeMs) || !Number.isFinite(input.canonicalTestProofMtimeMs)) blockers.push('release_real_skip_proof_mtime_missing')
  if (Number.isFinite(input.summaryMtimeMs) && Number.isFinite(input.distStampMtimeMs) && Number(input.summaryMtimeMs) < Number(input.distStampMtimeMs)) blockers.push('release_real_skip_full_summary_predates_current_build')
  if (Number.isFinite(input.summaryMtimeMs) && Number.isFinite(input.canonicalTestProofMtimeMs) && Number(input.summaryMtimeMs) < Number(input.canonicalTestProofMtimeMs)) blockers.push('release_real_skip_full_summary_predates_canonical_test_proof')
  const ageMs = Number.isFinite(input.summaryMtimeMs) ? Math.max(0, input.nowMs - Number(input.summaryMtimeMs)) : null
  if (ageMs !== null && ageMs > input.maxAgeMs) blockers.push('release_real_skip_full_summary_expired')
  return {
    schema: RELEASE_REAL_SKIP_PROOF_SCHEMA,
    ok: blockers.length === 0,
    proof_source: 'latest_full_dag_receipt+current_canonical_test_proof+release_authorization_snapshot+current_dist_source_stamp',
    latest_summary_path: input.summaryPath,
    latest_summary_sha256: input.summarySha256,
    run_id: summary?.run_id || null,
    selected_gates: summary?.selected_gates ?? null,
    completed: summary?.completed ?? null,
    failed: summary?.failed ?? null,
    ...authorization,
    dist_source_digest: input.currentDistSourceDigest,
    dist_source_file_count: input.currentDistSourceFileCount,
    dist_stamp_path: input.distStampPath,
    dist_stamp_source_digest: stamp?.source_digest || null,
    canonical_test_proof_path: input.canonicalTestProofPath,
    canonical_test_proof_sha256: input.canonicalTestProofSha256,
    canonical_test_proof_mtime_ms: input.canonicalTestProofMtimeMs,
    summary_mtime_ms: input.summaryMtimeMs,
    dist_stamp_mtime_ms: input.distStampMtimeMs,
    age_ms: ageMs,
    max_age_ms: input.maxAgeMs,
    blockers: unique(blockers)
  }
}

export function validateReleaseRealTaskIds(taskIds: string[]) {
  const raw = taskIds.map(String).filter(Boolean)
  const actual = unique(raw)
  const expected: string[] = [...RELEASE_REAL_CHECK_IDS]
  const missing = expected.filter((id) => !actual.includes(id))
  const unexpected = actual.filter((id) => !expected.includes(id))
  const duplicates = unique(raw.filter((id, index) => raw.indexOf(id) !== index))
  return {
    ok: missing.length === 0 && unexpected.length === 0 && duplicates.length === 0,
    expected_ids: expected,
    actual_ids: actual,
    missing_ids: missing,
    unexpected_ids: unexpected,
    duplicate_ids: duplicates
  }
}

export function parseReleaseRealJsonOutput(stdout: string, stderr: string) {
  const stdoutEnvelope = bestJsonEnvelope(stdout)
  const stderrEnvelope = bestJsonEnvelope(stderr)
  const primary = envelopeScore(stdoutEnvelope) >= envelopeScore(stderrEnvelope) ? stdoutEnvelope : stderrEnvelope
  return { primary, stdoutEnvelope, stderrEnvelope }
}

function validateJsonContract(
  policy: ReleaseRealTaskPolicy,
  value: { parsed: any; schema: string | null; parsedOk: boolean | null; status: string | null },
): string[] {
  const blockers: string[] = []
  if (!value.parsed) blockers.push('release_real_json_contract_missing')
  if (!value.schema) blockers.push('release_real_json_schema_missing')
  else if (!policy.expectedSchemas.includes(value.schema)) blockers.push(`release_real_json_schema_unexpected:${value.schema}`)
  if (value.parsedOk === null) blockers.push('release_real_json_ok_missing')
  const allowedStatuses = policy.allowedStatuses || []
  if (policy.statusRequired === true && !value.status) blockers.push('release_real_json_status_missing')
  if (value.status && !allowedStatuses.includes(value.status)) blockers.push(`release_real_json_status_unexpected:${value.status}`)
  return blockers
}

function classifyReleaseRealOutcome(input: {
  processOk: boolean
  parsedOk: boolean
  status: string | null
  policy: ReleaseRealTaskPolicy
}): ReleaseRealOutcome {
  const status = input.status || ''
  if (SKIPPED_STATUSES.has(status)) return input.processOk && input.parsedOk ? 'skipped' : 'failed'
  if (OPTIONAL_STATUSES.has(status)) return input.processOk && input.parsedOk ? 'optional' : 'failed'
  if (FAILED_STATUSES.has(status)) return 'failed'
  if (!input.processOk || !input.parsedOk) return 'failed'
  if (status && !(input.policy.passStatuses || []).includes(status)) return 'failed'
  return 'passed'
}

function contractSchema(parsed: any): string | null {
  return stringAt(parsed, ['schema']) || stringAt(parsed, ['detail', 'schema']) || stringAt(parsed, ['report', 'schema'])
}

function contractOk(parsed: any): boolean | null {
  if (typeof parsed?.ok === 'boolean') return parsed.ok
  if (typeof parsed?.detail?.ok === 'boolean') return parsed.detail.ok
  if (typeof parsed?.report?.ok === 'boolean') return parsed.report.ok
  if (typeof parsed?.detail?.overall_ok === 'boolean') return parsed.detail.overall_ok
  return null
}

function contractStatus(parsed: any): string | null {
  const direct = stringAt(parsed, ['status']) || stringAt(parsed, ['detail', 'status']) || stringAt(parsed, ['report', 'status'])
  if (direct) return direct
  if (parsed?.skipped === true || parsed?.detail?.skipped === true || parsed?.report?.skipped === true) return 'skipped'
  if (parsed?.integration_optional === true || parsed?.detail?.integration_optional === true || parsed?.report?.integration_optional === true) return 'integration_optional'
  return null
}

function contractReason(parsed: any): string | null {
  return stringAt(parsed, ['reason']) || stringAt(parsed, ['message']) || stringAt(parsed, ['detail', 'reason']) || stringAt(parsed, ['report', 'reason'])
}

function stringAt(value: any, path: string[]): string | null {
  let current = value
  for (const key of path) current = current && typeof current === 'object' ? current[key] : null
  return typeof current === 'string' && current.trim() ? current.trim() : null
}

function bestJsonEnvelope(text: string): any | null {
  const candidates = jsonEnvelopes(text)
  let best: any | null = null
  let bestScore = -1
  for (const candidate of candidates) {
    const score = envelopeScore(candidate)
    if (score >= bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

function jsonEnvelopes(text: string): any[] {
  const value = String(text || '').trim()
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? [parsed] : []
  } catch {}
  const out: any[] = []
  for (let start = 0; start < value.length; start += 1) {
    if (value[start] !== '{') continue
    const end = balancedObjectEnd(value, start)
    if (end < 0) continue
    try {
      const parsed = JSON.parse(value.slice(start, end + 1))
      if (parsed && typeof parsed === 'object') out.push(parsed)
      start = end
    } catch {}
  }
  return out
}

function balancedObjectEnd(value: string, start: number): number {
  let depth = 0
  let quoted = false
  let escaped = false
  for (let index = start; index < value.length; index += 1) {
    const char = value[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function envelopeScore(value: any): number {
  if (!value || typeof value !== 'object') return -1
  return (contractSchema(value) ? 8 : 0)
    + (contractOk(value) !== null ? 4 : 0)
    + (contractStatus(value) ? 2 : 0)
    + (value.detail && typeof value.detail === 'object' ? 1 : 0)
}

function extractContractStringLists(value: any, key: string): string[] {
  if (!value || typeof value !== 'object') return []
  const out: string[] = []
  const containers = [
    value,
    value.report,
    value.detail,
    value.detail?.report,
    value.detail?.result,
    value.result,
    value.proof
  ]
  for (const current of containers) {
    if (!current || typeof current !== 'object' || !Array.isArray(current[key])) continue
    for (const item of current[key]) if (typeof item === 'string' && item.trim()) out.push(item.trim())
  }
  return unique(out)
}

function normalizeOutcome(outcome: ReleaseRealOutcome | undefined, ok: boolean | undefined): ReleaseRealOutcome {
  if (outcome) return outcome
  return ok === true ? 'passed' : 'failed'
}

function countOutcomes(rows: any[]) {
  const count = (outcome: ReleaseRealOutcome) => rows.filter((row) => row.outcome === outcome).length
  return {
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped'),
    optional: count('optional')
  }
}


function sameStringList(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function tail(value: unknown, limit = 4000): string {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}
