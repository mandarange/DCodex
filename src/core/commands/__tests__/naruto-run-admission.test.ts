import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NARUTO_MISSION_RUN_LOCK,
  withNarutoMissionRunAdmission
} from '../../subagents/official-subagent-preparation.js'
import { getOrCreateExplicitNarutoMission } from '../../mission.js'

const TERMINAL_FILES = [
  'subagent-plan.json',
  'subagent-events.jsonl',
  'subagent-parent-summary.json',
  'subagent-evidence.json',
  'naruto-summary.json',
  'naruto-gate.json'
]

test('20 concurrent callers admit one owner and never create a second workflow run', async () => {
  await withFixture('same-process', async ({ dir, missionId }) => {
    let executions = 0
    const results = await Promise.all(Array.from({ length: 20 }, () => withNarutoMissionRunAdmission({
      missionId,
      missionDir: dir,
      staleMs: 1_000
    }, async () => {
      executions += 1
      await delay(80)
      await writeCompletedBundle(dir, missionId, 'run-single-owner')
      return 'executed'
    })))

    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.kind === 'executed').length, 1)
    assert.equal(results.every((result) => ['executed', 'running', 'reused'].includes(result.kind)), true)
    for (const result of results) {
      if (result.kind === 'running') assert.equal(result.response.workflow_run_id, null)
    }
    const reentry = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async () => 'unexpected')
    assert.equal(reentry.kind, 'reused')
    if (reentry.kind === 'reused') {
      assert.equal(reentry.response.status, 'completed')
      assert.equal(reentry.response.workflow_run_id, 'run-single-owner')
      assert.equal(reentry.response.reused, true)
    }
  })
})

test('20 separate processes observe one mission-wide owner', { timeout: 30_000 }, async () => {
  await withFixture('multi-process', async ({ dir, missionId }) => {
    const marker = path.join(dir, 'owner-markers.jsonl')
    const ready = path.join(dir, 'admission-ready')
    const admit = path.join(dir, 'release-admission')
    const release = path.join(dir, 'release-owner')
    const moduleUrl = new URL('../../subagents/official-subagent-preparation.js', import.meta.url).href
    assert.equal(await exists(fileURLToPath(moduleUrl)), true, 'compiled admission module is required for process black-box')
    const observations: Array<Record<string, unknown>> = []
    const processes = Array.from({ length: 20 }, () => spawnAdmissionChild({
      moduleUrl,
      dir,
      missionId,
      marker,
      ready,
      admit,
      release
    }).then((result) => {
      observations.push(result)
      return result
    }))
    const allResults = Promise.all(processes)

    try {
      await waitFor(async () => await exists(ready) && (await fs.readdir(ready)).length === 20, 10_000)
      await fs.writeFile(admit, 'admit\n')
      await waitFor(async () => await exists(marker), 5_000)
      await Promise.race([
        waitFor(async () => observations.filter((result) => result.kind === 'running').length === 19, 10_000),
        allResults.then((results) => {
          throw new Error(`admission children completed before observer quorum: ${JSON.stringify(results)}`)
        })
      ])
      await fs.writeFile(release, 'release\n')
      const results = await allResults
      const markerLines = (await fs.readFile(marker, 'utf8')).trim().split(/\r?\n/).filter(Boolean)

      assert.equal(markerLines.length, 1)
      assert.equal(results.filter((result) => result.kind === 'executed').length, 1)
      assert.equal(results.filter((result) => result.kind === 'running').length, 19)
      assert.equal(results.filter((result) => result.kind === 'running').every((result) => result.already_running === true), true)
    } finally {
      await fs.writeFile(admit, 'admit\n').catch(() => undefined)
      await fs.writeFile(release, 'release\n').catch(() => undefined)
      await allResults.catch(() => undefined)
    }
  })
})

