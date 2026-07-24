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
  /** Optional hard frame budget (max_threads). Defaults to DEFAULT_NARUTO_MAX_THREADS. */
  maxThreads?: number
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
  parallelism_mode: 'extreme' | 'balanced' | 'safe'
  reasons: string[]
  backpressure: 'normal' | 'throttled' | 'saturated'
  hardware: ReturnType<typeof probeHardwareCapacity>
}

/**
 * Hardware-aware frame budget for Naruto-adjacent native pools.
 * max_threads is a hard cap (frame budget), never a spawn target.
 * Must not hard-code "4" — that confused the GPT-5.6 four-profile matrix with agent count.
 */
export function decideNarutoConcurrency(input: NarutoConcurrencyGovernorInput = {}): NarutoConcurrencyGovernorDecision {
  const frameBudget = clamp(
    input.maxThreads ?? DEFAULT_NARUTO_MAX_THREADS,
    1,
    HARD_NARUTO_MAX_THREADS
  )
  const requestedWorkers = normalizePositiveInt(input.requestedWorkers, Math.min(8, frameBudget))
  const totalWorkItems = normalizePositiveInt(input.totalWorkItems, requestedWorkers)
  const pending = normalizeNonNegativeInt(input.pendingWorkQueueSize, totalWorkItems)
  const leaseConflicts = normalizeNonNegativeInt(input.activeLeaseConflicts, 0)
  const hardware = probeHardwareCapacity(input.hardware || {})
  const zellijVisiblePaneCap = normalizePositiveInt(
    input.zellijVisiblePaneCap,
    Math.min(frameBudget, Math.max(4, Math.floor(hardware.terminal_rows / 5)))
  )
  const backend = String(input.backend || 'codex-sdk')
  const parallelismMode = normalizeParallelismMode(input.parallelismMode)
  const freeGb = hardware.free_memory_bytes / (1024 * 1024 * 1024)
  const totalGb = hardware.total_memory_bytes / (1024 * 1024 * 1024)
  const reservedInteractiveGb = Math.max(2, totalGb * 0.2)
  const memoryBudgetGb = Math.max(0.5, freeGb - reservedInteractiveGb)
  const heavy = backend === 'codex-sdk' || backend === 'zellij' || backend === 'process' || backend === 'ollama'
  const gbPerWorker = heavy ? Number(process.env.SKS_NARUTO_GB_PER_WORKER || 1.5) : Number(process.env.SKS_NARUTO_LIGHT_GB_PER_WORKER || 0.5)
  const memoryCap = Math.max(1, Math.floor(memoryBudgetGb / Math.max(0.25, gbPerWorker)))
  const fdCap = Math.max(1, Math.floor((hardware.file_descriptor_limit - hardware.process_count) / 6))
  const cpuCap = Math.max(1, Math.min(frameBudget, Math.floor(hardware.cpu_core_count * (heavy ? 0.5 : 0.65))))
  const ioCap = Math.max(1, Math.min(Math.ceil(frameBudget / 4), Math.floor(hardware.cpu_core_count / 3)))
  const configuredProcessCap = Math.max(1, Number(process.env.SKS_NARUTO_HEADLESS_PROCESS_CAP || frameBudget))
  const processCap = Math.min(configuredProcessCap, cpuCap, frameBudget)
  const gitWorktreeCap = Math.max(1, Number(process.env.SKS_NARUTO_GIT_WORKTREE_CAP || Math.min(requestedWorkers, processCap)))
  const localLlmParallel = Math.max(1, Math.min(frameBudget, hardware.local_llm_max_parallel_requests))
  const remoteCodexParallel = Math.max(1, Math.min(hardware.remote_api_rate_limit_budget, requestedWorkers, frameBudget))
  const backendBudget = backend === 'ollama' || backend === 'local-llm'
    ? localLlmParallel
    : backend === 'codex-sdk' || backend === 'zellij'
      ? Math.min(remoteCodexParallel, processCap)
      : processCap
  const queueCap = Math.max(1, Math.min(requestedWorkers, pending || totalWorkItems))
  const leaseCap = Math.max(1, requestedWorkers - leaseConflicts)
  // IO pressure informs reasons/reporting; it must not hard-cap the whole Naruto
  // worker frame at ~4 (the old `ioCap + 1` pattern recreated the four-agent bug).
  const rawSafe = Math.max(1, Math.min(
    requestedWorkers,
    totalWorkItems,
    memoryCap,
    fdCap,
    cpuCap,
    gitWorktreeCap,
    processCap,
    backendBudget,
    queueCap,
    leaseCap,
    frameBudget
  ))
  const pressure = monitorNarutoResourcePressure(hardware, { activeWorkers: rawSafe, zellijVisiblePaneCap })
  const backpressure = applyNarutoBackpressure(rawSafe, pressure)
  const currentSafeActiveWorkers = Math.max(1, Math.min(rawSafe, backpressure.adjusted_active_workers))
  // Every mode respects live backpressure. Modes only lower the bounded cap.
  const modeCap = parallelismMode === 'safe'
    ? Math.max(1, Math.ceil(rawSafe * 0.5))
    : parallelismMode === 'balanced'
      ? Math.max(1, Math.ceil(rawSafe * 0.75))
      : rawSafe
  const safeActiveWorkers = Math.max(1, Math.min(modeCap, currentSafeActiveWorkers))
  const safeVisible = Math.min(safeActiveWorkers, zellijVisiblePaneCap)
  const reasons = [
    ...(memoryCap < requestedWorkers ? ['memory_cap'] : []),
    ...(fdCap < requestedWorkers ? ['file_descriptor_budget'] : []),
    ...(cpuCap + ioCap < requestedWorkers ? ['cpu_io_budget'] : []),
    ...(gitWorktreeCap + processCap < requestedWorkers ? ['git_worktree_process_budget'] : []),
    ...(backendBudget < requestedWorkers ? ['backend_parallel_budget'] : []),
    ...(remoteCodexParallel < requestedWorkers ? ['remote_api_rate_limit_budget'] : []),
    ...(frameBudget < requestedWorkers ? ['naruto_max_threads_frame_budget'] : []),
    ...(safeVisible < safeActiveWorkers ? ['zellij_ui_pane_budget'] : []),
    ...(leaseConflicts > 0 ? ['active_lease_conflicts'] : []),
    ...pressure.reasons
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
    process_parallel: processCap,
    git_worktree_parallel: gitWorktreeCap,
    cpu_io_parallel: cpuCap + ioCap,
    verification_parallel: Math.max(1, Math.min(2, safeActiveWorkers)),
    parallelism_mode: parallelismMode,
    reasons: [...new Set(reasons)],
    backpressure: backpressure.backpressure,
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

function normalizeNonNegativeInt(value: unknown, fallback: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return Math.max(0, Math.floor(fallback))
  return Math.floor(parsed)
}

function clamp(value: unknown, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
}
