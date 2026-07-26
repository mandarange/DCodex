#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'

const src = readText('src/core/zellij/zellij-worker-pane-manager.ts')
assertGate(src.includes('sks.zellij-pane-creation-lock-metrics.v1'), 'pane lock metrics schema missing')
assertGate(src.includes('pane-creation-lock-events.jsonl'), 'pane lock metrics artifact path missing')
for (const token of ['requested_at', 'acquired_at', 'released_at', 'wait_ms', 'held_ms']) {
  assertGate(src.includes(token), `pane lock metrics missing ${token}`)
}
assertGate(src.includes('zellij_pane_creation_lock_requested') && src.includes('zellij_pane_creation_lock_released'), 'pane lock runtime events missing')
emitGate('zellij:pane-creation-lock-metrics')
