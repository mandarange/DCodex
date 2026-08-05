#!/usr/bin/env node
// @ts-nocheck
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir, writeJsonAtomic } from '../core/fsx.js'
import {
  buildReleaseRealLiveCoverage,
  dependencyReleaseRealResult,
  normalizeReleaseRealProcessResult,
  releaseDagSummaryIdentityBlockers,
  releaseRealDependencySatisfied,
  summarizeReleaseRealPhases,
  validateReleaseRealSkipProof,
  validateReleaseRealTaskIds
} from '../core/release/release-real-contract.js'
import { currentDistFreshness } from './lib/ensure-dist-fresh.js'
import {
  releaseAuthorizationSnapshot,
  sameReleaseAuthorizationSnapshot
} from '../core/release/release-authorization-snapshot.js'
import { readCurrentCanonicalTestProof } from '../core/release/canonical-test-proof.js'

const args = process.argv.slice(2)
const skipReleaseCheck = args.includes('--skip-release-check') || process.env.SKS_RELEASE_REAL_CHECK_SKIP_RELEASE_CHECK === '1'
const root = process.cwd()
const concurrency = Math.max(1, Math.min(4, Math.floor(Number(process.env.SKS_RELEASE_REAL_CHECK_CONCURRENCY || 2))))
const releaseScratchDir = tmpdir('rr-')
const releaseScratchEnv = {
  TMPDIR: releaseScratchDir,
  TMP: releaseScratchDir,
  TEMP: releaseScratchDir,
  SKS_TMP_DIR: releaseScratchDir
}
const report = {
  schema: 'sks.release-real-check.v1',
  generated_at: new Date().toISOString(),
  ok: false,
  pipeline_shape: {
    schema: 'sks.release-real-check-diamond.v1',
    stages: ['design', 'parallel_processing', 'parallel_verification', 'aggregation'],
    concurrency,
    dependency_model: 'dependency-ordered-dag'
  },
  scratch_isolation: {
    schema: 'sks.release-real-scratch-isolation.v1',
    root: releaseScratchDir,
    owned: true,
    child_environment: ['TMPDIR', 'TMP', 'TEMP', 'SKS_TMP_DIR'],
    cleanup: null
  },
  release_check: null,
  skip_release_check_proof: null,
  policy: {
    schema: 'sks.release-real-policy.v1',
    release_authorizing_requirement: 'every required check must have outcome=passed and a valid JSON contract',
    live_optional_requirement: 'valid contracts are required; unavailable external credentials are reported as optional coverage and never counted as a required pass'
  },
  environment_required_checks: [],
  real_smoke_checks: [],
  real_ui_checks: [],
  release_authorizing_checks: [],
  live_coverage: null,
  all_checks: [],
  phase_results: [],
  blockers: [],
  warnings: []
}

