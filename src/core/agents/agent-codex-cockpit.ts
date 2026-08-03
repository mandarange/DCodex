import path from 'node:path'
import { appendJsonl, exists, nowIso, readJson, readText, writeJsonAtomic } from '../fsx.js'
import { normalizeAgentSessionRows } from './agent-session-rows.js'

export const AGENT_LIVE_SUMMARY_JSON = 'agent-live-summary.json'
export const AGENT_CODEX_COCKPIT_EVENTS = 'agent-codex-cockpit-events.jsonl'

export type CodexCockpitHookPayload = {
  hook_event_name: 'NativeSessionStart' | 'NativeSessionStop' | 'SubagentStart' | 'SubagentStop'
  agent_id?: string
  agent_type?: string
  session_id?: string
  transcript_path?: string | null
  agent_transcript_path?: string | null
  slot_id?: string | null
  generation_index?: number | null
  persona_id?: string | null
  last_assistant_message?: string | null
  stop_hook_active?: boolean
  turn_id?: string
  cwd?: string
  model?: string
  permission_mode?: string
}

export interface AgentCodexCockpitState {
  schema: 'sks.agent-codex-cockpit.v1'
  generated_at: string
  mission_id: string | null
  project_hash: string | null
  backend: string | null
  agent_count: number
  concurrency: number | null
  all_sessions_closed: boolean | null
  janitor_ok: boolean | null
  proof_status: string | null
  source_intelligence_status: string | null
  super_search_status: string | null
  codex_web_search_status: string | null
  goal_mode_status: string | null
  terminal_session_status: string | null
  target_active_slots: number | null
  active_slot_count: number | null
  pending_queue_count: number | null
  backfill_count: number | null
  scheduler_status: string | null
  patch_handoff_phase: string | null
  patch_queue_depth: number | null
  patch_apply_groups: Array<Record<string, unknown>>
  patch_changed_files_by_agent: Record<string, unknown>
  patch_verification_status: Array<Record<string, unknown>>
  patch_rollback_status: Array<Record<string, unknown>>
  patch_micro_win_links: Array<Record<string, unknown>>
  worker_slots: Array<Record<string, unknown>>
  session_generations: Array<Record<string, unknown>>
  blockers: string[]
  agents: Array<Record<string, unknown>>
  recent_events: string[]
  artifacts: Record<string, string>
}

export async function appendAgentCodexCockpitHookEvent(
  missionDir: string,
  payload: CodexCockpitHookPayload
): Promise<void> {
  await appendJsonl(path.join(agentRoot(missionDir), AGENT_CODEX_COCKPIT_EVENTS), {
    schema: 'sks.agent-codex-cockpit-event.v1',
    ts: nowIso(),
    ...payload,
  })
}

export async function writeAgentCodexCockpitArtifacts(
  missionDir: string,
  opts: { missionId?: string | null; projectHash?: string | null } = {}
): Promise<{ ok: boolean; issues: string[]; state: AgentCodexCockpitState }> {
  const state = await buildAgentCodexCockpitState(missionDir, opts)
  const root = agentRoot(missionDir)
  await writeJsonAtomic(path.join(root, AGENT_LIVE_SUMMARY_JSON), summarizeLiveState(state))
  return { ok: state.blockers.length === 0, issues: state.blockers, state }
}

