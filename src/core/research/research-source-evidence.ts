import fsp from 'node:fs/promises'
import path from 'node:path'
import { sha256 } from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'

export type ResearchEvidenceExecutionClass = 'real' | 'mock_fixture'

export interface ResearchSourceEvidenceValidation {
  ok: boolean
  blockers: string[]
}

export function trustworthyVerifiedResearchSource(source: any): boolean {
  return String(source?.acquisition_verdict || '') === 'verified_content'
    && /^verified_content:/i.test(String(source?.credibility || ''))
    && Boolean(String(source?.content_artifact || '').trim())
    && /^[a-f0-9]{64}$/i.test(String(source?.content_sha256 || '').trim())
    && Number(source?.content_length || 0) > 0
    && source?.super_search_provenance?.validated === true
}

export function explicitResearchFixtureSource(source: any): boolean {
  return /^(?:deterministic_fixture|mock|selftest(?:-|$))/i.test(String(source?.kind || ''))
}

export async function validateResearchSourceProvenance(
  dir: string,
  source: any
): Promise<ResearchSourceEvidenceValidation> {
  const sourceId = String(source?.id || source?.source_id || '').trim() || 'unknown'
  const blockers: string[] = []
  if (String(source?.acquisition_verdict || '') !== 'verified_content') blockers.push(`research_source_not_verified:${sourceId}`)
  if (!/^verified_content:/i.test(String(source?.credibility || ''))) blockers.push(`research_source_credibility_unverified:${sourceId}`)
  if (!String(source?.content_artifact || '').trim()) blockers.push(`research_source_content_artifact_missing:${sourceId}`)
  if (!/^[a-f0-9]{64}$/i.test(String(source?.content_sha256 || '').trim())) blockers.push(`research_source_content_sha_invalid:${sourceId}`)
  if (!(Number(source?.content_length || 0) > 0)) blockers.push(`research_source_content_length_invalid:${sourceId}`)

  const provenance = source?.super_search_provenance
  if (provenance?.schema !== 'sks.research-super-search-source-provenance.v1') {
    blockers.push(`research_source_super_search_provenance_missing:${sourceId}`)
    return { ok: false, blockers: unique(blockers) }
  }
  if (String(provenance?.source_id || '') !== sourceId) blockers.push(`research_source_provenance_source_id_mismatch:${sourceId}`)

  const proofPath = resolveMissionArtifact(dir, provenance?.proof_artifact)
  const sourceLedgerPath = resolveMissionArtifact(dir, provenance?.source_ledger_artifact)
  if (!proofPath) blockers.push(`research_source_proof_path_invalid:${sourceId}`)
  if (!sourceLedgerPath) blockers.push(`research_source_ledger_path_invalid:${sourceId}`)
  if (!proofPath || !sourceLedgerPath) return { ok: false, blockers: unique(blockers) }

  const [proofBytes, sourceLedgerBytes] = await Promise.all([
    fsp.readFile(proofPath).catch(() => null),
    fsp.readFile(sourceLedgerPath).catch(() => null)
  ])
  if (!proofBytes) blockers.push(`research_source_proof_missing:${sourceId}`)
  if (!sourceLedgerBytes) blockers.push(`research_source_ledger_missing:${sourceId}`)
  if (!proofBytes || !sourceLedgerBytes) return { ok: false, blockers: unique(blockers) }

  const proofDigest = sha256(proofBytes)
  const sourceLedgerDigest = sha256(sourceLedgerBytes)
  if (!/^[a-f0-9]{64}$/i.test(String(provenance?.proof_sha256 || '')) || provenance.proof_sha256 !== proofDigest) {
    blockers.push(`research_source_proof_digest_mismatch:${sourceId}`)
  }
  if (!/^[a-f0-9]{64}$/i.test(String(provenance?.source_ledger_sha256 || '')) || provenance.source_ledger_sha256 !== sourceLedgerDigest) {
    blockers.push(`research_source_ledger_digest_mismatch:${sourceId}`)
  }

  const proof = parseJsonBuffer(proofBytes)
  const sourceLedger = parseJsonBuffer(sourceLedgerBytes)
  if (proof?.schema !== 'sks.super-search-proof.v1') blockers.push(`research_source_proof_schema_invalid:${sourceId}`)
  if (proof?.ok !== true || normalizedStrings(proof?.blockers).length > 0) blockers.push(`research_source_proof_blocked:${sourceId}`)
  if (sourceLedger?.schema !== 'sks.super-search-source-ledger.v1') blockers.push(`research_source_ledger_schema_invalid:${sourceId}`)

  const linkedSource = (Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : [])
    .find((candidate: any) => String(candidate?.source_id || candidate?.id || '').trim() === sourceId)
  if (!linkedSource) {
    blockers.push(`research_source_not_in_super_search_ledger:${sourceId}`)
    return { ok: false, blockers: unique(blockers) }
  }
  if (String(linkedSource?.acquisition_verdict || '') !== 'verified_content') blockers.push(`research_source_linked_verdict_unverified:${sourceId}`)
  if (String(linkedSource?.content_artifact || '') !== String(source?.content_artifact || '')) blockers.push(`research_source_content_artifact_mismatch:${sourceId}`)
  if (String(linkedSource?.content_sha256 || '') !== String(source?.content_sha256 || '')) blockers.push(`research_source_content_sha_mismatch:${sourceId}`)
  if (Number(linkedSource?.content_length || 0) !== Number(source?.content_length || 0)) blockers.push(`research_source_content_length_mismatch:${sourceId}`)

  const contentPath = resolveChildArtifact(path.dirname(sourceLedgerPath), linkedSource?.content_artifact)
  if (!contentPath) {
    blockers.push(`research_source_hydrated_content_path_invalid:${sourceId}`)
    return { ok: false, blockers: unique(blockers) }
  }
  const contentBytes = await fsp.readFile(contentPath).catch(() => null)
  if (!contentBytes) {
    blockers.push(`research_source_hydrated_content_missing:${sourceId}`)
    return { ok: false, blockers: unique(blockers) }
  }
  if (sha256(contentBytes) !== String(linkedSource?.content_sha256 || '')) blockers.push(`research_source_hydrated_content_sha_mismatch:${sourceId}`)
  if (contentBytes.toString('utf8').length !== Number(linkedSource?.content_length || 0)) blockers.push(`research_source_hydrated_content_length_mismatch:${sourceId}`)

  return { ok: blockers.length === 0, blockers: unique(blockers) }
}

