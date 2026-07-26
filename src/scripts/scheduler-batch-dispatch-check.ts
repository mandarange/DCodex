#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgentScheduler } from '../core/agents/agent-scheduler.js'
import { assertGate, emitGate, readText } from './gate-lib.js'

assertGate(readText('src/core/agents/agent-scheduler.ts').includes('collectLaunchBatch') && readText('src/core/agents/agent-scheduler.ts').includes('batch_work_items_dispatched'), 'batch scheduler source wiring missing')
const missionId = 'M-scheduler-batch'
const ledgerRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-scheduler-batch-'))
const count = 6
const roster = { agent_count: count, roster: Array.from({ length: count }, (_, i) => ({ id: `a${i + 1}`, persona_id: `p${i + 1}`, role: 'verifier' })) }
const partition = { slices: Array.from({ length: count }, (_, i) => ({ id: `w${i + 1}`, description: 'batch', write_paths: [], readonly_paths: [] })) }
const result = await runAgentScheduler({ root: ledgerRoot, missionId, rootHash: 'fixture', roster, partition, targetActiveSlots: count, maxActiveSlots: count, launchSession: async ({ generation, agent, workItem }) => ({ schema: 'sks.agent-result.v1', mission_id: missionId, agent_id: agent.id, session_id: generation.session_id, persona_id: agent.persona_id, task_slice_id: workItem.id, status: 'done', backend: 'fake', summary: 'ok', findings: [], proposed_changes: [], changed_files: [], lease_compliance: { ok: true, violations: [] }, artifacts: [], blockers: [], confidence: 'high', handoff_notes: '', unverified: [], writes: [], recursion_guard: { ok: true, violations: [] }, verification: { status: 'passed', checks: [] } }) })
assertGate(result.state.batch_dispatch_count >= 1 && result.state.largest_batch_size >= result.state.target_active_slots, 'scheduler did not dispatch a full effective launch batch', result.state)
emitGate('scheduler:batch-dispatch', result.state)
