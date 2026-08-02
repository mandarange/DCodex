import fsp from 'node:fs/promises'
import path from 'node:path'
import { appendJsonlBounded, nowIso, sha256, writeJsonAtomic } from '../fsx.js'
import type { SubagentCountPolicy } from './wave-lifecycle.js'
import { HOST_CAPABILITY_DESCRIPTORS, hostCapabilityDigest } from '../agent-bridge/agent-manifest.js'
import {
  HOST_CAPABILITY_EVIDENCE_SCHEMA,
  HOST_CAPABILITY_RUNTIME_SCHEMA,
  type HostArtifactSourceReceipt,
  type HostArtifactReceipt,
  type HostCapabilityExecutionEvidence,
  type HostCapabilityUseReceipt
} from '../agent-bridge/host-capability-runtime.js'
import { isRecord } from '../json/records.js'

export const SUBAGENT_EVIDENCE_SCHEMA = 'sks.subagent-evidence.v1'
export const SUBAGENT_EVENT_SCHEMA = 'sks.subagent-event.v1'
export const SUBAGENT_PARENT_SUMMARY_SCHEMA = 'sks.subagent-parent-summary.v1'
export const SUBAGENT_EVIDENCE_FILENAME = 'subagent-evidence.json'
export const SUBAGENT_EVENT_LOG_FILENAME = 'subagent-events.jsonl'
export const SUBAGENT_PARENT_SUMMARY_FILENAME = 'subagent-parent-summary.json'

export type SubagentEventName = 'SubagentStart' | 'SubagentStop'

export interface NormalizedSubagentEvent {
  schema: typeof SUBAGENT_EVENT_SCHEMA
  event_name: SubagentEventName
  thread_id: string | null
  thread_id_source: 'thread_id' | 'agent_id' | null
  agent_id: string | null
  session_id: string | null
  turn_id: string | null
  run_id: string | null
  run_epoch: string | null
  model: string | null
  outcome: 'started' | 'stopped' | 'failed' | 'ambiguous'
  occurred_at: string
}

export interface SubagentEvidence {
  schema: typeof SUBAGENT_EVIDENCE_SCHEMA
  workflow: 'official_codex_subagent'
  requested_subagents: number
  count_policy: SubagentCountPolicy
  target_subagents: number
  started_threads: number
  completed_threads: number
  failed_threads: number
  started_thread_ids: string[]
  completed_thread_ids: string[]
  failed_thread_ids: string[]
  open_thread_ids: string[]
  unmatched_stop_thread_ids: string[]
  event_sources: SubagentEventName[]
  parent_summary_present: boolean
  parent_summary_trustworthy: boolean
  parent_summary_status: 'completed' | 'failed' | 'ambiguous' | null
  ambiguous_stop_thread_ids: string[]
  run_id: string | null
  run_epoch: string | null
  run_scope_source: 'input' | 'parent_summary' | 'event_run_id' | 'event_turn_id' | 'event_run_epoch' | null
  rejected_stale_events: number
  rejected_stale_thread_ids: string[]
  unbound_run_events: number
  preparation_only: boolean
  status: 'completed' | 'incomplete' | 'blocked' | 'preparation_only'
  ok: boolean
  blockers: string[]
  host_capability_evidence?: HostCapabilityExecutionEvidence
}

export interface StructuredSubagentParentSummary {
  schema: typeof SUBAGENT_PARENT_SUMMARY_SCHEMA
  status: 'completed' | 'blocked' | 'failed'
  summary: string
  thread_outcomes: Array<{
    thread_id: string
    status: 'completed' | 'blocked' | 'failed'
    summary: string
  }>
  changed_files?: string[]
  verification?: unknown[]
  blockers?: string[]
  run_id?: string
  run_epoch?: string | number
  artifacts?: HostArtifactReceipt[]
  capabilities_used?: HostCapabilityUseReceipt[]
}

export interface BuildSubagentEvidenceInput {
  requestedSubagents: number
  countPolicy?: SubagentCountPolicy
  targetSubagents?: number
  events?: readonly unknown[]
  parentSummary?: unknown
  parentSummaryPresent?: boolean
  workflowStatus?: string | null
  preparationOnly?: boolean
  additionalBlockers?: readonly unknown[]
  runId?: string | null
  runEpoch?: string | number | null
  hostCapabilityEvidence?: HostCapabilityExecutionEvidence | null
}

const MAX_PARENT_ARTIFACTS = 64
const MAX_PARENT_ARTIFACT_PATH_CHARS = 512
const MAX_PARENT_CAPABILITY_USES = 64
const MAX_PARENT_CAPABILITY_TOOL_NAMES = 64
const MAX_HOST_ARTIFACT_SOURCES = 64
const SHA256_RECEIPT_PATTERN = /^sha256:[a-f0-9]{64}$/
const ARTIFACT_ROLES = new Set<HostArtifactReceipt['role']>(['deliverable', 'scratch', 'temp', 'log'])
const HOST_CAPABILITY_BY_ID = new Map(HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))
const HOST_ARTIFACT_SOURCE_TOOLS = new Set(
  HOST_CAPABILITY_BY_ID.get('host.artifact.receipt.v1')?.tool_names || []
)

export function trustedHostCapabilityReceiptBindingBlockers(
  evidence: HostCapabilityExecutionEvidence
): string[] {
  const blockers: string[] = []
  const artifactSources = validateHostArtifactSources(evidence, blockers)
  const requestedIds = evidence.runtime.requested_capability_ids
  const requested = new Set(requestedIds)
  const receiptsById = new Map(evidence.capabilities_used.map((receipt) => [receipt.id, receipt]))
  if (requested.size !== requestedIds.length
    || receiptsById.size !== evidence.capabilities_used.length
    || evidence.capabilities_used.some((receipt) => !requested.has(receipt.id))
    || requestedIds.some((id) => !receiptsById.has(id))) {
    blockers.push('host_capability_requested_receipts_mismatch')
  }

  for (const id of requestedIds) {
    const descriptor = HOST_CAPABILITY_BY_ID.get(id)
    const receipt = receiptsById.get(id)
    if (!descriptor || !receipt) continue
    const relevantCalls = evidence.tool_calls.filter((call) => descriptor.tool_names.includes(call.tool))
    if (descriptor.executable === false) {
      blockers.push(...validateArtifactCapabilityReceipt(receipt, relevantCalls, evidence.artifacts, artifactSources))
      continue
    }
    const expectedTools = uniqueStrings(relevantCalls.map((call) => call.tool)).sort()
    const expectedHash = capabilityReceiptSha256(id, relevantCalls.map((call) => call.event_sha256), [])
    if (JSON.stringify(receipt.tool_names) !== JSON.stringify(expectedTools)) {
      blockers.push(`host_capability_receipt_tool_calls_mismatch:${id}`)
    }
    if (receipt.receipt_sha256 !== expectedHash) {
      blockers.push(`host_capability_receipt_sha256_mismatch:${id}`)
    }
    if (receipt.status === 'passed') {
      if (relevantCalls.length === 0) blockers.push(`host_capability_passed_call_missing:${id}`)
      if (relevantCalls.some((call) => call.status !== 'passed')) {
        blockers.push(`host_capability_passed_call_failed:${id}`)
      }
    }
  }
  return uniqueStrings(blockers)
}

