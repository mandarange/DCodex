#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { assertGate, emitGate, root } from './gate-lib.js'

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-proof-zellij-'))
const missionId = 'M-naruto-proof-zellij'
const dir = path.join(tmp, '.sneakoscope', 'missions', missionId)
const agents = path.join(dir, 'agents')
await fs.mkdir(path.join(dir, 'zellij'), { recursive: true })
await fs.mkdir(agents, { recursive: true })
await fs.writeFile(path.join(agents, 'parallel-runtime-proof.json'), JSON.stringify({
  schema: 'sks.parallel-runtime-proof.v1',
  mission_id: missionId,
  max_observed_active_workers: 32,
  unique_worker_pids: 32,
  max_observed_model_calls: 12,
  speedup_ratio: 6.8,
  visible_panes: 8,
  headless_workers: 24,
  passed: true,
  blockers: []
}, null, 2))
await fs.writeFile(path.join(agents, 'agent-scheduler-state.json'), JSON.stringify({ target_active_slots: 32, max_observed_active_slots: 32, largest_batch_size: 32, scheduler_utilization: 0.91 }, null, 2))
await fs.writeFile(path.join(dir, 'zellij', 'slot-telemetry.snapshot.json'), JSON.stringify({ schema: 'sks.zellij-slot-telemetry-snapshot.v1', mission_id: missionId, updated_at: new Date(Date.now() - 500).toISOString(), slots: {}, counts: {} }, null, 2))
await fs.writeFile(path.join(dir, 'zellij-right-column-state.json'), JSON.stringify({ schema: 'sks.zellij-right-column-state.v1', mission_id: missionId, session_name: 'fixture', status: 'active', slot_column_anchor_pane_id: 'terminal_1', visible_worker_panes: [], headless_workers: [], blockers: [] }, null, 2))
await fs.writeFile(path.join(tmp, 'agent-zellij-pane-launch-ledger.jsonl'), Array.from({ length: 8 }, (_, i) => JSON.stringify({
  schema: 'sks.agent-zellij-pane-launch.v1',
  mission_id: missionId,
  slot_id: `slot-${String(i + 1).padStart(3, '0')}`,
  worker_stacked_requested: i > 0,
  worker_stacked_applied: i > 0,
  worker_stacked_fallback_mode: i > 0 ? 'native-stacked' : null,
  worker_stacked_capability: { supports_stacked_panes: true, parsed_version: '0.43.1' },
  slot_column_anchor_pane_id: 'terminal_1'
})).join('\n') + '\n')
await fs.writeFile(path.join(dir, 'zellij', 'pane-creation-lock-events.jsonl'), [40, 70, 120, 180, 220, 260, 310, 350].map((wait, i) => JSON.stringify({ schema: 'sks.zellij-pane-creation-lock-metrics.v1', mission_id: missionId, slot_id: `slot-${i}`, wait_ms: wait, held_ms: 300 })).join('\n') + '\n')

const cli = path.join(root, 'dist', 'bin', 'sks.js')
const res = spawnSync(process.execPath, [cli, 'naruto', 'proof', 'latest'], { cwd: tmp, encoding: 'utf8', timeout: 30000 })
assertGate(res.status === 0, 'sks naruto proof latest failed', { stdout: res.stdout, stderr: res.stderr })
for (const token of ['Zellij stacked panes: 7/7 applied', 'Stack fallback: 0', 'Pane lock wait p95: 350ms', 'SLOTS anchors: 1']) {
  assertGate(res.stdout.includes(token), `naruto proof output missing ${token}`, { stdout: res.stdout })
}
emitGate('naruto:proof-zellij-stacked-summary', { command: 'sks naruto proof latest' })
