import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { recordSubagentEvent, readSubagentEvents } from '../subagent-evidence.js'
import {
  createSubagentWaveLifecycle,
  effectiveSubagentTarget,
  subagentCountContractBlockers,
  refreshSubagentWaveLifecycle
} from '../wave-lifecycle.js'

test('root-owned lifecycle reuses settled capacity for a later direct-child wave in the same run', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-lifecycle-'))
  const runId = 'naruto-wave-run'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 4,
      requested_subagents_source: 'operator',
      max_threads: 4,
      max_depth: 1,
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 4,
        countPolicy: 'exact'
      })
    }))

    let lastEvent = null
    for (const threadId of ['wave-1-a', 'wave-1-b']) {
      lastEvent = await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
    }
    for (const threadId of ['wave-1-a', 'wave-1-b']) {
      lastEvent = await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStop')
    }
    const afterWaveOne = await refreshSubagentWaveLifecycle(dir, {
      evidence: { completed_threads: 2, failed_threads: 0 },
      event: lastEvent
    })

    assert.equal(afterWaveOne?.max_depth, 1)
    assert.equal(afterWaveOne?.max_depth_semantics, 'child_nesting_only_root_may_launch_later_direct_child_waves')
    assert.equal(afterWaveOne?.current_wave, 1)
    assert.equal(afterWaveOne?.completed_waves, 1)
    assert.equal(afterWaveOne?.open_threads, 0)
    assert.equal(afterWaveOne?.recovered_capacity, 2)
    assert.equal(afterWaveOne?.remaining_to_start, 2)
    assert.equal(afterWaveOne?.post_wave_rescan_required, true)

    for (const threadId of ['wave-2-a', 'wave-2-b']) {
      lastEvent = await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
    }
    for (const threadId of ['wave-2-a', 'wave-2-b']) {
      lastEvent = await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStop')
    }
    const final = await refreshSubagentWaveLifecycle(dir, {
      evidence: { completed_threads: 4, failed_threads: 0 },
      event: lastEvent
    })
    const events = await readSubagentEvents(dir)

    assert.equal(final?.workflow_run_id, runId)
    assert.equal(final?.current_wave, 2)
    assert.equal(final?.completed_waves, 2)
    assert.equal(final?.cumulative_started, 4)
    assert.equal(final?.cumulative_completed, 4)
    assert.equal(final?.open_threads, 0)
    assert.equal(final?.remaining_to_start, 0)
    assert.equal(final?.post_wave_rescan_required, false)
    assert.deepEqual(final?.waves.map((wave) => wave.status), ['settled', 'settled'])
    assert.equal(events.length, 8)
    assert.ok(events.every((event) => event.run_id === runId))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('partial settlement, failed stops, and duplicate stops return only live-thread capacity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-partial-reuse-'))
  const runId = 'run-partial-reuse'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 8,
      requested_subagents_source: 'operator',
      first_wave: 4,
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 8,
        countPolicy: 'exact',
        waveCapacity: 4
      })
    }))

    for (const threadId of ['a', 'b', 'c', 'd']) {
      await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
    }
    await recordSubagentEvent(dir, { agent_id: 'a', workflow_run_id: runId }, 'SubagentStop')
    await recordSubagentEvent(dir, { agent_id: 'b', workflow_run_id: runId, outcome: 'failed' }, 'SubagentStop')
    await recordSubagentEvent(dir, { agent_id: 'b', workflow_run_id: runId, outcome: 'failed' }, 'SubagentStop')

    let lifecycle = await refreshSubagentWaveLifecycle(dir)
    assert.equal(lifecycle?.cumulative_started, 4)
    assert.equal(lifecycle?.cumulative_settled, 2)
    assert.equal(lifecycle?.cumulative_completed, 1)
    assert.equal(lifecycle?.cumulative_failed, 1)
    assert.equal(lifecycle?.open_threads, 2)
    assert.equal(lifecycle?.peak_open_threads, 4)
    assert.equal(lifecycle?.recovered_capacity, 2)
    assert.ok(lifecycle?.next_parent_actions.includes('spawn_next_direct_child_wave_upto:2'))

    for (const threadId of ['e', 'f']) {
      await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
    }
    lifecycle = await refreshSubagentWaveLifecycle(dir)
    const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    assert.equal(lifecycle?.open_threads, 4)
    assert.equal(lifecycle?.peak_open_threads, 4)
    assert.equal(lifecycle?.recovered_capacity, 0)
    assert.ok(!lifecycle?.next_parent_actions.some((action) => action.startsWith('spawn_next_direct_child_wave_upto:')))
    assert.deepEqual(subagentCountContractBlockers(plan), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('only dynamic automatic lifecycle targets may be amended between waves', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-count-policy-'))
  try {
    for (const [source, countPolicy, expectedTarget] of [
      ['automatic', 'dynamic_automatic', 4],
      ['operator', 'exact', 2],
      ['route_contract', 'exact', 2]
    ] as const) {
      const dir = path.join(root, source)
      await fs.mkdir(dir, { recursive: true })
      const plan = {
        schema: 'sks.subagent-plan.v1',
        workflow_run_id: `run-${source}`,
        requested_subagents: 4,
        requested_subagents_source: source,
        max_depth: 1,
        wave_lifecycle: createSubagentWaveLifecycle({
          workflowRunId: `run-${source}`,
          targetSubagents: 2,
          countPolicy
        })
      }
      await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify(plan))

      const lifecycle = await refreshSubagentWaveLifecycle(dir)
      const refreshedPlan = { ...plan, wave_lifecycle: lifecycle }
      const target = effectiveSubagentTarget(refreshedPlan)
      assert.equal(lifecycle?.count_policy, countPolicy)
      assert.equal(lifecycle?.target_subagents, expectedTarget)
      assert.equal(lifecycle?.remaining_to_start, expectedTarget)
      assert.equal(lifecycle?.target_change_rejected, source === 'automatic' ? false : true)
      assert.equal(target.targetSubagents, expectedTarget)
      assert.deepEqual(
        subagentCountContractBlockers(refreshedPlan),
        source === 'automatic' ? [] : ['subagent_target_change_rejected']
      )
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('lifecycle ignores unbound and stale-run events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-run-binding-'))
  const runId = 'current-run'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 1,
      requested_subagents_source: 'automatic',
      max_depth: 1,
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 1,
        countPolicy: 'dynamic_automatic'
      })
    }))
    await recordSubagentEvent(dir, { agent_id: 'unbound-thread' }, 'SubagentStart')
    await recordSubagentEvent(dir, { agent_id: 'stale-thread', workflow_run_id: 'stale-run' }, 'SubagentStart')
    await recordSubagentEvent(dir, { agent_id: 'current-thread', workflow_run_id: runId }, 'SubagentStart')
    await recordSubagentEvent(dir, { agent_id: 'current-thread', workflow_run_id: runId }, 'SubagentStop')

    const lifecycle = await refreshSubagentWaveLifecycle(dir)

    assert.equal(lifecycle?.cumulative_started, 1)
    assert.equal(lifecycle?.cumulative_settled, 1)
    assert.deepEqual(lifecycle?.waves.flatMap((wave) => wave.thread_ids), ['current-thread'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('automatic lifecycle target is capped by policy ceiling, not cumulative max_threads', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-automatic-capacity-'))
  try {
    const dir = path.join(root, 'multi-wave')
    const runId = 'run-multi-wave'
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 2,
      requested_subagents_source: 'automatic',
      max_threads: 3,
      fanout_policy: { automatic_ceiling: 10 },
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 10,
        countPolicy: 'dynamic_automatic'
      })
    }))
    for (const wave of [
      ['thread-1', 'thread-2', 'thread-3'],
      ['thread-4', 'thread-5', 'thread-6'],
      ['thread-7', 'thread-8', 'thread-9'],
      ['thread-10']
    ]) {
      for (const threadId of wave) {
        await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
      }
      for (const threadId of wave) {
        await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStop')
      }
    }

    const lifecycle = await refreshSubagentWaveLifecycle(dir)
    const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    assert.equal(lifecycle?.target_subagents, 10)
    assert.equal(lifecycle?.cumulative_started, 10)
    assert.equal(lifecycle?.completed_waves, 4)
    assert.ok(lifecycle?.waves.every((wave) => wave.thread_ids.length <= 3))
    assert.equal(effectiveSubagentTarget(plan, 10).targetSubagents, 10)
    assert.deepEqual(subagentCountContractBlockers(plan, 10), [])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('dynamic refresh preserves a predeclared target before starts arrive', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-predeclared-target-'))
  const runId = 'run-predeclared-target'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 2,
      requested_subagents_source: 'automatic',
      max_threads: 3,
      fanout_policy: { automatic_ceiling: 10 },
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 4,
        countPolicy: 'dynamic_automatic'
      })
    }))

    const lifecycle = await refreshSubagentWaveLifecycle(dir)
    assert.equal(lifecycle?.requested_target_subagents, 2)
    assert.equal(lifecycle?.target_subagents, 4)
    assert.equal(lifecycle?.cumulative_started, 0)
    assert.equal(lifecycle?.remaining_to_start, 4)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('automatic lifecycle rejects declared or observed work above its policy ceiling', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-policy-ceiling-'))
  const runId = 'run-policy-ceiling'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 2,
      requested_subagents_source: 'automatic',
      max_threads: 12,
      fanout_policy: { automatic_ceiling: 3 },
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 4,
        countPolicy: 'dynamic_automatic'
      })
    }))

    const lifecycle = await refreshSubagentWaveLifecycle(dir)
    const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    assert.equal(lifecycle?.target_subagents, 3)
    assert.equal(effectiveSubagentTarget(plan, 4).targetSubagents, 3)
    assert.deepEqual(
      subagentCountContractBlockers({
        ...plan,
        wave_lifecycle: { ...plan.wave_lifecycle, target_subagents: 4 }
      }, 4),
      ['subagent_automatic_fanout_cap_exceeded:4/3']
    )
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('mass and ordinary automatic lifecycle both use the 256-child SKS ceiling', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-mass-capacity-'))
  try {
    for (const [name, massParallel] of [
      ['mass', true],
      ['ordinary', false]
    ] as const) {
      const dir = path.join(root, name)
      const runId = `run-${name}`
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
        schema: 'sks.subagent-plan.v1',
        workflow_run_id: runId,
        requested_subagents: 16,
        requested_subagents_source: 'automatic',
        first_wave: 4,
        fanout_policy: {
          automatic_ceiling: 256,
          mass_parallel: massParallel
        },
        wave_lifecycle: createSubagentWaveLifecycle({
          workflowRunId: runId,
          targetSubagents: 16,
          countPolicy: 'dynamic_automatic'
        })
      }))
      const lifecycle = await refreshSubagentWaveLifecycle(dir)
      const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
      assert.equal(lifecycle?.target_subagents, 16)
      assert.deepEqual(subagentCountContractBlockers(plan, 16), [])
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('legacy SKS-owned automatic ceilings migrate while a later successful stop clears retry failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-legacy-ceiling-'))
  const runId = 'run-legacy-ceiling'
  try {
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 8,
      requested_subagents_source: 'automatic',
      max_threads: 12,
      first_wave: 8,
      fanout_policy: {
        mode: 'parent_owned_risk_based',
        count_source: 'automatic',
        automatic_ceiling: 12,
        mass_parallel: false
      },
      wave_lifecycle: createSubagentWaveLifecycle({
        workflowRunId: runId,
        targetSubagents: 12,
        countPolicy: 'dynamic_automatic',
        waveCapacity: 8
      })
    }))

    for (let index = 1; index <= 16; index += 1) {
      const threadId = `thread-${index}`
      await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId }, 'SubagentStart')
      if (index === 1) {
        await recordSubagentEvent(dir, { agent_id: threadId, workflow_run_id: runId, failed: true }, 'SubagentStop')
      }
      await recordSubagentEvent(dir, {
        agent_id: threadId,
        workflow_run_id: runId,
        last_assistant_message: 'Retry completed the assigned slice.'
      }, 'SubagentStop')
    }

    const lifecycle = await refreshSubagentWaveLifecycle(dir)
    const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    assert.equal(lifecycle?.target_subagents, 16)
    assert.equal(lifecycle?.cumulative_started, 16)
    assert.equal(lifecycle?.cumulative_completed, 16)
    assert.equal(lifecycle?.cumulative_failed, 0)
    assert.equal(effectiveSubagentTarget(plan, 16).targetSubagents, 16)
    assert.deepEqual(subagentCountContractBlockers(plan, 16), [])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('exact lifecycle target tampering cannot change the sealed target', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-exact-tamper-'))
  const runId = 'run-exact-tamper'
  try {
    const lifecycle = createSubagentWaveLifecycle({
      workflowRunId: runId,
      targetSubagents: 2,
      countPolicy: 'exact'
    })
    lifecycle.target_subagents = 4
    await fs.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
      schema: 'sks.subagent-plan.v1',
      workflow_run_id: runId,
      requested_subagents: 2,
      requested_subagents_source: 'operator',
      max_threads: 12,
      wave_lifecycle: lifecycle
    }))

    const refreshed = await refreshSubagentWaveLifecycle(dir)
    const plan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    assert.equal(refreshed?.requested_target_subagents, 2)
    assert.equal(refreshed?.target_subagents, 2)
    assert.equal(refreshed?.target_change_rejected, true)
    assert.equal(effectiveSubagentTarget(plan).targetSubagents, 2)
    assert.deepEqual(subagentCountContractBlockers(plan), ['subagent_target_change_rejected'])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('wave capacity is enforced from real lifecycle thread membership', () => {
  const lifecycle = createSubagentWaveLifecycle({
    workflowRunId: 'run-wave-capacity',
    targetSubagents: 6,
    countPolicy: 'exact',
    waveCapacity: 2
  })
  lifecycle.waves = [{
    wave: 1,
    status: 'running',
    thread_ids: ['thread-1', 'thread-2', 'thread-3'],
    settled_thread_ids: [],
    started_at: '2026-07-31T00:00:00.000Z',
    settled_at: null
  }]
  delete (lifecycle as Partial<typeof lifecycle>).peak_open_threads
  assert.deepEqual(
    subagentCountContractBlockers({
      schema: 'sks.subagent-plan.v1',
      requested_subagents: 6,
      wave_lifecycle: lifecycle
    }),
    ['subagent_wave_capacity_exceeded:3/2']
  )
})

