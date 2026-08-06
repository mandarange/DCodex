#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { runReleaseGateBatch } from '../core/release/release-gate-batch-runner.js'
import { assertGate, emitGate, root } from './gate-lib.js'
const reportRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-release-full-'))
const gates = Array.from({ length: 80 }, (_, i) => ({ id: `synthetic:${i + 1}`, command: `${process.execPath} -e \"setTimeout(()=>process.exit(0),1000)\"`, deps: [], resource: ['cpu-light', 'fs-read'], side_effect: 'hermetic', timeout_ms: 15000, output_contract: 'sks.gate-result.v2', cache: { enabled: false, inputs: [] }, isolation: { home: 'temp', codex_home: 'temp', report_dir: 'per-gate' }, preset: ['release'] }))
const started = performance.now()
const result = await runReleaseGateBatch(root, gates, { concurrency: 40, reportRoot })
const wallMs = Math.max(1, Math.round(performance.now() - started))
const completedDurations = result.results
  .map((row) => Number(row.duration_ms || 0))
  .filter((duration) => Number.isFinite(duration) && duration > 0)
const observedSequentialMs = completedDurations.reduce((total, duration) => total + duration, 0)
const slowestGateMs = Math.max(1, ...completedDurations)
const safeConcurrency = 4
const expectedWaves = Math.ceil(gates.length / safeConcurrency)
const dynamicWallBudgetMs = Math.max(20_000, Math.ceil((slowestGateMs * expectedWaves) + 12_000))
const gain = Number((observedSequentialMs / Math.max(1, wallMs)).toFixed(2))
assertGate(result.ok === true, 'synthetic release gates failed', result)
assertGate(result.batch_size === 80 && result.completed === 80, 'synthetic gate count mismatch', result)
assertGate(completedDurations.length === 80, 'synthetic gate duration evidence missing', { durations: completedDurations.length, result })
assertGate(wallMs <= dynamicWallBudgetMs, 'release full parallelism wall time too slow', {
  wallMs,
  dynamicWallBudgetMs,
  slowestGateMs,
  expectedWaves,
  result
})
assertGate(gain >= 3, 'release bounded parallelism gain below 3x', { gain, wallMs, observedSequentialMs })
emitGate('release:full-parallelism-blackbox', {
  wall_ms: wallMs,
  parallelism_gain: gain,
  observed_sequential_ms: observedSequentialMs,
  dynamic_wall_budget_ms: dynamicWallBudgetMs,
  slowest_gate_ms: slowestGateMs,
  max_running: safeConcurrency,
  slowest_gates: result.results.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5)
})
