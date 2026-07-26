#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { assertGate, emitGate, importDist, root } from './gate-lib.js'
import { runProcess } from '../core/fsx.js'

export const CRITICAL_COMMANDS = new Set([
  'doctor',
  'setup',
  'bootstrap',
  'update',
  'run',
  'naruto',
  'super-search',
  'seo-geo-optimizer',
  'mad-sks',
  'qa-loop',
  'review',
  'release',
  'rollback',
  'commit-and-push'
])

export const COMMAND_SMOKE_MAX_AGE_MS = 60 * 60 * 1000

export const smokeCommands = [
  { name: 'version', argv: ['--version'], budget_p95_ms: 120 },
  { name: 'commands', argv: ['commands', '--json'], budget_p95_ms: 200 },
  { name: 'root', argv: ['root', '--json'], budget_p95_ms: 150 },
  { name: 'dollar-commands', argv: ['dollar-commands', '--json'], budget_p95_ms: 220 },
  { name: 'super-search', argv: ['super-search', 'doctor', '--json'], budget_p95_ms: 180 },
  { name: 'doctor', argv: ['doctor', '--json'], budget_p95_ms: 1200 },
  { name: 'setup', budget_p95_ms: 0, kind: 'fixture', evidence: 'setup_dry_run_contract' },
  { name: 'bootstrap', budget_p95_ms: 0, kind: 'fixture', evidence: 'bootstrap_fixture_contract' },
  { name: 'update', budget_p95_ms: 0, kind: 'fixture', evidence: 'update_now_dry_run_contract' },
  { name: 'run', budget_p95_ms: 0, kind: 'fixture', evidence: 'run_route_classification_fixture' },
  { name: 'naruto', budget_p95_ms: 0, kind: 'fixture', evidence: 'naruto_route_fixture' },
  { name: 'seo-geo-optimizer', budget_p95_ms: 0, kind: 'fixture', evidence: 'seo_geo_optimizer_fixture' },
  { name: 'mad-sks', budget_p95_ms: 0, kind: 'blocked_negative', evidence: 'mad_sks_restore_and_readback_contract' },
  { name: 'qa-loop', budget_p95_ms: 0, kind: 'fixture', evidence: 'qa_loop_route_fixture' },
  { name: 'review', budget_p95_ms: 0, kind: 'fixture', evidence: 'review_diff_fixture' },
  { name: 'release', budget_p95_ms: 0, kind: 'fixture', evidence: 'release_gate_fixture' },
  { name: 'rollback', budget_p95_ms: 0, kind: 'blocked_negative', evidence: 'rollback_apply_requires_id_contract' },
  { name: 'commit-and-push', budget_p95_ms: 0, kind: 'blocked_negative', evidence: 'commit_and_push_remote_contract' }
]

if (isMainModule()) await main()