test('20 standalone CLI callers attempt one pinned Codex parent for one mission', { timeout: 30_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-cli-single-owner-'))
  const project = path.join(root, 'project')
  const home = path.join(root, 'home')
  const missionId = 'M-cli-single-owner'
  const dir = path.join(project, '.sneakoscope', 'missions', missionId)
  const ready = path.join(root, 'cli-ready')
  const admit = path.join(root, 'release-cli-admission')
  const barrierModule = path.join(root, 'cli-admission-barrier.mjs')
  const sksBin = fileURLToPath(new URL('../../../bin/sks.js', import.meta.url))
  let children: ReturnType<typeof spawnCliNarutoChild>[] = []
  let allResults: Promise<Array<{ code: number | null; json: Record<string, unknown>; stderr: string }>> | null = null

  try {
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(path.join(project, '.sneakoscope', 'state'), { recursive: true })
    await fs.mkdir(path.join(project, '.codex'), { recursive: true })
    await fs.mkdir(path.join(home, '.codex'), { recursive: true })
    await writeJson(path.join(dir, 'mission.json'), {
      id: missionId,
      mode: 'naruto',
      prompt: 'same mission fixture'
    })
    await writeJson(path.join(project, '.sneakoscope', 'state', 'current.json'), {
      mission_id: missionId,
      mode: 'NARUTO',
      phase: 'PREPARE'
    })
    await fs.writeFile(path.join(project, '.codex', 'config.toml'), [
      '[agents]',
      'max_threads = 4',
      'max_depth = 1',
      ''
    ].join('\n'))
    await fs.writeFile(path.join(home, '.codex', 'config.toml'), [
      'cli_auth_credentials_store = "file"',
      ''
    ].join('\n'))
    await fs.writeFile(barrierModule, [
      "import fs from 'node:fs'",
      "import path from 'node:path'",
      "const ready = String(process.env.SKS_TEST_ADMISSION_READY || '')",
      "const admit = String(process.env.SKS_TEST_ADMISSION_ADMIT || '')",
      "const caller = String(process.env.SKS_TEST_ADMISSION_CALLER || '')",
      "if (!ready || !admit || !caller) throw new Error('cli_admission_barrier_env_missing')",
      "fs.mkdirSync(ready, { recursive: true })",
      "fs.writeFileSync(path.join(ready, caller), 'ready\\n')",
      "const signal = new Int32Array(new SharedArrayBuffer(4))",
      "while (!fs.existsSync(admit)) Atomics.wait(signal, 0, 0, 20)"
    ].join('\n'))
    assert.equal(await exists(sksBin), true)

    const env = {
      ...process.env,
      HOME: home,
      CODEX_HOME: path.join(home, '.codex'),
      CODEX_CI: '1',
      SKS_AGENT_MODE: '1',
      SKS_DISABLE_UPDATE_CHECK: '1',
      SKS_UPDATE_MIGRATION_GATE_DISABLED: '1',
      SKS_NARUTO_STANDALONE_CLI: '1',
      SKS_PROVIDER: '',
      SKS_USE_CODEX_LB: '',
      SKS_MODEL_PROVIDER: '',
      CODEX_MODEL_PROVIDER: '',
      OPENAI_MODEL_PROVIDER: '',
      CODEX_THREAD_ID: ''
    }
    children = Array.from({ length: 20 }, (_, index) => spawnCliNarutoChild({
      sksBin,
      cwd: project,
      env,
      missionId,
      ready,
      admit,
      barrierModule: pathToFileURL(barrierModule).href,
      caller: String(index)
    }))
    allResults = Promise.all(children.map((entry) => entry.result))

    await waitFor(async () => await exists(ready) && (await fs.readdir(ready)).length === 20, 10_000)
    await fs.writeFile(admit, 'admit\n')
    const results = await allResults
    const ownerAttempts = results.filter((result) => {
      const blockers = Array.isArray(result.json.blockers) ? result.json.blockers.map(String) : []
      return result.code === 1
        && result.json.status === 'blocked'
        && result.json.reused !== true
        && blockers.some((blocker) => {
          const match = /^codex_parent_exit:(\d+)$/.exec(blocker)
          return match !== null && Number(match[1]) > 0
        })
    })
    const observers = results.filter((result) => {
      return (result.code === 0
          && result.json.status === 'running'
          && result.json.already_running === true)
        || (result.json.status === 'blocked' && result.json.reused === true)
    })

    assert.equal(ownerAttempts.length, 1, JSON.stringify(results))
    assert.equal(observers.length, 19, JSON.stringify(results))
  } finally {
    await fs.writeFile(admit, 'admit\n').catch(() => undefined)
    if (allResults) {
      await Promise.race([allResults.catch(() => undefined), delay(5_000)])
    }
    for (const entry of children) {
      if (entry.child.exitCode === null) entry.child.kill('SIGKILL')
    }
    await killProtectedAdmissionChildren(dir)
    if (allResults) await allResults.catch(() => undefined)
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('20 stale-lock waiters elect one recovery owner', async () => {
  await withFixture('stale-race', async ({ dir, missionId }) => {
    await writeOwner(dir, { pid: 999_999, heartbeatAt: '1970-01-01T00:00:00.000Z', staleMs: 1 })
    let executions = 0
    const results = await Promise.all(Array.from({ length: 20 }, () => withNarutoMissionRunAdmission({
      missionId,
      missionDir: dir,
      staleMs: 1
    }, async (lease) => {
      executions += 1
      assert.equal(lease.recovered, true)
      await delay(60)
      await writeCompletedBundle(dir, missionId, 'run-recovered')
      return 'recovered'
    })))

    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.kind === 'executed').length, 1)
    assert.equal(results.filter((result) => result.kind === 'executed' && result.recovered).length, 1)
  })
})

test('live owner wins before identity conflict and is never reclaimed by elapsed time alone', async () => {
  await withFixture('live-owner', async ({ dir, missionId }) => {
    await writeJson(path.join(dir, 'subagent-plan.json'), {
      schema: 'sks.subagent-plan.v1',
      workflow: 'official_codex_subagent',
      mission_id: 'M-conflicting',
      workflow_run_id: 'run-live'
    })
    await writeOwner(dir, { pid: process.pid, heartbeatAt: '1970-01-01T00:00:00.000Z', staleMs: 1 })
    let executed = false
    const result = await withNarutoMissionRunAdmission({ missionId, missionDir: dir, staleMs: 1 }, async () => {
      executed = true
      return null
    })

    assert.equal(executed, false)
    assert.equal(result.kind, 'running')
    if (result.kind === 'running') {
      assert.equal(result.response.ok, true)
      assert.equal(result.response.completion_evidence, false)
      assert.equal(result.response.status, 'running')
      assert.equal(result.response.already_running, true)
      assert.equal(result.response.workflow_run_id, 'run-live')
    }
  })
})

test('completed and blocked proof win before a live owner and completed bytes stay immutable', async () => {
  await withFixture('terminal', async ({ dir, missionId }) => {
    await writeCompletedBundle(dir, missionId, 'run-terminal')
    await writeOwner(dir, { pid: process.pid, heartbeatAt: new Date().toISOString(), staleMs: 60_000 })
    const before = await terminalMetadata(dir)
    for (let index = 0; index < 5; index += 1) {
      const result = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async () => 'unexpected')
      assert.equal(result.kind, 'reused')
      if (result.kind === 'reused') assert.equal(result.response.status, 'completed')
    }
    assert.deepEqual(await terminalMetadata(dir), before)
  })

  await withFixture('blocked-terminal', async ({ dir, missionId }) => {
    await writeBlockedBundle(dir, missionId, 'run-blocked')
    await writeOwner(dir, { pid: process.pid, heartbeatAt: new Date().toISOString(), staleMs: 60_000 })
    const result = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async () => 'unexpected')
    assert.equal(result.kind, 'reused')
    if (result.kind === 'reused') {
      assert.equal(result.response.status, 'blocked')
      assert.equal(result.response.ok, false)
      assert.equal(result.response.reused, true)
    }
  })
})

