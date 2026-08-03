import fs from 'node:fs'
import path from 'node:path'
import { createNarutoGeneration, completeNarutoGeneration, type NarutoGeneration } from './naruto-generation-scheduler.js'
import type { NarutoConcurrencyGovernorDecision } from './naruto-concurrency-governor.js'
import type { NarutoWorkGraph, NarutoWorkItem } from './naruto-work-item.js'

export interface NarutoActivePoolReport {
  schema: 'sks.naruto-active-pool.v1'
  ok: boolean
  safe_active_workers: number
  total_work_items: number
  completed_count: number
  failed_count: number
  refill_events: number
  max_observed_active_workers: number
  duplicate_execution_count: number
  conflict_items_enqueued: number
  max_observed_write_lease_conflicts: number
  repair_waves?: Array<{ failed_work_item_id: string; followup_work_item_id: string; attempt: number; requires_hypothesis: boolean; tournament_forced: boolean }>
  timeline: Array<{ tick: number; active: number; pending: number; completed: number; event: string }>
  blockers: string[]
}

export interface NarutoWorktreeActivePoolReport extends NarutoActivePoolReport {
  worktree_mode: 'git-worktree' | 'patch-envelope-only'
  worktree_allocation_required_count: number
  worktree_allocations: Array<{
    work_item_id: string
    mode: 'git-worktree' | 'patch-envelope-only'
    allocation_status: 'planned' | 'allocated' | 'skipped'
    worktree_path?: string
    branch?: string
    blockers: string[]
  }>
}

export interface NarutoWorkerPlacementDecision {
  placement: 'headless'
  reason: string
}

export interface NarutoWorkerHandle {
  id: string
  item: NarutoWorkItem
  placement: NarutoWorkerPlacementDecision
  started_at: number
  pid?: number | null
  worker_artifact_dir?: string | null
  heartbeat_path?: string | null
  exit?: Promise<unknown>
  force_timed_out?: boolean
}

export interface NarutoWorkerResult {
  id: string
  ok: boolean
  item: NarutoWorkItem
  placement: NarutoWorkerPlacementDecision
  completed_at: number
  pid?: number | null
  worker_artifact_dir?: string | null
  blockers?: string[]
  status?: 'completed' | 'failed' | 'timed_out'
  heartbeat_artifact_present_after_timeout?: boolean
}

export interface NarutoRuntimeEvent {
  event_type: 'worker_spawned' | 'worker_completed' | 'refill' | 'verification_enqueued' | 'pool_drained'
  work_item_id?: string
  active_workers: number
  pending_workers: number
  completed_workers: number
  placement?: NarutoWorkerPlacementDecision
}

export interface NarutoRealActivePoolReport extends NarutoActivePoolReport {
  runtime_mode: 'real-worker-lifecycle'
  active_cap: number
  average_active_workers: number
  active_pool_utilization: number
  headless_workers: number
  refill_latency_ms_p95: number
  worker_lifecycle: Array<{
    work_item_id: string
    placement: 'headless'
    pid?: number | null
    worker_artifact_dir?: string | null
    started_at: number
    completed_at: number | null
    ok: boolean | null
  }>
}

