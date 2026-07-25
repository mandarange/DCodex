#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'

const runtime = readText('src/core/agents/native-cli-worker-runtime.ts')
const processRunStart = runtime.indexOf('const processRun = liveWorkerPane')
const compactBlock = runtime.slice(processRunStart, runtime.indexOf('const zellijRequired'))
assertGate(processRunStart >= 0, 'worker runtime compact branch missing')
assertGate(compactBlock.indexOf('spawnCompactSlotWorkerProcess') >= 0 && compactBlock.indexOf('spawnCompactSlotWorkerProcess') < compactBlock.indexOf('openWorkerPane'), 'compact worker process must spawn before pane creation')
const parallel = readText('src/core/agents/parallel-runtime-proof.ts')
for (const event of ['worker_process_spawned', 'zellij_pane_creation_lock_requested', 'zellij_pane_created']) {
  assertGate(parallel.includes(event), `parallel proof event missing ${event}`)
}
emitGate('zellij:pane-lock-does-not-block-worker')