function validateArtifactCapabilityReceipt(
  receipt: HostCapabilityUseReceipt,
  relevantCalls: HostCapabilityExecutionEvidence['tool_calls'],
  artifacts: HostArtifactReceipt[],
  artifactSources: HostArtifactSourceReceipt[]
): string[] {
  const id = receipt.id
  const blockers: string[] = []
  const expectedTools = uniqueStrings(relevantCalls.map((call) => call.tool)).sort()
  if (JSON.stringify(receipt.tool_names) !== JSON.stringify(expectedTools)) {
    blockers.push(`host_capability_receipt_artifact_sources_mismatch:${id}`)
  }
  const expectedHash = capabilityReceiptSha256(
    id,
    relevantCalls.map((call) => call.event_sha256),
    artifactSources.map((source) => source.source_event_sha256)
  )
  if (receipt.receipt_sha256 !== expectedHash) blockers.push(`host_capability_receipt_sha256_mismatch:${id}`)
  if (receipt.status === 'passed') {
    if (artifacts.length === 0) blockers.push(`host_capability_passed_artifact_missing:${id}`)
    if (artifactSources.length === 0) blockers.push(`host_capability_passed_artifact_source_missing:${id}`)
    if (relevantCalls.some((call) => call.status !== 'passed')) {
      blockers.push(`host_capability_passed_call_failed:${id}`)
    }
  }
  return blockers
}

function validateHostArtifactSources(
  evidence: HostCapabilityExecutionEvidence,
  blockers: string[]
): HostArtifactSourceReceipt[] {
  const value: unknown = evidence.artifact_sources
  if (!Array.isArray(value)) {
    blockers.push('host_artifact_source_mapping_missing')
    return []
  }
  if (value.length > MAX_HOST_ARTIFACT_SOURCES) blockers.push('host_artifact_source_mapping_too_many')
  const sources: HostArtifactSourceReceipt[] = []
  for (const row of value.slice(0, MAX_HOST_ARTIFACT_SOURCES)) {
    if (!isRecord(row)
      || Object.keys(row).some((key) => !['path', 'source_tool', 'source_event_sha256'].includes(key))) {
      blockers.push('host_artifact_source_mapping_invalid')
      continue
    }
    const artifactPath = normalizeParentArtifactPath(row.path)
    const sourceTool = boundedParentToken(row.source_tool, 128, /^[A-Za-z][A-Za-z0-9_.:-]*$/)
    const sourceEventSha256 = typeof row.source_event_sha256 === 'string'
      ? row.source_event_sha256.trim().toLowerCase()
      : ''
    if (!artifactPath || !sourceTool || !SHA256_RECEIPT_PATTERN.test(sourceEventSha256)) {
      blockers.push('host_artifact_source_mapping_invalid')
      continue
    }
    sources.push({ path: artifactPath, source_tool: sourceTool, source_event_sha256: sourceEventSha256 })
  }

  const artifactPaths = evidence.artifacts.map((artifact) => artifact.path)
  const sourcePaths = sources.map((source) => source.path)
  if (JSON.stringify(artifactPaths) !== JSON.stringify([...artifactPaths].sort((left, right) => left.localeCompare(right)))) {
    blockers.push('host_artifact_source_mapping_order_mismatch')
  }
  if (new Set(sourcePaths).size !== sourcePaths.length) blockers.push('host_artifact_source_mapping_duplicate')
  if (artifactPaths.some((artifactPath) => !sourcePaths.includes(artifactPath))) {
    blockers.push('host_artifact_source_mapping_missing')
  }
  if (sourcePaths.some((sourcePath) => !artifactPaths.includes(sourcePath))) {
    blockers.push('host_artifact_source_mapping_forged')
  }
  if (JSON.stringify(sourcePaths) !== JSON.stringify(artifactPaths)) {
    blockers.push('host_artifact_source_mapping_order_mismatch')
  }
  for (const source of sources) {
    if (!HOST_ARTIFACT_SOURCE_TOOLS.has(source.source_tool)) {
      blockers.push('host_artifact_source_mapping_forged')
      continue
    }
    const exactPassedCalls = evidence.tool_calls.filter((call) => (
      call.status === 'passed'
      && call.tool === source.source_tool
      && call.event_sha256 === source.source_event_sha256
    ))
    if (exactPassedCalls.length !== 1) blockers.push('host_artifact_source_mapping_forged')
  }
  return sources
}

function capabilityReceiptSha256(id: string, calls: string[], artifacts: string[]): string {
  return `sha256:${sha256(JSON.stringify({ id, calls, artifacts }))}`
}

export function normalizeSubagentEvent(payload: unknown, explicitEventName?: unknown): NormalizedSubagentEvent | null {
  const row = isRecord(payload) ? payload : {}
  const nested = isRecord(row.payload)
    ? row.payload
    : isRecord(row.data)
      ? row.data
      : isRecord(row.input)
        ? row.input
        : {}
  const merged = { ...nested, ...row }
  const eventName = normalizeEventName(
    explicitEventName
      ?? row.hook_event_name
      ?? row.hookEventName
      ?? row.event_name
      ?? row.eventName
      ?? row.event
      ?? row.type
      ?? nested.hook_event_name
      ?? nested.hookEventName
      ?? nested.event_name
      ?? nested.eventName
      ?? nested.event
      ?? nested.type
  )
  if (!eventName) return null
  const persistedOutcome = row.schema === SUBAGENT_EVENT_SCHEMA
    ? normalizePersistedOutcome(row.outcome, eventName)
    : null

  const explicitThreadId = firstText(
    row.thread_id,
    row.threadId,
    row.agent_thread_id,
    row.agentThreadId,
    row.subagent_thread_id,
    row.subagentThreadId,
    nested.thread_id,
    nested.threadId,
    nested.agent_thread_id,
    nested.agentThreadId,
    nested.subagent_thread_id,
    nested.subagentThreadId,
    recordId(row.thread),
    recordId(nested.thread)
  )
  const agentId = firstText(row.agent_id, row.agentId, nested.agent_id, nested.agentId, recordId(row.agent), recordId(nested.agent))
  const sessionId = firstText(row.session_id, row.sessionId, nested.session_id, nested.sessionId, recordId(row.session), recordId(nested.session))
  // Official SubagentStart/SubagentStop payloads identify the child with
  // agent_id. session_id is the parent/session scope and must never be used as
  // a child identity because every sibling can share it.
  const threadId = explicitThreadId || agentId || null
  const threadIdSource = explicitThreadId
    ? 'thread_id'
    : agentId
      ? 'agent_id'
      : null

  return {
    schema: SUBAGENT_EVENT_SCHEMA,
    event_name: eventName,
    thread_id: threadId,
    thread_id_source: threadIdSource,
    agent_id: agentId || null,
    session_id: sessionId || null,
    turn_id: firstText(row.turn_id, row.turnId, nested.turn_id, nested.turnId) || null,
    run_id: firstText(
      row.run_id,
      row.runId,
      row.workflow_run_id,
      row.workflowRunId,
      nested.run_id,
      nested.runId,
      nested.workflow_run_id,
      nested.workflowRunId
    ) || null,
    run_epoch: firstText(
      row.run_epoch,
      row.runEpoch,
      row.execution_epoch,
      row.executionEpoch,
      nested.run_epoch,
      nested.runEpoch,
      nested.execution_epoch,
      nested.executionEpoch
    ) || null,
    model: firstText(row.model, nested.model) || null,
    outcome: persistedOutcome ?? (eventName === 'SubagentStart'
      ? 'started'
      : stopFailed(merged)
        ? 'failed'
        : stopAmbiguous(merged)
          ? 'ambiguous'
          : 'stopped'),
    occurred_at: firstText(
      row.occurred_at,
      row.timestamp,
      row.created_at,
      row.ts,
      nested.occurred_at,
      nested.timestamp,
      nested.created_at,
      nested.ts
    ) || nowIso()
  }
}

