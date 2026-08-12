import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createNativeCliWorkerRuntimeRecorder, NATIVE_CLI_WORKER_TIMEOUT_BLOCKER } from '../native-cli-worker-runtime.js'
import { resolveFastModePolicy } from '../fast-mode-policy.js'

/**
 * A worker that has finished its work has to leave, and it has to take the
 * `codex` process it spawned with it.
 *
 * Neither held. The worker was spawned outside the process-group registry that
 * covers every other long-lived child, so nothing swept it when the orchestrator
 * went away; teardown only ever signalled the worker's own pid, so its children
 * outlived it; and nothing at all bounded a worker that stopped making progress
 * — the orchestrator awaited its exit forever while the slot it held could never
 * be handed to the next agent. Each stranded `codex` holds hundreds of megabytes
 * resident until the machine reboots.
 */

const WORKER_RUNTIME_URL = new URL('../native-cli-worker-runtime.js', import.meta.url).href

function fakeAgent(id: string) {
  return { id, session_id: `${id}-session`, slot_id: `${id}-slot`, generation_index: 1, persona_id: id }
}

/**
 * Stands in for `native-cli-worker-entry`: records its own pid, spawns a child
 * that ignores every catchable signal, then blocks forever without ever writing
 * a result. Only a process-group signal can reach that child.
 */
async function writeStubWorker(root: string, workerPidFile: string, descendantPidFile: string): Promise<string> {
  const descendant = "for(const s of ['SIGHUP','SIGINT','SIGTERM'])process.on(s,()=>{});setInterval(()=>{},1000)"
  const source = [
    "const fs=require('node:fs')",
    "const {spawn}=require('node:child_process')",
    `fs.writeFileSync(${JSON.stringify(workerPidFile)},String(process.pid))`,
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
    `fs.writeFileSync(${JSON.stringify(descendantPidFile)},String(child.pid))`,
    'setInterval(()=>{},1000)'
  ].join(';\n')
  const file = path.join(root, 'stub-worker.cjs')
  await fsp.writeFile(file, source)
  return file
}

async function scratch(t: TestContext): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-cli-worker-reap-'))
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))
  return root
}

test('a worker that stops making progress is torn down with its children instead of holding its slot', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await scratch(t)
  const workerPidFile = path.join(root, 'worker.pid')
  const descendantPidFile = path.join(root, 'descendant.pid')
  const stub = await writeStubWorker(root, workerPidFile, descendantPidFile)
  const pids: number[] = []
  t.after(() => { for (const pid of pids) terminateExactProcess(pid) })

  const recorder = createNativeCliWorkerRuntimeRecorder(root, {
    missionId: 'mission-reap', requestedAgents: 1, targetActiveSlots: 1,
    backend: 'native-cli', route: 'test', projectRoot: root,
    fastModePolicy: resolveFastModePolicy({ fastMode: true, serviceTier: 'fast' }),
    workerEntrypointPath: stub
  })
  await recorder.initialize()

  // Before the watchdog existed this await simply never returned.
  const started = Date.now()
  const result = await recorder.launchWorker({
    agent: fakeAgent('slot-001'),
    slice: { id: 'slice-001' },
    opts: { cwd: root, projectRoot: root, workerTimeoutMs: 3_000 }
  })
  const elapsed = Date.now() - started

  assert.ok(elapsed < 60_000, `worker must not outlive its watchdog (took ${elapsed}ms)`)
  assert.ok(elapsed >= 3_000, `the watchdog must not fire before its deadline (took ${elapsed}ms)`)
  // A killed worker produced no result, so the pipeline escalates it past
  // `failed` to `blocked`. What matters is that it can never read as `done`.
  assert.notEqual(result.status, 'done')
  assert.ok(
    result.blockers.includes(NATIVE_CLI_WORKER_TIMEOUT_BLOCKER),
    `a watchdog kill must be reported, got ${JSON.stringify(result.blockers)}`
  )

  const workerPid = await readPid(workerPidFile)
  const descendantPid = await readPid(descendantPidFile)
  pids.push(workerPid, descendantPid)
  assert.ok(workerPid > 0 && descendantPid > 0, 'stub worker never reported its pids')
  assert.equal(await processExits(workerPid, 5_000), true, 'the worker itself must be gone')
  assert.equal(
    await processExits(descendantPid, 5_000), true,
    'the process the worker spawned must not survive the worker'
  )

  const summary = await recorder.finalize()
  assert.equal(summary.active_worker_process_count, 0, 'a torn-down worker must not stay counted as active')
})

test('a worker and its children die with the orchestrator that spawned them', {
  skip: process.platform === 'win32'
}, async (t) => {
  const root = await scratch(t)
  const workerPidFile = path.join(root, 'worker.pid')
  const descendantPidFile = path.join(root, 'descendant.pid')
  const stub = await writeStubWorker(root, workerPidFile, descendantPidFile)
  let orchestrator: ReturnType<typeof spawn> | null = null
  const pids: number[] = []
  t.after(() => {
    for (const pid of pids) terminateExactProcess(pid)
    if (orchestrator?.pid && processIsAlive(orchestrator.pid)) orchestrator.kill('SIGKILL')
  })

  const recorderInput = {
    missionId: 'mission-orphan', requestedAgents: 1, targetActiveSlots: 1,
    backend: 'native-cli', route: 'test', projectRoot: root,
    fastModePolicy: resolveFastModePolicy({ fastMode: true, serviceTier: 'fast' }),
    workerEntrypointPath: stub
  }
  const orchestratorSource = [
    `import {createNativeCliWorkerRuntimeRecorder} from ${JSON.stringify(WORKER_RUNTIME_URL)}`,
    `const recorder=createNativeCliWorkerRuntimeRecorder(${JSON.stringify(root)},${JSON.stringify(recorderInput)})`,
    'await recorder.initialize()',
    'setInterval(()=>{},1000)',
    `void recorder.launchWorker({agent:${JSON.stringify(fakeAgent('slot-orphan'))},slice:{id:'slice-orphan'},opts:{cwd:${JSON.stringify(root)},projectRoot:${JSON.stringify(root)}}})`
  ].join(';\n')
  orchestrator = spawn(process.execPath, ['--input-type=module', '-e', orchestratorSource], { stdio: 'ignore' })

  const workerPid = await waitForPid(workerPidFile, 30_000)
  const descendantPid = await waitForPid(descendantPidFile, 30_000)
  pids.push(workerPid, descendantPid)
  assert.notEqual(workerPid, descendantPid)
  assert.equal(processIsAlive(workerPid), true)
  assert.equal(processIsAlive(descendantPid), true)

  orchestrator.kill('SIGTERM')

  assert.equal(await processExits(workerPid, 15_000), true, 'the worker must not outlive its orchestrator')
  assert.equal(
    await processExits(descendantPid, 15_000), true,
    'the process the worker spawned must not outlive its orchestrator either'
  )
})

async function readPid(file: string): Promise<number> {
  const raw = await fsp.readFile(file, 'utf8').catch(() => '')
  const pid = Number(raw.trim())
  return Number.isFinite(pid) && pid > 0 ? pid : 0
}

async function waitForPid(file: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const pid = await readPid(file)
    if (pid) return pid
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`pid file never appeared: ${file}`)
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

function terminateExactProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}
