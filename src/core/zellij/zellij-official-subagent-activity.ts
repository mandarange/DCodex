import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nowIso, sha256 } from '../fsx.js'
import {
  appendZellijSlotTelemetry,
  readZellijSlotTelemetrySnapshot,
  type ZellijSlotTelemetryEventType,
  type ZellijSlotTelemetrySnapshot
} from './zellij-slot-telemetry.js'

const DEFAULT_TAIL_BYTES = 256 * 1024
const DEFAULT_HEAD_BYTES = 1024 * 1024
const DEFAULT_REFRESH_MIN_MS = 2_000
const DEFAULT_HEARTBEAT_MS = 5_000
const MAX_DISCOVERY_DAY_DIRS = 45
// The current release baseline is 0.144.5, but this rollout format has been
// stable since 0.144.1 and remains readable for compatible older sessions.
const MIN_SUPPORTED_CODEX_ROLLOUT_VERSION = '0.144.1'
const rolloutPathCache = new Map<string, { checked_at_ms: number; file: string | null }>()

export interface OfficialSubagentRolloutActivity {
  thread_id: string
  rollout_path: string
  observed_at: string
  source_updated_at: string
  source_size: number
  activity_hash: string
  activity_kind: string
  event_type: ZellijSlotTelemetryEventType
  task_title: string
  current_file: string | null
  log_tail: string
  model: string | null
  reasoning_effort: string | null
}