export function buildSubagentEvidence(input: BuildSubagentEvidenceInput): SubagentEvidence {
  const requestedSubagents = normalizeRequested(input.requestedSubagents)
  const countPolicy: SubagentCountPolicy = input.countPolicy === 'dynamic_automatic'
    ? 'dynamic_automatic'
    : 'exact'
  const normalizedEvents = (input.events || [])
    .map((event) => normalizeSubagentEvent(event))
    .filter((event): event is NormalizedSubagentEvent => Boolean(event))
  const parentSummary = normalizeSubagentParentSummary(input.parentSummary)
  const hostCapabilityEvidence = normalizeTrustedHostCapabilityEvidence(input.hostCapabilityEvidence)
  const hostCapabilityBlockers = validateParentHostCapabilityBinding(parentSummary.raw, hostCapabilityEvidence)
  const runScope = resolveRunScope(input, normalizedEvents, parentSummary)
  const scopedEvents = scopeSubagentEvents(normalizedEvents, runScope)
  const events = scopedEvents.events
  const starts = new Set<string>()
  const successfulStops = new Set<string>()
  const failedStops = new Set<string>()
  const unmatchedStops = new Set<string>()
  const ambiguousStops = new Set<string>()
  const eventSources = new Set<SubagentEventName>()
  let missingThreadId = false
  const parentSummaryStructurallyTrustworthy = parentSummary.trustworthy
    && hostCapabilityBlockers.length === 0
    && runScope.blockers.length === 0
    && runScope.parentBlockers.length === 0
  const parentCompletedStructurallyTrustworthy = parentSummaryStructurallyTrustworthy
    && parentSummary.status === 'completed'

  for (const event of events) {
    eventSources.add(event.event_name)
    if (!event.thread_id) {
      missingThreadId = true
      continue
    }
    if (event.event_name === 'SubagentStart') {
      starts.add(event.thread_id)
      continue
    }
    if (!starts.has(event.thread_id)) {
      unmatchedStops.add(event.thread_id)
      continue
    }
    if (event.outcome === 'failed') {
      failedStops.add(event.thread_id)
      successfulStops.delete(event.thread_id)
      ambiguousStops.delete(event.thread_id)
      continue
    }
    if (event.outcome === 'ambiguous') {
      ambiguousStops.add(event.thread_id)
      successfulStops.delete(event.thread_id)
      failedStops.delete(event.thread_id)
      continue
    }
    const parentOutcome = parentSummary.thread_outcomes.get(event.thread_id)
    if (parentOutcome === 'failed') {
      failedStops.add(event.thread_id)
      successfulStops.delete(event.thread_id)
      ambiguousStops.delete(event.thread_id)
    } else if (parentOutcome === 'completed' && parentCompletedStructurallyTrustworthy) {
      successfulStops.add(event.thread_id)
      failedStops.delete(event.thread_id)
      ambiguousStops.delete(event.thread_id)
    } else {
      ambiguousStops.add(event.thread_id)
      successfulStops.delete(event.thread_id)
      failedStops.delete(event.thread_id)
    }
  }

  const parentOutcomeThreadIds = [...parentSummary.thread_outcomes.keys()].sort()
  const parentOutcomeThreadIdSet = new Set(parentOutcomeThreadIds)
  const missingParentOutcomeThreadIds = [...starts]
    .filter((threadId) => !parentOutcomeThreadIdSet.has(threadId))
    .sort()
  const unobservedParentOutcomeThreadIds = parentOutcomeThreadIds
    .filter((threadId) => !starts.has(threadId))
  const parentThreadIdentityBlockers = [
    ...missingParentOutcomeThreadIds.map((threadId) => `parent_thread_outcome_missing_for_started_thread:${threadId}`),
    ...unobservedParentOutcomeThreadIds.map((threadId) => `parent_thread_outcome_without_start:${threadId}`)
  ]
  const parentSummaryTrustworthy = parentSummaryStructurallyTrustworthy
    && parentThreadIdentityBlockers.length === 0
  if (!parentSummaryTrustworthy) {
    for (const threadId of successfulStops) {
      successfulStops.delete(threadId)
      if (!failedStops.has(threadId)) ambiguousStops.add(threadId)
    }
  }

  const completedThreadIds = [...successfulStops]
    .filter((threadId) => starts.has(threadId))
    .sort()
  const failedThreadIds = [...failedStops]
    .filter((threadId) => starts.has(threadId))
    .sort()
  const startedThreadIds = [...starts].sort()
  const configuredTargetSubagents = normalizeRequested(input.targetSubagents)
  const targetSubagents = countPolicy === 'dynamic_automatic'
    ? configuredTargetSubagents > 0
      ? configuredTargetSubagents
      : Math.max(requestedSubagents, startedThreadIds.length)
    : requestedSubagents
  const stoppedThreadIds = new Set([...completedThreadIds, ...failedThreadIds])
  const openThreadIds = startedThreadIds.filter((threadId) => !stoppedThreadIds.has(threadId))
  const preparationOnly = input.preparationOnly === true || isPreparationStatus(input.workflowStatus)
  const parentSummaryPresent = input.parentSummaryPresent
    ?? parentSummary.present
  const blockers: string[] = []

  if (preparationOnly) blockers.push('subagent_workflow_preparation_only')
  if (requestedSubagents < 1) blockers.push('requested_subagents_missing')
  if (countPolicy === 'dynamic_automatic'
    && configuredTargetSubagents > 0
    && requestedSubagents > configuredTargetSubagents) {
    blockers.push(`requested_subagents_exceed_target:${requestedSubagents}/${configuredTargetSubagents}`)
  }
  if (missingThreadId) blockers.push('subagent_event_thread_id_missing')
  if (startedThreadIds.length < targetSubagents) {
    blockers.push(`requested_subagent_starts_incomplete:${startedThreadIds.length}/${targetSubagents}`)
  } else if (startedThreadIds.length > targetSubagents) {
    blockers.push(`requested_subagent_starts_exceeded:${startedThreadIds.length}/${targetSubagents}`)
  }
  if (completedThreadIds.length < targetSubagents) {
    blockers.push(`requested_subagent_completions_incomplete:${completedThreadIds.length}/${targetSubagents}`)
  } else if (completedThreadIds.length > targetSubagents) {
    blockers.push(`requested_subagent_completions_exceeded:${completedThreadIds.length}/${targetSubagents}`)
  }
  if (failedThreadIds.length > 0) blockers.push(`subagent_threads_failed:${failedThreadIds.length}`)
  if (openThreadIds.length > 0) blockers.push(`subagent_threads_still_open:${openThreadIds.length}`)
  if (unmatchedStops.size > 0) blockers.push(`subagent_stops_without_start:${unmatchedStops.size}`)
  if (ambiguousStops.size > 0) blockers.push(`subagent_thread_outcomes_ambiguous:${ambiguousStops.size}`)
  blockers.push(...runScope.blockers, ...runScope.parentBlockers)
  blockers.push(...parentThreadIdentityBlockers)
  if (!parentSummaryPresent) blockers.push('parent_summary_missing')
  else if (!parentSummary.trustworthy) blockers.push(...parentSummary.blockers)
  if (parentSummary.status === 'failed') blockers.push('parent_summary_failed')
  blockers.push(...hostCapabilityBlockers)
  if (input.hostCapabilityEvidence !== undefined && input.hostCapabilityEvidence !== null && !hostCapabilityEvidence) {
    blockers.push('host_capability_evidence_invalid')
  }
  if (hostCapabilityEvidence) {
    blockers.push(...hostCapabilityEvidence.blockers)
    if (hostCapabilityEvidence.ok !== (hostCapabilityEvidence.blockers.length === 0
      && hostCapabilityEvidence.capabilities_used.every((receipt) => receipt.status === 'passed'))) {
      blockers.push('host_capability_evidence_status_inconsistent')
    }
  }
  for (const blocker of input.additionalBlockers || []) {
    const normalized = String(blocker || '').trim()
    if (normalized) blockers.push(normalized)
  }

  const uniqueBlockers = uniqueStrings(blockers)
  const ok = uniqueBlockers.length === 0
  const status: SubagentEvidence['status'] = preparationOnly
    ? 'preparation_only'
    : ok
      ? 'completed'
      : failedThreadIds.length > 0 || hostCapabilityBlockers.length > 0 || Boolean(hostCapabilityEvidence && !hostCapabilityEvidence.ok)
        ? 'blocked'
        : 'incomplete'

  return {
    schema: SUBAGENT_EVIDENCE_SCHEMA,
    workflow: 'official_codex_subagent',
    requested_subagents: requestedSubagents,
    count_policy: countPolicy,
    target_subagents: targetSubagents,
    started_threads: startedThreadIds.length,
    completed_threads: completedThreadIds.length,
    failed_threads: failedThreadIds.length,
    started_thread_ids: startedThreadIds,
    completed_thread_ids: completedThreadIds,
    failed_thread_ids: failedThreadIds,
    open_thread_ids: openThreadIds,
    unmatched_stop_thread_ids: [...unmatchedStops].sort(),
    event_sources: [...eventSources].sort(eventSourceOrder),
    parent_summary_present: parentSummaryPresent,
    parent_summary_trustworthy: parentSummaryTrustworthy,
    parent_summary_status: parentSummary.status,
    ambiguous_stop_thread_ids: [...ambiguousStops].sort(),
    run_id: runScope.runId,
    run_epoch: runScope.runEpoch,
    run_scope_source: runScope.source,
    rejected_stale_events: scopedEvents.staleEvents.length,
    rejected_stale_thread_ids: uniqueStrings(scopedEvents.staleEvents.map((event) => event.thread_id || '')).sort(),
    unbound_run_events: scopedEvents.unboundEvents.length,
    preparation_only: preparationOnly,
    status,
    ok,
    blockers: uniqueBlockers,
    ...(hostCapabilityEvidence ? { host_capability_evidence: hostCapabilityEvidence } : {})
  }
}

