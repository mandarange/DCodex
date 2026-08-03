#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildRuntimeProofSummary } from '../core/agents/runtime-proof-summary.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-runtime-summary-'))
const missionId = 'M-runtime-summary'
const dir = path.join(root, '.sneakoscope', 'missions', missionId)
const agents = path.join(dir, 'agents')
await fs.mkdir(agents, { recursive: true })
await fs.writeFile(path.join(agents, 'parallel-runtime-proof.json'), `${JSON.stringify({
  schema: 'sks.parallel-runtime-proof.v1',
  mission_id: missionId,
  generated_at: new Date().toISOString(),
  proof_mode: 'production',
  require_worker_pids: true,
  allow_missing_pids: false,
  requested_workers: 32,
  target_active_slots: 32,
  max_observed_active_workers: 32,
  max_observed_worker_processes: 32,
  unique_worker_pids: 32,
  unique_model_call_ids: 64,
  max_observed_model_calls: 12,
  launch_span_ms: 400,
  first_batch_launch_span_ms: 400,
  wall_ms: 12000,
  sequential_estimate_ms: 82000,
  speedup_ratio: 6.833,
  overlap_windows: [],
  utilization_proof_consistency: { ok: true, scheduler_max_active: 32, proof_max_active: 32, wall_ms_delta: 100 },
  passed: true,
  blockers: []
})}\n`)
await fs.writeFile(path.join(agents, 'agent-scheduler-state.json'), `${JSON.stringify({ target_active_slots: 32, max_observed_active_slots: 32, largest_batch_size: 32, scheduler_utilization: 0.88, wall_time_ms: 12100 })}\n`)
await fs.writeFile(path.join(agents, 'native-cli-worker-runtime.json'), `${JSON.stringify({ process_ids: Array.from({ length: 32 }, (_, i) => 8000 + i) })}\n`)
await fs.writeFile(path.join(agents, 'naruto-concurrency-governor.json'), `${JSON.stringify({ target_active_slots: 32 })}\n`)
const summary = await buildRuntimeProofSummary(root, missionId)
assertGate(summary.ok === true, 'runtime proof summary must pass complete fixture', summary)
assertGate(summary.parallel.max_active_workers === 32 && summary.parallel.unique_worker_pids === 32 && summary.model_calls.max_observed === 12 && summary.scheduler.largest_batch_size === 32, 'runtime proof summary values mismatch', summary)
assertGate(await exists(path.join(agents, 'runtime-proof-summary.json')), 'runtime proof summary file missing')
emitGate('runtime:proof-summary', summary)

async function exists(file) {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}