const nodeScript = (name, ...args) => [process.execPath, `./dist/scripts/${name}`, ...args]
const terminalStatuses = ['failed', 'blocked', 'error', 'unavailable', 'real_required_missing', 'skipped', 'not_run', 'not_requested', 'integration_optional', 'optional', 'not_required', 'skipped_optional_unavailable']
const requiredPolicy = (expectedSchemas, options = {}) => ({
  requirement: 'release_authorizing',
  expectedSchemas,
  statusRequired: options.statusRequired === true,
  passStatuses: options.passStatuses || [],
  allowedStatuses: [...new Set([...(options.passStatuses || []), ...terminalStatuses])]
})
const liveOptionalPolicy = (expectedSchemas, passStatuses = ['passed', 'proven']) => ({
  requirement: 'live_optional',
  expectedSchemas,
  statusRequired: true,
  passStatuses,
  allowedStatuses: [...new Set([...passStatuses, ...terminalStatuses])]
})
const tasks = [
  task('codex:actual-config-load-probe', 'direct', { command: nodeScript('codex-config-load-probe.js', '--actual-codex', '--require-actual-codex', '--json'), group: 'environment_required', phase: 'parallel_processing', policy: requiredPolicy(['sks.codex-config-load-probe.v2']) }),
  task('codex:current-core-real-probes:require-real', 'direct', { command: nodeScript('codex-current-core-real-probes-check.js', '--require-real', '--allow-network'), group: 'environment_required', phase: 'parallel_processing', policy: requiredPolicy(['sks.release-gate.v1']) }),
  task('codex:current:app-server-v2:real', 'direct', { command: nodeScript('codex-current-app-server-v2-check.js'), group: 'environment_required', phase: 'parallel_processing', args: ['--require-real'], policy: requiredPolicy(['sks.release-gate.v1']) }),
  task('codex:current:capability:real', 'direct', { command: nodeScript('codex-current-capability-check.js'), group: 'environment_required', phase: 'parallel_verification', args: ['--require-real'], deps: ['codex:current:app-server-v2:real'], policy: requiredPolicy(['sks.release-gate.v1']) }),
  task('doctor:actual', 'direct', { command: [process.execPath, './dist/bin/sks.js', 'doctor', '--json'], group: 'environment_required', phase: 'parallel_processing', policy: requiredPolicy(['sks.doctor-status.v3'], { statusRequired: true, passStatuses: ['fast_readonly_ok', 'ok'] }) }),
  task('release:pack-receipt', 'release:pack-receipt', { group: 'environment_required', phase: 'parallel_processing', policy: requiredPolicy(['sks.release-pack-receipt.v1']) }),
  task('naruto:worktree-coding:blackbox', 'direct', { command: nodeScript('naruto-worktree-coding-blackbox.js'), group: 'real_smoke', phase: 'parallel_processing', args: ['--require-real'], env: { SKS_REQUIRE_GIT_WORKTREE: '1' }, policy: requiredPolicy(['sks.release-gate.v1']) }),
  task('codex-sdk:real-smoke', 'direct', { command: nodeScript('codex-sdk-real-smoke-check.js'), group: 'real_smoke', phase: 'parallel_processing', args: ['--require-real'], policy: requiredPolicy(['sks.release-gate.v1'], { statusRequired: true, passStatuses: ['proven'] }) }),
  task('desktop-bridge:real-evidence', 'direct', {
    command: nodeScript('desktop-bridge-real-evidence-check.js'),
    group: 'real_ui',
    phase: 'parallel_verification',
    deps: ['codex:actual-config-load-probe'],
    policy: liveOptionalPolicy(['sks.desktop-bridge-real-evidence-check.v1'], ['passed'])
  }),
  task('imagegen:real-smoke', 'direct', { command: nodeScript('imagegen-real-smoke-check.js'), group: 'real_smoke', phase: 'parallel_processing', policy: liveOptionalPolicy(['sks.imagegen-real-smoke.v1'], ['passed']) }),
  task('ux-review:real-imagegen-smoke', 'direct', { command: nodeScript('ux-review-real-imagegen-smoke-check.js'), group: 'real_smoke', phase: 'parallel_processing', deps: ['imagegen:real-smoke'], policy: liveOptionalPolicy(['sks.ux-real-imagegen-smoke.v1'], ['passed']) }),
  task('ppt:real-imagegen-smoke', 'direct', { command: nodeScript('ppt-real-imagegen-smoke-check.js'), group: 'real_smoke', phase: 'parallel_processing', deps: ['imagegen:real-smoke'], policy: liveOptionalPolicy(['sks.ppt-real-imagegen-smoke.v1'], ['passed']) })
]
const taskContract = validateReleaseRealTaskIds(tasks.map((row) => row.id))
report.task_contract = taskContract
let terminating = false
let skipProofRevalidated = false
let scratchCleanupSucceeded = false
const activeChildren = new Set()

main().catch(async (err) => {
  terminating = true
  report.blockers.push(`release_real_check_exception:${err?.message || String(err)}`)
  await stopActiveChildren('SIGTERM')
  await finish(false, 'exception')
})

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, async () => {
    if (terminating) return
    terminating = true
    report.blockers.push(`release_real_check_signal:${signal}`)
    await stopActiveChildren(signal)
    await finish(false, `signal:${signal}`)
    process.exit(exitCode)
  })
}

