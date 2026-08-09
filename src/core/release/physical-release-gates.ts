import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  desktopBridgeReleaseSourceIdentitySha256,
  inspectDesktopBridgeReleaseEvidence,
  type DesktopBridgeReleaseEvidenceInspection
} from './desktop-bridge-release-evidence.js'
import { cloneBuffer, fileIdentity, inspectionKey, memoizeReleaseInspection, toolIdentity } from './release-inspection-memo.js'

export const PHYSICAL_RELEASE_GATES_SCHEMA = 'sks.release-physical-gates.v2'
export const PHYSICAL_RELEASE_GATES_INSPECTION_SCHEMA = 'sks.release-physical-gates-inspection.v2'
export const PHYSICAL_RELEASE_EVIDENCE_ARTIFACT_MANIFEST_SCHEMA = 'sks.release-physical-evidence-artifact-manifest.v1'
export const PHYSICAL_RELEASE_EVIDENCE_CAPTURE_WORKFLOW = '.github/workflows/capture-physical-release-evidence.yml'
export const PHYSICAL_RELEASE_EVIDENCE_MANIFEST = 'physical-evidence-artifact-manifest.json'
export const PHYSICAL_RELEASE_EVIDENCE_REPOSITORY = 'mandarange/Sneakoscope-Codex'
const MAX_PHYSICAL_RELEASE_ARTIFACT_BYTES = 32 * 1024 * 1024
const MAX_PHYSICAL_RELEASE_EVIDENCE_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_PHYSICAL_RELEASE_FUTURE_SKEW_MS = 5 * 60 * 1000
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const COMMIT_PATTERN = /^[a-f0-9]{40}$/i
const CAPTURE_ID_PATTERN = /^[a-z0-9][a-z0-9._:/-]{2,159}$/i
export const PHYSICAL_RELEASE_GATE_IDS = [
  'update_5001_directory',
  'single_menubar_process',
  'codex_lb_measured_request',
  'desktop_bridge_live_evidence'
] as const

export type PhysicalReleaseGateId = typeof PHYSICAL_RELEASE_GATE_IDS[number]

export interface PhysicalReleaseGateInspectionOptions {
  readonly root: string
  readonly version: string
  readonly sourceCommit?: string | null
  readonly now?: Date
  readonly inspectorPlatform?: NodeJS.Platform
  readonly requireMacosInspector?: boolean
  readonly evidenceArchive?: string | null
  readonly evidenceRunId?: string | null
  readonly repository?: string | null
}

export interface PhysicalReleaseEvidenceArtifactAttestation {
  readonly schema: 'sks.release-physical-evidence-artifact-attestation.v1'
  readonly archive_path: string
  readonly archive_sha256: string
  readonly manifest_sha256: string
  readonly github_repository: string
  readonly trusted_workflow: string
  readonly workflow_run_id: string
  readonly run_invocation_uri: string
  readonly artifact_name: string
  readonly entry_count: number
  readonly capture_adapter_executable_sha256: string
  readonly capture_adapter_id: string
  readonly capture_adapter_version: string
  readonly capture_adapter_run_id: string
  readonly capture_adapter_receipt_id: string
  readonly capture_adapter_receipt_sha256: string
}

export interface PhysicalReleaseGateInspection {
  readonly schema: 'sks.release-physical-gates-inspection.v2'
  readonly ok: boolean
  readonly status: 'passed' | 'blocked'
  readonly package_version: string
  readonly release_source_commit: string | null
  readonly head_commit: string | null
  readonly receipt_path: string
  readonly receipt_sha256: string | null
  readonly inspector_platform: NodeJS.Platform
  readonly evidence_capture_platform: string | null
  readonly inspected_at: string
  readonly release_authorizing: boolean
  readonly artifact_attestation: PhysicalReleaseEvidenceArtifactAttestation | null
  readonly desktop_bridge_evidence: DesktopBridgeReleaseEvidenceInspection | null
  readonly verified_gate_ids: string[]
  readonly blockers: string[]
}

