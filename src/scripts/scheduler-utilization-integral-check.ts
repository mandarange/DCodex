#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runAgentScheduler } from '../core/agents/agent-scheduler.js'
import { assertGate, emitGate } from './gate-lib.js'

const sleepMs = 2000

async function runFixture(targetActiveSlots) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-scheduler-util-${targetActiveSlots}-`))
  const missionId = `M-scheduler-util-${targetActiveSlots}`
  const roster = {
    agent_count: 10,
    concurrency: targetActiveSlots,
    roster: Array.from({ length: 10 }, (_, i) => ({ id: `agent_${i + 1}`, persona_id: `p${i + 1}`, role: 'verifier', write_policy: 'read-only' }))
  }
  const partition = {
    slices: Array.from({ length: 10 }, (_, i) => ({ id: `work-${i + 1}`, role: 'verifier', description: `sleep ${i + 1}`, write_paths: [], readonly_paths: [] }))
  }
  const started = Date.now()
  const result = await runAgentScheduler({
    root,
    missionId,
    rootHash: 'fixture',
    roster,
    partition,
    targetActiveSlots,
    maxActiveSlots: 10,
    launchSession: async ({ generation, agent, workItem }) => {
      await new Promise((resolve) => setTimeout(resolve, sleepMs))
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
  return { wall: Date.now() - started, state: result.state }
}

function assertActiveTimeIntegral(label, run) {
  const expectedActiveSlotTimeMs = 10 * sleepMs
  const expectedWallMs = Math.ceil(10 / run.state.target_active_slots) * sleepMs
  const wallOvershootMs = Math.max(0, run.wall - expectedWallMs)
  const launchSpanMs = Number(run.state.first_batch_launch_span_ms || 0)
  const lowerBoundMs = Math.floor(expectedActiveSlotTimeMs * 0.75)
  const upperBoundMs = expectedActiveSlotTimeMs + Math.max(
    12_000,
    Math.ceil(wallOvershootMs * run.state.target_active_slots),
    Math.ceil(launchSpanMs * run.state.target_active_slots)
  )
  assertGate(
    run.state.active_slot_time_ms >= lowerBoundMs && run.state.active_slot_time_ms <= upperBoundMs,
    `${label} active time integral must approximate worker runtime under scheduler load`,
    {
      ...run.state,
      expected_active_slot_time_ms: expectedActiveSlotTimeMs,
      expected_wall_ms: expectedWallMs,
      wall_overshoot_ms: wallOvershootMs,
      active_slot_time_bounds_ms: { lower: lowerBoundMs, upper: upperBoundMs }
    }
  )
}

function assertSchedulerShape(label, run, utilizationFloor) {
  const launchSpanMs = Number(run.state.first_batch_launch_span_ms || 0)
  const utilizationPenalty = Math.min(0.2, launchSpanMs / 10_000)
  const dynamicUtilizationFloor = Number(Math.max(0.55, utilizationFloor - utilizationPenalty).toFixed(3))
  assertGate(run.state.completed_count === 10 && run.state.failed_count === 0, `${label} scheduler must complete all fixture work`, run.state)
  assertGate(run.state.max_observed_active_slots === run.state.target_active_slots, `${label} scheduler must fill target active slots`, run.state)
  assertGate(run.state.scheduler_utilization >= dynamicUtilizationFloor, `${label} scheduler utilization too low`, {
    ...run.state,
    dynamic_utilization_floor: dynamicUtilizationFloor
  })
}

function assertFixtureWallTime(label, run) {
  const expectedWallMs = Math.ceil(10 / run.state.target_active_slots) * sleepMs
  const launchSpanMs = Number(run.state.first_batch_launch_span_ms || 0)
  const wallBudgetMs = Math.max(expectedWallMs + 5_000, expectedWallMs + launchSpanMs + 4_000)
  assertGate(run.wall < wallBudgetMs, `${label} scheduler wall time too slow`, {
    wall: run.wall,
    wall_budget_ms: wallBudgetMs,
    expected_wall_ms: expectedWallMs,
    state: run.state
  })
}

const ten = await runFixture(10)
assertFixtureWallTime('10-slot', ten)
assertActiveTimeIntegral('10-slot', ten)
assertSchedulerShape('10-slot', ten, 0.65)

const two = await runFixture(2)
assertGate(two.wall >= 8000, '2-slot scheduler wall time must not run all work at once', two)
assertFixtureWallTime('2-slot', two)
assertActiveTimeIntegral('2-slot', two)
assertSchedulerShape('2-slot', two, 0.75)

emitGate('scheduler:utilization-integral', { ten: ten.state, two: two.state })
