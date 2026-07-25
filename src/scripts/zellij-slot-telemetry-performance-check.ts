#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendZellijSlotTelemetry, readZellijSlotTelemetrySnapshot } from '../core/zellij/zellij-slot-telemetry.js'
import { assertGate, emitGate } from './gate-lib.js'
const removeTempDir = fs.rm.bind(fs)
const missionId = 'M-zellij-performance'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-perf-'))
try {
  const started = Date.now()
  for (let i = 0; i < 5000; i++) await appendZellijSlotTelemetry(root, { schema: 'sks.zellij-slot-telemetry-event.v1', ts: new Date().toISOString(), mission_id: missionId, slot_id: `slot-${String(i % 100).padStart(3, '0')}`, generation_index: Math.floor(i / 100) + 1, worker_id: `w${i}`, event_type: 'heartbeat', status: 'running' })
  const wallMs = Date.now() - started
  const snapshot = await readZellijSlotTelemetrySnapshot(root, missionId)
  assertGate(wallMs < 15000, '5000 telemetry appends exceeded performance threshold', { wallMs, counts: snapshot.counts })
  assertGate(Object.keys(snapshot.slots).length === 5000, 'snapshot slot count mismatch', { wallMs, slot_count: Object.keys(snapshot.slots).length })
  assertGate(Number(snapshot.flush_count || 0) > 0 && Number(snapshot.flush_count || 0) < 500, 'snapshot writes must be throttled far below event count', { flush_count: snapshot.flush_count })
  assertGate(snapshot.slots['slot-099:g50']?.status === 'running', 'latest slot state must remain correct after incremental updates', snapshot.slots['slot-099:g50'])
  emitGate('zellij:slot-telemetry-performance', { wall_ms: wallMs, slot_count: Object.keys(snapshot.slots).length, flush_count: snapshot.flush_count })
} finally {
  await guardedRm(root, 'sks-zellij-perf-')
}

async function guardedRm(target: string, prefix: string) {
  const tempRoot = path.resolve(os.tmpdir())
  const resolved = path.resolve(target)
  if (path.dirname(resolved) !== tempRoot || !path.basename(resolved).startsWith(prefix)) {
    throw new Error(`refusing_to_remove_unscoped_temp_dir:${target}`)
  }
  await removeTempDir(resolved, { recursive: true, force: true })
}
