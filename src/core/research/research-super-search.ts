import path from 'node:path'
import { readJson, sha256 } from '../fsx.js'
import { runCodexTask } from '../codex-control/codex-task-runner.js'
import { runSuperSearch, type SuperSearchSourceFunction, type SuperSearchSourceRecord } from '../super-search/index.js'
import { TERRA_SUBAGENT_EFFORT, TERRA_SUBAGENT_MODEL } from '../subagents/model-policy.js'
import {
  type ResearchSourceLayer,
  type ResearchSourceShardOutput
} from './research-source-shards.js'

export const RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY = Object.freeze({
  model: TERRA_SUBAGENT_MODEL,
  model_reasoning_effort: TERRA_SUBAGENT_EFFORT
})

export interface ResearchSuperSearchShardInput {
  root: string
  dir: string
  plan: any
  layer: ResearchSourceLayer
  cycle: number
  timeoutMs: number
  deadlineMs?: number
  sourceSearch?: SuperSearchSourceFunction
}

export async function runResearchSuperSearchShard(input: ResearchSuperSearchShardInput): Promise<ResearchSourceShardOutput> {
 const missionId = String(input.plan?.mission_id || '')
  const acquisitionDir = path.join(input.dir, 'research', `cycle-${input.cycle}`, 'source-acquisition', input.layer.id)
  const sourceSearch = input.sourceSearch || createCodexSourceSearch(input)
  const result = await runSuperSearch({
    root: input.root,
    missionDir: acquisitionDir,
    missionId,
    route: '$Research',
    query: buildResearchLayerQuery(input.plan, input.layer),
    mode: 'deep',
    codexWebSearch: sourceSearch,
    maxQueryVariants: 2,
    maxHydratedSources: 4,
    hardTimeoutMs: input.timeoutMs,
    ...(input.deadlineMs === undefined ? {} : { deadlineEpochMs: input.deadlineMs }),
    env: { ...process.env, SKS_CODEX_WEB_SEARCH_AVAILABLE: '1' }
  })
  const sources = result.sources.map((source) => researchSourceRow(source, input.layer))
  const verifiedEvidenceCandidates = sources.filter((source) => source.acquisition_verdict === 'verified_content').length
  const blockers = [
    ...result.proof.blockers.map((blocker) => `super_search:${blocker}`),
    ...(sources.length ? [] : ['super_search:source_rows_missing']),
    ...(input.layer.id === 'counterevidence_factcheck' && verifiedEvidenceCandidates === 0
      ? ['super_search:verified_counterevidence_candidate_missing']
     : [])
  ]
  return {
    schema: 'sks.research-source-shard-output.v1',
    mission_id: missionId,
    cycle: input.cycle,
    layer_id: input.layer.id,
    queries: result.query_variants.map((query) => ({
      query,
      rationale: `Super Search ${result.mode} acquisition for ${input.layer.label}.`
    })),
    sources,
    blockers: [...new Set(blockers)],
    super_search: {
      schema: 'sks.research-super-search-link.v1',
      result_artifact: path.relative(input.dir, path.join(result.artifact_dir, 'super-search-result.json')),
      proof_artifact: path.relative(input.dir, path.join(result.artifact_dir, 'super-search-proof.json')),
      source_ledger_artifact: path.relative(input.dir, path.join(result.artifact_dir, 'source-ledger.json')),
      claim_ledger_artifact: path.relative(input.dir, path.join(result.artifact_dir, 'claim-ledger.json')),
      proof_ok: result.proof.ok,
      verified_sources: result.proof.verified_source_count,
      provider_independent: result.proof.provider_independent,
      verified_provider_families: result.proof.verified_provider_families,
      verified_independence_clusters: result.proof.verified_independence_clusters,
      query_execution: result.query_execution
    }
  }
}

export function buildResearchLayerQuery(plan: any, layer: ResearchSourceLayer): string {
  const topic = String(plan?.prompt || 'research mission').trim()
  const templates = layer.query_templates.slice(0, 3).map((query) => query.replace(/<topic>/g, topic))
  return [
    topic,
    `Evidence layer: ${layer.label}.`,
    layer.purpose,
    `Prioritize primary or authoritative sources; preserve contrary evidence; never invent URLs. Suggested searches: ${templates.join(' | ')}`
  ].join(' ')
}

