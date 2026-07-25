import { constants as fsConstants } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { sha256 } from '../fsx.js'
import {
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_EVENT_LOG_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  buildSubagentEvidence,
  normalizeSubagentEvent,
  normalizeSubagentParentSummary,
  trustedHostCapabilityReceiptBindingBlockers
} from './subagent-evidence.js'
import {
  NARUTO_GATE_FILENAME,
  NARUTO_RESULT_SCHEMA,
  NARUTO_SUMMARY_FILENAME,
  SUBAGENT_PLAN_FILENAME
} from './official-subagent-preparation.js'
import {
  effectiveSubagentTarget,
  normalizeLegacySubagentCountFields,
  subagentCountContractBlockers
} from './wave-lifecycle.js'
import {
  HOST_CAPABILITY_DESCRIPTORS,
  hostCapabilityDigest
} from '../agent-bridge/agent-manifest.js'
import {
  HOST_CAPABILITY_EVIDENCE_SCHEMA,
  HOST_CAPABILITY_RUNTIME_SCHEMA,
  type HostCapabilityExecutionEvidence
} from '../agent-bridge/host-capability-runtime.js'
import { isRecord } from '../json/records.js'
import { uniqueStrings } from '../text/strings.js'

export const NARUTO_PROOF_ARTIFACT_FILENAMES = Object.freeze([
  SUBAGENT_PLAN_FILENAME,
  SUBAGENT_EVENT_LOG_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  SUBAGENT_EVIDENCE_FILENAME,
  NARUTO_SUMMARY_FILENAME,
  NARUTO_GATE_FILENAME
] as const)

export type NarutoProofStatus = 'completed' | 'blocked' | 'incomplete'

type NarutoProofArtifactFilename = typeof NARUTO_PROOF_ARTIFACT_FILENAMES[number]

export interface NarutoProofVerification {
  name: string
  status: 'passed' | 'failed' | 'blocked' | 'skipped' | 'pending' | 'unknown' | 'reported'
}

export interface NarutoProofArtifactReceipt {
  path: string
  kind: string
  media_type: string
  sha256: string
  bytes: number
  role: 'deliverable' | 'scratch' | 'temp' | 'log'
}

export interface NarutoProofCapabilityUse {
  id: string
  status: 'passed' | 'failed'
  tool_names: string[]
  receipt_sha256: string
}

export interface NarutoProofResult {
  summary: string
  changed_files: string[]
  verification: NarutoProofVerification[]
  artifacts?: NarutoProofArtifactReceipt[]
  capabilities_used?: NarutoProofCapabilityUse[]
}

export interface NarutoProofArtifactSnapshot {
  bytes: Record<NarutoProofArtifactFilename, Buffer | null>
  byte_hashes: Record<NarutoProofArtifactFilename, string | null>
  read_blockers: string[]
}

export interface NarutoProofProjection {
  schema: typeof NARUTO_RESULT_SCHEMA
  action: 'proof'
  ok: boolean
  status: NarutoProofStatus
  mission_id: string
  workflow: 'official_codex_subagent'
  workflow_run_id: string | null
  blockers: string[]
  evidence: unknown
  summary: unknown
  gate: unknown
  result: NarutoProofResult
  proof_fingerprint: string
}

const MAX_RESULT_SUMMARY_CHARS = 4096
const MAX_CHANGED_FILES = 256
const MAX_CHANGED_FILE_CHARS = 512
const MAX_VERIFICATION_ROWS = 32
const MAX_VERIFICATION_NAME_CHARS = 240
const MAX_ARTIFACTS = 64
const MAX_ARTIFACT_PATH_CHARS = 512
const MAX_ARTIFACT_KIND_CHARS = 64
const MAX_MEDIA_TYPE_CHARS = 160
const MAX_CAPABILITY_USES = 64
const MAX_CAPABILITY_ID_CHARS = 160
const MAX_CAPABILITY_TOOL_NAMES = 64
const MAX_CAPABILITY_TOOL_NAME_CHARS = 128
const MAX_CANONICAL_PROOF_ARTIFACT_BYTES = 4 * 1024 * 1024
const MAX_CANONICAL_PROOF_AGGREGATE_BYTES = 16 * 1024 * 1024
const MAX_DELIVERABLE_ARTIFACT_BYTES = 128 * 1024 * 1024
const MAX_DELIVERABLE_ARTIFACT_AGGREGATE_BYTES = 512 * 1024 * 1024
const SHA256_RECEIPT_PATTERN = /^sha256:[a-f0-9]{64}$/
const ARTIFACT_ROLES = new Set<NarutoProofArtifactReceipt['role']>(['deliverable', 'scratch', 'temp', 'log'])
const NON_DELIVERABLE_ARTIFACT_KINDS = new Set(['scratch', 'temp', 'tmp', 'log'])
const NON_DELIVERABLE_PATH_SEGMENTS = new Set(['scratch', 'temp', 'tmp', 'log', 'logs'])
const ARTIFACT_RECEIPT_KEYS = new Set(['path', 'kind', 'media_type', 'sha256', 'bytes', 'role'])
const CAPABILITY_USE_KEYS = new Set(['id', 'status', 'tool_names', 'receipt_sha256'])
const HOST_CAPABILITY_BY_ID = new Map(HOST_CAPABILITY_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor]))
const INCOMPLETE_BLOCKER_PATTERNS = [
  /^proof_artifact_missing:/,
  /^requested_subagent_(?:starts|completions)_incomplete:/,
  /^subagent_threads_still_open:/,
  /^parent_summary_missing$/,
  /^subagent_workflow_preparation_only$/,
  /^official_subagent_execution_pending_in_current_parent$/
]

