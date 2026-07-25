#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
const mod = await importDist('core/qa-loop/qa-loop-app-handoff-confirmation.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-app-confirm-'))
const missionDir = path.join(root, '.sneakoscope', 'missions', 'M-fixture')
await fs.mkdir(path.join(missionDir, 'qa-loop'), { recursive: true })
await fs.writeFile(path.join(missionDir, 'qa-gate.json'), JSON.stringify({ desktop_app_handoff_required: true, desktop_app_handoff_status: 'pending', blockers: ['desktop_app_handoff_confirmation_missing'], notes: [] }, null, 2))
let missingBlocked = false
try {
  await mod.confirmQaLoopAppHandoff(root, { missionId: 'M-fixture', verdict: 'pass', notes: 'Desktop reviewed' })
} catch {
  missingBlocked = true
}
assertGate(missingBlocked, 'app-confirm must reject pass confirmation before app-handoff.json exists')
await fs.writeFile(path.join(missionDir, 'qa-loop', 'app-handoff.json'), JSON.stringify({ schema: 'sks.codex-app-handoff-result.v1', status: 'launched_pending_confirmation', ok: true }, null, 2))
const result = await mod.confirmQaLoopAppHandoff(root, { missionId: 'M-fixture', verdict: 'pass', notes: 'Desktop reviewed' })
assertGate(result.confirmation.verdict === 'pass' && result.gate.desktop_app_handoff_confirmed === true && result.gate.desktop_app_handoff_status === 'completed', 'app-confirm must write confirmation artifact and update qa-gate')
emitGate('qa-loop:app-handoff-confirmation')
