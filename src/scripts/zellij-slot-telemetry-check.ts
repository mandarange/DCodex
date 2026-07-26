#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'

const telemetry = await importDist('core/zellij/zellij-slot-telemetry.js')
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sks-slot-telemetry-'))
const missionId = 'M-20260608-000000-test'
await telemetry.appendZellijSlotTelemetry(tempRoot, {
  schema: telemetry.ZELLIJ_SLOT_TELEMETRY_EVENT_SCHEMA,
  mission_id: missionId,
  ts: new Date().toISOString(),
  slot_id: 'slot-001',
  generation_index: 1,
  event_type: 'worker_spawned',
  status: 'running',
  placement: 'zellij-pane',
  backend: 'fake',
  service_tier: 'fast',
  role: 'verifier'
})
await telemetry.appendZellijSlotTelemetry(tempRoot, {
  schema: telemetry.ZELLIJ_SLOT_TELEMETRY_EVENT_SCHEMA,
  mission_id: missionId,
  ts: new Date().toISOString(),
  slot_id: 'slot-001',
  generation_index: 2,
  event_type: 'worker_spawned',
  status: 'queued',
  backend: 'fake',
  service_tier: 'fast',
  role: 'verifier'
})
const snapshot = await telemetry.readZellijSlotTelemetrySnapshot(tempRoot, missionId)
assertGate(snapshot.schema === telemetry.ZELLIJ_SLOT_TELEMETRY_SNAPSHOT_SCHEMA, 'snapshot schema must match', snapshot)
assertGate(snapshot.slots['slot-001:g1']?.status === 'running', 'slot status must be snapshot-backed by slot generation', snapshot)
assertGate(snapshot.slots['slot-001:g2']?.status === 'queued', 'slot telemetry must preserve reused slot generations separately', snapshot)
emitGate('zellij:slot-telemetry', { slots: Object.keys(snapshot.slots).length })
