import path from 'node:path'
import { readJson } from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'
import { runCodexTask } from '../codex-control/codex-task-runner.js'
import { THINKING_SUBAGENT_MODEL, SUBAGENT_EFFORT } from '../subagents/model-policy.js'
import {
  normalizeClaimEvidenceMatrix,
  validateClaimEvidenceMatrix,
  type ClaimEvidenceMatrix
} from './claim-evidence-matrix.js'

export async function synthesizeResearchClaimEvidenceMatrix(input: {
  root: string
  dir: string
  plan: any
  sourceLedger: any
  timeoutMs: number
  deadlineMs?: number
  backendPreference?: Array<'codex-sdk' | 'python-codex-sdk'>
}): Promise<{ matrix: ClaimEvidenceMatrix; blockers: string[]; worker_result_path: string | null }> {
  const result = await runCodexTask({
    route: '$Research',
    tier: 'orchestrator',
    missionId: String(input.plan?.mission_id || 'research-claim-synthesis'),
    workItemId: 'research_claim_semantic_synthesis',
    cwd: input.root,
    prompt: buildResearchClaimSynthesisPrompt(input),
    inputFiles: [path.join(input.dir, 'source-ledger.json')],
    outputSchema: researchClaimEvidenceMatrixOutputSchema,
    outputSchemaId: 'sks.claim-evidence-matrix.v1',
    sandboxPolicy: 'read-only',
    requestedScopeContract: {
      id: 'research-claim-semantic-synthesis',
      route: '$Research',
      read_only: true,
      allowed_paths: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
      write_paths: [],
      allowed_write_prefixes: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
      source_mutation_allowed: false
    },
    backendPreference: input.backendPreference || ['codex-sdk', 'python-codex-sdk'],
    allowLocalLlm: false,
    localLlmPolicy: { mode: 'disabled', requiresGptFinal: true },
    mutationLedgerRoot: path.join(input.dir, 'research', 'claim-synthesis-codex-control'),
    reliabilityPolicy: {
      timeoutClass: 'standard',
      idleTimeoutMs: input.timeoutMs,
      hardTimeoutMs: input.timeoutMs,
      ...(input.deadlineMs === undefined ? {} : { deadlineEpochMs: input.deadlineMs })
    },
    model: THINKING_SUBAGENT_MODEL,
    reasoningEffort: SUBAGENT_EFFORT,
    modelReasoningEffort: SUBAGENT_EFFORT,
    serviceTier: 'fast'
  })
  const worker = await readJson<any>(result.workerResultPath as string, null)
  const recalculated = recalculateResearchClaimEvidenceMatrix(worker, input.plan, input.sourceLedger)
  const validation = validateClaimEvidenceMatrix(recalculated, input.sourceLedger, null)
  const blockers = unique([
    ...(Array.isArray(result.blockers) ? result.blockers.map(String) : []),
    ...(Array.isArray(worker?.blockers) ? worker.blockers.map(String) : []),
    ...recalculated.blockers,
    ...validation.blockers
  ])
  return {
    matrix: normalizeClaimEvidenceMatrix({ ...recalculated, blockers }),
    blockers,
    worker_result_path: typeof result.workerResultPath === 'string' ? result.workerResultPath : null
  }
}