export function inspectPhysicalReleaseGates(opts: PhysicalReleaseGateInspectionOptions): PhysicalReleaseGateInspection {
  const root = path.resolve(opts.root)
  const evidenceRoot = path.join(root, 'release-evidence', opts.version)
  const receiptPath = path.join(evidenceRoot, 'physical-gates.json')
  const headCommit = opts.sourceCommit === undefined ? gitHead(root) : opts.sourceCommit
  const inspectorPlatform = opts.inspectorPlatform ?? process.platform
  const now = opts.now?.getTime() ?? Date.now()
  const blockers: string[] = []
  const receiptBytes = readRegularFile(receiptPath)
  const receipt = parseJson(receiptBytes)

  if (!receipt) blockers.push('physical_receipt_missing_or_invalid')
  if (receiptBytes && containsSecretBytes(receiptBytes)) blockers.push('physical_receipt_secret_material_present')
  if (receipt && receipt.schema !== PHYSICAL_RELEASE_GATES_SCHEMA) blockers.push('physical_receipt_schema_invalid')
  if (receipt && receipt.ok !== true) blockers.push('physical_receipt_not_ok')
  if (receipt && receipt.release_authorizing !== true) blockers.push('physical_receipt_not_release_authorizing')
  if (receipt && (receipt.fixture !== false || receipt.mock !== false || receipt.synthetic !== false)) blockers.push('physical_receipt_reality_flags_invalid')
  if (receipt && receipt.capture_platform !== 'darwin') blockers.push('physical_receipt_capture_platform_invalid')
  if (receipt && (!Array.isArray(receipt.blockers) || receipt.blockers.length > 0)) blockers.push('physical_receipt_blockers_present')
  if (receipt && receipt.package_version !== opts.version) blockers.push('physical_receipt_version_mismatch')
  validateFreshDate(receipt?.captured_at, 'physical_receipt_time', now, blockers)
  if (!headCommit || !COMMIT_PATTERN.test(headCommit)) blockers.push('physical_receipt_head_commit_unavailable')
  const releaseSourceCommit = String(receipt?.source_commit || '')
  if (receipt && !COMMIT_PATTERN.test(releaseSourceCommit)) blockers.push('physical_receipt_source_commit_invalid')
  if (receipt && COMMIT_PATTERN.test(releaseSourceCommit)
    && receipt.source_identity_sha256 !== desktopBridgeReleaseSourceIdentitySha256(opts.version, releaseSourceCommit)) {
    blockers.push('physical_receipt_source_identity_mismatch')
  }
  if (receipt && (!CAPTURE_ID_PATTERN.test(String(receipt.capture_adapter_id || ''))
    || !CAPTURE_ID_PATTERN.test(String(receipt.capture_adapter_version || ''))
    || !CAPTURE_ID_PATTERN.test(String(receipt.capture_adapter_receipt_id || ''))
    || !SHA256_PATTERN.test(String(receipt.capture_adapter_receipt_sha256 || '')))) {
    blockers.push('physical_receipt_capture_adapter_identity_invalid')
  }
  if ((opts.requireMacosInspector ?? true) && inspectorPlatform !== 'darwin') {
    blockers.push(`physical_receipt_requires_macos_inspector:${inspectorPlatform}`)
  }
  if (receipt && headCommit && COMMIT_PATTERN.test(releaseSourceCommit)) {
    validateSourceBinding(releaseSourceCommit, headCommit, blockers)
  }

  const artifactAttestation = inspectPhysicalEvidenceArtifact({
    root,
    version: opts.version,
    sourceCommit: headCommit,
    ...(opts.evidenceArchive !== undefined ? { archivePath: opts.evidenceArchive } : {}),
    ...(opts.evidenceRunId !== undefined ? { evidenceRunId: opts.evidenceRunId } : {}),
    ...(opts.repository !== undefined ? { repository: opts.repository } : {}),
    blockers
  })

  const gates = Array.isArray(receipt?.gates) ? receipt.gates : []
  const ids = gates.map((gate: any) => String(gate?.id || ''))
  if (new Set(ids).size !== ids.length) blockers.push('physical_receipt_gate_ids_duplicate')
  const unknown = ids.filter((id: string) => !PHYSICAL_RELEASE_GATE_IDS.includes(id as PhysicalReleaseGateId))
  if (unknown.length > 0) blockers.push(`physical_receipt_unknown_gate:${unknown.sort().join(',')}`)

  for (const id of PHYSICAL_RELEASE_GATE_IDS) {
    const gate = gates.find((entry: any) => entry?.id === id)
    if (!gate) {
      blockers.push(`physical_receipt_gate_missing:${id}`)
      continue
    }
    validateGate(gate, id, opts.version, releaseSourceCommit, evidenceRoot, now, blockers)
  }

  const desktopBridgeGate = gates.find((entry: any) => entry?.id === 'desktop_bridge_live_evidence')
  const desktopBridgeEvidence = desktopBridgeGate && COMMIT_PATTERN.test(releaseSourceCommit)
    ? inspectDesktopBridgeReleaseEvidence({
      evidenceRoot,
      reportPath: String(desktopBridgeGate.artifact_path || ''),
      expectedVersion: opts.version,
      expectedSourceCommit: releaseSourceCommit,
      ...(opts.now ? { now: opts.now } : {})
    })
    : null
  if (!desktopBridgeEvidence) blockers.push('physical_receipt_desktop_bridge_evidence_missing')
  else blockers.push(...desktopBridgeEvidence.blockers.map((blocker) => `physical_receipt_desktop_bridge:${blocker}`))
  validateCaptureAdapterBinding(receipt, gates, artifactAttestation, desktopBridgeEvidence, blockers)
  const uniqueBlockers = [...new Set(blockers)]
  const ok = uniqueBlockers.length === 0
  return {
    schema: PHYSICAL_RELEASE_GATES_INSPECTION_SCHEMA,
    ok,
    status: ok ? 'passed' : 'blocked',
    package_version: opts.version,
    release_source_commit: COMMIT_PATTERN.test(releaseSourceCommit) ? releaseSourceCommit : null,
    head_commit: headCommit || null,
    receipt_path: path.relative(root, receiptPath).split(path.sep).join('/'),
    receipt_sha256: receiptBytes ? sha256(receiptBytes) : null,
    inspector_platform: inspectorPlatform,
    evidence_capture_platform: typeof receipt?.capture_platform === 'string' ? receipt.capture_platform : null,
    inspected_at: new Date(now).toISOString(),
    release_authorizing: ok,
    artifact_attestation: artifactAttestation,
    desktop_bridge_evidence: desktopBridgeEvidence,
    verified_gate_ids: ok ? [...PHYSICAL_RELEASE_GATE_IDS] : [],
    blockers: uniqueBlockers
  }
}

export function physicalReleaseGateInspectionPath(root: string, version: string): string {
  return path.join(path.resolve(root), '.sneakoscope', 'reports', 'release', version, 'physical-gates-inspection.json')
}

export function physicalReleaseEvidenceArchivePath(root: string, version: string): string {
  return path.join(path.resolve(root), '.sneakoscope', 'reports', 'release', version, 'physical-evidence-archive.tgz')
}

export function physicalReleaseEvidenceManifestPath(root: string, version: string): string {
  return path.join(path.resolve(root), '.sneakoscope', 'reports', 'release', version, PHYSICAL_RELEASE_EVIDENCE_MANIFEST)
}