export async function readNarutoProofArtifactSnapshot(artifactDir: string): Promise<NarutoProofArtifactSnapshot> {
  const rows = await Promise.all(NARUTO_PROOF_ARTIFACT_FILENAMES.map(async (filename) => {
    try {
      const file = path.join(artifactDir, filename)
      const stat = await fsp.stat(file)
      if (!stat.isFile()) return { filename, bytes: null, blocker: `proof_artifact_unreadable:${filename}` }
      if (stat.size > MAX_CANONICAL_PROOF_ARTIFACT_BYTES) {
        return { filename, bytes: null, blocker: `proof_artifact_too_large:${filename}` }
      }
      return { filename, bytes: await fsp.readFile(file), blocker: null }
    } catch (error: unknown) {
      const code = errorCode(error)
      return {
        filename,
        bytes: null,
        blocker: code === 'ENOENT'
          ? `proof_artifact_missing:${filename}`
          : `proof_artifact_unreadable:${filename}`
      }
    }
  }))
  const bytes = {} as Record<NarutoProofArtifactFilename, Buffer | null>
  const byteHashes = {} as Record<NarutoProofArtifactFilename, string | null>
  const blockers: string[] = []
  let aggregateBytes = 0
  for (const row of rows) {
    bytes[row.filename] = row.bytes
    byteHashes[row.filename] = row.bytes ? `sha256:${sha256(row.bytes)}` : null
    aggregateBytes += row.bytes?.length || 0
    if (row.blocker) blockers.push(row.blocker)
  }
  if (aggregateBytes > MAX_CANONICAL_PROOF_AGGREGATE_BYTES) blockers.push('proof_artifacts_aggregate_too_large')
  return { bytes, byte_hashes: byteHashes, read_blockers: blockers }
}

export async function buildNarutoProofProjection(input: {
  artifactDir: string
  missionId: string
  workspaceRoot?: string
}): Promise<NarutoProofProjection> {
  const snapshot = await readNarutoProofArtifactSnapshot(input.artifactDir)
  const projected = projectNarutoProofSnapshot({ snapshot, missionId: input.missionId })
  if (!projected.result.artifacts?.length) return projected
  const artifactBlockers = await verifyProjectedArtifactFiles({
    artifacts: projected.result.artifacts,
    artifactDir: input.artifactDir,
    workspaceRoot: input.workspaceRoot
  })
  if (artifactBlockers.length === 0) return projected
  return projectNarutoProofSnapshot({
    snapshot: {
      ...snapshot,
      read_blockers: [...snapshot.read_blockers, ...artifactBlockers]
    },
    missionId: input.missionId
  })
}

