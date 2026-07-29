import path from 'node:path'
import { nowIso, readJson } from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'
import { runCodexTask } from '../codex-control/codex-task-runner.js'
import { THINKING_SUBAGENT_MODEL, SUBAGENT_EFFORT } from '../subagents/model-policy.js'

export async function runResearchFalsification(input: {
  root: string
  dir: string
  plan: any
  claimMatrix: any
  sourceLedger: any
  timeoutMs: number
  deadlineMs?: number
  backendPreference?: Array<'codex-sdk' | 'python-codex-sdk'>
}) {
  const result = await runCodexTask({
    route: '$Research',
    tier: 'orchestrator',
    missionId: String(input.plan?.mission_id || 'research-falsification'),
    workItemId: 'research_falsification',
    cwd: input.root,
    prompt: buildResearchFalsificationPrompt(input),
    inputFiles: [path.join(input.dir, 'claim-evidence-matrix.json'), path.join(input.dir, 'source-ledger.json')],
    outputSchema: researchFalsificationOutputSchema,
    outputSchemaId: 'sks.falsification-ledger.v1',
    sandboxPolicy: 'read-only',
    requestedScopeContract: {
      id: 'research-falsification',
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
    mutationLedgerRoot: path.join(input.dir, 'research', 'falsification-codex-control'),
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
  const normalized = normalizeResearchFalsification(worker, input.claimMatrix, input.sourceLedger)
  const blockers = unique([
    ...(Array.isArray(result.blockers) ? result.blockers.map(String) : []),
    ...normalized.blockers
  ])
  return {
    ...normalized,
    blockers,
    worker_result_path: typeof result.workerResultPath === 'string' ? result.workerResultPath : null
  }
}

export function normalizeResearchFalsification(value: any, claimMatrix: any, sourceLedger: any) {
  const knownClaimIds = new Set((Array.isArray(claimMatrix?.claims) ? claimMatrix.claims : []).map((claim: any) => String(claim?.id || '')).filter(Boolean))
  const knownSourceIds = new Set([
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ].map((source: any) => String(source?.id || '')).filter(Boolean))
  const blockers = normalizeStrings(value?.blockers)
  const cases = (Array.isArray(value?.cases) ? value.cases : []).map((row: any, index: number) => {
    const id = String(row?.id || `falsification-${index + 1}`).trim()
    const targetClaim = String(row?.target_claim || row?.claim_id || '').trim()
    const sourceIds = normalizeStrings(row?.source_ids).filter((sourceId) => knownSourceIds.has(sourceId))
    const result = ['survives', 'weakened', 'refuted', 'inconclusive'].includes(row?.result) ? row.result : 'inconclusive'
    if (!knownClaimIds.has(targetClaim)) blockers.push(`falsification_target_claim_unknown:${id}:${targetClaim || 'missing'}`)
    for (const sourceId of normalizeStrings(row?.source_ids)) {
      if (!knownSourceIds.has(sourceId)) blockers.push(`falsification_source_unknown:${id}:${sourceId}`)
    }
    if (!String(row?.attack || '').trim()) blockers.push(`falsification_attack_missing:${id}`)
    if (!sourceIds.length) blockers.push(`falsification_source_missing:${id}`)
    if (!String(row?.next_decisive_test || '').trim()) blockers.push(`falsification_next_test_missing:${id}`)
    return {
      id,
      target_claim: targetClaim,
      attack: String(row?.attack || '').trim(),
      source_ids: sourceIds,
      result,
      reasoning: String(row?.reasoning || '').trim(),
      limitations: normalizeStrings(row?.limitations),
      next_decisive_test: String(row?.next_decisive_test || '').trim()
    }
  })
  const unresolvedFailures = cases
    .filter((row: any) => row.result !== 'survives')
    .map((row: any) => `${row.target_claim}:${row.result}`)
  if (cases.length < 4) blockers.push('falsification_cases_below_contract')
  if (new Set(cases.map((row: any) => row.target_claim)).size < Math.min(4, knownClaimIds.size)) blockers.push('falsification_claim_coverage_below_contract')
  if (unresolvedFailures.length) blockers.push(...unresolvedFailures.map((row: string) => `falsification_unresolved:${row}`))
  return {
    schema_version: 1,
    schema: 'sks.falsification-ledger.v1',
    created_at: String(value?.created_at || nowIso()),
    execution_class: 'real',
    cases,
    unresolved_failures: unresolvedFailures,
    next_decisive_tests: unique(cases.map((row: any) => row.next_decisive_test).filter(Boolean)),
    blockers: unique(blockers)
  }
}

function buildResearchFalsificationPrompt(input: { plan: any; claimMatrix: any; sourceLedger: any }) {
  return [
    'Attempt to falsify the key claims in this Research mission before manuscript synthesis.',
    'This is a judgment-heavy task: use GPT-5.6 Sol with max reasoning.',
    'Return exactly one JSON object matching sks.falsification-ledger.v1.',
    'Do not mark a claim as surviving by default. Compare the written claim with actual source notes/content and counterevidence.',
    'Use only known claim IDs and source IDs. A generic attack with no source-linked reasoning is invalid.',
    'Allowed result values are survives, weakened, refuted, and inconclusive.',
    'If evidence is missing, use inconclusive and identify the decisive next test.',
    `Mission: ${input.plan?.mission_id || 'unknown'}`,
    `Question: ${input.plan?.prompt || ''}`,
    '',
    'Claim matrix and evidence:',
    JSON.stringify({
      claims: input.claimMatrix?.claims || [],
      sources: [
        ...(Array.isArray(input.sourceLedger?.sources) ? input.sourceLedger.sources : []),
        ...(Array.isArray(input.sourceLedger?.counterevidence_sources) ? input.sourceLedger.counterevidence_sources : [])
      ].map((source: any) => ({
        id: source.id,
        layer: source.layer,
        title: source.title,
        locator: source.locator,
        publisher_or_author: source.publisher_or_author,
        credibility: source.credibility,
        stance: source.stance,
        notes: source.notes,
        content_artifact: source.content_artifact || null,
        content_sha256: source.content_sha256 || null
      }))
    }, null, 2).slice(0, 30000)
  ].join('\n')
}

function normalizeStrings(value: any): string[] {
  return unique((Array.isArray(value) ? value : value == null ? [] : [value]).map((entry) => String(entry || '').trim()).filter(Boolean))
}

export const researchFalsificationOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema', 'cases', 'unresolved_failures', 'next_decisive_tests', 'blockers'],
  properties: {
    schema: { const: 'sks.falsification-ledger.v1' },
    cases: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'target_claim', 'attack', 'source_ids', 'result', 'reasoning', 'limitations', 'next_decisive_test'],
        properties: {
          id: { type: 'string' },
          target_claim: { type: 'string' },
          attack: { type: 'string' },
          source_ids: { type: 'array', items: { type: 'string' } },
          result: { enum: ['survives', 'weakened', 'refuted', 'inconclusive'] },
          reasoning: { type: 'string' },
          limitations: { type: 'array', items: { type: 'string' } },
          next_decisive_test: { type: 'string' }
        }
      }
    },
    unresolved_failures: { type: 'array', items: { type: 'string' } },
    next_decisive_tests: { type: 'array', items: { type: 'string' } },
    blockers: { type: 'array', items: { type: 'string' } }
  }
} as const