export function validatePhysicalReleaseGateInspection(input: {
  root: string
  version: string
  sourceCommit: string
  now?: Date
}): {
  ok: boolean
  path: string
  sha256: string | null
  report: PhysicalReleaseGateInspection | null
  blockers: string[]
} {
  const reportPath = physicalReleaseGateInspectionPath(input.root, input.version)
  const bytes = readRegularFile(reportPath)
  const report = parseJson(bytes) as PhysicalReleaseGateInspection | null
  const blockers: string[] = []
  if (!report || report.schema !== PHYSICAL_RELEASE_GATES_INSPECTION_SCHEMA) blockers.push('physical_inspection_missing_or_invalid')
  if (report && (report.ok !== true || report.status !== 'passed' || report.release_authorizing !== true)) blockers.push('physical_inspection_not_authorizing')
  if (report && report.inspector_platform !== 'darwin') blockers.push('physical_inspection_not_macos')
  if (report && report.evidence_capture_platform !== 'darwin') blockers.push('physical_inspection_capture_platform_invalid')
  if (report && report.package_version !== input.version) blockers.push('physical_inspection_version_mismatch')
  if (report && report.release_source_commit !== input.sourceCommit) blockers.push('physical_inspection_source_commit_mismatch')
  if (report && report.head_commit !== input.sourceCommit) blockers.push('physical_inspection_head_commit_mismatch')
  if (report && !validDate(report.inspected_at)) blockers.push('physical_inspection_time_invalid')
  if (report && (!Array.isArray(report.blockers) || report.blockers.length > 0)) blockers.push('physical_inspection_blockers_present')
  if (report && !sameStrings(report.verified_gate_ids, PHYSICAL_RELEASE_GATE_IDS)) blockers.push('physical_inspection_gate_inventory_invalid')
  if (report && !report.artifact_attestation) blockers.push('physical_inspection_artifact_attestation_missing')

  const current = inspectPhysicalReleaseGates({
    root: input.root,
    version: input.version,
    sourceCommit: input.sourceCommit,
    ...(input.now ? { now: input.now } : {}),
    requireMacosInspector: false,
    evidenceArchive: report?.artifact_attestation?.archive_path
      ? path.resolve(input.root, report.artifact_attestation.archive_path)
      : null,
    evidenceRunId: report?.artifact_attestation?.workflow_run_id || null,
    repository: report?.artifact_attestation?.github_repository || null
  })
  if (!current.ok) blockers.push(...current.blockers.map((blocker) => `physical_inspection_revalidation:${blocker}`))
  if (report && report.receipt_sha256 !== current.receipt_sha256) blockers.push('physical_inspection_receipt_hash_mismatch')
  if (report && !sameDesktopEvidenceBinding(report.desktop_bridge_evidence, current.desktop_bridge_evidence)) {
    blockers.push('physical_inspection_desktop_bridge_binding_mismatch')
  }
  if (report && !sameArtifactAttestation(report.artifact_attestation, current.artifact_attestation)) {
    blockers.push('physical_inspection_artifact_attestation_mismatch')
  }
  return {
    ok: blockers.length === 0,
    path: path.relative(path.resolve(input.root), reportPath).split(path.sep).join('/'),
    sha256: bytes ? sha256(bytes) : null,
    report,
    blockers: [...new Set(blockers)]
  }
}

function sameDesktopEvidenceBinding(
  left: DesktopBridgeReleaseEvidenceInspection | null,
  right: DesktopBridgeReleaseEvidenceInspection | null
): boolean {
  if (!left || !right) return false
  return left.ok === true
    && right.ok === true
    && left.report_sha256 === right.report_sha256
    && left.adapter_receipt_sha256 === right.adapter_receipt_sha256
    && left.native_screenshot_sha256 === right.native_screenshot_sha256
    && left.deep_artifact_count === right.deep_artifact_count
    && left.adapter_id === right.adapter_id
    && left.adapter_version === right.adapter_version
    && left.adapter_run_id === right.adapter_run_id
    && left.adapter_receipt_id === right.adapter_receipt_id
    && sameStrings(left.providers, right.providers)
}

function sameArtifactAttestation(
  left: PhysicalReleaseEvidenceArtifactAttestation | null | undefined,
  right: PhysicalReleaseEvidenceArtifactAttestation | null | undefined
): boolean {
  if (!left || !right) return false
  return left.schema === right.schema
    && left.archive_path === right.archive_path
    && left.archive_sha256 === right.archive_sha256
    && left.manifest_sha256 === right.manifest_sha256
    && left.github_repository === right.github_repository
    && left.trusted_workflow === right.trusted_workflow
    && left.workflow_run_id === right.workflow_run_id
    && left.run_invocation_uri === right.run_invocation_uri
    && left.artifact_name === right.artifact_name
    && left.entry_count === right.entry_count
    && left.capture_adapter_executable_sha256 === right.capture_adapter_executable_sha256
    && left.capture_adapter_id === right.capture_adapter_id
    && left.capture_adapter_version === right.capture_adapter_version
    && left.capture_adapter_run_id === right.capture_adapter_run_id
    && left.capture_adapter_receipt_id === right.capture_adapter_receipt_id
    && left.capture_adapter_receipt_sha256 === right.capture_adapter_receipt_sha256
}