export function projectNarutoProofSnapshot(input: {
  snapshot: NarutoProofArtifactSnapshot
  missionId: string
}): NarutoProofProjection {
  const missionId = String(input.missionId || '').trim()
  const readBlockers = input.snapshot.read_blockers
  const blockers = Array.isArray(readBlockers)
    ? readBlockers.filter((blocker): blocker is string => typeof blocker === 'string')
    : ['proof_read_blockers_invalid']
  if (Array.isArray(readBlockers) && blockers.length !== readBlockers.length) blockers.push('proof_read_blockers_invalid')
  const plan = parseJsonArtifact(input.snapshot, SUBAGENT_PLAN_FILENAME, blockers)
  const parentSummaryValue = parseJsonArtifact(input.snapshot, SUBAGENT_PARENT_SUMMARY_FILENAME, blockers)
  const persistedEvidence = normalizeLegacySubagentCountFields(parseJsonArtifact(input.snapshot, SUBAGENT_EVIDENCE_FILENAME, blockers), isRecord(plan) ? plan : null)
  const receiptProjectedPersistedEvidence = projectReceiptAdditiveFields(
    SUBAGENT_EVIDENCE_FILENAME,
    persistedEvidence
  )
  const trustedHostCapabilityEvidence = projectTrustedHostCapabilityEvidence(
    recordValue(receiptProjectedPersistedEvidence, 'host_capability_evidence'),
    blockers
  )
  const projectedPersistedEvidence = isRecord(receiptProjectedPersistedEvidence) && trustedHostCapabilityEvidence
    ? { ...receiptProjectedPersistedEvidence, host_capability_evidence: trustedHostCapabilityEvidence }
    : receiptProjectedPersistedEvidence
  const summary = normalizeLegacySubagentCountFields(parseJsonArtifact(input.snapshot, NARUTO_SUMMARY_FILENAME, blockers), isRecord(plan) ? plan : null)
  const gate = normalizeLegacySubagentCountFields(parseJsonArtifact(input.snapshot, NARUTO_GATE_FILENAME, blockers), isRecord(plan) ? plan : null)
  const events = parseJsonlArtifact(input.snapshot, blockers)
  const workflowRunId = firstText(recordValue(plan, 'workflow_run_id')) || null

  validateArtifactIdentities({ missionId, workflowRunId, plan, persistedEvidence, summary, gate }, blockers)
  const normalizedParentSummary = normalizeSubagentParentSummary(parentSummaryValue)
  if (parentSummaryValue !== null && !normalizedParentSummary.trustworthy) {
    blockers.push(...normalizedParentSummary.blockers)
  }
  if (normalizedParentSummary.run_id && workflowRunId && normalizedParentSummary.run_id !== workflowRunId) {
    blockers.push('proof_parent_summary_run_identity_mismatch')
  }

  const planRequestedSubagents = positiveInteger(recordValue(plan, 'requested_subagents'))
  const observedStarts = new Set(events
    .filter((event) => recordValue(event, 'event_name') === 'SubagentStart'
      && firstText(recordValue(event, 'run_id')) === workflowRunId)
    .map((event) => firstText(recordValue(event, 'thread_id')))
    .filter(Boolean)).size
  const countTarget = effectiveSubagentTarget(isRecord(plan) ? plan : null, observedStarts)
  validateCountContractArtifacts({
    persistedEvidence,
    summary,
    gate,
    countPolicy: countTarget.countPolicy,
    targetSubagents: countTarget.targetSubagents
  }, blockers)
  const rebuiltEvidence = planRequestedSubagents === null
    ? null
    : buildSubagentEvidence({
        requestedSubagents: countTarget.requestedSubagents,
        countPolicy: countTarget.countPolicy,
        targetSubagents: countTarget.targetSubagents,
        events,
        parentSummary: parentSummaryValue,
        parentSummaryPresent: parentSummaryValue !== null,
        workflowStatus: firstText(recordValue(summary, 'status')),
        preparationOnly: recordValue(persistedEvidence, 'preparation_only') === true,
        runId: workflowRunId,
        ...(trustedHostCapabilityEvidence ? { hostCapabilityEvidence: trustedHostCapabilityEvidence } : {}),
        additionalBlockers: subagentCountContractBlockers(isRecord(plan) ? plan : null, observedStarts)
      })
  if (planRequestedSubagents === null && plan !== null) blockers.push('proof_plan_requested_subagents_invalid')
  const evidenceInputsPresent = input.snapshot.bytes[SUBAGENT_PLAN_FILENAME] !== null
    && input.snapshot.bytes[SUBAGENT_EVENT_LOG_FILENAME] !== null
    && input.snapshot.bytes[SUBAGENT_PARENT_SUMMARY_FILENAME] !== null
  if (evidenceInputsPresent) validatePersistedEvidence(projectedPersistedEvidence, rebuiltEvidence, blockers)

  const changedFiles = projectChangedFiles(normalizedParentSummary.raw?.changed_files, blockers)
  const verification = projectVerification(normalizedParentSummary.raw?.verification, blockers)
  const parentArtifacts = projectArtifacts(recordValue(parentSummaryValue, 'artifacts'), blockers)
  const parentCapabilitiesUsed = projectCapabilityUses(recordValue(parentSummaryValue, 'capabilities_used'), blockers)
  const trustedArtifacts = trustedHostCapabilityEvidence
    ? projectArtifacts(trustedHostCapabilityEvidence.artifacts, blockers) || []
    : undefined
  const trustedCapabilitiesUsed = trustedHostCapabilityEvidence
    ? projectCapabilityUses(trustedHostCapabilityEvidence.capabilities_used, blockers) || []
    : undefined
  const rawParentArtifacts = recordValue(parentSummaryValue, 'artifacts')
  const rawParentCapabilitiesUsed = recordValue(parentSummaryValue, 'capabilities_used')
  const parentHostClaimsPresent = hasNonEmptyHostCapabilityClaim(rawParentArtifacts)
    || hasNonEmptyHostCapabilityClaim(rawParentCapabilitiesUsed)
  const trustedHostBindingRequired = Boolean(trustedHostCapabilityEvidence && (
    trustedHostCapabilityEvidence.runtime.requested_capability_ids.length > 0
      || trustedHostCapabilityEvidence.tool_calls.length > 0
      || trustedHostCapabilityEvidence.artifacts.length > 0
      || parentHostClaimsPresent
  ))
  if (trustedHostCapabilityEvidence) {
    if (trustedHostBindingRequired && JSON.stringify(parentArtifacts || []) !== JSON.stringify(trustedArtifacts || [])) {
      blockers.push('proof_parent_host_artifacts_mismatch')
    }
    if (trustedHostBindingRequired && JSON.stringify(parentCapabilitiesUsed || []) !== JSON.stringify(trustedCapabilitiesUsed || [])) {
      blockers.push('proof_parent_host_capabilities_mismatch')
    }
  } else if (parentHostClaimsPresent) {
    blockers.push('proof_host_capability_evidence_missing')
  }
  const artifacts = trustedHostBindingRequired ? trustedArtifacts : parentArtifacts
  const capabilitiesUsed = trustedHostBindingRequired ? trustedCapabilitiesUsed : parentCapabilitiesUsed
  for (const receipt of capabilitiesUsed || []) {
    if (receipt.status !== 'passed') blockers.push(`proof_capability_use_not_passed:${receipt.id}`)
  }
  const parentText = normalizedParentSummary.summary || ''
  if (parentText.length > MAX_RESULT_SUMMARY_CHARS) blockers.push('proof_result_summary_too_large')
  if (containsLeakageMarker(parentText)) blockers.push('proof_result_summary_sensitive')
  const result: NarutoProofResult = {
    summary: normalizedParentSummary.trustworthy
      && parentText.length <= MAX_RESULT_SUMMARY_CHARS
      && !containsLeakageMarker(parentText)
      ? parentText
      : '',
    changed_files: changedFiles,
    verification,
    ...(artifacts === undefined ? {} : { artifacts }),
    ...(capabilitiesUsed === undefined ? {} : { capabilities_used: capabilitiesUsed })
  }

  const completed = gatePassed(gate)
    && recordValue(projectedPersistedEvidence, 'ok') === true
    && firstText(recordValue(projectedPersistedEvidence, 'status')).toLowerCase() === 'completed'
    && rebuiltEvidence?.ok === true
    && normalizedParentSummary.trustworthy
    && normalizedParentSummary.status === 'completed'
    && firstText(recordValue(summary, 'status')).toLowerCase() === 'completed'
    && recordValue(summary, 'ok') === true
    && recordValue(summary, 'completion_evidence') === true
    && blockers.length === 0
  const explicitBlocked = !completed && isExplicitlyBlocked({
    blockers,
    parentStatus: normalizedParentSummary.status,
    evidenceStatus: firstText(recordValue(projectedPersistedEvidence, 'status')),
    failedThreads: Number(recordValue(projectedPersistedEvidence, 'failed_threads') || 0),
    summaryStatus: firstText(recordValue(summary, 'status')),
    gate
  })
  const status: NarutoProofStatus = completed ? 'completed' : explicitBlocked ? 'blocked' : 'incomplete'
  const ok = status === 'completed'
  blockers.push(...validateNarutoProofStatus({ status, ok }))
  const uniqueBlockers = uniqueStrings(blockers)
  const proofFingerprint = fingerprintProof({
    status,
    missionId,
    workflowRunId,
    artifactHashes: projectFingerprintArtifactHashes(input.snapshot),
    result
  })

  return {
    schema: NARUTO_RESULT_SCHEMA,
    action: 'proof',
    ok,
    status,
    mission_id: missionId,
    workflow: 'official_codex_subagent',
    workflow_run_id: workflowRunId,
    blockers: uniqueBlockers,
    evidence: projectedPersistedEvidence,
    summary,
    gate,
    result,
    proof_fingerprint: proofFingerprint
  }
}

function hasNonEmptyHostCapabilityClaim(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value !== undefined
}

