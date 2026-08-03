import fsp from 'node:fs/promises'
import path from 'node:path'
import { exists, nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { normalizeAgentSessionRows } from './agent-session-rows.js'
import { resolveOwnedNamespacePath } from './agent-namespace-safety.js'

export interface AgentJanitorReport {
  schema: 'sks.agent-janitor-report.v1'
  generated_at: string
  ok: boolean
  mission_id: string | null
  project_hash: string | null
  stale_heartbeat_sessions: string[]
  zombie_process_sessions: string[]
  active_generation_sessions: string[]
  active_generation_count: number
  cleaned_generation_count: number
  orphan_generation_dirs: string[]
  slot_generation_cleanup: string[]
  orphan_temp_dirs: string[]
  stale_locks: string[]
  cleaned: string[]
  blockers: string[]
}

export async function runAgentJanitor(input: {
  missionDir: string
  missionId?: string | null
  projectHash?: string | null
  staleMs?: number
  cleanup?: boolean
}): Promise<AgentJanitorReport> {
  const staleMs = input.staleMs ?? 30 * 60 * 1000
  const agentRoot = path.join(input.missionDir, 'agents')
  const sessions = await readJson<any>(path.join(agentRoot, 'agent-sessions.json'), null)
  const namespace = await readJson<any>(path.join(input.missionDir, 'project-session-namespace.json'), null)
  const projectHash = input.projectHash || namespace?.root_hash || null
  const rows = normalizeAgentSessionRows(sessions)
  const generations = await readJson<any>(path.join(agentRoot, 'agent-session-generations.json'), null)
  const generationRows = generations?.generations ? Object.values<any>(generations.generations) : []
  const activeGenerationSessions = generationRows
    .filter((row) => !row.closed_at && ['running', 'launching', 'collecting'].includes(String(row.status || 'running')))
    .map((row) => String(row.session_id))
  const now = Date.now()
  const staleHeartbeat: string[] = rows
    .filter((row: any) => {
      const status = String(row.status || row.lifecycle_state || '')
      if (['closed', 'completed', 'done'].includes(status)) return false
      const heartbeat = Date.parse(String(row.heartbeat_at || row.last_heartbeat_at || row.updated_at || ''))
      return !Number.isFinite(heartbeat) || now - heartbeat > staleMs
    })
    .map((row: any) => String(row.session_id || row.id || row.agent_id))
  const statusByAgent = new Map<string, string>()
  const statusBySession = new Map<string, string>()
  for (const row of rows) {
    const status = String(row.status || row.lifecycle_state || '')
    if (row.agent_id || row.id) statusByAgent.set(String(row.agent_id || row.id), status)
    if (row.session_id) statusBySession.set(String(row.session_id), status)
  }
  const zombieProcesses = await detectZombieProcessSessions(agentRoot, statusByAgent, statusBySession)
  const orphanGenerationDirs = await detectOrphanGenerationDirs(agentRoot, new Set(generationRows.map((row) => String(row.artifact_dir || ''))))
  const orphanTempDirs = await scopedExistingPaths(
    Array.isArray(namespace?.orphan_temp_dirs) ? namespace.orphan_temp_dirs : [],
    projectHash,
    namespace?.temp_dir ? [namespace.temp_dir] : []
  )
  const staleLocks = await scopedStaleLockPaths(namespace?.lock_dir ? [namespace.lock_dir] : [], projectHash, staleMs)
  const cleaned: string[] = []
  if (input.cleanup) {
    for (const dir of orphanGenerationDirs) {
      await fsp.rm(path.join(agentRoot, dir), { recursive: true, force: true }).catch(() => {})
      cleaned.push(path.join(agentRoot, dir))
    }
    for (const dir of orphanTempDirs) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
      cleaned.push(dir)
    }
  }
  const blockers = [
    ...staleHeartbeat.map((id) => `stale_heartbeat:${id}`),
    ...zombieProcesses.map((id) => `zombie_process:${id}`),
    ...staleLocks.map((id) => `stale_lock:${id}`),
  ]
  const report: AgentJanitorReport = {
    schema: 'sks.agent-janitor-report.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    mission_id: input.missionId || namespace?.mission_id || null,
    project_hash: projectHash,
    stale_heartbeat_sessions: staleHeartbeat,
    zombie_process_sessions: zombieProcesses,
    active_generation_sessions: activeGenerationSessions,
    active_generation_count: activeGenerationSessions.length,
    cleaned_generation_count: cleaned.filter((entry) => entry.includes(`${path.sep}sessions${path.sep}`)).length,
    orphan_generation_dirs: orphanGenerationDirs,
    slot_generation_cleanup: cleaned.filter((entry) => entry.includes(`${path.sep}sessions${path.sep}`)),
    orphan_temp_dirs: orphanTempDirs,
    stale_locks: staleLocks,
    cleaned,
    blockers,
  }
  await writeAgentJanitorReport(input.missionDir, report)
  return report
}

