#!/usr/bin/env node
// @ts-nocheck
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'

const started = Date.now()
const result = spawnSync(process.execPath, ['dist/bin/sks.js', 'doctor', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024
})
const elapsedMs = Date.now() - started
const parsed = JSON.parse(result.stdout || '{}')

assertGate(result.status === 0, 'doctor --json must exit 0', { status: result.status, stderr: result.stderr.slice(-2000), stdout: result.stdout.slice(-2000) })
assertGate(parsed.schema === 'sks.doctor-status.v3', 'doctor --json fast path must emit v3 doctor status schema', parsed)
assertGate(parsed.ok === true, 'doctor --json fast path must report fast readonly success only', parsed)
assertGate(parsed.status === 'fast_readonly_ok', 'doctor --json fast path must use fast_readonly_ok status', parsed)
assertGate(parsed.diagnostic_depth === 'fast', 'doctor --json fast path must declare fast diagnostic depth', parsed)
assertGate(parsed.deep_diagnostics_skipped === true, 'doctor --json fast path must explicitly skip deep diagnostics', parsed)
assertGate(parsed.deep_ok === null, 'doctor --json fast path must not claim deep diagnostics passed', parsed)
assertGate(parsed.not_counted_as_full_doctor === true, 'doctor --json fast path must not count as full doctor', parsed)
assertGate(Array.isArray(parsed.next_actions) && parsed.next_actions.some((action) => String(action).includes('sks doctor --full --json')), 'doctor --json fast path must point to full diagnostics next action', parsed.next_actions)
assertGate(parsed.doctor_fix_transaction === null, 'doctor --json no-fix must not run fix transaction', parsed.doctor_fix_transaction)
assertGate(parsed.repair?.setup === null, 'doctor --json no-fix must not run setup repair', parsed.repair?.setup)
assertGate(parsed.repair?.sks_temp_sweep?.skipped === true, 'doctor --json no-fix must not sweep runtime state', parsed.repair?.sks_temp_sweep)
assertGate(elapsedMs <= 1200, 'doctor --json fast path must stay under 1200ms p95 target in this gate', { elapsed_ms: elapsedMs })

emitGate('doctor:fastpath', { elapsed_ms: elapsedMs })
