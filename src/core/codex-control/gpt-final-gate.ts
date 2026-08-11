import { nowIso } from '../fsx.js'

export const GPT_FINAL_GATE_SCHEMA = 'sks.gpt-final-gate.v1'

export type GptFinalStatus = 'approved' | 'modified' | 'rejected' | 'needs_more_work'

export const GPT_FINAL_ACCEPTED_STATUSES: ReadonlyArray<'approved' | 'modified'> = ['approved', 'modified']

/**
 * Candidate output that did not come from the pipeline's own verified path —
 * today, a git-worktree-derived diff — is draft material until GPT Final
 * approves or modifies it.
 *
 * This gate replaces the local-collaboration final gate, which carried the same
 * acceptance rule plus four local-LLM collaboration modes and a "the arbiter
 * must not itself be a local backend" check. Local LLM support was removed, so
 * the modes describe nothing and no backend can be local; what survives is the
 * rule that mattered: a required GPT Final must be present, available, and
 * accepted.
 */
export function evaluateGptFinalGate(input: {
  required?: boolean
  gptFinalStatus?: string | null
  gptFinalAvailable?: boolean
} = {}) {
  const required = input.required !== false
  const status = normalizeGptFinalStatus(input.gptFinalStatus)
  const blockers = [
    ...(required && input.gptFinalAvailable === false ? ['gpt_final_arbiter_unavailable'] : []),
    ...(required && !status ? ['gpt_final_arbiter_missing'] : []),
    ...(required && status && !GPT_FINAL_ACCEPTED_STATUSES.includes(status as 'approved' | 'modified')
      ? [`gpt_final_status_not_accepted:${status}`]
      : [])
  ]
  const accepted = blockers.length === 0
  return {
    schema: GPT_FINAL_GATE_SCHEMA,
    generated_at: nowIso(),
    ok: accepted,
    gpt_final_required: required,
    gpt_final_status: status,
    final_status: accepted ? 'accepted' : 'blocked',
    apply_allowed: accepted,
    release_proof_allowed: accepted,
    final_patch_source: accepted && required ? 'gpt_final_arbiter' : 'not_applicable',
    blockers
  }
}

export function normalizeGptFinalStatus(value: unknown): GptFinalStatus | null {
  const text = String(value ?? '').trim()
  return text === 'approved' || text === 'modified' || text === 'rejected' || text === 'needs_more_work' ? text : null
}
