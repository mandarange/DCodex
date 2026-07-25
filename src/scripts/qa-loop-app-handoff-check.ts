#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
const core = readText('src/core/qa-loop.ts')
assertGate(command.includes('runCodexAppHandoff') && command.includes('--app-handoff-required'), 'QA-LOOP command must wire Codex App /app handoff flags')
assertGate(core.includes('desktop_app_handoff_required') && core.includes('desktop_app_handoff_misused_as_web_evidence'), 'QA gate must track desktop handoff without web evidence substitution')
emitGate('qa-loop:app-handoff')
