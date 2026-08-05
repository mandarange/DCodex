#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_CURRENT_APP_FAKE = '1'
process.env.SKS_CODEX_APP_LAUNCH_FAKE = '1'
const mod = await importDist('core/codex-app/codex-app-handoff.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-app-handoff-launch-'))
const result = await mod.runCodexAppHandoff(root, {
  schema: 'sks.codex-app-handoff-request.v1',
  mission_id: 'M-fixture',
  route: '$QA-LOOP',
  reason: 'fixture',
  workspace_path: root,
  artifacts: ['qa-gate.json'],
  prompt: 'fixture prompt',
  require_desktop: true,
  capability_required: 'codex-current',
  launch_mode: 'attempt-launch'
})
assertGate(result.launch_attempt?.attempted === true && result.status === 'launched_pending_confirmation' && result.confirmation_required === true, 'Codex App handoff launch mode must record launched_pending_confirmation and require confirmation', result)
emitGate('codex-app:handoff-launch', { status: result.status })
