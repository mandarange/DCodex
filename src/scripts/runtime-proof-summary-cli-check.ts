#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-runtime-summary-cli-'))
const missionId = 'M-runtime-summary-cli'
const dir = path.join(tmp, '.sneakoscope', 'missions', missionId)
const agents = path.join(dir, 'agents')
await fs.mkdir(agents, { recursive: true })
await fs.writeFile(path.join(agents, 'parallel-runtime-proof.json'), JSON.stringify({
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
  speedup_ratio: 6.8,
  overlap_windows: [],
  utilization_proof_consistency: { ok: true, scheduler_max_active: 32, proof_max_active: 32, wall_ms_delta: 100 },
  passed: true,
  blockers: []
}, null, 2))
await fs.writeFile(path.join(agents, 'agent-scheduler-state.json'), JSON.stringify({ target_active_slots: 32, max_observed_active_slots: 32, largest_batch_size: 32, scheduler_utilization: 0.88 }, null, 2))
const cli = path.join(root, 'dist', 'bin', 'sks.js')
for (const args of [['proof', 'latest'], ['naruto', 'proof', 'latest']]) {
  const res = spawnSync(process.execPath, [cli, ...args], { cwd: tmp, encoding: 'utf8', timeout: 30000 })
  assertGate(res.status === 0, `${args.join(' ')} failed`, { stdout: res.stdout, stderr: res.stderr })
  for (const token of ['Parallel proof: passed', 'Active workers: 32', 'Unique PIDs: 32', 'Model calls max: 12']) {
    assertGate(res.stdout.includes(token), `${args.join(' ')} missing ${token}`, { stdout: res.stdout })
  }
}
emitGate('runtime:proof-summary-cli', { commands: ['sks proof latest', 'sks naruto proof latest'] })
