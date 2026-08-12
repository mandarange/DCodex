import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { spawn } from 'node:child_process'
import { runAgentCleanupExecutor } from '../agent-cleanup-executor.js'

/**
 * Cleanup used to run only on the way out, so anything that killed the
 * orchestrator left its workers running — and the sweep that should have caught
 * them on the next run skipped them, because a crashed run leaves every session
 * permanently non-terminal and "non-terminal" was being read as "active".
 *
 * The two halves are tested separately: that a quiet session stops shielding its
 * process, and that a live one still does. The second matters more than the
 * first — a sweep that kills a running sibling is worse than no sweep at all.
 */

const PROJECT_HASH = 'a'.repeat(64)

async function scratch(t: TestContext): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-pre-spawn-sweep-'))
  t.after(async () => fsp.rm(dir, { recursive: true, force: true }))
  return dir
}

function spawnStubborn(): ReturnType<typeof spawn> {
  return spawn(process.execPath, [
    '-e',
    "for (const s of ['SIGHUP','SIGINT','SIGTERM']) process.on(s, () => {}); setInterval(() => {}, 1000)"
  ], { stdio: 'ignore', detached: true })
}

async function seedMission(missionDir: string, input: {
  sessionId: string
  pid: number
  heartbeatAt: string
  status?: string
}): Promise<void> {
  const agentRoot = path.join(missionDir, 'agents')
  const sessionDir = path.join(agentRoot, 'sessions', input.sessionId)
  await fsp.mkdir(sessionDir, { recursive: true })
  await fsp.writeFile(
    path.join(missionDir, 'project-session-namespace.json'),
    JSON.stringify({ root_hash: PROJECT_HASH, mission_id: 'mission-sweep' })
  )
  await fsp.writeFile(path.join(agentRoot, 'agent-sessions.json'), JSON.stringify({
    sessions: {
      [input.sessionId]: {
        session_id: input.sessionId,
        agent_id: input.sessionId,
        status: input.status || 'running',
        heartbeat_at: input.heartbeatAt
      }
    }
  }))
  await fsp.writeFile(path.join(sessionDir, 'agent-process-report.json'), JSON.stringify({
    schema: 'sks.agent-process-report.v1',
    session_id: input.sessionId,
    agent_id: input.sessionId,
    project_hash: PROJECT_HASH,
    pid: input.pid,
    // Null exit code is the claim "this process was still running when recorded".
    exit_code: null
  }))
}

async function processExits(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !processIsAlive(pid)
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('an orphan whose session went quiet is reaped instead of shielded forever', {
  skip: process.platform === 'win32'
}, async (t) => {
  const missionDir = await scratch(t)
  const orphan = spawnStubborn()
  const pid = orphan.pid as number
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })
  assert.ok(pid > 0)

  // A run that crashed: the session is still "running" because the code that
  // would have closed it died, and the heartbeat stopped an hour ago.
  await seedMission(missionDir, {
    sessionId: 'slot-001',
    pid,
    heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  })

  const report = await runAgentCleanupExecutor({
    missionDir,
    missionId: 'mission-sweep',
    action: 'cleanup',
    apply: true,
    staleMs: 60_000
  })

  const terminated = (report.actions || []).filter((row: any) => row.kind === 'terminate_process')
  assert.equal(terminated.length, 1, `expected one termination, got ${JSON.stringify(report.actions)}`)
  assert.equal(terminated[0]?.status, 'applied')
  assert.equal(await processExits(pid, 10_000), true, 'the orphan must be gone before the next fan-out starts')
})

test('a worker that is still reporting in is never killed by the sweep', {
  skip: process.platform === 'win32'
}, async (t) => {
  // The dangerous direction. A concurrent run's live worker looks exactly like
  // an orphan except for its heartbeat, so the heartbeat has to be load-bearing.
  const missionDir = await scratch(t)
  const live = spawnStubborn()
  const pid = live.pid as number
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })

  await seedMission(missionDir, {
    sessionId: 'slot-live',
    pid,
    heartbeatAt: new Date().toISOString()
  })

  const report = await runAgentCleanupExecutor({
    missionDir,
    missionId: 'mission-sweep',
    action: 'cleanup',
    apply: true,
    staleMs: 60_000
  })

  assert.equal((report.actions || []).filter((row: any) => row.kind === 'terminate_process').length, 0)
  assert.ok(
    (report.actions || []).some((row: any) => row.kind === 'skip_active_session'),
    'a live session must be reported as skipped, not silently ignored'
  )
  assert.equal(processIsAlive(pid), true, 'a live worker must survive the sweep')
})

test('a process outside this project is never signalled', {
  skip: process.platform === 'win32'
}, async (t) => {
  const missionDir = await scratch(t)
  const foreign = spawnStubborn()
  const pid = foreign.pid as number
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })

  await seedMission(missionDir, {
    sessionId: 'slot-foreign',
    pid,
    heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  })
  // Same mission, but the process was recorded under a different project.
  const reportPath = path.join(missionDir, 'agents', 'sessions', 'slot-foreign', 'agent-process-report.json')
  const recorded = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
  await fsp.writeFile(reportPath, JSON.stringify({ ...recorded, project_hash: 'b'.repeat(64) }))

  const report = await runAgentCleanupExecutor({
    missionDir,
    missionId: 'mission-sweep',
    action: 'cleanup',
    apply: true,
    staleMs: 60_000
  })

  assert.equal((report.actions || []).filter((row: any) => row.kind === 'terminate_process').length, 0)
  assert.equal(processIsAlive(pid), true)
})

test('a recycled pid is never signalled, however stale the session', {
  skip: process.platform === 'win32'
}, async (t) => {
  // The recorded process already exited, so a live pid with that number belongs
  // to something else entirely. Killing it would be the worst outcome here.
  const missionDir = await scratch(t)
  const unrelated = spawnStubborn()
  const pid = unrelated.pid as number
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })

  await seedMission(missionDir, {
    sessionId: 'slot-recycled',
    pid,
    heartbeatAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
  })
  const reportPath = path.join(missionDir, 'agents', 'sessions', 'slot-recycled', 'agent-process-report.json')
  const recorded = JSON.parse(await fsp.readFile(reportPath, 'utf8'))
  await fsp.writeFile(reportPath, JSON.stringify({ ...recorded, exit_code: 0 }))

  const report = await runAgentCleanupExecutor({
    missionDir,
    missionId: 'mission-sweep',
    action: 'cleanup',
    apply: true,
    staleMs: 60_000
  })

  assert.equal((report.actions || []).filter((row: any) => row.kind === 'terminate_process').length, 0)
  assert.equal(processIsAlive(pid), true)
})

test('a session with no heartbeat at all reads as stale, not as fresh', {
  skip: process.platform === 'win32'
}, async (t) => {
  // Trusting a missing timestamp is what let crashed runs shield their orphans.
  const missionDir = await scratch(t)
  const orphan = spawnStubborn()
  const pid = orphan.pid as number
  t.after(() => { try { process.kill(pid, 'SIGKILL') } catch {} })

  await seedMission(missionDir, { sessionId: 'slot-nobeat', pid, heartbeatAt: '' })

  const report = await runAgentCleanupExecutor({
    missionDir,
    missionId: 'mission-sweep',
    action: 'cleanup',
    apply: true,
    staleMs: 60_000
  })

  assert.equal((report.actions || []).filter((row: any) => row.kind === 'terminate_process').length, 1)
  assert.equal(await processExits(pid, 10_000), true)
})