test('a decomposed wider wave is not throttled by the pre-decomposition first_wave', async () => {
  // `first_wave` is frozen before decomposition and nothing rewrites it. Using it
  // as the wave capacity throttled every later wave and raised a false
  // `subagent_wave_capacity_exceeded` the moment the parent opened the wider wave
  // its own decomposition justified — so maximum parallelism was unreachable.
  const runId = 'run-wide-wave'
  // Preparation asked for 4 and froze first_wave at 4; the parent then decomposed
  // into 8 genuinely independent slices, so the target outgrew the plan.
  const plan = {
    schema: 'sks.subagent-plan.v1',
    workflow_run_id: runId,
    requested_subagents: 4,
    requested_subagents_source: 'automatic',
    first_wave: 4,
    max_threads: 256,
    fanout_policy: { automatic_ceiling: 256, mode: 'parent_owned_risk_based' },
    capacity_controller: { selected_capacity: 4, available_thread_slots: 250 },
    wave_lifecycle: createSubagentWaveLifecycle({
      workflowRunId: runId,
      targetSubagents: 4,
      countPolicy: 'dynamic_automatic',
      waveCapacity: 4
    })
  }
  const events = Array.from({ length: 8 }, (_, index) => ({
    run_id: runId,
    event_name: 'SubagentStart' as const,
    thread_id: `thread-${index}`
  }))

  const roomy = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-wide-'))
  try {
    const lifecycle = await refreshSubagentWaveLifecycle(roomy, { plan, events: events as any })
    assert.ok(lifecycle)
    assert.equal(lifecycle!.target_subagents, 8)
    assert.equal(lifecycle!.wave_capacity, 8, 'capacity must follow the decomposed target when the host has slots')
    assert.deepEqual(
      subagentCountContractBlockers({ ...plan, wave_lifecycle: lifecycle }),
      [],
      'the wider wave the parent decomposed must not be reported as exceeding capacity'
    )
  } finally {
    await fs.rm(roomy, { recursive: true, force: true })
  }

  // The guard still has teeth: a live thread-slot shortage caps the grown target
  // rather than letting it open the full 8. It never drops below the wave width
  // preparation already promised, so an in-flight wave is not retroactively
  // narrowed.
  const scarce = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-scarce-'))
  try {
    const lifecycle = await refreshSubagentWaveLifecycle(scarce, {
      plan: { ...plan, capacity_controller: { selected_capacity: 4, available_thread_slots: 3 } },
      events: events as any
    })
    assert.ok(lifecycle)
    assert.equal(lifecycle!.target_subagents, 8)
    assert.equal(lifecycle!.wave_capacity, 4)
  } finally {
    await fs.rm(scarce, { recursive: true, force: true })
  }

  // A plan whose target never outgrew its requested count keeps its deliberate
  // wave staging: capacity stays at the planned width, not the target.
  const staged = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-wave-staged-'))
  try {
    const lifecycle = await refreshSubagentWaveLifecycle(staged, {
      plan: { ...plan, requested_subagents: 8 },
      events: events as any
    })
    assert.ok(lifecycle)
    assert.equal(lifecycle!.target_subagents, 8)
    assert.equal(lifecycle!.wave_capacity, 4)
  } finally {
    await fs.rm(staged, { recursive: true, force: true })
  }
})
