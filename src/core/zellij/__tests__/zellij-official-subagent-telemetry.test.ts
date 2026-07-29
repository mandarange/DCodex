import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { NormalizedSubagentEvent } from '../../subagents/subagent-evidence.js'
import {
  SKS_ZELLIJ_HOST_MISSION_ENV,
  officialSubagentSlotId,
  recordOfficialSubagentParentOutcomesTelemetry,
  recordOfficialSubagentZellijTelemetry
} from '../zellij-official-subagent-telemetry.js'
import { renderZellijSlotPane, renderZellijSlotPaneFromArtifacts } from '../zellij-slot-pane-renderer.js'
import { appendZellijSlotTelemetry, readZellijSlotTelemetrySnapshotNoRebuild } from '../zellij-slot-telemetry.js'
import {
  readOfficialSubagentRolloutActivity,
  refreshOfficialSubagentZellijActivity
} from '../zellij-official-subagent-activity.js'

function lifecycleEvent(
  eventName: 'SubagentStart' | 'SubagentStop',
  threadId: string,
  outcome: NormalizedSubagentEvent['outcome']
): NormalizedSubagentEvent {
  return {
    schema: 'sks.subagent-event.v1',
    event_name: eventName,
    thread_id: threadId,
    thread_id_source: 'thread_id',
    agent_id: threadId,
    session_id: 'parent-thread',
    turn_id: 'turn-1',
    run_id: 'run-1',
    run_epoch: null,
    model: 'gpt-5.6-sol',
    outcome,
    occurred_at: new Date().toISOString()
  }
}

function parentSummary(threadId: string, status: 'completed' | 'failed', summary: string) {
  return {
    schema: 'sks.subagent-parent-summary.v1',
    status,
    summary: status === 'completed' ? 'Parent integrated the verified result.' : 'Parent rejected the failed result.',
    thread_outcomes: [{ thread_id: threadId, status, summary }],
    changed_files: [],
    verification: [],
    blockers: status === 'completed' ? [] : ['thread_failed'],
    run_id: 'run-1'
  }
}

test('official subagent lifecycle mirrors into route and host missions and waits for a trustworthy parent verdict', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-subagent-'))
  const routeMissionId = 'M-route'
  const hostMissionId = 'M-host'
  const threadId = 'thread-alpha'
  const env = { [SKS_ZELLIJ_HOST_MISSION_ENV]: hostMissionId }
  const plan = {
    mission_id: routeMissionId,
    suggested_agents: ['debugger'],
    agents: {
      debugger: {
        model: 'gpt-5.6-sol',
        model_reasoning_effort: 'max'
      }
    }
  }

  try {
    const started = await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId,
      event: lifecycleEvent('SubagentStart', threadId, 'started'),
      payload: {
        agent_type: 'debugger',
        task_title: 'Trace the failing lifecycle',
        provider: 'openai',
        model_reasoning_effort: 'max'
      },
      plan,
      env
    })
    assert.equal(started.written, true)

    for (const missionId of [routeMissionId, hostMissionId]) {
      const snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
      const row = snapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]
      assert.equal(row?.status, 'running')
      assert.equal(row?.role, 'debugger')
      assert.equal(row?.model, 'gpt-5.6-sol')
      assert.match(String(row?.task_title), /failing lifecycle/i)
    }

    const premature = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId,
      parentSummary: parentSummary(threadId, 'completed', 'Root cause verified and fix accepted.'),
      plan,
      env
    })
    assert.equal(premature.written, false)
    assert.equal(premature.blocker, 'subagent_stop_telemetry_missing')

    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId,
      event: lifecycleEvent('SubagentStop', threadId, 'stopped'),
      payload: {
        agent_type: 'debugger',
        last_assistant_message: 'Root cause isolated; parent verification is still required.'
      },
      plan,
      env
    })
    const verifying = await readZellijSlotTelemetrySnapshotNoRebuild(root, hostMissionId)
    const verifyingRow = verifying?.slots[`${officialSubagentSlotId(threadId)}:g1`]
    assert.equal(verifyingRow?.status, 'verifying')
    assert.equal(verifyingRow?.task_title, 'Trace the failing lifecycle')

    const ambiguous = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId,
      parentSummary: parentSummary(threadId, 'completed', 'Verification failed and remains unresolved.'),
      plan,
      env
    })
    assert.equal(ambiguous.written, false)
    const stillVerifying = await readZellijSlotTelemetrySnapshotNoRebuild(root, hostMissionId)
    assert.equal(stillVerifying?.slots[`${officialSubagentSlotId(threadId)}:g1`]?.status, 'verifying')

    const completed = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId,
      parentSummary: parentSummary(threadId, 'completed', 'Root cause verified and fix accepted.'),
      plan,
      env
    })
    assert.equal(completed.written, true)
    for (const missionId of [routeMissionId, hostMissionId]) {
      const snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
      const row = snapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]
      assert.equal(row?.status, 'completed')
      assert.match(String(row?.log_tail), /fix accepted/i)
    }

    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId,
      event: lifecycleEvent('SubagentStart', threadId, 'started'),
      payload: { agent_type: 'debugger', task_title: 'Second bounded investigation' },
      plan,
      env
    })
    const reused = await readZellijSlotTelemetrySnapshotNoRebuild(root, hostMissionId)
    assert.equal(reused?.slots[`${officialSubagentSlotId(threadId)}:g2`]?.status, 'running')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('trustworthy failed parent outcome becomes failed telemetry instead of a successful stop', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-subagent-failed-'))
  const missionId = 'M-failed'
  const threadId = 'thread-failed'
  try {
    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId: missionId,
      event: lifecycleEvent('SubagentStart', threadId, 'started'),
      payload: { agent_type: 'test_engineer' }
    })
    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId: missionId,
      event: lifecycleEvent('SubagentStop', threadId, 'failed'),
      payload: { agent_type: 'test_engineer', last_assistant_message: 'Two focused tests failed.' }
    })
    const beforeParent = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
    assert.equal(beforeParent?.slots[`${officialSubagentSlotId(threadId)}:g1`]?.status, 'verifying')

    const failed = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId: missionId,
      parentSummary: parentSummary(threadId, 'failed', 'Two focused tests failed.'),
      plan: {}
    })
    assert.equal(failed.written, true)
    const snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
    assert.equal(snapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]?.status, 'failed')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