export async function recordSubagentEvent(
  artifactDir: string,
  payload: unknown,
  explicitEventName?: unknown
): Promise<NormalizedSubagentEvent | null> {
  const event = normalizeSubagentEvent(payload, explicitEventName)
  if (!event) return null
  await appendJsonlBounded(path.join(artifactDir, SUBAGENT_EVENT_LOG_FILENAME), event, 1024 * 1024)
  return event
}

export async function readSubagentEvents(artifactDir: string): Promise<NormalizedSubagentEvent[]> {
  const text = await fsp.readFile(path.join(artifactDir, SUBAGENT_EVENT_LOG_FILENAME), 'utf8').catch(() => '')
  const events: NormalizedSubagentEvent[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const event = normalizeSubagentEvent(parsed)
    if (event) events.push(event)
  }
  return events
}

export async function writeSubagentEvidence(
  artifactDir: string,
  input: BuildSubagentEvidenceInput
): Promise<SubagentEvidence> {
  const events = input.events ?? await readSubagentEvents(artifactDir)
  const evidence = buildSubagentEvidence({ ...input, events })
  await writeJsonAtomic(path.join(artifactDir, SUBAGENT_EVIDENCE_FILENAME), evidence)
  return evidence
}

export async function persistOrReuseTrustworthySubagentParentSummary(
  artifactDir: string,
  value: unknown,
  opts: { workflowStatus?: string | null; runId?: string | null } = {}
): Promise<unknown> {
  const incoming = normalizeSubagentParentSummary(value)
  const file = path.join(artifactDir, SUBAGENT_PARENT_SUMMARY_FILENAME)
  const workflowFailed = isFailureWorkflowStatus(opts.workflowStatus)
  const activeRunId = firstText(opts.runId)
  const incomingMatchesActiveRun = !activeRunId || !incoming.run_id || incoming.run_id === activeRunId
  if (incoming.trustworthy && incoming.status === 'failed' && incoming.raw && incomingMatchesActiveRun) {
    await writeJsonAtomic(file, incoming.raw)
    return incoming.raw
  }
  if (workflowFailed || incoming.status === 'failed' || parentResultExplicitlyFailed(value)) {
    const persisted = normalizeSubagentParentSummary(
      await reuseMatchingPersistedParentSummary(file, activeRunId, null)
    )
    const incomingContradictsFailure = incoming.trustworthy
      && incoming.status === 'completed'
      && incomingMatchesActiveRun
    if (!incomingContradictsFailure
      && persisted.trustworthy
      && persisted.status === 'failed'
      && persisted.raw) {
      return persisted.raw
    }
    await fsp.rm(file, { force: true }).catch(() => undefined)
    if (workflowFailed && incoming.trustworthy && incoming.status === 'completed') return null
    return value
  }
  if (incoming.trustworthy && incoming.raw) {
    if (!incomingMatchesActiveRun) return reuseMatchingPersistedParentSummary(file, activeRunId, value)
    await writeJsonAtomic(file, incoming.raw)
    return incoming.raw
  }
  return reuseMatchingPersistedParentSummary(file, activeRunId, value)
}

export function bindTrustworthySubagentParentSummaryToRun(value: unknown, runId: unknown): unknown {
  const normalizedRunId = firstText(runId)
  if (!normalizedRunId) return value
  const summary = normalizeSubagentParentSummary(value)
  if (!summary.trustworthy || !summary.raw) return value
  if (summary.run_id && summary.run_id !== normalizedRunId) return null
  return summary.run_id
    ? summary.raw
    : { ...summary.raw, run_id: normalizedRunId }
}

