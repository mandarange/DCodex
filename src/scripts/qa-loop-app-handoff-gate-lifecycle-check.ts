#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
const qa = await importDist('core/qa-loop.js')
const confirm = await importDist('core/qa-loop/qa-loop-app-handoff-confirmation.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-app-gate-'))
const missionDir = path.join(root, '.sneakoscope', 'missions', 'M-fixture')
await fs.mkdir(path.join(missionDir, 'qa-loop'), { recursive: true })
await fs.writeFile(path.join(missionDir, 'qa-loop', 'app-handoff.json'), JSON.stringify({ schema: 'sks.codex-app-handoff-result.v1', status: 'launched_pending_confirmation', ok: true }, null, 2))
const report = '2026-06-09-v2.0.19-qa-report.md'
await fs.writeFile(path.join(missionDir, report), 'ok')
await fs.writeFile(path.join(missionDir, 'qa-ledger.json'), JSON.stringify({ checklist: [] }))
await fs.writeFile(path.join(missionDir, 'qa-gate.json'), JSON.stringify({
  passed: true,
  clarification_contract_sealed: true,
  qa_report_written: true,
  qa_report_file: report,
  qa_ledger_complete: true,
  checklist_completed: true,
  safety_reviewed: true,
  deployed_destructive_tests_blocked: true,
  credentials_not_persisted: true,
  corrective_loop_enabled: false,
  unsafe_external_side_effects: false,
  ui_e2e_required: false,
  desktop_app_handoff_required: true,
  desktop_app_handoff_status: 'pending',
  desktop_app_handoff_confirmed: false,
  desktop_app_handoff_verdict: null,
  desktop_app_handoff_is_web_ui_evidence: false,
  honest_mode_complete: true,
  blockers: [],
  evidence: [],
  notes: []
}, null, 2))
const before = await qa.evaluateQaGate(missionDir)
await confirm.confirmQaLoopAppHandoff(root, { missionId: 'M-fixture', verdict: 'pass', notes: 'Desktop reviewed' })
const after = await qa.evaluateQaGate(missionDir)
assertGate(before.passed === false && before.reasons.includes('desktop_app_handoff_confirmation_missing') && after.passed === true, 'required Desktop handoff gate must wait for pass confirmation', { before, after })
emitGate('qa-loop:app-handoff-gate-lifecycle')