test('artifact mission and workflow-run identity conflicts block without reset or execution', async () => {
  await withFixture('identity-conflict', async ({ dir, missionId }) => {
    await writeJson(path.join(dir, 'subagent-plan.json'), {
      schema: 'sks.subagent-plan.v1',
      workflow: 'official_codex_subagent',
      mission_id: missionId,
      workflow_run_id: 'run-a'
    })
    await writeJson(path.join(dir, 'subagent-evidence.json'), {
      schema: 'sks.subagent-evidence.v1',
      workflow: 'official_codex_subagent',
      run_id: 'run-b'
    })
    const planBefore = await fs.readFile(path.join(dir, 'subagent-plan.json'))
    let executed = false
    const result = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async () => {
      executed = true
      return null
    })

    assert.equal(executed, false)
    assert.equal(result.kind, 'blocked')
    if (result.kind === 'blocked') {
      assert.deepEqual(result.response.blockers, ['naruto_mission_identity_conflict:workflow_run_id'])
    }
    assert.deepEqual(await fs.readFile(path.join(dir, 'subagent-plan.json')), planBefore)
  })
})

test('a stale incomplete mission cannot be restarted with a different task prompt', async () => {
  await withFixture('prompt-conflict', async ({ dir, missionId }) => {
    let executed = false
    const result = await withNarutoMissionRunAdmission({
      missionId,
      missionDir: dir,
      prompt: 'different task'
    }, async () => {
      executed = true
      return 'unexpected'
    })
    assert.equal(executed, false)
    assert.equal(result.kind, 'blocked')
    if (result.kind === 'blocked') {
      assert.deepEqual(result.response.blockers, ['naruto_mission_identity_conflict:mission_prompt'])
    }
  })
})