export async function buildAgentCodexCockpitState(
  missionDir: string,
  opts: { missionId?: string | null; projectHash?: string | null } = {}
): Promise<AgentCodexCockpitState> {
  const root = agentRoot(missionDir)
  const sessions = await readJson<any>(path.join(root, 'agent-sessions.json'), null)
  const roster = await readJson<any>(path.join(root, 'agent-roster.json'), null)
  const leases = await readJson<any>(path.join(root, 'agent-leases.json'), null)
  const proof = await readJson<any>(path.join(root, 'agent-proof-evidence.json'), null)
  const consensus = await readJson<any>(path.join(root, 'agent-consensus.json'), null)
  const cleanup = await readJson<any>(path.join(root, 'agent-cleanup.json'), null)
  const janitor = await readJson<any>(path.join(root, 'agent-janitor-report.json'), null)
  const namespace = await readJson<any>(path.join(missionDir, 'project-session-namespace.json'), null)
  const sourceIntelligence = await readJson<any>(path.join(missionDir, 'source-intelligence-evidence.json'), null)
  const goalMode = await readJson<any>(path.join(missionDir, 'goal-mode-applied.json'), null)
  const scheduler = await readJson<any>(path.join(root, 'agent-scheduler-state.json'), null)
  const workerSlots = await readJson<any>(path.join(root, 'agent-worker-slots.json'), null)
  const generations = await readJson<any>(path.join(root, 'agent-session-generations.json'), null)
  const patchHandoff = await readJson<any>(path.join(root, 'agent-patch-handoff-runtime.json'), null)
  const patchQueue = await readJson<any>(path.join(root, 'agent-patch-queue.json'), null)
  const patchMerge = await readJson<any>(path.join(root, 'agent-merge-coordinator-report.json'), null)
  const patchVerification = await readJson<any>(path.join(root, 'agent-patch-verification-results.json'), null)
  const patchRollback = await readJson<any>(path.join(root, 'agent-patch-rollback-proof.json'), null)
  const patchProof = await readJson<any>(path.join(root, 'agent-patch-proof.json'), null)
  const terminalClosed = proof?.terminal_sessions_closed === true
  const eventsTail = await readTailLines(path.join(root, 'agent-events.jsonl'), 8)
  const cockpitEventsTail = await readTailLines(path.join(root, AGENT_CODEX_COCKPIT_EVENTS), 8)
  const subagentTail = await readTailLines(path.join(missionDir, 'subagent-events.jsonl'), 8)
  const sessionRows = normalizeAgentSessionRows(sessions)
  const rosterRows = Array.isArray(roster?.roster) ? roster.roster : []
  const leaseRows = Array.isArray(leases?.leases) ? leases.leases : []
  const agents = mergeAgentRows(sessionRows, rosterRows, leaseRows, [...eventsTail, ...cockpitEventsTail])
  const blockers = [
    ...(Array.isArray(proof?.blockers) ? proof.blockers : []),
    ...(!sessions ? ['agent_sessions_missing'] : []),
    ...(proof && proof.ok === false ? ['agent_proof_not_ok'] : []),
    ...(janitor && janitor.ok === false ? ['agent_janitor_not_ok'] : []),
  ].map(String)
  return {
    schema: 'sks.agent-codex-cockpit.v1',
    generated_at: nowIso(),
    mission_id: opts.missionId || namespace?.mission_id || proof?.mission_id || null,
    project_hash: opts.projectHash || namespace?.root_hash || null,
    backend: proof?.backend || null,
    agent_count: Number(proof?.agent_count || roster?.agent_count || agents.length || 0),
    concurrency: Number.isFinite(Number(roster?.concurrency)) ? Number(roster.concurrency) : null,
    all_sessions_closed: proof?.all_sessions_closed ?? cleanup?.all_sessions_closed ?? null,
    janitor_ok: janitor?.ok ?? null,
    proof_status: proof?.status || (proof?.ok ? 'passed' : proof ? 'blocked' : null),
    source_intelligence_status: sourceIntelligence?.ok === true ? sourceIntelligence.mode || 'ok' : sourceIntelligence ? 'blocked' : null,
    super_search_status: sourceIntelligence?.super_search?.proof?.ok === true ? 'verified' : sourceIntelligence?.super_search ? 'partial' : null,
    codex_web_search_status: sourceIntelligence?.codex_web_search?.status || sourceIntelligence?.policy?.codex_web_search?.status || null,
    goal_mode_status: goalMode?.mode || null,
    terminal_session_status: terminalClosed ? 'closed' : proof ? 'blocked_or_unverified' : null,
    target_active_slots: scheduler?.target_active_slots ?? null,
    active_slot_count: scheduler?.active_slot_count ?? null,
    pending_queue_count: scheduler?.pending_count ?? null,
    backfill_count: scheduler?.backfill_count ?? null,
    scheduler_status: scheduler?.status || null,
    patch_handoff_phase: patchHandoff ? (patchHandoff.ok === true ? 'passed' : 'blocked') : null,
    patch_queue_depth: patchQueue?.queued_count ?? null,
    patch_apply_groups: Array.isArray(patchMerge?.parallel_apply_groups) ? patchMerge.parallel_apply_groups : [],
    patch_changed_files_by_agent: patchProof?.changed_files_by_agent || {},
    patch_verification_status: Array.isArray(patchVerification?.results) ? patchVerification.results : [],
    patch_rollback_status: Array.isArray(patchRollback?.entries) ? patchRollback.entries : [],
    patch_micro_win_links: buildPatchMicroWinLinks(patchQueue),
    worker_slots: Array.isArray(workerSlots?.slots) ? workerSlots.slots : [],
    session_generations: generations?.generations ? Object.values(generations.generations) : [],
    blockers,
    agents,
    recent_events: [...eventsTail, ...cockpitEventsTail, ...subagentTail].slice(-12),
    artifacts: {
      live_summary: path.join('agents', AGENT_LIVE_SUMMARY_JSON),
      event_stream: path.join('agents', AGENT_CODEX_COCKPIT_EVENTS),
    },
  }
}

