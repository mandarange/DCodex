import { isImageOutputEvent } from './image-generation-probe.js'

export interface CodexLbCliImageProbeResult {
  ok: boolean
  status:
    | 'image_generated'
    | 'tool_accepted'
    | 'tool_rejected'
    | 'request_failed'
    | 'timeout'
  http_status: number | null
  response_id: string | null
  events: unknown[]
  tool_accepted: boolean
  image_event_seen: boolean
  artifact_materialized: boolean
  forced_tool_choice_used: boolean
  blockers: string[]
  error: string | null
}

export interface CodexLbCliImageProbeInput {
  baseUrl: string
  apiKey: string
  model: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export const DEFAULT_CLI_IMAGE_PROBE_TIMEOUT_MS = 90_000

// CLI-plane verification: authenticate exactly like the Codex CLI codex-lb
// provider contract (Authorization: Bearer from env_key) and run one real,
// minimal image generation through the gateway. A tool that merely round-trips
// a text request does not prove image_generation, so the probe forces the tool
// once and falls back to an acceptance check only when the gateway rejects the
// forced tool_choice shape itself.
export async function probeCodexLbCliImageGeneration(
  input: CodexLbCliImageProbeInput
): Promise<CodexLbCliImageProbeResult> {
  const fetchImpl = input.fetchImpl || globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return result({
      status: 'request_failed',
      http_status: null,
      response_id: null,
      events: [],
      tool_accepted: false,
      image_event_seen: false,
      artifact_materialized: false,
      forced_tool_choice_used: true,
      blockers: ['image_probe_fetch_unavailable'],
      error: 'fetch_unavailable'
    })
  }
  const endpoint = `${String(input.baseUrl || '').replace(/\/+$/, '')}/responses`
  const timeoutMs = input.timeoutMs || DEFAULT_CLI_IMAGE_PROBE_TIMEOUT_MS
  const forced = await postImageProbe(fetchImpl, endpoint, input.apiKey, input.model, timeoutMs, true)
  const forcedToolChoiceRejected = !forced.ok && /tool_choice/.test(String(forced.errorText || ''))
  const attempt = forcedToolChoiceRejected
    ? await postImageProbe(fetchImpl, endpoint, input.apiKey, input.model, timeoutMs, false)
    : forced
  if (attempt.timedOut) {
    return result({
      status: 'timeout',
      http_status: attempt.httpStatus,
      response_id: attempt.responseId,
      events: attempt.imageEvents,
      tool_accepted: attempt.imageEvents.length > 0,
      image_event_seen: attempt.imageEvents.length > 0,
      artifact_materialized: attempt.artifactMaterialized,
      forced_tool_choice_used: !forcedToolChoiceRejected,
      blockers: ['image_probe_timeout'],
      error: redact(`image probe timed out after ${timeoutMs}ms`, input.apiKey)
    })
  }
  if (!attempt.ok) {
    const toolRejected = /image_generation|tool/i.test(attempt.errorText)
      && /unsupported|not supported|unknown|invalid|not allowed|unrecognized/i.test(attempt.errorText)
    return result({
      status: toolRejected ? 'tool_rejected' : 'request_failed',
      http_status: attempt.httpStatus,
      response_id: attempt.responseId,
      events: attempt.imageEvents,
      tool_accepted: false,
      image_event_seen: attempt.imageEvents.length > 0,
      artifact_materialized: attempt.artifactMaterialized,
      forced_tool_choice_used: !forcedToolChoiceRejected,
      blockers: [toolRejected ? 'image_generation_tool_rejected_by_gateway' : `image_probe_request_failed:${attempt.httpStatus || 'network'}`],
      error: redact(attempt.errorText || 'image probe request failed', input.apiKey)
    })
  }
  const imageEventSeen = attempt.imageEvents.length > 0
  return result({
    status: imageEventSeen && attempt.artifactMaterialized
      ? 'image_generated'
      : 'tool_accepted',
    http_status: attempt.httpStatus,
    response_id: attempt.responseId,
    events: attempt.imageEvents,
    tool_accepted: true,
    image_event_seen: imageEventSeen,
    artifact_materialized: attempt.artifactMaterialized,
    forced_tool_choice_used: !forcedToolChoiceRejected,
    blockers: [],
    error: null
  })
}

