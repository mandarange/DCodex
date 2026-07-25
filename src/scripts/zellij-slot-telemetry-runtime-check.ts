#!/usr/bin/env node
import { assertGate, emitGate, readText } from './gate-lib.js'

const runtime = readText('src/core/agents/native-cli-worker-runtime.ts')
const worker = readText('src/core/agents/native-cli-worker.ts')
const requiredEvents = [
  'slot_reserved',
  'worker_spawned',
  'task_started',
  'heartbeat',
  'task_progress',
  'patch_candidate',
  'artifact_written',
  'worker_completed',
  'worker_failed'
]

for (const event of requiredEvents) {
  assertGate(runtime.includes(event) || worker.includes(event), `missing runtime slot telemetry event ${event}`)
}

assertGate(runtime.includes('appendZellijSlotTelemetry'), 'session runtime must append Zellij slot telemetry')
assertGate(worker.includes('appendZellijSlotTelemetry'), 'native worker must append Zellij slot telemetry')
assertGate(worker.includes('startWorkerProgressTelemetry'), 'native worker must emit progress telemetry during backend runtime')
assertGate(!/progress:\s*\{\s*done:\s*tick,\s*total:\s*0/.test(worker), 'heartbeat ticks must not be reported as progress done/total counters')
emitGate('zellij:slot-telemetry-runtime', { lifecycle_events: requiredEvents.length, progress_pump: true })
