#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReleaseGateDag, type ReleaseGateDagRunResult } from '../core/release/release-gate-dag.js'
import {
  releaseAuthorizationSnapshot,
  type ReleaseAuthorizationSnapshot
} from '../core/release/release-authorization-snapshot.js'
import { ensureDistFresh } from './lib/ensure-dist-fresh.js'
import { ensureCurrentMigrationBeforeCommand } from '../core/update/update-migration-state.js'
import { GATE_RESULT_CONTRACT, GATE_RESULT_CONTRACT_MODE } from '../core/commands/gate-result-contract.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
process.env.SKS_RELEASE_GATE_CACHE_MEMOIZE ||= '1'
const freshness = ensureDistFresh({ rebuild: false })
if (!freshness.ok) {
  console.error(`SKS release gate DAG blocked: dist is stale (${freshness.issues.join(', ')}).`)
  console.error('Run npm run build:incremental first.')
  process.exit(1)
}
const migration = await ensureCurrentMigrationBeforeCommand({
  command: 'release-gate-runner-preflight',
  cwd: root
})
if (!migration.ok) {
  console.error('SKS release gate DAG blocked: project migration preflight failed.')
  console.error(`Stage: ${migration.failed_stage_id || migration.status}`)
  for (const blocker of migration.blockers) console.error(`Required blocker: ${blocker}`)
  for (const warning of migration.warnings) console.error(`Optional warning: ${warning}`)
  console.error(`Receipt: ${migration.receipt_path}`)
  process.exit(1)
}
const args = process.argv.slice(2)
const presetIndex = args.indexOf('--preset')
const preset = presetIndex >= 0 ? args[presetIndex + 1] : 'release'
const gateIndex = args.indexOf('--gate')
const gate = gateIndex >= 0 ? args[gateIndex + 1] : null
if (gateIndex >= 0 && (!gate || gate.startsWith('--'))) failRunner('release_gate_only_selection_id_missing')
const changedSinceIndex = args.indexOf('--changed-since')
const changedSince = changedSinceIndex >= 0 ? (args[changedSinceIndex + 1] || null) : null
const slaIndex = args.indexOf('--sla')
const slaMs = slaIndex >= 0 ? parseDurationMs(args[slaIndex + 1] || '') : null
let authorizationSnapshot: ReleaseAuthorizationSnapshot
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  authorizationSnapshot = releaseAuthorizationSnapshot(root, pkg)
} catch (error) {
  failRunner(`release_authorization_snapshot_failed:${error instanceof Error ? error.message : String(error)}`)
}

let result: ReleaseGateDagRunResult
try {
  result = await runReleaseGateDag({
    root,
    ...(gate ? { onlyGateIds: [gate] } : preset === undefined ? {} : { preset }),
    changedSince,
    slaMs,
    full: args.includes('--full'),
    explain: args.includes('--explain'),
    noCache: args.includes('--no-cache'),
    failFast: args.includes('--fail-fast'),
    useGatePacks: args.includes('--use-gate-packs'),
    releaseAuthorizationSnapshot: authorizationSnapshot
  })
} catch (error) {
  failRunner(error instanceof Error ? error.message : String(error || 'release_gate_dag_failed'))
}

console.log(`SKS Release DAG
  gates: ${result.total_gates} total, ${result.selected_gates} selected, ${result.cached} cached
  affected: ${result.affected_selection?.mode || 'full'} selected=${result.selected_gate_ids.length} skipped=${result.skipped_by_affected.length}
  concurrency: ${result.budget_summary}
  peak_running: ${result.peak_running}
  completed: ${result.completed} pass, ${result.failed} fail
  wall: ${(result.wall_ms / 1000).toFixed(1)}s
  parallelism_gain: ${result.parallelism_gain}
  cpu_time_saved: ${(result.cpu_time_saved_ms / 1000).toFixed(1)}s
  critical_path: ${(result.critical_path_ms / 1000).toFixed(1)}s
  certificate: ${result.completion_certificate.confidence} sla=${(result.completion_certificate.sla_ms / 1000).toFixed(0)}s met=${result.completion_certificate.sla_met}
  report: ${result.report_dir}`)

const gateResult = {
  schema: GATE_RESULT_CONTRACT,
  contract_mode: GATE_RESULT_CONTRACT_MODE,
  ok: result.ok === true,
  blockers: result.ok ? [] : result.failures.map((failure) => `release_gate_failed:${failure.id}`),
  summary: {
    total_gates: result.total_gates,
    selected_gates: result.selected_gates,
    cached: result.cached,
    completed: result.completed,
    failed: result.failed,
    report_dir: result.report_dir
  }
}
console.log(JSON.stringify(gateResult))

if (!result.ok) {
  for (const failure of result.failures) {
    console.error(`[fail] ${failure.id} exit=${failure.exit_code}\n${failure.stderr_tail}`)
  }
  process.exit(1)
}

function failRunner(blocker: string): never {
  console.error(`SKS Release DAG blocked: ${blocker}`)
  console.log(JSON.stringify({ schema: GATE_RESULT_CONTRACT, contract_mode: GATE_RESULT_CONTRACT_MODE, ok: false, blockers: [blocker] }))
  process.exit(1)
}

function parseDurationMs(value: string): number | null {
  const match = String(value || '').trim().match(/^(\d+(?:\.\d+)?)(ms|s|m)?$/i)
  if (!match) return null
  const amount = Number(match[1])
  const unit = (match[2] || 'ms').toLowerCase()
  if (!Number.isFinite(amount) || amount <= 0) return null
  if (unit === 'm') return Math.floor(amount * 60_000)
  if (unit === 's') return Math.floor(amount * 1000)
  return Math.floor(amount)
}
