import type { SubagentWaveLifecycle } from './wave-lifecycle.js'
import { HARD_NARUTO_MAX_THREADS } from './thread-budget.js'

export const WAVE_PARENT_GUIDANCE_SCHEMA = 'sks.subagent-wave-parent-guidance.v1'
const SUBAGENT_WAVE_LIFECYCLE_SCHEMA = 'sks.subagent-wave-lifecycle.v1'
const OFFICIAL_SUBAGENT_PLAN_SCHEMA = 'sks.subagent-plan.v1'
const OFFICIAL_SUBAGENT_WORKFLOW = 'official_codex_subagent'
const CLOSE_COMPLETED_THREADS_ACTION = 'close_completed_child_threads_after_collecting_results'
const REFRESH_LIFECYCLE_ACTION = 'refresh_wave_lifecycle_and_ready_dag'
const SPAWN_NEXT_WAVE_ACTION = 'spawn_next_direct_child_wave_upto'
const EMIT_PARENT_SUMMARY_ACTION = 'integrate_settled_child_results_and_emit_parent_summary'

export interface WaveParentGuidance {
  schema: typeof WAVE_PARENT_GUIDANCE_SCHEMA
  required: boolean
  actions: string[]
  remaining_to_start: number
  open_threads: number
  wave_capacity: number
  recovered_capacity: number
  post_wave_rescan_required: boolean
  current_wave: number
  completed_waves: number
}

export function buildWaveParentGuidance(
  lifecycle: Partial<SubagentWaveLifecycle> | null | undefined
): WaveParentGuidance {
  const remaining = boundedLifecycleCount(lifecycle?.remaining_to_start)
  const openThreads = boundedLifecycleCount(lifecycle?.open_threads)
  const recovered = boundedLifecycleCount(lifecycle?.recovered_capacity)
  const waveCapacity = boundedLifecycleCount(lifecycle?.wave_capacity) || recovered
  const rescan = lifecycle?.post_wave_rescan_required === true
  const actions: string[] = []

  if (openThreads > 0) {
    actions.push(CLOSE_COMPLETED_THREADS_ACTION)
  }
  if (rescan || remaining > 0) {
    actions.push(REFRESH_LIFECYCLE_ACTION)
    const nextWaveLimit = Math.min(remaining, waveCapacity)
    if (nextWaveLimit > 0) {
      actions.push(`${SPAWN_NEXT_WAVE_ACTION}:${nextWaveLimit}`)
    }
  }
  if (remaining === 0 && openThreads === 0 && !rescan) {
    actions.push(EMIT_PARENT_SUMMARY_ACTION)
  }

  return {
    schema: WAVE_PARENT_GUIDANCE_SCHEMA,
    required: actions.some((action) => action.startsWith('spawn_next_') || action.startsWith('close_')),
    actions: [...new Set(actions)],
    remaining_to_start: remaining,
    open_threads: openThreads,
    wave_capacity: waveCapacity,
    recovered_capacity: recovered,
    post_wave_rescan_required: rescan,
    current_wave: boundedLifecycleCount(lifecycle?.current_wave),
    completed_waves: boundedLifecycleCount(lifecycle?.completed_waves)
  }
}

export function buildBoundWaveParentGuidance(
  plan: unknown,
  binding: { missionId: unknown; workflowRunId: unknown }
): WaveParentGuidance | null {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return null
  const row = plan as Record<string, unknown>
  const missionId = String(binding.missionId || '').trim()
  const workflowRunId = String(binding.workflowRunId || '').trim()
  if (!missionId || !workflowRunId) return null
  if (row.schema !== OFFICIAL_SUBAGENT_PLAN_SCHEMA || row.workflow !== OFFICIAL_SUBAGENT_WORKFLOW) return null
  if (String(row.mission_id || '').trim() !== missionId) return null
  if (String(row.workflow_run_id || '').trim() !== workflowRunId) return null
  const lifecycle = row.wave_lifecycle
  if (!lifecycle || typeof lifecycle !== 'object' || Array.isArray(lifecycle)) return null
  const lifecycleRow = lifecycle as Record<string, unknown>
  if (lifecycleRow.schema !== SUBAGENT_WAVE_LIFECYCLE_SCHEMA) return null
  if (String(lifecycleRow.workflow_run_id || '').trim() !== workflowRunId) return null
  return buildWaveParentGuidance({
    remaining_to_start: boundedLifecycleCount(lifecycleRow.remaining_to_start),
    open_threads: boundedLifecycleCount(lifecycleRow.open_threads),
    wave_capacity: boundedLifecycleCount(
      lifecycleRow.wave_capacity
        ?? row.first_wave
        ?? (row.capacity_controller as Record<string, unknown> | undefined)?.selected_capacity
    ),
    recovered_capacity: boundedLifecycleCount(lifecycleRow.recovered_capacity),
    post_wave_rescan_required: lifecycleRow.post_wave_rescan_required === true,
    current_wave: boundedLifecycleCount(lifecycleRow.current_wave),
    completed_waves: boundedLifecycleCount(lifecycleRow.completed_waves)
  })
}

export function renderWaveParentGuidance(guidance: WaveParentGuidance): string {
  if (!guidance.required && guidance.actions.length === 0) return ''
  return [
    'SKS Naruto wave lifecycle (root parent only):',
    `- current_wave=${guidance.current_wave}; completed_waves=${guidance.completed_waves}`,
    `- open_threads=${guidance.open_threads}; remaining_to_start=${guidance.remaining_to_start}; wave_capacity=${guidance.wave_capacity}; recovered_capacity=${guidance.recovered_capacity}`,
    `- post_wave_rescan_required=${guidance.post_wave_rescan_required}`,
    ...guidance.actions.map((action) => `- action: ${action}`),
    '- max_depth=1: children must not spawn children; only this root may launch later direct-child waves',
    '- after collecting results, close completed child threads so recovered capacity can be reused'
  ].join('\n')
}

function boundedLifecycleCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.min(HARD_NARUTO_MAX_THREADS, Math.floor(value)))
}
