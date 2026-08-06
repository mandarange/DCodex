#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist, readJson, readText } from './gate-lib.js'

const pkg = readJson('package.json')
const manifest = readJson('release-gates.v2.json')
const runner = readText('src/core/release/release-gate-dag.ts')
const runnerCli = readText('src/scripts/release-gate-dag-runner.ts')
const hermeticEnv = readText('src/core/release/release-gate-hermetic-env.ts')
const scheduler = readText('src/core/release/release-gate-scheduler.ts')
const cache = readText('src/core/release/release-gate-cache-v2.ts')
const retiredContractNoteField = ['contract', 'note'].join('_')

const releaseCheck = String(pkg.scripts['release:check'] || '')
const delegatedReleaseCheck = releaseCheck.match(/^npm run ([^\s&]+)(?:\s+--silent)?$/)?.[1]
const effectiveReleaseCheck = delegatedReleaseCheck ? String(pkg.scripts[delegatedReleaseCheck] || '') : releaseCheck

assertGate(
  effectiveReleaseCheck.includes('release-gate-dag-runner.js'),
  'release:check must execute DAG runner',
  { release_check: releaseCheck, delegated_release_check: delegatedReleaseCheck || null, effective_release_check: effectiveReleaseCheck }
)
assertGate(!/&&\s*npm run\s+\w/.test(releaseCheck.replace('npm run build --silent &&', '')), 'release:check must not be a giant npm-run chain', releaseCheck)
assertGate(!/&&\s*npm run\s+\w/.test(effectiveReleaseCheck.replace('npm run build:incremental --silent &&', '').replace('npm run build --silent &&', '')), 'effective release:check must not be a giant npm-run chain', effectiveReleaseCheck)
assertGate(!pkg.scripts['release:check:legacy'], 'retired release:check:legacy alias must stay removed')
assertGate(pkg.scripts['release:real-check'] === 'node ./dist/scripts/release-real-check.js', 'release:real-check must expose the canonical environment-dependent proof runner')
assertGate(manifest.schema === 'sks.release-gates.v2' && manifest.gates.length >= 10, 'release-gates.v2 manifest must exist with nodes', manifest)
assertGate(
  manifest.gates.every((row: any) => row.output_contract === 'sks.gate-result.v2' && !Object.hasOwn(row, retiredContractNoteField)),
  'every release gate must declare only the strict current output contract',
  manifest.gates.filter((row: any) => row.output_contract !== 'sks.gate-result.v2' || Object.hasOwn(row, retiredContractNoteField)).map((row: any) => row.id)
)
for (const gateId of [
  'scheduler:comprehensive',
  'doctor:fix-proves-codex-read',
  'release:batch-runner-comprehensive',
  'release:parallel-speed-budget'
]) {
  const gate = manifest.gates.find((row: any) => row.id === gateId)
  assertGate(gate?.resource?.includes('timing-sensitive'), `${gateId} must run in timing-sensitive isolation`, gate)
}
assertGate(runner.includes('Promise.race') && scheduler.includes('pickLaunchableReleaseGates'), 'DAG runner must schedule independent gates concurrently')
assertGate(runner.includes('readReleaseGateCacheRecord') && cache.includes('duration_ms') && cache.includes('RELEASE_GATE_CACHE_V2_SCHEMA'), 'DAG runner must use release gate cache v2 module with cached duration evidence')
assertGate(runner.includes('cpu_time_saved_ms') && runner.includes('peak_running') && runner.includes('budget_snapshot'), 'DAG summary must include CPU time saved, peak running gates, and resource budget proof')
assertGate(runner.includes('sks.five-minute-completion-certificate.v1') && runner.includes('sks.affected-gate-graph.v1') && cache.includes('releaseGateProofBankFile'), 'DAG runner must emit completion certificates, affected graph, and proof-bank cache path')
assertGate(runner.includes('detached: process.platform') && runner.includes('killGateProcessTree') && runner.includes('timed_out'), 'DAG runner must kill timed-out gate process trees and record timeout evidence')
assertGate(runner.includes('normalizeReleaseGateOutput') && runner.includes('gate_result: normalized.gate_result'), 'DAG runner must normalize and verify every child through the strict gate-result contract')
assertGate(runnerCli.includes('GATE_RESULT_CONTRACT_MODE') && runnerCli.includes('contract_mode: GATE_RESULT_CONTRACT_MODE'), 'DAG CLI must emit the strict current gate-result contract')
assertGate(runner.includes('pruneOldReleaseGateRunDirs') && runner.includes('SKS_RELEASE_GATE_RUN_RETENTION'), 'DAG runner must prune stale release-gate run reports before they exhaust local disk')
assertGate(runnerCli.includes('ensureCurrentMigrationBeforeCommand') && runnerCli.includes('release-gate-runner-preflight'), 'DAG runner CLI must self-heal project migration before hermetic gates run')
assertGate(hermeticEnv.includes('SKS_UPDATE_MIGRATION_GATE_DISABLED'), 'hermetic release gates must not rewrite project migration receipts from temporary HOME roots')
assertGate(hermeticEnv.includes("input.gate.id === 'migration:current-surface-e2e'") && hermeticEnv.includes('delete gateEnv.SKS_UPDATE_MIGRATION_GATE_DISABLED'), 'migration:current-surface-e2e must explicitly remove an inherited disable flag while testing migration retry/repair behavior')
const currentSurfaceMigration = manifest.gates.find((row: any) => row.id === 'migration:current-surface-e2e')
assertGate(currentSurfaceMigration?.cache?.inputs?.includes('src/core/**'), 'migration:current-surface-e2e cache must cover every directly or transitively executed core source')

