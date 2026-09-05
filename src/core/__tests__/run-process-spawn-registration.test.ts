import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { runProcess } from '../fsx.js'

test('runProcess never spawns after cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await runProcess(process.execPath, ['-e', 'process.exit(0)'], {
    signal: controller.signal,
    onSpawn: () => assert.fail('cancelled work must not spawn')
  })
  assert.equal(result.aborted, true)
  assert.equal(result.pid, undefined)
  assert.equal(result.code, 130)
})

test('runProcess cancellation reaps the running process tree before returning', { skip: process.platform === 'win32' }, async () => {
  const controller = new AbortController()
  let descendant = 0
  const result = await runProcess(process.execPath, ['-e', [
    "const {spawn}=require('node:child_process')",
    "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'})",
    "console.log(child.pid)",
    "setInterval(()=>{},1000)"
  ].join(';')], {
    signal: controller.signal,
    timeoutMs: 5_000,
    onStdout: chunk => {
      descendant = Number(chunk.trim())
      controller.abort()
    }
  })
  assert.equal(result.aborted, true)
  assert.equal(result.code, 130)
  assert.equal(result.timedOut, false)
  assert.ok(descendant > 0)
  assert.equal(processIsAlive(result.pid!), false)
  assert.equal(processIsAlive(descendant), false)
})

test('runProcess completes spawn registration before a POSIX child continues', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-run-process-spawn-'))
  const registration = path.join(root, 'registered')
  const beforeSighupListeners = process.listenerCount('SIGHUP')
  const beforeSigintListeners = process.listenerCount('SIGINT')
  const beforeSigtermListeners = process.listenerCount('SIGTERM')
  t.after(async () => fsp.rm(root, { recursive: true, force: true }))

  const result = await runProcess(process.execPath, [
    '-e',
    "const fs=require('node:fs'); process.exit(fs.existsSync(process.argv[1]) ? 0 : 7)",
    registration
  ], {
    timeoutMs: 5_000,
    onSpawn: async (pid) => {
      assert.ok(pid > 0)
      await new Promise((resolve) => setTimeout(resolve, 50))
      await fsp.writeFile(registration, 'ready\n')
    }
  })

  assert.equal(result.code, 0)
  assert.equal(result.spawnRegistrationFailed, undefined)
  assert.equal(process.listenerCount('SIGHUP'), beforeSighupListeners)
  assert.equal(process.listenerCount('SIGINT'), beforeSigintListeners)
  assert.equal(process.listenerCount('SIGTERM'), beforeSigtermListeners)
})

test('runProcess kills the child and fails closed when spawn registration fails', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    timeoutMs: 5_000,
    onSpawn: async () => {
      throw new Error('fixture registration failure')
    }
  })

  assert.notEqual(result.code, 0)
  assert.equal(result.spawnRegistrationFailed, true)
})

for (const parentSignal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const) test(`runProcess terminates concurrent detached POSIX process groups when the wrapper receives ${parentSignal}`, { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createSignalFixture(t, 2)
  const closed = waitForClose(fixture.wrapper, `wrapper did not terminate after ${parentSignal}`)
  fixture.wrapper.kill(parentSignal)
  assert.deepEqual(await closed, { code: null, signal: parentSignal })
  await assertProcessesExit([...fixture.groupLeaderPids, ...fixture.descendantPids])
})

test('runProcess preserves a pre-existing once SIGTERM handler without re-signaling the wrapper', { skip: process.platform === 'win32' }, async (t) => {
  const fixture = await createSignalFixture(t, 1, 'SIGTERM')
  const closed = waitForClose(fixture.wrapper, 'wrapper did not terminate during deliberate cleanup')
  fixture.wrapper.kill('SIGTERM')
  await waitForFile(fixture.userOnceMarker, 5_000)
  assert.equal(await fsp.readFile(fixture.userOnceMarker, 'utf8'), 'USER_ONCE_HANDLED')
  await assertProcessesExit([...fixture.groupLeaderPids, ...fixture.descendantPids])
  assert.equal(processIsAlive(fixture.wrapper.pid ?? 0), true)
  fixture.wrapper.kill('SIGKILL')
  assert.deepEqual(await closed, { code: null, signal: 'SIGKILL' })
})

interface SignalFixture {
  wrapper: ReturnType<typeof spawn>
  groupLeaderPids: number[]
  descendantPids: number[]
  userOnceMarker: string
}

