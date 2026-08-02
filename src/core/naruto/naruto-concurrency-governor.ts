import {
  DEFAULT_NARUTO_MAX_THREADS,
  HARD_NARUTO_MAX_THREADS
} from '../subagents/thread-budget.js'
import { probeHardwareCapacity, type HardwareCapacityProbeInput } from './hardware-capacity-probe.js'
import { applyNarutoBackpressure } from './naruto-backpressure.js'
import { monitorNarutoResourcePressure } from './resource-pressure-monitor.js'

export interface NarutoConcurrencyGovernorInput {
  requestedWorkers?: number
  totalWorkItems?: number
  pendingWorkQueueSize?: number
  activeLeaseConflicts?: number
  backend?: string
  hardware?: HardwareCapacityProbeInput
  zellijVisiblePaneCap?: number
  parallelismMode?: 'extreme' | 'balanced' | 'safe' | string
  /** Optional spawned-child slot cap (max_threads). Defaults to DEFAULT_NARUTO_MAX_THREADS. */
  maxThreads?: number
  /** Exact host-owned child slot cap, when the Codex host exposes one. */
  externalCodexHostCap?: number
}

export interface NarutoConcurrencyGovernorDecision {
  schema: 'sks.naruto-concurrency-governor.v1'
  requested_workers: number
  total_work_items: number
  safe_active_workers: number
  safe_zellij_visible_panes: number
  headless_workers: number
  local_llm_parallel: number
  remote_codex_parallel: number
  process_parallel: number
  git_worktree_parallel: number
  cpu_io_parallel: number
  verification_parallel: number
  external_codex_host_cap: number | null
  limiting_factors: string[]
  parallelism_mode: 'extreme' | 'balanced' | 'safe'
  reasons: string[]
  backpressure: 'normal' | 'throttled' | 'saturated'
  hardware: ReturnType<typeof probeHardwareCapacity>
}

/**
 * Hardware-aware frame budget for Naruto-adjacent native pools.
 * max_threads is a hard cap (frame budget), never a spawn target; the absolute
 * ceiling is HARD_NARUTO_MAX_THREADS (256). Must not hard-code "4" — that
 * confused the GPT-5.6 four-profile matrix with agent count.
 * Official Codex subagents are host-managed remote threads: local CPU/RAM/fd
 * budgets and an unmeasured default API budget do not cap that lane. A measured
 * external host cap or explicitly configured API budget still applies exactly.
 * Heavy local backends (codex-sdk/zellij/process/ollama) are bounded by the remote
 * API rate-limit budget and 1.5 GB/worker; light lanes (any other backend) skip
 * the remote budget and use 0.5 GB/worker, so they can scale into the hundreds
 * when the real memory/fd/cpu floors below allow it.
 */
