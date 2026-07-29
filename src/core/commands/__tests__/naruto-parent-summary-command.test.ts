import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { evaluateHookPayload } from '../../hooks-runtime.js'
import { loadStateForSession, missionDir, setCurrent } from '../../mission.js'
import { prepareRoute } from '../../pipeline.js'
import { runProcess } from '../../fsx.js'
import { installGlobalSkills } from '../../init/skills.js'

const PARENT_SUMMARY_STDIN_LIMIT = 1024 * 1024

test('App Naruto parent-summary command fails closed, finalizes canonically, and rejects terminal conflicts', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-parent-summary-command-'))
  const home = path.join(root, 'home')
  const session = 'naruto-parent-summary-command-session'
  const restoreEnvironment = setEnvironment({
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global')
  })
  try {
    await fsp.mkdir(home, { recursive: true })
    const skillInstall = await installGlobalSkills(home)
    assert.equal(skillInstall.ok, true, JSON.stringify(skillInstall, null, 2))
    await prepareRoute(root, '$Naruto --agents 2 verify the final result UX', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    })
    let state: any = await loadStateForSession(root, session)
    const dir = missionDir(root, state.mission_id)
    const runId = String(state.official_subagent_run_id)
    const summary = parentSummary(runId, ['parent-summary-a1', 'parent-summary-a2'])

    await recordThread(root, state, session, runId, 'parent-summary-a1')

    const invalidJson = await invokeParentSummary(root, session, state.mission_id, '{')
    assert.equal(invalidJson.code, 1)
    assert.ok(invalidJson.result.blockers.includes('naruto_parent_summary_stdin_json_invalid'))
    await assert.rejects(fsp.access(path.join(dir, 'subagent-parent-summary.json')))

    const missingRunId = structuredClone(summary)
    delete (missingRunId as any).run_id
    const missingRun = await invokeParentSummary(root, session, state.mission_id, JSON.stringify(missingRunId))
    assert.equal(missingRun.code, 1)
    assert.ok(missingRun.result.blockers.some((blocker: string) => blocker.includes('parent_summary_run_id_missing')))
    await assert.rejects(fsp.access(path.join(dir, 'subagent-parent-summary.json')))

    const mismatchedRun = await invokeParentSummary(root, session, state.mission_id, JSON.stringify({
      ...summary,
      run_id: 'naruto-stale-run'
    }))
    assert.equal(mismatchedRun.code, 1)
    assert.ok(mismatchedRun.result.blockers.includes('naruto_parent_summary_run_id_mismatch'))
    await assert.rejects(fsp.access(path.join(dir, 'subagent-parent-summary.json')))

    const oversized = await invokeParentSummary(
      root,
      session,
      state.mission_id,
      'x'.repeat(PARENT_SUMMARY_STDIN_LIMIT + 1)
    )
    assert.equal(oversized.code, 1)
    assert.ok(oversized.result.blockers.includes(
      `naruto_parent_summary_stdin_too_large:${PARENT_SUMMARY_STDIN_LIMIT}`
    ))
    await assert.rejects(fsp.access(path.join(dir, 'subagent-parent-summary.json')))

    const incompleteSummary = parentSummary(runId, ['parent-summary-a1'])
    const incomplete = await invokeParentSummary(root, session, state.mission_id, JSON.stringify(incompleteSummary))
    assert.equal(incomplete.code, 1)
    assert.equal(incomplete.result.ok, false)
    assert.equal(incomplete.result.accepted, false)
    assert.ok(incomplete.result.blockers.some((blocker: string) => blocker.includes(
      'requested_subagent_completions_incomplete'
    )))
    assert.equal(
      JSON.parse(await fsp.readFile(path.join(dir, 'subagent-parent-summary.json'), 'utf8')).thread_outcomes.length,
      1
    )

    await recordThread(root, state, session, runId, 'parent-summary-a2')
    state = await loadStateForSession(root, session)

    const completed = await invokeParentSummary(root, session, state.mission_id, JSON.stringify(summary))
    assert.equal(completed.code, 0, JSON.stringify({
      stderr: completed.stderr,
      result: completed.result
    }, null, 2))
    assert.equal(completed.result.ok, true)
    assert.equal(completed.result.accepted, true)
    assert.equal(completed.result.workflow_run_id, runId)
    assert.equal(
      JSON.parse(await fsp.readFile(path.join(dir, 'subagent-parent-summary.json'), 'utf8')).thread_outcomes.length,
      2
    )

    const terminalFiles = [
      'subagent-parent-summary.json',
      'subagent-evidence.json',
      'naruto-gate.json',
      'completion-proof.json'
    ]
    const terminalBytes = await readFiles(dir, terminalFiles)
    const replay = await invokeParentSummary(root, session, state.mission_id, JSON.stringify(summary))
    assert.equal(replay.code, 0, replay.stderr)
    assert.equal(replay.result.ok, true)
    assert.deepEqual(await readFiles(dir, terminalFiles), terminalBytes)

    const conflict = await invokeParentSummary(root, session, state.mission_id, JSON.stringify({
      ...summary,
      summary: 'Conflicting terminal integration result.'
    }))
    assert.equal(conflict.code, 1)
    assert.ok(conflict.result.blockers.includes('naruto_parent_summary_conflicts_with_canonical'))
    assert.deepEqual(await readFiles(dir, terminalFiles), terminalBytes)
  } finally {
    restoreEnvironment()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('App parent-summary finalizes an official subagent run owned by another active route', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-cross-route-parent-summary-'))
  const home = path.join(root, 'home')
  const session = 'cross-route-parent-summary-session'
  const restoreEnvironment = setEnvironment({
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: path.join(home, '.codex'),
    SKS_GLOBAL_ROOT: path.join(home, '.sneakoscope-global')
  })
  try {
    await fsp.mkdir(home, { recursive: true })
    const skillInstall = await installGlobalSkills(home)
    assert.equal(skillInstall.ok, true, JSON.stringify(skillInstall, null, 2))
    await prepareRoute(root, '$Naruto --agents 1 verify an Image UX route slice', {}, {
      sessionKey: session,
      parentModel: 'gpt-5.6-sol'
    })
    let state: any = await loadStateForSession(root, session)
    const runId = String(state.official_subagent_run_id)
    await recordThread(root, state, session, runId, 'cross-route-a1')
    const dir = missionDir(root, state.mission_id)
    assert.match(await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'), /cross-route-a1/)
    await setCurrent(root, {
      mode: 'IMAGE_UX_REVIEW',
      route: 'ImageUXReview',
      route_command: '$Image-UX-Review',
      subagents_required: true
    }, { sessionKey: session })
    state = await loadStateForSession(root, session)
    assert.match(await fsp.readFile(path.join(dir, 'subagent-events.jsonl'), 'utf8'), /cross-route-a1/)

    const completed = await invokeParentSummary(
      root,
      session,
      state.mission_id,
      JSON.stringify(parentSummary(runId, ['cross-route-a1']))
    )
    assert.equal(completed.code, 0, JSON.stringify(completed, null, 2))
    assert.equal(completed.result.ok, true)
    assert.equal(completed.result.status, 'completed')
    assert.equal(completed.result.workflow_run_id, runId)
    assert.equal(state.route, 'ImageUXReview')
  } finally {
    restoreEnvironment()
    await fsp.rm(root, { recursive: true, force: true })
  }
})

async function recordThread(
  root: string,
  state: any,
  session: string,
  runId: string,
  threadId: string
) {
  const base = {
    conversation_id: session,
    session_id: session,
    turn_id: `turn-${threadId}`,
    workflow_run_id: runId,
    agent_id: threadId,
    thread_id: threadId,
    agent_type: 'worker',
    model: 'gpt-5.6-luna',
    permission_mode: 'default'
  }
  await evaluateHookPayload('subagent-start', {
    ...base,
    hook_event_name: 'SubagentStart'
  }, { root, state })
  await evaluateHookPayload('subagent-stop', {
    ...base,
    hook_event_name: 'SubagentStop',
    last_assistant_message: `${threadId} completed its bounded slice.`,
    stop_hook_active: false
  }, { root, state })
}

function parentSummary(runId: string, threadIds: string[]) {
  return {
    schema: 'sks.subagent-parent-summary.v1',
    run_id: runId,
    status: 'completed',
    summary: 'Integrated every requested slice and verified the final result UX.',
    thread_outcomes: threadIds.map((threadId) => ({
      thread_id: threadId,
      status: 'completed',
      summary: `${threadId} completed`
    })),
    changed_files: [],
    verification: [
      { name: 'focused parent-summary command regression', status: 'passed' }
    ],
    artifacts: [],
    capabilities_used: [],
    blockers: []
  }
}

async function invokeParentSummary(
  root: string,
  session: string,
  missionId: string,
  input: string
) {
  const moduleUrl = new URL('../naruto-command.js', import.meta.url).href
  const script = [
    `const { narutoCommand } = await import(${JSON.stringify(moduleUrl)});`,
    `await narutoCommand(['parent-summary', '--mission', ${JSON.stringify(missionId)}, '--stdin', '--json']);`
  ].join('\n')
  const run = await runProcess(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: root,
    input,
    env: {
      CODEX_THREAD_ID: session,
      SKS_NARUTO_APP_SESSION: '1',
      SKS_NARUTO_STANDALONE_CLI: '0',
      SKS_GLOBAL_ROOT: root,
      HOME: String(process.env.HOME),
      USERPROFILE: String(process.env.USERPROFILE),
      CODEX_HOME: String(process.env.CODEX_HOME)
    },
    timeoutMs: 30_000,
    maxOutputBytes: 256 * 1024
  })
  return {
    code: run.code,
    stderr: run.stderr,
    result: JSON.parse(run.stdout)
  }
}

async function readFiles(dir: string, names: string[]) {
  return Promise.all(names.map((name) => fsp.readFile(path.join(dir, name), 'utf8')))
}

function setEnvironment(values: Record<string, string>) {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) process.env[key] = value
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