async function main() {
  if (!taskContract.ok) {
    report.blockers.push(...taskContract.missing_ids.map((id) => `release_real_task_missing:${id}`))
    report.blockers.push(...taskContract.unexpected_ids.map((id) => `release_real_task_unexpected:${id}`))
    report.blockers.push(...taskContract.duplicate_ids.map((id) => `release_real_task_duplicate:${id}`))
    return await finish(false)
  }
  if (!skipReleaseCheck) {
    report.release_check = await runNpm(task('release:check', 'release:check', { group: 'design', phase: 'design', policy: requiredPolicy(['sks.gate-result.v1']) }))
    if (terminating) return
    collect(report.release_check)
    if (!report.release_check.ok) return await finish(false)
  } else {
    const proof = buildSkipReleaseCheckProof()
    report.skip_release_check_proof = proof
    report.release_check = {
      id: 'release:check',
      script: 'release:check',
      group: 'design',
      phase: 'design',
      requirement: 'release_authorizing',
      required_for_release: true,
      release_blocking: proof.ok !== true,
      outcome: proof.ok === true ? 'passed' : 'blocked',
      passed: proof.ok === true,
      ok: proof.ok === true,
      process_ok: null,
      contract_ok: proof.ok === true,
      skipped: true,
      execution: 'reused_full_release_proof',
      parsed_status: proof.ok === true ? 'proven_by_full_release_receipt' : 'skip_proof_invalid',
      blockers: proof.blockers || [],
      warnings: [],
      duration_ms: 0,
      note: proof.ok === true
        ? 'Execution skipped only because the latest full release receipt is bound to the current source digest.'
        : 'Skip denied because no current full release receipt is bound to this source digest.',
      proof
    }
    collect(report.release_check)
    if (!report.release_check.ok) return await finish(false)
  }

  const result = await runDag(tasks, concurrency)
  if (terminating) return
  report.all_checks = result.results
  report.environment_required_checks = result.results.filter((row) => row.group === 'environment_required')
  report.real_smoke_checks = result.results.filter((row) => row.group === 'real_smoke')
  report.real_ui_checks = result.results.filter((row) => row.group === 'real_ui')
  report.release_authorizing_checks = result.results.filter((row) => row.required_for_release === true)
  report.live_coverage = buildReleaseRealLiveCoverage(result.results)
  report.phase_results = summarizeReleaseRealPhases(['design', 'parallel_processing', 'parallel_verification', 'aggregation'], result.results, report.release_check)
  for (const row of result.results) collect(row)
  await finish(result.results.every((row) => row.ok))
}

function task(id, script, options = {}) {
  return {
    id,
    script,
    command: options.command || null,
    group: options.group || 'real_smoke',
    phase: options.phase || 'parallel_processing',
    args: options.args || [],
    env: options.env || {},
    deps: options.deps || [],
    alwaysRun: options.alwaysRun === true,
    policy: options.policy || requiredPolicy(['sks.release-gate.v1']),
    retries: Number(options.retries || 0),
    retryDelayMs: Number(options.retryDelayMs || 0)
  }
}

