#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertGate, emitGate, importDist } from './gate-lib.js'
process.env.SKS_CODEX_CURRENT_APP_FAKE = '1'
const mod = await importDist('core/codex-app/codex-app-handoff.js')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-app-handoff-'))
const result = await mod.runCodexAppHandoff(root, {
  schema: 'sks.codex-app-handoff-request.v1',
  mission_id: 'M-fixture',
  route: '$QA-LOOP',
  reason: 'fixture',
  workspace_path: root,
  artifacts: ['qa-gate.json'],
  prompt: 'fixture prompt',
  require_desktop: false,
  capability_required: 'codex-current'
})
const artifact = JSON.parse(await fs.readFile(result.artifact_path, 'utf8'))
assertGate(result.ok === true && artifact.operator_instruction.open === 'codex /app', 'Codex App handoff must write operator handoff artifact', result)
assertGate(String(await fs.readFile(result.prompt_artifact_path, 'utf8')).includes('Do not treat this handoff artifact as web UI verification evidence'), 'handoff prompt must preserve web evidence boundary')
emitGate('codex-app:handoff', { status: result.status })