export async function runNarutoRealActivePool(input: {
  graph: NarutoWorkGraph
  governor: NarutoConcurrencyGovernorDecision
  spawnWorker: (item: NarutoWorkItem, placement: NarutoWorkerPlacementDecision) => Promise<NarutoWorkerHandle>
  collectWorker: (handle: NarutoWorkerHandle) => Promise<NarutoWorkerResult>
  enqueueVerification: (result: NarutoWorkerResult) => Promise<void>
  updateDashboard: (event: NarutoRuntimeEvent) => Promise<void>
  hardTimeoutMs?: number
}): Promise<NarutoRealActivePoolReport> {
  const safeActiveWorkers = Math.max(1, input.governor.safe_active_workers)
  const pending = [...input.graph.work_items]
  const active = new Map<string, NarutoWorkerHandle>()
  const completed = new Map<string, NarutoWorkerResult>()
  const byId = new Map(input.graph.work_items.map((item) => [item.id, item]))
  const timeline: NarutoActivePoolReport['timeline'] = []
  const lifecycle: NarutoRealActivePoolReport['worker_lifecycle'] = []
  const refillLatencies: number[] = []
  let tick = 0
  let refillEvents = 0
  let maxObserved = 0

  while (pending.length || active.size) {
    const beforeLaunch = Date.now()
    const completedIds = new Set(completed.keys())
    const launchActiveMap = activeToGenerationMap(active)
    const batch: Array<{ item: NarutoWorkItem; placement: NarutoWorkerPlacementDecision }> = []
    while (active.size + batch.length < safeActiveWorkers) {
      const item = popRunnable(pending, completedIds, launchActiveMap, byId)
      if (!item) break
      const placement: NarutoWorkerPlacementDecision = { placement: 'headless', reason: 'headless_process' }
      batch.push({ item, placement })
      launchActiveMap.set(`batch:${item.id}`, createNarutoGeneration(item, launchActiveMap.size + 1, tick))
    }
    const launched = batch.length > 0
    if (launched) {
      const handles = await Promise.all(batch.map((entry) => input.spawnWorker(entry.item, entry.placement)))
      for (const handle of handles) {
        const item = handle.item
        const placement = handle.placement
        active.set(handle.id, handle)
        lifecycle.push({ work_item_id: item.id, placement: placement.placement, pid: handle.pid || null, worker_artifact_dir: handle.worker_artifact_dir || null, started_at: handle.started_at, completed_at: null, ok: null })
      }
      refillEvents += handles.length
      refillLatencies.push(Date.now() - beforeLaunch)
      await input.updateDashboard({ event_type: 'refill', active_workers: active.size, pending_workers: pending.length, completed_workers: completed.size })
    }
    maxObserved = Math.max(maxObserved, active.size)
    timeline.push({ tick, active: active.size, pending: pending.length, completed: completed.size, event: launched ? 'refill' : 'wait' })
    const done = await nextCollectableWorkers(active, input.hardTimeoutMs)
    if (!done.length) {
      tick += 1
      if (tick > input.graph.work_items.length * 4 + 20) break
      continue
    }
    for (const handle of done) {
      active.delete(handle.id)
      const result = handle.force_timed_out ? await forceCollectTimedOutWorker(handle) : await input.collectWorker(handle)
      completed.set(result.item.id, result)
      const row = lifecycle.find((entry) => entry.work_item_id === result.item.id && entry.completed_at == null)
      if (row) {
        row.completed_at = result.completed_at
        row.ok = result.ok
        row.pid = result.pid || row.pid || null
        row.worker_artifact_dir = result.worker_artifact_dir || row.worker_artifact_dir || null
      }
      await input.updateDashboard({ event_type: 'worker_completed', work_item_id: result.item.id, active_workers: active.size, pending_workers: pending.length, completed_workers: completed.size, placement: result.placement })
      if (result.item.verification_required) {
        await input.enqueueVerification(result)
        await input.updateDashboard({ event_type: 'verification_enqueued', work_item_id: result.item.id, active_workers: active.size, pending_workers: pending.length, completed_workers: completed.size, placement: result.placement })
      }
    }
    tick += 1
    if (tick > input.graph.work_items.length * 4 + 20) break
  }

  await input.updateDashboard({ event_type: 'pool_drained', active_workers: active.size, pending_workers: pending.length, completed_workers: completed.size })
  const failedCount = [...completed.values()].filter((result) => !result.ok).length
  const activeSamples = timeline.map((row) => row.active)
  const averageActiveWorkers = activeSamples.length
    ? activeSamples.reduce((sum, value) => sum + value, 0) / activeSamples.length
    : 0
  const saturatedSamples = timeline
    .filter((row) => row.pending + row.active >= safeActiveWorkers)
    .map((row) => row.active)
  const averageSaturatedActiveWorkers = saturatedSamples.length
    ? saturatedSamples.reduce((sum, value) => sum + value, 0) / saturatedSamples.length
    : averageActiveWorkers
  const utilizationDenominator = Math.max(1, safeActiveWorkers)
  const activePoolUtilization = Math.min(1, averageSaturatedActiveWorkers / utilizationDenominator)
  const enoughWorkForUtilization = input.graph.total_work_items >= safeActiveWorkers * 2
  const blockers = [
    ...(pending.length ? ['naruto_real_active_pool_pending_not_drained'] : []),
    ...(active.size ? ['naruto_real_active_pool_active_not_drained'] : []),
    ...(maxObserved > safeActiveWorkers ? ['naruto_real_active_pool_exceeded_safe_workers'] : []),
    ...(enoughWorkForUtilization && maxObserved < Math.ceil(safeActiveWorkers * 0.8) ? ['naruto_real_active_pool_underutilized'] : []),
    ...(enoughWorkForUtilization && activePoolUtilization < 0.8 ? ['naruto_real_active_pool_low_sustained_utilization'] : []),
    ...[...completed.values()].flatMap((result) => result.blockers || [])
  ]
  return {
    schema: 'sks.naruto-active-pool.v1',
    ok: blockers.length === 0,
    runtime_mode: 'real-worker-lifecycle',
    active_cap: safeActiveWorkers,
    safe_active_workers: safeActiveWorkers,
    total_work_items: input.graph.total_work_items,
    completed_count: completed.size,
    failed_count: failedCount,
    refill_events: refillEvents,
    max_observed_active_workers: maxObserved,
    duplicate_execution_count: 0,
    conflict_items_enqueued: 0,
    max_observed_write_lease_conflicts: 0,
    average_active_workers: Number(averageSaturatedActiveWorkers.toFixed(4)),
    active_pool_utilization: Number(activePoolUtilization.toFixed(4)),
    headless_workers: lifecycle.length,
    refill_latency_ms_p95: percentile(refillLatencies, 0.95),
    worker_lifecycle: lifecycle,
    timeline,
    blockers
  }
}