export function validateNarutoProofStatus(value: { status: unknown; ok: unknown }): string[] {
  const status = String(value.status || '').trim()
  if (status !== 'completed' && status !== 'blocked' && status !== 'incomplete') {
    return ['proof_status_invalid']
  }
  return value.ok === (status === 'completed') ? [] : ['proof_status_ok_inconsistent']
}

function projectTrustedHostCapabilityEvidence(
  value: unknown,
  blockers: string[]
): HostCapabilityExecutionEvidence | null {
  if (value === undefined || value === null) return null
  if (!isRecord(value)
    || value.schema !== HOST_CAPABILITY_EVIDENCE_SCHEMA
    || typeof value.ok !== 'boolean'
    || !isRecord(value.runtime)
    || value.runtime.schema !== HOST_CAPABILITY_RUNTIME_SCHEMA
    || value.runtime.server !== 'acas-tools'
    || value.runtime.capability_digest !== hostCapabilityDigest(HOST_CAPABILITY_DESCRIPTORS)
    || !Array.isArray(value.runtime.requested_capability_ids)
    || !Array.isArray(value.runtime.blockers)
    || !Array.isArray(value.tool_calls)
    || !Array.isArray(value.capabilities_used)
    || !Array.isArray(value.artifacts)
    || !Array.isArray(value.blockers)) {
    blockers.push('proof_host_capability_evidence_invalid')
    return null
  }
  const requestedIds = value.runtime.requested_capability_ids.map((id) => String(id || '').trim())
  if (requestedIds.some((id) => !HOST_CAPABILITY_BY_ID.has(id))
    || new Set(requestedIds).size !== requestedIds.length
    || value.runtime.blockers.some((blocker) => !isBoundedBlockerCode(blocker))
    || value.blockers.some((blocker) => !isBoundedBlockerCode(blocker))) {
    blockers.push('proof_host_capability_runtime_invalid')
    return null
  }
  const knownTools = new Set(HOST_CAPABILITY_DESCRIPTORS.flatMap((descriptor) => descriptor.tool_names))
  if (value.tool_calls.length > 1024 || value.tool_calls.some((row) => {
    if (!isRecord(row)) return true
    return row.server !== 'acas-tools'
      || typeof row.tool !== 'string'
      || !knownTools.has(row.tool)
      || (row.status !== 'passed' && row.status !== 'failed')
      || typeof row.event_sha256 !== 'string'
      || !SHA256_RECEIPT_PATTERN.test(row.event_sha256)
  })) {
    blockers.push('proof_host_capability_tool_calls_invalid')
    return null
  }
  const receiptBlockers: string[] = []
  const capabilities = projectCapabilityUses(value.capabilities_used, receiptBlockers)
  const artifacts = projectArtifacts(value.artifacts, receiptBlockers)
  if (!capabilities || !artifacts || receiptBlockers.length > 0
    || capabilities.length !== value.capabilities_used.length
    || artifacts.length !== value.artifacts.length) {
    blockers.push(...receiptBlockers, 'proof_host_capability_receipts_invalid')
    return null
  }
  const observedIds = capabilities.map((receipt) => receipt.id)
  if (JSON.stringify([...observedIds].sort()) !== JSON.stringify([...requestedIds].sort())) {
    blockers.push('proof_host_capability_requested_receipts_mismatch')
  }
  const expectedOk = value.blockers.length === 0 && capabilities.every((receipt) => receipt.status === 'passed')
  if (value.ok !== expectedOk) blockers.push('proof_host_capability_evidence_status_inconsistent')
  const bindingBlockers = trustedHostCapabilityReceiptBindingBlockers({
    ...value,
    capabilities_used: capabilities,
    artifacts
  } as unknown as HostCapabilityExecutionEvidence)
  blockers.push(...bindingBlockers.map((blocker) => `proof_${blocker}`))
  blockers.push(...value.blockers)
  return {
    ...value,
    capabilities_used: capabilities,
    artifacts
  } as unknown as HostCapabilityExecutionEvidence
}

async function verifyProjectedArtifactFiles(input: {
  artifacts: NarutoProofArtifactReceipt[]
  artifactDir: string
  workspaceRoot: string | undefined
}): Promise<string[]> {
  const workspaceRoot = await resolveArtifactWorkspaceRoot(input.artifactDir, input.workspaceRoot)
  if (!workspaceRoot) return ['proof_artifact_workspace_root_missing']
  const blockers: string[] = []
  for (const artifact of input.artifacts) {
    blockers.push(...await verifyProjectedArtifactFile(workspaceRoot, artifact))
  }
  return uniqueStrings(blockers)
}

async function resolveArtifactWorkspaceRoot(artifactDir: string, explicitRoot: string | undefined): Promise<string | null> {
  let candidate = explicitRoot ? path.resolve(explicitRoot) : ''
  if (!candidate) {
    let cursor = path.resolve(artifactDir)
    while (true) {
      if (path.basename(cursor) === '.sneakoscope') {
        candidate = path.dirname(cursor)
        break
      }
      const parent = path.dirname(cursor)
      if (parent === cursor) break
      cursor = parent
    }
  }
  if (!candidate) return null
  try {
    const realRoot = await fsp.realpath(candidate)
    return (await fsp.stat(realRoot)).isDirectory() ? realRoot : null
  } catch {
    return null
  }
}