export function decideNarutoConcurrency(input: NarutoConcurrencyGovernorInput = {}): NarutoConcurrencyGovernorDecision {
  const frameBudget = boundedThreadCount(
    input.maxThreads ?? DEFAULT_NARUTO_MAX_THREADS,
    'max_threads'
  )
  const requestedWorkers = boundedThreadCount(
    input.requestedWorkers ?? Math.min(8, frameBudget),
    'requested_workers'
  )
  const totalWorkItems = normalizePositiveInt(input.totalWorkItems, requestedWorkers)
  const pending = normalizeNonNegativeInt(input.pendingWorkQueueSize, totalWorkItems)
  const leaseConflicts = normalizeNonNegativeInt(input.activeLeaseConflicts, 0)
  const hardware = probeHardwareCapacity(input.hardware || {})
  const zellijVisiblePaneCap = normalizePositiveInt(
    input.zellijVisiblePaneCap,
    Math.min(frameBudget, Math.max(4, Math.floor(hardware.terminal_rows / 5)))
  )
  const backend = String(input.backend || 'codex-sdk')
  const officialSubagentLane = backend === 'official-subagent'
  const parallelismMode = normalizeParallelismMode(input.parallelismMode)
  const freeGb = hardware.free_memory_bytes / (1024 * 1024 * 1024)
  const totalGb = hardware.total_memory_bytes / (1024 * 1024 * 1024)
  const reservedInteractiveGb = Math.max(2, totalGb * 0.2)
  const memoryBudgetGb = Math.max(0.5, freeGb - reservedInteractiveGb)
  const heavy = backend === 'codex-sdk' || backend === 'zellij' || backend === 'process' || backend === 'ollama'
  const gbPerWorker = heavy
    ? normalizePositiveNumber(process.env.SKS_NARUTO_GB_PER_WORKER, 1.5)
    : normalizePositiveNumber(process.env.SKS_NARUTO_LIGHT_GB_PER_WORKER, 0.5)
  const memoryCap = Math.max(1, Math.floor(memoryBudgetGb / Math.max(0.25, gbPerWorker)))
  const fdCap = Math.max(1, Math.floor((hardware.file_descriptor_limit - hardware.process_count) / 6))
  const cpuCap = Math.max(1, Math.min(frameBudget, Math.floor(hardware.cpu_core_count * (heavy ? 0.5 : 0.65))))
  const ioCap = Math.max(1, Math.min(Math.ceil(frameBudget / 4), Math.floor(hardware.cpu_core_count / 3)))
  const configuredProcessCap = normalizePositiveInt(
    process.env.SKS_NARUTO_HEADLESS_PROCESS_CAP,
    frameBudget
  )
  const processCap = Math.min(configuredProcessCap, cpuCap, frameBudget)
  const gitWorktreeCap = normalizePositiveInt(
    process.env.SKS_NARUTO_GIT_WORKTREE_CAP,
    Math.min(requestedWorkers, processCap)
  )
  const localLlmParallel = Math.max(1, Math.min(frameBudget, hardware.local_llm_max_parallel_requests))
  const remoteCodexParallel = Math.max(1, Math.min(hardware.remote_api_rate_limit_budget, requestedWorkers, frameBudget))
  const externalCodexHostCap = input.externalCodexHostCap === undefined
    ? null
    : boundedThreadCount(input.externalCodexHostCap, 'external_codex_host_cap')
  const explicitRemoteApiBudget = hardware.remote_api_rate_limit_budget_source !== 'default_unmeasured'
  const backendBudget = officialSubagentLane
    ? explicitRemoteApiBudget ? remoteCodexParallel : frameBudget
    : backend === 'ollama' || backend === 'local-llm'
    ? localLlmParallel
    : backend === 'codex-sdk' || backend === 'zellij'
      ? Math.min(remoteCodexParallel, processCap)
      : processCap
  const queueCap = Math.max(1, Math.min(requestedWorkers, pending || totalWorkItems))
  const leaseCap = Math.max(1, requestedWorkers - leaseConflicts)
  // IO pressure informs reasons/reporting; it must not hard-cap the whole Naruto
  // worker frame at ~4 (the old `ioCap + 1` pattern recreated the four-agent bug).
  const localWorkerBounds = officialSubagentLane
    ? []
    : [memoryCap, fdCap, cpuCap, gitWorktreeCap, processCap]
  const rawSafe = Math.max(1, Math.min(
    requestedWorkers,
    totalWorkItems,
    ...localWorkerBounds,
    backendBudget,
    queueCap,
    leaseCap,
    ...(externalCodexHostCap === null ? [] : [externalCodexHostCap]),
    frameBudget
  ))
  const pressure = monitorNarutoResourcePressure(hardware, { activeWorkers: rawSafe, zellijVisiblePaneCap })
  const backpressure = applyNarutoBackpressure(rawSafe, pressure)
  const currentSafeActiveWorkers = officialSubagentLane
    ? rawSafe
    : Math.max(1, Math.min(rawSafe, backpressure.adjusted_active_workers))
  // Every mode respects live backpressure. Modes only lower the bounded cap.
  const modeCap = parallelismMode === 'safe'
    ? Math.max(1, Math.ceil(rawSafe * 0.5))
    : parallelismMode === 'balanced'
      ? Math.max(1, Math.ceil(rawSafe * 0.75))
      : rawSafe
  const safeActiveWorkers = Math.max(1, Math.min(modeCap, currentSafeActiveWorkers))
  const safeVisible = Math.min(safeActiveWorkers, zellijVisiblePaneCap)
  const exactLimiters = [
    ...(externalCodexHostCap !== null && externalCodexHostCap === rawSafe
      ? [`external_codex_host_cap:${externalCodexHostCap}`]
      : []),
    ...(frameBudget === rawSafe && frameBudget < requestedWorkers
      ? [`naruto_max_threads_child_slot_cap:${frameBudget}`]
      : []),
    ...(backendBudget === rawSafe && backendBudget < requestedWorkers
      ? [`backend_parallel_budget:${backendBudget}`]
      : []),
    ...(officialSubagentLane && explicitRemoteApiBudget && remoteCodexParallel === rawSafe
      && remoteCodexParallel < requestedWorkers
      ? [`remote_api_rate_limit_budget:${remoteCodexParallel}`]
      : []),
    ...(!officialSubagentLane && memoryCap === rawSafe && memoryCap < requestedWorkers ? [`memory_cap:${memoryCap}`] : []),
    ...(!officialSubagentLane && fdCap === rawSafe && fdCap < requestedWorkers ? [`file_descriptor_budget:${fdCap}`] : []),
    ...(!officialSubagentLane && cpuCap === rawSafe && cpuCap < requestedWorkers ? [`cpu_budget:${cpuCap}`] : []),
    ...(!officialSubagentLane && gitWorktreeCap === rawSafe && gitWorktreeCap < requestedWorkers
      ? [`git_worktree_budget:${gitWorktreeCap}`]
      : []),
    ...(queueCap === rawSafe && queueCap < requestedWorkers ? [`ready_queue_cap:${queueCap}`] : []),
    ...(leaseCap === rawSafe && leaseCap < requestedWorkers ? [`lease_conflict_cap:${leaseCap}`] : []),
    ...(!officialSubagentLane && safeActiveWorkers < rawSafe ? [`live_backpressure:${safeActiveWorkers}`] : [])
  ]
  const reasons = [
    ...(!officialSubagentLane && memoryCap < requestedWorkers ? ['memory_cap'] : []),
    ...(!officialSubagentLane && fdCap < requestedWorkers ? ['file_descriptor_budget'] : []),
    ...(!officialSubagentLane && cpuCap + ioCap < requestedWorkers ? ['cpu_io_budget'] : []),
    ...(!officialSubagentLane && gitWorktreeCap + processCap < requestedWorkers ? ['git_worktree_process_budget'] : []),
    ...(backendBudget < requestedWorkers ? ['backend_parallel_budget'] : []),
    ...((!officialSubagentLane || explicitRemoteApiBudget) && remoteCodexParallel < requestedWorkers
      ? [`remote_api_rate_limit_budget:${remoteCodexParallel}`]
      : []),
    ...(externalCodexHostCap !== null && externalCodexHostCap < requestedWorkers
      ? [`external_codex_host_cap:${externalCodexHostCap}`]
      : []),
    ...(frameBudget < requestedWorkers ? [`naruto_max_threads_child_slot_cap:${frameBudget}`] : []),
    ...(safeVisible < safeActiveWorkers ? ['zellij_ui_pane_budget'] : []),
    ...(leaseConflicts > 0 ? ['active_lease_conflicts'] : []),
    ...(!officialSubagentLane ? pressure.reasons : [])
  ]
  return {
    schema: 'sks.naruto-concurrency-governor.v1',
    requested_workers: requestedWorkers,
    total_work_items: totalWorkItems,
    safe_active_workers: safeActiveWorkers,
    safe_zellij_visible_panes: safeVisible,
    headless_workers: Math.max(0, safeActiveWorkers - safeVisible),
    local_llm_parallel: localLlmParallel,
    remote_codex_parallel: remoteCodexParallel,
    process_parallel: officialSubagentLane ? frameBudget : processCap,
    git_worktree_parallel: officialSubagentLane ? frameBudget : gitWorktreeCap,
    cpu_io_parallel: officialSubagentLane ? frameBudget : cpuCap + ioCap,
    verification_parallel: Math.max(1, Math.min(2, safeActiveWorkers)),
    external_codex_host_cap: externalCodexHostCap,
    limiting_factors: [...new Set(exactLimiters)],
    parallelism_mode: parallelismMode,
    reasons: [...new Set(reasons)],
    backpressure: officialSubagentLane ? 'normal' : backpressure.backpressure,
    hardware
  }
}

function normalizeParallelismMode(value: unknown): 'extreme' | 'balanced' | 'safe' {
  const text = String(value || process.env.SKS_NARUTO_PARALLELISM || 'extreme').toLowerCase()
  if (text === 'safe' || text === 'balanced' || text === 'extreme') return text
  return 'extreme'
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return Math.max(1, Math.floor(fallback))
  return Math.floor(parsed)
}

function normalizePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return Math.max(0, Math.floor(fallback))
  return Math.floor(parsed)
}

function boundedThreadCount(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_NARUTO_MAX_THREADS) {
    throw new RangeError(`${label}_must_be_integer_1_to_${HARD_NARUTO_MAX_THREADS}:${String(value)}`)
  }
  return parsed
}