test('absent explicit mission id is created once and admits one execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-explicit-first-create-'))
  const missionId = 'M-acas-33333333-3333-4333-8333-333333333333-g000004'
  const prompt = 'reserved host task'
  try {
    let executions = 0
    const resolved = await getOrCreateExplicitNarutoMission(root, { requestedId: missionId, prompt })
    assert.equal(resolved.ok, true)
    if (!resolved.ok) return
    const result = await withNarutoMissionRunAdmission({
      missionId: resolved.id,
      missionDir: resolved.dir,
      prompt
    }, async () => {
      executions += 1
      return 'created-once'
    })
    assert.equal(executions, 1)
    assert.equal(result.kind, 'executed')
    const missions = await fs.readdir(path.join(root, '.sneakoscope', 'missions'))
    assert.deepEqual(missions, [missionId])
    const mission = JSON.parse(await fs.readFile(path.join(resolved.dir, 'mission.json'), 'utf8'))
    assert.equal(mission.id, missionId)
    assert.equal(mission.prompt, prompt)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('same explicit id and prompt admit only one concurrent execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-explicit-concurrent-'))
  const missionId = 'M-acas-44444444-4444-4444-8444-444444444444-g000001'
  const prompt = 'same reserved task'
  try {
    let executions = 0
    const results = await Promise.all(Array.from({ length: 2 }, async () => {
      const resolved = await getOrCreateExplicitNarutoMission(root, { requestedId: missionId, prompt })
      assert.equal(resolved.ok, true)
      if (!resolved.ok) return { kind: 'blocked' as const }
      return withNarutoMissionRunAdmission({
        missionId: resolved.id,
        missionDir: resolved.dir,
        prompt,
        staleMs: 1_000
      }, async () => {
        executions += 1
        await delay(80)
        await writeCompletedBundle(resolved.dir, resolved.id, 'run-explicit-single')
        return 'executed'
      })
    }))
    assert.equal(executions, 1)
    assert.equal(results.filter((result) => result.kind === 'executed').length, 1)
    const missions = await fs.readdir(path.join(root, '.sneakoscope', 'missions'))
    assert.deepEqual(missions, [missionId])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('same explicit id with a different prompt fail-closes without an extra execution', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-naruto-explicit-prompt-drift-'))
  const missionId = 'M-acas-55555555-5555-4555-8555-555555555555-g000002'
  try {
    let executions = 0
    const first = await getOrCreateExplicitNarutoMission(root, {
      requestedId: missionId,
      prompt: 'original reserved task'
    })
    assert.equal(first.ok, true)
    if (!first.ok) return
    const admitted = await withNarutoMissionRunAdmission({
      missionId: first.id,
      missionDir: first.dir,
      prompt: 'original reserved task'
    }, async () => {
      executions += 1
      return 'first'
    })
    assert.equal(admitted.kind, 'executed')
    assert.equal(executions, 1)

    const second = await getOrCreateExplicitNarutoMission(root, {
      requestedId: missionId,
      prompt: 'drifted reserved task'
    })
    assert.equal(second.ok, false)
    if (second.ok) return
    assert.deepEqual(second.blockers, ['naruto_mission_identity_conflict:mission_prompt'])
    assert.equal(executions, 1)
    const missions = await fs.readdir(path.join(root, '.sneakoscope', 'missions'))
    assert.deepEqual(missions, [missionId])
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('protected child PID prevents stale recovery after the parent owner dies', async () => {
  await withFixture('protected-child', async ({ dir, missionId }) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    assert.ok(child.pid)
    try {
      await writeOwner(dir, {
        pid: 999_999,
        protectedPids: [child.pid],
        heartbeatAt: '1970-01-01T00:00:00.000Z',
        staleMs: 1
      })
      const live = await withNarutoMissionRunAdmission({ missionId, missionDir: dir, staleMs: 1 }, async () => 'unexpected')
      assert.equal(live.kind, 'running')

      child.kill('SIGKILL')
      await new Promise<void>((resolve) => child.once('close', () => resolve()))
      const recovered = await withNarutoMissionRunAdmission({ missionId, missionDir: dir, staleMs: 1 }, async (lease) => {
        assert.equal(lease.recovered, true)
        return 'recovered-after-child-exit'
      })
      assert.equal(recovered.kind, 'executed')
      if (recovered.kind === 'executed') assert.equal(recovered.value, 'recovered-after-child-exit')
    } finally {
      child.kill('SIGKILL')
      await onceClose(child, 2_000).catch(() => undefined)
    }
  })
})

test('admission lease persists a protected child PID in the existing lock owner record', async () => {
  await withFixture('lease-child', async ({ dir, missionId }) => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    assert.ok(child.pid)
    try {
      let persisted: unknown = null
      const result = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async (lease) => {
        await lease.protectChildPid(child.pid as number)
        persisted = JSON.parse(await fs.readFile(path.join(dir, NARUTO_MISSION_RUN_LOCK, 'owner.json'), 'utf8'))
        return 'protected'
      })
      assert.equal(result.kind, 'executed')
      assert.deepEqual((persisted as { protected_pids?: number[] }).protected_pids, [child.pid])
    } finally {
      child.kill('SIGKILL')
      await onceClose(child, 2_000).catch(() => undefined)
    }
  })
})