async function verifyProjectedArtifactFile(
  workspaceRoot: string,
  artifact: NarutoProofArtifactReceipt
): Promise<string[]> {
  if (artifact.bytes > MAX_DELIVERABLE_ARTIFACT_BYTES) return ['proof_artifact_file_too_large']
  const segments = artifact.path.split('/')
  const candidate = path.join(workspaceRoot, ...segments)
  if (!pathWithinRoot(workspaceRoot, candidate)) return ['proof_artifact_file_escape']
  let cursor = workspaceRoot
  for (let index = 0; index < segments.length; index += 1) {
    cursor = path.join(cursor, segments[index]!)
    try {
      const stat = await fsp.lstat(cursor)
      if (stat.isSymbolicLink()) return ['proof_artifact_file_symlink']
      if (index < segments.length - 1 && !stat.isDirectory()) return ['proof_artifact_file_not_regular']
      if (index === segments.length - 1 && !stat.isFile()) return ['proof_artifact_file_not_regular']
    } catch (error: unknown) {
      return [errorCode(error) === 'ENOENT' ? 'proof_artifact_file_missing' : 'proof_artifact_file_unreadable']
    }
  }
  try {
    const realCandidate = await fsp.realpath(candidate)
    if (!pathWithinRoot(workspaceRoot, realCandidate)) return ['proof_artifact_file_escape']
    const expected = await fsp.stat(realCandidate)
    if (expected.size > MAX_DELIVERABLE_ARTIFACT_BYTES) return ['proof_artifact_file_too_large']
    const handle = await fsp.open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile()) return ['proof_artifact_file_not_regular']
      if (before.dev !== expected.dev || before.ino !== expected.ino) {
        return ['proof_artifact_file_changed_during_hash']
      }
      const header = Buffer.alloc(8)
      const headerRead = await handle.read(header, 0, header.length, 0)
      const digest = createHash('sha256')
      for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) digest.update(chunk)
      const after = await handle.stat()
      const finalPathStat = await fsp.lstat(candidate)
      if (finalPathStat.isSymbolicLink()) return ['proof_artifact_file_symlink']
      if (before.dev !== after.dev
        || before.ino !== after.ino
        || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs
        || finalPathStat.dev !== after.dev
        || finalPathStat.ino !== after.ino) {
        return ['proof_artifact_file_changed_during_hash']
      }
      const blockers: string[] = []
      if (after.size !== artifact.bytes) blockers.push('proof_artifact_file_bytes_mismatch')
      if (`sha256:${digest.digest('hex')}` !== artifact.sha256) blockers.push('proof_artifact_file_sha256_mismatch')
      blockers.push(...artifactSignatureBlockers(artifact, header.subarray(0, headerRead.bytesRead)))
      return blockers
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    return [errorCode(error) === 'ELOOP' ? 'proof_artifact_file_symlink' : 'proof_artifact_file_unreadable']
  }
}

function artifactSignatureBlockers(artifact: NarutoProofArtifactReceipt, header: Buffer): string[] {
  if (artifact.media_type === 'application/pdf') {
    return header.subarray(0, 5).equals(Buffer.from('%PDF-')) ? [] : ['proof_artifact_pdf_signature_invalid']
  }
  if (artifact.media_type === 'image/png') {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return header.subarray(0, png.length).equals(png) ? [] : ['proof_artifact_png_signature_invalid']
  }
  if (artifact.media_type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    const zipLocalHeader = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    return header.subarray(0, zipLocalHeader.length).equals(zipLocalHeader)
      ? []
      : ['proof_artifact_xlsx_signature_invalid']
  }
  return []
}

function pathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function parseJsonArtifact(
  snapshot: NarutoProofArtifactSnapshot,
  filename: Exclude<NarutoProofArtifactFilename, typeof SUBAGENT_EVENT_LOG_FILENAME>,
  blockers: string[]
): unknown {
  const bytes = snapshot.bytes[filename]
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    blockers.push(`proof_artifact_malformed:${filename}`)
    return null
  }
}

function parseJsonlArtifact(snapshot: NarutoProofArtifactSnapshot, blockers: string[]): unknown[] {
  const bytes = snapshot.bytes[SUBAGENT_EVENT_LOG_FILENAME]
  if (!bytes) return []
  const rows: unknown[] = []
  const lines = bytes.toString('utf8').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line?.trim()) continue
    try {
      const parsed = JSON.parse(line)
      const event = normalizeSubagentEvent(parsed)
      if (!event) blockers.push(`proof_event_invalid:${index + 1}`)
      else rows.push(event)
    } catch {
      blockers.push(`proof_event_malformed:${index + 1}`)
    }
  }
  return rows
}

function validateArtifactIdentities(input: {
  missionId: string
  workflowRunId: string | null
  plan: unknown
  persistedEvidence: unknown
  summary: unknown
  gate: unknown
}, blockers: string[]): void {
  if (!input.missionId) blockers.push('proof_mission_id_missing')
  if (input.plan !== null) {
    if (recordValue(input.plan, 'schema') !== 'sks.subagent-plan.v1') blockers.push('proof_plan_schema_invalid')
    if (recordValue(input.plan, 'workflow') !== 'official_codex_subagent') blockers.push('proof_plan_workflow_invalid')
    if (!input.workflowRunId) blockers.push('proof_workflow_run_id_missing')
    if (firstText(recordValue(input.plan, 'mission_id')) !== input.missionId) blockers.push('proof_plan_mission_identity_mismatch')
  }
  if (input.persistedEvidence !== null) {
    if (recordValue(input.persistedEvidence, 'schema') !== 'sks.subagent-evidence.v1') blockers.push('proof_evidence_schema_invalid')
    if (recordValue(input.persistedEvidence, 'workflow') !== 'official_codex_subagent') blockers.push('proof_evidence_workflow_invalid')
    if (input.workflowRunId && firstText(recordValue(input.persistedEvidence, 'run_id')) !== input.workflowRunId) {
      blockers.push('proof_evidence_run_identity_mismatch')
    }
  }
  if (input.summary !== null) {
    validateMissionRunArtifact(input.summary, 'summary', input.missionId, input.workflowRunId, blockers)
    if (recordValue(input.summary, 'schema') !== NARUTO_RESULT_SCHEMA) blockers.push('proof_summary_schema_invalid')
  }
  if (input.gate !== null) {
    validateMissionRunArtifact(input.gate, 'gate', input.missionId, input.workflowRunId, blockers)
    if (recordValue(input.gate, 'schema') !== 'sks.naruto-gate.v1') blockers.push('proof_gate_schema_invalid')
  }
}

function validateMissionRunArtifact(
  value: unknown,
  label: 'summary' | 'gate',
  missionId: string,
  workflowRunId: string | null,
  blockers: string[]
): void {
  if (recordValue(value, 'workflow') !== 'official_codex_subagent') blockers.push(`proof_${label}_workflow_invalid`)
  if (firstText(recordValue(value, 'mission_id')) !== missionId) blockers.push(`proof_${label}_mission_identity_mismatch`)
  if (workflowRunId && firstText(recordValue(value, 'workflow_run_id')) !== workflowRunId) {
    blockers.push(`proof_${label}_run_identity_mismatch`)
  }
}

