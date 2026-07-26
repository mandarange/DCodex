#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const zellij = fs.readFileSync(path.join(root, 'src/commands/zellij.ts'), 'utf8')
const report = {
  schema: 'sks.zellij-developer-controls-check.v1',
  ok: true,
  zellij_controls: ['focus-worker', 'worker-logs', 'close-drained', 'pin', 'unpin'].every((token) => zellij.includes(token)),
  unknown_subcommands_blocked: zellij.includes("status: 'unsupported_subcommand'") && zellij.includes('unsupported_zellij_subcommand'),
  focus_uses_pane_id: zellij.includes('focus-pane-id'),
  logs_read_runtime: zellij.includes('native-cli-worker-runtime.json')
}
report.ok = report.zellij_controls && report.unknown_subcommands_blocked && report.focus_uses_pane_id && report.logs_read_runtime
assertGate(report.ok, 'Zellij/Naruto developer controls missing', report)
emitGate('zellij:developer-controls', report)
