import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const PHYSICAL_RELEASE_GATES_SCHEMA = 'sks.release-physical-gates.v1'
const MAX_PHYSICAL_RELEASE_ARTIFACT_BYTES = 8 * 1024 * 1024
export const PHYSICAL_RELEASE_GATE_IDS = [
  'update_5001_directory',
  'single_menubar_process',
  'codex_lb_measured_request',
  'telegram_cellular_e2e'
] as const

export type PhysicalReleaseGateId = typeof PHYSICAL_RELEASE_GATE_IDS[number]

export interface PhysicalReleaseGateInspectionOptions {
  readonly root: string
  readonly version: string
  readonly sourceCommit?: string | null
}

export interface PhysicalReleaseGateInspection {
  readonly schema: 'sks.release-physical-gates-inspection.v1'
  readonly ok: boolean
  readonly package_version: string
  readonly release_source_commit: string | null
  readonly head_commit: string | null
  readonly receipt_path: string
  readonly verified_gate_ids: string[]
  readonly blockers: string[]
}

export function inspectPhysicalReleaseGates(opts: PhysicalReleaseGateInspectionOptions): PhysicalReleaseGateInspection {
  const root = path.resolve(opts.root)
  const evidenceRoot = path.join(root, 'release-evidence', opts.version)
  const receiptPath = path.join(evidenceRoot, 'physical-gates.json')
  const headCommit = opts.sourceCommit === undefined ? gitHead(root) : opts.sourceCommit
  const blockers: string[] = []
  const receipt = readJson(receiptPath)

  if (!receipt) blockers.push('physical_receipt_missing_or_invalid')
  if (receipt && receipt.schema !== PHYSICAL_RELEASE_GATES_SCHEMA) blockers.push('physical_receipt_schema_invalid')
  if (receipt && receipt.ok !== true) blockers.push('physical_receipt_not_ok')
  if (receipt && receipt.package_version !== opts.version) blockers.push('physical_receipt_version_mismatch')
  if (!headCommit || !/^[a-f0-9]{40}$/i.test(headCommit)) blockers.push('physical_receipt_head_commit_unavailable')
  const releaseSourceCommit = String(receipt?.source_commit || '')
  if (receipt && !/^[a-f0-9]{40}$/i.test(releaseSourceCommit)) blockers.push('physical_receipt_source_commit_invalid')
  if (receipt && headCommit && /^[a-f0-9]{40}$/i.test(releaseSourceCommit)) {
    validateSourceBinding(root, evidenceRoot, releaseSourceCommit, headCommit, blockers)
  }

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
    validateGate(gate, id, opts.version, evidenceRoot, blockers)
  }

  return {
    schema: 'sks.release-physical-gates-inspection.v1',
    ok: blockers.length === 0,
    package_version: opts.version,
    release_source_commit: /^[a-f0-9]{40}$/i.test(releaseSourceCommit) ? releaseSourceCommit : null,
    head_commit: headCommit || null,
    receipt_path: path.relative(root, receiptPath).split(path.sep).join('/'),
    verified_gate_ids: PHYSICAL_RELEASE_GATE_IDS.filter((id) => !blockers.some((blocker) => blocker.includes(`:${id}`))),
    blockers: [...new Set(blockers)]
  }
}

function validateSourceBinding(root: string, evidenceRoot: string, releaseSourceCommit: string, headCommit: string, blockers: string[]): void {
  if (releaseSourceCommit === headCommit) return
  const ancestor = spawnSync('git', ['merge-base', '--is-ancestor', releaseSourceCommit, headCommit], { cwd: root, encoding: 'utf8' })
  if (ancestor.status !== 0) {
    blockers.push('physical_receipt_source_commit_mismatch')
    return
  }
  const diff = spawnSync('git', ['diff', '--name-only', `${releaseSourceCommit}..${headCommit}`, '--'], { cwd: root, encoding: 'utf8' })
  if (diff.status !== 0) {
    blockers.push('physical_receipt_source_diff_unavailable')
    return
  }
  const evidencePrefix = `${path.relative(root, evidenceRoot).split(path.sep).join('/')}/`
  const changed = String(diff.stdout || '').split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)
  const outsideEvidence = changed.filter((entry) => !entry.startsWith(evidencePrefix))
  if (outsideEvidence.length > 0) blockers.push(`physical_receipt_source_changed_after_capture:${outsideEvidence.slice(0, 8).join(',')}`)
}

function validateGate(gate: any, id: PhysicalReleaseGateId, version: string, evidenceRoot: string, blockers: string[]): void {
  if (gate.ok !== true) blockers.push(`physical_receipt_gate_not_ok:${id}`)
  if (gate.evidence_kind !== 'real') blockers.push(`physical_receipt_gate_not_real:${id}`)
  if (gate.fixture === true || gate.mock === true || gate.synthetic === true) blockers.push(`physical_receipt_gate_synthetic:${id}`)
  if (gate.redacted !== true || gate.secrets_present !== false) blockers.push(`physical_receipt_gate_redaction_invalid:${id}`)
  if (!validDate(gate.performed_at)) blockers.push(`physical_receipt_gate_time_invalid:${id}`)
  if (!String(gate.reviewer || '').trim()) blockers.push(`physical_receipt_gate_reviewer_missing:${id}`)
  if (!String(gate.summary || '').trim()) blockers.push(`physical_receipt_gate_summary_missing:${id}`)
  validateArtifact(gate, id, evidenceRoot, blockers)
  validateObservations(gate.observations || {}, id, version, blockers)
}

function validateArtifact(gate: any, id: PhysicalReleaseGateId, evidenceRoot: string, blockers: string[]): void {
  const rel = String(gate.artifact_path || '')
  if (!rel || path.isAbsolute(rel)) {
    blockers.push(`physical_receipt_artifact_path_invalid:${id}`)
    return
  }
  const file = path.resolve(evidenceRoot, rel)
  const relative = path.relative(evidenceRoot, file)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    blockers.push(`physical_receipt_artifact_path_invalid:${id}`)
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch {
    blockers.push(`physical_receipt_artifact_missing:${id}`)
    return
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    blockers.push(`physical_receipt_artifact_not_regular:${id}`)
    return
  }
  if (stat.size < 1 || stat.size > MAX_PHYSICAL_RELEASE_ARTIFACT_BYTES) {
    blockers.push(`physical_receipt_artifact_size_invalid:${id}`)
    return
  }
  const expected = String(gate.artifact_sha256 || '')
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (!/^[a-f0-9]{64}$/i.test(expected) || actual !== expected.toLowerCase()) {
    blockers.push(`physical_receipt_artifact_hash_mismatch:${id}`)
  }
}

function validateObservations(observations: any, id: PhysicalReleaseGateId, version: string, blockers: string[]): void {
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
  } else if (id === 'telegram_cellular_e2e') {
    if (observations.network !== 'cellular') blockers.push(`physical_receipt_observation_invalid:${id}:network`)
    if (observations.paired !== true || observations.allowlisted !== true) blockers.push(`physical_receipt_observation_invalid:${id}:authorization`)
    if (observations.typed_command !== true || observations.reply_received !== true) blockers.push(`physical_receipt_observation_invalid:${id}:roundtrip`)
    if (observations.bot_token_recorded !== false) blockers.push(`physical_receipt_observation_invalid:${id}:secret`)
  }
}

function readJson(file: string): any | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function validDate(value: unknown): boolean {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function gitHead(root: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? String(result.stdout || '').trim() || null : null
}