function validatePersistedEvidence(persisted: unknown, rebuilt: ReturnType<typeof buildSubagentEvidence> | null, blockers: string[]): void {
  if (!isRecord(persisted) || !rebuilt) return
  const scalarKeys = [
    'requested_subagents', 'count_policy', 'target_subagents', 'started_threads', 'completed_threads', 'failed_threads',
    'parent_summary_present', 'parent_summary_trustworthy', 'status', 'ok'
  ] as const
  for (const key of scalarKeys) {
    if (persisted[key] !== rebuilt[key]) blockers.push(`proof_evidence_rebuild_mismatch:${key}`)
  }
  const arrayKeys = [
    'started_thread_ids', 'completed_thread_ids', 'failed_thread_ids', 'open_thread_ids',
    'unmatched_stop_thread_ids', 'ambiguous_stop_thread_ids'
  ] as const
  for (const key of arrayKeys) {
    if (JSON.stringify(persisted[key]) !== JSON.stringify(rebuilt[key])) {
      blockers.push(`proof_evidence_rebuild_mismatch:${key}`)
    }
  }
  if (JSON.stringify(persisted.host_capability_evidence) !== JSON.stringify(rebuilt.host_capability_evidence)) {
    blockers.push('proof_evidence_rebuild_mismatch:host_capability_evidence')
  }
}

function validateCountContractArtifacts(input: {
  persistedEvidence: unknown
  summary: unknown
  gate: unknown
  countPolicy: string
  targetSubagents: number
}, blockers: string[]): void {
  for (const [label, value] of [
    ['evidence', input.persistedEvidence],
    ['summary', input.summary],
    ['gate', input.gate]
  ] as const) {
    if (!isRecord(value)) continue
    if (value.count_policy !== input.countPolicy) blockers.push(`proof_${label}_count_policy_mismatch`)
    if (Number(value.target_subagents || 0) !== input.targetSubagents) blockers.push(`proof_${label}_target_subagents_mismatch`)
  }
}

function projectChangedFiles(value: unknown, blockers: string[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    blockers.push('proof_changed_files_invalid')
    return []
  }
  if (value.length > MAX_CHANGED_FILES) blockers.push('proof_changed_files_too_many')
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value.slice(0, MAX_CHANGED_FILES)) {
    if (typeof item !== 'string') {
      blockers.push('proof_changed_file_invalid')
      continue
    }
    const original = item.trim()
    if (!original || original.includes('\0') || original.length > MAX_CHANGED_FILE_CHARS) {
      blockers.push('proof_changed_file_invalid')
      continue
    }
    const slashPath = original.replace(/\\/g, '/')
    if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(original)) {
      blockers.push('proof_changed_file_absolute')
      continue
    }
    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '')
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
      blockers.push('proof_changed_file_escape')
      continue
    }
    if (seen.has(normalized)) {
      blockers.push('proof_changed_file_duplicate')
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function projectVerification(value: unknown, blockers: string[]): NarutoProofVerification[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    blockers.push('proof_verification_invalid')
    return []
  }
  if (value.length > MAX_VERIFICATION_ROWS) blockers.push('proof_verification_too_many')
  const result: NarutoProofVerification[] = []
  for (const row of value.slice(0, MAX_VERIFICATION_ROWS)) {
    const projected = projectVerificationRow(row)
    if (!projected) blockers.push('proof_verification_row_invalid')
    else result.push(projected)
  }
  return result
}

function projectVerificationRow(value: unknown): NarutoProofVerification | null {
  const rawName = typeof value === 'string'
    ? value
    : isRecord(value)
      ? firstText(value.name, value.check, value.command)
      : ''
  const name = rawName.trim()
  if (!name || name.length > MAX_VERIFICATION_NAME_CHARS || /[\r\n\0]/.test(name) || containsLeakageMarker(name)) return null
  const rawStatus = isRecord(value) ? firstText(value.status) : ''
  return { name, status: normalizeVerificationStatus(rawStatus, name) }
}

function projectArtifacts(value: unknown, blockers: string[]): NarutoProofArtifactReceipt[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    blockers.push('proof_artifacts_invalid')
    return []
  }
  if (value.length > MAX_ARTIFACTS) blockers.push('proof_artifacts_too_many')
  const result: NarutoProofArtifactReceipt[] = []
  const seenPaths = new Set<string>()
  let aggregateBytes = 0
  for (const row of value.slice(0, MAX_ARTIFACTS)) {
    if (!isRecord(row)) {
      blockers.push('proof_artifact_invalid')
      continue
    }
    const artifactPath = normalizeArtifactPath(row.path, blockers)
    const kind = boundedToken(row.kind, MAX_ARTIFACT_KIND_CHARS, /^[a-z][a-z0-9_-]*$/)
    const mediaType = boundedToken(
      row.media_type,
      MAX_MEDIA_TYPE_CHARS,
      /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i
    )
    const artifactSha256 = typeof row.sha256 === 'string' && SHA256_RECEIPT_PATTERN.test(row.sha256)
      ? row.sha256
      : null
    const bytes = typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0
      ? row.bytes
      : null
    const role = typeof row.role === 'string' && ARTIFACT_ROLES.has(row.role as NarutoProofArtifactReceipt['role'])
      ? row.role as NarutoProofArtifactReceipt['role']
      : null
    if (!kind) blockers.push('proof_artifact_kind_invalid')
    if (!mediaType) blockers.push('proof_artifact_media_type_invalid')
    if (!artifactSha256) blockers.push('proof_artifact_sha256_invalid')
    if (bytes === null) blockers.push('proof_artifact_bytes_invalid')
    if (bytes !== null && bytes > MAX_DELIVERABLE_ARTIFACT_BYTES) blockers.push('proof_artifact_bytes_too_large')
    if (!role) blockers.push('proof_artifact_role_invalid')
    if (!artifactPath || !kind || !mediaType || !artifactSha256 || bytes === null || !role) continue
    if (seenPaths.has(artifactPath)) {
      blockers.push('proof_artifact_path_duplicate')
      continue
    }
    if (role === 'deliverable' && isNonDeliverableArtifact(artifactPath, kind)) {
      blockers.push('proof_artifact_deliverable_role_invalid')
      continue
    }
    blockers.push(...artifactMediaConsistencyBlockers(artifactPath, mediaType))
    seenPaths.add(artifactPath)
    aggregateBytes += bytes
    result.push({ path: artifactPath, kind, media_type: mediaType, sha256: artifactSha256, bytes, role })
  }
  if (aggregateBytes > MAX_DELIVERABLE_ARTIFACT_AGGREGATE_BYTES) blockers.push('proof_artifact_bytes_aggregate_too_large')
  return result
}

