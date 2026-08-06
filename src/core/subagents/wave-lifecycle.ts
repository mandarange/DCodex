import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import {
  readSubagentEvents,
  type NormalizedSubagentEvent,
  type SubagentEvidence
} from './subagent-evidence.js'
import {
  MAX_AUTOMATIC_SUBAGENT_COUNT,
  MAX_MASS_AUTOMATIC_SUBAGENT_COUNT
} from './agent-catalog.js'
import { buildWaveParentGuidance, type WaveParentGuidance } from './wave-parent-guidance.js'

export const SUBAGENT_WAVE_LIFECYCLE_SCHEMA = 'sks.subagent-wave-lifecycle.v1'

const LEGACY_SKS_AUTOMATIC_SUBAGENT_CEILINGS = new Set([12, 64])

export type SubagentCountPolicy = 'exact' | 'dynamic_automatic'

export function subagentCountPolicy(plan: Record<string, unknown> | null | undefined): SubagentCountPolicy {
  const lifecycle = plan?.wave_lifecycle as Partial<SubagentWaveLifecycle> | undefined
  if (lifecycle?.count_policy === 'dynamic_automatic') return 'dynamic_automatic'
  if (lifecycle?.count_policy === 'exact') return 'exact'
  return 'exact'
}

export function normalizeLegacySubagentCountFields<T>(value: T, plan?: Record<string, unknown> | null): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const row = value as Record<string, unknown>
  if (row.count_policy !== undefined || row.target_subagents !== undefined) return value
  const lifecycle = plan?.wave_lifecycle as Partial<SubagentWaveLifecycle> | undefined
  const requestedSubagents = normalizeCount(row.requested_subagents) || normalizeCount(plan?.requested_subagents)
  if (requestedSubagents < 1) return value
  const countPolicy = lifecycle?.count_policy === 'dynamic_automatic' ? 'dynamic_automatic' : 'exact'
  const targetSubagents = countPolicy === 'dynamic_automatic'
    ? normalizeCount(lifecycle?.target_subagents) || requestedSubagents
    : requestedSubagents
  return {
    ...row,
    count_policy: countPolicy,
    target_subagents: targetSubagents
  } as T
}

export function subagentCountContractBlockers(plan: Record<string, unknown> | null | undefined, observedStarts = 0): string[] {
  const lifecycle = plan?.wave_lifecycle as Partial<SubagentWaveLifecycle> | undefined
  const exactSealedTarget = normalizeCount(lifecycle?.requested_target_subagents)
    || normalizeCount(plan?.requested_subagents)
  const exactTargetRejected = lifecycle?.count_policy === 'exact' && (
    lifecycle.target_change_rejected === true
      || normalizeCount(lifecycle.target_subagents) !== exactSealedTarget
  )
  const cap = automaticSubagentTargetCap(plan)
  const dynamicObservedOrDeclared = Math.max(
    normalizeCount(observedStarts),
    normalizeCount(lifecycle?.target_subagents)
  )
  const dynamicCapExceeded = lifecycle?.count_policy === 'dynamic_automatic'
    && dynamicObservedOrDeclared > cap
  const waveCapacity = positiveCount(lifecycle?.wave_capacity)
    || positiveCount(plan?.first_wave)
    || positiveCount((plan?.capacity_controller as Record<string, unknown> | undefined)?.selected_capacity)
  const legacyObservedWavePeak = Array.isArray(lifecycle?.waves)
    ? lifecycle.waves.reduce((peak, wave) => {
        if (!wave || typeof wave !== 'object' || !Array.isArray(wave.thread_ids)) return peak
        return Math.max(peak, new Set(wave.thread_ids.map(String).filter(Boolean)).size)
      }, 0)
    : 0
  const observedWavePeak = lifecycle?.peak_open_threads === undefined
    ? legacyObservedWavePeak
    : normalizeCount(lifecycle.peak_open_threads)
  const waveCapacityExceeded = waveCapacity > 0 && observedWavePeak > waveCapacity
  return [
    ...(exactTargetRejected ? ['subagent_target_change_rejected'] : []),
    ...(dynamicCapExceeded ? [`subagent_automatic_fanout_cap_exceeded:${dynamicObservedOrDeclared}/${cap}`] : []),
    ...(waveCapacityExceeded ? [`subagent_wave_capacity_exceeded:${observedWavePeak}/${waveCapacity}`] : [])
  ]
}