async function reuseMatchingPersistedParentSummary(file: string, activeRunId: string, fallback: unknown): Promise<unknown> {
  const persisted = await fsp.readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null)
  const previous = normalizeSubagentParentSummary(persisted)
  if (!previous.trustworthy || !previous.raw) return fallback
  if (activeRunId && previous.run_id !== activeRunId) return fallback
  return previous.raw
}

export const normalizeSubagentEvidence = buildSubagentEvidence

function normalizeEventName(value: unknown): SubagentEventName | null {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z]+/g, '')
  if (normalized === 'subagentstart') return 'SubagentStart'
  if (normalized === 'subagentstop') return 'SubagentStop'
  return null
}

function normalizePersistedOutcome(value: unknown, eventName: SubagentEventName): NormalizedSubagentEvent['outcome'] | null {
  const normalized = String(value || '').trim().toLowerCase()
  if (eventName === 'SubagentStart') return normalized === 'started' ? 'started' : null
  if (normalized === 'stopped' || normalized === 'failed' || normalized === 'ambiguous') return normalized
  return null
}

function stopFailed(row: Record<string, unknown>): boolean {
  const status = firstText(row.status, row.outcome, row.result, row.state).toLowerCase()
  const resultText = firstText(
    row.last_assistant_message,
    row.lastAssistantMessage,
    row.summary,
    row.message,
    row.result_text,
    row.resultText
  )
  return row.ok === false
    || row.success === false
    || row.failed === true
    || Boolean(row.error)
    || /^(failed|failure|error|blocked|cancelled|canceled|interrupted|timed[_ -]?out)$/.test(status)
    || containsUnambiguousFailureText(resultText)
}

function stopAmbiguous(row: Record<string, unknown>): boolean {
  const resultText = firstText(
    row.last_assistant_message,
    row.lastAssistantMessage,
    row.summary,
    row.message,
    row.result_text,
    row.resultText
  )
  return containsAmbiguousOutcomeText(resultText)
}

export function normalizeSubagentParentSummary(value: unknown): {
  present: boolean
  trustworthy: boolean
  status: 'completed' | 'failed' | 'ambiguous' | null
  summary: string | null
  run_id: string | null
  run_epoch: string | null
  thread_outcomes: Map<string, 'completed' | 'failed' | 'ambiguous'>
  blockers: string[]
  raw: StructuredSubagentParentSummary | null
} {
  const present = hasMeaningfulSummary(value)
  const parsed = parseStructuredParentSummary(value)
  const threadOutcomes = new Map<string, 'completed' | 'failed' | 'ambiguous'>()
  const blockers: string[] = []
  if (!parsed) {
    if (present) blockers.push('parent_summary_untrusted')
    return {
      present,
      trustworthy: false,
      status: present ? 'ambiguous' : null,
      summary: null,
      run_id: null,
      run_epoch: null,
      thread_outcomes: threadOutcomes,
      blockers,
      raw: null
    }
  }

  const summary = String(parsed.summary || '').trim()
  if (typeof parsed.summary !== 'string' || !summary) blockers.push('parent_summary_text_missing')
  const topLevelKeys = new Set([
    'schema',
    'status',
    'summary',
    'thread_outcomes',
    'changed_files',
    'verification',
    'blockers',
    'run_id',
    'run_epoch',
    'artifacts',
    'capabilities_used'
  ])
  for (const key of Object.keys(parsed as any)) {
    if (!topLevelKeys.has(key)) blockers.push(`parent_summary_unknown_field:${key}`)
  }
  if (parsed.changed_files !== undefined && (!Array.isArray(parsed.changed_files) || parsed.changed_files.some((item) => typeof item !== 'string'))) {
    blockers.push('parent_summary_changed_files_invalid')
  }
  if (parsed.verification !== undefined && !Array.isArray(parsed.verification)) blockers.push('parent_summary_verification_invalid')
  const changedFiles = Array.isArray(parsed.changed_files)
    ? parsed.changed_files.map((item) => String(item || '').trim()).filter(Boolean)
    : []
  if (changedFiles.length > 0 && !hasFocusedParentVerification(parsed.verification)) {
    blockers.push('parent_summary_verification_missing')
  }
  if (parsed.blockers !== undefined && (!Array.isArray(parsed.blockers) || parsed.blockers.some((item) => typeof item !== 'string'))) {
    blockers.push('parent_summary_blockers_invalid')
  }
  const parentArtifacts = validateParentArtifactReceipts(parsed.artifacts, blockers)
  const parentCapabilities = validateParentCapabilityUseReceipts(parsed.capabilities_used, blockers)
  if (!Array.isArray(parsed.thread_outcomes) || parsed.thread_outcomes.length === 0) {
    blockers.push('parent_thread_outcomes_missing')
  }
  for (const row of Array.isArray(parsed.thread_outcomes) ? parsed.thread_outcomes : []) {
    if (!isRecord(row)) {
      blockers.push('parent_thread_outcome_invalid')
      continue
    }
    const rowKeys = new Set(['thread_id', 'status', 'summary'])
    for (const key of Object.keys(row)) {
      if (!rowKeys.has(key)) blockers.push(`parent_thread_outcome_unknown_field:${key}`)
    }
    const threadId = firstText(row?.thread_id)
    const status = strictTerminalOutcome(row?.status)
    const rowSummary = typeof row?.summary === 'string' ? row.summary.trim() : ''
    if (!threadId) {
      blockers.push('parent_thread_outcome_thread_id_missing')
      continue
    }
    if (threadOutcomes.has(threadId)) {
      blockers.push(`parent_thread_outcome_duplicate:${threadId}`)
      continue
    }
    threadOutcomes.set(threadId, status)
    if (status === 'ambiguous') blockers.push(`parent_thread_outcome_ambiguous:${threadId}`)
    if (!rowSummary) blockers.push(`parent_thread_outcome_summary_missing:${threadId}`)
    if (status === 'completed' && containsFailedOrAmbiguousOutcomeText(rowSummary)) {
      blockers.push(`parent_thread_outcome_text_contradiction:${threadId}`)
    }
  }

  const status = strictTerminalOutcome(parsed.status)
  if (status === 'ambiguous') blockers.push('parent_summary_status_ambiguous')
  if (status === 'completed' && containsFailedOrAmbiguousOutcomeText(summary)) blockers.push('parent_summary_text_contradiction')
  if (status === 'completed' && Array.isArray(parsed.blockers) && parsed.blockers.length > 0) {
    blockers.push('parent_summary_completed_with_blockers')
  }
  if (status === 'completed') {
    for (const receipt of parentCapabilities || []) {
      if (receipt.status !== 'passed') blockers.push(`parent_summary_capability_not_passed:${receipt.id}`)
    }
  }
  const raw = {
    ...parsed,
    ...(parsed.artifacts === undefined ? {} : { artifacts: parentArtifacts || [] }),
    ...(parsed.capabilities_used === undefined ? {} : { capabilities_used: parentCapabilities || [] })
  }
  return {
    present: true,
    trustworthy: blockers.length === 0,
    status,
    summary: summary || null,
    run_id: firstText(parsed.run_id) || null,
    run_epoch: firstText(parsed.run_epoch) || null,
    thread_outcomes: threadOutcomes,
    blockers: uniqueStrings(blockers.length ? blockers : []),
    raw
  }
}