function createCodexSourceSearch(input: ResearchSuperSearchShardInput): SuperSearchSourceFunction {
  return async (query: string) => {
    const queryId = sha256(query).slice(0, 12)
    const result = await runCodexTask({
      route: '$Research',
      tier: 'worker',
      missionId: String(input.plan?.mission_id || 'research-source-acquisition'),
      workItemId: `super_search_${input.layer.id}_${queryId}`,
      cwd: input.root,
      prompt: buildSourceSearchPrompt(input.plan, input.layer, query),
      outputSchema: researchSourceSearchOutputSchema,
      outputSchemaId: 'sks.research-source-search-output.v1',
      sandboxPolicy: 'read-only',
      requestedScopeContract: {
        id: `research-super-search-${input.layer.id}`,
        route: '$Research',
        read_only: true,
        allowed_paths: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
        write_paths: [],
        allowed_write_prefixes: [`.sneakoscope/missions/${input.plan?.mission_id || ''}/`],
        source_mutation_allowed: false
      },
      backendPreference: ['codex-sdk', 'python-codex-sdk'],
      mutationLedgerRoot: path.join(input.dir, 'research', `cycle-${input.cycle}`, 'super-search-codex-control', input.layer.id, queryId),
      reliabilityPolicy: {
        timeoutClass: 'standard',
        idleTimeoutMs: input.timeoutMs,
        hardTimeoutMs: input.timeoutMs,
        ...(input.deadlineMs === undefined ? {} : { deadlineEpochMs: input.deadlineMs })
      },
      model: RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY.model,
      reasoningEffort: RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY.model_reasoning_effort,
      modelReasoningEffort: RESEARCH_SOURCE_ACQUISITION_MODEL_POLICY.model_reasoning_effort,
      serviceTier: 'fast'
    })
    const worker = await readJson<any>(result.workerResultPath as string, null)
    if (!result.ok || !worker) return { results: [], blockers: result.blockers || ['research_source_search_failed'] }
    return {
      results: Array.isArray(worker.results) ? worker.results : [],
      blockers: Array.isArray(worker.blockers) ? worker.blockers : []
    }
  }
}

function buildSourceSearchPrompt(plan: any, layer: ResearchSourceLayer, query: string): string {
  return [
    'Use current web/source search tools for one read-only Super Search acquisition query.',
    `Mission: ${plan?.mission_id || 'unknown'}`,
    `Research topic: ${plan?.prompt || ''}`,
    `Layer: ${layer.id} (${layer.label})`,
    `Query: ${query}`,
    '',
    'Return only JSON matching sks.research-source-search-output.v1.',
    'Every result must contain an exact reachable http(s) URL, title, and source-grounded snippet.',
    'Do not invent citations, URLs, dates, authors, or source text. If search is unavailable, return an empty results array and an explicit blocker.'
  ].join('\n')
}

export function researchSourceRow(
  source: SuperSearchSourceRecord,
  layer: ResearchSourceLayer
): ResearchSourceShardOutput['sources'][number] {
  const verified = source.acquisition_verdict === 'verified_content'
  const evidenceText = [source.title, source.snippet].filter(Boolean).join(' ')
  const sourceClaimId = `source-claim-${sha256([
    source.canonical_url || source.original_url || source.source_id,
    source.content_sha256 || '',
    evidenceText.trim().toLowerCase()
  ].join('\0')).slice(0, 16)}`
  return {
    id: source.source_id,
    layer: layer.id,
    kind: source.source_type,
    title: source.title,
    locator: source.canonical_url || source.original_url || source.content_artifact || source.source_id,
    publisher_or_author: source.author || source.domain || source.provider_id,
    ...(source.published_at ? { published_at: source.published_at } : {}),
    accessed_at: source.retrieved_at,
    reliability: source.authority_tier === 'A0' || source.authority_tier === 'A1' ? 'high' : source.authority_tier === 'B' ? 'medium-high' : 'medium',
    credibility: verified ? `verified_content:${source.trust_score.toFixed(2)}` : `${source.acquisition_verdict}:${source.trust_score.toFixed(2)}`,
    stance: 'context',
    claim_ids: [sourceClaimId],
    content_artifact: source.content_artifact,
    content_sha256: source.content_sha256,
    content_length: source.content_length,
    acquisition_verdict: source.acquisition_verdict,
    domain: source.domain,
    authority_tier: source.authority_tier,
    primary_source: source.primary_source,
    independence_cluster_id: source.independence_cluster_id,
    notes: [
      source.snippet.trim().slice(0, 900),
      `Super Search provider=${source.provider_id}; authority=${source.authority_tier}; acquisition=${source.acquisition_verdict}; source_claim_id=${sourceClaimId}.`
    ].filter(Boolean).join(' ')
  }
}

export const researchSourceSearchOutputSchema = {
  type: 'object',
  required: ['schema', 'results', 'blockers'],
  properties: {
    schema: { const: 'sks.research-source-search-output.v1' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'url', 'snippet'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          snippet: { type: 'string' }
        }
      }
    },
    blockers: { type: 'array', items: { type: 'string' } }
  }
}