export function recalculateResearchClaimEvidenceMatrix(value: any, plan: any, sourceLedger: any): ClaimEvidenceMatrix {
 const normalized = normalizeClaimEvidenceMatrix(value)
 const sources = allSources(sourceLedger)
 const byId = new Map(sources.map((source) => [String(source?.id || ''), source]))
 const claims = normalized.claims.map((claim) => {
   const evidenceBlockers: string[] = []
    const counterevidenceLinks = claim.counterevidence_links.filter((link) => {
      if (link.target_claim_id !== claim.id) {
        evidenceBlockers.push(`claim_counterevidence_target_mismatch:${claim.id}:${link.source_id}`)
        return false
      }
      if (link.contradiction_rationale.length < 32 || !sourceSemanticallyOverlapsClaim({ notes: link.contradiction_rationale }, claim.claim)) {
        evidenceBlockers.push(`claim_counterevidence_rationale_not_claim_relative:${claim.id}:${link.source_id}`)
        return false
      }
      return true
    })
    const counterevidenceLinksBySource = new Map(counterevidenceLinks.map((link) => [link.source_id, link]))
    const sourceIds = unique(claim.source_ids).filter((sourceId) => {
      const source = byId.get(sourceId)
      if (!source) {
        evidenceBlockers.push(`claim_source_unknown:${claim.id}:${sourceId}`)
        return false
      }
      if (!trustworthyVerifiedEvidence(source)) {
        evidenceBlockers.push(`claim_source_not_verified:${claim.id}:${sourceId}`)
        return false
      }
     if (!sourceSemanticallyOverlapsClaim(source, claim.claim)) {
        evidenceBlockers.push(`claim_source_semantic_overlap_missing:${claim.id}:${sourceId}`)
        return false
      }
      return true
    })
    const counterevidenceIds = unique(claim.counterevidence_ids).filter((sourceId) => {
      const source = byId.get(sourceId)
      if (!source) {
        evidenceBlockers.push(`claim_counterevidence_unknown:${claim.id}:${sourceId}`)
        return false
      }
      if (!trustworthyVerifiedEvidence(source)) {
        evidenceBlockers.push(`claim_counterevidence_not_verified:${claim.id}:${sourceId}`)
        return false
      }
      if (!counterevidenceLinksBySource.has(sourceId)) {
       evidenceBlockers.push(`claim_counterevidence_link_missing:${claim.id}:${sourceId}`)
       return false
     }
      if (sourceIds.includes(sourceId)) {
        evidenceBlockers.push(`claim_counterevidence_also_used_as_support:${claim.id}:${sourceId}`)
        return false
      }
      if (!sourceSemanticallyOverlapsClaim(source, claim.claim)) {
        evidenceBlockers.push(`claim_counterevidence_semantic_overlap_missing:${claim.id}:${sourceId}`)
        return false
      }
      return true
    })
    const supportRows = sourceIds.map((id) => byId.get(id)).filter(Boolean)
    const counterRows = counterevidenceIds.map((id) => byId.get(id)).filter(Boolean)
    const supportLayers = unique(supportRows.map((row: any) => String(row?.layer || '')).filter(Boolean))
    const layers = unique([...supportRows, ...counterRows].map((row: any) => String(row?.layer || '')).filter(Boolean))
    const independenceKeys = unique(supportRows.map(sourceIndependenceKey).filter(Boolean))
    const authoritativeSupportCount = supportRows.filter(authoritativeSupportingEvidence).length
    const independentConfirmationCount = independenceKeys.length
    const highConfidence = sourceIds.length >= 3
      && independentConfirmationCount >= 3
      && supportLayers.length >= 3
      && authoritativeSupportCount >= 2
      && counterevidenceIds.length > 0
      && evidenceBlockers.length === 0
    const mediumConfidence = sourceIds.length >= 2
      && independentConfirmationCount >= 2
      && supportLayers.length >= 2
      && authoritativeSupportCount >= 1
      && evidenceBlockers.length === 0
    return {
     ...claim,
     source_ids: sourceIds,
     counterevidence_ids: counterevidenceIds,
      counterevidence_links: counterevidenceLinks.filter((link) => counterevidenceIds.includes(link.source_id)),
      local_evidence_ids: sourceIds.filter((id) => byId.get(id)?.layer === 'local_project_evidence'),
      triangulation: {
        source_layers: layers,
        independent_confirmation_count: independentConfirmationCount,
        conflicts: counterevidenceIds.length ? [`counterevidence:${counterevidenceIds.join(',')}`] : []
      },
      confidence: highConfidence ? 'high' as const : mediumConfidence ? 'medium' as const : 'low' as const,
      evidence_blockers: unique(evidenceBlockers),
      support_layer_count: supportLayers.length,
      authoritative_support_count: authoritativeSupportCount
    }
  })
  const unsupported = unique([
    ...normalized.unsupported_claims,
    ...claims.filter((claim: any) => {
      const important = claim.importance === 'high' || claim.importance === 'critical'
      return important && (
        claim.source_ids.length < 2
        || claim.triangulation.independent_confirmation_count < 2
        || claim.support_layer_count < 2
        || claim.authoritative_support_count < 1
        || claim.evidence_blockers.length > 0
        || (claim.importance === 'critical' && claim.counterevidence_ids.length === 0)
      )
    }).map((claim: any) => claim.id)
  ])
  const evidenceBlockers = claims.flatMap((claim: any) => claim.evidence_blockers)
  const outputClaims = claims.map(({
    evidence_blockers: _evidenceBlockers,
    support_layer_count: _supportLayerCount,
    authoritative_support_count: _authoritativeSupportCount,
    ...claim
  }: any) => claim)
  return normalizeClaimEvidenceMatrix({
    schema: 'sks.claim-evidence-matrix.v1',
    mission_id: String(value?.mission_id || plan?.mission_id || ''),
    claims: outputClaims,
    key_claim_ids: normalized.key_claim_ids,
    unsupported_claims: unsupported,
    triangulated_claim_count: outputClaims.filter((claim: any) => claim.triangulation.source_layers.length >= 2 && claim.triangulation.independent_confirmation_count >= 2).length,
    blockers: unique([
      ...normalized.blockers,
      ...evidenceBlockers,
      ...unsupported.map((id) => `unsupported_important_claim:${id}`)
    ])
  })
}

