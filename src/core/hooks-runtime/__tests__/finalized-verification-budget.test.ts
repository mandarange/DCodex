// First import: the subagent-skill-availability guard ledger resolves
// $HOME/.sneakoscope and would otherwise pollute the operator's real home.
import '../../__tests__/helpers/isolated-test-home.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { refreshOfficialSubagentCompletionArtifacts } from '../../hooks-runtime.js'
import { setCurrent } from '../../mission.js'
import { buildSsotGuard } from '../../safety/ssot-guard.js'
import { createSubagentWaveLifecycle } from '../../subagents/wave-lifecycle.js'

/**
 * Join-level cover for the parent's reported change surface reaching the
 * finalized verification budget.
 *
 * The plan's budget is a forecast written before anything changed. Every unit
 * test of the budget chooser supplies its own changed-file list, so none of them
 * can see a finalizer that keeps reporting the forecast after the real list
 * arrives. These assertions read the committed `naruto-summary.json`.
 */

const THREAD_IDS = ['thread-a', 'thread-b'] as const

interface FixtureOptions {
  taskProfile?: string | undefined
  plannedBudget?: string | undefined
  changedFiles: string[]
}

async function finalize(options: FixtureOptions) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-finalized-budget-'))
  const missionId = `M-20260812-090000-${Math.random().toString(16).slice(2, 10)}`
  const runId = `finalized-budget-${Math.random().toString(16).slice(2, 10)}`
  const sessionKey = `finalized-budget-${Math.random().toString(16).slice(2, 10)}`
  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  await fsp.mkdir(dir, { recursive: true })

  const state = {
    mission_id: missionId,
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    official_subagent_run_id: runId,
    subagents_required: true,
    _session_key: sessionKey
  }

  await writeJson(path.join(dir, 'mission.json'), {
    id: missionId,
    mode: 'Naruto',
    prompt: 'finalized verification budget fixture',
    created_at: '2026-08-12T03:00:00.000Z'
  })
  await writeJson(path.join(dir, 'subagent-plan.json'), {
    schema: 'sks.subagent-plan.v1',
    mission_id: missionId,
    route: '$Naruto',
    workflow: 'official_codex_subagent',
    workflow_run_id: runId,
    requested_subagents: THREAD_IDS.length,
    requested_subagents_source: 'automatic',
    max_threads: 12,
    max_depth: 1,
    config_blockers: [],
    ...(options.taskProfile === undefined ? {} : { task_profile: options.taskProfile }),
    ...(options.plannedBudget === undefined ? {} : { verification_budget: options.plannedBudget }),
    verification_checks: [],
    wave_lifecycle: createSubagentWaveLifecycle({
      workflowRunId: runId,
      targetSubagents: THREAD_IDS.length,
      countPolicy: 'dynamic_automatic'
    })
  })
  const events = THREAD_IDS.flatMap((threadId) => [
    subagentEvent('SubagentStart', threadId, runId),
    subagentEvent('SubagentStop', threadId, runId)
  ])
  await fsp.writeFile(
    path.join(dir, 'subagent-events.jsonl'),
    `${events.map((row) => JSON.stringify(row)).join('\n')}\n`
  )
  await writeJson(path.join(dir, 'ssot-guard.json'), buildSsotGuard({
    route: 'Naruto',
    mode: 'NARUTO',
    task: 'finalized verification budget fixture'
  }))
  await setCurrent(root, state, { replace: true, sessionKey })

  const parentSummary = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: `All ${THREAD_IDS.length} independent slices completed and were integrated.`,
    thread_outcomes: THREAD_IDS.map((threadId) => ({
      thread_id: threadId,
      status: 'completed',
      summary: `${threadId} completed`
    })),
    changed_files: options.changedFiles,
    verification: [{ name: 'focused Naruto verification', status: 'passed' }],
    blockers: [],
    run_id: runId
  }

  await refreshOfficialSubagentCompletionArtifacts(root, state, parentSummary, sessionKey)
  const summary = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-summary.json'), 'utf8'))
  return { summary, cleanup: () => fsp.rm(root, { recursive: true, force: true }) }
}

function subagentEvent(eventName: 'SubagentStart' | 'SubagentStop', threadId: string, runId: string) {
  return {
    schema: 'sks.subagent-event.v1',
    event_name: eventName,
    thread_id: threadId,
    run_id: runId,
    outcome: eventName === 'SubagentStart' ? 'started' : 'stopped',
    occurred_at: '2026-08-12T03:00:00.000Z'
  }
}

async function writeJson(file: string, value: unknown) {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('a run that turned out to touch release surface finalizes with the release budget', async () => {
  const fixture = await finalize({
    taskProfile: 'bounded-work',
    plannedBudget: 'affected',
    changedFiles: ['src/core/report/formatter.ts', 'package.json']
  })
  try {
    assert.equal(fixture.summary.verification.budget, 'release')
  } finally {
    await fixture.cleanup()
  }
})

test('a run that turned out broad finalizes with the confidence budget', async () => {
  const fixture = await finalize({
    taskProfile: 'bounded-work',
    plannedBudget: 'affected',
    changedFiles: Array.from({ length: 8 }, (_, index) => `src/core/report/part-${index}.ts`)
  })
  try {
    assert.equal(fixture.summary.verification.budget, 'confidence')
  } finally {
    await fixture.cleanup()
  }
})

test('a narrow run keeps the planned affected budget', async () => {
  const fixture = await finalize({
    taskProfile: 'bounded-work',
    plannedBudget: 'affected',
    changedFiles: ['src/core/report/formatter.ts']
  })
  try {
    assert.equal(fixture.summary.verification.budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})

test('an observed narrow surface never relaxes a stronger planned budget', async () => {
  const fixture = await finalize({
    taskProfile: 'bounded-work',
    plannedBudget: 'release',
    changedFiles: ['src/core/report/formatter.ts']
  })
  try {
    assert.equal(fixture.summary.verification.budget, 'release')
  } finally {
    await fixture.cleanup()
  }
})

test('a plan without a task profile falls back to the budget it recorded', async () => {
  const fixture = await finalize({
    plannedBudget: 'affected',
    changedFiles: ['package.json']
  })
  try {
    assert.equal(fixture.summary.verification.budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})

test('a plan with neither profile nor budget still reports a budget', async () => {
  const fixture = await finalize({ changedFiles: ['src/core/report/formatter.ts'] })
  try {
    assert.equal(fixture.summary.verification.budget, 'affected')
  } finally {
    await fixture.cleanup()
  }
})
