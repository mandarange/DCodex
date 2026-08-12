import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, nowIso, registerDetachedProcessGroup, writeTextAtomic } from '../fsx.js'
import { readyVerificationTasks, validateVerificationDag, type VerificationDag } from './verification-dag.js'
import { VerificationArtifactLock } from './verification-artifact-lock.js'
import { emptyParallelVerificationResult, type ParallelVerificationResult, type VerificationTask, type VerificationTaskResult } from './verification-result.js'

export async function runVerificationDag(
  dag: VerificationDag,
  opts: { cwd?: string; concurrency?: number; logDir?: string; failFast?: boolean } = {}
): Promise<ParallelVerificationResult> {
  validateVerificationDag(dag)
  const concurrency = Math.max(1, opts.concurrency || Number(process.env.SKS_VERIFY_CONCURRENCY) || os.cpus().length || 2)
  const succeeded = new Set<string>()
  const failed = new Set<string>()
  const skipped = new Set<string>()
  const running = new Set<string>()
  const results: VerificationTaskResult[] = []
  const lock = new VerificationArtifactLock(opts.cwd || process.cwd())
  let blocked = false
  while (results.length + running.size < dag.tasks.length || running.size > 0) {
    for (const task of dag.tasks) {
      if (succeeded.has(task.id) || failed.has(task.id) || skipped.has(task.id) || running.has(task.id)) continue
      const failedDeps = (task.dependencies || []).filter((dep) => failed.has(dep) || skipped.has(dep))
      if (blocked || failedDeps.length) {
        skipped.add(task.id)
        results.push(skippedVerificationTaskResult(task, blocked ? 'fail_fast' : `dependency_failed:${failedDeps.join(',')}`))
      }
    }
    const ready = blocked ? [] : readyVerificationTasks(dag.tasks, succeeded, running)
      .filter((task) => !failed.has(task.id) && !skipped.has(task.id))
      .filter((task) => lock.canAcquire(task.outputs || []))
      .slice(0, Math.max(0, concurrency - running.size))
    if (!ready.length && running.size === 0) {
      for (const task of dag.tasks) {
        if (succeeded.has(task.id) || failed.has(task.id) || skipped.has(task.id)) continue
        skipped.add(task.id)
        results.push(skippedVerificationTaskResult(task, 'no_ready_tasks'))
      }
      break
    }
    const launched = ready.map(async (task) => {
      running.add(task.id)
      lock.acquire(task.outputs || [])
      try {
        const taskOpts: { cwd?: string; logDir?: string } = {}
        if (opts.cwd) taskOpts.cwd = opts.cwd
        if (opts.logDir) taskOpts.logDir = opts.logDir
        const result = await runVerificationTask(task, taskOpts)
        results.push(result)
        if (result.ok) succeeded.add(task.id)
        else {
          failed.add(task.id)
          if (opts.failFast) blocked = true
        }
      } finally {
        running.delete(task.id)
        lock.release(task.outputs || [])
      }
    })
    if (launched.length) {
      await Promise.race(launched)
    } else {
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  return emptyParallelVerificationResult(results.sort((a, b) => a.id.localeCompare(b.id)), dag.tasks.length)
}

export async function runVerificationTask(
  task: VerificationTask,
  opts: { cwd?: string; logDir?: string } = {}
): Promise<VerificationTaskResult> {
  const started = Date.now()
  const startedAt = nowIso()
  const cwd = task.cwd || opts.cwd || process.cwd()
  const logDir = opts.logDir || path.join(cwd, '.sneakoscope', 'reports', 'verification-logs')
  await ensureDir(logDir)
  const stdoutLog = path.join(logDir, `${task.id}.stdout.log`)
  const stderrLog = path.join(logDir, `${task.id}.stderr.log`)
  const chunks: string[] = []
  const errChunks: string[] = []
  const result = await new Promise<{ code: number | null; error?: string }>((resolve) => {
    const child = spawn(task.command, { cwd, env: { ...process.env, ...(task.env || {}) }, shell: true, detached: true })
    // Detached means the group survives the parent unless someone sweeps it.
    // Registering it makes the pool's tasks die with the run that started them.
    const unregisterProcessGroup = registerDetachedProcessGroup(child)
    let settled = false
    let timedOut = false
    const timeoutMs = task.timeout_ms || 10 * 60 * 1000
    let killTimeout: NodeJS.Timeout | null = null
    let exitFallback: NodeJS.Timeout | null = null
    const finish = (payload: { code: number | null; error?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (killTimeout) clearTimeout(killTimeout)
      if (exitFallback) clearTimeout(exitFallback)
      unregisterProcessGroup()
      resolve(payload)
    }
    const timeout = setTimeout(() => {
      timedOut = true
      terminateProcessTree(child.pid, 'SIGTERM')
      killTimeout = setTimeout(async () => {
        if (!timedOut) return
        terminateProcessTree(child.pid, 'SIGKILL')
        await waitForProcessTreeExit(child.pid, 2_000)
        finish({ code: null, error: `timeout:${timeoutMs}` })
      }, 2_000)
      killTimeout.unref()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => chunks.push(String(chunk)))
    child.stderr.on('data', (chunk) => errChunks.push(String(chunk)))
    child.on('error', (err) => {
      finish({ code: null, error: err.message })
    })
    child.on('exit', (code) => {
      if (settled) return
      exitFallback = setTimeout(async () => {
        if (timedOut) await waitForProcessTreeExit(child.pid, 2_000)
        finish({ code, ...(timedOut ? { error: `timeout:${timeoutMs}` } : {}) })
      }, 1_000)
    })
    child.on('close', async (code) => {
      if (timedOut) await waitForProcessTreeExit(child.pid, 2_000)
      finish({ code, ...(timedOut ? { error: `timeout:${timeoutMs}` } : {}) })
    })
  })
  await writeTextAtomic(stdoutLog, chunks.join(''))
  await writeTextAtomic(stderrLog, errChunks.join(''))
  const finishedAt = nowIso()
  return {
    schema: 'sks.parallel-verification-task-result.v1',
    id: task.id,
    ok: result.code === 0,
    command: task.command,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Date.now() - started,
    exit_code: result.code,
    stdout_log: stdoutLog,
    stderr_log: stderrLog,
    ...(result.error ? { error: result.error } : {}),
  }
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
    return
  } catch {}
  try {
    process.kill(pid, signal)
  } catch {}
}

async function waitForProcessTreeExit(pid: number | undefined, timeoutMs: number): Promise<void> {
  if (!pid) return
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processTreeIsAlive(pid)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

function processTreeIsAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch {}
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function skippedVerificationTaskResult(task: VerificationTask, reason: string): VerificationTaskResult {
  const ts = nowIso()
  return {
    schema: 'sks.parallel-verification-task-result.v1',
    id: task.id,
    ok: false,
    skipped: true,
    command: task.command,
    started_at: ts,
    finished_at: ts,
    duration_ms: 0,
    exit_code: null,
    error: reason,
  }
}
