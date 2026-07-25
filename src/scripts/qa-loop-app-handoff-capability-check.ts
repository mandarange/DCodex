#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
const handoff = readText('src/core/codex-app/codex-app-handoff.ts')
assertGate(command.includes('writeCodex0138CapabilityArtifacts'), 'QA-LOOP must snapshot Codex 0.138 capability before handoff')
assertGate(handoff.includes('supports_app_handoff') && handoff.includes('capability_required') && handoff.includes('codex-0.138'), 'handoff must be gated by Codex 0.138 capability')
emitGate('qa-loop:app-handoff-capability')