export async function readOfficialSubagentRolloutActivity(input: {
  threadId: string
  startedAt?: string | null
  projectRoot?: string | null
  env?: NodeJS.ProcessEnv
  tailBytes?: number
}): Promise<OfficialSubagentRolloutActivity | null> {
  const threadId = safeThreadId(input.threadId)
  if (!threadId) return null
  const env = input.env || process.env
  const codexHome = path.resolve(String(env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')))
  const rolloutPath = await locateOfficialSubagentRollout(codexHome, threadId, input.startedAt)
  if (!rolloutPath) return null
  const identity = await readRolloutIdentity(rolloutPath)
  if (
    !identity
    || identity.thread_id !== threadId
    || identity.official_subagent !== true
    || !versionAtLeast(identity.cli_version, MIN_SUPPORTED_CODEX_ROLLOUT_VERSION)
  ) return null
  const tailBytes = boundedInt(input.tailBytes ?? env.SKS_ZELLIJ_OFFICIAL_ACTIVITY_TAIL_BYTES, DEFAULT_TAIL_BYTES, 64 * 1024, 1024 * 1024)
  const tail = await readRolloutTail(rolloutPath, tailBytes)
  if (!tail) return null
  const birthMs = Date.parse(identity.spawned_at)
  const startMs = Date.parse(String(input.startedAt || ''))
  const activityCutoffMs = Math.max(
    Number.isFinite(birthMs) ? birthMs : 0,
    Number.isFinite(startMs) ? startMs : 0
  )
  const rows = tail.rows.filter((row) => {
    const ts = Date.parse(String(row?.timestamp || ''))
    // Forked subagent rollouts contain a rewritten copy of the parent history.
    // Those copied rows share the child session_meta timestamp. Ignore that
    // fork snapshot and surface only events emitted by the child afterwards.
    return Number.isFinite(ts) && ts > activityCutoffMs
  })
  if (!rows.length) return null

  const summaries: ActivitySummary[] = []
  let model: string | null = null
  let reasoningEffort: string | null = null
  for (const row of rows) {
    if (row?.type === 'turn_context') {
      model = firstKnown(row?.payload?.model, model)
      reasoningEffort = firstKnown(row?.payload?.effort, row?.payload?.reasoning_effort, reasoningEffort)
    }
    const summary = summarizeRolloutRow(row, input.projectRoot || null)
    if (summary) summaries.push(summary)
  }
  // turn_context is emitted per turn; a long single turn can push every
  // turn_context row out of the tail window. Model and effort are stable for
  // the session, so fall back to the first child-emitted turn_context near the
  // rollout head. Rows copied from the parent history share the child
  // session_meta timestamp and are excluded by the same cutoff as activity.
  if (!model || !reasoningEffort) {
    const headBytes = boundedInt(env.SKS_ZELLIJ_OFFICIAL_ACTIVITY_HEAD_BYTES, DEFAULT_HEAD_BYTES, 64 * 1024, 8 * 1024 * 1024)
    const head = await readRolloutHeadTurnContext(rolloutPath, headBytes, activityCutoffMs)
    model = model || firstKnown(head?.model)
    reasoningEffort = reasoningEffort || firstKnown(head?.effort, head?.reasoning_effort)
  }
  const latest = summaries.at(-1)
  if (!latest) {
    const sourceUpdatedAt = new Date(tail.mtime_ms).toISOString()
    return {
      thread_id: threadId,
      rollout_path: rolloutPath,
      observed_at: nowIso(),
      source_updated_at: sourceUpdatedAt,
      source_size: tail.size,
      activity_hash: sha256(`${threadId}:${tail.size}:${sourceUpdatedAt}:heartbeat`).slice(0, 24),
      activity_kind: 'heartbeat',
      event_type: 'heartbeat',
      task_title: 'agent active',
      current_file: null,
      log_tail: 'Codex subagent is active; waiting for the next visible activity item.',
      model,
      reasoning_effort: reasoningEffort
    }
  }
  const visible = uniqueSummaries(summaries).slice(-4)
  const sourceUpdatedAt = latest.timestamp || new Date(tail.mtime_ms).toISOString()
  const activityHash = sha256(JSON.stringify({
    thread_id: threadId,
    source_size: tail.size,
    latest: latest.identity,
    source_updated_at: sourceUpdatedAt
  })).slice(0, 24)
  return {
    thread_id: threadId,
    rollout_path: rolloutPath,
    observed_at: nowIso(),
    source_updated_at: sourceUpdatedAt,
    source_size: tail.size,
    activity_hash: activityHash,
    activity_kind: latest.kind,
    event_type: latest.eventType,
    task_title: latest.title,
    current_file: latest.currentFile,
    log_tail: boundedText(visible.map((row) => row.line).join('\n'), 1200) || latest.line,
    model,
    reasoning_effort: reasoningEffort
  }
}

export async function refreshOfficialSubagentZellijActivity(input: {
  root: string
  missionId: string
  env?: NodeJS.ProcessEnv
}) {
  const snapshot = await readZellijSlotTelemetrySnapshot(input.root, input.missionId).catch(() => null)
  if (!snapshot) return { written: false, refreshed_threads: [], blockers: ['zellij_slot_snapshot_missing'] }
  const env = input.env || process.env
  const refreshMinMs = boundedInt(env.SKS_ZELLIJ_OFFICIAL_ACTIVITY_MIN_MS, DEFAULT_REFRESH_MIN_MS, 0, 60_000)
  const heartbeatMs = boundedInt(env.SKS_ZELLIJ_OFFICIAL_ACTIVITY_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 1_000, 60_000)
  const refreshed: string[] = []
  const blockers: string[] = []
  for (const slot of Object.values(snapshot.slots || {})) {
    if (slot.backend !== 'official-codex-subagent') continue
    if (!['running', 'launching'].includes(String(slot.status || '').toLowerCase())) continue
    const activity = await readOfficialSubagentRolloutActivity({
      threadId: slot.worker_id,
      startedAt: slot.started_at,
      projectRoot: input.root,
      env
    }).catch(() => null)
    if (!activity) continue
    const ageMs = Math.max(0, Date.now() - (Date.parse(slot.latest_ts) || 0))
    const sameActivity = slot.activity_hash === activity.activity_hash
    if (ageMs < refreshMinMs || (sameActivity && ageMs < heartbeatMs)) continue
    const eventType = sameActivity ? 'heartbeat' : activity.event_type
    const provider = knownOrUndefined(slot.provider)
    const serviceTier = knownOrUndefined(slot.service_tier)
    const model = knownOrUndefined(activity.model) || knownOrUndefined(slot.model)
    const reasoningEffort = knownOrUndefined(activity.reasoning_effort) || knownOrUndefined(slot.reasoning_effort)
    try {
      await appendZellijSlotTelemetry(input.root, {
        schema: 'sks.zellij-slot-telemetry-event.v1',
        ts: nowIso(),
        mission_id: input.missionId,
        slot_id: slot.slot_id,
        generation_index: slot.generation_index,
        worker_id: slot.worker_id,
        event_type: eventType,
        status: 'running',
        role: slot.role,
        backend: slot.backend,
        ...(provider ? { provider } : {}),
        ...(serviceTier ? { service_tier: serviceTier } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
        task_id: slot.worker_id,
        task_title: sameActivity ? slot.task_title : activity.task_title,
        current_file: sameActivity ? slot.current_file : activity.current_file,
        artifact_paths: slot.artifact_paths,
        log_tail: sameActivity ? slot.log_tail : activity.log_tail,
        blockers: slot.blockers,
        activity_source: 'codex_rollout',
        activity_hash: activity.activity_hash
      })
      refreshed.push(slot.worker_id)
    } catch (error: any) {
      blockers.push(`official_subagent_activity_write_failed:${slot.worker_id}:${String(error?.message || error)}`)
    }
  }
  return { written: refreshed.length > 0, refreshed_threads: refreshed, blockers }
}

async function locateOfficialSubagentRollout(codexHome: string, threadId: string, startedAt?: string | null): Promise<string | null> {
  const cacheKey = `${codexHome}\u0000${threadId}`
  const cached = rolloutPathCache.get(cacheKey)
  if (cached?.file && await isFile(cached.file)) return cached.file
  if (cached && !cached.file && Date.now() - cached.checked_at_ms < 2_000) return null
  const sessionsRoot = path.join(codexHome, 'sessions')
  const expectedNameSuffix = `-${threadId}.jsonl`
  for (const dir of candidateDateDirs(sessionsRoot, startedAt)) {
    const file = await findExactRolloutInDir(dir, expectedNameSuffix)
    if (file) {
      rolloutPathCache.set(cacheKey, { checked_at_ms: Date.now(), file })
      return file
    }
  }
  const fallback = await findRecentRollout(sessionsRoot, expectedNameSuffix)
  rolloutPathCache.set(cacheKey, { checked_at_ms: Date.now(), file: fallback })
  return fallback
}

function candidateDateDirs(sessionsRoot: string, startedAt?: string | null): string[] {
  const dates: Date[] = []
  const parsed = Date.parse(String(startedAt || ''))
  if (Number.isFinite(parsed)) dates.push(new Date(parsed))
  const now = new Date()
  for (let day = -2; day <= 1; day += 1) dates.push(new Date(now.getTime() + day * 24 * 60 * 60 * 1000))
  const out = new Set<string>()
  for (const date of dates) {
    out.add(path.join(sessionsRoot, String(date.getFullYear()).padStart(4, '0'), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')))
    out.add(path.join(sessionsRoot, String(date.getUTCFullYear()).padStart(4, '0'), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')))
  }
  return [...out]
}

async function findExactRolloutInDir(dir: string, expectedNameSuffix: string): Promise<string | null> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  const match = entries.find((entry) => entry.isFile() && entry.name.endsWith(expectedNameSuffix))
  return match ? path.join(dir, match.name) : null
}

async function findRecentRollout(sessionsRoot: string, expectedNameSuffix: string): Promise<string | null> {
  const years = await childDirsDescending(sessionsRoot)
  let checkedDays = 0
  for (const year of years) {
    for (const month of await childDirsDescending(year)) {
      for (const day of await childDirsDescending(month)) {
        const found = await findExactRolloutInDir(day, expectedNameSuffix)
        if (found) return found
        checkedDays += 1
        if (checkedDays >= MAX_DISCOVERY_DAY_DIRS) return null
      }
    }
  }
  return null
}

async function childDirsDescending(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .sort((left, right) => right.localeCompare(left))
}

async function readRolloutIdentity(file: string): Promise<{ thread_id: string; spawned_at: string; cli_version: string; official_subagent: boolean } | null> {
  const handle = await fsp.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const firstLine = await readFirstLine(handle, 1024 * 1024)
    if (!firstLine) return null
    const row = JSON.parse(firstLine)
    if (row?.type !== 'session_meta') return null
    const payload = objectValue(row.payload)
    const source = objectValue(payload.source)
    const subagent = objectValue(source.subagent)
    const threadSpawn = objectValue(subagent.thread_spawn)
    const officialSubagent = Object.keys(subagent).length > 0 && Object.keys(threadSpawn).length > 0
    return {
      thread_id: String(payload.id || payload.session_id || '').trim(),
      spawned_at: String(row.timestamp || payload.timestamp || ''),
      cli_version: String(payload.cli_version || ''),
      official_subagent: officialSubagent
    }
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

async function readFirstLine(handle: fsp.FileHandle, maxBytes: number): Promise<string> {
  const chunkBytes = 64 * 1024
  const parts: Buffer[] = []
  let total = 0
  while (total < maxBytes) {
    const length = Math.min(chunkBytes, maxBytes - total)
    const buffer = Buffer.alloc(length)
    const read = await handle.read(buffer, 0, length, total)
    if (read.bytesRead <= 0) break
    const part = buffer.subarray(0, read.bytesRead)
    const newline = part.indexOf(0x0A)
    if (newline >= 0) {
      parts.push(part.subarray(0, newline))
      break
    }
    parts.push(part)
    total += read.bytesRead
    if (read.bytesRead < length) break
  }
  return Buffer.concat(parts).toString('utf8').replace(/\r$/, '')
}

async function readRolloutTail(file: string, bytes: number): Promise<{ rows: any[]; size: number; mtime_ms: number } | null> {
  const handle = await fsp.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, bytes)
    const start = Math.max(0, stat.size - length)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    let text = buffer.toString('utf8')
    if (start > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : ''
    }
    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    return { rows, size: stat.size, mtime_ms: stat.mtimeMs }
  } finally {
    await handle.close().catch(() => undefined)
  }
}

interface ActivitySummary {
  timestamp: string
  identity: string
  kind: string
  eventType: ZellijSlotTelemetryEventType
  title: string
  line: string
  currentFile: string | null
}

async function readRolloutHeadTurnContext(
  file: string,
  maxBytes: number,
  activityCutoffMs: number
): Promise<{ model: string | null; effort: string | null; reasoning_effort: string | null } | null> {
  const handle = await fsp.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const stat = await handle.stat()
    const length = Math.min(stat.size, Math.max(64 * 1024, maxBytes))
    const buffer = Buffer.alloc(length)
    const read = await handle.read(buffer, 0, length, 0)
    let text = buffer.subarray(0, read.bytesRead).toString('utf8')
    // Drop the trailing partial line so JSON.parse never sees a truncated row.
    if (read.bytesRead === length && stat.size > length) {
      const lastNewline = text.lastIndexOf('\n')
      text = lastNewline >= 0 ? text.slice(0, lastNewline) : ''
    }
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.includes('"turn_context"')) continue
      let row: any = null
      try { row = JSON.parse(trimmed) } catch { continue }
      if (row?.type !== 'turn_context') continue
      const ts = Date.parse(String(row?.timestamp || ''))
      if (!Number.isFinite(ts) || ts <= activityCutoffMs) continue
      const payload = objectValue(row.payload)
      return {
        model: firstKnown(payload.model),
        effort: firstKnown(payload.effort),
        reasoning_effort: firstKnown(payload.reasoning_effort)
      }
    }
    return null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function summarizeRolloutRow(row: any, projectRoot: string | null): ActivitySummary | null {
  const timestamp = String(row?.timestamp || '')
  const payload = objectValue(row?.payload)
  const outer = String(row?.type || '')
  const type = String(payload.type || '')
  const id = firstKnown(payload.id, payload.call_id, payload.turn_id, `${timestamp}:${outer}:${type}`) || `${timestamp}:${outer}:${type}`
  if (outer === 'event_msg') {
    if (type === 'agent_reasoning') return activity(timestamp, id, 'reasoning', 'task_progress', 'reasoning through the assigned slice', 'reasoning · private reasoning text is intentionally hidden', null)
    if (type === 'agent_message') {
      const text = boundedVisibleText(payload.message, 280)
      if (!text) return null
      const phase = String(payload.phase || 'commentary')
      return activity(timestamp, id, 'commentary', 'task_progress', `agent ${phase}: ${text}`, `${phase} · ${text}`, null)
    }
    if (type === 'patch_apply_end') {
      const files = Object.keys(objectValue(payload.changes))
      const currentFile = files[0] ? displayPath(files[0], projectRoot) : null
      const succeeded = payload.success === true || String(payload.status || '') === 'completed'
      const title = `${succeeded ? 'applied' : 'failed'} patch${files.length ? ` · ${files.length} file${files.length === 1 ? '' : 's'}` : ''}`
      return activity(timestamp, id, 'patch', succeeded ? 'patch_candidate' : 'task_progress', title, `${title}${currentFile ? ` · ${currentFile}` : ''}`, currentFile)
    }
    if (type === 'web_search_end') {
      const query = boundedVisibleText(payload.query, 180)
      return activity(timestamp, id, 'web_search', 'task_progress', query ? `searched: ${query}` : 'completed web search', query ? `web search · ${query}` : 'web search completed', null)
    }
    if (type === 'mcp_tool_call_end') {
      const invocation = objectValue(payload.invocation)
      const server = firstKnown(invocation.server, invocation.server_name)
      const tool = firstKnown(invocation.tool, invocation.tool_name, invocation.name)
      const label = [server, tool].filter(Boolean).join('/') || 'MCP tool'
      return activity(timestamp, id, 'mcp', 'task_progress', `completed ${label}`, `mcp · ${label} completed`, null)
    }
    if (type === 'task_started') return activity(timestamp, id, 'turn', 'task_started', 'started agent turn', 'turn · started', null)
    if (type === 'task_complete') return activity(timestamp, id, 'turn', 'task_progress', 'finished assigned turn; returning to parent', 'turn · complete, parent lifecycle verdict pending', null)
    if (type === 'turn_aborted') return activity(timestamp, id, 'turn', 'task_progress', 'agent turn interrupted', 'turn · interrupted', null)
    if (type === 'context_compacted') return activity(timestamp, id, 'context', 'task_progress', 'compacted agent context', 'context · compacted', null)
    return null
  }
  if (outer !== 'response_item') return null
  if (type === 'custom_tool_call' || type === 'function_call' || type === 'local_shell_call') {
    const name = firstKnown(payload.name, type === 'local_shell_call' ? 'shell' : null) || 'tool'
    const status = knownOrUndefined(payload.status)
    const label = `${name} tool${status ? ` · ${status}` : ''}`
    return activity(timestamp, id, 'tool', 'task_progress', `using ${name}`, label, null)
  }
  if (type === 'web_search_call') return activity(timestamp, id, 'web_search', 'task_progress', 'running web search', 'web search · running', null)
  if (type === 'message' && String(payload.role || '').toLowerCase() === 'assistant') {
    const text = boundedVisibleText(extractMessageText(payload.content), 280)
    if (!text) return null
    return activity(timestamp, id, 'commentary', 'task_progress', `agent message: ${text}`, `message · ${text}`, null)
  }
  return null
}

function activity(
  timestamp: string,
  identity: string,
  kind: string,
  eventType: ZellijSlotTelemetryEventType,
  title: string,
  line: string,
  currentFile: string | null
): ActivitySummary {
  return {
    timestamp,
    identity,
    kind,
    eventType,
    title: boundedText(title, 240) || 'agent active',
    line: boundedText(line, 360) || 'agent active',
    currentFile
  }
}

function uniqueSummaries(rows: ActivitySummary[]): ActivitySummary[] {
  const out: ActivitySummary[] = []
  for (const row of rows) {
    if (out.at(-1)?.line === row.line) continue
    out.push(row)
  }
  return out
}

function extractMessageText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value
    .map((item) => firstKnown(item?.text, item?.content, item?.input_text) || '')
    .filter(Boolean)
    .join(' ')
}

function displayPath(value: string, projectRoot: string | null): string {
  const absolute = path.resolve(value)
  if (projectRoot) {
    const relative = path.relative(path.resolve(projectRoot), absolute)
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) return relative
  }
  return path.basename(absolute)
}

function boundedVisibleText(value: unknown, max: number): string | null {
  const text = String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\b(?:sk|sess|rk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-token]')
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
  return boundedText(text, max)
}

function boundedText(value: unknown, max: number): string | null {
  const text = String(value || '').replace(/\s+$/g, '').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

function firstKnown(...values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    if (text && text.toLowerCase() !== 'unknown' && text !== '?') return text
  }
  return null
}

function knownOrUndefined(value: unknown): string | undefined {
  return firstKnown(value) || undefined
}

function safeThreadId(value: unknown): string {
  const text = String(value || '').trim()
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : ''
}

function objectValue(value: unknown): Record<string, any> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Math.floor(Number(value ?? fallback))
  const number = Number.isFinite(parsed) ? parsed : fallback
  return Math.max(min, Math.min(number, max))
}

async function isFile(file: string): Promise<boolean> {
  return fsp.stat(file).then((stat) => stat.isFile()).catch(() => false)
}

function versionAtLeast(value: unknown, minimum: string): boolean {
  const current = versionParts(value)
  const required = versionParts(minimum)
  if (!current || !required) return false
  for (let index = 0; index < Math.max(current.length, required.length); index += 1) {
    const left = current[index] || 0
    const right = required[index] || 0
    if (left > right) return true
    if (left < right) return false
  }
  return true
}

function versionParts(value: unknown): number[] | null {
  const match = String(value || '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return match ? match.slice(1).map((part) => Number(part)) : null
}

export function officialSubagentActivitySlot(snapshot: ZellijSlotTelemetrySnapshot | null, threadId: string) {
  return Object.values(snapshot?.slots || {}).find((slot) => slot.worker_id === threadId) || null
}
