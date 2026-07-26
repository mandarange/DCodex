import path from 'node:path'
import { nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js'

export const TOOL_OUTPUT_QUARANTINE_SCHEMA = 'sks.tool-output-quarantine.v1'

export interface ToolOutputQuarantineRecord {
  schema: typeof TOOL_OUTPUT_QUARANTINE_SCHEMA
  active: true
  session_key_hash: string
  call_id: string
  mission_id: string | null
  turn_id: string | null
  first_seen_at: string
  updated_at: string
  recovery: 'fresh_thread_required'
}

export function missingToolOutputCallId(text: unknown): string | null {
  return String(text || '').match(/\[No tool output found for (?:custom\s+)?tool call\s+([^\].\s]+)\.?\]/i)?.[1] || null
}

export function missingToolOutputCallIdFromPayload(payload: any = {}): string | null {
  const candidates = [
    payload.prompt,
    payload.user_prompt,
    payload.userPrompt,
    payload.last_assistant_message,
    payload.assistant_message,
    payload.previous_assistant_message,
    payload.prior_assistant_message,
    payload.response,
    payload.raw,
    payload.error,
    payload.error_message,
    payload.errorMessage,
    payload.last_error,
    payload.raw_error,
    payload.rawError,
    payload.result
  ]
  const seen = new Set<object>()
  let visited = 0
  const scan = (value: unknown, depth = 0): string | null => {
    if (visited >= 128 || depth > 4 || value === null || value === undefined) return null
    visited += 1
    if (typeof value === 'string' || typeof value === 'number') return missingToolOutputCallId(value)
    if (typeof value !== 'object' || seen.has(value)) return null
    seen.add(value)
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = scan(item, depth + 1)
        if (found) return found
      }
      return null
    }
    for (const nested of Object.values(value)) {
      const found = scan(nested, depth + 1)
      if (found) return found
    }
    return null
  }
  for (const candidate of candidates) {
    const found = scan(candidate)
    if (found) return found
  }
  return null
}

export function toolOutputQuarantinePath(root: string, sessionKey: string): string {
  return path.join(root, '.sneakoscope', 'state', 'tool-output-quarantine', `${sha256(String(sessionKey || 'default')).slice(0, 32)}.json`)
}

export async function readToolOutputQuarantine(root: string, sessionKey: string): Promise<ToolOutputQuarantineRecord | null> {
  const record = await readJson<ToolOutputQuarantineRecord | null>(toolOutputQuarantinePath(root, sessionKey), null).catch(() => null)
  return record?.schema === TOOL_OUTPUT_QUARANTINE_SCHEMA && record.active === true ? record : null
}

export async function quarantineMissingToolOutput(input: {
  root: string
  sessionKey: string
  callId: string
  missionId?: unknown
  turnId?: unknown
}): Promise<ToolOutputQuarantineRecord> {
  const previous = await readToolOutputQuarantine(input.root, input.sessionKey)
  const now = nowIso()
  const record: ToolOutputQuarantineRecord = {
    schema: TOOL_OUTPUT_QUARANTINE_SCHEMA,
    active: true,
    session_key_hash: sha256(String(input.sessionKey || 'default')).slice(0, 24),
    call_id: String(input.callId || previous?.call_id || 'unknown'),
    mission_id: String(input.missionId || previous?.mission_id || '').trim() || null,
    turn_id: String(input.turnId || '').trim() || previous?.turn_id || null,
    first_seen_at: previous?.first_seen_at || now,
    updated_at: now,
    recovery: 'fresh_thread_required'
  }
  await writeJsonAtomic(toolOutputQuarantinePath(input.root, input.sessionKey), record)
  return record
}

export function interruptedToolOutputRecoveryBlockReason(input: {
  callId?: unknown
  missionId?: unknown
} = {}) {
  const callId = String(input.callId || 'unknown')
  const missionId = String(input.missionId || '').trim() || 'none'
  return [
    `SKS blocked same-thread continuation because custom tool call ${callId} has no correlated output (active mission: ${missionId}).`,
    'The current Codex conversation state may be structurally invalid, so additional context cannot repair the pending Responses request.',
    'Treat the call result as unknown and do not replay a possibly mutating action.',
    'Upgrade the selected codex-lb to the official latest stable release (`sks codex-lb status --json` reports whether the deployment satisfies tool-heavy continuation), or explicitly switch with `sks codex-lb use-oauth`, then open a fresh Codex thread and continue the persisted mission after inspecting side effects.'
  ].join(' ')
}