async function nextCollectableWorkers(active: Map<string, NarutoWorkerHandle>, hardTimeoutMs = 10 * 60 * 1000): Promise<NarutoWorkerHandle[]> {
  const handles = [...active.values()]
  const now = Date.now()
  const timedOut = handles.filter((handle) => now - Number(handle.started_at || now) > hardTimeoutMs)
  if (timedOut.length) return timedOut.map((handle) => ({ ...handle, force_timed_out: true }))
  const handlesWithExit = handles.filter((handle) => typeof (handle as any).exit?.then === 'function')
  if (!handlesWithExit.length) return handles.slice(0, Math.max(1, Math.ceil(active.size / 2)))
  const settled = new Set<NarutoWorkerHandle>()
  for (const handle of handlesWithExit) {
    ;(handle as any).exit.then(() => settled.add(handle), () => settled.add(handle))
  }
  /* intentional: only racing for settlement timing here — actual outcomes are captured via the .then() handlers above, this catch just prevents an unhandled-rejection warning on the raced promises */
  await Promise.race([
    ...handlesWithExit.map((handle) => (handle as any).exit.catch(() => undefined)),
    delay(1000)
  ])
  await delay(25)
  return handlesWithExit.filter((handle) => settled.has(handle))
}

async function forceCollectTimedOutWorker(handle: NarutoWorkerHandle): Promise<NarutoWorkerResult> {
  const blockers = ['naruto_worker_hard_timeout']
  const pid = Number(handle.pid)
  if (Number.isFinite(pid) && pid > 0) {
    sendSignal(pid, 'SIGTERM')
    await delay(5000)
    if (pidAlive(pid)) {
      sendSignal(pid, 'SIGKILL')
      await delay(100)
    }
    if (pidAlive(pid)) blockers.push('naruto_worker_sigkill_failed')
  }
  const heartbeatPath = handle.heartbeat_path || (handle.worker_artifact_dir ? path.join(handle.worker_artifact_dir, 'worker-heartbeat.jsonl') : null)
  const heartbeatArtifactPresent = heartbeatPath ? fs.existsSync(heartbeatPath) : false
  return {
    id: handle.id,
    ok: false,
    item: handle.item,
    placement: handle.placement,
    completed_at: Date.now(),
    pid: handle.pid || null,
    worker_artifact_dir: handle.worker_artifact_dir || null,
    status: 'timed_out',
    blockers,
    ...(heartbeatArtifactPresent ? { heartbeat_artifact_present_after_timeout: true } : {})
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals) {
  /* intentional: the pid/process-group may already be dead (ESRCH) by the time this fires — that's the expected common case, not an error */
  if (process.platform !== 'win32') {
    try { process.kill(-pid, signal) } catch {}
  }
  try { process.kill(pid, signal) } catch {}
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    return err?.code === 'EPERM'
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runNarutoActivePool(input: {
  graph: NarutoWorkGraph
  governor: NarutoConcurrencyGovernorDecision
  failWorkItemIds?: string[]
  retryLimit?: number
  allocateWorktree?: (item: NarutoWorkItem) => Promise<{ ok: boolean; worktree_path?: string; branch?: string; blockers?: string[] }>
}): Promise<NarutoWorktreeActivePoolReport> {
  const base = simulateNarutoActivePool(input)
  const allocations: NarutoWorktreeActivePoolReport['worktree_allocations'] = []
  for (const item of input.graph.work_items) {
    if (!item.write_allowed) continue
    const mode = item.worktree?.mode || input.graph.worktree_policy.mode
    if (mode !== 'git-worktree') {
      allocations.push({ work_item_id: item.id, mode, allocation_status: 'skipped', blockers: [] })
      continue
    }
    if (!input.allocateWorktree) {
      allocations.push({ work_item_id: item.id, mode, allocation_status: 'planned', blockers: [] })
      continue
    }
    const allocated = await input.allocateWorktree(item)
    allocations.push({
      work_item_id: item.id,
      mode,
      allocation_status: allocated.ok ? 'allocated' : 'planned',
      ...(allocated.worktree_path ? { worktree_path: allocated.worktree_path } : {}),
      ...(allocated.branch ? { branch: allocated.branch } : {}),
      blockers: allocated.blockers || []
    })
  }
  const allocationBlockers = allocations.flatMap((row) => row.blockers)
  return {
    ...base,
    ok: base.ok && allocationBlockers.length === 0,
    worktree_mode: input.graph.worktree_policy.mode,
    worktree_allocation_required_count: allocations.filter((row) => row.mode === 'git-worktree').length,
    worktree_allocations: allocations,
    blockers: [...base.blockers, ...allocationBlockers]
  }
}

function activeToGenerationMap(active: Map<string, NarutoWorkerHandle>): Map<string, NarutoGeneration> {
  const out = new Map<string, NarutoGeneration>()
  let index = 1
  for (const handle of active.values()) {
    out.set(handle.id, createNarutoGeneration(handle.item, index, 0))
    index += 1
  }
  return out
}

function percentile(values: number[], quantile: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))
  return sorted[index] || 0
}