async function runDag(taskList, maxConcurrency) {
  const pending = new Map(taskList.map((row) => [row.id, row]))
  const running = new Map()
  const completed = new Map()
  const results = []
  while (pending.size || running.size) {
    if (terminating) {
      await Promise.allSettled([...running.values()])
      return { results }
    }
    for (const [id, row] of [...pending]) {
      const depsComplete = row.deps.every((dep) => completed.has(dep))
      const unsatisfiedDeps = depsComplete
        ? row.deps.filter((dep) => !releaseRealDependencySatisfied(completed.get(dep)))
        : []
      if (unsatisfiedDeps.length && !row.alwaysRun) {
        pending.delete(id)
        const blocked = dependencyReleaseRealResult(row, unsatisfiedDeps.map((dep) => completed.get(dep)))
        completed.set(id, blocked)
        results.push(blocked)
      }
    }
    const ready = [...pending.values()].filter((row) => row.deps.every((dep) => completed.has(dep) && (row.alwaysRun || releaseRealDependencySatisfied(completed.get(dep)))))
    while (running.size < maxConcurrency && ready.length) {
      const row = ready.shift()
      pending.delete(row.id)
      const promise = runNpm(row)
      running.set(row.id, promise)
    }
    if (!running.size) {
      if (pending.size) {
        for (const row of pending.values()) {
          const dependencies = row.deps.map((dep) => completed.get(dep) || { id: dep, outcome: 'blocked', ok: false })
          const blocked = dependencyReleaseRealResult(row, dependencies)
          completed.set(row.id, blocked)
          results.push(blocked)
        }
        pending.clear()
      }
      continue
    }
    const result = await Promise.race([...running.values()])
    running.delete(result.id)
    completed.set(result.id, result)
    results.push(result)
  }
  return { results }
}

async function runNpm(row) {
  const maxAttempts = Math.max(1, Number(row.retries || 0) + 1)
  const attempts = []
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runNpmOnce(row, attempt)
    attempts.push(compactAttempt(result))
    if (terminating || result.ok || attempt >= maxAttempts) {
      const finalResult = {
        ...result,
        attempt,
        attempts,
        retried: attempts.length > 1
      }
      return finalResult
    }
    await sleep(Math.max(0, Number(row.retryDelayMs || 0)))
  }
}

