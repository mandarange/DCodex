import path from 'node:path'
import { nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js'
import { appendMissionStatus } from '../recallpulse.js'
import { conversationId } from './payload-signals.js'

const STOP_REPEAT_GUARD_ARTIFACT = 'stop-hook-repeat-guard.json'
const STOP_REPEAT_GUARD_WINDOW_MS = 10 * 60 * 1000
const STOP_REPEAT_GUARD_MAX_ENTRIES = 25
const DEFAULT_STOP_REPEAT_GUARD_LIMIT = 2

export async function finalizationRepeatDecision(root: any, state: any = {}, payload: any = {}, reason: any = '', kind: any = 'finalization') {
  const now = nowIso()
  const guardPath = path.join(root, '.sneakoscope', 'state', STOP_REPEAT_GUARD_ARTIFACT)
  const previous = await readJson(guardPath, {}).catch(() => ({}))
  const limit = stopRepeatGuardLimit()
  const entries: Record<string, any> = pruneStopRepeatEntries(previous.entries || {}, now)
  const key = stopRepeatKey(state, payload, reason, kind)
  const prior = entries[key] || {}
  const repeatCount = stopRepeatInWindow(prior, now)
    ? Number(prior.repeat_count || 0) + 1
    : 1
  const record = {
    schema_version: 1,
    updated_at: now,
    window_ms: STOP_REPEAT_GUARD_WINDOW_MS,
    limit,
    entries: {
      ...entries,
      [key]: {
        kind,
        route: state.route_command || state.route || state.mode || null,
        mission_id: state.mission_id || null,
        conversation_id: conversationId(payload),
        first_seen: stopRepeatInWindow(prior, now) ? (prior.first_seen || now) : now,
        last_seen: now,
        repeat_count: repeatCount,
        tripped: repeatCount >= limit,
        terminal_status: repeatCount >= limit ? 'unverified' : null,
        stop_reason: repeatCount >= limit ? 'finalization_repeat_budget_exhausted' : null,
        completion_claim_allowed: false,
        reason
      }
    }
  }
  try {
    await writeJsonAtomic(guardPath, record)
  } catch {
    return {
      continue: true,
      action: 'finalization_terminal_unverified',
      status: 'unverified',
      stop_reason: 'finalization_repeat_guard_persistence_failed',
      completion_claim_allowed: false,
      systemMessage: `SKS could not persist the ${kind} repeat budget. Finalization stopped fail-closed and completion remains unverified.`
    }
  }
  if (state.mission_id) {
    await appendMissionStatus(root, state.mission_id, {
      category: repeatCount >= limit ? 'warning' : 'blocker',
      audience: ['user', 'route', 'final-summary'],
      stage_id: 'before_final',
      message: repeatCount >= limit
        ? `Repeated ${kind} stop prompt was suppressed; route completion is still unclaimed until evidence passes.`
        : reason,
      dedupe_key: key,
      evidence: [STOP_REPEAT_GUARD_ARTIFACT]
    }).catch(() => null)
  }
  if (repeatCount < limit) return null
  return {
    continue: true,
    action: 'finalization_terminal_unverified',
    status: 'unverified',
    stop_reason: 'finalization_repeat_budget_exhausted',
    completion_claim_allowed: false,
    systemMessage: `SKS stopped repeated ${kind} finalization after ${repeatCount} identical block(s). The terminal state is unverified; no completion success is claimed.`
  }
}

function stopRepeatKey(state: any = {}, payload: any = {}, reason: any = '', kind: any = '') {
  return sha256(JSON.stringify({
    kind,
    reason,
    conversation_id: conversationId(payload),
    mission_id: state.mission_id || null,
    route: state.route_command || state.route || state.mode || null,
    gate: state.stop_gate || null
  })).slice(0, 24)
}

function stopRepeatGuardLimit() {
  const raw = Number.parseInt(process.env.SKS_STOP_REPEAT_GUARD_LIMIT || '', 10)
  if (!Number.isFinite(raw)) return DEFAULT_STOP_REPEAT_GUARD_LIMIT
  return Math.max(1, Math.min(20, raw))
}

function stopRepeatInWindow(entry: any = {}, now: any = nowIso()) {
  const last = Date.parse(entry.last_seen || '')
  const current = Date.parse(now)
  if (!Number.isFinite(last) || !Number.isFinite(current)) return false
  return current - last <= STOP_REPEAT_GUARD_WINDOW_MS
}

function pruneStopRepeatEntries(entries: any = {}, now: any = nowIso()) {
  return Object.fromEntries(Object.entries(entries)
    .filter(([, entry]: any) => stopRepeatInWindow(entry, now))
    .sort((a: any, b: any) => Date.parse(b[1]?.last_seen || '') - Date.parse(a[1]?.last_seen || ''))
    .slice(0, STOP_REPEAT_GUARD_MAX_ENTRIES))
}
