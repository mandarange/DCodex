#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs'
import path from 'node:path'
import { assertGate, emitGate, root } from './gate-lib.js'

const uiMode = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-ui-mode.ts'), 'utf8')
const manager = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-right-column-manager.ts'), 'utf8')
const worker = fs.readFileSync(path.join(root, 'src/core/zellij/zellij-worker-pane-manager.ts'), 'utf8')
const runtime = fs.readFileSync(path.join(root, 'src/core/agents/native-cli-worker-runtime.ts'), 'utf8')
const report = {
  schema: 'sks.zellij-slot-only-ui-check.v1',
  default_compact_slots: uiMode.includes("return 'compact-slots'"),
  worker_panes_default_live_renderer: uiMode.includes('resolveZellijWorkerPaneUiMode') && uiMode.includes("|| 'compact-slots'"),
  full_debug_opt_in_available: uiMode.includes("'--zellij-full-debug'") && uiMode.includes("fromEnv === 'full-debug'"),
  compact_explicit_fallback: uiMode.includes("'--zellij-compact-slots'") && uiMode.includes("fromEnv === 'compact-slots'"),
  supported_modes_present: ["'compact-slots'", "'full-debug'"].every((token) => uiMode.includes(token)),
  state_records_ui_mode: manager.includes('ui_mode: uiMode'),
  first_slot_creates_slot_anchor_right: worker.includes('buildZellijSlotColumnAnchorCommand') && worker.includes("'--direction', 'right', '--name', 'SLOTS'"),
  anchor_creation_serialized: worker.includes('withZellijPaneCreationLock'),
  workers_stack_down_from_anchor: worker.includes("const directionRequested: 'right' | 'down' = 'down'")
    && worker.includes("'--near-current-pane'")
    && worker.includes("'--stacked'")
    && worker.includes('slot_column_anchor_pane_id'),
  explicit_compact_uses_renderer: runtime.includes('buildZellijSlotPaneCommand') && runtime.includes("liveWorkerPane ? 'worker-command-pane' : 'zellij-slot-pane-renderer'")
    && runtime.includes('paneRecord.pane_kind')
    && runtime.includes('paneRecord.scaling_primitive')
}
const ok = Object.values(report).every((value) => value === true || typeof value === 'string')
assertGate(ok, 'Zellij UI must remain compact slot and viewport based', report)
emitGate('zellij:slot-only-ui', report)
