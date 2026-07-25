#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendZellijSlotTelemetry, readZellijSlotTelemetrySnapshot, slotTelemetrySnapshotPath } from '../core/zellij/zellij-slot-telemetry.js'
import { assertGate, emitGate, readText } from './gate-lib.js'
const removeTempDir = fs.rm.bind(fs)
const src = readText('src/core/zellij/zellij-slot-telemetry.ts')
assertGate(src.includes('applyTelemetryEventToSnapshot') && src.includes('readZellijSlotTelemetrySnapshotNoRebuild'), 'incremental telemetry helpers missing')
assertGate(src.includes('withFileLock') && src.includes('writeTextAtomic(file'), 'slot telemetry snapshot writes must be locked and atomically published')
const missionId = 'M-zellij-incremental'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-incremental-'))
try {
  process.env.SKS_ZELLIJ_SLOT_TELEMETRY_FLUSH_MS = '60000'
  process.env.SKS_ZELLIJ_SLOT_TELEMETRY_FLUSH_EVERY_N = '1000'
  const startedAt = '2026-01-01T00:00:00.000Z'
  const completedAt = '2026-01-01T00:00:01.000Z'
  const delayedHeartbeatAt = '2026-01-01T00:00:02.000Z'
  const drainedAt = '2026-01-01T00:00:03.000Z'
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: startedAt, mission_id: missionId, slot_id: 'slot-001', generation_index: 1, worker_id: 'w1', event_type: 'slot_reserved', status: 'queued' })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: completedAt, mission_id: missionId, slot_id: 'slot-001', generation_index: 1, worker_id: 'w1', event_type: 'worker_completed', status: 'completed' })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: startedAt, mission_id: missionId, slot_id: 'slot-001', generation_index: 1, worker_id: 'w1', event_type: 'heartbeat', status: 'running', artifact_paths: ['late-artifact.txt'] })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: completedAt, mission_id: missionId, slot_id: 'slot-001', generation_index: 1, worker_id: 'w1', event_type: 'heartbeat', status: 'running' })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: delayedHeartbeatAt, mission_id: missionId, slot_id: 'slot-001', generation_index: 1, worker_id: 'w1', event_type: 'heartbeat', status: 'running', log_tail: 'late heartbeat after completion' })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: startedAt, mission_id: missionId, slot_id: 'slot-002', generation_index: 1, worker_id: 'w2', event_type: 'worker_spawned', status: 'running' })
  await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: drainedAt, mission_id: missionId, slot_id: 'slot-002', generation_index: 1, worker_id: 'w2', event_type: 'heartbeat', status: 'drained' })
  const snapshot = await readZellijSlotTelemetrySnapshot(root, missionId)
  assertGate(snapshot.counts.completed === 2 && Object.keys(snapshot.slots).length === 2, 'incremental snapshot merge failed', snapshot)
  assertGate(snapshot.counts.running === 0 && snapshot.slots['slot-001:g1']?.status === 'completed', 'stale slot telemetry must not regress terminal status', snapshot)
  assertGate(snapshot.slots['slot-001:g1']?.artifact_paths?.includes('late-artifact.txt'), 'stale slot telemetry should still preserve additive artifacts', snapshot)
  assertGate(!String(snapshot.slots['slot-001:g1']?.log_tail || '').includes('late heartbeat after completion'), 'delayed heartbeat must not replace terminal telemetry tail', snapshot)
  const diskSnapshot = JSON.parse(await fs.readFile(slotTelemetrySnapshotPath(root, missionId), 'utf8'))
  assertGate(diskSnapshot.slots?.['slot-002:g1']?.status === 'drained', 'drained terminal status must flush to disk immediately', diskSnapshot)
  emitGate('zellij:slot-telemetry-incremental', snapshot.counts)
} finally {
  await guardedRm(root, 'sks-zellij-incremental-')
}

async function guardedRm(target: string, prefix: string) {
  const tempRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`refusing_to_remove_unscoped_temp_dir:${target}`)
  }
  await removeTempDir(resolved, { recursive: true, force: true })
}