export function simulateNarutoActivePool(input: {
  graph: NarutoWorkGraph
  governor: NarutoConcurrencyGovernorDecision
  failWorkItemIds?: string[]
  retryLimit?: number
}): NarutoActivePoolReport {
  const safeActiveWorkers = Math.max(1, input.governor.safe_active_workers)
  const retryLimit = Math.max(0, Math.floor(Number(input.retryLimit ?? 1)))
  const failIds = new Set((input.failWorkItemIds || []).map(String))
  const pending = [...input.graph.work_items]
  const active = new Map<string, NarutoGeneration>()
  const completed = new Set<string>()
  const failed = new Set<string>()
  const executed = new Map<string, number>()
  const byId = new Map(input.graph.work_items.map((item) => [item.id, item]))
  const timeline: NarutoActivePoolReport['timeline'] = []
  let generationIndex = 1
  let tick = 0
  let refillEvents = 0
  let maxObserved = 0
  let maxObservedWriteLeaseConflicts = 0
  let conflictItemsEnqueued = 0
  const repairWaves: NonNullable<NarutoActivePoolReport['repair_waves']> = []

  while (pending.length || active.size) {
    let launched = 0
    for (;;) {
      if (active.size >= safeActiveWorkers) break
      const next = popRunnable(pending, completed, active, byId)
      if (!next) break
      const generation = createNarutoGeneration(next, generationIndex, tick)
      generationIndex += 1
      active.set(generation.generation_id, generation)
      executed.set(next.id, (executed.get(next.id) || 0) + 1)
      launched += 1
    }
    if (launched) refillEvents += launched
    maxObserved = Math.max(maxObserved, active.size)
    maxObservedWriteLeaseConflicts = Math.max(maxObservedWriteLeaseConflicts, countActiveWriteLeaseConflicts(active, byId))
    timeline.push({ tick, active: active.size, pending: pending.length, completed: completed.size, event: launched ? 'refill' : 'wait' })
    const done = [...active.values()].slice(0, Math.max(1, Math.ceil(active.size / 2)))
    if (!done.length && pending.length) break
    for (const generation of done) {
      active.delete(generation.generation_id)
      const shouldFail = failIds.has(generation.work_item_id) && (executed.get(generation.work_item_id) || 0) <= retryLimit
      completeNarutoGeneration(generation, tick + 1, shouldFail)
      if (shouldFail) {
        failed.add(generation.work_item_id)
        conflictItemsEnqueued += 1
        const attempt = executed.get(generation.work_item_id) || 1
        const followup = conflictResolutionFollowup(generation.work_item_id, input.graph.work_items.length + conflictItemsEnqueued, attempt)
        repairWaves.push({
          failed_work_item_id: generation.work_item_id,
          followup_work_item_id: followup.id,
          attempt,
          requires_hypothesis: true,
          tournament_forced: Boolean(followup.tournament && followup.tournament >= 2)
        })
        pending.push(followup)
        byId.set(followup.id, followup)
      } else {
        completed.add(generation.work_item_id)
      }
    }
    tick += 1
    if (tick > input.graph.work_items.length * 4 + 20) break
  }
  const duplicateExecutionCount = [...executed.values()].filter((count) => count > 1).length
  const blockers = [
    ...(pending.length ? ['naruto_active_pool_pending_not_drained'] : []),
    ...(active.size ? ['naruto_active_pool_active_not_drained'] : []),
    ...(maxObserved > safeActiveWorkers ? ['naruto_active_pool_exceeded_safe_workers'] : []),
    ...(maxObservedWriteLeaseConflicts > 0 ? ['naruto_active_pool_overlapping_write_leases'] : []),
    ...(duplicateExecutionCount > conflictItemsEnqueued ? ['naruto_active_pool_duplicate_execution_without_retry'] : [])
  ]
  return {
    schema: 'sks.naruto-active-pool.v1',
    ok: blockers.length === 0,
    safe_active_workers: safeActiveWorkers,
    total_work_items: input.graph.total_work_items,
    completed_count: completed.size,
    failed_count: failed.size,
    refill_events: refillEvents,
    max_observed_active_workers: maxObserved,
    duplicate_execution_count: duplicateExecutionCount,
    conflict_items_enqueued: conflictItemsEnqueued,
    max_observed_write_lease_conflicts: maxObservedWriteLeaseConflicts,
    repair_waves: repairWaves,
    timeline,
    blockers
  }
}