export function automaticSubagentTargetCap(plan: Record<string, unknown> | null | undefined): number {
  const fanout = plan?.fanout_policy as Record<string, unknown> | undefined
  const hardAutomaticCeiling = fanout?.mass_parallel === true
    ? MAX_MASS_AUTOMATIC_SUBAGENT_COUNT
    : MAX_AUTOMATIC_SUBAGENT_COUNT
  const configuredCeiling = positiveCount(fanout?.automatic_ceiling)
  const legacySksOwnedCeiling = fanout?.mode === 'parent_owned_risk_based'
    && fanout?.count_source === 'automatic'
    && LEGACY_SKS_AUTOMATIC_SUBAGENT_CEILINGS.has(configuredCeiling)
  const effectiveConfiguredCeiling = legacySksOwnedCeiling
    ? hardAutomaticCeiling
    : configuredCeiling || hardAutomaticCeiling
  return Math.min(effectiveConfiguredCeiling, hardAutomaticCeiling)
}

export function effectiveSubagentTarget(
  plan: Record<string, unknown> | null | undefined,
  observedStarts = 0
): { requestedSubagents: number; countPolicy: SubagentCountPolicy; targetSubagents: number } {
  const countPolicy = subagentCountPolicy(plan)
  const lifecycle = plan?.wave_lifecycle as Partial<SubagentWaveLifecycle> | undefined
  const planRequestedSubagents = normalizeCount(plan?.requested_subagents)
  const requestedSubagents = countPolicy === 'exact'
    ? normalizeCount(lifecycle?.requested_target_subagents) || planRequestedSubagents
    : planRequestedSubagents
  const lifecycleTarget = normalizeCount(lifecycle?.target_subagents)
  const dynamicCap = automaticSubagentTargetCap(plan)
  return {
    requestedSubagents,
    countPolicy,
    targetSubagents: countPolicy === 'dynamic_automatic'
      ? Math.min(dynamicCap, Math.max(requestedSubagents, lifecycleTarget, normalizeCount(observedStarts)))
      : requestedSubagents
  }
}

export interface SubagentWaveRecord {
  wave: number
  status: 'running' | 'settled'
  thread_ids: string[]
  settled_thread_ids: string[]
  started_at: string
  settled_at: string | null
}

export interface SubagentWaveLifecycle {
  schema: typeof SUBAGENT_WAVE_LIFECYCLE_SCHEMA
  owner: 'root_parent'
  workflow_run_id: string
  count_policy: SubagentCountPolicy
  requested_target_subagents: number
  target_subagents: number
  target_change_rejected: boolean
  max_depth: 1
  max_depth_semantics: 'child_nesting_only_root_may_launch_later_direct_child_waves'
  current_wave: number
  completed_waves: number
  cumulative_started: number
  cumulative_completed: number
  cumulative_failed: number
  cumulative_settled: number
  peak_open_threads: number
  open_threads: number
  remaining_to_start: number
  post_wave_rescan_required: boolean
  wave_capacity: number
  recovered_capacity: number
  next_parent_actions: string[]
  parent_guidance: WaveParentGuidance
  waves: SubagentWaveRecord[]
  last_event: 'SubagentStart' | 'SubagentStop' | null
  updated_at: string
}

export function createSubagentWaveLifecycle(input: {
  workflowRunId: string
  targetSubagents: number
  countPolicy: SubagentCountPolicy
  waveCapacity?: number
}): SubagentWaveLifecycle {
  const targetSubagents = normalizeCount(input.targetSubagents)
  const waveCapacity = input.waveCapacity === undefined
    ? targetSubagents
    : normalizeCount(input.waveCapacity)
  return {
    schema: SUBAGENT_WAVE_LIFECYCLE_SCHEMA,
    owner: 'root_parent',
    workflow_run_id: String(input.workflowRunId || '').trim(),
    count_policy: input.countPolicy,
    requested_target_subagents: targetSubagents,
    target_subagents: targetSubagents,
    target_change_rejected: false,
    max_depth: 1,
    max_depth_semantics: 'child_nesting_only_root_may_launch_later_direct_child_waves',
    current_wave: 0,
    completed_waves: 0,
    cumulative_started: 0,
    cumulative_completed: 0,
    cumulative_failed: 0,
    cumulative_settled: 0,
    peak_open_threads: 0,
    open_threads: 0,
    remaining_to_start: targetSubagents,
    post_wave_rescan_required: false,
    wave_capacity: waveCapacity,
    recovered_capacity: 0,
    next_parent_actions: [],
    parent_guidance: buildWaveParentGuidance({
      remaining_to_start: targetSubagents,
      open_threads: 0,
      wave_capacity: waveCapacity,
      recovered_capacity: 0,
      post_wave_rescan_required: false,
      current_wave: 0,
      completed_waves: 0
    }),
    waves: [],
    last_event: null,
    updated_at: nowIso()
  }
}