for (const stopOutcome of ['failed', 'ambiguous'] as const) {
  test(`a completed parent verdict cannot override a ${stopOutcome} SubagentStop outcome`, async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), `sks-zellij-official-subagent-${stopOutcome}-`))
    const missionId = `M-${stopOutcome}-stop`
    const threadId = `thread-${stopOutcome}-stop`
    try {
      await recordOfficialSubagentZellijTelemetry({
        root,
        routeMissionId: missionId,
        event: lifecycleEvent('SubagentStart', threadId, 'started'),
        payload: { agent_type: 'reviewer' }
      })
      await recordOfficialSubagentZellijTelemetry({
        root,
        routeMissionId: missionId,
        event: lifecycleEvent('SubagentStop', threadId, stopOutcome),
        payload: { agent_type: 'reviewer', last_assistant_message: `${stopOutcome} result text` }
      })

      const result = await recordOfficialSubagentParentOutcomesTelemetry({
        root,
        routeMissionId: missionId,
        parentSummary: parentSummary(threadId, 'completed', 'Parent incorrectly marked this thread complete.'),
        plan: {}
      })
      assert.equal(result.written, true)

      const snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
      const row = snapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]
      assert.equal(row?.status, 'failed')
      assert.ok(row?.blockers.includes(`awaiting_parent_verdict:${stopOutcome}`))
      assert.ok(row?.blockers.includes('parent_thread_outcome_conflict:completed'))
      assert.match(String(row?.log_tail), /completed parent verdict rejected/i)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
}

