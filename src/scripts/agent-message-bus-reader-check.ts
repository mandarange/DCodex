#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { appendAgentMessage, readAgentMessageBus } from '../core/agents/agent-message-bus.js'
import { assertGate, emitGate } from './gate-lib.js'

const missionId = 'M-agent-message-reader'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-agent-message-'))
const agents = path.join(root, '.sneakoscope', 'missions', missionId, 'agents')
await fs.mkdir(agents, { recursive: true })
await appendAgentMessage(agents, { from: 'slot-001', session_id: 's1', type: 'worker_completed', body: 'patch candidate verified', artifact_paths: ['a.json'] })
await appendAgentMessage(agents, { from: 'slot-002', session_id: 's2', type: 'worker_failed', body: 'blocker git_worktree_merge_conflict', artifact_paths: ['b.json'] })
const rows = await readAgentMessageBus(root, missionId, { max: 20 })
assertGate(rows.length === 2, 'message bus reader must read jsonl entries', rows)
assertGate(rows[0].event_type === 'worker_completed' && rows[1].event_type === 'worker_failed', 'message bus reader must normalize event types', rows)
assertGate(rows[1].level === 'error', 'worker_failed message must normalize to error level', rows[1])
emitGate('agent:message-bus-reader', { rows })