function popRunnable(pending: NarutoWorkItem[], completed: Set<string>, active: Map<string, NarutoGeneration>, byId: Map<string, NarutoWorkItem>): NarutoWorkItem | null {
  const activeWorkIds = new Set([...active.values()].map((item) => item.work_item_id))
  for (let index = 0; index < pending.length; index += 1) {
    const item = pending[index]
    if (!item) continue
    if (activeWorkIds.has(item.id)) continue
    if (!item.dependencies.every((dep) => completed.has(dep))) continue
    const writeConflict = [...active.values()].some((generation) => {
      const activeItem = byId.get(generation.work_item_id)
      return activeItem?.write_paths.some((file) => item.write_paths.includes(file))
    })
    if (writeConflict) continue
    pending.splice(index, 1)
    return item
  }
  return null
}

function countActiveWriteLeaseConflicts(active: Map<string, NarutoGeneration>, byId: Map<string, NarutoWorkItem>): number {
  const counts = new Map<string, number>()
  for (const generation of active.values()) {
    const item = byId.get(generation.work_item_id)
    for (const file of item?.write_paths || []) counts.set(file, (counts.get(file) || 0) + 1)
  }
  return [...counts.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0)
}

function conflictResolutionFollowup(failedId: string, index: number, attempt = 1): NarutoWorkItem {
  const id = `NW-CONFLICT-${String(index).padStart(4, '0')}`
  return {
    id,
    kind: 'conflict_resolution',
    title: `Resolve failed work item ${failedId} with repair-hypothesis.json before patching`,
    target_paths: [],
    readonly_paths: [],
    write_paths: [`.sneakoscope/naruto/conflicts/${id}.json`],
    required_role: 'conflict_resolver',
    write_allowed: true,
    verification_required: true,
    dependencies: [],
    can_run_in_parallel_with: [],
    conflicts_with: [],
    estimated_cost: { tokens: 4000, latency_ms: 45000, cpu_weight: 1, memory_mb: 256, gpu_weight: 0 },
    lease_requirements: [{ path: `.sneakoscope/naruto/conflicts/${id}.json`, kind: 'write' }],
    acceptance: { requires_patch_envelope: true, requires_verification: true, requires_gpt_final: true },
    ...(attempt >= 3 ? { tournament: 3 } : {})
  }
}
