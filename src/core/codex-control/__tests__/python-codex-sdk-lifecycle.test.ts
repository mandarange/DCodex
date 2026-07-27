import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runPythonRunner } from '../python-codex-sdk-adapter.js'

test('Python SDK runner exits with its parent on SIGTERM', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-python-sdk-parent-exit-'))
  const runnerPidFile = path.join(root, 'runner.pid')
  const runner = await writeExecutable(root, 'blocking-runner.sh', [
    '#!/bin/sh',
    'printf \'%s\' "$$" > "$SKS_PYTHON_RUNNER_PID_FILE"',
    'trap \'\' HUP INT TERM',
    'while :; do /bin/sleep 1; done'
  ].join('\n'))
  let wrapper: ReturnType<typeof spawn> | null = null
  let runnerPid = 0
  t.after(async () => {
    if (runnerPid > 0) terminateExactProcessGroup(runnerPid)
    if (wrapper?.pid && processIsAlive(wrapper.pid)) wrapper.kill('SIGKILL')
    await fsp.rm(root, { recursive: true, force: true })
  })

  const adapterUrl = new URL('../python-codex-sdk-adapter.js', import.meta.url).href
  const wrapperSource = [
    `import {runPythonRunner} from ${JSON.stringify(adapterUrl)}`,
    `void runPythonRunner(${JSON.stringify(runner)}, {}, {SKS_PYTHON_RUNNER_PID_FILE:${JSON.stringify(runnerPidFile)}}, 60000)`
  ].join(';')
  wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperSource], { stdio: 'ignore' })

  await waitForFile(runnerPidFile, 5_000)
  runnerPid = Number(await fsp.readFile(runnerPidFile, 'utf8'))
  assert.ok(runnerPid > 0)
  assert.equal(processIsAlive(runnerPid), true)

  const closed = waitForClose(wrapper, 'Python SDK wrapper did not terminate after SIGTERM')
  wrapper.kill('SIGTERM')
  assert.deepEqual(await closed, { code: null, signal: 'SIGTERM' })
  await waitForProcessExit(runnerPid, 5_000)
  assert.equal(processIsAlive(runnerPid), false)
})

test('Python SDK runner cancels delayed SIGKILL after the child closes', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-python-sdk-timeout-close-'))
  const groupPidFile = path.join(root, 'group.pid')
  const sentinelPidFile = path.join(root, 'sentinel.pid')
  // Publish readiness before the long-lived wait so concurrent release-gate
  // load cannot race the adapter timeout against pid-file creation. Use the
  // shell builtin wait so TERM interrupts promptly instead of waiting for an
  // external sleep process to finish before the trap can run.
  const runner = await writeExecutable(root, 'timeout-runner.sh', [
    '#!/bin/sh',
    'printf \'%s\' "$$" > "$SKS_PYTHON_GROUP_PID_FILE"',
    '/bin/sh -c \'trap "" HUP INT TERM; while :; do /bin/sleep 1; done\' </dev/null >/dev/null 2>&1 &',
    'sentinel_pid=$!',
    'printf \'%s\' "$sentinel_pid" > "$SKS_PYTHON_SENTINEL_PID_FILE"',
    'trap \'exit 0\' HUP INT TERM',
    'wait "$sentinel_pid"'
  ].join('\n'))
  let groupPid = 0
  let sentinelPid = 0
  t.after(async () => {
    if (groupPid > 0) terminateExactProcessGroup(groupPid)
    if (sentinelPid > 0) terminateExactProcess(sentinelPid)
    await fsp.rm(root, { recursive: true, force: true })
  })

  const timeoutMs = 5_000
  const forceKillDelayMs = 1_000
  const run = runPythonRunner(runner, {}, {
    SKS_PYTHON_GROUP_PID_FILE: groupPidFile,
    SKS_PYTHON_SENTINEL_PID_FILE: sentinelPidFile
  }, timeoutMs, forceKillDelayMs)
  await Promise.all([waitForFile(groupPidFile, 10_000), waitForFile(sentinelPidFile, 10_000)])
  groupPid = Number(await fsp.readFile(groupPidFile, 'utf8'))
  sentinelPid = Number(await fsp.readFile(sentinelPidFile, 'utf8'))

  const events = await run
  assert.ok(events.some((event) => event?.message === `python_codex_sdk_timeout:${timeoutMs}`))
  await new Promise((resolve) => setTimeout(resolve, forceKillDelayMs + 100))
  assert.equal(processIsAlive(sentinelPid), true, 'stale SIGKILL fallback killed the surviving process group')
})

async function writeExecutable(root: string, name: string, source: string): Promise<string> {
  const file = path.join(root, name)
  await fsp.writeFile(file, `${source}\n`, 'utf8')
  await fsp.chmod(file, 0o755)
  return file
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

function waitForClose(child: ReturnType<typeof spawn>, message: string): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 5_000)
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
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
