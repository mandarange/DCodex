#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendAgentMessage } from '../core/agents/agent-message-bus.js'
import { buildRuntimeProofSummary, renderRuntimeProofSummary } from '../core/agents/runtime-proof-summary.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-runtime-summary-messages-'))
const missionId = 'M-runtime-summary-messages'
const dir = path.join(root, '.sneakoscope', 'missions', missionId)
const agents = path.join(dir, 'agents')
await fs.mkdir(path.join(dir, 'zellij'), { recursive: true })
await fs.mkdir(agents, { recursive: true })
await fs.writeFile(path.join(agents, 'parallel-runtime-proof.json'), JSON.stringify({
  schema: 'sks.parallel-runtime-proof.v1',
  mission_id: missionId,
  max_observed_active_workers: 32,
  unique_worker_pids: 32,
  speedup_ratio: 6,
  visible_panes: 8,
  headless_workers: 24,
  passed: true,
  blockers: []
}, null, 2))
await fs.writeFile(path.join(agents, 'agent-scheduler-state.json'), JSON.stringify({ target_active_slots: 32, max_observed_active_slots: 32, largest_batch_size: 32, scheduler_utilization: 0.9 }, null, 2))
await fs.writeFile(path.join(agents, 'native-cli-worker-runtime.json'), JSON.stringify({ process_ids: Array.from({ length: 32 }, (_, i) => 7000 + i), zellij_pane_worker_sessions: 8, headless_overflow_worker_count: 24 }, null, 2))
await fs.writeFile(path.join(dir, 'zellij', 'slot-telemetry.snapshot.json'), JSON.stringify({ updated_at: new Date().toISOString(), slots: {} }, null, 2))
await appendAgentMessage(agents, { from: 'slot-001', session_id: 's1', type: 'worker_completed', body: 'implementer: patch candidate verified' })
await appendAgentMessage(agents, { from: 'slot-008', session_id: 's8', type: 'worker_failed', body: 'qa: blocker git_worktree_merge_conflict' })
const summary = await buildRuntimeProofSummary(root, missionId, { maxMessages: 20 })
const rendered = renderRuntimeProofSummary(summary)
assertGate(summary.messages.completed_count === 1 && summary.messages.failed_count === 1, 'runtime summary message counts mismatch', summary.messages)
assertGate(summary.ok === false && summary.blockers.includes('agent_message_bus_error_blockers'), 'runtime summary must fail on error messages', summary)
assertGate(rendered.includes('Recent worker messages:') && rendered.includes('[done]') && rendered.includes('[fail]'), 'runtime summary render must include recent worker messages', { rendered })
emitGate('runtime:proof-summary-messages', { messages: summary.messages, blockers: summary.blockers })
