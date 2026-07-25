#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendZellijSlotTelemetry, readZellijSlotTelemetrySnapshot, slotTelemetrySnapshotPath } from '../core/zellij/zellij-slot-telemetry.js'
import { assertGate, emitGate } from './gate-lib.js'
const removeTempDir = fs.rm.bind(fs)

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-live-flush-'))
const missionId = 'M-zellij-live-flush'
try {
  process.env.SKS_ZELLIJ_SLOT_TELEMETRY_FLUSH_MS = '1000'
  process.env.SKS_ZELLIJ_SLOT_TELEMETRY_FLUSH_EVERY_N = '100'

  await appendZellijSlotTelemetry(root, event('task_started', 'running', { task_title: 'live flush fixture' }))
  let snapshot = JSON.parse(await fs.readFile(slotTelemetrySnapshotPath(root, missionId), 'utf8'))
  assertGate(Object.keys(snapshot.slots || {}).length === 1, 'task_started must flush snapshot immediately', snapshot)
  const updates = [snapshot.updated_at]

  for (let i = 0; i < 7; i++) {
    await new Promise((resolve) => setTimeout(resolve, 300))
    await appendZellijSlotTelemetry(root, event('heartbeat', 'running', { log_tail: `heartbeat ${i}` }))
    const current = JSON.parse(await fs.readFile(slotTelemetrySnapshotPath(root, missionId), 'utf8'))
    if (current.updated_at !== updates[updates.length - 1]) updates.push(current.updated_at)
  }

  await appendZellijSlotTelemetry(root, event('worker_completed', 'completed', { artifact_paths: ['artifact.json'] }))
  const completed = await readZellijSlotTelemetrySnapshot(root, missionId)
  assertGate(completed.counts.completed === 1, 'completed event must flush immediately', completed)
  const eventCount = 1 + 7 + 1
  assertGate(updates.length >= 2, 'heartbeat stream must update snapshot at least twice in about 2s', { updates })
  assertGate(Number(completed.flush_count || 0) < eventCount, 'flush count must be throttled below event count', { flush_count: completed.flush_count, eventCount })
  emitGate('zellij:slot-telemetry-live-flush', { flush_count: completed.flush_count, event_count: eventCount, updates: updates.length })
} finally {
  await guardedRm(root, 'sks-zellij-live-flush-')
}

async function guardedRm(target: string, prefix: string) {
  const tempRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`refusing_to_remove_unscoped_temp_dir:${target}`)
  }
  await removeTempDir(resolved, { recursive: true, force: true })
}

function event(eventType, status, extra = {}) {
  return {
    schema: 'sks.zellij-slot-telemetry-event.v1',
    ts: new Date().toISOString(),
    mission_id: missionId,
    slot_id: 'slot-001',
    generation_index: 1,
    worker_id: 'worker-001',
    event_type: eventType,
    status,
    ...extra
  }
}
