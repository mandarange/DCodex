import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GPT_FINAL_ACCEPTED_STATUSES,
  evaluateGptFinalGate,
  normalizeGptFinalStatus
} from '../../dist/core/codex-control/gpt-final-gate.js';
import { gptFinalRequiredForPipeline } from '../../dist/core/pipeline/gpt-final-required.js';

test('a required GPT final that never ran cannot be accepted', () => {
  const gate = evaluateGptFinalGate({ required: true, gptFinalAvailable: false });
  assert.equal(gate.ok, false);
  assert.equal(gate.apply_allowed, false);
  assert.ok(gate.blockers.includes('gpt_final_arbiter_unavailable'));
  assert.ok(gate.blockers.includes('gpt_final_arbiter_missing'));
});

test('only approved or modified pass; a rejection names the status', () => {
  assert.deepEqual([...GPT_FINAL_ACCEPTED_STATUSES], ['approved', 'modified']);
  assert.equal(evaluateGptFinalGate({ gptFinalStatus: 'approved' }).ok, true);
  assert.equal(evaluateGptFinalGate({ gptFinalStatus: 'modified' }).ok, true);
  const rejected = evaluateGptFinalGate({ gptFinalStatus: 'rejected' });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.blockers.includes('gpt_final_status_not_accepted:rejected'));
  assert.equal(normalizeGptFinalStatus('nonsense'), null);
});

test('a run with nothing to arbitrate is accepted without one', () => {
  const gate = evaluateGptFinalGate({ required: false });
  assert.equal(gate.ok, true);
  assert.equal(gate.final_patch_source, 'not_applicable');
});

test('worktree-derived candidates are what now require GPT final', () => {
  // Local LLM drafts used to be the other trigger; with local LLM removed, a
  // candidate that never went through the pipeline's own verified path is the
  // only draft material left to arbitrate.
  const none = gptFinalRequiredForPipeline({ candidateResults: [{ backend: 'codex-sdk' }] });
  assert.equal(none.gpt_final_required, false);
  assert.equal(none.reason, 'no_worktree_candidate_participation');
  const worktree = gptFinalRequiredForPipeline({ candidatePatchEnvelopes: [{ source: 'git-worktree-diff' }] });
  assert.equal(worktree.gpt_final_required, true);
  assert.equal(worktree.reason, 'worktree_candidate_outputs_require_gpt_final');
});