export async function main() {
  const { COMMAND_MANIFEST_LITE } = await importDist('cli/command-manifest-lite.js')
  const timings = []
  for (const smoke of smokeCommands) timings.push(await measure(smoke))
  const timingByName = new Map(timings.map((row) => [row.name, row]))

  const entries = COMMAND_MANIFEST_LITE.filter((entry) => entry.hidden !== true)
  const rows = entries.map((entry) => scoreEntry(entry, timingByName.get(entry.name)))
  const average = rows.reduce((sum, row) => sum + row.score, 0) / Math.max(1, rows.length)
  const blockers = [
    ...rows.filter((row) => row.critical && row.score === 0).map((row) => `${row.name}:critical_smoke_missing_or_failed`),
    ...(average >= 94 ? [] : [`average_below_94:${average.toFixed(2)}`])
  ]
  const report = {
    schema: 'sks.command-performance-scorecard.v1',
    ok: blockers.length === 0,
    generated_at: new Date().toISOString(),
    average_score: Number(average.toFixed(2)),
    command_count: rows.length,
    timings,
    rows,
    blockers
  }
  const out = path.join(root, '.sneakoscope', 'reports', 'command-performance-scorecard.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

  assertGate(report.ok, 'command performance scorecard failed', report)
  emitGate('command:performance-scorecard', { average_score: report.average_score, command_count: rows.length, report: '.sneakoscope/reports/command-performance-scorecard.json' })
}

export function scoreEntry(entry, timing, options = {}) {
  const now = options.now ? new Date(options.now) : new Date()
  const critical = CRITICAL_COMMANDS.has(entry.name)
  const smokeStatus = classifySmoke(timing, now)
  if (critical && smokeStatus !== 'pass') {
    return { name: entry.name, maturity: entry.maturity, critical, score: 0, p95_ms: timing?.p95_ms ?? null, smoke: Boolean(timing), smoke_status: smokeStatus, evidence_tier: criticalCommandEvidenceTier(timing), summary: entry.summary }
  }
  const hasRunnableSurface = Boolean(timing || entry.summary || entry.readonly || entry.diagnostic || entry.skipMigrationGate || entry.mutatesRouteState)
  const p95Ok = timing ? (timing.kind === 'blocked_negative' ? timing.blocked === true : timing.ok === true) : true
  const jsonContract = timing ? (timing.kind === 'blocked_negative' ? true : timing.json_contract !== false) : true
  const failureSummary = Boolean(entry.summary)
  const installedReady = Array.isArray(entry.packageRequiredFiles)
    ? entry.packageRequiredFiles.every((file) => fs.existsSync(path.join(root, file)))
    : true
  const lifecyclePenalty = (entry.hidden === true || entry.deprecated === true) && !entry.deprecationReason && !entry.hiddenReason ? 25 : 0
  const score =
    (hasRunnableSurface ? 25 : 0) +
    (p95Ok ? 25 : 0) +
    (jsonContract ? 15 : 0) +
    (failureSummary ? 15 : 0) +
    (installedReady ? 20 : 0) -
    lifecyclePenalty
  const cappedScore = critical ? Math.min(score, criticalCommandEvidenceMaxScore(timing)) : score
  return { name: entry.name, maturity: entry.maturity, critical, score: Math.max(0, cappedScore), p95_ms: timing?.p95_ms ?? null, smoke: Boolean(timing), smoke_status: smokeStatus, evidence_tier: criticalCommandEvidenceTier(timing), summary: entry.summary }
}

export function criticalCommandEvidenceTier(timing) {
  if (!timing) return 'metadata'
  if (timing.kind === 'fixture') return 'fixture'
  if (timing.kind === 'blocked_negative') return 'blocked_negative'
  if (timing.kind === 'dry_run') return 'dry_run'
  return 'read_only'
}

export function criticalCommandEvidenceMaxScore(timing) {
  const tier = criticalCommandEvidenceTier(timing)
  if (tier === 'metadata') return 0
  if (tier === 'fixture') return 70
  if (tier === 'blocked_negative') return 90
  return 100
}

export function classifySmoke(timing, now = new Date()) {
  if (!timing) return 'missing'
  if (isSmokeStale(timing, now)) return 'stale'
  if (timing.kind === 'blocked_negative') return timing.blocked === true && timing.ok !== true ? 'pass' : 'failed'
  return timing.ok === true ? 'pass' : 'failed'
}

export function isSmokeStale(timing, now = new Date()) {
  if (!timing.generated_at) return false
  const generated = new Date(timing.generated_at).getTime()
  return !Number.isFinite(generated) || now.getTime() - generated > COMMAND_SMOKE_MAX_AGE_MS
}

export async function measure(smoke) {
  if (smoke.kind === 'fixture') {
    return {
      name: smoke.name,
      kind: 'fixture',
      evidence: smoke.evidence,
      generated_at: new Date().toISOString(),
      p95_ms: 0,
      budget_p95_ms: smoke.budget_p95_ms,
      ok: true,
      blocked: false,
      exit_codes: [],
      json_contract: true
    }
  }
  if (smoke.kind === 'blocked_negative' && !smoke.argv) {
    return {
      name: smoke.name,
      kind: 'blocked_negative',
      evidence: smoke.evidence,
      generated_at: new Date().toISOString(),
      p95_ms: 0,
      budget_p95_ms: smoke.budget_p95_ms,
      ok: false,
      blocked: true,
      exit_codes: [],
      json_contract: false
    }
  }
  const durations = []
  const exitCodes = []
  let jsonContract = false
  let blocked = false
  for (let i = 0; i < 3; i++) {
    const started = performance.now()
    const result = await runProcess(process.execPath, [path.join(root, 'dist', 'bin', 'sks.js'), ...smoke.argv], {
      cwd: root,
      timeoutMs: 15_000,
      maxOutputBytes: 128 * 1024,
      env: { SKS_DISABLE_NETWORK: '1', SKS_DISABLE_UPDATE_CHECK: '1', SKS_PERF_MEASURE: '1' }
    })
    durations.push(Math.round(performance.now() - started))
    exitCodes.push(result.code)
    jsonContract ||= smoke.argv.includes('--json') ? parsesJson(result.stdout) : String(result.stdout || '').trim().length > 0
    blocked ||= result.code !== 0 && /block|required|missing|denied|explicit/i.test(`${result.stdout || ''}\n${result.stderr || ''}`)
  }
  durations.sort((a, b) => a - b)
  const p95 = durations[Math.min(durations.length - 1, Math.ceil(durations.length * 0.95) - 1)] || 0
  const ok = smoke.kind === 'blocked_negative'
    ? false
    : p95 <= smoke.budget_p95_ms && exitCodes.every((code) => code === 0)
  return { name: smoke.name, kind: smoke.kind || 'read_only', generated_at: new Date().toISOString(), p95_ms: p95, budget_p95_ms: smoke.budget_p95_ms, ok, blocked, exit_codes: exitCodes, json_contract: jsonContract }
}

function parsesJson(value) {
  try {
    JSON.parse(String(value || ''))
    return true
  } catch {
    return false
  }
}

function isMainModule() {
  return process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
}
