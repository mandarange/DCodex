#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './lib/codex-sdk-gate-lib.js';

// Local LLM support was removed, so a local draft can no longer be the thing
// GPT Final has to approve. Worktree-derived candidate output still is: it never
// went through the pipeline's own verified path, so finalization must refuse it
// while the arbiter is unavailable.
const finalizer = await importDist('core/pipeline/finalize-pipeline-result.js');
const blocked = await finalizer.finalizePipelineResult({
  route: '$Naruto',
  missionId: 'M-worktree-final-gpt',
  candidateResults: [{ backend: 'codex-sdk', summary: 'draft', git_worktree_diff: { changed_files: ['src/example.ts'] } }],
  candidatePatchEnvelopes: [{ source: 'git-worktree-diff' }],
  verificationResults: [],
  sideEffectReport: {},
  mutationLedger: {},
  rollbackPlan: {},
  applyPatches: true,
  forceGptFinalUnavailable: true
});
assertGate(blocked.ok === false, 'worktree candidate without GPT final must block finalization');
assertGate(blocked.blockers.includes('gpt_final_arbiter_required_not_passed'), 'missing GPT final blocker required');
emitGate('gpt-final:all-pipelines-required', { final_status: blocked.final_status, blockers: blocked.blockers.length });
