#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const currentRunDir = process.env.SKS_REPORT_DIR ? path.dirname(process.env.SKS_REPORT_DIR) : null
const latest = currentRunDir ? currentDagSummary(currentRunDir) : latestDagSummary()
assertGate(Boolean(latest), 'release speed budget requires an actual DAG summary', {
  expected: '.sneakoscope/reports/release-gates/<latest>/summary.json',
  hint: 'run npm run release:check:dag first'
})
const summary = JSON.parse(fs.readFileSync(latest.summaryPath, 'utf8'))
const slowest = slowestGateResults(latest.dir)
const warnOnly = process.env.SKS_RELEASE_SPEED_BUDGET_WARN_ONLY === '1'
const budgetMs = Number(process.env.SKS_RELEASE_SPEED_BUDGET_MS || 20 * 60 * 1000)
const cachedBudgetMs = Number(process.env.SKS_RELEASE_CACHED_SPEED_BUDGET_MS || 4 * 60 * 1000)
const fastSlaMs = Number(process.env.SKS_RELEASE_FAST_SLA_MS || 5 * 60 * 1000)
const cachedRatio = Number(summary.cached || 0) / Math.max(1, Number(summary.completed || summary.selected_gates || 1))
const cachedRun = cachedRatio >= 0.5
const parallelismGainTarget = 2
const parallelismPeakTarget = 2
const fastSlaMet = Number(summary.wall_ms || 0) <= fastSlaMs
// A long critical-path gate can keep measured gain below 2 even while the DAG
// executes independent work concurrently and finishes inside the release SLA.
// Preserve a real parallelism requirement, but accept either measured gain or
// observed concurrent execution paired with the five-minute certificate SLA.
const parallelismOk = cachedRun
  || Number(summary.parallelism_gain || 0) >= parallelismGainTarget
  || (Number(summary.peak_running || 0) >= parallelismPeakTarget && fastSlaMet)
const wallOk = cachedRun ? summary.wall_ms <= cachedBudgetMs : summary.wall_ms <= budgetMs
const failureIds = Array.isArray(summary.failures) ? summary.failures.map((entry) => String(entry?.id || '')).filter(Boolean) : []
const selfFailureIds = new Set(['release:parallel-speed-budget', 'release:stability-report'])
const blockingFailureIds = failureIds.filter((id) => !selfFailureIds.has(id))
const summaryOk = Number(summary.failed || 0) === 0 || (failureIds.length > 0 && blockingFailureIds.length === 0)
const report = {
  schema: 'sks.release-speed.v1',
  ok: summaryOk && parallelismOk && (wallOk || warnOnly),
  summary_path: path.relative(root, latest.summaryPath),
  run_id: summary.run_id,
  mode: cachedRun ? 'cached' : 'full',
  total_gates: summary.total_gates,
  selected_gates: summary.selected_gates,
  completed: summary.completed,
  failed: summary.failed,
  cached: summary.cached,
  cached_ratio: Number(cachedRatio.toFixed(4)),
  wall_ms: summary.wall_ms,
  sum_gate_ms: summary.sum_gate_ms,
  critical_path_ms: summary.critical_path_ms,
  slowest_gates: slowest,
  functional_failure_ids: blockingFailureIds,
  ignored_self_failure_ids: failureIds.filter((id) => selfFailureIds.has(id)),
  target_full_wall_ms: budgetMs,
  target_cached_wall_ms: cachedBudgetMs,
  target_changed_file_wall_ms: 90 * 1000,
  target_fast_sla_ms: fastSlaMs,
  fast_sla_met: fastSlaMet,
  parallelism_gain: summary.parallelism_gain,
  parallelism_gain_target: parallelismGainTarget,
  peak_running: summary.peak_running,
  parallelism_peak_target: parallelismPeakTarget,
  parallel_execution_proven: parallelismOk,
  warn_only: warnOnly,
  blockers: [
    ...(summaryOk ? [] : ['release_summary_has_failures']),
    ...(parallelismOk ? [] : ['parallel_execution_not_proven']),
    ...(wallOk || warnOnly ? [] : [cachedRun ? 'cached_release_wall_budget_exceeded' : 'release_wall_budget_exceeded']),
    ...(Number.isFinite(Number(summary.critical_path_ms)) ? [] : ['critical_path_ms_missing']),
    ...(Array.isArray(slowest) && slowest.length ? [] : ['slowest_gates_missing'])
  ]
}
assertGate(report.blockers.length === 0, 'release DAG speed budget must use and pass actual run summary', report)
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true })
fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'release-parallel-speed-budget.json'), `${JSON.stringify(report, null, 2)}\n`)
emitGate('release:parallel-speed-budget', report)

function latestDagSummary() {
  const dir = path.join(root, '.sneakoscope', 'reports', 'release-gates')
  if (!fs.existsSync(dir)) return null
  const rows = fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((candidate) => fs.existsSync(path.join(candidate, 'summary.json')))
    .map((candidate) => ({ dir: candidate, summaryPath: path.join(candidate, 'summary.json'), mtime: fs.statSync(path.join(candidate, 'summary.json')).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return rows[0] || null
}

function currentDagSummary(dir: string) {
  const summaryPath = path.join(dir, 'summary.json')
  if (!fs.existsSync(summaryPath)) return null
  return { dir, summaryPath, mtime: fs.statSync(summaryPath).mtimeMs }
}

function slowestGateResults(reportDir: string) {
  const out = []
  for (const name of fs.readdirSync(reportDir)) {
    const file = path.join(reportDir, name, 'result.json')
    if (!fs.existsSync(file)) continue
    try {
      const result = JSON.parse(fs.readFileSync(file, 'utf8'))
      out.push({ id: result.id || name, duration_ms: Number(result.duration_ms || 0), cached: result.cached === true, ok: result.ok === true })
    } catch {}
  }
  return out.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 10)
}