function runNpmOnce(row, attempt) {
  const direct = Array.isArray(row.command) && row.command.length > 0
  const bin = direct ? row.command[0] : 'npm'
  const processArgs = direct
    ? [...row.command.slice(1), ...(row.args || [])]
    : ['run', row.script, '--silent', ...(row.args?.length ? ['--', ...row.args] : [])]
  const commandLine = [bin, ...processArgs]
  const started = Date.now()
  let stdout = ''
  let stderr = ''
  return new Promise((resolve) => {
    const child = spawn(bin, processArgs, {
      cwd: root,
      env: { ...process.env, ...(row.env || {}), ...releaseScratchEnv },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    activeChildren.add(child)
    child.stdout.on('data', (chunk) => { stdout = appendTail(stdout, chunk) })
    child.stderr.on('data', (chunk) => { stderr = appendTail(stderr, chunk) })
    child.on('error', (err) => {
      activeChildren.delete(child)
      resolve(normalizeResult(row, commandLine, 1, null, { code: err.code, message: err.message }, stdout, stderr, Date.now() - started, attempt))
    })
    child.on('close', (code, signal) => {
      activeChildren.delete(child)
      resolve(normalizeResult(row, commandLine, code, signal, null, stdout, stderr, Date.now() - started, attempt))
    })
  })
}

function normalizeResult(row, commandLine, code, signal, error, stdout, stderr, durationMs, attempt) {
  return normalizeReleaseRealProcessResult({ task: row, commandLine, code, signal, error, stdout, stderr, durationMs, attempt })
}

function compactAttempt(result) {
  return {
    attempt: result.attempt,
    ok: result.ok,
    outcome: result.outcome,
    contract_ok: result.contract_ok,
    exit_code: result.exit_code,
    duration_ms: result.duration_ms,
    blockers: result.blockers || [],
    stderr_tail: tail(result.stderr_tail || '', 600)
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function stopActiveChildren(signal = 'SIGTERM') {
  const children = [...activeChildren]
  if (!children.length) return { ok: true, stopped: 0, escalated: 0 }
  for (const child of children) signalChildTree(child, signal)
  await settleWithTimeout(children.map(waitForChildClose), 5_000)
  const remaining = children.filter((child) => child.exitCode === null && child.signalCode === null)
  for (const child of remaining) signalChildTree(child, 'SIGKILL')
  if (remaining.length) await settleWithTimeout(remaining.map(waitForChildClose), 1_000)
  const survivors = remaining.filter((child) => child.exitCode === null && child.signalCode === null)
  if (survivors.length) {
    const blocker = `release_real_child_cleanup_not_proven:${survivors.length}`
    if (!report.blockers.includes(blocker)) report.blockers.push(blocker)
    if (!report.warnings.includes(blocker)) report.warnings.push(blocker)
  }
  return { ok: survivors.length === 0, stopped: children.length, escalated: remaining.length }
}

function signalChildTree(child, signal) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      const warning = `release_real_child_signal_failed:${child.pid}:${signal}:${error?.code || 'unknown'}`
      if (!report.warnings.includes(warning)) report.warnings.push(warning)
    }
  }
}

function waitForChildClose(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}

async function settleWithTimeout(promises, timeoutMs) {
  let timer = null
  try {
    await Promise.race([
      Promise.allSettled(promises),
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function collect(result) {
  if (result.release_blocking === true || result.ok === false) {
    for (const blocker of result.blockers || []) {
      if (!report.blockers.includes(blocker)) report.blockers.push(blocker)
    }
  }
  if ((result.release_blocking === true || result.ok === false) && !(result.blockers || []).length) {
    const blocker = `${result.id.replace(/[^A-Za-z0-9]+/g, '_')}_failed`
    if (!report.blockers.includes(blocker)) report.blockers.push(blocker)
  }
  if (result.requirement === 'live_optional' && result.outcome !== 'passed') {
    const warning = `optional_live_coverage_not_proven:${result.id}:${result.outcome}`
    if (!report.warnings.includes(warning)) report.warnings.push(warning)
  }
  for (const warning of result.warnings || []) {
    if (!report.warnings.includes(warning)) report.warnings.push(warning)
  }
}

async function finish(ok, trigger = 'finish') {
  if (skipReleaseCheck && report.skip_release_check_proof?.ok === true && !skipProofRevalidated) {
    skipProofRevalidated = true
    const initialProof = report.skip_release_check_proof
    const finalProof = buildSkipReleaseCheckProof()
    const identityMatches = finalProof.ok === true
      && finalProof.run_id === initialProof.run_id
      && finalProof.latest_summary_sha256 === initialProof.latest_summary_sha256
      && sameReleaseAuthorizationSnapshot(finalProof, initialProof)
      && finalProof.dist_source_digest === initialProof.dist_source_digest
      && finalProof.dist_source_file_count === initialProof.dist_source_file_count
      && finalProof.dist_stamp_source_digest === initialProof.dist_stamp_source_digest
      && finalProof.canonical_test_proof_path === initialProof.canonical_test_proof_path
      && finalProof.canonical_test_proof_sha256 === initialProof.canonical_test_proof_sha256
    report.skip_release_check_proof = {
      ...initialProof,
      stable_through_real_checks: identityMatches,
      final_revalidation: finalProof
    }
    if (report.release_check?.proof) report.release_check.proof = report.skip_release_check_proof
    if (!identityMatches) {
      const blocker = 'release_real_skip_proof_changed_during_run'
      if (!report.blockers.includes(blocker)) report.blockers.push(blocker)
      ok = false
    }
  }
  const scratchCleanup = cleanupReleaseScratch(trigger)
  if (!scratchCleanup.ok) ok = false
  report.ok = ok && report.blockers.length === 0
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', 'release-real-check.json'), report)
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exitCode = 1
}

function cleanupReleaseScratch(trigger) {
  if (scratchCleanupSucceeded) {
    const cleanup = { trigger, ok: true, removed: true, outcome: 'already_removed' }
    report.scratch_isolation.cleanup = cleanup
    return cleanup
  }
  let error = null
  try {
    fs.rmSync(releaseScratchDir, { recursive: true, force: true })
  } catch (caught) {
    error = caught?.message || String(caught)
  }
  const removed = !fs.existsSync(releaseScratchDir)
  scratchCleanupSucceeded = removed
  const cleanup = {
    trigger,
    ok: removed,
    removed,
    outcome: removed ? 'removed' : 'cleanup_not_proven',
    ...(error ? { error } : {})
  }
  report.scratch_isolation.cleanup = cleanup
  if (!removed) {
    const blocker = 'release_real_scratch_cleanup_not_proven'
    if (!report.blockers.includes(blocker)) report.blockers.push(blocker)
    if (!report.warnings.includes(blocker)) report.warnings.push(blocker)
  }
  return cleanup
}

function appendTail(previous, chunk, limit = 2 * 1024 * 1024) {
  const text = previous + String(chunk || '')
  return text.length <= limit ? text : text.slice(-limit)
}

function tail(value, limit = 4000) {
  const text = String(value || '')
  return text.length <= limit ? text : text.slice(-limit)
}

function buildSkipReleaseCheckProof() {
  const summaryPath = latestReleaseGateSummaryPath()
  const summary = readJson(summaryPath)
  const freshness = currentDistFreshness()
  const pkg = readJson(path.join(root, 'package.json'))
  let authorizationSnapshot = {}
  try { authorizationSnapshot = releaseAuthorizationSnapshot(root, pkg) } catch {}
  const summaryMtimeMs = fileMtime(summaryPath)
  const distStampMtimeMs = fileMtime(freshness.stamp_path)
  const canonicalInspection = readCurrentCanonicalTestProof(root)
  const canonicalProofPath = canonicalInspection.proof_path || null
  const maxAgeMs = Math.max(60_000, Number(process.env.SKS_RELEASE_REAL_SKIP_MAX_AGE_MS || 6 * 60 * 60 * 1000))
  return validateReleaseRealSkipProof({
    summary,
    expectedReleaseGateIds: releasePresetGateIds(),
    summaryPath: summaryPath ? path.relative(root, summaryPath).split(path.sep).join('/') : null,
    summaryMtimeMs,
    summarySha256: summaryPath ? sha256File(summaryPath) : null,
    distStamp: freshness.stamp,
    distStampPath: freshness.stamp_path ? path.relative(root, freshness.stamp_path).split(path.sep).join('/') : null,
    distStampMtimeMs,
    canonicalTestProof: canonicalInspection.proof,
    canonicalTestProofPath: canonicalProofPath ? path.relative(root, canonicalProofPath).split(path.sep).join('/') : null,
    canonicalTestProofSha256: canonicalInspection.proof_sha256 || null,
    canonicalTestProofMtimeMs: fileMtime(canonicalProofPath),
    canonicalTestProofBlockers: canonicalInspection.blockers || [],
    authorizationSnapshot,
    currentDistSourceDigest: freshness.source_digest || null,
    currentDistSourceFileCount: Number.isInteger(freshness.source_file_count) ? freshness.source_file_count : null,
    nowMs: Date.now(),
    maxAgeMs
  })
}

function releasePresetGateIds() {
  const manifest = readJson(path.join(root, 'release-gates.v2.json'))
  return (Array.isArray(manifest?.gates) ? manifest.gates : [])
    .filter((gate) => Array.isArray(gate?.preset) && gate.preset.includes('release'))
    .map((gate) => String(gate.id || ''))
    .filter(Boolean)
}

function latestReleaseGateSummaryPath() {
  const dir = path.join(root, '.sneakoscope', 'reports', 'release-gates')
  if (!fs.existsSync(dir)) return null
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, 'summary.json'))
    .filter((file) => fs.existsSync(file))
    .filter((file) => {
      const summary = readJson(file)
      return summary && releaseDagSummaryIdentityBlockers(summary, file, dir).length === 0
    })
    .sort((left, right) => Number(fileMtime(right) || 0) - Number(fileMtime(left) || 0))[0] || null
}

function readJson(file) {
  try { return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null } catch { return null }
}

function fileMtime(file) {
  try { return file ? fs.statSync(file).mtimeMs : null } catch { return null }
}

function sha256File(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch { return null }
}