test('macOS black-box: an ordinary spawned child survives parent SIGKILL', {
  skip: process.platform !== 'darwin',
  timeout: 5_000
}, async () => {
  // Use writeSync(1) so the pid is not stuck in stdio block-buffering when
  // stdout is a pipe/unix-socket under the test runner. console.log has left
  // admission workers waiting forever on firstPid in full-suite runs.
  const parentCode = [
    'const { spawn } = require("node:child_process")',
    'const fs = require("node:fs")',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", detached: true })',
    'child.unref()',
    'fs.writeSync(1, String(child.pid) + "\\n")',
    'setInterval(() => {}, 1000)'
  ].join(';')
  const parent = spawn(process.execPath, ['-e', parentCode], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childPid = 0
  try {
    childPid = await firstPid(parent, 2_000)
    parent.kill('SIGKILL')
    await onceClose(parent, 2_000)
    await delay(250)
    assert.equal(pidAlive(childPid), true)
  } finally {
    if (parent.exitCode === null && parent.signalCode === null) {
      try { parent.kill('SIGKILL') } catch {}
    }
    if (childPid > 0 && pidAlive(childPid)) {
      try { process.kill(childPid, 'SIGKILL') } catch {}
    }
  }
})

test('crashes before preparation and after plan, parent summary, or gate recover once in the same mission', { timeout: 20_000 }, async () => {
  const moduleUrl = new URL('../../subagents/official-subagent-preparation.js', import.meta.url).href
  const checkpoints = ['before-preparation', 'after-plan', 'after-parent-summary', 'after-gate'] as const

  for (const checkpoint of checkpoints) {
    await withFixture(`crash-${checkpoint}`, async ({ dir, missionId }) => {
      const ready = path.join(dir, `crash-ready-${checkpoint}`)
      const child = spawnCrashCheckpointOwner({ moduleUrl, dir, missionId, ready, checkpoint })
      await waitFor(async () => await exists(ready), 5_000)
      child.kill('SIGKILL')
      await onceClose(child, 2_000)
      await delay(80)

      let recoveries = 0
      const recoveredRunId = `run-recovered-${checkpoint}`
      const recovered = await withNarutoMissionRunAdmission({
        missionId,
        missionDir: dir,
        staleMs: 20
      }, async (lease) => {
        recoveries += 1
        assert.equal(lease.recovered, true)
        await writeCompletedBundle(dir, missionId, recoveredRunId)
        return checkpoint
      })

      assert.equal(recovered.kind, 'executed')
      assert.equal(recoveries, 1)
      const replay = await withNarutoMissionRunAdmission({ missionId, missionDir: dir }, async () => 'unexpected')
      assert.equal(replay.kind, 'reused')
      if (replay.kind === 'reused') {
        assert.equal(replay.response.status, 'completed')
        assert.equal(replay.response.workflow_run_id, recoveredRunId)
      }
    })
  }
})

async function withFixture(
  name: string,
  fn: (fixture: { root: string; dir: string; missionId: string }) => Promise<void>
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `sks-naruto-admission-${name}-`))
  const missionId = `M-${name}`
  const dir = path.join(root, '.sneakoscope', 'missions', missionId)
  await fs.mkdir(dir, { recursive: true })
  await writeJson(path.join(dir, 'mission.json'), { id: missionId, mode: 'naruto', prompt: 'fixture' })
  try {
    await fn({ root, dir, missionId })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}

