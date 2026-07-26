#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'
import { buildWorkerPaneArtifact } from '../core/zellij/zellij-worker-pane-manager.js'

const root = process.cwd()
const managerSource = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-worker-pane-manager.ts'), 'utf8')
const runtimeSource = fs.readFileSync(path.join(root, 'src/core/agents/native-cli-worker-runtime.ts'), 'utf8')

const base = {
  root,
  missionId: 'M-slot-renderer-proof-semantics',
  sessionName: 'sks-M-slot-renderer-proof-semantics',
  slotId: 'slot-001',
  generationIndex: 1,
  sessionId: 'slot-001-gen-1',
  workerArtifactDir: 'sessions/slot-001/gen-1/worker',
  resultPath: 'sessions/slot-001/gen-1/worker/worker-result.json',
  heartbeatPath: 'sessions/slot-001/gen-1/worker/worker-heartbeat.jsonl',
  patchEnvelopePath: 'sessions/slot-001/gen-1/worker/worker-patch-envelope.json',
  stdoutLog: 'sessions/slot-001/gen-1/worker/worker.stdout.log',
  stderrLog: 'sessions/slot-001/gen-1/worker/worker.stderr.log',
  paneId: '101',
  paneIdSource: 'zellij_worker_new_pane_stdout' as const,
  status: 'running' as const,
  blockers: []
}

const slotRenderer = buildWorkerPaneArtifact({
  ...base,
  workerCommand: 'node dist/bin/sks.js zellij-slot-pane --watch'
})
const workerCommand = buildWorkerPaneArtifact({
  ...base,
  slotId: 'slot-002',
  sessionId: 'slot-002-gen-1',
  workerCommand: 'node dist/core/agents/native-cli-worker-entry.js --intake worker-intake.json --json'
})

const report = {
  schema: 'sks.zellij-slot-renderer-proof-semantics-check.v2',
  ok: true,
  slot_renderer_pane_kind: slotRenderer.pane_kind,
  slot_renderer_scaling_primitive: slotRenderer.scaling_primitive,
  worker_pane_kind: workerCommand.pane_kind,
  worker_scaling_primitive: workerCommand.scaling_primitive,
  launch_ledger_uses_record_values: managerSource.includes('pane_kind: record.pane_kind') && managerSource.includes('scaling_primitive: record.scaling_primitive'),
  runtime_uses_pane_record_values: runtimeSource.includes('input.record.pane_kind = paneRecord.pane_kind') && runtimeSource.includes('input.record.scaling_primitive = paneRecord.scaling_primitive'),
  blockers: [] as string[]
}

report.blockers = [
  ...(slotRenderer.pane_kind === 'slot_status_renderer' ? [] : ['slot_renderer_pane_kind_not_distinct']),
  ...(slotRenderer.scaling_primitive === 'native_cli_process_with_zellij_slot_renderer' ? [] : ['slot_renderer_scaling_primitive_not_distinct']),
  ...(workerCommand.pane_kind === 'worker_codex_sdk' ? [] : ['worker_pane_kind_regressed']),
  ...(workerCommand.scaling_primitive === 'native_cli_process_in_zellij_worker_pane' ? [] : ['worker_scaling_primitive_regressed']),
  ...(report.launch_ledger_uses_record_values ? [] : ['launch_ledger_semantics_not_record_backed']),
  ...(report.runtime_uses_pane_record_values ? [] : ['runtime_semantics_not_record_backed'])
]
report.ok = report.blockers.length === 0

assertGate(report.ok, 'Zellij compact slot renderer proof semantics must distinguish status renderer panes from worker command panes', report)
emitGate('zellij:slot-renderer-proof-semantics', report)