async function detectOrphanGenerationDirs(agentRoot: string, knownGenerationDirs: Set<string>): Promise<string[]> {
  const sessionsDir = path.join(agentRoot, 'sessions')
  const out: string[] = []
  if (!(await exists(sessionsDir))) return out
  for (const slot of await fsp.readdir(sessionsDir, { withFileTypes: true }).catch(() => [])) {
    if (!slot.isDirectory()) continue
    const slotDir = path.join(sessionsDir, slot.name)
    for (const gen of await fsp.readdir(slotDir, { withFileTypes: true }).catch(() => [])) {
      if (!gen.isDirectory() || !/^gen-\d+$/.test(gen.name)) continue
      const rel = path.join('sessions', slot.name, gen.name)
      if (!knownGenerationDirs.has(rel)) out.push(rel)
    }
  }
  return out
}

export async function writeAgentJanitorReport(missionDir: string, report: AgentJanitorReport): Promise<void> {
  await writeJsonAtomic(path.join(missionDir, 'agents', 'agent-janitor-report.json'), report)
}

async function scopedExistingPaths(paths: string[], projectHash: string | null, anchors: string[] = []): Promise<string[]> {
  const out: string[] = []
  for (const candidate of paths) {
    const owned = await resolveOwnedNamespacePath(candidate, String(projectHash || ''), anchors)
    if (owned) out.push(owned)
  }
  return out
}

async function scopedStaleLockPaths(paths: string[], projectHash: string | null, staleMs: number): Promise<string[]> {
  const out: string[] = []
  const now = Date.now()
  for (const dir of paths) {
    const ownedDir = await resolveOwnedNamespacePath(dir, String(projectHash || ''))
    if (!ownedDir) continue
    for (const file of await listFiles(ownedDir)) {
      const stat = await fsp.stat(file).catch(() => null)
      if (stat && now - stat.mtimeMs > staleMs) out.push(file)
    }
  }
  return out
}

async function detectZombieProcessSessions(agentRoot: string, statusByAgent: Map<string, string>, statusBySession: Map<string, string>): Promise<string[]> {
  const out: string[] = []
  for (const file of await listNamedFiles(path.join(agentRoot, 'sessions'), 'agent-process-report.json')) {
    const report = await readJson<any>(file, null)
    const pid = Number(report?.pid || 0)
    if (!pid || report?.exit_code !== null) continue
    const id = String(report?.session_id || report?.agent_id || path.basename(path.dirname(file)))
    const status = statusBySession.get(String(report?.session_id || '')) || statusByAgent.get(String(report?.agent_id || '')) || ''
    const alive = processIsAlive(pid)
    if ((!alive && !['closed', 'completed', 'done'].includes(status)) || (alive && ['closed', 'completed', 'done'].includes(status))) out.push(id)
  }
  return out
}

async function listNamedFiles(dir: string, name: string): Promise<string[]> {
  return (await listFiles(dir)).filter((file) => path.basename(file) === name)
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  if (!(await exists(dir))) return out
  let entries: Array<import('node:fs').Dirent>
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return out
    throw error
  }
  for (const entry of entries) {
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
