#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'

const src = readText('src/core/zellij/zellij-worker-pane-manager.ts')
assertGate(src.includes('checkZellijStackedPaneCapability'), 'worker pane manager must read stacked capability before --stacked')
assertGate(src.includes("'--stacked'"), 'worker pane manager must still support native --stacked when capability allows')
assertGate(src.includes('worker_stacked_requested') && src.includes('worker_stacked_applied'), 'worker pane record must capture requested/applied stacked fields')
assertGate(src.includes('worker_stacked_fallback_mode'), 'worker pane record must capture fallback mode')
assertGate(src.includes('zellij_stacked_pane_rejected_fallback_down'), 'worker pane manager must record rejected --stacked fallback')
emitGate('zellij:stacked-capability-routing')