export async function refreshSubagentWaveLifecycle(
  artifactDir: string,
  input: {
    plan?: Record<string, unknown> | null
    evidence?: SubagentEvidence | Record<string, unknown> | null
    event?: NormalizedSubagentEvent | null
    events?: readonly NormalizedSubagentEvent[]
  } = {}
): Promise<SubagentWaveLifecycle | null> {
  const planFile = path.join(artifactDir, 'subagent-plan.json')
  const plan = input.plan || await readJson<any>(planFile, null)
  if (!plan || plan.schema !== 'sks.subagent-plan.v1') return null
  const workflowRunId = String(plan.workflow_run_id || '').trim()
  if (!workflowRunId) return null

  const existing = normalizeLifecycle(plan.wave_lifecycle, workflowRunId)
  const countPolicy = existing?.count_policy || subagentCountPolicy(plan)
  const planRequestedSubagents = normalizeCount(plan.requested_subagents)
  const requestedTargetSubagents = countPolicy === 'exact' && existing
    ? normalizeCount(existing.requested_target_subagents) || planRequestedSubagents
    : planRequestedSubagents
  const events = (input.events || await readSubagentEvents(artifactDir))
    .filter((event) => event.run_id === workflowRunId)
  const startedCount = uniqueThreadIds(events.filter((event) => event.event_name === 'SubagentStart')).length
  const targetSubagents = countPolicy === 'exact' && existing
    ? requestedTargetSubagents
    : Math.min(
        automaticSubagentTargetCap(plan),
        Math.max(requestedTargetSubagents, normalizeCount(existing?.target_subagents), startedCount)
      )
  const waveCapacity = positiveCount(plan.first_wave)
    || positiveCount((plan.capacity_controller as Record<string, unknown> | undefined)?.selected_capacity)
    || positiveCount(existing?.wave_capacity)
    || positiveCount(plan.max_threads)
    || targetSubagents
  const next = projectLifecycle(existing || createSubagentWaveLifecycle({
    workflowRunId,
    targetSubagents,
    countPolicy,
    waveCapacity
  }), {
    workflowRunId,
    requestedTargetSubagents,
    targetSubagents,
    countPolicy,
    events,
    evidence: input.evidence || null,
    waveCapacity,
    lastEvent: input.event?.event_name || null,
    targetChangeRejected: existing?.target_change_rejected === true || (
      countPolicy === 'exact'
        && Boolean(existing)
        && (planRequestedSubagents !== requestedTargetSubagents
          || normalizeCount(existing?.target_subagents) !== requestedTargetSubagents)
    )
  })
  await writeJsonAtomic(planFile, { ...plan, wave_lifecycle: next })
  return next
}