function parseStructuredParentSummary(value: unknown): StructuredSubagentParentSummary | null {
  if (isRecord(value)) return validStructuredParentSummary(value)
  if (typeof value !== 'string' || !value.trim()) return null
  const trimmed = value.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1]?.trim()
  const candidates = [trimmed, ...(fenced ? [fenced] : [])]
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      const valid = validStructuredParentSummary(parsed)
      if (valid) return valid
    } catch {}
  }
  return null
}

function validStructuredParentSummary(value: unknown): StructuredSubagentParentSummary | null {
  if (!isRecord(value) || value.schema !== SUBAGENT_PARENT_SUMMARY_SCHEMA) return null
  if (!Array.isArray(value.thread_outcomes)) return null
  return value as unknown as StructuredSubagentParentSummary
}

function validateParentArtifactReceipts(value: unknown, blockers: string[]): HostArtifactReceipt[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    blockers.push('parent_summary_artifacts_invalid')
    return undefined
  }
  if (value.length > MAX_PARENT_ARTIFACTS) blockers.push('parent_summary_artifacts_too_many')
  const result: HostArtifactReceipt[] = []
  const seen = new Set<string>()
  for (const row of value.slice(0, MAX_PARENT_ARTIFACTS)) {
    if (!isRecord(row)) {
      blockers.push('parent_summary_artifact_invalid')
      continue
    }
    const artifactPath = normalizeParentArtifactPath(row.path)
    const kind = boundedParentToken(row.kind, 64, /^[a-z][a-z0-9_-]*$/)
    const mediaType = boundedParentToken(
      row.media_type,
      160,
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
    )
    const receiptHash = typeof row.sha256 === 'string' && SHA256_RECEIPT_PATTERN.test(row.sha256)
      ? row.sha256
      : null
    const bytes = typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0
      ? row.bytes
      : null
    const role = typeof row.role === 'string' && ARTIFACT_ROLES.has(row.role as HostArtifactReceipt['role'])
      ? row.role as HostArtifactReceipt['role']
      : null
    if (!artifactPath) blockers.push('parent_summary_artifact_path_invalid')
    if (!kind) blockers.push('parent_summary_artifact_kind_invalid')
    if (!mediaType) blockers.push('parent_summary_artifact_media_type_invalid')
    if (!receiptHash) blockers.push('parent_summary_artifact_sha256_invalid')
    if (bytes === null) blockers.push('parent_summary_artifact_bytes_invalid')
    if (!role) blockers.push('parent_summary_artifact_role_invalid')
    if (!artifactPath || !kind || !mediaType || !receiptHash || bytes === null || !role) continue
    if (seen.has(artifactPath)) {
      blockers.push('parent_summary_artifact_path_duplicate')
      continue
    }
    seen.add(artifactPath)
    result.push({ path: artifactPath, kind, media_type: mediaType, sha256: receiptHash, bytes, role })
  }
  return result
}

function validateParentCapabilityUseReceipts(value: unknown, blockers: string[]): HostCapabilityUseReceipt[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    blockers.push('parent_summary_capabilities_used_invalid')
    return undefined
  }
  if (value.length > MAX_PARENT_CAPABILITY_USES) blockers.push('parent_summary_capabilities_used_too_many')
  const result: HostCapabilityUseReceipt[] = []
  const seen = new Set<string>()
  for (const row of value.slice(0, MAX_PARENT_CAPABILITY_USES)) {
    if (!isRecord(row)) {
      blockers.push('parent_summary_capability_use_invalid')
      continue
    }
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    const descriptor = HOST_CAPABILITY_BY_ID.get(id)
    const status = row.status === 'passed' || row.status === 'failed' ? row.status : null
    const toolNames = normalizeParentCapabilityToolNames(row.tool_names, descriptor?.tool_names || [], status)
    const receiptHash = typeof row.receipt_sha256 === 'string' && SHA256_RECEIPT_PATTERN.test(row.receipt_sha256)
      ? row.receipt_sha256
      : null
    if (!descriptor) blockers.push(`parent_summary_capability_use_unknown:${id || '<missing>'}`)
    if (!status) blockers.push('parent_summary_capability_use_status_invalid')
    if (!toolNames) blockers.push('parent_summary_capability_use_tool_names_invalid')
    if (!receiptHash) blockers.push('parent_summary_capability_use_receipt_sha256_invalid')
    if (!descriptor || !status || !toolNames || !receiptHash) continue
    if (seen.has(id)) {
      blockers.push(`parent_summary_capability_use_duplicate:${id}`)
      continue
    }
    seen.add(id)
    result.push({ id, status, tool_names: toolNames, receipt_sha256: receiptHash })
  }
  return result
}

function normalizeParentArtifactPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const original = value.trim()
  if (!original || original.length > MAX_PARENT_ARTIFACT_PATH_CHARS || /[\r\n\0\\]/.test(original)) return null
  if (path.posix.isAbsolute(original) || path.win32.isAbsolute(original)) return null
  const normalized = path.posix.normalize(original).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null
  return normalized.length <= MAX_PARENT_ARTIFACT_PATH_CHARS ? normalized : null
}

function normalizeParentCapabilityToolNames(
  value: unknown,
  allowed: readonly string[],
  status: HostCapabilityUseReceipt['status'] | null
): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_PARENT_CAPABILITY_TOOL_NAMES) return null
  if (status === 'passed' && value.length === 0) return null
  const allowedSet = new Set(allowed)
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const tool = boundedParentToken(item, 128, /^[A-Za-z][A-Za-z0-9_.:-]*$/)
    if (!tool || !allowedSet.has(tool) || seen.has(tool)) return null
    seen.add(tool)
    result.push(tool)
  }
  return result
}

function boundedParentToken(value: unknown, maxChars: number, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  return text && text.length <= maxChars && !/[\r\n\0]/.test(text) && pattern.test(text) ? text : null
}

function normalizeTrustedHostCapabilityEvidence(value: unknown): HostCapabilityExecutionEvidence | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_EVIDENCE_SCHEMA
    || typeof value.ok !== 'boolean'
    || !isRecord(value.runtime)
    || value.runtime.schema !== HOST_CAPABILITY_RUNTIME_SCHEMA
    || value.runtime.server !== 'acas-tools'
    || value.runtime.capability_digest !== hostCapabilityDigest(HOST_CAPABILITY_DESCRIPTORS)
    || !Array.isArray(value.runtime.requested_capability_ids)
    || value.runtime.requested_capability_ids.some((id) => typeof id !== 'string' || !HOST_CAPABILITY_BY_ID.has(id))
    || new Set(value.runtime.requested_capability_ids).size !== value.runtime.requested_capability_ids.length
    || !Array.isArray(value.tool_calls)
    || !Array.isArray(value.capabilities_used)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.artifact_sources)
    || !Array.isArray(value.blockers)
    || value.blockers.some((blocker) => typeof blocker !== 'string')) {
    return null
  }
  const validationBlockers: string[] = []
  const capabilities = validateParentCapabilityUseReceipts(value.capabilities_used, validationBlockers)
  const artifacts = validateParentArtifactReceipts(value.artifacts, validationBlockers)
  if (!capabilities || !artifacts || validationBlockers.length > 0) return null
  const knownTools = new Set(HOST_CAPABILITY_DESCRIPTORS.flatMap((descriptor) => descriptor.tool_names))
  if (value.tool_calls.length > 1024 || value.tool_calls.some((row) => {
    if (!isRecord(row)) return true
    return row.server !== 'acas-tools'
      || typeof row.tool !== 'string'
      || !knownTools.has(row.tool)
      || (row.status !== 'passed' && row.status !== 'failed')
      || typeof row.event_sha256 !== 'string'
      || !SHA256_RECEIPT_PATTERN.test(row.event_sha256)
  })) return null
  const evidence = {
    ...value,
    capabilities_used: capabilities,
    artifacts,
    artifact_sources: value.artifact_sources
  } as unknown as HostCapabilityExecutionEvidence
  return trustedHostCapabilityReceiptBindingBlockers(evidence).length === 0 ? evidence : null
}

