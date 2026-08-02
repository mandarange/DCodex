export const DEFAULT_NARUTO_MAX_THREADS = 256
/**
 * Absolute structural frame ceiling (hard safety cap, never a spawn target).
 * Raised from 32 to 256 so mass fan-out can schedule multi-wave under one
 * frame budget; real per-lane floors (memory/fd/cpu/rate-limit) still apply downstream.
 */
export const HARD_NARUTO_MAX_THREADS = 256
export const DEFAULT_NARUTO_REQUESTED_SUBAGENTS = 4
/** Parent always keeps one frame-budget slot for integration — never treat this as spawn target. */
export const DEFAULT_NARUTO_PARENT_THREAD_RESERVATION = 1
/**
 * Reviewer slots are demand-driven. Default 0 so idle reviewer reservation cannot
 * collapse useful Naruto child parallelism (the old default of 1 made max_threads=6
 * look like a hard 4-child creation cap).
 */
export const DEFAULT_NARUTO_REVIEWER_THREAD_RESERVATION = 0

export type SubagentCapacityFactor =
  | 'ready_dag_width'
  | 'disjoint_ownership'
  | 'verifier_capacity'
  | 'tool_concurrency'
  | 'external_codex_host_cap'
  | 'available_thread_slots'
  | 'marginal_useful_workers'
  | 'requested_subagents'

export interface SubagentCapacityController {
  formula: 'min_ready_dag_disjoint_verifier_tools_available_marginal'
  max_threads_is_cap_not_target: true
  selected_capacity: number
  available_thread_slots: number
  limiting_factors: SubagentCapacityFactor[]
  bounds: Record<SubagentCapacityFactor, number>
  external_codex_host_cap_verification: 'verified' | 'unverified_external_host_cap'
  reservations: {
    parent_threads: number
    reviewer_threads: number
    active_threads: number
  }
  marginal_useful_throughput_positive: boolean
  exhausted: boolean
}

export interface SubagentThreadBudget {
  requestedSubagents: number
  maxThreads: number
  firstWave: number
  waveCount: number
  maxDepth: 1
  capacity: SubagentCapacityController
}

export interface SubagentThreadBudgetInput {
  requested?: number | undefined
  configuredMaxThreads?: number | undefined
  independentSliceCount?: number | undefined
  readyDagWidth?: number | undefined
  disjointOwnershipCount?: number | undefined
  verifierCapacity?: number | undefined
  toolConcurrency?: number | undefined
  /** Measured host-owned child-thread limit. Omit when the host has not exposed one. */
  externalCodexHostCap?: number | undefined
  activeThreadCount?: number | undefined
  parentReservedThreads?: number | undefined
  reviewerReservedThreads?: number | undefined
  marginalUsefulWorkers?: number | undefined
  marginalUsefulThroughputPositive?: boolean | undefined
}

/**
 * Naruto capacity ledger (one spawn path).
 * - `configuredMaxThreads` / max_threads = spawned-child slot cap, never a spawn target
 * - `requested` / agents = work-width target derived from ready DAG / operator intent
 * - The root is outside this child-slot cap; subtracting it here would count it twice
 * - Child reviewer reservations shrink elastically so at least one child slot remains runnable
 */
export function resolveSubagentThreadBudget(input: SubagentThreadBudgetInput = {}): SubagentThreadBudget {
  const requested = boundedPositiveInteger(
    input.requested ?? input.independentSliceCount ?? DEFAULT_NARUTO_REQUESTED_SUBAGENTS,
    'requested_subagents'
  )
  const configured = boundedPositiveInteger(
    input.configuredMaxThreads ?? DEFAULT_NARUTO_MAX_THREADS,
    'max_threads'
  )
  const requestedParentThreads = clampNonNegative(
    input.parentReservedThreads ?? DEFAULT_NARUTO_PARENT_THREAD_RESERVATION,
    HARD_NARUTO_MAX_THREADS
  )
  const requestedReviewerThreads = clampNonNegative(
    input.reviewerReservedThreads ?? DEFAULT_NARUTO_REVIEWER_THREAD_RESERVATION,
    HARD_NARUTO_MAX_THREADS
  )
  const activeThreads = clampNonNegative(input.activeThreadCount ?? 0, HARD_NARUTO_MAX_THREADS)
  // `configured` already counts only children. The root reservation is reported
  // for frame accounting but deliberately does not consume a child slot.
  const parentThreads = requestedParentThreads
  const reviewerReservationCapacity = Math.max(0, configured - activeThreads - 1)
  const reviewerThreads = Math.min(requestedReviewerThreads, reviewerReservationCapacity)
  const availableThreadSlots = Math.max(0, configured - reviewerThreads - activeThreads)
  const marginalUsefulThroughputPositive = input.marginalUsefulThroughputPositive !== false
  const externalCodexHostCapVerified = input.externalCodexHostCap !== undefined
  const bounds: Record<SubagentCapacityFactor, number> = {
    ready_dag_width: optionalCapacity(input.readyDagWidth, requested),
    disjoint_ownership: optionalCapacity(input.disjointOwnershipCount, requested),
    verifier_capacity: optionalCapacity(input.verifierCapacity, requested),
    tool_concurrency: optionalCapacity(input.toolConcurrency, requested),
    external_codex_host_cap: optionalCapacity(input.externalCodexHostCap, requested),
    available_thread_slots: availableThreadSlots,
    marginal_useful_workers: marginalUsefulThroughputPositive
      ? optionalCapacity(input.marginalUsefulWorkers, requested)
      : 0,
    requested_subagents: requested
  }
  const selectedCapacity = Math.min(...Object.values(bounds))
  const limitingFactors = (Object.entries(bounds) as Array<[SubagentCapacityFactor, number]>)
    .filter(([factor, value]) => (
      value === selectedCapacity
      && (factor !== 'external_codex_host_cap' || externalCodexHostCapVerified)
    ))
    .map(([factor]) => factor)

  return {
    requestedSubagents: requested,
    maxThreads: configured,
    firstWave: selectedCapacity,
    waveCount: selectedCapacity > 0 ? Math.ceil(requested / selectedCapacity) : 0,
    maxDepth: 1,
    capacity: {
      formula: 'min_ready_dag_disjoint_verifier_tools_available_marginal',
      max_threads_is_cap_not_target: true,
      selected_capacity: selectedCapacity,
      available_thread_slots: availableThreadSlots,
      limiting_factors: limitingFactors,
      bounds,
      external_codex_host_cap_verification: externalCodexHostCapVerified
        ? 'verified'
        : 'unverified_external_host_cap',
      reservations: {
        parent_threads: parentThreads,
        reviewer_threads: reviewerThreads,
        active_threads: activeThreads
      },
      marginal_useful_throughput_positive: marginalUsefulThroughputPositive,
      exhausted: requested > 0 && selectedCapacity === 0
    }
  }
}

function boundedPositiveInteger(value: unknown, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_NARUTO_MAX_THREADS) {
    throw new RangeError(`${label}_must_be_integer_1_to_${HARD_NARUTO_MAX_THREADS}:${String(value)}`)
  }
  return parsed
}

function clampNonNegative(value: unknown, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.min(maximum, Math.floor(parsed)))
}

function optionalCapacity(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  return clampNonNegative(value, HARD_NARUTO_MAX_THREADS)
}
