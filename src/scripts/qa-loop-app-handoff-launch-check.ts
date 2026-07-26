#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
assertGate(command.includes('--app-handoff-launch') && command.includes('--app-handoff-artifact-only') && command.includes('launch_mode'), 'QA-LOOP must expose launch/artifact-only handoff flags and pass launch_mode')
emitGate('qa-loop:app-handoff-launch')