async function createSignalFixture(t: TestContext, groupCount: number, userOnceSignal?: 'SIGTERM'): Promise<SignalFixture> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-run-process-wrapper-signal-'))
  const groupLeaderPidFile = path.join(root, 'group-leaders.pid')
  const descendantPidFiles = Array.from({ length: groupCount }, (_, index) => path.join(root, `descendant-${index}.pid`))
  const userOnceMarker = path.join(root, 'user-once-handled')
  let wrapper: ReturnType<typeof spawn> | null = null
  let groupLeaderPids: number[] = []
  let descendantPids: number[] = []
  t.after(async () => {
    const recordedLeaders = uniquePids([...groupLeaderPids, ...await readPidLines(groupLeaderPidFile)])
    const recordedDescendants = uniquePids([...descendantPids, ...await readPidFiles(descendantPidFiles)])
    for (const pid of recordedLeaders) terminateExactProcessGroup(pid)
    for (const pid of recordedDescendants) terminateExactProcess(pid)
    if (wrapper?.pid && processIsAlive(wrapper.pid)) wrapper.kill('SIGKILL')
    await fsp.rm(root, { recursive: true, force: true })
  })

  const descendantSource = "for(const signal of ['SIGHUP','SIGINT','SIGTERM'])process.on(signal,()=>{});setInterval(()=>{},1000)"
  const childSource = [
    "const fs=require('node:fs')",
    "const {spawn}=require('node:child_process')",
    `const child=spawn(process.execPath,['-e',${JSON.stringify(descendantSource)}],{stdio:'ignore'})`,
    "fs.writeFileSync(process.argv[1],String(child.pid))",
    "setInterval(()=>{},1000)"
  ].join(';')
  const fsxUrl = new URL('../fsx.js', import.meta.url).href
  const wrapperSource = [
    "import fs from 'node:fs'",
    `import {runProcess} from ${JSON.stringify(fsxUrl)}`,
    ...(userOnceSignal ? [`process.once(${JSON.stringify(userOnceSignal)},()=>fs.writeFileSync(${JSON.stringify(userOnceMarker)},'USER_ONCE_HANDLED'))`] : []),
    "setInterval(()=>{},1000)",
    ...descendantPidFiles.map((file) => `void runProcess(process.execPath,['-e',${JSON.stringify(childSource)},${JSON.stringify(file)}],{timeoutMs:60_000,onSpawn:(pid)=>fs.appendFileSync(${JSON.stringify(groupLeaderPidFile)},String(pid)+'\\n')})`)
  ].join(';')
  wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], { stdio: 'ignore' })

  await waitForPidCount(groupLeaderPidFile, groupCount, 5_000)
  await Promise.all(descendantPidFiles.map((file) => waitForFile(file, 5_000)))
  groupLeaderPids = await readPidLines(groupLeaderPidFile)
  descendantPids = await readPidFiles(descendantPidFiles)
  assert.equal(groupLeaderPids.length, groupCount)
  assert.equal(descendantPids.length, groupCount)
  assert.equal(new Set([...groupLeaderPids, ...descendantPids]).size, groupCount * 2)
  for (const pid of [...groupLeaderPids, ...descendantPids]) {
    assert.ok(pid > 0)
    assert.equal(processIsAlive(pid), true)
  }
  return { wrapper, groupLeaderPids, descendantPids, userOnceMarker }
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await fsp.access(file)
      return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${file}`)
}

async function waitForPidCount(file: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await readPidLines(file)).length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${count} PIDs in ${file}`)
}

function waitForClose(child: ReturnType<typeof spawn>, timeoutMessage: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(timeoutMessage)), 5_000)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

async function readPidLines(file: string): Promise<number[]> {
  const text = await fsp.readFile(file, 'utf8').catch(() => '')
  return uniquePids(text.split(/\s+/).map(Number))
}

async function readPidFiles(files: string[]): Promise<number[]> {
  return uniquePids(await Promise.all(files.map(async (file) => Number(await fsp.readFile(file, 'utf8').catch(() => '0')))))
}

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))]
}

async function assertProcessesExit(pids: number[]): Promise<void> {
  await Promise.all(pids.map((pid) => waitForProcessExit(pid, 5_000)))
  for (const pid of pids) assert.equal(processIsAlive(pid), false, `process ${pid} survived`)
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function terminateExactProcessGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    terminateExactProcess(pid)
  }
}

function terminateExactProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL')
  } catch {}
}
