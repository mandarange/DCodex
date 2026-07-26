#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const renderer = await importDist('core/zellij/zellij-slot-pane-renderer.js')
const text = renderer.renderZellijSlotPane({
  slotId: 'slot-003',
  generationIndex: 2,
  role: 'implementer',
  backend: 'local-llm',
  status: 'coding',
  fastMode: true,
  serviceTier: 'fast',
  provider: 'codex-lb',
  authMode: 'codex_lb_key',
  model: 'gpt-5.6-terra',
  reasoningEffort: 'medium',
  currentFile: 'src/core/foo.ts',
  currentTask: 'Editing Zellij slot pane renderer',
  changedFiles: ['src/core/foo.ts', 'src/core/bar.ts'],
  patchStatus: 'candidate',
  verifyStatus: 'queued',
  heartbeatAgeMs: 2000,
  worktreeId: 'WT-0007',
  eventLines: ['running: tool apply_patch', 'running: file src/core/foo.ts'],
  stdoutTail: ['renderer updated live pane output'],
  mode: 'compact-slots'
})
const lines = text.split(/\n/)
const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-slot-pane-renderer-'))
await fs.writeFile(path.join(artifactDir, 'worker-intake.json'), JSON.stringify({
  agent: { session_id: 'session-slot-003', role: 'implementer' },
  backend: 'codex-sdk',
  fast_mode: true,
  service_tier: 'fast',
  slice: {
    title: 'Hydrate live slot pane from artifacts',
    write_paths: ['src/core/zellij/zellij-slot-pane-renderer.ts']
  },
  worktree: { id: 'WT-0007' }
}, null, 2))
await fs.writeFile(path.join(artifactDir, 'worker-process-report.json'), JSON.stringify({
  fast_mode: true,
  service_tier: 'fast',
  session_proof: { ok: true, session_id: 'session-slot-003' }
}, null, 2))
await fs.writeFile(path.join(artifactDir, 'zellij-worker-pane.json'), JSON.stringify({
  provider: 'codex-lb',
  service_tier: 'fast',
  provider_context: {
    provider: 'codex-lb',
    auth_mode: 'codex_lb_key'
  }
}, null, 2))
await fs.writeFile(path.join(artifactDir, 'codex-control-proof.json'), JSON.stringify({
  config: {
    model: 'gpt-5.6-terra',
    model_provider: 'codex-lb',
    service_tier: 'fast',
    model_reasoning_effort: 'medium'
  }
}, null, 2))
await fs.writeFile(path.join(artifactDir, 'worker-heartbeat.jsonl'), `${JSON.stringify({ event: 'started', status: 'running' })}\n`)
await fs.writeFile(path.join(artifactDir, 'codex-sdk-events.jsonl'), `${JSON.stringify({
  sdk_event_type: 'item.completed',
  lane_status: 'running',
  current_tool: 'apply_patch',
  current_file: 'src/core/zellij/zellij-slot-pane-renderer.ts',
  message_tail: null
})}\n`)
await fs.writeFile(path.join(artifactDir, 'worker.stdout.log'), 'renderer stdout tail\n')
const hydrated = await renderer.renderZellijSlotPaneFromArtifacts({
  artifactDir,
  slotId: 'slot-003',
  generationIndex: 2,
  mode: 'compact-slots'
})
const missionRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-slot-pane-mission-'))
const missionId = 'M-slot-pane-renderer'
const snapshotDir = path.join(missionRoot, '.sneakoscope', 'missions', missionId, 'zellij')
await fs.mkdir(snapshotDir, { recursive: true })
await fs.writeFile(path.join(snapshotDir, 'slot-telemetry.snapshot.json'), `${JSON.stringify({
  schema: 'sks.zellij-slot-telemetry-snapshot.v1',
  mission_id: missionId,
  updated_at: new Date(Date.now() - 61000).toISOString(),
  flush_count: 1,
  slots: {
    'slot-003:g2': {
      slot_id: 'slot-003',
      generation_index: 2,
      worker_id: 'slot-003',
      status: 'running',
      role: 'implementer',
      backend: 'codex-sdk',
      provider: 'codex-lb',
      service_tier: 'fast',
      worktree_id: 'WT-0007',
      worktree_path: null,
      task_title: 'mission telemetry stale fixture',
      current_file: null,
      latest_event_type: 'task_started',
      latest_ts: new Date(Date.now() - 12000).toISOString(),
      progress: null,
      artifact_paths: [],
      blockers: [],
      log_tail: ''
    }
  },
  counts: { queued: 0, running: 1, verifying: 0, completed: 0, failed: 0, headless: 0 }
})}\n`, 'utf8')
const missionHydrated = await renderer.renderZellijSlotPaneFromArtifacts({
  artifactDir,
  artifactRoot: missionRoot,
  missionId,
  slotId: 'slot-003',
  generationIndex: 2,
  mode: 'compact-slots'
})
await fs.rm(missionRoot, { recursive: true, force: true })
await fs.rm(artifactDir, { recursive: true, force: true })
const command = renderer.buildZellijSlotPaneCommand({
  cliPath: '/repo/dist/bin/sks.js',
  missionId: 'M-test',
  slotId: 'slot-003',
  generationIndex: 2,
  artifactDir: '/tmp/worker',
  watch: true
})
const report = {
  schema: 'sks.zellij-slot-pane-renderer-check.v1',
  line_count: lines.length,
  max_compact_lines: 14,
  contains_slot: /┌─ slot-003/.test(text) && /slot-003/.test(text),
  contains_status: /coding/.test(text),
  contains_runtime: /gpt-5\.6-terra·fast/.test(text),
  contains_files: /src\/core\/foo\.ts/.test(text),
  contains_live_event: /renderer updated live pane output/.test(text),
  artifact_hydrates_runtime: /gpt-5\.6-terra·fast/.test(hydrated),
  artifact_hydrates_live_event: /renderer stdout tail/.test(hydrated),
  artifact_hydrates_planned_file: /zellij-slot-pane-renderer\.ts/.test(hydrated),
  mission_live_telemetry_wins: /mission telemetry stale fixture/.test(missionHydrated) && /renderer stdout tail/.test(missionHydrated),
  command_uses_slot_pane: command.includes('zellij-slot-pane') && command.includes('--watch'),
  snapshot: text,
  hydrated_snapshot: hydrated,
  mission_hydrated_snapshot: missionHydrated
}
assertGate(lines.length <= 14 && report.contains_slot && report.contains_status && report.contains_runtime && report.contains_files && report.contains_live_event && report.artifact_hydrates_runtime && report.artifact_hydrates_live_event && report.artifact_hydrates_planned_file && report.mission_live_telemetry_wins && report.command_uses_slot_pane, 'compact slot pane renderer must render one live work pane per slot', report)
emitGate('zellij:compact-slot-renderer', report)