function buildResearchClaimSynthesisPrompt(input: { plan: any; sourceLedger: any }) {
  const contract = input.plan?.quality_contract || {}
  return [
    'Build a semantic claim-evidence matrix for this Research mission.',
    'This is a judgment-heavy task: use GPT-5.6 Sol with max reasoning.',
    'Return exactly one JSON object matching sks.claim-evidence-matrix.v1.',
    'Never reuse or merge discovery claim IDs merely because their strings match.',
    'Group sources only when their hydrated notes/content actually support the same written claim.',
    'Every supporting and counterevidence source id must exist in the supplied source ledger.',
    'A source title alone is not evidence. Use locator, author/date, credibility, notes/snippet, and content artifact/hash when present.',
    'Context, weak, partial, public-discourse-only, or discovery-only rows cannot support a high/critical claim.',
    'Critical claims require direct counterevidence or must be downgraded/blocked.',
    'Every counterevidence id must have a counterevidence_links row whose target_claim_id exactly equals the current claim id and whose contradiction_rationale explains the claim-relative conflict.',
    'Do not infer counterevidence from generic negative keywords; select it only when the hydrated source meaning directly challenges the written claim.',
    'Mark uncertainty and return explicit blockers when the evidence cannot satisfy the requested minimums.',
    `Mission: ${input.plan?.mission_id || 'unknown'}`,
    `Question: ${input.plan?.prompt || ''}`,
    `Target key claims: ${Number(contract.min_key_claims || 8)}`,
    `Target triangulated claims: ${Number(contract.min_trianguled_claims || 6)}`,
    '',
    'Evidence pack:',
    JSON.stringify(compactSourceLedger(input.sourceLedger), null, 2).slice(0, 30000)
  ].join('\n')
}

function compactSourceLedger(sourceLedger: any) {
  return {
    sources: allSources(sourceLedger).map((source: any) => ({
      id: source.id,
      layer: source.layer,
      kind: source.kind,
      title: source.title,
      locator: source.locator,
      publisher_or_author: source.publisher_or_author,
      published_at: source.published_at || null,
      accessed_at: source.accessed_at,
      reliability: source.reliability,
      credibility: source.credibility,
      stance: source.stance,
      notes: source.notes,
      content_artifact: source.content_artifact || null,
      content_sha256: source.content_sha256 || null,
      content_length: source.content_length || null,
      acquisition_verdict: source.acquisition_verdict || null,
      domain: source.domain || null,
      authority_tier: source.authority_tier || null,
      primary_source: source.primary_source === true,
      independence_cluster_id: source.independence_cluster_id || null
    })),
    blockers: Array.isArray(sourceLedger?.blockers) ? sourceLedger.blockers : []
  }
}

function allSources(sourceLedger: any): any[] {
  return [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ]
}

function trustworthyVerifiedEvidence(source: any): boolean {
  const verified = String(source?.acquisition_verdict || '') === 'verified_content'
    && /^verified_content:/i.test(String(source?.credibility || ''))
  const hydrated = Boolean(String(source?.content_artifact || '').trim())
    && /^[a-f0-9]{64}$/i.test(String(source?.content_sha256 || '').trim())
    && Number(source?.content_length || 0) > 0
  return verified && hydrated && source?.super_search_provenance?.validated === true
}