async function writeCompletedBundle(dir: string, missionId: string, runId: string): Promise<void> {
  await Promise.all([
    writeJson(path.join(dir, 'subagent-plan.json'), {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId, workflow_run_id: runId
    }),
    fs.writeFile(path.join(dir, 'subagent-events.jsonl'), [
      JSON.stringify({ event_name: 'SubagentStart', thread_id: 'thread-a', workflow_run_id: runId }),
      JSON.stringify({ event_name: 'SubagentStop', thread_id: 'thread-a', workflow_run_id: runId })
    ].join('\n') + '\n'),
    writeJson(path.join(dir, 'subagent-parent-summary.json'), {
      schema: 'sks.subagent-parent-summary.v1', status: 'completed', summary: 'fixture completed', run_id: runId,
      thread_outcomes: [{ thread_id: 'thread-a', status: 'completed', summary: 'done' }], changed_files: [], verification: [], blockers: []
    }),
    writeJson(path.join(dir, 'subagent-evidence.json'), {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId, status: 'completed', ok: true,
      parent_summary_trustworthy: true, blockers: []
    }),
    writeJson(path.join(dir, 'naruto-summary.json'), {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId,
      workflow_run_id: runId, status: 'completed', ok: true, completion_evidence: true, blockers: []
    }),
    writeJson(path.join(dir, 'naruto-gate.json'), {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId,
      workflow_run_id: runId, status: 'passed', passed: true, terminal: true, terminal_state: 'completed', blockers: []
    })
  ])
}

async function writeBlockedBundle(dir: string, missionId: string, runId: string): Promise<void> {
  await Promise.all([
    writeJson(path.join(dir, 'subagent-plan.json'), {
      schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId, workflow_run_id: runId
    }),
    fs.writeFile(path.join(dir, 'subagent-events.jsonl'), ''),
    writeJson(path.join(dir, 'subagent-evidence.json'), {
      schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId, status: 'blocked', ok: false, blockers: ['fixture_blocker']
    }),
    writeJson(path.join(dir, 'naruto-summary.json'), {
      schema: 'sks.naruto-subagent-workflow.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId,
      workflow_run_id: runId, status: 'blocked', ok: false, completion_evidence: false, blockers: ['fixture_blocker']
    }),
    writeJson(path.join(dir, 'naruto-gate.json'), {
      schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', route: '$sks-naruto', mission_id: missionId,
      workflow_run_id: runId, status: 'blocked', passed: false, terminal: false, terminal_state: 'blocked', blockers: ['fixture_blocker']
    })
  ])
}

