import fsp from 'node:fs/promises'
import path from 'node:path'
import { appendJsonl, exists, nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { normalizeAgentSessionRows } from './agent-session-rows.js'
import { isAgentTerminalSessionStatus, writeAgentCleanupReport } from './agent-cleanup.js'
import { processReportMatchesProjectNamespace, resolveOwnedNamespacePath, validProjectNamespaceHash } from './agent-namespace-safety.js'
import { appendAgentLedgerEvent } from './agent-central-ledger.js'
import { closeAgentSession } from './agent-lifecycle.js'
import { closeAgentSessionGeneration } from './agent-session-generation.js'
import { closeAgentTerminalSession } from './agent-terminal-session.js'

export const AGENT_CLEANUP_PROOF_SCHEMA = 'sks.agent-cleanup-proof.v2'
export const AGENT_CLEANUP_ACTION_LEDGER_SCHEMA = 'sks.agent-cleanup-action-ledger.v1'

export interface AgentCleanupExecutorOptions {
  missionDir: string
  missionId?: string | null
  action?: 'cleanup' | 'close'
  apply?: boolean
  dryRun?: boolean
  drain?: boolean
  staleMs?: number
  graceMs?: number
  killEscalation?: boolean
}

type CleanupActionKind = 'terminalize_stale_session' | 'terminate_process' | 'remove_temp_dir' | 'remove_lock' | 'skip_active_session' | 'skip_foreign_namespace' | 'archive_transcript_keep'

interface CleanupAction {
  kind: CleanupActionKind
  target: string
  status: 'planned' | 'applied' | 'skipped' | 'failed'
  reason: string
  error?: string
  process_tree?: ProcessTreeEntry[]
  before?: Record<string, unknown>
  after?: Record<string, unknown>
  signal_sequence?: string[]
  grace_ms?: number
  verified_exited?: boolean
  escalated_to_sigkill?: boolean
}

interface ProcessTreeEntry {
  pid: number
  ppid: number
  command: string
}

export async function runAgentCleanupExecutor(opts: AgentCleanupExecutorOptions) {
  const agentRoot = path.join(opts.missionDir, 'agents')
  const action = opts.action || 'cleanup'
  const apply = opts.apply === true && opts.dryRun !== true
  const namespace = await readJson<any>(path.join(opts.missionDir, 'project-session-namespace.json'), null)
  const sessionsRaw = await readJson<any>(path.join(agentRoot, 'agent-sessions.json'), { sessions: {} })
  const sessions = normalizeAgentSessionRows(sessionsRaw)
  const sessionById = new Map(sessions.map((row: any) => [String(row.session_id || row.id || row.agent_id || ''), row]))
  const activeSessionIds = new Set(
    sessions
      .filter((row: any) => !isAgentTerminalSessionStatus(row.status || row.lifecycle_state))
      .map((row: any) => String(row.session_id || row.id || row.agent_id || ''))
      .filter(Boolean)
  )
  const now = Date.now()
  const requestedStaleMs = Number(opts.staleMs ?? 30 * 60 * 1000)
  const staleMs = Number.isFinite(requestedStaleMs) ? Math.max(0, requestedStaleMs) : 30 * 60 * 1000
  const projectHash = String(namespace?.root_hash || '')
  const namespaceAuthorized = validProjectNamespaceHash(projectHash)
  const actions: CleanupAction[] = []
  const graceMs = opts.graceMs ?? Number(process.env.SKS_CLEANUP_GRACE_MS || 750)
  const killEscalation = opts.killEscalation !== false && process.env.SKS_CLEANUP_KILL_ESCALATION !== '0'
  const sessionFiles = await listFiles(path.join(agentRoot, 'sessions'))
  for (const session of sessions) {
    if (isAgentTerminalSessionStatus(session.status || session.lifecycle_state)) continue
    const staleAction = await reconcileStaleSession({
      agentRoot,
      session,
      sessionFiles,
      projectHash,
      namespaceAuthorized,
      missionId: opts.missionId || namespace?.mission_id || null,
      now,
      staleMs,
      apply
    })
    if (!staleAction) continue
    actions.push(staleAction)
    if (staleAction.kind === 'terminalize_stale_session' && (staleAction.status === 'planned' || staleAction.status === 'applied')) {
      activeSessionIds.delete(String(session.session_id || session.session_key || session.id || session.agent_id || ''))
    }
  }
  const processReports = sessionFiles.filter((file) => path.basename(file) === 'agent-process-report.json')
  for (const file of processReports) {
    const report = await readJson<any>(file, null)
    const pid = Number(report?.pid || 0)
    const sessionId = String(report?.session_id || '')
    const status = String(sessionById.get(sessionId)?.status || '')
    const terminal = isAgentTerminalSessionStatus(status)
    if (!pid || !processIsAlive(pid)) continue
    // A non-null exit code proves the recorded process already exited. If the
    // PID is alive now it has been reused and must never be killed.
    if (report?.exit_code !== null && report?.exit_code !== undefined) {
      actions.push({ kind: 'skip_foreign_namespace', target: String(pid), status: 'skipped', reason: 'recorded_process_already_exited_pid_reused' })
      continue
    }
    if (activeSessionIds.has(sessionId) && !terminal) {
      actions.push({ kind: 'skip_active_session', target: sessionId || String(pid), status: 'skipped', reason: 'session_active' })
      continue
    }
    if (!processReportMatchesProjectNamespace(report, projectHash)) {
      actions.push({ kind: 'skip_foreign_namespace', target: String(pid), status: 'skipped', reason: 'process_outside_project_namespace' })
      continue
    }
    actions.push(await terminateProcessTreeAction({
      pid,
      reason: terminal ? 'terminal_session_process_alive' : 'stale_session_process',
      apply,
      graceMs,
      killEscalation
    }))
  }
  for (const dir of Array.isArray(namespace?.orphan_temp_dirs) ? namespace.orphan_temp_dirs.map(String) : []) {
    const ownedDir = await resolveOwnedNamespacePath(dir, projectHash, namespace?.temp_dir ? [namespace.temp_dir] : [])
    if (!ownedDir) {
      actions.push({ kind: 'skip_foreign_namespace', target: dir, status: 'skipped', reason: 'path_outside_project_namespace' })
      continue
    }
    actions.push(await applyAction({
      kind: 'remove_temp_dir',
      target: ownedDir,
      reason: 'orphan_temp_dir',
      apply,
      before: async () => ({ exists: await exists(ownedDir) }),
      after: async () => ({ exists: await exists(ownedDir) }),
      run: async () => {
        await fsp.rm(ownedDir, { recursive: true, force: true })
        if (await exists(ownedDir)) throw new Error('temp_dir_still_exists_after_remove')
      }
    }))
  }
  for (const lock of await staleLockFiles(String(namespace?.lock_dir || ''), projectHash, now, staleMs)) {
    actions.push(await applyAction({
      kind: 'remove_lock',
      target: lock,
      reason: 'stale_lock_file',
      apply,
      before: async () => ({ exists: await exists(lock) }),
      after: async () => ({ exists: await exists(lock) }),
      run: async () => {
        await fsp.rm(lock, { force: true })
        if (await exists(lock)) throw new Error('lock_file_still_exists_after_remove')
      }
    }))
  }
  for (const transcript of sessionFiles.filter((file) => path.basename(file) === 'agent-terminal-session.json')) {
    actions.push({ kind: 'archive_transcript_keep', target: transcript, status: 'skipped', reason: 'terminal_transcripts_are_preserved' })
  }
  const sessionCleanup = await writeAgentCleanupReport(agentRoot)
  const proof = buildCleanupProof({
    generatedAt: nowIso(),
    missionId: opts.missionId || namespace?.mission_id || null,
    projectNamespace: projectHash || null,
    action,
    apply,
    dryRun: !apply,
    actions,
    activeSessionIds: [...activeSessionIds],
    sessionCleanup
  })
  await writeJsonAtomic(path.join(agentRoot, 'agent-cleanup-proof.json'), proof)
  await writeJsonAtomic(path.join(agentRoot, 'agent-command-cleanup.json'), {
    schema: 'sks.agent-command-cleanup.v2',
    ok: proof.ok,
    mission_id: proof.mission_id,
    action,
    cleanup_executor: 'agent-cleanup-proof.json',
    cleanup_action_ledger: 'agent-cleanup-action-ledger.jsonl',
    applied: apply,
    blockers: proof.blockers
  })
  for (const row of actions) {
    await appendJsonl(path.join(agentRoot, 'agent-cleanup-action-ledger.jsonl'), {
      schema: AGENT_CLEANUP_ACTION_LEDGER_SCHEMA,
      generated_at: proof.generated_at,
      action: row
    })
  }
  return proof
}

const STALE_SESSION_REASON = 'stale_nonterminal_session_without_live_process'
const SESSION_PROCESS_REPORT_NAMES = new Set(['agent-process-report.json', 'worker-process-report.json'])

async function reconcileStaleSession(input: {
  agentRoot: string
  session: any
  sessionFiles: string[]
  projectHash: string
  namespaceAuthorized: boolean
  missionId: string | null
  now: number
  staleMs: number
  apply: boolean
}): Promise<CleanupAction | null> {
  const initial = await assessStaleSession(input)
  if (!initial.stale) return null
  const sessionId = initial.session_id
  if (!sessionId || !initial.artifact_dir || !input.namespaceAuthorized) {
    return {
      kind: 'skip_foreign_namespace',
      target: sessionId || 'unknown-session',
      status: 'skipped',
      reason: !input.namespaceAuthorized ? 'stale_session_project_namespace_missing_or_invalid' : 'stale_session_artifact_path_invalid',
      before: initial.evidence
    }
  }
  if (initial.foreign_process_reports.length > 0) {
    return {
      kind: 'skip_foreign_namespace',
      target: sessionId,
      status: 'skipped',
      reason: 'stale_session_foreign_process_report',
      before: initial.evidence
    }
  }
  if (initial.live_pids.length > 0) {
    return {
      kind: 'skip_active_session',
      target: sessionId,
      status: 'skipped',
      reason: 'stale_session_live_process',
      before: initial.evidence
    }
  }
  if (!input.apply) {
    return {
      kind: 'terminalize_stale_session',
      target: sessionId,
      status: 'planned',
      reason: STALE_SESSION_REASON,
      before: initial.evidence,
      after: initial.evidence
    }
  }

  const latestSession = await readLatestSessionRecord(input.agentRoot, input.session, initial.artifact_dir)
  const latestFiles = await listFiles(path.join(input.agentRoot, 'sessions'))
  const latest = await assessStaleSession({ ...input, session: latestSession, sessionFiles: latestFiles })
  if (!latest.stale) {
    return {
      kind: 'skip_active_session',
      target: sessionId,
      status: 'skipped',
      reason: 'stale_session_activity_refreshed_before_apply',
      before: initial.evidence,
      after: latest.evidence
    }
  }
  if (latest.foreign_process_reports.length > 0) {
    return {
      kind: 'skip_foreign_namespace',
      target: sessionId,
      status: 'skipped',
      reason: 'stale_session_foreign_process_report',
      before: initial.evidence,
      after: latest.evidence
    }
  }
  if (latest.live_pids.length > 0) {
    return {
      kind: 'skip_active_session',
      target: sessionId,
      status: 'skipped',
      reason: 'stale_session_live_process',
      before: initial.evidence,
      after: latest.evidence
    }
  }
  try {
    const after = await terminalizeStaleSession(input.agentRoot, latestSession, latest, input.missionId)
    return {
      kind: 'terminalize_stale_session',
      target: sessionId,
      status: 'applied',
      reason: STALE_SESSION_REASON,
      before: initial.evidence,
      after
    }
  } catch (err: unknown) {
    return {
      kind: 'terminalize_stale_session',
      target: sessionId,
      status: 'failed',
      reason: STALE_SESSION_REASON,
      before: initial.evidence,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function assessStaleSession(input: {
  agentRoot: string
  session: any
  sessionFiles: string[]
  projectHash: string
  now: number
  staleMs: number
}) {
  const sessionId = String(input.session?.session_id || input.session?.session_key || input.session?.id || input.session?.agent_id || '')
  const artifact = resolveSessionArtifactDir(input.agentRoot, input.session)
  const activity = latestSessionActivity(input.session)
  const ageMs = activity ? Math.max(0, input.now - activity.timestamp) : null
  const stale = ageMs !== null && ageMs > input.staleMs
  const reportFiles = input.sessionFiles.filter((file) => SESSION_PROCESS_REPORT_NAMES.has(path.basename(file)))
  const reports: Array<{ file: string; row: any }> = []
  for (const file of reportFiles) {
    const row = await readJson<any>(file, null).catch(() => null)
    if (row && String(row.session_id || '') === sessionId) reports.push({ file, row })
  }
  const foreignProcessReports = reports
    .filter(({ row }) => !processReportMatchesProjectNamespace(row, input.projectHash))
    .map(({ file }) => path.relative(input.agentRoot, file))
  const pids = [...new Set([
    Number(input.session?.pid || input.session?.process_id || input.session?.worker_pid || 0),
    ...reports.flatMap(({ row }) => [Number(row?.pid || row?.process_id || row?.worker_pid || 0), ...(Array.isArray(row?.child_process_ids) ? row.child_process_ids.map(Number) : [])])
  ].filter((pid) => Number.isSafeInteger(pid) && pid > 0))]
  const livePids = pids.filter(processIsAlive)
  const evidence = {
    session_id: sessionId || null,
    observed_status: String(input.session?.status || input.session?.lifecycle_state || ''),
    last_activity_at: activity?.iso || null,
    last_activity_source: activity?.source || null,
    age_ms: ageMs,
    stale_ms: input.staleMs,
    stale,
    process_report_count: reports.length,
    process_reports: reports.map(({ file }) => path.relative(input.agentRoot, file)),
    observed_pids: pids,
    live_pids: livePids,
    foreign_process_reports: foreignProcessReports,
    artifact_dir: artifact?.relative || null,
    checked_at: new Date(input.now).toISOString()
  }
  return {
    stale,
    session_id: sessionId,
    artifact_dir: artifact,
    foreign_process_reports: foreignProcessReports,
    live_pids: livePids,
    evidence
  }
}

function latestSessionActivity(session: any) {
  const candidates = [
    ['heartbeat_at', session?.heartbeat_at],
    ['last_heartbeat_at', session?.last_heartbeat_at],
    ['updated_at', session?.updated_at],
    ['opened_at', session?.opened_at]
  ].map(([source, value]) => ({ source: String(source), iso: String(value || ''), timestamp: Date.parse(String(value || '')) }))
    .filter((row) => Number.isFinite(row.timestamp))
    .sort((a, b) => b.timestamp - a.timestamp)
  return candidates[0] || null
}

function resolveSessionArtifactDir(agentRoot: string, session: any) {
  const slotId = String(session?.slot_id || session?.worker_slot_id || '')
  const generationIndex = Number(session?.generation_index)
  const raw = String(session?.session_artifact_dir || (slotId && Number.isFinite(generationIndex) ? path.join('sessions', slotId, `gen-${generationIndex}`) : ''))
  if (!raw || path.isAbsolute(raw) || raw.split(/[\\/]+/).includes('..')) return null
  const resolved = path.resolve(agentRoot, raw)
  const relative = path.relative(path.resolve(agentRoot), resolved)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return { absolute: resolved, relative: relative.split(path.sep).join('/') }
}

async function readLatestSessionRecord(agentRoot: string, fallback: any, artifact: { absolute: string; relative: string }) {
  const sessionKey = String(fallback?.session_key || fallback?.session_id || fallback?.agent_id || 'session').replace(/[^A-Za-z0-9._-]+/g, '_')
  const shard = await readJson<any>(path.join(agentRoot, 'sessions', `${sessionKey}.json`), null).catch(() => null)
  if (shard) return shard
  const artifactRecord = await readJson<any>(path.join(artifact.absolute, 'agent-session-record.json'), null).catch(() => null)
  return artifactRecord || fallback
}

async function terminalizeStaleSession(
  agentRoot: string,
  session: any,
  assessment: Awaited<ReturnType<typeof assessStaleSession>>,
  missionId: string | null
) {
  const artifact = assessment.artifact_dir
  if (!artifact) throw new Error('stale_session_artifact_path_invalid')
  const sessionId = String(session.session_id || session.session_key || session.agent_id || '')
  if (!sessionId) throw new Error('stale_session_id_missing')
  const closedAt = nowIso()
  const evidencePath = path.join(artifact.relative, 'agent-stale-session-terminalization.json')
  const closeReportPath = path.join(artifact.relative, 'agent-terminal-close-report.json')
  const transactionId = `stale-${Date.now()}-${sessionId.slice(0, 80)}`
  const evidence = {
    schema: 'sks.agent-stale-session-terminalization.v1',
    transaction_id: transactionId,
    mission_id: missionId,
    session_id: sessionId,
    status: 'timed_out',
    generation_status: 'blocked',
    reason: STALE_SESSION_REASON,
    applied_at: closedAt,
    assessment: assessment.evidence
  }
  const sessionKey = String(session.session_key || sessionId).replace(/[^A-Za-z0-9._-]+/g, '_')
  const reasonedSession = {
    ...session,
    session_key: sessionKey,
    timed_out_at: closedAt,
    cleanup_terminalized_at: closedAt,
    terminal_reason: STALE_SESSION_REASON,
    terminalization_evidence: evidencePath
  }
  const agent = {
    ...reasonedSession,
    id: String(session.agent_id || session.id || sessionId),
    session_id: sessionId,
    session_generation_id: String(session.session_key || sessionId),
    session_artifact_dir: artifact.relative
  }
  await writeJsonAtomic(path.join(agentRoot, evidencePath), evidence)
  await writeJsonAtomic(path.join(agentRoot, 'sessions', `${sessionKey}.json`), { ...reasonedSession, schema: 'sks.agent-session-record.v1' })
  await writeJsonAtomic(path.join(artifact.absolute, 'agent-session-record.json'), { ...reasonedSession, schema: 'sks.agent-session-record.v1' })
  const closeReport = await closeAgentTerminalSession(agentRoot, agent, {
    exitCode: 124,
    status: 'timed_out',
    ...(session.slot_id ? { slotId: String(session.slot_id) } : {}),
    ...(Number.isFinite(Number(session.generation_index)) ? { generationIndex: Number(session.generation_index) } : {}),
    requireGeneration: Boolean(session.slot_id && Number.isFinite(Number(session.generation_index)))
  })
  const terminalPath = path.join(artifact.absolute, 'agent-terminal-session.json')
  const terminalRecord = await readJson<any>(terminalPath, null)
  await writeJsonAtomic(terminalPath, { ...terminalRecord, close_status: 'timed_out', close_reason: STALE_SESSION_REASON, terminalization_evidence: evidencePath })
  await writeJsonAtomic(path.join(agentRoot, closeReportPath), { ...closeReport, status: 'timed_out', reason: STALE_SESSION_REASON, terminalization_evidence: evidencePath })
  const generation = await closeAgentSessionGeneration(agentRoot, sessionId, { status: 'blocked', terminalCloseReportPath: closeReportPath })
  await appendAgentLedgerEvent(agentRoot, {
    agent_id: agent.id,
    session_id: sessionId,
    event_type: 'stale_session_terminalized',
    payload: evidence
  })
  // closeAgentSession atomically replaces the session shard and then the
  // canonical aggregate, so registry state is the final commit point.
  const canonical = await closeAgentSession(agentRoot, agent, 'timed_out')
  return {
    session_id: sessionId,
    status: canonical.status,
    generation_status: generation?.status || null,
    closed_at: canonical.closed_at,
    transaction_id: transactionId,
    canonical_registry: 'agent-sessions.json',
    session_record: path.join(artifact.relative, 'agent-session-record.json'),
    terminal_record: path.join(artifact.relative, 'agent-terminal-session.json'),
    terminal_close_report: closeReportPath,
    evidence: evidencePath
  }
}

function buildCleanupProof(input: {
  generatedAt: string
  missionId: string | null
  projectNamespace: string | null
  action: string
  apply: boolean
  dryRun: boolean
  actions: CleanupAction[]
  activeSessionIds: string[]
  sessionCleanup: Record<string, unknown>
}) {
  const byKind = (kind: CleanupActionKind, status?: CleanupAction['status']) => input.actions.filter((row) => row.kind === kind && (!status || row.status === status))
  const failed = input.actions.filter((row) => row.status === 'failed')
  return {
    schema: AGENT_CLEANUP_PROOF_SCHEMA,
    generated_at: input.generatedAt,
    ok: failed.length === 0,
    mission_id: input.missionId,
    project_namespace: input.projectNamespace,
    action: input.action,
    dry_run: input.dryRun,
    apply: input.apply,
    stale_processes_found: byKind('terminate_process').map((row) => row.target),
    stale_processes_killed: byKind('terminate_process', 'applied').map((row) => row.target),
    stale_sessions_found: byKind('terminalize_stale_session').map((row) => row.target),
    stale_sessions_terminalization_planned: byKind('terminalize_stale_session', 'planned').map((row) => row.target),
    stale_sessions_terminalized: byKind('terminalize_stale_session', 'applied').map((row) => row.target),
    stale_session_terminalization_failures: byKind('terminalize_stale_session', 'failed').map((row) => row.target),
    process_trees: byKind('terminate_process').map((row) => ({ target: row.target, tree: row.process_tree || [] })),
    process_tree_count: byKind('terminate_process').filter((row) => (row.process_tree || []).length > 0).length,
    sigterm_planned: input.actions.filter((row) => row.status === 'planned' && row.signal_sequence?.includes('SIGTERM')).map((row) => row.target),
    sigterm_sent: input.actions.filter((row) => row.status === 'applied' && row.signal_sequence?.includes('SIGTERM')).map((row) => row.target),
    sigkill_escalations: input.actions.filter((row) => row.escalated_to_sigkill === true).map((row) => row.target),
    process_exit_verified: input.actions.filter((row) => row.kind === 'terminate_process' && row.verified_exited === true).map((row) => row.target),
    sigterm_count: input.actions.filter((row) => row.signal_sequence?.includes('SIGTERM')).length,
    sigkill_count: input.actions.filter((row) => row.signal_sequence?.includes('SIGKILL')).length,
    verified_exited_count: input.actions.filter((row) => row.kind === 'terminate_process' && row.verified_exited === true).length,
    failed_to_kill_count: input.actions.filter((row) => row.kind === 'terminate_process' && row.status === 'failed').length,
    orphan_temp_dirs_found: byKind('remove_temp_dir').map((row) => row.target),
    orphan_temp_dirs_removed: byKind('remove_temp_dir', 'applied').map((row) => row.target),
    stale_locks_found: byKind('remove_lock').map((row) => row.target),
    stale_locks_removed: byKind('remove_lock', 'applied').map((row) => row.target),
    skipped_active_sessions: [...new Set([...input.activeSessionIds, ...byKind('skip_active_session').map((row) => row.target)])].filter(Boolean),
    skipped_foreign_namespace: byKind('skip_foreign_namespace').map((row) => row.target),
    terminal_transcripts_preserved: byKind('archive_transcript_keep').map((row) => row.target),
    session_cleanup: input.sessionCleanup,
    action_count: input.actions.length,
    applied_count: input.actions.filter((row) => row.status === 'applied').length,
    failed_count: failed.length,
    actions: input.actions,
    blockers: failed.map((row) => `cleanup_action_failed:${row.kind}:${row.target}`)
  }
}

async function terminateProcessTreeAction(input: { pid: number; reason: string; apply: boolean; graceMs: number; killEscalation: boolean }): Promise<CleanupAction> {
  const processTree = await readProcessTree(input.pid)
  const targets = processTree.length ? processTree.map((row) => row.pid) : [input.pid]
  if (!input.apply) {
    return {
      kind: 'terminate_process',
      target: String(input.pid),
      status: 'planned',
      reason: input.reason,
      process_tree: processTree,
      before: { alive: targets.filter(processIsAlive) },
      after: { alive: targets.filter(processIsAlive) },
      signal_sequence: input.killEscalation ? ['SIGTERM', 'SIGKILL_IF_STILL_ALIVE'] : ['SIGTERM'],
      grace_ms: input.graceMs,
      verified_exited: false,
      escalated_to_sigkill: false
    }
  }
  const signalSequence: string[] = []
  try {
    for (const pid of [...targets].reverse()) safeKill(pid, 'SIGTERM')
    signalSequence.push('SIGTERM')
    await waitForProcessesExited(targets, input.graceMs)
    let alive = targets.filter(processIsAlive)
    let escalated = false
    if (alive.length && input.killEscalation) {
      for (const pid of [...alive].reverse()) safeKill(pid, 'SIGKILL')
      signalSequence.push('SIGKILL')
      escalated = true
      await waitForProcessesExited(targets, 500)
      alive = targets.filter(processIsAlive)
    }
    return {
      kind: 'terminate_process',
      target: String(input.pid),
      status: alive.length ? 'failed' : 'applied',
      reason: input.reason,
      process_tree: processTree,
      before: { alive: targets },
      after: { alive },
      signal_sequence: signalSequence,
      grace_ms: input.graceMs,
      verified_exited: alive.length === 0,
      escalated_to_sigkill: escalated,
      ...(alive.length ? { error: `processes_still_alive:${alive.join(',')}` } : {})
    }
  } catch (err: unknown) {
    return {
      kind: 'terminate_process',
      target: String(input.pid),
      status: 'failed',
      reason: input.reason,
      process_tree: processTree,
      before: { alive: targets },
      after: { alive: targets.filter(processIsAlive) },
      signal_sequence: signalSequence,
      grace_ms: input.graceMs,
      verified_exited: false,
      escalated_to_sigkill: signalSequence.includes('SIGKILL'),
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

async function applyAction(input: { kind: CleanupActionKind; target: string; reason: string; apply: boolean; before?: () => Promise<Record<string, unknown>>; after?: () => Promise<Record<string, unknown>>; run: () => Promise<void> | void }): Promise<CleanupAction> {
  const before = input.before ? await input.before().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })) : undefined
  if (!input.apply) return { kind: input.kind, target: input.target, status: 'planned', reason: input.reason, ...(before ? { before, after: before } : {}) }
  try {
    await input.run()
    const after = input.after ? await input.after().catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })) : undefined
    return { kind: input.kind, target: input.target, status: 'applied', reason: input.reason, ...(before ? { before } : {}), ...(after ? { after } : {}) }
  } catch (err: unknown) {
    const after = input.after ? await input.after().catch((afterErr: unknown) => ({ error: afterErr instanceof Error ? afterErr.message : String(afterErr) })) : undefined
    return { kind: input.kind, target: input.target, status: 'failed', reason: input.reason, error: err instanceof Error ? err.message : String(err), ...(before ? { before } : {}), ...(after ? { after } : {}) }
  }
}

async function staleLockFiles(lockDir: string, projectHash: string, now: number, staleMs: number) {
  const out: string[] = []
  const ownedLockDir = await resolveOwnedNamespacePath(lockDir, projectHash)
  if (!ownedLockDir) return out
  for (const file of await listFiles(ownedLockDir)) {
    const stat = await fsp.stat(file).catch(() => null)
    if (stat && now - stat.mtimeMs > staleMs) out.push(file)
  }
  return out
}

async function listNamedFiles(dir: string, name: string): Promise<string[]> {
  return (await listFiles(dir)).filter((file) => path.basename(file) === name)
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  if (!(await exists(dir))) return out
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await listFiles(file))
    else if (entry.isFile()) out.push(file)
  }
  return out
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readProcessTree(rootPid: number): Promise<ProcessTreeEntry[]> {
  try {
    const { runProcess } = await import('../fsx.js')
    const result = await runProcess('ps', ['-axo', 'pid=,ppid=,command='], { timeoutMs: 3000, maxOutputBytes: 512 * 1024 })
    const rows = result.stdout.split(/\r?\n/).map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/)
      if (!match) return null
      return { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] || '' }
    }).filter(Boolean) as ProcessTreeEntry[]
    const byParent = new Map<number, ProcessTreeEntry[]>()
    const byPid = new Map<number, ProcessTreeEntry>()
    for (const row of rows) byParent.set(row.ppid, [...(byParent.get(row.ppid) || []), row])
    for (const row of rows) byPid.set(row.pid, row)
    const out: ProcessTreeEntry[] = []
    const visited = new Set<number>()
    const visit = (pid: number) => {
      if (visited.has(pid)) return
      visited.add(pid)
      const current = byPid.get(pid)
      if (current) out.push(current)
      for (const child of byParent.get(pid) || []) visit(child.pid)
    }
    visit(rootPid)
    return out
  } catch {
    return processIsAlive(rootPid) ? [{ pid: rootPid, ppid: 0, command: 'unknown' }] : []
  }
}

function safeKill(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal)
  } catch {}
}

async function waitForProcessesExited(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!pids.some(processIsAlive)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !pids.some(processIsAlive)
}