function normalizeArtifactPath(value: unknown, blockers: string[]): string | null {
  if (typeof value !== 'string') {
    blockers.push('proof_artifact_path_invalid')
    return null
  }
  const original = value.trim()
  if (!original || original.length > MAX_ARTIFACT_PATH_CHARS || /[\r\n\0]/.test(original)) {
    blockers.push('proof_artifact_path_invalid')
    return null
  }
  if (original.includes('\\')) {
    blockers.push('proof_artifact_path_not_posix')
    return null
  }
  if (path.posix.isAbsolute(original) || path.win32.isAbsolute(original)) {
    blockers.push('proof_artifact_path_absolute')
    return null
  }
  const normalized = path.posix.normalize(original).replace(/^\.\//, '')
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    blockers.push('proof_artifact_path_escape')
    return null
  }
  if (normalized.length > MAX_ARTIFACT_PATH_CHARS) {
    blockers.push('proof_artifact_path_invalid')
    return null
  }
  return normalized
}

function isNonDeliverableArtifact(artifactPath: string, kind: string): boolean {
  if (NON_DELIVERABLE_ARTIFACT_KINDS.has(kind.toLowerCase())) return true
  const segments = artifactPath.toLowerCase().split('/')
  return segments.some((segment) => NON_DELIVERABLE_PATH_SEGMENTS.has(segment))
    || artifactPath.toLowerCase().endsWith('.log')
}

function artifactMediaConsistencyBlockers(artifactPath: string, mediaType: string): string[] {
  const extension = path.posix.extname(artifactPath).toLowerCase()
  const expectedByExtension: Record<string, string> = {
    '.csv': 'text/csv',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  }
  const expectedExtensionsByMedia: Record<string, string[]> = {
    'text/csv': ['.csv'],
    'application/pdf': ['.pdf'],
    'image/png': ['.png'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx']
  }
  const blockers: string[] = []
  const expectedMedia = expectedByExtension[extension]
  if (expectedMedia && mediaType !== expectedMedia) blockers.push('proof_artifact_media_extension_mismatch')
  const expectedExtensions = expectedExtensionsByMedia[mediaType]
  if (expectedExtensions && !expectedExtensions.includes(extension)) blockers.push('proof_artifact_extension_media_mismatch')
  return blockers
}

function projectCapabilityUses(value: unknown, blockers: string[]): NarutoProofCapabilityUse[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    blockers.push('proof_capabilities_used_invalid')
    return []
  }
  if (value.length > MAX_CAPABILITY_USES) blockers.push('proof_capabilities_used_too_many')
  const result: NarutoProofCapabilityUse[] = []
  const seenIds = new Set<string>()
  for (const row of value.slice(0, MAX_CAPABILITY_USES)) {
    if (!isRecord(row)) {
      blockers.push('proof_capability_use_invalid')
      continue
    }
    const id = boundedToken(row.id, MAX_CAPABILITY_ID_CHARS, /^[a-z][a-z0-9._-]*$/)
    const descriptor = id ? HOST_CAPABILITY_BY_ID.get(id) : undefined
    const status = normalizeCapabilityStatus(row.status)
    const toolNames = projectCapabilityToolNames(row.tool_names, descriptor?.tool_names || [], status, blockers)
    const receiptSha256 = typeof row.receipt_sha256 === 'string' && SHA256_RECEIPT_PATTERN.test(row.receipt_sha256)
      ? row.receipt_sha256
      : null
    if (!id) blockers.push('proof_capability_use_id_invalid')
    else if (!descriptor) blockers.push('proof_capability_use_unknown_id')
    if (!status) blockers.push('proof_capability_use_status_invalid')
    if (!receiptSha256) blockers.push('proof_capability_use_receipt_sha256_invalid')
    if (!id || !descriptor || !status || !toolNames || !receiptSha256) continue
    if (seenIds.has(id)) {
      blockers.push('proof_capability_use_duplicate')
      continue
    }
    seenIds.add(id)
    result.push({ id, status, tool_names: toolNames, receipt_sha256: receiptSha256 })
  }
  return result
}

function projectCapabilityToolNames(
  value: unknown,
  allowedToolNames: readonly string[],
  status: NarutoProofCapabilityUse['status'] | null,
  blockers: string[]
): string[] | null {
  if (!Array.isArray(value) || (status === 'passed' && value.length === 0)) {
    blockers.push('proof_capability_use_tool_names_invalid')
    return null
  }
  if (value.length > MAX_CAPABILITY_TOOL_NAMES) {
    blockers.push('proof_capability_use_tool_names_too_many')
    return null
  }
  const result: string[] = []
  const seen = new Set<string>()
  const allowed = new Set(allowedToolNames)
  for (const valueItem of value) {
    const toolName = boundedToken(valueItem, MAX_CAPABILITY_TOOL_NAME_CHARS, /^[A-Za-z][A-Za-z0-9_.:-]*$/)
    if (!toolName) {
      blockers.push('proof_capability_use_tool_name_invalid')
      return null
    }
    if (seen.has(toolName)) {
      blockers.push('proof_capability_use_tool_name_duplicate')
      return null
    }
    if (!allowed.has(toolName)) {
      blockers.push('proof_capability_use_tool_name_not_declared')
      return null
    }
    seen.add(toolName)
    result.push(toolName)
  }
  return result
}

function normalizeCapabilityStatus(value: unknown): NarutoProofCapabilityUse['status'] | null {
  const status = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return status === 'passed' || status === 'failed' ? status : null
}