export async function eligibleResearchSourceIdSet(
  dir: string,
  sourceLedger: any,
  executionClass: ResearchEvidenceExecutionClass | string
): Promise<Set<string>> {
  const rows = [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ]
  if (executionClass === 'mock_fixture') {
    return new Set(rows
      .filter((source: any) => explicitResearchFixtureSource(source))
      .map(sourceId)
      .filter(Boolean))
  }
  const eligible = await Promise.all(rows.map(async (source: any) => {
    const validation = await validateResearchSourceProvenance(dir, source)
    return validation.ok ? sourceId(source) : ''
  }))
  return new Set(eligible.filter(Boolean))
}

function resolveMissionArtifact(dir: string, artifact: unknown): string | null {
  return resolveChildArtifact(path.resolve(dir), artifact)
}

function resolveChildArtifact(parent: string, artifact: unknown): string | null {
  const raw = String(artifact || '').trim()
  if (!raw || path.isAbsolute(raw)) return null
  const root = path.resolve(parent)
  const candidate = path.resolve(root, raw)
  return candidate === root || candidate.startsWith(`${root}${path.sep}`) ? candidate : null
}

function parseJsonBuffer(bytes: Buffer): any | null {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
}

function sourceId(source: any): string {
  return String(source?.id || source?.source_id || '').trim()
}

function normalizedStrings(value: any): string[] {
  return (Array.isArray(value) ? value : value == null ? [] : [value]).map(String).map((item) => item.trim()).filter(Boolean)
}
