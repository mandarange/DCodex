#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
assertGate(command.includes('desktop_app_confirmation') && command.includes('desktop_review_complete') && command.includes('launch:'), 'QA status --desktop must include handoff launch, confirmation, and complete lifecycle')
emitGate('qa-loop:app-handoff-status-lifecycle')
