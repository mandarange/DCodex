import path from 'node:path'
import { appendJsonlBounded } from '../fsx.js'
import type { CodexTaskInput } from './codex-control-plane.js'
import { buildCodexExecutionPolicy, buildCodexSdkConfig } from './codex-sdk-config-policy.js'
import { buildCodexSdkEnv } from './codex-sdk-env-policy.js'
import { translateCodexSdkEvent } from './codex-event-translator.js'
import type { CodexSdkSandboxMode } from './codex-sdk-sandbox-policy.js'
import { codexTimeoutClassForRoute } from './codex-reliability-shield.js'
import { resolveOfficialCodexPackageRuntime } from '../codex-runtime/resolve-codex-runtime.js'

export async function runRealCodexSdkTask(input: CodexTaskInput, policy: {
  sandboxMode: CodexSdkSandboxMode
  env: Record<string, string>
  config: Record<string, unknown>
}) {
  if (codexSdkTurnTimeoutMs(input) <= 0) {
    return {
      ok: false,
      sdkThreadId: '',
      sdkRunId: null,
      events: [],
      finalResponse: '',
      structuredOutput: null,
      blockers: ['codex_sdk_hard_deadline_exceeded'],
      liveEventsWritten: false,
      runtimeIdentity: null,
      executionPolicy: buildCodexExecutionPolicy(input),
      raw: { aborted: true, hard_deadline_exceeded: true }
    }
  }
  const runtime = await resolveCodexSdkRuntime(input)
  if (!runtime.ok || !runtime.identity) {
    throw new Error(`Trusted Codex SDK runtime unavailable: ${runtime.blockers.join(',')}`)
  }
  const mod: any = await import('@openai/codex-sdk')
  const Codex = mod.Codex || mod.default?.Codex || mod.default
  if (typeof Codex !== 'function') throw new Error('Codex SDK export Codex not found')
  const executionPolicy = buildCodexExecutionPolicy(input)
  const codex = new Codex({
    codexPathOverride: runtime.identity.realpath,
    env: policy.env,
    config: policy.config
  })
  const threadOptions = {
    workingDirectory: input.cwd,
    sandboxMode: executionPolicy.sandbox || policy.sandboxMode,
    approvalPolicy: executionPolicy.approval,
    skipGitRepoCheck: executionPolicy.gitRepoCheck === 'allow-explicit-non-git',
    networkAccessEnabled: executionPolicy.network === 'full',
    webSearchMode: executionPolicy.webSearch === 'indexed' ? undefined : executionPolicy.webSearch
  }
  const resumeId = typeof input.requestedScopeContract?.resume_thread_id === 'string'
    ? input.requestedScopeContract.resume_thread_id
    : null
  const thread = resumeId ? codex.resumeThread(resumeId, threadOptions) : codex.startThread(threadOptions)
  const events: any[] = []
  let finalResponse = ''
  let liveEventsWritten = false
  const liveEventPath = input.mutationLedgerRoot ? path.join(input.mutationLedgerRoot, 'codex-sdk-events.jsonl') : null
  const timeoutMs = codexSdkTurnTimeoutMs(input)
  if (timeoutMs <= 0) {
    return {
      ok: false,
      sdkThreadId: String(thread.id || ''),
      sdkRunId: null,
      events,
      finalResponse,
      structuredOutput: null,
      blockers: ['codex_sdk_hard_deadline_exceeded'],
      liveEventsWritten,
      runtimeIdentity: runtime.identity,
      executionPolicy,
      raw: { aborted: true, hard_deadline_exceeded: true }
    }
  }
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref?.()
  try {
    const streamed = await thread.runStreamed(buildSdkInput(input), { outputSchema: input.outputSchema, signal: controller.signal })
    for await (const event of streamed.events) {
      events.push(event)
      if (liveEventPath) {
        await appendJsonlBounded(liveEventPath, translateCodexSdkEvent(event), 5 * 1024 * 1024)
        liveEventsWritten = true
      }
      if (event?.type === 'item.completed' && event?.item?.type === 'agent_message') finalResponse = String(event.item.text || '')
    }
  } catch (err: any) {
    if (!timedOut && controller.signal.aborted !== true && String(err?.name || '') !== 'AbortError') throw err
    return {
      ok: false,
      sdkThreadId: String(thread.id || events.find((event) => event?.type === 'thread.started')?.thread_id || ''),
      sdkRunId: extractRunId(events),
      events,
      finalResponse,
      structuredOutput: null,
      blockers: [`codex_sdk_turn_timeout:${timeoutMs}`],
      liveEventsWritten,
      runtimeIdentity: runtime.identity,
      executionPolicy,
      raw: { timeout_ms: timeoutMs, aborted: true }
    }
  } finally {
    clearTimeout(timer)
  }
  const failed = events.find((event) => event?.type === 'turn.failed' || event?.type === 'error')
  if (failed) {
    return {
      ok: false,
      sdkThreadId: String(thread.id || events.find((event) => event?.type === 'thread.started')?.thread_id || ''),
      sdkRunId: extractRunId(events),
      events,
      finalResponse,
      structuredOutput: null,
      blockers: ['codex_turn_failed'],
      liveEventsWritten,
      runtimeIdentity: runtime.identity,
      executionPolicy,
      raw: { failed_event: failed }
    }
  }
  const structuredOutput = parseStructuredOutput(finalResponse, Boolean(input.outputSchema))
  return {
    ok: true,
    sdkThreadId: String(thread.id || events.find((event) => event?.type === 'thread.started')?.thread_id || ''),
    sdkRunId: extractRunId(events),
    events,
    finalResponse,
    structuredOutput,
    blockers: [],
    runtimeIdentity: runtime.identity,
    executionPolicy,
    liveEventsWritten,
    raw: { item_count: events.filter((event) => String(event?.type || '').startsWith('item.')).length }
  }
}