function inspectPhysicalEvidenceArtifact(input: {
  root: string
  version: string
  sourceCommit: string | null
  archivePath?: string | null
  evidenceRunId?: string | null
  repository?: string | null
  blockers: string[]
}): PhysicalReleaseEvidenceArtifactAttestation | null {
  const blockerCount = input.blockers.length
  const archivePath = path.resolve(input.archivePath || physicalReleaseEvidenceArchivePath(input.root, input.version))
  const runId = String(input.evidenceRunId || '')
  const repository = String(input.repository || '')
  const sourceCommit = String(input.sourceCommit || '')
  if (!/^\d+$/.test(runId)) input.blockers.push('physical_evidence_attestation_run_id_missing_or_invalid')
  if (repository !== PHYSICAL_RELEASE_EVIDENCE_REPOSITORY) input.blockers.push('physical_evidence_attestation_repository_missing_or_invalid')
  if (!COMMIT_PATTERN.test(sourceCommit)) input.blockers.push('physical_evidence_attestation_source_commit_invalid')
  const archiveBytes = readBoundArchive(archivePath)
  if (!archiveBytes) input.blockers.push('physical_evidence_attestation_archive_missing_or_invalid')
  if (!archiveBytes || !/^\d+$/.test(runId) || repository !== PHYSICAL_RELEASE_EVIDENCE_REPOSITORY || !COMMIT_PATTERN.test(sourceCommit)) {
    input.blockers.push('physical_evidence_attestation_missing')
    return null
  }

  const archiveSha256 = sha256(archiveBytes)
  const trustedWorkflow = `${repository}/${PHYSICAL_RELEASE_EVIDENCE_CAPTURE_WORKFLOW}`
  const invocationUri = verifyGithubArtifactAttestation({
    archivePath,
    repository,
    trustedWorkflow,
    sourceCommit,
    runId,
    blockers: input.blockers
  })
  const listed = listArchiveFiles(archivePath, input.blockers)
  const manifestMember = listed?.get(PHYSICAL_RELEASE_EVIDENCE_MANIFEST)
  if (!manifestMember) input.blockers.push('physical_evidence_artifact_manifest_missing_from_archive')
  const archiveManifestBytes = manifestMember
    ? readArchiveMember(archivePath, manifestMember, 'physical_evidence_artifact_manifest', input.blockers)
    : null
  const extractedManifestPath = physicalReleaseEvidenceManifestPath(input.root, input.version)
  const extractedManifestBytes = readRegularFile(extractedManifestPath)
  if (!extractedManifestBytes) input.blockers.push('physical_evidence_artifact_manifest_missing_or_invalid')
  if (archiveManifestBytes && extractedManifestBytes && !archiveManifestBytes.equals(extractedManifestBytes)) {
    input.blockers.push('physical_evidence_artifact_manifest_archive_mismatch')
  }
  const manifest = archiveManifestBytes ? parseJson(archiveManifestBytes) : null
  const expectedArtifactName = `physical-release-evidence-${sourceCommit}`
  if (manifest?.schema !== PHYSICAL_RELEASE_EVIDENCE_ARTIFACT_MANIFEST_SCHEMA) input.blockers.push('physical_evidence_artifact_manifest_schema_invalid')
  if (manifest?.package_version !== input.version) input.blockers.push('physical_evidence_artifact_manifest_version_mismatch')
  if (manifest?.source_commit !== sourceCommit) input.blockers.push('physical_evidence_artifact_manifest_source_commit_mismatch')
  if (manifest?.github_repository !== repository) input.blockers.push('physical_evidence_artifact_manifest_repository_mismatch')
  if (manifest?.workflow_path !== PHYSICAL_RELEASE_EVIDENCE_CAPTURE_WORKFLOW) input.blockers.push('physical_evidence_artifact_manifest_workflow_mismatch')
  if (String(manifest?.workflow_run_id || '') !== runId) input.blockers.push('physical_evidence_artifact_manifest_run_id_mismatch')
  if (manifest?.artifact_name !== expectedArtifactName) input.blockers.push('physical_evidence_artifact_manifest_name_mismatch')
  if (manifest?.capture_platform !== 'darwin') input.blockers.push('physical_evidence_artifact_manifest_platform_mismatch')
  const captureAdapter = manifest?.capture_adapter
  if (captureAdapter?.schema !== 'sks.release-physical-capture-adapter.v1'
    || captureAdapter?.executable_path !== '/usr/local/bin/sks-physical-release-capture'
    || !SHA256_PATTERN.test(String(captureAdapter?.executable_sha256 || ''))
    || captureAdapter?.owner_uid !== 0
    || !CAPTURE_ID_PATTERN.test(String(captureAdapter?.adapter_id || ''))
    || !CAPTURE_ID_PATTERN.test(String(captureAdapter?.adapter_version || ''))
    || !CAPTURE_ID_PATTERN.test(String(captureAdapter?.run_id || ''))
    || !CAPTURE_ID_PATTERN.test(String(captureAdapter?.receipt_id || ''))
    || captureAdapter?.receipt_path !== 'desktop-bridge/production-adapter-receipt.json'
    || !SHA256_PATTERN.test(String(captureAdapter?.receipt_sha256 || ''))) {
    input.blockers.push('physical_evidence_artifact_manifest_capture_adapter_invalid')
  }

  const entries = Array.isArray(manifest?.entries) ? manifest.entries : []
  if (entries.length < 1) input.blockers.push('physical_evidence_artifact_manifest_entries_invalid')
  const entryPaths = entries.map((entry: any) => String(entry?.path || ''))
  if (new Set(entryPaths).size !== entryPaths.length || JSON.stringify(entryPaths) !== JSON.stringify([...entryPaths].sort())) {
    input.blockers.push('physical_evidence_artifact_manifest_inventory_invalid')
  }
  const expectedPrefix = `release-evidence/${input.version}/`
  for (const entry of entries) {
    const relativePath = String(entry?.path || '')
    const expectedSha256 = String(entry?.sha256 || '')
    const expectedBytes = entry?.bytes
    if (!safeArchivePath(relativePath) || !relativePath.startsWith(expectedPrefix)) {
      input.blockers.push(`physical_evidence_artifact_manifest_path_invalid:${relativePath || 'missing'}`)
      continue
    }
    if (!SHA256_PATTERN.test(expectedSha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1) {
      input.blockers.push(`physical_evidence_artifact_manifest_entry_invalid:${relativePath}`)
      continue
    }
    const member = listed?.get(relativePath)
    if (!member) {
      input.blockers.push(`physical_evidence_artifact_archive_entry_missing:${relativePath}`)
      continue
    }
    const memberBytes = readArchiveMember(archivePath, member, `physical_evidence_artifact_entry:${relativePath}`, input.blockers)
    if (!memberBytes || memberBytes.length !== expectedBytes || sha256(memberBytes) !== expectedSha256.toLowerCase()) {
      input.blockers.push(`physical_evidence_artifact_archive_entry_mismatch:${relativePath}`)
    }
    if (memberBytes && containsSecretBytes(memberBytes)) {
      input.blockers.push(`physical_evidence_artifact_secret_material:${relativePath}`)
    }
    const extractedPath = path.resolve(input.root, relativePath)
    const extractedRelative = path.relative(input.root, extractedPath)
    const extractedBytes = safeArchivePath(extractedRelative.split(path.sep).join('/')) ? readRegularFile(extractedPath) : null
    if (!extractedBytes || extractedBytes.length !== expectedBytes || sha256(extractedBytes) !== expectedSha256.toLowerCase()) {
      input.blockers.push(`physical_evidence_artifact_extracted_entry_mismatch:${relativePath}`)
    }
  }
  if (listed) {
    const expectedFiles = new Set([PHYSICAL_RELEASE_EVIDENCE_MANIFEST, ...entryPaths])
    const unexpected = [...listed.keys()].filter((entry) => !expectedFiles.has(entry))
    const missing = [...expectedFiles].filter((entry) => !listed.has(entry))
    if (unexpected.length > 0 || missing.length > 0 || listed.size !== expectedFiles.size) {
      input.blockers.push('physical_evidence_artifact_archive_inventory_mismatch')
    }
  }
  if (input.blockers.length !== blockerCount || !invocationUri || !archiveManifestBytes) return null
  return {
    schema: 'sks.release-physical-evidence-artifact-attestation.v1',
    archive_path: relativeOrAbsolute(input.root, archivePath),
    archive_sha256: archiveSha256,
    manifest_sha256: sha256(archiveManifestBytes),
    github_repository: repository,
    trusted_workflow: trustedWorkflow,
    workflow_run_id: runId,
    run_invocation_uri: invocationUri,
    artifact_name: expectedArtifactName,
    entry_count: entries.length,
    capture_adapter_executable_sha256: String(captureAdapter?.executable_sha256 || '').toLowerCase(),
    capture_adapter_id: String(captureAdapter?.adapter_id || ''),
    capture_adapter_version: String(captureAdapter?.adapter_version || ''),
    capture_adapter_run_id: String(captureAdapter?.run_id || ''),
    capture_adapter_receipt_id: String(captureAdapter?.receipt_id || ''),
    capture_adapter_receipt_sha256: String(captureAdapter?.receipt_sha256 || '').toLowerCase()
  }
}

function verifyGithubArtifactAttestation(input: {
  archivePath: string
  repository: string
  trustedWorkflow: string
  sourceCommit: string
  runId: string
  blockers: string[]
}): string | null {
  // Verifying the same archive bytes against the same repo/workflow/digest
  // always yields the same certificate, so the `gh` spawn is memoized on those
  // inputs. Blockers are replayed by the caller-visible return contract below.
  const key = inspectionKey(
    input.archivePath,
    fileIdentity(input.archivePath),
    toolIdentity('gh'),
    input.repository,
    input.trustedWorkflow,
    input.sourceCommit,
    input.runId
  )
  const verdict = memoizeReleaseInspection('github-artifact-attestation', key, () => {
    const blockers: string[] = []
    const invocationUri = computeGithubArtifactAttestation({ ...input, blockers })
    return { invocation_uri: invocationUri, blockers }
  })
  input.blockers.push(...verdict.blockers)
  return verdict.invocation_uri
}

function computeGithubArtifactAttestation(input: {
  archivePath: string
  repository: string
  trustedWorkflow: string
  sourceCommit: string
  runId: string
  blockers: string[]
}): string | null {
  const result = spawnSync('gh', [
    'attestation', 'verify', input.archivePath,
    '--repo', input.repository,
    '--signer-workflow', input.trustedWorkflow,
    '--source-digest', input.sourceCommit,
    '--format', 'json'
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.status !== 0) {
    input.blockers.push('physical_evidence_attestation_verification_failed')
    return null
  }
  let rows: any
  try {
    rows = JSON.parse(String(result.stdout || ''))
  } catch {
    input.blockers.push('physical_evidence_attestation_output_invalid')
    return null
  }
  const certificates = (Array.isArray(rows) ? rows : [rows])
    .map((row: any) => row?.verificationResult?.signature?.certificate)
    .filter((certificate: any) => certificate && typeof certificate === 'object')
  const expected = `https://github.com/${input.repository}/actions/runs/${input.runId}/attempts/`
  const invocationUris = certificates.flatMap((certificate: any) => collectNamedStrings(certificate, 'runInvocationURI'))
  const invocationUri = invocationUris.find((uri) => uri.startsWith(expected) && /^\d+$/.test(uri.slice(expected.length))) || null
  if (!invocationUri) input.blockers.push('physical_evidence_attestation_run_binding_invalid')
  return invocationUri
}

function collectNamedStrings(value: unknown, wanted: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry) => collectNamedStrings(entry, wanted))
  if (!value || typeof value !== 'object') return []
  const output: string[] = []
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === wanted.toLowerCase() && typeof child === 'string') output.push(child)
    output.push(...collectNamedStrings(child, wanted))
  }
  return output
}

