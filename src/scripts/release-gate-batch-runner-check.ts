#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const batch = await importDist('core/release/release-gate-batch-runner.js')
assertGate(typeof batch.runReleaseGateBatch === 'function', 'release batch runner export missing')
assertGate(typeof batch.isReleaseGateBatchable === 'function', 'release batchable predicate export missing')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-release-batch-'))
const reportRoot = path.join(root, 'reports')
const base = {
  deps: [],
  resource: ['cpu-light', 'fs-read'],
  side_effect: 'hermetic',
  timeout_ms: 30000,
  cache: { enabled: false, inputs: [] },
  isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' },
  preset: ['release']
}
const envProofScript = [
  "if(process.env.SKS_GATE_ID!=='batch:pass')process.exit(21)",
  "if(process.env.SKS_DISABLE_GLOBAL_CONFIG_MUTATION!=='1')process.exit(22)",
  "if(process.env.SKS_DISABLE_REAL_MODEL_CALLS!=='1')process.exit(23)",
  "if(!String(process.env.HOME||'').includes('sks-gate'))process.exit(24)",
  "if(!String(process.env.CODEX_HOME||'').includes('sks-gate'))process.exit(25)",
  "if(!String(process.env.SKS_REPORT_DIR||'').includes('batch-pass'))process.exit(26)"
].join(';')
const passGate = { ...base, id: 'batch:pass', command: `${process.execPath} -e ${JSON.stringify(envProofScript)}` }
const failGate = { ...base, id: 'batch:fail', command: `${process.execPath} -e "process.exit(7)"` }
const timeoutGate = { ...base, id: 'batch:timeout', timeout_ms: 50, command: `${process.execPath} -e "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"` }
const zellijGate = { ...base, id: 'batch:zellij-real', resource: ['zellij-real'], side_effect: 'real-env', command: `${process.execPath} -e "process.exit(0)"` }

assertGate(batch.isReleaseGateBatchable(passGate) === true, 'hermetic cpu-light fs-read gate must be batchable')
assertGate(batch.isReleaseGateBatchable(zellijGate) === false, 'zellij-real gate must not be batchable')

const result = await batch.runReleaseGateBatch(root, [passGate, failGate], { concurrency: 2, reportRoot })
assertGate(result.ok === false && result.failed === 1, 'one failed child gate must fail the batch', result)
assertGate(result.results.some((row: any) => row.id === 'batch:fail' && row.ok === false && row.exit_code === 7), 'batch result must report exact failed child id', result)
assertGate(fs.existsSync(path.join(reportRoot, 'batch-pass', 'result.json')) && fs.existsSync(path.join(reportRoot, 'batch-fail', 'result.json')), 'batch runner must preserve individual result JSON files')
assertGate(result.results.some((row: any) => row.id === 'batch:pass' && row.ok === true), 'batch runner must execute children with hermetic release-gate environment', result)
const timeoutResult = await batch.runReleaseGateBatch(root, [timeoutGate], { concurrency: 1, reportRoot })
assertGate(timeoutResult.results.some((row: any) => row.id === 'batch:timeout' && row.ok === false && row.exit_code === 124 && row.timed_out === true), 'batch runner must report timed-out child process trees explicitly', timeoutResult)
assertGate(timeoutResult.results.some((row: any) => row.id === 'batch:timeout' && row.duration_ms >= 1400), 'batch runner must wait for timed-out process tree hard-kill cleanup before resolving', timeoutResult)
const dateNowDescriptor = Object.getOwnPropertyDescriptor(Date, 'now')
let regressingWallClock = Date.now()
Object.defineProperty(Date, 'now', {
  configurable: true,
  value: () => {
    regressingWallClock -= 1000
    return regressingWallClock
  }
})
try {
  const clockRollbackGate = {
    ...base,
    id: 'batch:clock-rollback',
    command: `${process.execPath} -e "setTimeout(() => process.exit(0), 50)"`
  }
  const clockRollbackResult = await batch.runReleaseGateBatch(root, [clockRollbackGate], { concurrency: 1, reportRoot })
  assertGate(
    clockRollbackResult.results.some((row: any) => row.id === 'batch:clock-rollback' && row.ok === true && row.duration_ms > 0),
    'batch runner duration evidence must remain positive across wall-clock rollback',
    clockRollbackResult
  )
} finally {
  if (dateNowDescriptor) Object.defineProperty(Date, 'now', dateNowDescriptor)
}
emitGate('release:gate-batch-runner', { batch_size: result.batch_size, failed_child: 'batch:fail' })
