import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { ReleaseGateNode } from './release-gate-node.js'
import { cleanupReleaseGateHermeticEnv, createReleaseGateHermeticEnv } from './release-gate-hermetic-env.js'
import { writeReleaseGateJson } from './release-gate-report.js'
import { guardedProcessKill, guardContextForRoute } from '../safety/mutation-guard.js'
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js'
import { normalizeReleaseGateOutput } from './release-gate-output-contract.js'

export interface ReleaseGateBatchResult {
  schema: 'sks.release-gate-batch-result.v2'
  ok: boolean
  batch_size: number
  completed: number
  failed: number
  results: Array<{ id: string; ok: boolean; exit_code: number | null; signal: NodeJS.Signals | null; timed_out: boolean; duration_ms: number; report_dir?: string; output_contract?: string; gate_result?: unknown }>
}

const DISALLOWED_BATCH_RESOURCES = new Set(['git-worktree', 'local-llm-real', 'remote-model-real', 'publish', 'global-config', 'timing-sensitive'])

export function isReleaseGateBatchable(gate: ReleaseGateNode): boolean {
  if (gate.side_effect !== 'hermetic') return false
  if (!gate.resource.includes('cpu-light') || !gate.resource.includes('fs-read')) return false
  return gate.resource.every((resource) => resource === 'cpu-light' || resource === 'fs-read') && !gate.resource.some((resource) => DISALLOWED_BATCH_RESOURCES.has(resource))
}

export async function runReleaseGateBatch(root: string, gates: ReleaseGateNode[], input: { concurrency?: number; reportRoot?: string } = {}): Promise<ReleaseGateBatchResult> {
  const requestedConcurrency = Math.max(1, Math.floor(Number(input.concurrency || process.env.SKS_RELEASE_BATCH_CONCURRENCY || 2)))
  const concurrency = Math.min(requestedConcurrency, 4)
  const runId = `rgb-${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
  const reportRoot = input.reportRoot || path.join(root, '.sneakoscope', 'reports', 'release-gate-batches', runId)
  const nonBatchable = gates.filter((gate) => !isReleaseGateBatchable(gate))
  if (nonBatchable.length) {
    return {
      schema: 'sks.release-gate-batch-result.v2',
      ok: false,
      batch_size: gates.length,
      completed: 0,
      failed: nonBatchable.length,
      results: nonBatchable.map((gate) => ({ id: gate.id, ok: false, exit_code: null, signal: null, timed_out: false, duration_ms: 0 }))
    }
  }
  const queue = [...gates]
  const results: ReleaseGateBatchResult['results'] = []
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const gate = queue.shift()
      if (!gate) continue
      const result = await runOne(root, runId, reportRoot, gate)
      results.push(result)
      if (input.reportRoot) writeChildResult(input.reportRoot, result)
    }
  })
  await Promise.all(workers)
  const failed = results.filter((row) => !row.ok).length
  return {
    schema: 'sks.release-gate-batch-result.v2',
    ok: failed === 0,
    batch_size: gates.length,
    completed: results.length - failed,
    failed,
    results
  }
}

function runOne(root: string, runId: string, reportRoot: string, gate: ReleaseGateNode): Promise<ReleaseGateBatchResult['results'][number]> {
  const started = performance.now()
  const hermetic = createReleaseGateHermeticEnv({ root, runId, gate, reportRoot })
  return new Promise((resolve) => {
    const child = spawn(gate.command, { cwd: root, shell: true, env: hermetic.env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let stdoutTail = ''
    let timedOut = false
    let timeoutCleanup: Promise<void> | null = null
    const timer = setTimeout(() => {
      timedOut = true
      timeoutCleanup = cleanupTimedOutGateProcessTree(root, child)
    }, gate.timeout_ms)
    timer.unref?.()
    child.stdout.on('data', (chunk) => {
      stdoutTail = appendTail(stdoutTail, String(chunk))
    })
    child.stderr.resume()
    child.on('close', (code, signal) => {
      void (async () => {
        clearTimeout(timer)
        if (timeoutCleanup) await timeoutCleanup
        const exitCode = timedOut ? 124 : code
        const normalized = normalizeReleaseGateOutput({ gateId: gate.id, status: exitCode, signal, timedOut, stdout: stdoutTail })
        const result = {
          id: gate.id,
          ok: normalized.evaluation.ok,
          exit_code: exitCode,
          signal,
          timed_out: timedOut,
          duration_ms: Math.max(1, Math.round(performance.now() - started)),
          report_dir: hermetic.report_dir,
          output_contract: gate.output_contract,
          gate_result: normalized.gate_result
        }
        cleanupReleaseGateHermeticEnv(hermetic)
        resolve(result)
      })()
    })
  })
}

function appendTail(previous: string, next: string, limit = 64 * 1024): string {
  const combined = `${previous}${next}`
  return combined.length > limit ? combined.slice(-limit) : combined
}

async function cleanupTimedOutGateProcessTree(root: string, child: ChildProcess): Promise<void> {
  await killGateProcessTree(root, child, 'SIGTERM')
  await sleep(1500)
  await killGateProcessTree(root, child, 'SIGKILL')
  await sleep(100)
}

async function killGateProcessTree(root: string, child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (!child.pid) return
  const pid = process.platform !== 'win32' ? -child.pid : child.pid
  const contract = createRequestedScopeContract({
    route: 'release:gate-batch-runner',
    userRequest: 'Terminate only the batched release gate child process tree after its configured timeout.',
    projectRoot: root,
    overrides: { codex_app_process: true }
  })
  try {
    await guardedProcessKill(guardContextForRoute(root, contract, 'release gate batch timeout cleanup'), pid, { signal, confirmed: true })
  } catch {
    try {
      child.kill(signal)
    } catch {}
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeChildResult(reportRoot: string, result: ReleaseGateBatchResult['results'][number]) {
  const dir = result.report_dir || path.join(reportRoot, result.id.replace(/[^A-Za-z0-9_.:-]/g, '_'))
  writeReleaseGateJson(path.join(dir, 'result.json'), {
    schema: 'sks.release-gate-batch-child-result.v2',
    ...result
  })
}
