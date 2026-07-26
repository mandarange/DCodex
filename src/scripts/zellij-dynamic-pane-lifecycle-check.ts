#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const worker = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-worker-pane-manager.ts'), 'utf8')
const manager = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-right-column-manager.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(root, 'src/core/agents/native-cli-worker-runtime.ts'), 'utf8')
const report = {
  schema: 'sks.zellij-dynamic-pane-lifecycle-check.v1',
  ok: true,
  close_success_default: worker.includes("SKS_ZELLIJ_CLOSE_WORKER_PANE !== '0'"),
  keep_failed_default: worker.includes('SKS_ZELLIJ_KEEP_FAILED_PANE'),
  close_updates_right_column: worker.includes('closeWorkerInRightColumn'),
  drained_status_recorded: manager.includes('worker_pane_drained'),
  overflow_headless_recorded: runtime.includes('recordHeadlessWorkerInRightColumn')
}
report.ok = report.close_success_default && report.keep_failed_default && report.close_updates_right_column && report.drained_status_recorded && report.overflow_headless_recorded
assertGate(report.ok, 'dynamic pane lifecycle must close/drain workers and record headless overflow', report)
emitGate('zellij:dynamic-pane-lifecycle', report)