function validateParentHostCapabilityBinding(
  parent: StructuredSubagentParentSummary | null,
  evidence: HostCapabilityExecutionEvidence | null
): string[] {
  const parentClaims = hasNonEmptyHostCapabilityClaim(parent?.artifacts)
    || hasNonEmptyHostCapabilityClaim(parent?.capabilities_used)
  if (!evidence) return parentClaims ? ['parent_summary_host_capability_evidence_missing'] : []
  const bindingRequired = parentClaims
    || evidence.runtime.requested_capability_ids.length > 0
    || evidence.tool_calls.length > 0
    || evidence.artifacts.length > 0
  if (!bindingRequired) return []
  const blockers: string[] = []
  const artifactBlockers: string[] = []
  const capabilityBlockers: string[] = []
  const parentArtifacts = validateParentArtifactReceipts(parent?.artifacts, artifactBlockers)
  const parentCapabilities = validateParentCapabilityUseReceipts(parent?.capabilities_used, capabilityBlockers)
  if (artifactBlockers.length > 0 || JSON.stringify(parentArtifacts || []) !== JSON.stringify(evidence.artifacts)) {
    blockers.push('parent_summary_host_artifacts_mismatch')
  }
  if (capabilityBlockers.length > 0 || JSON.stringify(parentCapabilities || []) !== JSON.stringify(evidence.capabilities_used)) {
    blockers.push('parent_summary_host_capabilities_mismatch')
  }
  return blockers
}

function hasNonEmptyHostCapabilityClaim(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined
}

function hasFocusedParentVerification(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((row) => {
    if (!isRecord(row)) return false
    const status = String(row.status || '').trim().toLowerCase()
    if (status === 'not_applicable') return Boolean(firstText(row.reason))
    if (status !== 'passed') return false
    return Boolean(firstText(row.name, row.check, row.command))
  })
}

function strictTerminalOutcome(value: unknown): 'completed' | 'failed' | 'ambiguous' {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'completed') return 'completed'
  if (status === 'blocked' || status === 'failed') return 'failed'
  return 'ambiguous'
}