async function writeOwner(dir: string, input: {
  pid: number
  protectedPids?: number[]
  heartbeatAt: string
  staleMs: number
}): Promise<void> {
  const lock = path.join(dir, NARUTO_MISSION_RUN_LOCK)
  await fs.mkdir(lock, { recursive: true })
  await writeJson(path.join(lock, 'owner.json'), {
    schema: 'sks.file-lock-owner.v1',
    owner: 'fixture-owner',
    pid: input.pid,
    hostname: os.hostname(),
    acquired_at: input.heartbeatAt,
    heartbeat_at: input.heartbeatAt,
    stale_ms: input.staleMs,
    ...(input.protectedPids ? { protected_pids: input.protectedPids } : {})
  })
}

async function terminalMetadata(dir: string): Promise<Record<string, { hash: string; mtimeMs: number }>> {
  const entries = await Promise.all(TERMINAL_FILES.map(async (name) => {
    const file = path.join(dir, name)
    const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file)])
    return [name, { hash: crypto.createHash('sha256').update(bytes).digest('hex'), mtimeMs: stat.mtimeMs }] as const
  }))
  return Object.fromEntries(entries)
}

function spawnAdmissionChild(input: {
  moduleUrl: string
  dir: string
  missionId: string
  marker: string
  ready: string
  admit: string
  release: string
}): Promise<Record<string, unknown>> {
  const script = [
    'import fs from "node:fs/promises"',
    'import path from "node:path"',
    `const mod = await import(${JSON.stringify(input.moduleUrl)})`,
    `await fs.mkdir(${JSON.stringify(input.ready)}, { recursive: true })`,
    `await fs.writeFile(path.join(${JSON.stringify(input.ready)}, String(process.pid)), "ready\\n")`,
    `while (true) { try { await fs.access(${JSON.stringify(input.admit)}); break } catch {} await new Promise(resolve => setTimeout(resolve, 20)) }`,
    `const result = await mod.withNarutoMissionRunAdmission({ missionId: ${JSON.stringify(input.missionId)}, missionDir: ${JSON.stringify(input.dir)}, staleMs: 5000 }, async () => {`,
    `  await fs.appendFile(${JSON.stringify(input.marker)}, JSON.stringify({ pid: process.pid }) + "\\n")`,
    `  while (true) { try { await fs.access(${JSON.stringify(input.release)}); break } catch {} await new Promise(resolve => setTimeout(resolve, 20)) }`,
    '  return "owner"',
    '})',
    'console.log(JSON.stringify(result.kind === "running" ? { kind: result.kind, already_running: result.response.already_running } : { kind: result.kind }))'
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`admission child failed (${code}): ${stderr}`))
      try {
        resolve(JSON.parse(stdout.trim()))
      } catch (error) {
        reject(new Error(`admission child returned invalid JSON: ${stdout}\n${stderr}\n${String(error)}`))
      }
    })
  })
}

function spawnCrashCheckpointOwner(input: {
  moduleUrl: string
  dir: string
  missionId: string
  ready: string
  checkpoint: 'before-preparation' | 'after-plan' | 'after-parent-summary' | 'after-gate'
}): ReturnType<typeof spawn> {
  const runId = `run-crashed-${input.checkpoint}`
  const script = [
    'import fs from "node:fs/promises"',
    'import path from "node:path"',
    `const mod = await import(${JSON.stringify(input.moduleUrl)})`,
    `const dir = ${JSON.stringify(input.dir)}`,
    `const missionId = ${JSON.stringify(input.missionId)}`,
    `const checkpoint = ${JSON.stringify(input.checkpoint)}`,
    `const runId = ${JSON.stringify(runId)}`,
    'const writeJson = (name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value) + "\\n")',
    'await mod.withNarutoMissionRunAdmission({ missionId, missionDir: dir, staleMs: 20 }, async () => {',
    "  if (checkpoint !== 'before-preparation') {",
    "    await writeJson('subagent-plan.json', { schema: 'sks.subagent-plan.v1', workflow: 'official_codex_subagent', mission_id: missionId, workflow_run_id: runId })",
    "    await fs.writeFile(path.join(dir, 'subagent-events.jsonl'), '')",
    '  }',
    "  if (checkpoint === 'after-parent-summary' || checkpoint === 'after-gate') {",
    "    await writeJson('subagent-parent-summary.json', { schema: 'sks.subagent-parent-summary.v1', status: 'completed', summary: 'crashed parent summary', run_id: runId, thread_outcomes: [], changed_files: [], verification: [], blockers: [] })",
    "    await writeJson('subagent-evidence.json', { schema: 'sks.subagent-evidence.v1', workflow: 'official_codex_subagent', run_id: runId, status: 'incomplete', ok: false, blockers: ['crash_fixture'] })",
    '  }',
    "  if (checkpoint === 'after-gate') {",
    "    await writeJson('naruto-gate.json', { schema: 'sks.naruto-gate.v1', workflow: 'official_codex_subagent', mission_id: missionId, workflow_run_id: runId, status: 'blocked', passed: false, terminal: false, terminal_state: 'blocked', blockers: ['crash_fixture'] })",
    '  }',
    `  await fs.writeFile(${JSON.stringify(input.ready)}, 'ready\\n')`,
    '  setInterval(() => {}, 1000)',
    '  await new Promise(() => {})',
    '})'
  ].join('\n')
  return spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: 'ignore' })
}

