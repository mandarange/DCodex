#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const worker = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-worker-pane-manager.ts'), 'utf8')
const manager = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-right-column-manager.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(root, 'src/core/agents/native-cli-worker-runtime.ts'), 'utf8')
const headlessReturnIndex = worker.indexOf("rightColumn?.placement === 'headless'")
const newPaneIndex = worker.indexOf("action', 'new-pane'")
const report = {
  schema: 'sks.zellij-right-column-headless-overflow-check.v1',
  headless_source: worker.includes("'zellij_worker_headless_overflow'"),
  headless_scaling_primitive: worker.includes('native_cli_process_headless_with_slot_column'),
  returns_before_new_pane: headlessReturnIndex >= 0 && newPaneIndex >= 0 && headlessReturnIndex < newPaneIndex,
  manager_records_overflow: manager.includes('worker_headless_overflow') && manager.includes('visible_pane_cap'),
  runtime_records_overflow: runtime.includes('recordHeadlessWorkerInRightColumn')
}
const ok = report.headless_source && report.headless_scaling_primitive && report.returns_before_new_pane && report.manager_records_overflow && report.runtime_records_overflow
assertGate(ok, 'headless overflow must not call zellij action new-pane', report)
emitGate('zellij:right-column-headless-overflow', report)
