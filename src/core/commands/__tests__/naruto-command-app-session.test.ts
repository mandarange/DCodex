import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createMission, loadStateForSession, setCurrent } from '../../mission.js'
import { evaluateHookPayload } from '../../hooks-runtime.js'
import {
  OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION,
  SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR
} from '../../subagents/official-subagent-preparation.js'
import { injectNextNarutoPreparationFailureForTest, narutoCommand } from '../naruto-command.js'

test('App Naruto reuses the active mission bound to the current Codex thread state', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-session-'))
  const threadId = 'thread-app-session-regression'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldAppSession = process.env.SKS_NARUTO_APP_SESSION
  const oldStandalone = process.env.SKS_NARUTO_STANDALONE_CLI
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldExitCode = process.exitCode
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    const previous = await createMission(root, { mode: 'naruto', prompt: 'old mission', sessionKey: threadId })
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadId
    delete process.env.SKS_NARUTO_APP_SESSION
    delete process.env.SKS_NARUTO_STANDALONE_CLI
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    console.log = () => undefined
    console.warn = () => undefined

    const task = 'review independent packages'
    const result: any = await narutoCommand(['run', task, '--agents', '2', '--json'])
    const sessionState: any = await loadStateForSession(root, threadId)
    const [mission, intake, plan] = await Promise.all([
      fs.readFile(path.join(previous.dir, 'mission.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(previous.dir, 'request-intake.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(previous.dir, 'subagent-plan.json'), 'utf8').then(JSON.parse)
    ])

    assert.equal(result.mission_id, previous.id)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'delegation_context_ready')
    assert.equal(result.session_scope, threadId)
    assert.equal(result.artifacts.parent_summary, null)
    assert.equal(sessionState.mission_id, result.mission_id)
    assert.equal(sessionState.subagents_required, true)
    assert.equal(sessionState.agents_required, false)
    assert.equal(sessionState.phase, 'NARUTO_DELEGATION_CONTEXT_READY')
    assert.equal(sessionState.session_scope, threadId)
    assert.equal(plan.session_scope, threadId)
    assert.equal(plan.workflow_run_id, result.workflow_run_id)
    assert.equal(mission.prompt, task)
    assert.equal(intake.original_prompt, task)
    assert.equal(plan.goal, task)
  } finally {
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('SKS_NARUTO_APP_SESSION', oldAppSession)
    restoreEnv('SKS_NARUTO_STANDALONE_CLI', oldStandalone)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    process.exitCode = oldExitCode
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('App Naruto blocks invalid explicit config before entering the delegation runner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-config-blocker-'))
  const threadId = 'thread-app-config-blocker'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldGlobalRoot = process.env.SKS_GLOBAL_ROOT
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldExitCode = process.exitCode
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadId
    process.env.SKS_GLOBAL_ROOT = root
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    await fs.mkdir(path.join(root, '.codex'), { recursive: true })
    await fs.writeFile(
      path.join(root, '.codex', 'config.toml'),
      '[agents]\nmax_concurrent_threads_per_session = 257\n'
    )
    console.log = () => undefined
    console.warn = () => undefined

    const result: any = await narutoCommand(['run', 'must not delegate', '--json'])
    assert.equal(result.status, 'blocked')
    assert.ok(result.blockers.includes(
      'project_official_subagent_max_threads_exceeds_hard_cap:257:256'
    ))
    assert.equal(result.started_subagents, undefined)
  } finally {
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('SKS_GLOBAL_ROOT', oldGlobalRoot)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    process.exitCode = oldExitCode
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('a reused App Naruto mission resets stale completion artifacts and binds a fresh workflow run', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-stale-run-'))
  const threadId = 'thread-app-stale-run'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldGlobalRoot = process.env.SKS_GLOBAL_ROOT
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadId
    process.env.SKS_GLOBAL_ROOT = root
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    console.log = () => undefined
    console.warn = () => undefined

    const first: any = await narutoCommand(['run', 'old task', '--agents', '1', '--json'])
    const dir = path.join(root, '.sneakoscope', 'missions', first.mission_id)
    const firstPlan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    const staleSummary = {
      schema: 'sks.subagent-parent-summary.v1',
      status: 'completed',
      summary: 'Old task integrated.',
      run_id: firstPlan.workflow_run_id,
      thread_outcomes: [{ thread_id: 'old-agent', status: 'completed', summary: 'Old task completed.' }],
      changed_files: [],
      verification: [],
      blockers: []
    }
    await fs.writeFile(path.join(dir, 'subagent-events.jsonl'), [
      JSON.stringify({ event_name: 'SubagentStart', agent_id: 'old-agent', workflow_run_id: firstPlan.workflow_run_id }),
      JSON.stringify({ event_name: 'SubagentStop', agent_id: 'old-agent', workflow_run_id: firstPlan.workflow_run_id })
    ].join('\n') + '\n')
    await fs.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify(staleSummary))
    await fs.writeFile(path.join(dir, 'subagent-evidence.json'), JSON.stringify({ schema: 'sks.subagent-evidence.v1', ok: true, run_id: firstPlan.workflow_run_id }))
    await fs.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ schema: 'sks.naruto-gate.v1', passed: true, workflow_run_id: firstPlan.workflow_run_id }))
    await fs.writeFile(path.join(dir, 'completion-proof.json'), JSON.stringify({ mission_id: first.mission_id, evidence: { route_gate: { workflow_run_id: firstPlan.workflow_run_id } } }))
    await fs.writeFile(path.join(dir, 'completion-proof.md'), `# stale proof ${firstPlan.workflow_run_id}\n`)
    const staleCaptureDir = path.join(dir, SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR, 'old-run')
    await fs.mkdir(staleCaptureDir, { recursive: true })
    await fs.writeFile(path.join(staleCaptureDir, 'old-failure.json'), '{}\n')
    await setCurrent(root, {
      reflection_invalidation_required: true,
      reflection_invalidated_at: 'stale-r1-reflection',
      reflection_invalidation_reason: 'naruto_terminal_proof_committed',
      reflection_invalidated_for_workflow_run_id: firstPlan.workflow_run_id,
      reflection_invalidated_for_proof_digest: 'stale-r1-digest'
    }, { sessionKey: threadId })

    const second: any = await narutoCommand(['run', 'new task', '--agents', '1', '--json'])
    const secondPlan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    const evidence = JSON.parse(await fs.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8'))
    const gate = JSON.parse(await fs.readFile(path.join(dir, 'naruto-gate.json'), 'utf8'))
    const events = await fs.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8')
    const state: any = await loadStateForSession(root, threadId)

    assert.equal(second.mission_id, first.mission_id)
    assert.notEqual(secondPlan.workflow_run_id, firstPlan.workflow_run_id)
    assert.equal(second.workflow_run_id, secondPlan.workflow_run_id)
    assert.equal(evidence.run_id, secondPlan.workflow_run_id)
    assert.equal(evidence.ok, false)
    assert.equal(evidence.preparation_only, true)
    assert.equal(gate.workflow_run_id, secondPlan.workflow_run_id)
    assert.equal(gate.passed, false)
    assert.equal(events, '')
    await assert.rejects(fs.access(path.join(dir, 'subagent-parent-summary.json')))
    await assert.rejects(fs.access(path.join(dir, 'completion-proof.json')))
    await assert.rejects(fs.access(path.join(dir, 'completion-proof.md')))
    await assert.rejects(fs.access(path.join(dir, SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR)))
    assert.equal(state.official_subagent_run_id, secondPlan.workflow_run_id)
    assert.equal(state.reflection_invalidation_required, false)
    assert.equal(state.reflection_invalidated_at, null)
    assert.equal(state.reflection_invalidated_for_workflow_run_id, null)
    assert.equal(state.reflection_invalidated_for_proof_digest, null)
  } finally {
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('SKS_GLOBAL_ROOT', oldGlobalRoot)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('App Naruto retry recovers a post-state preparation marker before using the pending fast path', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-preparation-recovery-'))
  const threadId = 'thread-app-preparation-recovery'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldGlobalRoot = process.env.SKS_GLOBAL_ROOT
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadId
    process.env.SKS_GLOBAL_ROOT = root
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    console.log = () => undefined
    console.warn = () => undefined

    const first: any = await narutoCommand(['run', 'first app task', '--agents', '1', '--json'])
    const dir = path.join(root, '.sneakoscope', 'missions', first.mission_id)
    const markerFile = path.join(dir, OFFICIAL_SUBAGENT_PREPARATION_TRANSACTION)
    injectNextNarutoPreparationFailureForTest('after_state_commit_before_marker_clear')
    await assert.rejects(
      narutoCommand(['run', 'second app task', '--agents', '1', '--json']),
      /after_state_commit_before_marker_clear/
    )
    const interruptedPlan = JSON.parse(await fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8'))
    const interruptedState: any = await loadStateForSession(root, threadId)
    await fs.access(markerFile)
    assert.notEqual(interruptedPlan.workflow_run_id, first.workflow_run_id)
    assert.equal(interruptedState.official_subagent_run_id, interruptedPlan.workflow_run_id)

    const recovered: any = await narutoCommand(['run', 'second app task', '--agents', '1', '--json'])
    const recoveredState: any = await loadStateForSession(root, threadId)
    assert.equal(recovered.workflow_run_id, interruptedPlan.workflow_run_id)
    assert.equal(recoveredState.official_subagent_run_id, interruptedPlan.workflow_run_id)
    await assert.rejects(fs.access(markerFile))

    const eventsBefore = await fs.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8')
    await evaluateHookPayload('subagent-start', {
      conversation_id: threadId,
      session_id: threadId,
      turn_id: 'post-recovery-start',
      hook_event_name: 'SubagentStart',
      workflow_run_id: interruptedPlan.workflow_run_id,
      agent_id: 'post-recovery-agent',
      agent_type: 'worker',
      model: 'gpt-5.6-luna'
    }, { root, state: recoveredState })
    const eventsAfter = await fs.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8')
    assert.notEqual(eventsAfter, eventsBefore)
    assert.match(eventsAfter, /post-recovery-agent/)
  } finally {
    injectNextNarutoPreparationFailureForTest(null)
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('SKS_GLOBAL_ROOT', oldGlobalRoot)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('App Naruto never reuses another Codex thread mission and latest status stays session-scoped', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-isolation-'))
  const threadA = 'thread-app-a'
  const threadB = 'thread-app-b'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    const missionA = await createMission(root, { mode: 'naruto', prompt: 'thread A mission', sessionKey: threadA })
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadB
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    console.log = () => undefined
    console.warn = () => undefined

    const resultB: any = await narutoCommand(['run', 'review two independent files', '--agents', '2', '--json'])
    assert.notEqual(resultB.mission_id, missionA.id)
    const stateB: any = await loadStateForSession(root, threadB)
    assert.equal(stateB.mission_id, resultB.mission_id)

    const statusB: any = await narutoCommand(['status', 'latest', '--json'])
    assert.equal(statusB.mission_id, resultB.mission_id)
  } finally {
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('concurrent App Naruto runs atomically reuse one mission for the same Codex thread', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-app-session-race-'))
  const threadId = 'thread-app-session-race'
  const oldCwd = process.cwd()
  const oldThreadId = process.env.CODEX_THREAD_ID
  const oldGlobalRoot = process.env.SKS_GLOBAL_ROOT
  const oldHome = process.env.HOME
  const oldCodexHome = process.env.CODEX_HOME
  const oldLog = console.log
  const oldWarn = console.warn
  try {
    process.chdir(root)
    process.env.CODEX_THREAD_ID = threadId
    process.env.SKS_GLOBAL_ROOT = root
    process.env.HOME = path.join(root, 'home')
    process.env.CODEX_HOME = path.join(root, 'home', '.codex')
    console.log = () => undefined
    console.warn = () => undefined

    const [first, second]: any[] = await Promise.all([
      narutoCommand(['run', 'review the same two independent files', '--agents', '2', '--json']),
      narutoCommand(['run', 'review the same two independent files', '--agents', '2', '--json'])
    ])

    assert.equal(first.mission_id, second.mission_id)
    assert.equal(first.workflow_run_id, second.workflow_run_id)
    assert.deepEqual(first.artifacts, second.artifacts)
    assert.deepEqual(
      [first.attached_to_pending_run, second.attached_to_pending_run].sort(),
      [false, true]
    )
    assert.equal(first.ok, false)
    assert.equal(second.ok, false)
    assert.equal(first.status, 'delegation_context_ready')
    assert.equal(second.status, 'delegation_context_ready')
    assert.equal(first.completion_evidence, false)
    assert.equal(second.completion_evidence, false)
    assert.equal(first.session_scope, threadId)
    assert.equal(second.session_scope, threadId)
    const missionIds = (await fs.readdir(path.join(root, '.sneakoscope', 'missions')))
      .filter((entry) => entry.startsWith('M-'))
    assert.deepEqual(missionIds, [first.mission_id])
    const dir = path.join(root, '.sneakoscope', 'missions', first.mission_id)
    const [plan, evidence, summary, gate] = await Promise.all([
      fs.readFile(path.join(dir, 'subagent-plan.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(dir, 'subagent-evidence.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(dir, 'naruto-summary.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(dir, 'naruto-gate.json'), 'utf8').then(JSON.parse)
    ])
    assert.equal(plan.workflow_run_id, first.workflow_run_id)
    assert.equal(evidence.run_id, first.workflow_run_id)
    assert.equal(summary.workflow_run_id, first.workflow_run_id)
    assert.equal(gate.workflow_run_id, first.workflow_run_id)
    assert.equal(plan.session_scope, threadId)
    assert.equal(summary.session_scope, threadId)
    assert.equal(evidence.preparation_only, true)
    assert.equal(gate.passed, false)
    const [mission, intake] = await Promise.all([
      fs.readFile(path.join(dir, 'mission.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(dir, 'request-intake.json'), 'utf8').then(JSON.parse)
    ])
    assert.equal(mission.prompt, 'review the same two independent files')
    assert.equal(intake.original_prompt, mission.prompt)
    const sessionState: any = await loadStateForSession(root, threadId)
    assert.equal(sessionState.mission_id, first.mission_id)
    assert.equal(sessionState.official_subagent_run_id, first.workflow_run_id)
    assert.equal(sessionState.session_scope, threadId)
  } finally {
    process.chdir(oldCwd)
    restoreEnv('CODEX_THREAD_ID', oldThreadId)
    restoreEnv('SKS_GLOBAL_ROOT', oldGlobalRoot)
    restoreEnv('HOME', oldHome)
    restoreEnv('CODEX_HOME', oldCodexHome)
    console.log = oldLog
    console.warn = oldWarn
    await fs.rm(root, { recursive: true, force: true })
  }
})

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
