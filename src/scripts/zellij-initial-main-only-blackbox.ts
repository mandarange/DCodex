#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const mad = fs.readFileSync(path.join(root, 'src/core/commands/mad-sks-command.ts'), 'utf8')
const naruto = fs.readFileSync(path.join(root, 'src/core/commands/naruto-command.ts'), 'utf8')
const launcher = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-launcher.ts'), 'utf8')

const report = {
  schema: 'sks.zellij-initial-main-only-blackbox.v1',
  ok: true,
  mad_slot_zero: /launchMadZellijUi\([\s\S]*slotCount:\s*0/.test(mad),
  mad_initial_ui_artifact: mad.includes('zellij-initial-ui.json') && mad.includes("ui_architecture: 'monitor_plus_viewports'") && mad.includes('worker_panes_created: 0'),
  naruto_uses_official_subagents: naruto.includes('runOfficialSubagentWorkflow'),
  launcher_uses_layout_builder: launcher.includes('writeZellijLayout(root, layoutInput)')
}
report.ok = report.mad_slot_zero
  && report.mad_initial_ui_artifact
  && report.naruto_uses_official_subagents
  && report.launcher_uses_layout_builder

assertGate(report.ok, 'Zellij initial UI must use monitor plus fixed viewports with no worker panes at launch', report)
emitGate('zellij:initial-main-only-blackbox', report)
