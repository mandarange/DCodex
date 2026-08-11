import { nowIso, sha256 } from '../fsx.js'

export const GPT_FINAL_PROOF_PACK_SCHEMA = 'sks.gpt-final-proof-pack.v1'

export interface GptFinalArbiterInput {
  schema?: string
  route: string
  mission_id: string
  candidate_outputs?: any[]
  candidate_diff?: string
  candidate_patch_envelopes?: any[]
  verification_results?: any[]
  side_effect_report?: any
  mutation_ledger?: any
  rollback_plan?: any
}

export function buildGptFinalProofPack(input: GptFinalArbiterInput, opts: { maxCriticalLogChars?: number } = {}) {
  const maxCriticalLogChars = Math.max(1000, Number(opts.maxCriticalLogChars || 6000))
  const candidateOutputs = Array.isArray(input.candidate_outputs) ? input.candidate_outputs : []
  const candidatePatchEnvelopes = Array.isArray(input.candidate_patch_envelopes) ? input.candidate_patch_envelopes : []
  const verificationResults = Array.isArray(input.verification_results) ? input.verification_results : []
  const pack = {
    schema: GPT_FINAL_PROOF_PACK_SCHEMA,
    generated_at: nowIso(),
    route: String(input.route || ''),
    mission_id: String(input.mission_id || ''),
    worker_count: candidateOutputs.length,
    changed_files: sortedUnique([
      ...candidatePatchEnvelopes.flatMap((envelope) => envelopeChangedFiles(envelope)),
      ...candidateOutputs.flatMap((output) => Array.isArray(output?.changed_files) ? output.changed_files.map(String) : [])
    ]),
    candidate_output_summaries: candidateOutputs.map((output, index) => ({
      worker_id: String(output?.worker_id || output?.agent_id || output?.id || `worker-${index + 1}`),
      backend: String(output?.backend || 'unknown'),
      status: String(output?.status || 'unknown'),
      summary: trim(String(output?.summary || ''), 600),
      proof: trim(String(output?.proof || output?.verification?.status || ''), 600),
      blocker_count: Array.isArray(output?.blockers) ? output.blockers.length : 0,
      patch_envelope_count: Array.isArray(output?.patch_envelopes) ? output.patch_envelopes.length : output?.patch_envelope ? 1 : 0
    })),
    candidate_diff_sha256: sha256(String(input.candidate_diff || '')),
    candidate_diff_tail: tail(String(input.candidate_diff || ''), maxCriticalLogChars),
    candidate_patch_envelopes: candidatePatchEnvelopes.map((envelope, index) => summarizeEnvelope(envelope, index)),
    verification_failures: verificationResults.filter((result) => result?.ok === false || result?.status === 'failed').map((result) => ({
      id: String(result?.id || result?.patch_entry_id || result?.name || 'verification'),
      status: String(result?.status || (result?.ok === false ? 'failed' : 'unknown')),
      blockers: stringArray(result?.blockers || result?.violations)
    })),
    side_effect_ledger_summary: summarizeObject(input.side_effect_report),
    mutation_ledger_summary: summarizeObject(input.mutation_ledger),
    rollback_plan_summary: summarizeObject(input.rollback_plan),
    conflict_map: buildConflictMap(candidatePatchEnvelopes),
    critical_logs_tail: tail(JSON.stringify({
      candidate_outputs: candidateOutputs.map((output) => ({
        id: output?.worker_id || output?.agent_id || output?.id,
        blockers: output?.blockers || [],
        unverified: output?.unverified || []
      })),
      verification_results: verificationResults
    }), maxCriticalLogChars),
    token_budget_estimate: 0
  }
  return {
    ...pack,
    token_budget_estimate: estimateTokens(pack)
  }
}

export function buildGptFinalLatencyBudgetReport(input: { workerCount: number; tokenBudgetEstimate: number; latencyMs?: number | null }) {
  const workerCount = Math.max(0, Number(input.workerCount || 0))
  const tokenBudgetEstimate = Math.max(0, Number(input.tokenBudgetEstimate || 0))
  const capAdjustment = tokenBudgetEstimate > 8000 || workerCount > 20 ? 'reduce_worker_parallelism_or_pack_size' : 'within_budget'
  return {
    schema: 'sks.gpt-final-latency-budget.v1',
    generated_at: nowIso(),
    worker_count: workerCount,
    token_budget_estimate: tokenBudgetEstimate,
    latency_ms: input.latencyMs ?? null,
    cap_adjustment: capAdjustment,
    ok: capAdjustment === 'within_budget'
  }
}

function summarizeEnvelope(envelope: any, index: number) {
  return {
    id: String(envelope?.id || envelope?.patch_id || `patch-${index + 1}`),
    agent_id: String(envelope?.agent_id || 'unknown'),
    source: String(envelope?.source || 'unknown'),
    operations: Array.isArray(envelope?.operations) ? envelope.operations.length : 0,
    write_paths: envelopeChangedFiles(envelope),
    lease_id: envelope?.lease_id || envelope?.lease_proof?.lease_id || null,
    rollback_ready: Boolean(envelope?.rollback_hint || envelope?.lease_proof?.rollback_node_id)
  }
}

function envelopeChangedFiles(envelope: any) {
  return Array.isArray(envelope?.operations) ? envelope.operations.map((operation: any) => String(operation?.path || '')).filter(Boolean) : []
}

function buildConflictMap(envelopes: any[]) {
  const owners = new Map<string, string[]>()
  for (const envelope of envelopes) {
    const agent = String(envelope?.agent_id || 'unknown')
    for (const file of envelopeChangedFiles(envelope)) owners.set(file, [...(owners.get(file) || []), agent])
  }
  return [...owners.entries()]
    .filter(([, agents]) => new Set(agents).size > 1)
    .map(([file, agents]) => ({ file, agents: sortedUnique(agents) }))
}

function summarizeObject(value: any) {
  if (!value || typeof value !== 'object') return null
  return {
    schema: value.schema || null,
    ok: typeof value.ok === 'boolean' ? value.ok : null,
    status: value.status || null,
    blockers: stringArray(value.blockers).slice(0, 20),
    keys: Object.keys(value).slice(0, 30)
  }
}

function estimateTokens(value: unknown) {
  return Math.ceil(JSON.stringify(value).length / 4)
}

function tail(value: string, max: number) {
  return value.length <= max ? value : value.slice(value.length - max)
}

function trim(value: string, max: number) {
  return value.length <= max ? value : value.slice(0, max)
}

function sortedUnique(values: string[]) {
  return [...new Set(values.map(String).filter(Boolean))].sort()
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry || '').trim()).filter(Boolean) : []
}
