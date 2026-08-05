#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
const handoff = readText('src/core/codex-app/codex-app-handoff.ts')
assertGate(command.includes('writeCodexCurrentAppCapabilityArtifacts'), 'QA-LOOP must snapshot current Codex capability before handoff')
assertGate(handoff.includes('supports_app_handoff') && handoff.includes('capability_required') && handoff.includes('codex-current'), 'handoff must be gated by current Codex capability')
emitGate('qa-loop:app-handoff-capability')