interface ProbeAttempt {
  ok: boolean
  timedOut: boolean
  httpStatus: number | null
  responseId: string | null
  imageEvents: unknown[]
  artifactMaterialized: boolean
  errorText: string
}

async function postImageProbe(
  fetchImpl: typeof fetch,
  endpoint: string,
  apiKey: string,
  model: string,
  timeoutMs: number,
  forceTool: boolean
): Promise<ProbeAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        instructions: 'You are running an SKS codex-lb image-generation capability probe. Always use the image_generation tool.',
        input: 'Generate a tiny solid red square image (minimal size) using the image_generation tool.',
        tools: [{ type: 'image_generation' }],
        ...(forceTool ? { tool_choice: { type: 'image_generation' } } : {}),
        stream: true,
        store: false,
        parallel_tool_calls: false,
        reasoning: { effort: 'low' }
      }),
      redirect: 'error',
      signal: controller.signal
    })
    const text = await response.text()
    let json: Record<string, unknown> | null = null
    try { json = text ? JSON.parse(text) : null } catch {}
    const events = json ? [] : parseSseEvents(text)
    const imageEvents = collectImageEvents(json, events)
    const errorPayload = responseError(json, events)
    return {
      ok: response.ok && !errorPayload,
      timedOut: false,
      httpStatus: response.status,
      responseId: responseIdOf(json) || events.map((event) => responseIdOf(event)).find(Boolean) || null,
      imageEvents,
      artifactMaterialized: imageEvents.some(eventCarriesImageArtifact),
      errorText: errorPayload ? errorText(errorPayload) : response.ok ? '' : text.slice(0, 500)
    }
  } catch (error: unknown) {
    const timedOut = controller.signal.aborted
    return {
      ok: false,
      timedOut,
      httpStatus: null,
      responseId: null,
      imageEvents: [],
      artifactMaterialized: false,
      errorText: timedOut ? 'timeout' : String((error as Error)?.message || error || 'network_error')
    }
  } finally {
    clearTimeout(timer)
  }
}

function parseSseEvents(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (!data || data === '[DONE]') continue
    try { events.push(JSON.parse(data)) } catch {}
  }
  return events
}

function collectImageEvents(
  json: Record<string, unknown> | null,
  events: Array<Record<string, unknown>>
): unknown[] {
  const collected = events.filter(isImageOutputEvent)
  if (json) {
    const output = Array.isArray(json.output) ? json.output : []
    for (const item of output) {
      if (isImageOutputEvent({ type: 'response.output_item.done', item })) collected.push({ type: 'response.output_item.done', item })
    }
  }
  return collected.slice(0, 20)
}

function eventCarriesImageArtifact(event: unknown): boolean {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false
  const row = event as Record<string, unknown>
  const candidates: unknown[] = [
    row.result,
    row.partial_image_b64,
    row.b64_json,
    row.url,
    row.item && (row.item as Record<string, unknown>).result,
    row.item && (row.item as Record<string, unknown>).partial_image_b64
  ]
  return candidates.some((value) => typeof value === 'string' && value.length > 0)
}

function responseError(
  json: Record<string, unknown> | null,
  events: Array<Record<string, unknown>>
): Record<string, unknown> | null {
  if (json?.error) return json
  for (const event of events) {
    if (event.error || event.response && (event.response as Record<string, unknown>).error
      || event.type === 'response.failed' || event.type === 'error') return event
  }
  return null
}

function errorText(payload: Record<string, unknown>): string {
  const error = (payload.error || (payload.response as Record<string, unknown> | undefined)?.error || payload) as Record<string, unknown>
  return [error.type, error.code, error.message].filter(Boolean).join(' ').slice(0, 300)
}

function responseIdOf(payload: Record<string, unknown> | null): string | null {
  if (!payload) return null
  if (typeof payload.id === 'string' && payload.id) return payload.id
  const response = payload.response as Record<string, unknown> | undefined
  if (typeof response?.id === 'string' && response.id) return response.id
  return null
}

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[redacted]') : text
}

function result(
  input: Omit<CodexLbCliImageProbeResult, 'ok'>
): CodexLbCliImageProbeResult {
  return { ok: input.status === 'image_generated' || input.status === 'tool_accepted', ...input }
}
