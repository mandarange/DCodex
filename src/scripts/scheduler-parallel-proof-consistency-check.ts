#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgentScheduler } from '../core/agents/agent-scheduler.js'
import { appendParallelRuntimeEvent, writeParallelRuntimeProof } from '../core/agents/parallel-runtime-proof.js'
import { assertGate, emitGate } from './gate-lib.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-scheduler-proof-consistency-'))
const missionId = 'M-scheduler-proof-consistency'
const workers = 4
const sleepMs = 300
const roster = { agent_count: workers, concurrency: workers, roster: Array.from({ length: workers }, (_, i) => ({ id: `agent_${i + 1}`, persona_id: `p${i + 1}`, role: 'verifier', write_policy: 'read-only' })) }
const partition = { slices: Array.from({ length: workers }, (_, i) => ({ id: `work-${i + 1}`, role: 'verifier', description: `sleep ${i + 1}`, write_paths: [], readonly_paths: [] })) }

await runAgentScheduler({
  root,
  missionId,
  rootHash: 'fixture',
  roster,
  partition,
  targetActiveSlots: workers,
  maxActiveSlots: workers,
  launchSession: async ({ generation, slot, agent, workItem }) => {
    const pid = 7000 + Number(slot.slot_id.match(/\d+/)?.[0] || 0)
    await appendParallelRuntimeEvent(root, missionId, { event_type: 'worker_process_spawned', slot_id: slot.slot_id, generation_index: generation.generation_index, session_id: generation.session_id, pid, backend: 'fixture', placement: 'process' })
    await new Promise((resolve) => setTimeout(resolve, sleepMs))
    await appendParallelRuntimeEvent(root, missionId, { event_type: 'worker_completed', slot_id: slot.slot_id, generation_index: generation.generation_index, session_id: generation.session_id, pid, backend: 'fixture', placement: 'process' })
    return {
      schema: 'sks.agent-result.v1',
      mission_id: missionId,
      agent_id: agent.id,
      session_id: generation.session_id,
      persona_id: agent.persona_id,
      task_slice_id: workItem.id,
      status: 'done',
      backend: 'fixture',
      summary: 'done',
      findings: [],
      proposed_changes: [],
      changed_files: [],
      lease_compliance: { ok: true, violations: [] },
      artifacts: [],
      blockers: [],
      confidence: 'high',
      handoff_notes: '',
      unverified: [],
      writes: [],
      recursion_guard: { ok: true, violations: [] },
      verification: { status: 'passed', checks: ['sleep'] }
    }
  }
})
const proof = await writeParallelRuntimeProof(root, missionId, {
  proofMode: 'mock-process',
  requireWorkerPids: true,
  requestedWorkers: workers,
  targetActiveSlots: workers,
  expectedWorkerRuntimeMs: sleepMs,
  minActiveWorkers: workers,
  minSpeedupRatio: 1
})
assertGate(proof.utilization_proof_consistency?.ok === true, 'scheduler/proof consistency must pass', proof)
assertGate(proof.utilization_proof_consistency.scheduler_max_active >= workers - 1 && proof.utilization_proof_consistency.proof_max_active >= workers - 1, 'scheduler and proof max active counts must roughly agree', proof)
emitGate('scheduler:parallel-proof-consistency', proof.utilization_proof_consistency)
