#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, readText } from './gate-lib.js'
const command = readText('src/core/commands/qa-loop-command.ts')
assertGate(command.includes('[--app-handoff] [--app-handoff-required]') && command.includes('status <mission-id|latest> [--desktop]'), 'QA-LOOP help must expose app handoff run/status flags')
assertGate(command.includes('blocked_for_desktop_review') && command.includes('desktop_app_handoff'), 'QA-LOOP CLI must emit desktop handoff status')
emitGate('qa-loop:app-handoff-cli')