function authoritativeSupportingEvidence(source: any): boolean {
  if (!source || source?.layer === 'public_discourse') return false
  const tier = String(source?.authority_tier || '').toUpperCase()
  const reliability = String(source?.reliability || '').toLowerCase()
  return source?.primary_source === true
    || ['A0', 'A1', 'B'].includes(tier)
    || reliability === 'high'
    || reliability === 'medium-high'
}

function sourceIndependenceKey(source: any): string {
  const explicit = String(source?.independence_cluster_id || source?.domain || '').trim().toLowerCase()
  if (explicit) return explicit
  try {
    return new URL(String(source?.locator || '')).hostname.toLowerCase()
  } catch {
    return String(source?.publisher_or_author || '').trim().toLowerCase()
  }
}

function sourceSemanticallyOverlapsClaim(source: any, claim: string): boolean {
  const claimTokens = semanticTokens(claim)
  if (claimTokens.length === 0) return false
  const sourceTokens = new Set(semanticTokens([
    source?.title,
    source?.notes,
    source?.publisher_or_author,
    source?.locator
  ].filter(Boolean).join(' ')))
  const overlap = claimTokens.filter((token) => sourceTokens.has(token)).length
  const minimumOverlap = claimTokens.length <= 2 ? claimTokens.length : claimTokens.length <= 5 ? 2 : 3
  const minimumCoverage = claimTokens.length <= 3 ? 1 : 0.3
  return overlap >= minimumOverlap && overlap / claimTokens.length >= minimumCoverage
}

function semanticTokens(value: unknown): string[] {
  const stop = new Set(['about', 'after', 'before', 'been', 'being', 'could', 'evidence', 'finding', 'from', 'have', 'into', 'research', 'result', 'should', 'source', 'study', 'that', 'their', 'there', 'these', 'this', 'through', 'using', 'with'])
  return unique(String(value || '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{4,}/gu) || [])
    .filter((token) => !stop.has(token))
}

export const researchClaimEvidenceMatrixOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'mission_id', 'claims', 'key_claim_ids', 'unsupported_claims', 'triangulated_claim_count', 'blockers'],
  properties: {
    schema: { const: 'sks.claim-evidence-matrix.v1' },
    mission_id: { type: 'string' },
    claims: {
      type: 'array',
      items: {
        type: 'object',
       additionalProperties: false,
        required: ['id', 'claim', 'claim_type', 'importance', 'source_ids', 'local_evidence_ids', 'counterevidence_ids', 'counterevidence_links', 'triangulation', 'confidence', 'falsifiable', 'test_or_probe'],
       properties: {
          id: { type: 'string' },
          claim: { type: 'string' },
          claim_type: { enum: ['fact', 'inference', 'hypothesis', 'recommendation', 'implementation_guidance'] },
          importance: { enum: ['low', 'medium', 'high', 'critical'] },
          source_ids: { type: 'array', items: { type: 'string' } },
         local_evidence_ids: { type: 'array', items: { type: 'string' } },
         counterevidence_ids: { type: 'array', items: { type: 'string' } },
          counterevidence_links: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['source_id', 'target_claim_id', 'contradiction_rationale'],
              properties: {
                source_id: { type: 'string' },
                target_claim_id: { type: 'string' },
                contradiction_rationale: { type: 'string' }
              }
            }
          },
         triangulation: {
            type: 'object',
            additionalProperties: false,
            required: ['source_layers', 'independent_confirmation_count', 'conflicts'],
            properties: {
              source_layers: { type: 'array', items: { type: 'string' } },
              independent_confirmation_count: { type: 'number' },
              conflicts: { type: 'array', items: { type: 'string' } }
            }
          },
          confidence: { enum: ['low', 'medium', 'high'] },
          falsifiable: { type: 'boolean' },
          test_or_probe: { type: 'string' }
        }
      }
    },
    key_claim_ids: { type: 'array', items: { type: 'string' } },
    unsupported_claims: { type: 'array', items: { type: 'string' } },
    triangulated_claim_count: { type: 'number' },
    blockers: { type: 'array', items: { type: 'string' } }
  }
} as const
