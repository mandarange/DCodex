export const DEFAULT_NARUTO_MAX_THREADS = 12
export const HARD_NARUTO_MAX_THREADS = 32
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
  activeThreadCount?: number | undefined
  parentReservedThreads?: number | undefined
  reviewerReservedThreads?: number | undefined
  marginalUsefulWorkers?: number | undefined
  marginalUsefulThroughputPositive?: boolean | undefined
}

/**
 * Naruto capacity ledger (one spawn path).
 * - `configuredMaxThreads` / max_threads = hard frame budget (cap), never a spawn target
 * - `requested` / agents = work-width target derived from ready DAG / operator intent
 * - Reservations shrink elastically so at least one child slot remains runnable
 */
export function resolveSubagentThreadBudget(input: SubagentThreadBudgetInput = {}): SubagentThreadBudget {
  const requested = clamp(
    input.requested ?? input.independentSliceCount ?? DEFAULT_NARUTO_REQUESTED_SUBAGENTS,
    1,
    HARD_NARUTO_MAX_THREADS
  )
  const configured = clamp(
    input.configuredMaxThreads ?? DEFAULT_NARUTO_MAX_THREADS,
    1,
    HARD_NARUTO_MAX_THREADS
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
  // Keep ≥1 executable child slot under small caps (elastic reservation).
  const reservationCapacity = Math.max(0, configured - activeThreads - 1)
  const parentThreads = Math.min(requestedParentThreads, reservationCapacity)
  const reviewerThreads = Math.min(requestedReviewerThreads, reservationCapacity - parentThreads)
  const availableThreadSlots = Math.max(0, configured - parentThreads - reviewerThreads - activeThreads)
  const marginalUsefulThroughputPositive = input.marginalUsefulThroughputPositive !== false
  const bounds: Record<SubagentCapacityFactor, number> = {
    ready_dag_width: optionalCapacity(input.readyDagWidth, requested),
    disjoint_ownership: optionalCapacity(input.disjointOwnershipCount, requested),
    verifier_capacity: optionalCapacity(input.verifierCapacity, requested),
    tool_concurrency: optionalCapacity(input.toolConcurrency, requested),
    available_thread_slots: availableThreadSlots,
    marginal_useful_workers: marginalUsefulThroughputPositive
      ? optionalCapacity(input.marginalUsefulWorkers, requested)
      : 0,
    requested_subagents: requested
  }
  const selectedCapacity = Math.min(...Object.values(bounds))
  const limitingFactors = (Object.entries(bounds) as Array<[SubagentCapacityFactor, number]>)
    .filter(([, value]) => value === selectedCapacity)
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

function clamp(value: unknown, minimum: number, maximum: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return minimum
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)))
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