function containsUnambiguousFailureText(value: unknown): boolean {
  const source = String(value || '').trim()
  if (!source) return false
  const scrubbed = source
    .replace(/\b(?:no|without)\s+(?:errors?|failures?|blockers?|issues?)\b/gi, ' ')
    .replace(/\bno\s+(?:\d+\s+)?(?:tests?|suites?|checks?|cases?)\s+(?:failed|failing|errored)\b/gi, ' ')
    .replace(/\bnot\s+blocked\b/gi, ' ')
    .replace(/\b(?:did\s+not|didn't)\s+fail\b/gi, ' ')
    .replace(/\b(?:type\s*check|typecheck|build|compilation|compile|compiler|npm\s+test|tests?|test\s+suites?)\s+(?:did\s+not|didn't)\s+fail\b/gi, ' ')
    .replace(/\b(?:failed|failure|error|blocked)[- ]paths?\b/gi, ' ')
    .replace(/\b(?:could\s+not|unable\s+to)\s+(?:reproduce|find|detect|observe|identify)\b[^.!?\n]*/gi, ' ')
    .replace(/(?:실패한|차단된|오류(?:가|는)?\s*발생한?)\s*(?:테스트|검사|항목|문제)(?:가|이|는|은)?\s*(?:없음|없다|없습니다)/g, ' ')
    .replace(/(?:실패|오류|에러|차단|문제)(?:가|이|는|은)?\s*(?:없음|없다|없습니다|없이)/g, ' ')
    .replace(/차단되지\s*않(?:음|았다|았습니다)/g, ' ')
  return /^(?:failed|failure|error|blocked|cancelled|canceled|interrupted|timed\s*out|incomplete)\b/i.test(scrubbed)
    || /\b\d+\s+(?:tests?|suites?|checks?|cases?)\s+(?:failed|failing|errored)\b/i.test(scrubbed)
    || /\b(?:type\s*check|typecheck|build|compilation|compile|compiler|npm\s+test|npm\s+run\s+(?:test|build|typecheck)|tests?|test\s+suites?|lint|verification)\b[^.!?\n]{0,40}\b(?:failed|failing|failure|errored|errors?)\b/i.test(scrubbed)
    || /\b(?:compilation|compiler|typescript|tsc)\s+error(?:\s+TS\d+)?\b/i.test(scrubbed)
    || /\berror\s+TS\d+\b/i.test(scrubbed)
    || /\b(?:slice|thread|task|work|review|integration|execution|run|job|agent|subagent)\b[^.!?\n]{0,32}\b(?:failed|blocked|cancelled|canceled|interrupted|timed\s*out|not\s+completed|incomplete)\b/i.test(scrubbed)
    || /\b(?:could\s+not|unable\s+to|failed\s+to)\s+(?:complete|finish|deliver|execute|run|continue|return)\b/i.test(scrubbed)
    || /(?:작업|슬라이스|스레드|검수|통합|실행|에이전트|서브\s*에이전트)[^.!?\n]{0,20}(?:실패|차단|중단|미완료)/i.test(scrubbed)
    || /(?:완료|수행|실행|진행|통합)하지\s*못|완료되지\s*않|미완료/i.test(scrubbed)
}

function containsAmbiguousOutcomeText(value: unknown): boolean {
  const source = String(value || '').trim()
  if (!source) return false
  const completedReadOnlyReview = (
    /\bread[- ]only\b[^.!?\n]{0,180}\b(?:review|inspection|audit)\b[^.!?\n]{0,180}\b(?:covered|completed|finished)\b/i.test(source)
      || /읽기\s*전용[^.!?\n]{0,180}(?:검수|검토|감사)[^.!?\n]{0,180}(?:완료|점검|확인)/i.test(source)
  ) && (
    /\bno files? (?:were )?(?:changed|modified)\b/i.test(source)
      || /파일[^.!?\n]{0,40}(?:변경|수정)(?:하지\s*않|없)/i.test(source)
  )
  const ambiguitySource = completedReadOnlyReview
    ? source
      .replace(/\bno tests? (?:were )?(?:run|executed)\b/gi, ' ')
      .replace(/\btests? (?:were )?not (?:run|executed)\b/gi, ' ')
      .replace(/테스트[^.!?\n]{0,20}(?:미실행|실행하지\s*않)/gi, ' ')
    : source
  const scrubbed = ambiguitySource
    .replace(/\bno\s+(?:remaining\s+)?(?:unknowns?|ambiguities|pending\s+(?:checks?|work)|unverified\s+(?:checks?|work|gaps?))\b/gi, ' ')
    .replace(/\bnot\s+(?:pending|unknown|unclear|ambiguous|inconclusive)\b/gi, ' ')
  return /\b(?:tests?|test\s+suites?|checks?|type\s*check|typecheck|build|lint|verification)\b[^.!?\n]{0,32}\b(?:not\s+(?:run|executed|verified|completed)|pending|unknown|unclear|ambiguous|inconclusive)\b/i.test(scrubbed)
    || /\b(?:could\s+not|unable\s+to|failed\s+to)\s+(?:verify|confirm|determine)\b/i.test(scrubbed)
    || /\b(?:result|status|outcome)\b[^.!?\n]{0,20}\b(?:unknown|unclear|ambiguous|pending|inconclusive)\b/i.test(scrubbed)
    || /\b(?:partially|partly)\s+(?:completed|verified|tested)\b/i.test(scrubbed)
    || /(?:테스트|검사|타입\s*체크|빌드|검증)[^.!?\n]{0,16}(?:미실행|미검증|보류|불명확|알\s*수\s*없|확인하지\s*못)/i.test(scrubbed)
}

function containsFailedOrAmbiguousOutcomeText(value: unknown): boolean {
  return containsUnambiguousFailureText(value) || containsAmbiguousOutcomeText(value)
}

function parentResultExplicitlyFailed(value: unknown): boolean {
  if (typeof value === 'string') return containsUnambiguousFailureText(value)
  if (!isRecord(value)) return false
  const status = firstText(value.status, value.outcome, value.result, value.state).toLowerCase()
  const resultText = firstText(
    value.summary,
    value.message,
    value.last_assistant_message,
    value.lastAssistantMessage,
    value.result_text,
    value.resultText
  )
  return value.ok === false
    || value.success === false
    || value.failed === true
    || Boolean(value.error)
    || (Array.isArray(value.blockers) && value.blockers.length > 0)
    || /^(failed|failure|error|blocked|cancelled|canceled|interrupted|timed[_ -]?out|incomplete)$/.test(status)
    || containsUnambiguousFailureText(resultText)
}

function isFailureWorkflowStatus(value: unknown): boolean {
  return /^(parent_failed|host_capability_blocked|failed|blocked|incomplete|cancelled|canceled|timed[_ -]?out)$/i.test(String(value || '').trim())
}

interface ResolvedRunScope {
  runId: string | null
  runEpoch: string | null
  source: SubagentEvidence['run_scope_source']
  blockers: string[]
  parentBlockers: string[]
}

function resolveRunScope(
  input: BuildSubagentEvidenceInput,
  events: readonly NormalizedSubagentEvent[],
  parentSummary: ReturnType<typeof normalizeSubagentParentSummary>
): ResolvedRunScope {
  const requestedRunId = firstText(input.runId)
  const requestedRunEpoch = firstText(input.runEpoch)
  const eventRunIds = uniqueStrings(events.map((event) => event.run_id || ''))
  const eventTurnIds = uniqueStrings(events.map((event) => event.turn_id || ''))
  const eventRunEpochs = uniqueStrings(events.map((event) => event.run_epoch || ''))
  const latestEventRunId = latestText(events, (event) => event.run_id)
  const latestEventTurnId = latestText(events, (event) => event.turn_id)
  const latestEventRunEpoch = latestText(events, (event) => event.run_epoch)
  const runId = requestedRunId || latestEventRunId || latestEventTurnId || parentSummary.run_id || null
  const runEpoch = requestedRunEpoch || latestEventRunEpoch || parentSummary.run_epoch || null
  const source: ResolvedRunScope['source'] = requestedRunId || requestedRunEpoch
    ? 'input'
    : latestEventRunId
      ? 'event_run_id'
      : latestEventTurnId
        ? 'event_turn_id'
        : parentSummary.run_id || parentSummary.run_epoch
          ? 'parent_summary'
          : latestEventRunEpoch
            ? 'event_run_epoch'
            : null
  const blockers: string[] = []
  const parentBlockers: string[] = []

  const parentRunBindingRequired = Boolean(parentSummary.run_id)
    || (source !== 'event_turn_id' && Boolean(requestedRunId || eventRunIds.length > 0))
  if (parentSummary.present && runId && parentRunBindingRequired) {
    if (!parentSummary.run_id) parentBlockers.push('parent_summary_run_id_missing')
    else if (parentSummary.run_id !== runId) parentBlockers.push('parent_summary_run_id_mismatch')
  }
  const parentEpochBindingRequired = Boolean(requestedRunEpoch || parentSummary.run_epoch || eventRunEpochs.length > 0)
  if (parentSummary.present && runEpoch && parentEpochBindingRequired) {
    if (!parentSummary.run_epoch) parentBlockers.push('parent_summary_run_epoch_missing')
    else if (parentSummary.run_epoch !== runEpoch) parentBlockers.push('parent_summary_run_epoch_mismatch')
  }

  return {
    runId,
    runEpoch,
    source,
    blockers,
    parentBlockers
  }
}

function scopeSubagentEvents(events: readonly NormalizedSubagentEvent[], scope: ResolvedRunScope): {
  events: NormalizedSubagentEvent[]
  staleEvents: NormalizedSubagentEvent[]
  unboundEvents: NormalizedSubagentEvent[]
} {
  const accepted: NormalizedSubagentEvent[] = []
  const staleEvents: NormalizedSubagentEvent[] = []
  const unboundEvents: NormalizedSubagentEvent[] = []
  for (const event of events) {
    const eventRunId = scope.source === 'event_turn_id'
      ? event.turn_id
      : scope.source === 'input' || scope.source === 'parent_summary'
        ? event.run_id || event.turn_id
        : event.run_id
    if ((scope.runId && !eventRunId) || (scope.runEpoch && !event.run_epoch)) {
      unboundEvents.push(event)
      continue
    }
    if ((scope.runId && eventRunId !== scope.runId) || (scope.runEpoch && event.run_epoch !== scope.runEpoch)) {
      staleEvents.push(event)
      continue
    }
    accepted.push(event)
  }
  if (unboundEvents.length > 0) scope.blockers.push(`subagent_events_run_scope_missing:${unboundEvents.length}`)
  return { events: accepted, staleEvents, unboundEvents }
}

function latestText<T>(values: readonly T[], pick: (value: T) => string | null): string {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = pick(values[index] as T)
    if (value) return value
  }
  return ''
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function normalizeRequested(value: unknown): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.floor(parsed))
}

function isPreparationStatus(value: unknown): boolean {
  return /^(delegation_context_ready|context_ready|prepared|preparation_only)$/.test(String(value || '').trim().toLowerCase())
}

function hasMeaningfulSummary(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return isRecord(value) && Object.keys(value).length > 0
}

function eventSourceOrder(a: SubagentEventName, b: SubagentEventName): number {
  return (a === 'SubagentStart' ? 0 : 1) - (b === 'SubagentStart' ? 0 : 1)
}

function recordId(value: unknown): unknown {
  return isRecord(value) ? value.id : undefined
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return ''
}