export async function resolveCodexSdkRuntime(_input?: Pick<CodexTaskInput, 'requestedScopeContract'>) {
  return resolveOfficialCodexPackageRuntime({ requestedBy: 'codex-sdk-adapter' })
}

export function codexSdkRuntimePolicies(input: CodexTaskInput) {
  const env = buildCodexSdkEnv(input)
  const config = buildCodexSdkConfig(input)
  return { env, config }
}

export function codexSdkTurnTimeoutMs(input: CodexTaskInput, nowMs = Date.now()) {
  const explicit = Number(process.env.SKS_CODEX_SDK_TURN_TIMEOUT_MS)
  const timeoutClass = codexTimeoutClassForRoute(input.route, input.reliabilityPolicy?.timeoutClass || (input.tier === 'orchestrator' ? 'long' : 'standard'))
  const classTimeout = Number.isFinite(explicit) && explicit > 0
    ? Math.max(1, Math.floor(explicit))
    : timeoutClass === 'short' ? 45_000 : timeoutClass === 'long' ? 300_000 : 120_000
  const hardTimeout = positiveFinite(input.reliabilityPolicy?.hardTimeoutMs)
  const deadline = positiveFinite(input.reliabilityPolicy?.deadlineEpochMs)
  const remainingDeadline = deadline === null ? null : Math.floor(deadline - nowMs)
  if (remainingDeadline !== null && remainingDeadline <= 0) return 0
  return Math.max(1, Math.floor(Math.min(
    classTimeout,
    hardTimeout ?? Number.POSITIVE_INFINITY,
    remainingDeadline ?? Number.POSITIVE_INFINITY
  )))
}

function positiveFinite(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function buildSdkInput(input: CodexTaskInput): any {
  const text = [
    input.prompt,
    input.inputFiles?.length ? `\nInput files:\n${input.inputFiles.map((file) => `- ${file}`).join('\n')}` : ''
  ].filter(Boolean).join('\n')
  const images = input.inputImages || []
  if (!images.length) return text
  return [
    { type: 'text', text },
    ...images.map((image) => ({ type: 'local_image', path: image }))
  ]
}

function parseStructuredOutput(text: string, strict = false) {
  const trimmed = String(text || '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    if (strict) return null
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1))
      } catch {}
    }
    return null
  }
}

function extractRunId(events: any[]) {
  const turn = events.find((event) => event?.turn_id || event?.run_id)
  return turn?.turn_id ? String(turn.turn_id) : turn?.run_id ? String(turn.run_id) : null
}
