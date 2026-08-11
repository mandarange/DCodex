export function gptFinalRequiredForPipeline(input: {
  candidateResults?: unknown[]
  candidatePatchEnvelopes?: unknown[]
}) {
  // Local LLM support was removed; worktree-derived candidate output is now the
  // only draft material GPT Final has to approve before it can be applied.
  const worktreeParticipated = worktreeCandidateParticipated(input.candidateResults)
    || worktreeCandidateParticipated(input.candidatePatchEnvelopes)
  return {
    schema: 'sks.gpt-final-required.v1',
    worktree_participated: worktreeParticipated,
    gpt_final_required: worktreeParticipated,
    reason: worktreeParticipated
      ? 'worktree_candidate_outputs_require_gpt_final'
      : 'no_worktree_candidate_participation'
  }
}

function worktreeCandidateParticipated(values: unknown[] | undefined): boolean {
  return (Array.isArray(values) ? values : []).some((value: any) => {
    if (!value || typeof value !== 'object') return false
    if (value.source === 'git-worktree-diff') return true
    if (value.git_worktree?.worktree_path || value.git_worktree?.checkpoint?.commit_hash) return true
    if (value.git_worktree_diff || value.git_worktree_checkpoint) return true
    return Array.isArray(value.patch_envelopes) && worktreeCandidateParticipated(value.patch_envelopes)
  })
}