function projectLifecycle(
  previous: SubagentWaveLifecycle,
  input: {
    workflowRunId: string
    requestedTargetSubagents: number
    targetSubagents: number
    countPolicy: SubagentCountPolicy
    events: NormalizedSubagentEvent[]
    evidence: SubagentEvidence | Record<string, unknown> | null
    waveCapacity: number
    lastEvent: 'SubagentStart' | 'SubagentStop' | null
    targetChangeRejected: boolean
  }
): SubagentWaveLifecycle {
  const starts = uniqueThreadIds(input.events.filter((event) => event.event_name === 'SubagentStart'))
  const stops = new Set<string>()
  const waves = previous.waves.map((wave) => ({ ...wave, thread_ids: [...wave.thread_ids], settled_thread_ids: [...wave.settled_thread_ids] }))
  const assigned = new Set(waves.flatMap((wave) => wave.thread_ids))

  for (const event of input.events) {
    const threadId = event.thread_id
    if (!threadId) continue
    if (event.event_name === 'SubagentStop') {
      stops.add(threadId)
      const wave = waves.find((row) => row.thread_ids.includes(threadId))
      if (wave && wave.thread_ids.every((id) => stops.has(id))) wave.status = 'settled'
      continue
    }
    if (!assigned.has(threadId)) {
      let wave = waves.at(-1)
      const waveSettled = Boolean(wave?.thread_ids.length && wave.thread_ids.every((id) => stops.has(id)))
      if (!wave || wave.status === 'settled' || waveSettled) {
        wave = {
          wave: (wave?.wave || 0) + 1,
          status: 'running',
          thread_ids: [],
          settled_thread_ids: [],
          started_at: event.occurred_at || nowIso(),
          settled_at: null
        }
        waves.push(wave)
      }
      wave.thread_ids.push(threadId)
      assigned.add(threadId)
    }
  }

  for (const wave of waves) {
    wave.settled_thread_ids = wave.thread_ids.filter((threadId) => stops.has(threadId))
    const settled = wave.thread_ids.length > 0 && wave.settled_thread_ids.length === wave.thread_ids.length
    wave.status = settled ? 'settled' : 'running'
    wave.settled_at = settled
      ? latestEventTime(input.events, 'SubagentStop', wave.settled_thread_ids) || wave.settled_at || nowIso()
      : null
  }

  const latestStopOutcomes = new Map<string, NormalizedSubagentEvent['outcome']>()
  for (const event of input.events) {
    if (event.event_name === 'SubagentStop' && event.thread_id) {
      latestStopOutcomes.set(event.thread_id, event.outcome)
    }
  }
  const failed = new Set([...latestStopOutcomes]
    .filter(([, outcome]) => outcome === 'failed')
    .map(([threadId]) => threadId))
  const cumulativeSettled = [...stops].filter((threadId) => starts.includes(threadId)).length
  const completed = Math.max(0, cumulativeSettled - failed.size)
  const openThreads = Math.max(0, starts.length - cumulativeSettled)
  const peakOpenThreads = maxConcurrentOpenThreads(input.events)
  const remainingToStart = Math.max(0, input.targetSubagents - starts.length)
  const lastWave = waves.at(-1)
  const postWaveRescanRequired = Boolean(
    lastWave?.status === 'settled'
      && openThreads === 0
      && remainingToStart > 0
  )
  const recoveredCapacity = Math.min(
    cumulativeSettled,
    Math.max(0, input.waveCapacity - openThreads)
  )
  const parentGuidance = buildWaveParentGuidance({
    remaining_to_start: remainingToStart,
    open_threads: openThreads,
    wave_capacity: input.waveCapacity,
    recovered_capacity: recoveredCapacity,
    post_wave_rescan_required: postWaveRescanRequired,
    current_wave: lastWave?.wave || 0,
    completed_waves: waves.filter((wave) => wave.status === 'settled').length
  })

  return {
    ...previous,
    workflow_run_id: input.workflowRunId,
    count_policy: input.countPolicy,
    requested_target_subagents: input.requestedTargetSubagents,
    target_subagents: input.targetSubagents,
    target_change_rejected: input.targetChangeRejected || previous.target_change_rejected === true,
    current_wave: lastWave?.wave || 0,
    completed_waves: waves.filter((wave) => wave.status === 'settled').length,
    cumulative_started: starts.length,
    cumulative_completed: completed,
    cumulative_failed: failed.size,
    cumulative_settled: cumulativeSettled,
    peak_open_threads: peakOpenThreads,
    open_threads: openThreads,
    remaining_to_start: remainingToStart,
    post_wave_rescan_required: postWaveRescanRequired,
    wave_capacity: input.waveCapacity,
    recovered_capacity: recoveredCapacity,
    next_parent_actions: parentGuidance.actions,
    parent_guidance: parentGuidance,
    waves,
    last_event: input.lastEvent,
    updated_at: nowIso()
  }
}

function normalizeLifecycle(value: unknown, workflowRunId: string): SubagentWaveLifecycle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Partial<SubagentWaveLifecycle>
  if (row.schema !== SUBAGENT_WAVE_LIFECYCLE_SCHEMA || row.workflow_run_id !== workflowRunId) return null
  return row as SubagentWaveLifecycle
}

function uniqueThreadIds(events: NormalizedSubagentEvent[]): string[] {
  return [...new Set(events.map((event) => event.thread_id || '').filter(Boolean))]
}

function maxConcurrentOpenThreads(events: readonly NormalizedSubagentEvent[]): number {
  const started = new Set<string>()
  const open = new Set<string>()
  let peak = 0
  for (const event of events) {
    const threadId = event.thread_id
    if (!threadId) continue
    if (event.event_name === 'SubagentStart') {
      if (started.has(threadId)) continue
      started.add(threadId)
      open.add(threadId)
      peak = Math.max(peak, open.size)
      continue
    }
    if (started.has(threadId)) open.delete(threadId)
  }
  return peak
}

function latestEventTime(
  events: NormalizedSubagentEvent[],
  name: NormalizedSubagentEvent['event_name'],
  threadIds: string[]
) {
  const allowed = new Set(threadIds)
  return events
    .filter((event) => event.event_name === name && Boolean(event.thread_id && allowed.has(event.thread_id)))
    .map((event) => event.occurred_at)
    .sort()
    .at(-1) || null
}

function normalizeCount(value: unknown): number {
  return Math.max(0, Math.floor(Number(value) || 0))
}

function positiveCount(value: unknown): number {
  const count = normalizeCount(value)
  return count > 0 ? count : 0
}