function readBoundArchive(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 512 * 1024 * 1024) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function listArchiveFiles(archivePath: string, blockers: string[]): Map<string, string> | null {
  const listing = memoizeReleaseInspection(
    'physical-archive-listing',
    inspectionKey(archivePath, fileIdentity(archivePath), toolIdentity('tar')),
    () => {
      const own: string[] = []
      const files = computeArchiveFiles(archivePath, own)
      return { entries: files ? [...files] : null, blockers: own }
    }
  )
  blockers.push(...listing.blockers)
  return listing.entries ? new Map(listing.entries) : null
}

function computeArchiveFiles(archivePath: string, blockers: string[]): Map<string, string> | null {
  const result = spawnSync('tar', ['-tzf', archivePath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) {
    blockers.push('physical_evidence_artifact_archive_unreadable')
    return null
  }
  const files = new Map<string, string>()
  for (const rawLine of String(result.stdout || '').split(/\r?\n/)) {
    const raw = rawLine.trim()
    if (!raw) continue
    const normalized = raw.replace(/^\.\//, '')
    const pathToValidate = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
    if (!safeArchivePath(pathToValidate)) {
      blockers.push('physical_evidence_artifact_archive_path_invalid')
      return null
    }
    if (normalized.endsWith('/')) continue
    if (files.has(normalized)) blockers.push(`physical_evidence_artifact_archive_duplicate:${normalized}`)
    else files.set(normalized, raw)
  }
  return files
}

function readArchiveMember(archivePath: string, member: string, label: string, blockers: string[]): Buffer | null {
  const bytes = memoizeReleaseInspection(
    'physical-archive-member',
    inspectionKey(archivePath, fileIdentity(archivePath), toolIdentity('tar'), member),
    () => {
      const result = spawnSync('tar', ['-xOzf', archivePath, member], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
      return result.status !== 0 || !Buffer.isBuffer(result.stdout) ? null : result.stdout
    },
    (value) => (value ? cloneBuffer(value) : null)
  )
  if (!bytes) {
    blockers.push(`${label}_unreadable`)
    return null
  }
  return bytes
}

function safeArchivePath(value: string): boolean {
  if (!value || value.includes('\\') || value.startsWith('/') || value.endsWith('/')) return false
  const parts = value.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..' && /^[A-Za-z0-9._-]+$/.test(part))
}

function relativeOrAbsolute(root: string, file: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(file))
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? relative.split(path.sep).join('/')
    : path.resolve(file)
}

function validateCaptureAdapterBinding(
  receipt: any,
  gates: any[],
  attestation: PhysicalReleaseEvidenceArtifactAttestation | null,
  desktop: DesktopBridgeReleaseEvidenceInspection | null,
  blockers: string[]
): void {
  if (!attestation || !desktop || !desktop.ok) return
  const bindingValid = receipt?.capture_adapter_id === desktop.adapter_id
    && receipt?.capture_adapter_version === desktop.adapter_version
    && receipt?.capture_adapter_receipt_id === desktop.adapter_receipt_id
    && receipt?.capture_adapter_receipt_sha256 === desktop.adapter_receipt_sha256
    && attestation.capture_adapter_id === desktop.adapter_id
    && attestation.capture_adapter_version === desktop.adapter_version
    && attestation.capture_adapter_run_id === desktop.adapter_run_id
    && attestation.capture_adapter_receipt_id === desktop.adapter_receipt_id
    && attestation.capture_adapter_receipt_sha256 === desktop.adapter_receipt_sha256
  if (!bindingValid) blockers.push('physical_receipt_capture_adapter_binding_mismatch')
  for (const gate of gates) {
    const id = String(gate?.id || 'missing')
    if (gate?.capture_adapter_id !== desktop.adapter_id
      || gate?.capture_adapter_version !== desktop.adapter_version
      || gate?.producer_receipt_id !== desktop.adapter_receipt_id
      || gate?.producer_receipt_sha256 !== desktop.adapter_receipt_sha256) {
      blockers.push(`physical_receipt_gate_adapter_binding_mismatch:${id}`)
    }
  }
}

function validateSourceBinding(releaseSourceCommit: string, headCommit: string, blockers: string[]): void {
  if (releaseSourceCommit !== headCommit) blockers.push('physical_receipt_source_commit_mismatch')
}

function validateGate(
  gate: any,
  id: PhysicalReleaseGateId,
  version: string,
  sourceCommit: string,
  evidenceRoot: string,
  now: number,
  blockers: string[]
): void {
  if (gate.ok !== true) blockers.push(`physical_receipt_gate_not_ok:${id}`)
  if (gate.evidence_kind !== 'real') blockers.push(`physical_receipt_gate_not_real:${id}`)
  if (gate.fixture !== false || gate.mock !== false || gate.synthetic !== false) blockers.push(`physical_receipt_gate_synthetic:${id}`)
  if (gate.redacted !== true || gate.secrets_present !== false) blockers.push(`physical_receipt_gate_redaction_invalid:${id}`)
  if (!CAPTURE_ID_PATTERN.test(String(gate.capture_adapter_id || ''))
    || !CAPTURE_ID_PATTERN.test(String(gate.capture_adapter_version || ''))
    || !CAPTURE_ID_PATTERN.test(String(gate.producer_receipt_id || ''))
    || !SHA256_PATTERN.test(String(gate.producer_receipt_sha256 || ''))) {
    blockers.push(`physical_receipt_gate_adapter_identity_invalid:${id}`)
  }
  if (gate.package_version !== version) blockers.push(`physical_receipt_gate_version_mismatch:${id}`)
  if (!COMMIT_PATTERN.test(String(gate.source_commit || '')) || gate.source_commit !== sourceCommit) {
    blockers.push(`physical_receipt_gate_source_commit_mismatch:${id}`)
  }
  validateFreshDate(gate.performed_at, `physical_receipt_gate_time:${id}`, now, blockers)
  if (!String(gate.reviewer || '').trim()) blockers.push(`physical_receipt_gate_reviewer_missing:${id}`)
  if (!String(gate.summary || '').trim()) blockers.push(`physical_receipt_gate_summary_missing:${id}`)
  const artifact = validateArtifactReference(gate.artifact_path, gate.artifact_sha256, id, evidenceRoot, null, blockers)
  if (id !== 'desktop_bridge_live_evidence' && artifact) {
    validateGenericGateArtifact(artifact, gate, id, version, sourceCommit, evidenceRoot, blockers)
  }
  if (artifact && containsSecretBytes(artifact)) blockers.push(`physical_receipt_artifact_secret_material:${id}`)
  validateObservations(gate.observations || {}, id, version, sourceCommit, evidenceRoot, artifact, now, blockers)
}

export function physicalGateObservationsSha256(value: unknown): string {
  return sha256(Buffer.from(canonicalJson(value)))
}

function validateGenericGateArtifact(
  bytes: Buffer,
  gate: any,
  id: PhysicalReleaseGateId,
  version: string,
  sourceCommit: string,
  evidenceRoot: string,
  blockers: string[]
): void {
  const artifact = parseJson(bytes)
  const producer = artifact?.producer
  if (artifact?.schema !== 'sks.release-physical-gate-artifact.v2'
    || artifact?.gate_id !== id
    || artifact?.package_version !== version
    || artifact?.source_commit !== sourceCommit
    || producer?.schema !== 'sks.release-physical-gate-producer.v1'
    || producer?.capture_adapter_id !== gate.capture_adapter_id
    || producer?.capture_adapter_version !== gate.capture_adapter_version
    || producer?.receipt_id !== gate.producer_receipt_id
    || producer?.receipt_sha256 !== gate.producer_receipt_sha256
    || producer?.command_id !== genericGateCommandId(id)
    || !CAPTURE_ID_PATTERN.test(String(producer?.invocation_id || ''))
    || producer?.exit_code !== 0
    || producer?.fixture !== false
    || producer?.mock !== false
    || producer?.synthetic !== false
    || !validDate(producer?.started_at)
    || !validDate(producer?.completed_at)
    || Date.parse(producer.completed_at) < Date.parse(producer.started_at)
    || producer?.completed_at !== gate.performed_at) {
    blockers.push(`physical_receipt_gate_artifact_contract_invalid:${id}`)
    return
  }
  const outputBytes = validateArtifactReference(
    producer.output_path,
    producer.output_sha256,
    id,
    evidenceRoot,
    'producer_output',
    blockers
  )
  const output = outputBytes ? parseJson(outputBytes) : null
  if (outputBytes && containsSecretBytes(outputBytes)) blockers.push(`physical_receipt_gate_producer_output_secret_material:${id}`)
  const derived = deriveGenericGateObservations(id, output?.measurement)
  if (output?.schema !== 'sks.release-physical-gate-producer-output.v1'
    || output?.gate_id !== id
    || output?.capture_adapter_id !== gate.capture_adapter_id
    || output?.capture_adapter_version !== gate.capture_adapter_version
    || output?.producer_receipt_id !== gate.producer_receipt_id
    || output?.invocation_id !== producer.invocation_id
    || output?.fixture !== false
    || output?.mock !== false
    || output?.synthetic !== false
    || !derived
    || canonicalJson(derived) !== canonicalJson(gate.observations || {})) {
    blockers.push(`physical_receipt_gate_producer_output_invalid:${id}`)
  }
}

function genericGateCommandId(id: PhysicalReleaseGateId): string {
  return ({
    update_5001_directory: 'sks.update.physical',
    single_menubar_process: 'sks.menubar.process-readback',
    codex_lb_measured_request: 'sks.codex-lb.measured-request',
    desktop_bridge_live_evidence: 'sks.desktop-bridge.live-evidence'
  } as const)[id]
}

function deriveGenericGateObservations(id: PhysicalReleaseGateId, measurement: any): Record<string, unknown> | null {
  if (id === 'update_5001_directory') {
    if (!Number.isSafeInteger(measurement?.directories_scanned)
      || measurement?.update_exit_code !== 0
      || !Array.isArray(measurement?.warning_codes)
      || !Array.isArray(measurement?.residue_paths)) return null
    return {
      directories_encountered: measurement.directories_scanned,
      update_status: 'succeeded',
      warning_code: measurement.warning_codes.includes('guidance_scan_truncated') ? 'guidance_scan_truncated' : '',
      false_residue_blockers: measurement.residue_paths.length
    }
  }
  if (id === 'single_menubar_process') {
    if (!Array.isArray(measurement?.processes) || typeof measurement?.prior_version !== 'string') return null
    const current = measurement.processes.filter((entry: any) => entry?.role === 'sks-menubar')
    return {
      process_count: current.length,
      running_version: current.length === 1 ? current[0]?.version : null,
      prior_version: measurement.prior_version,
      process_readback: measurement.readback_source === 'launchctl-and-process-table'
    }
  }
  if (id === 'codex_lb_measured_request') {
    if (!CAPTURE_ID_PATTERN.test(String(measurement?.request_id || ''))
      || !Number.isFinite(measurement?.latency_ms)) return null
    return {
      selected: measurement.selected_target === 'codex-lb',
      measured: Boolean(measurement.response_sha256 && SHA256_PATTERN.test(String(measurement.response_sha256))),
      target_matches_configured: measurement.selected_target === measurement.configured_target,
      auth_class: measurement.auth_class,
      oauth_fallback: measurement.oauth_header_present === true,
      latency_ms: measurement.latency_ms
    }
  }
  return null
}

function validateArtifactReference(
  artifactPath: unknown,
  artifactSha256: unknown,
  id: PhysicalReleaseGateId,
  evidenceRoot: string,
  scope: string | null,
  blockers: string[]
): Buffer | null {
  const suffix = scope ? `:${id}:${scope}` : `:${id}`
  const rel = String(artifactPath || '')
  if (!rel || path.isAbsolute(rel)) {
    blockers.push(`physical_receipt_artifact_path_invalid${suffix}`)
    return null
  }
  const file = path.resolve(evidenceRoot, rel)
  const relative = path.relative(evidenceRoot, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    blockers.push(`physical_receipt_artifact_path_invalid${suffix}`)
    return null
  }
  const bytes = readRegularFile(file)
  if (!bytes) {
    blockers.push(fs.existsSync(file)
      ? `physical_receipt_artifact_not_regular${suffix}`
      : `physical_receipt_artifact_missing${suffix}`)
    return null
  }
  if (bytes.length < 1 || bytes.length > MAX_PHYSICAL_RELEASE_ARTIFACT_BYTES) {
    blockers.push(`physical_receipt_artifact_size_invalid${suffix}`)
    return null
  }
  const expected = String(artifactSha256 || '')
  if (!SHA256_PATTERN.test(expected) || sha256(bytes) !== expected.toLowerCase()) {
    blockers.push(`physical_receipt_artifact_hash_mismatch${suffix}`)
  }
  return bytes
}

function validateObservations(
  observations: any,
  id: PhysicalReleaseGateId,
  version: string,
  sourceCommit: string,
  evidenceRoot: string,
  artifact: Buffer | null,
  now: number,
  blockers: string[]
): void {
  if (id === 'update_5001_directory') {
    if (!Number.isSafeInteger(observations.directories_encountered) || observations.directories_encountered < 5001) blockers.push(`physical_receipt_observation_invalid:${id}:directories`)
    if (observations.update_status !== 'succeeded') blockers.push(`physical_receipt_observation_invalid:${id}:status`)
    if (observations.warning_code !== 'guidance_scan_truncated') blockers.push(`physical_receipt_observation_invalid:${id}:warning`)
    if (observations.false_residue_blockers !== 0) blockers.push(`physical_receipt_observation_invalid:${id}:residue`)
  } else if (id === 'single_menubar_process') {
    if (observations.process_count !== 1) blockers.push(`physical_receipt_observation_invalid:${id}:count`)
    if (observations.running_version !== version) blockers.push(`physical_receipt_observation_invalid:${id}:version`)
    if (!observations.prior_version || observations.prior_version === version) blockers.push(`physical_receipt_observation_invalid:${id}:prior_version`)
    if (observations.process_readback !== true) blockers.push(`physical_receipt_observation_invalid:${id}:readback`)
  } else if (id === 'codex_lb_measured_request') {
    if (observations.selected !== true || observations.measured !== true) blockers.push(`physical_receipt_observation_invalid:${id}:measurement`)
    if (observations.target_matches_configured !== true) blockers.push(`physical_receipt_observation_invalid:${id}:target`)
    if (observations.auth_class !== 'gateway-key' || observations.oauth_fallback !== false) blockers.push(`physical_receipt_observation_invalid:${id}:auth`)
    if (!Number.isFinite(observations.latency_ms) || observations.latency_ms < 0) blockers.push(`physical_receipt_observation_invalid:${id}:latency`)
  } else if (id === 'desktop_bridge_live_evidence') {
    if (observations.release_authorizing !== true
      || observations.capture_platform !== 'darwin'
      || observations.both_providers_verified !== true
      || observations.oauth_preserved !== true
      || observations.websocket_verified !== true
      || observations.native_ui_screenshot_verified !== true
      || observations.production_deep_artifacts_verified !== true) {
      blockers.push(`physical_receipt_observation_invalid:${id}:release_contract`)
    }
  }
}

function parseJson(bytes: Buffer | null): any | null {
  if (!bytes) return null
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

function readRegularFile(file: string): Buffer | null {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function validateFreshDate(value: unknown, blockerPrefix: string, now: number, blockers: string[]): void {
  const timestamp = typeof value === 'string' ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(timestamp)) {
    blockers.push(`${blockerPrefix}_invalid`)
    return
  }
  if (timestamp > now + MAX_PHYSICAL_RELEASE_FUTURE_SKEW_MS) blockers.push(`${blockerPrefix}_future`)
  if (now - timestamp > MAX_PHYSICAL_RELEASE_EVIDENCE_AGE_MS) blockers.push(`${blockerPrefix}_stale`)
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false
  return JSON.stringify(value.map(String).sort()) === JSON.stringify([...expected].sort())
}

function containsSecretBytes(bytes: Buffer): boolean {
  const text = bytes.toString('utf8')
  return /(?:"|')?(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|cookie|secret_value|credential_value)(?:"|')?\s*[:=]/i.test(text)
    || /\b(?:sk|or|sess|key)-[A-Za-z0-9_-]{8,}\b|Bearer\s+[A-Za-z0-9._~+/-]{8,}/i.test(text)
}

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function gitHead(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() || null : null
}