test('parent outcome retries a host mission after a partial route/host write failure', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-subagent-retry-'))
  const routeMissionId = 'M-route-retry'
  const hostMissionId = 'M-host-retry'
  const threadId = 'thread-retry'
  const env = { [SKS_ZELLIJ_HOST_MISSION_ENV]: hostMissionId }
  const hostZellijDir = path.join(root, '.sneakoscope', 'missions', hostMissionId, 'zellij')
  const savedHostZellijDir = `${hostZellijDir}.saved`
  try {
    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId,
      event: lifecycleEvent('SubagentStart', threadId, 'started'),
      payload: { agent_type: 'integration_reviewer', task_title: 'Verify mirrored mission recovery' },
      env
    })
    await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId,
      event: lifecycleEvent('SubagentStop', threadId, 'stopped'),
      payload: { agent_type: 'integration_reviewer', last_assistant_message: 'Parent verdict pending.' },
      env
    })

    await fsp.rename(hostZellijDir, savedHostZellijDir)
    await fsp.writeFile(hostZellijDir, 'block host telemetry directory')
    const partial = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId,
      parentSummary: parentSummary(threadId, 'completed', 'Mirrored lifecycle verified.'),
      plan: {},
      env
    })
    assert.equal(partial.written, true)
    assert.ok('failed_mission_ids' in partial && partial.failed_mission_ids.includes(hostMissionId))
    const routeSnapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, routeMissionId)
    assert.equal(routeSnapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]?.status, 'completed')

    await fsp.rm(hostZellijDir, { force: true })
    await fsp.rename(savedHostZellijDir, hostZellijDir)
    const retried = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId,
      parentSummary: parentSummary(threadId, 'completed', 'Mirrored lifecycle verified.'),
      plan: {},
      env
    })
    assert.equal(retried.written, true)
    assert.equal('failed_mission_ids' in retried ? retried.failed_mission_ids.length : -1, 0)
    const hostSnapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, hostMissionId)
    assert.equal(hostSnapshot?.slots[`${officialSubagentSlotId(threadId)}:g1`]?.status, 'completed')
  } finally {
    await fsp.rm(hostZellijDir, { force: true }).catch(() => undefined)
    await fsp.rename(savedHostZellijDir, hostZellijDir).catch(() => undefined)
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('official subagent viewport renders the observed model and reasoning effort', () => {
  const rendered = renderZellijSlotPane({
    slotId: 'sub-fixture',
    generationIndex: 1,
    status: 'running',
    role: 'debugger',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'max',
    serviceTier: 'standard',
    currentTask: 'Trace the failure'
  })
  assert.match(rendered, /gpt-5\.6-sol/)
  assert.match(rendered, /max/)
  assert.match(rendered, /Trace the failure/)
})

test('unknown live telemetry does not hide stronger artifact model metadata', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-artifact-model-fallback-'))
  const missionId = 'M-artifact-model-fallback'
  const artifactDir = path.join(root, 'worker-artifacts')
  await fsp.mkdir(artifactDir, { recursive: true })
  await fsp.writeFile(path.join(artifactDir, 'codex-control-proof.json'), JSON.stringify({
    config: {
      model: 'gpt-5.6-sol',
      model_provider: 'openai',
      service_tier: 'standard',
      model_reasoning_effort: 'max'
    }
  }))
  try {
    await appendZellijSlotTelemetry(root, {
      schema: 'sks.zellij-slot-telemetry-event.v1',
      ts: new Date().toISOString(),
      mission_id: missionId,
      slot_id: 'slot-artifact',
      generation_index: 1,
      worker_id: 'worker-artifact',
      event_type: 'worker_spawned',
      status: 'running',
      task_title: 'Artifact-backed task'
    })
    const rendered = await renderZellijSlotPaneFromArtifacts({
      artifactDir,
      artifactRoot: root,
      missionId,
      slotId: 'slot-artifact',
      generationIndex: 1
    })
    assert.match(rendered, /gpt-5\.6-sol/)
    assert.match(rendered, /max/)
    assert.doesNotMatch(rendered, /unknown·unknown/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('official rollout polling shows continuous per-thread activity without cross-attributing concurrent agents', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-live-'))
  const codexHome = path.join(root, 'codex-home')
  const missionId = 'M-live-official'
  const alpha = '019f-live-alpha'
  const beta = '019f-live-beta'
  const spawnedAt = new Date(Date.now() - 10_000)
  const env = {
    CODEX_HOME: codexHome,
    SKS_ZELLIJ_OFFICIAL_ACTIVITY_MIN_MS: '0',
    SKS_ZELLIJ_OFFICIAL_ACTIVITY_HEARTBEAT_MS: '1000'
  }
  try {
    const alphaRollout = await writeOfficialRollout(codexHome, alpha, spawnedAt, [
      rolloutRow(spawnedAt, 200, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'inherited parent activity must stay hidden' }),
      rolloutRow(spawnedAt, 2_000, 'turn_context', { model: 'gpt-5.6-sol', effort: 'max' }),
      rolloutRow(spawnedAt, 2_100, 'event_msg', { type: 'agent_reasoning', text: 'PRIVATE_ALPHA_REASONING' }),
      rolloutRow(spawnedAt, 2_200, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'alpha tracing parser lifecycle' })
    ])
    const betaRollout = await writeOfficialRollout(codexHome, beta, spawnedAt, [
      rolloutRow(spawnedAt, 2_000, 'turn_context', { model: 'gpt-5.6-sol', effort: 'max' }),
      rolloutRow(spawnedAt, 2_200, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'beta checking viewport renderer' })
    ])
    for (const [threadId, title] of [[alpha, 'Alpha assigned slice'], [beta, 'Beta assigned slice']] as const) {
      const started = lifecycleEvent('SubagentStart', threadId, 'started')
      started.occurred_at = new Date(spawnedAt.getTime() + 1_500).toISOString()
      await recordOfficialSubagentZellijTelemetry({
        root,
        routeMissionId: missionId,
        event: started,
        payload: { agent_type: 'debugger', task_title: title }
      })
    }

    const first = await refreshOfficialSubagentZellijActivity({ root, missionId, env })
    assert.equal(first.refreshed_threads.length, 2)
    let snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
    const alphaFirst = snapshot?.slots[`${officialSubagentSlotId(alpha)}:g1`]
    const betaFirst = snapshot?.slots[`${officialSubagentSlotId(beta)}:g1`]
    assert.match(String(alphaFirst?.task_title), /alpha tracing parser/i)
    assert.match(String(betaFirst?.task_title), /beta checking viewport/i)
    assert.doesNotMatch(String(alphaFirst?.log_tail), /beta checking/i)
    assert.doesNotMatch(String(betaFirst?.log_tail), /alpha tracing/i)
    assert.doesNotMatch(String(alphaFirst?.log_tail), /PRIVATE_ALPHA_REASONING|inherited parent activity/i)
    const firstAlphaHash = alphaFirst?.activity_hash

    await fsp.appendFile(alphaRollout, `${JSON.stringify(rolloutRow(spawnedAt, 4_000, 'event_msg', {
      type: 'patch_apply_end',
      status: 'completed',
      success: true,
      changes: { [path.join(root, 'src', 'alpha.ts')]: { type: 'update' } }
    }))}\n`)
    await fsp.appendFile(betaRollout, `${JSON.stringify(rolloutRow(spawnedAt, 4_100, 'event_msg', {
      type: 'web_search_end',
      query: 'beta official renderer contract'
    }))}\n`)
    const second = await refreshOfficialSubagentZellijActivity({ root, missionId, env })
    assert.equal(second.refreshed_threads.length, 2)
    snapshot = await readZellijSlotTelemetrySnapshotNoRebuild(root, missionId)
    const alphaSecond = snapshot?.slots[`${officialSubagentSlotId(alpha)}:g1`]
    const betaSecond = snapshot?.slots[`${officialSubagentSlotId(beta)}:g1`]
    assert.notEqual(alphaSecond?.activity_hash, firstAlphaHash)
    assert.equal(alphaSecond?.current_file, 'src/alpha.ts')
    assert.match(String(alphaSecond?.task_title), /applied patch/i)
    assert.match(String(betaSecond?.task_title), /beta official renderer contract/i)
    assert.doesNotMatch(String(alphaSecond?.log_tail), /beta official renderer/i)
    assert.doesNotMatch(String(betaSecond?.log_tail), /alpha\.ts/i)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('official rollout activity stays bounded, redacts obvious secrets, and never exposes reasoning text', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-bounded-'))
  const codexHome = path.join(root, 'codex-home')
  const threadId = '019f-live-bounded'
  const spawnedAt = new Date(Date.now() - 10_000)
  try {
    await writeOfficialRollout(codexHome, threadId, spawnedAt, [
      rolloutRow(spawnedAt, 2_000, 'event_msg', { type: 'agent_reasoning', text: 'DO_NOT_RENDER_THIS_REASONING' }),
      rolloutRow(spawnedAt, 2_100, 'event_msg', {
        type: 'agent_message',
        phase: 'commentary',
        message: `api_key=super-secret-value ${'x'.repeat(3_000)}`
      })
    ])
    const activity = await readOfficialSubagentRolloutActivity({
      threadId,
      startedAt: spawnedAt.toISOString(),
      projectRoot: root,
      env: { CODEX_HOME: codexHome }
    })
    assert.ok(activity)
    assert.ok(String(activity?.log_tail).length <= 1200)
    assert.doesNotMatch(String(activity?.log_tail), /super-secret-value|DO_NOT_RENDER_THIS_REASONING/)
    assert.match(String(activity?.log_tail), /api_key=\[redacted\]/i)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('official rollout reader rejects unsupported or non-subagent identities and ignores an incomplete final row', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-identity-'))
  const codexHome = path.join(root, 'codex-home')
  const spawnedAt = new Date(Date.now() - 10_000)
  try {
    const validThread = '019f-live-valid-tail'
    const validFile = await writeOfficialRollout(codexHome, validThread, spawnedAt, [
      rolloutRow(spawnedAt, 2_000, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'valid visible activity' })
    ])
    await fsp.appendFile(validFile, '{"timestamp":"incomplete')
    const valid = await readOfficialSubagentRolloutActivity({ threadId: validThread, startedAt: spawnedAt.toISOString(), env: { CODEX_HOME: codexHome } })
    assert.match(String(valid?.log_tail), /valid visible activity/i)

    const oldThread = '019f-live-old-version'
    const oldFile = await writeOfficialRollout(codexHome, oldThread, spawnedAt, [
      rolloutRow(spawnedAt, 2_000, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'must not render' })
    ])
    await rewriteRolloutIdentity(oldFile, (payload) => ({ ...payload, cli_version: '0.143.9' }))
    assert.equal(await readOfficialSubagentRolloutActivity({ threadId: oldThread, startedAt: spawnedAt.toISOString(), env: { CODEX_HOME: codexHome } }), null)

    const rootThread = '019f-live-not-subagent'
    const rootFile = await writeOfficialRollout(codexHome, rootThread, spawnedAt, [
      rolloutRow(spawnedAt, 2_000, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'must not render' })
    ])
    await rewriteRolloutIdentity(rootFile, (payload) => ({ ...payload, source: 'cli', parent_thread_id: null, thread_source: 'root' }))
    assert.equal(await readOfficialSubagentRolloutActivity({ threadId: rootThread, startedAt: spawnedAt.toISOString(), env: { CODEX_HOME: codexHome } }), null)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('official rollout activity resolves model and effort from the rollout head when turn_context leaves the tail window', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-zellij-official-head-'))
  const codexHome = path.join(root, 'codex-home')
  const threadId = '019f-live-head-model'
  const spawnedAt = new Date(Date.now() - 10_000)
  try {
    const rows: any[] = [
      rolloutRow(spawnedAt, 2_000, 'turn_context', { model: 'gpt-5.6-sol', effort: 'max' })
    ]
    // Push the only turn_context row out of the tail window with tool activity
    // from a single long turn, then leave a visible tail activity row.
    for (let index = 0; index < 900; index += 1) {
      rows.push(rolloutRow(spawnedAt, 2_100 + index, 'response_item', {
        type: 'function_call',
        name: 'exec_command',
        status: 'completed',
        call_id: `call-${index}`
      }))
    }
    rows.push(rolloutRow(spawnedAt, 4_500, 'event_msg', { type: 'agent_message', phase: 'commentary', message: 'tail activity visible' }))
    await writeOfficialRollout(codexHome, threadId, spawnedAt, rows)

    const activity = await readOfficialSubagentRolloutActivity({
      threadId,
      startedAt: spawnedAt.toISOString(),
      env: { CODEX_HOME: codexHome },
      tailBytes: 64 * 1024
    })
    assert.ok(activity)
    assert.match(String(activity?.task_title), /tail activity visible/i)
    assert.equal(activity?.model, 'gpt-5.6-sol')
    assert.equal(activity?.reasoning_effort, 'max')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

async function writeOfficialRollout(codexHome: string, threadId: string, spawnedAt: Date, rows: any[]): Promise<string> {
  const dir = path.join(
    codexHome,
    'sessions',
    String(spawnedAt.getFullYear()).padStart(4, '0'),
    String(spawnedAt.getMonth() + 1).padStart(2, '0'),
    String(spawnedAt.getDate()).padStart(2, '0')
  )
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-${spawnedAt.toISOString().replace(/[:.]/g, '-')}-${threadId}.jsonl`)
  const identity = {
    timestamp: spawnedAt.toISOString(),
    type: 'session_meta',
    payload: {
      id: threadId,
      cli_version: '0.144.3',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: 'parent-thread',
            depth: 1,
            agent_path: `/root/${threadId}`
          }
        }
      }
    }
  }
  await fsp.writeFile(file, `${[identity, ...rows].map((row) => JSON.stringify(row)).join('\n')}\n`)
  return file
}

function rolloutRow(base: Date, offsetMs: number, type: string, payload: Record<string, unknown>) {
  return {
    timestamp: new Date(base.getTime() + offsetMs).toISOString(),
    type,
    payload
  }
}

async function rewriteRolloutIdentity(file: string, update: (payload: Record<string, any>) => Record<string, any>) {
  const rows = (await fsp.readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean)
  const first = JSON.parse(rows[0] || '{}')
  first.payload = update(first.payload || {})
  rows[0] = JSON.stringify(first)
  await fsp.writeFile(file, `${rows.join('\n')}\n`)
}