function summarizeLiveState(state: AgentCodexCockpitState) {
  return {
    schema: 'sks.agent-live-summary.v1',
    generated_at: state.generated_at,
    mission_id: state.mission_id,
    project_hash: state.project_hash,
    backend: state.backend,
    agent_count: state.agent_count,
    concurrency: state.concurrency,
    active_agents: state.agents.filter((agent) => !['closed', 'done', 'completed'].includes(String(agent.status || ''))).length,
    target_active_slots: state.target_active_slots,
    active_slot_count: state.active_slot_count,
    pending_queue_count: state.pending_queue_count,
    backfill_count: state.backfill_count,
    scheduler_status: state.scheduler_status,
    patch_handoff_phase: state.patch_handoff_phase,
    patch_queue_depth: state.patch_queue_depth,
    patch_apply_groups: state.patch_apply_groups,
    patch_changed_files_by_agent: state.patch_changed_files_by_agent,
    patch_verification_status: state.patch_verification_status,
    patch_rollback_status: state.patch_rollback_status,
    patch_micro_win_links: state.patch_micro_win_links,
    worker_slot_count: state.worker_slots.length,
    session_generation_count: state.session_generations.length,
    proof_status: state.proof_status,
    source_intelligence_status: state.source_intelligence_status,
    super_search_status: state.super_search_status,
    codex_web_search_status: state.codex_web_search_status,
    goal_mode_status: state.goal_mode_status,
    terminal_session_status: state.terminal_session_status,
    blockers: state.blockers,
  }
}

function buildPatchMicroWinLinks(patchQueue: any): Array<Record<string, unknown>> {
  const entries = Array.isArray(patchQueue?.entries) ? patchQueue.entries : []
  return entries.map((entry: any) => ({
    patch_entry_id: entry.id,
    agent_id: entry.agent_id,
    micro_win_id: entry.envelope?.lease_proof?.micro_win_id || null,
    strategy_task_id: entry.envelope?.lease_proof?.strategy_task_id || null,
    write_paths: entry.write_paths || []
  }))
}

function mergeAgentRows(sessions: any[], roster: any[], leases: any[], events: string[]): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>()
  for (const row of roster) byId.set(String(row.id || row.agent_id), { ...row })
  for (const row of sessions) {
    const id = String(row.id || row.agent_id || row.session_id)
    byId.set(id, { ...(byId.get(id) || {}), ...row, id })
  }
  for (const row of leases) {
    const id = String(row.agent_id || row.id || '')
    if (!id) continue
    byId.set(id, { ...(byId.get(id) || {}), lease_id: row.lease_id || row.id, lease: row.scope || row.path || row.write_scope })
  }
  for (const [id, row] of byId) {
    row.id = row.id || id
    row.recent_event_tail = events.filter((line) => line.includes(id)).slice(-3)
    if (row.heartbeat_age_ms === undefined) {
      const heartbeat = Date.parse(String(row.heartbeat_at || row.last_heartbeat_at || row.updated_at || ''))
      if (Number.isFinite(heartbeat)) row.heartbeat_age_ms = Math.max(0, Date.now() - heartbeat)
    }
  }
  return [...byId.values()]
}

async function readTailLines(file: string, count: number): Promise<string[]> {
  if (!(await exists(file))) return []
  const text = await readText(file, '')
  return String(text).trim().split(/\n+/).filter(Boolean).slice(-count)
}

function agentRoot(missionDir: string): string {
  return path.join(missionDir, 'agents')
}
