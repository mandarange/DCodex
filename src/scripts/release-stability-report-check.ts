#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, readJson, root } from './gate-lib.js'

const manifest = readJson('release-gates.v2.json')
const currentRunDir = process.env.SKS_REPORT_DIR ? path.dirname(process.env.SKS_REPORT_DIR) : null
const latestReleaseRun = currentRunDir || latestDir(path.join(root, '.sneakoscope', 'reports', 'release-gates'))
const latestSummary = currentRunDir ? summarizeCurrentRun(currentRunDir) : latestReleaseRun ? readJsonIfExists(path.join(latestReleaseRun, 'summary.json')) : null
const zellijReportPath = path.join(root, '.sneakoscope', 'reports', 'zellij-worker-pane-real-ui-blackbox.json')
const zellij = fs.existsSync(zellijReportPath) ? JSON.parse(fs.readFileSync(zellijReportPath, 'utf8')) : null
const releaseSummaryRequired = Boolean(currentRunDir || process.env.SKS_RELEASE_STABILITY_REQUIRE_SUMMARY === '1')
const zellijRequired = Boolean(zellij || process.env.SKS_RELEASE_STABILITY_REQUIRE_ZELLIJ === '1')
const requiredGateIds = [
  'release:dag-runner',
  'release:parallel-speed-budget',
  'git:worktree-manifest-append',
  'git:worktree-dirty-main-detection',
  'git:worktree-untracked-diff',
  'git:worktree-diff-envelope',
  'git:worktree-integration-primary',
  'git:worktree-dirty-lock',
  'naruto:worktree-coding:blackbox',
  'release:proof-truth'
]
const manifestIds = new Set(manifest.gates.map((gate) => gate.id))
const missing = requiredGateIds.filter((id) => !manifestIds.has(id))
const score = computeScore({ missing, latestSummary, zellij, releaseSummaryRequired, zellijRequired })
const report = {
  schema: 'sks.release-stability-report.v1',
  ok: score >= 9.5 && missing.length === 0 && (!releaseSummaryRequired || latestSummary?.ok === true) && (!zellijRequired || zellij?.ok === true),
  target_score: 9.5,
  score,
  manifest_gate_count: manifest.gates.length,
  latest_release_summary: latestSummary ? path.relative(root, path.join(latestReleaseRun, 'summary.json')) : null,
  release_check_required: releaseSummaryRequired,
  release_check_ok: latestSummary?.ok === true,
  release_check_passed: latestSummary?.completed || 0,
  release_check_failed: latestSummary?.failed || 0,
  zellij_real_worker_panes_required: zellijRequired,
  zellij_real_worker_panes_ok: zellij?.ok === true,
  zellij_real_worker_panes: zellij?.real_pane_ids || 0,
  missing_required_gates: missing,
  blockers: []
}
if (!report.ok) {
  report.blockers = [
    ...(score >= 9.5 ? [] : ['stability_score_below_target']),
    ...(missing.length ? ['required_release_gate_missing'] : []),
    ...(!releaseSummaryRequired || latestSummary?.ok === true ? [] : ['latest_release_check_not_green']),
    ...(!zellijRequired || zellij?.ok === true ? [] : ['zellij_real_worker_panes_not_green'])
  ]
}
fs.mkdirSync(path.join(root, '.sneakoscope', 'reports'), { recursive: true })
fs.writeFileSync(path.join(root, '.sneakoscope', 'reports', 'release-stability-report.json'), `${JSON.stringify(report, null, 2)}\n`)
assertGate(report.ok, 'release stability report must meet 9.5+ target', report)
emitGate('release:stability-report', report)

function computeScore({ missing, latestSummary, zellij, releaseSummaryRequired, zellijRequired }) {
  let score = 10
  score -= missing.length * 0.25
  if (releaseSummaryRequired && latestSummary?.ok !== true) score -= 1.5
  if ((latestSummary?.failed || 0) > 0) score -= 1
  if (zellijRequired && zellij?.ok !== true) score -= 1
  return Number(Math.max(0, score).toFixed(2))
}

function latestDir(dir) {
  if (!fs.existsSync(dir)) return null
  const dirs = fs.readdirSync(dir)
    .map((name) => path.join(dir, name))
    .filter((candidate) => fs.statSync(candidate).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return dirs[0] || null
}

function summarizeCurrentRun(runDir) {
  const results = []
  for (const entry of fs.readdirSync(runDir)) {
    const result = readJsonIfExists(path.join(runDir, entry, 'result.json'))
    if (result && result.id !== 'release:stability-report') results.push(result)
  }
  if (!results.length) return null
  const failed = results.filter((result) => result.ok !== true)
  return {
    schema: 'sks.release-gate-current-run-summary.v1',
    ok: failed.length === 0,
    completed: results.filter((result) => result.ok === true).length,
    failed: failed.length
  }
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