const dag = await importDist('core/release/release-gate-dag.js')
const fsx = await importDist('core/fsx.js')
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-dag-timeout-'))
await fsx.writeJsonAtomic(path.join(fixtureRoot, 'release-gates.v2.json'), {
  schema: 'sks.release-gates.v2',
  gates: [{
    id: 'dag:timeout',
    command: `${process.execPath} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"`,
    deps: [],
    resource: ['cpu-light', 'fs-read'],
    side_effect: 'hermetic',
    timeout_ms: 50,
    output_contract: 'sks.gate-result.v2',
    cache: { enabled: false, inputs: [] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  }]
})
const timeoutRun = await dag.runReleaseGateDag({ root: fixtureRoot, preset: 'release', full: true, noCache: true })
const timeoutFailure = timeoutRun.failures.find((row: any) => row.id === 'dag:timeout')
const timeoutDuration = timeoutRun.slowest_gates.find((row: any) => row.id === 'dag:timeout')?.duration_ms || 0
assertGate(timeoutRun.ok === false && timeoutRun.failed === 1, 'DAG timeout fixture must fail the run', timeoutRun)
assertGate(timeoutFailure?.exit_code === 124 && timeoutFailure?.timed_out === true, 'DAG timeout fixture must record exit 124 and timed_out evidence', timeoutRun)
assertGate(String(timeoutFailure?.stderr_tail || '').includes('release_gate_timeout:dag:timeout:50ms'), 'DAG timeout fixture must include timeout marker in stderr tail', timeoutRun)
assertGate(timeoutDuration >= 1400, 'DAG timeout fixture must wait for hard-kill cleanup before resolving', timeoutRun)

const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-dag-cache-'))
await fsx.writeJsonAtomic(path.join(cacheRoot, 'package.json'), { name: 'cache-fixture', version: '0.0.0' })
await fsx.writeJsonAtomic(path.join(cacheRoot, 'release-gates.v2.json'), {
  schema: 'sks.release-gates.v2',
  gates: [{
    id: 'dag:cached-duration',
    command: `${process.execPath} -e "const until=Date.now()+80; while(Date.now()<until){}"`,
    deps: [],
    resource: ['cpu-light', 'fs-read'],
    side_effect: 'hermetic',
    timeout_ms: 5000,
    output_contract: 'sks.gate-result.v2',
    cache: { enabled: true, inputs: [] },
    isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
    preset: ['release']
  }]
})
const firstCacheRun = await dag.runReleaseGateDag({ root: cacheRoot, preset: 'release', full: true })
const secondCacheRun = await dag.runReleaseGateDag({ root: cacheRoot, preset: 'release', full: true })
const cachedDuration = secondCacheRun.slowest_gates.find((row: any) => row.id === 'dag:cached-duration')?.duration_ms || 0
assertGate(firstCacheRun.ok === true && firstCacheRun.cached === 0, 'DAG cache fixture first run must execute the gate', firstCacheRun)
assertGate(secondCacheRun.ok === true && secondCacheRun.cached === 1, 'DAG cache fixture second run must hit cache', secondCacheRun)
assertGate(cachedDuration > 0, 'DAG cache fixture must retain nonzero cached duration evidence', secondCacheRun)
assertGate(secondCacheRun.sum_gate_ms >= cachedDuration, 'DAG cache fixture must include cached duration in sum_gate_ms evidence', secondCacheRun)
assertGate(secondCacheRun.completion_certificate?.schema === 'sks.five-minute-completion-certificate.v1', 'DAG cache fixture must include completion certificate', secondCacheRun)
assertGate(secondCacheRun.affected_graph?.proof_bank_file?.includes('.sneakoscope/proof-bank/gates/cache-v2.json'), 'DAG cache fixture must expose proof bank path', secondCacheRun)
assertGate(await exists(path.join(cacheRoot, '.sneakoscope', 'reports', 'release-gates', secondCacheRun.run_id, 'completion-certificate.json')), 'DAG cache fixture must write completion-certificate artifact')
assertGate(await exists(path.join(cacheRoot, '.sneakoscope', 'proof-bank', 'gates', 'cache-v2.json')), 'DAG cache fixture must mirror successful proof into proof bank')

const retentionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-dag-retention-'))
const retentionBase = path.join(retentionRoot, '.sneakoscope', 'reports', 'release-gates')
await fs.mkdir(retentionBase, { recursive: true })
for (let i = 0; i < 5; i++) {
  const dir = path.join(retentionBase, `rg-2026-06-01T00-00-0${i}-000Z-${i}`)
  await fs.mkdir(dir, { recursive: true })
  await fsx.writeJsonAtomic(path.join(dir, 'summary.json'), { ok: true, index: i })
  const date = new Date(Date.UTC(2026, 5, 1, 0, 0, i))
  await fs.utimes(path.join(dir, 'summary.json'), date, date)
}
await fsx.writeJsonAtomic(path.join(retentionBase, 'cache-v2.json'), {})
const retention = await dag.pruneOldReleaseGateRunDirs(retentionRoot, { keep: 2, preserveRunId: 'rg-2026-06-01T00-00-00-000Z-0' })
const remainingRetentionRuns = (await fs.readdir(retentionBase)).filter((name) => name.startsWith('rg-')).sort()
assertGate(retention.removed === 2 && retention.kept === 3, 'DAG retention fixture must remove stale runs while preserving requested run', retention)
assertGate(remainingRetentionRuns.length === 3 && remainingRetentionRuns.includes('rg-2026-06-01T00-00-00-000Z-0'), 'DAG retention fixture must keep newest runs and preserved current run', { remainingRetentionRuns, retention })
assertGate(await exists(path.join(retentionBase, 'cache-v2.json')), 'DAG retention fixture must not remove cache-v2.json')

emitGate('release:dag-runner', { gates: manifest.gates.length, default_script: releaseCheck, effective_script: effectiveReleaseCheck })

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}
