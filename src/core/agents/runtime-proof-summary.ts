import path from 'node:path'
import { findLatestMission, missionDir } from '../mission.js'
import { readJson, writeJsonAtomic } from '../fsx.js'
import { readAgentMessageBus, type AgentMessageBusEntry } from './agent-message-bus.js'
import { readLoopGraphProof, summarizeLoopGraphProof } from '../loops/loop-observability.js'

export const RUNTIME_PROOF_SUMMARY_SCHEMA = 'sks.runtime-proof-summary.v1'

export interface RuntimeProofSummary {
  schema: typeof RUNTIME_PROOF_SUMMARY_SCHEMA
  ok: boolean
  mission_id: string
  generated_at: string
  parallel: {
    max_active_workers: number
    unique_worker_pids: number
    speedup_ratio: number
    proof_passed: boolean
  }
  model_calls: {
    max_observed: number
    unique_model_call_ids: number
  }
  scheduler: {
    largest_batch_size: number
    utilization: number
  }
  messages: {
    recent: AgentMessageBusEntry[]
    completed_count: number
    failed_count: number
    warning_count: number
    error_count: number
  }
  loops: {
    total: number
    running: number
    completed: number
    blocked: number
    speedup_ratio: number
    active_loop_ids: string[]
    blocked_loop_ids: string[]
  }
  terminal_proof: {
    accepted: boolean
    gate_file: string | null
    terminal_state: string | null
  }
  blockers: string[]
}

export async function buildRuntimeProofSummary(root: string, missionIdInput: string = 'latest', opts: { maxMessages?: number } = {}): Promise<RuntimeProofSummary> {
  const missionId = missionIdInput === 'latest' ? await findLatestMission(root) : missionIdInput
  if (!missionId) throw new Error('runtime_proof_summary_mission_missing')
  const dir = missionDir(root, missionId)
  const agentsDir = path.join(dir, 'agents')
  const parallel = await readJson<any>(path.join(agentsDir, 'parallel-runtime-proof.json'), null)
  const scheduler = await readJson<any>(path.join(agentsDir, 'agent-scheduler-state.json'), null)
  const runtime = await readJson<any>(path.join(agentsDir, 'native-cli-worker-runtime.json'), null)
  const stopGate = await readJson<any>(path.join(dir, 'stop-gate.json'), null)
  const governor = await readJson<any>(path.join(agentsDir, 'naruto-concurrency-governor.json'), null)
  const messagesAll = await readAgentMessageBus(root, missionId, { max: 500 })
  const recentMessages = await readAgentMessageBus(root, missionId, { max: opts.maxMessages || 8 })
  const loopSummary = summarizeLoopGraphProof(await readLoopGraphProof(root, missionId).catch(() => null))
  const failedMessages = messagesAll.filter((row) => row.event_type === 'worker_failed')
  const errorMessages = messagesAll.filter((row) => row.level === 'error')
  const terminalProofAccepted = canonicalTerminalProofAccepted(stopGate, missionId)
  const parallelBlockers = parallel?.passed === false ? parallel.blockers || ['parallel_runtime_proof_failed'] : []
  const blockers = [
    ...(!parallel ? ['parallel_runtime_proof_missing'] : []),
    ...(!scheduler ? ['agent_scheduler_state_missing'] : []),
    ...(terminalProofAccepted ? parallelBlockers.filter((blocker: unknown) => String(blocker) !== 'speedup_ratio_below_target') : parallelBlockers),
    ...(errorMessages.length ? ['agent_message_bus_error_blockers'] : [])
  ].map(String)
  const summary: RuntimeProofSummary = {
    schema: RUNTIME_PROOF_SUMMARY_SCHEMA,
    ok: blockers.length === 0,
    mission_id: missionId,
    generated_at: new Date().toISOString(),
    parallel: {
      max_active_workers: Number(parallel?.max_observed_active_workers || scheduler?.max_observed_active_slots || 0),
      unique_worker_pids: Number(parallel?.unique_worker_pids || uniqueNumbers(runtime?.process_ids).length || 0),
      speedup_ratio: Number(parallel?.speedup_ratio || 0),
      proof_passed: parallel?.passed === true
    },
    model_calls: {
      max_observed: Number(parallel?.max_observed_model_calls || 0),
      unique_model_call_ids: Number(parallel?.unique_model_call_ids || 0)
    },
    scheduler: {
      largest_batch_size: Number(scheduler?.largest_batch_size || 0),
      utilization: Number(scheduler?.scheduler_utilization || 0)
    },
    messages: {
      recent: recentMessages,
      completed_count: messagesAll.filter((row) => row.event_type === 'worker_completed').length,
      failed_count: failedMessages.length,
      warning_count: messagesAll.filter((row) => row.level === 'warning').length,
      error_count: errorMessages.length
    },
    loops: loopSummary,
    terminal_proof: {
      accepted: terminalProofAccepted,
      gate_file: terminalProofAccepted ? 'stop-gate.json' : null,
      terminal_state: terminalProofAccepted ? String(stopGate?.terminal_state || 'completed') : null
    },
    blockers
  }
  await writeJsonAtomic(path.join(agentsDir, 'runtime-proof-summary.json'), summary)
  return summary
}

export function renderRuntimeProofSummary(summary: RuntimeProofSummary): string {
  return [
    `Parallel proof: ${summary.parallel.proof_passed ? 'passed' : summary.terminal_proof?.accepted ? 'terminal gate accepted' : 'blocked'}`,
    `Canonical terminal proof: ${summary.terminal_proof?.accepted ? 'accepted' : 'not available'}`,
    `Active workers: ${summary.parallel.max_active_workers}`,
    `Unique PIDs: ${summary.parallel.unique_worker_pids}`,
    `Speedup: ${summary.parallel.speedup_ratio}x`,
    `Model calls max: ${summary.model_calls.max_observed}`,
    `Loops: ${summary.loops.total} total / ${summary.loops.completed} done / ${summary.loops.blocked} blocked / ${summary.loops.speedup_ratio}x`,
    ...(summary.messages.recent.length ? [
      'Recent worker messages:',
      ...summary.messages.recent.map((row) => `  ${messageStatusLabel(row)} ${row.slot_id || row.worker_id}: ${row.message}`)
    ] : []),
    ...(summary.blockers.length ? [`Blockers: ${summary.blockers.join(', ')}`] : [])
  ].join('\n')
}

function canonicalTerminalProofAccepted(gate: any, missionId: string) {
  const blockers = Array.isArray(gate?.blockers) ? gate.blockers : []
  return gate?.schema === 'sks.stop-gate.v1'
    && String(gate?.mission_id || '') === missionId
    && gate?.passed === true
    && gate?.terminal === true
    && String(gate?.terminal_state || '') === 'completed'
    && blockers.length === 0
}

function messageStatusLabel(row: AgentMessageBusEntry): string {
  if (row.event_type === 'worker_completed') return '[done]'
  if (row.event_type === 'worker_failed') return '[fail]'
  if (row.level === 'warning') return '[warn]'
  if (row.level === 'error') return '[err]'
  return '[info]'
}

function uniqueNumbers(values: unknown) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => Number(value)).filter((value) => Number.isFinite(value)))]
}
