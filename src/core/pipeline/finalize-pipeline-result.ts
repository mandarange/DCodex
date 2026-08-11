import path from 'node:path'
import { nowIso, writeJsonAtomic } from '../fsx.js'
import { runGptFinalArbiter } from '../codex-control/gpt-final-arbiter.js'
import { gptFinalRequiredForPipeline } from './gpt-final-required.js'

export async function finalizePipelineResult(input: {
  route: string
  missionId: string
  candidateResults: unknown[]
  candidatePatchEnvelopes: unknown[]
  verificationResults: unknown[]
  sideEffectReport: unknown
  mutationLedger: unknown
  rollbackPlan: unknown
  applyPatches: boolean
  cwd?: string
  mutationLedgerRoot?: string
  forceGptFinalUnavailable?: boolean
}) {
  const cwd = path.resolve(input.cwd || process.cwd())
  const root = path.resolve(input.mutationLedgerRoot || path.join(cwd, '.sneakoscope', 'tmp', 'pipeline-finalize', safeName(input.missionId)))
  const requirement = gptFinalRequiredForPipeline({
    candidateResults: input.candidateResults,
    candidatePatchEnvelopes: input.candidatePatchEnvelopes
  })
  let arbiter: any = null
  let blockers: string[] = []
  if (requirement.gpt_final_required) {
    arbiter = await runGptFinalArbiter({
      schema: 'sks.gpt-final-arbiter-input.v1',
      route: input.route,
      mission_id: input.missionId,
      candidate_outputs: input.candidateResults as any[],
      candidate_patch_envelopes: input.candidatePatchEnvelopes as any[]
    }, {
      cwd,
      mutationLedgerRoot: path.join(root, 'gpt-final-arbiter'),
      ...(typeof input.forceGptFinalUnavailable === 'boolean' ? { forceUnavailable: input.forceGptFinalUnavailable } : {})
    })
    blockers = [
      ...(arbiter.ok ? [] : ['gpt_final_arbiter_required_not_passed']),
      ...(Array.isArray(arbiter.blockers) ? arbiter.blockers.map(String) : [])
    ]
  }
  const result = {
    schema: 'sks.pipeline-finalize-result.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    route: input.route,
    mission_id: input.missionId,
    worktree_participated: requirement.worktree_participated,
    gpt_final_required: requirement.gpt_final_required,
    gpt_final_arbiter: arbiter,
    final_status: blockers.length ? 'blocked' : 'accepted',
    apply_allowed: blockers.length === 0 && input.applyPatches === true,
    final_patch_source: requirement.gpt_final_required ? 'gpt_final_arbiter' : 'deterministic_finalize',
    candidate_results_count: input.candidateResults.length,
    candidate_patch_envelope_count: input.candidatePatchEnvelopes.length,
    verification_results_count: input.verificationResults.length,
    side_effect_report: input.sideEffectReport,
    mutation_ledger: input.mutationLedger,
    rollback_plan: input.rollbackPlan,
    blockers
  }
  await writeJsonAtomic(path.join(root, 'pipeline-finalize-result.json'), result)
  return result
}

function safeName(value: unknown) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 80)
}
