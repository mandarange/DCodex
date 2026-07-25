#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { slotTelemetrySnapshotPath } from '../core/zellij/zellij-slot-telemetry.js'
import { renderZellijSlotPaneFromArtifacts, renderZellijSlotPaneStatusFromArtifacts } from '../core/zellij/zellij-slot-pane-renderer.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-stale-'))
const missionId = 'M-zellij-stale'
const file = slotTelemetrySnapshotPath(root, missionId)
const artifactDir = path.join(root, 'worker-artifacts')
await fs.mkdir(path.dirname(file), { recursive: true })
await fs.mkdir(artifactDir, { recursive: true })
await fs.writeFile(path.join(artifactDir, 'worker-intake.json'), JSON.stringify({
  agent: { session_id: 'stale-session', role: 'worker' },
  backend: 'codex-sdk',
  slice: { title: 'fresh artifact fallback', write_paths: ['src/core/zellij/zellij-slot-pane-renderer.ts'] }
}, null, 2))
await fs.writeFile(path.join(artifactDir, 'worker-heartbeat.jsonl'), `${JSON.stringify({ event: 'progress', status: 'running', message: 'fresh heartbeat fallback' })}\n`)
await fs.writeFile(path.join(artifactDir, 'codex-sdk-events.jsonl'), `${JSON.stringify({ sdk_event_type: 'item.completed', lane_status: 'running', current_tool: 'apply_patch', current_file: 'src/core/zellij/zellij-slot-pane-renderer.ts' })}\n`)
await fs.writeFile(path.join(artifactDir, 'worker.stdout.log'), 'fresh worker stdout fallback\n')
const snapshot = {
  schema: 'sks.zellij-slot-telemetry-snapshot.v1',
  mission_id: missionId,
  updated_at: new Date().toISOString(),
  flush_count: 1,
  slots: {
    'slot-001:g1': {
      slot_id: 'slot-001',
      generation_index: 1,
      worker_id: 'worker-001',
      status: 'running',
      role: 'worker',
      backend: 'fixture',
      provider: 'fixture',
      service_tier: 'fast',
      worktree_id: null,
      worktree_path: null,
      task_title: 'stale detection fixture',
      current_file: null,
      latest_event_type: 'task_started',
      latest_ts: new Date().toISOString(),
      progress: null,
      artifact_paths: [],
      blockers: [],
      log_tail: ''
    }
  },
  counts: { queued: 0, running: 1, verifying: 0, completed: 0, failed: 0, headless: 0 }
}
// New stale contract: 1000ms+jitter flush throttle means a brief gap is NOT staleness. A snapshot
// only 3.5s old must read as FRESH (no stale row), preventing the flapping that produced bogus
// multi-thousand-second staleness in the live UI.
snapshot.updated_at = new Date(Date.now() - 3500).toISOString()
await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
const freshStatus = await renderZellijSlotPaneStatusFromArtifacts({ artifactDir, artifactRoot: root, missionId, slotId: 'slot-001', generationIndex: 1 })
assertGate(freshStatus.telemetry_stale === false, 'slot pane status JSON must treat 3.5s-old telemetry as fresh under new 15s threshold', freshStatus)

// Between 15s and 60s the status JSON marks staleness; the pane keeps showing live telemetry
// merged with fresh artifact/log detail instead of replacing it with stale-only prose.
snapshot.updated_at = new Date(Date.now() - 16000).toISOString()
await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
const staleText = await renderZellijSlotPaneFromArtifacts({ artifactDir, artifactRoot: root, missionId, slotId: 'slot-001', generationIndex: 1 })
const staleStatus = await renderZellijSlotPaneStatusFromArtifacts({ artifactDir, artifactRoot: root, missionId, slotId: 'slot-001', generationIndex: 1 })
assertGate(staleStatus.telemetry_stale === true && staleStatus.telemetry_age_ms >= 15000, 'slot pane status JSON must expose stale telemetry above 15s', staleStatus)
assertGate(staleText.includes('fresh worker stdout fallback') || staleText.includes('apply_patch'), 'stale slot pane must show fresh artifact/log fallback', { staleText })

// Past 60s the status JSON remains stale and the watch loop owns zombie closure.
snapshot.updated_at = new Date(Date.now() - 61000).toISOString()
await fs.writeFile(file, `${JSON.stringify(snapshot)}\n`, 'utf8')
const blockedText = await renderZellijSlotPaneFromArtifacts({ artifactDir, artifactRoot: root, missionId, slotId: 'slot-001', generationIndex: 1 })
assertGate(blockedText.includes('fresh worker stdout fallback') || blockedText.includes('apply_patch'), 'blocked stale slot pane must keep artifact/log fallback', { blockedText })
emitGate('zellij:slot-pane-stale-detection', { stale_age_ms: staleStatus.telemetry_age_ms, artifact_fallback: true })