function spawnCliNarutoChild(input: {
  sksBin: string
  cwd: string
  env: NodeJS.ProcessEnv
  missionId: string
  ready: string
  admit: string
  barrierModule: string
  caller: string
}): {
  child: ReturnType<typeof spawn>
  result: Promise<{ code: number | null; json: Record<string, unknown>; stderr: string }>
} {
  const child = spawn(process.execPath, [
    input.sksBin,
    'naruto',
    'run',
    'same mission fixture',
    '--mission',
    input.missionId,
    '--agents',
    '1',
    '--max-threads',
    '4',
    '--readonly',
    '--json'
  ], {
    cwd: input.cwd,
    env: {
      ...input.env,
      NODE_OPTIONS: `--import=${input.barrierModule}`,
      SKS_TEST_ADMISSION_READY: input.ready,
      SKS_TEST_ADMISSION_ADMIT: input.admit,
      SKS_TEST_ADMISSION_CALLER: input.caller
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const result = new Promise<{ code: number | null; json: Record<string, unknown>; stderr: string }>((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', (code) => {
      try {
        resolve({
          code,
          json: JSON.parse(stdout.trim()) as Record<string, unknown>,
          stderr
        })
      } catch (error) {
        reject(new Error('CLI admission child returned invalid JSON: ' + stdout + '\n' + stderr + '\n' + String(error)))
      }
    })
  })
  return { child, result }
}

async function killProtectedAdmissionChildren(dir: string): Promise<void> {
  const owner = await fs.readFile(path.join(dir, NARUTO_MISSION_RUN_LOCK, 'owner.json'), 'utf8')
    .then((text) => JSON.parse(text) as { protected_pids?: unknown[] })
    .catch(() => null)
  for (const value of owner?.protected_pids || []) {
    const pid = Number(value)
    if (!Number.isSafeInteger(pid) || pid <= 0 || !pidAlive(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

async function firstPid(child: ReturnType<typeof spawn>, timeoutMs = 2_000): Promise<number> {
  const stdoutStream = child.stdout
  if (!stdoutStream) {
    throw new Error('parent fixture stdout is not a readable pipe')
  }
  return new Promise((resolve, reject) => {
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`parent fixture pid timeout after ${timeoutMs}ms: ${JSON.stringify(stdout)}`)))
    }, timeoutMs)
    const onData = (chunk: Buffer | string) => {
      stdout += String(chunk)
      const match = stdout.match(/\b(\d+)\b/)
      const pid = match ? Number(match[1]) : NaN
      if (Number.isSafeInteger(pid) && pid > 0) finish(() => resolve(pid))
    }
    const onError = (error: Error) => finish(() => reject(error))
    const onClose = (code: number | null) => {
      finish(() => reject(new Error(`parent fixture closed before child pid (${code}): ${JSON.stringify(stdout)}`)))
    }
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdoutStream.off('data', onData)
      child.off('error', onError)
      child.off('close', onClose)
      fn()
    }
    stdoutStream.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

async function onceClose(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child close timeout after ${timeoutMs}ms`)), timeoutMs)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (!(await predicate())) {
    if (Date.now() - started > timeoutMs) throw new Error('wait_for_timeout')
    await delay(20)
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(() => true, () => false)
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
