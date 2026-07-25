#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const pane = readText('src/core/zellij/zellij-slot-pane-renderer.ts')
const anchor = readText('src/core/zellij/zellij-slot-column-anchor.ts')
assertGate(pane.includes('QA app handoff pending') && pane.includes('app-handoff.json'), 'Zellij slot pane must surface QA app handoff pending status')
assertGate(anchor.includes('QA /app handoff pending') && anchor.includes('qa-loop/app-handoff.json'), 'Zellij column anchor must surface QA app handoff pending status')
emitGate('zellij:qa-app-handoff-status')
