#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate } from './gate-lib.js'

const root = process.cwd()
const worker = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-worker-pane-manager.ts'), 'utf8')
const rightColumn = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-right-column-manager.ts'), 'utf8')
const registry = fs.readFileSync(path.join(root, 'src/cli/command-registry.ts'), 'utf8')
const checks = {
  command_registered: registry.includes("'zellij-slot-column-anchor'"),
  anchor_command_used: worker.includes('buildZellijSlotColumnAnchorCommand'),
  anchor_created_right: worker.includes("'--direction', 'right', '--name', 'SLOTS'"),
  worker_down_only_for_right_column: worker.includes("const directionRequested: 'right' | 'down' = 'down'"),
  worker_new_pane_uses_down_direction: worker.includes("'--direction', directionRequested") && !worker.includes("'--direction', 'right', '--name', 'SKS "),
  legacy_first_worker_right_removed: !worker.includes("rightColumn?.focusPaneId ? 'down' : 'right'"),
  worker_direction_fields: worker.includes('worker_direction_requested') && worker.includes('worker_direction_applied'),
  state_anchor_field: rightColumn.includes('slot_column_anchor_pane_id')
}
assertGate(Object.values(checks).every(Boolean), 'First visible Zellij worker must stack down from a right-column SLOTS anchor', checks)
emitGate('zellij:first-slot-down-stack', checks)