function boundedToken(value: unknown, maxChars: number, pattern: RegExp): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text || text.length > maxChars || containsLeakageMarker(text) || !pattern.test(text)) return null
  return text
}

function normalizeVerificationStatus(value: string, name: string): NarutoProofVerification['status'] {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'passed' || normalized === 'pass' || normalized === 'ok' || normalized === 'verified') return 'passed'
  if (normalized === 'failed' || normalized === 'fail' || normalized === 'error') return 'failed'
  if (normalized === 'blocked') return 'blocked'
  if (normalized === 'skipped') return 'skipped'
  if (normalized === 'pending' || normalized === 'running') return 'pending'
  if (normalized === 'unknown' || normalized === 'unverified') return 'unknown'
  if (/\b(?:passed|pass|verified|green)\b|통과|완료/i.test(name)) return 'passed'
  if (/\b(?:failed|failure|error)\b|실패|오류/i.test(name)) return 'failed'
  if (/\bblocked\b|차단/i.test(name)) return 'blocked'
  if (/\b(?:pending|running)\b|보류|진행\s*중/i.test(name)) return 'pending'
  if (/\b(?:not run|unverified|unknown)\b|미실행|미검증/i.test(name)) return 'unknown'
  return 'reported'
}

function containsLeakageMarker(value: string): boolean {
  return /(?:^|\s)(?:prompt|system_prompt|user_prompt|stdout|stderr|environment|env_dump)\s*[:=]/i.test(value)
    || /\b(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]/i.test(value)
}

function isBoundedBlockerCode(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9_.:-]+$/.test(value)
}

function isExplicitlyBlocked(input: {
  blockers: string[]
  parentStatus: string | null
  evidenceStatus: string
  failedThreads: number
  summaryStatus: string
  gate: unknown
}): boolean {
  if (input.parentStatus === 'blocked' || input.parentStatus === 'failed' || input.failedThreads > 0) return true
  if (/^(?:blocked|failed)$/i.test(input.evidenceStatus) || /^(?:blocked|failed)$/i.test(input.summaryStatus)) return true
  if (recordValue(input.gate, 'passed') === false && recordValue(input.gate, 'terminal') === true) return true
  return input.blockers.some((blocker) => !INCOMPLETE_BLOCKER_PATTERNS.some((pattern) => pattern.test(blocker)))
}

function gatePassed(value: unknown): boolean {
  return recordValue(value, 'passed') === true
    && recordValue(value, 'terminal') === true
    && firstText(recordValue(value, 'terminal_state')).toLowerCase() === 'completed'
    && arrayValue(recordValue(value, 'blockers')).length === 0
}

function fingerprintProof(input: {
  status: NarutoProofStatus
  missionId: string
  workflowRunId: string | null
  artifactHashes: NarutoProofArtifactSnapshot['byte_hashes']
  result: NarutoProofResult
}): string {
  const artifactHashes = NARUTO_PROOF_ARTIFACT_FILENAMES.map((filename) => [filename, input.artifactHashes[filename]])
  const stableInput = {
    schema: NARUTO_RESULT_SCHEMA,
    action: 'proof',
    status: input.status,
    mission_id: input.missionId,
    workflow: 'official_codex_subagent',
    workflow_run_id: input.workflowRunId,
    artifact_byte_sha256: artifactHashes,
    result: input.result
  }
  return `sha256:${sha256(JSON.stringify(stableInput))}`
}

function projectFingerprintArtifactHashes(
  snapshot: NarutoProofArtifactSnapshot
): NarutoProofArtifactSnapshot['byte_hashes'] {
  const hashes = { ...snapshot.byte_hashes }
  for (const filename of [SUBAGENT_PARENT_SUMMARY_FILENAME, SUBAGENT_EVIDENCE_FILENAME] as const) {
    const bytes = snapshot.bytes[filename]
    if (!bytes) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(bytes.toString('utf8'))
    } catch {
      continue
    }
    const projected = projectReceiptAdditiveFields(filename, parsed)
    if (projected === parsed) continue
    hashes[filename] = `sha256:${sha256(`${JSON.stringify(projected, null, 2)}\n`)}`
  }
  return hashes
}

function projectReceiptAdditiveFields(
  filename: typeof SUBAGENT_PARENT_SUMMARY_FILENAME | typeof SUBAGENT_EVIDENCE_FILENAME,
  value: unknown
): unknown {
  if (!isRecord(value)) return value
  if (filename === SUBAGENT_PARENT_SUMMARY_FILENAME) {
    return projectReceiptContainerAdditiveFields(value)
  }
  const hostEvidence = recordValue(value, 'host_capability_evidence')
  if (!isRecord(hostEvidence)) return value
  const projectedHostEvidence = projectReceiptContainerAdditiveFields(hostEvidence)
  return projectedHostEvidence === hostEvidence
    ? value
    : { ...value, host_capability_evidence: projectedHostEvidence }
}

function projectReceiptContainerAdditiveFields(value: Record<string, unknown>): Record<string, unknown> {
  const artifacts = projectReceiptRowsAdditiveFields(value.artifacts, ARTIFACT_RECEIPT_KEYS)
  const capabilitiesUsed = projectReceiptRowsAdditiveFields(value.capabilities_used, CAPABILITY_USE_KEYS)
  if (artifacts === value.artifacts && capabilitiesUsed === value.capabilities_used) return value
  return {
    ...value,
    ...(artifacts === value.artifacts ? {} : { artifacts }),
    ...(capabilitiesUsed === value.capabilities_used ? {} : { capabilities_used: capabilitiesUsed })
  }
}

function projectReceiptRowsAdditiveFields(value: unknown, allowedKeys: ReadonlySet<string>): unknown {
  if (!Array.isArray(value)) return value
  let changed = false
  const projected = value.map((row) => {
    if (!isRecord(row)) return row
    const unknownKeys = Object.keys(row).filter((key) => !allowedKeys.has(key))
    if (unknownKeys.length === 0) return row
    changed = true
    return Object.fromEntries(Object.entries(row).filter(([key]) => allowedKeys.has(key)))
  })
  return changed ? projected : value
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? '').trim()
    if (text) return text
  }
  return ''
}

function positiveInteger(value: unknown): number | null {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : null
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
}
