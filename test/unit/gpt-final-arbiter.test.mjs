import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('GPT final arbiter approves safe fake Codex SDK result', async () => {
  const mod = await import('../../dist/core/codex-control/gpt-final-arbiter.js');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-gpt-final-test-'));
  const old = snapshotEnv();
  enableHermeticFakeCodex();
  try {
    const result = await mod.runGptFinalArbiter(input('safe'), { cwd: process.cwd(), mutationLedgerRoot: tmp });
    assert.equal(result.ok, true);
    assert.equal(result.backend, 'codex-sdk');
    assert.equal(result.result.status, 'approved');
    assert.equal(result.result.lean_review.status, 'pass');
    assert.equal(result.result.lean_review.selected_rung, 'minimal-custom');
    assert.equal(result.final_gate.ok, true);
    const artifact = JSON.parse(await fs.readFile(path.join(tmp, 'gpt-final-arbiter.json'), 'utf8'));
    assert.equal(artifact.result.schema, 'sks.gpt-final-arbiter-result.v1');
    assert.equal(artifact.result.lean_review.verification_minimum_present, true);
  } finally {
    restoreEnv(old);
  }
});

test('GPT final arbiter blocks unavailable GPT final backend', async () => {
  const mod = await import('../../dist/core/codex-control/gpt-final-arbiter.js');
  const result = await mod.runGptFinalArbiter(input('unavailable'), { writeArtifact: false, forceUnavailable: true });
  assert.equal(result.ok, false);
  assert.equal(result.result.status, 'needs_more_work');
  assert.equal(result.result.lean_review.status, 'needs_more_work');
  assert.ok(result.blockers.includes('gpt_final_arbiter_unavailable'));
});

test('GPT final arbiter flags lean over-build fixtures', async () => {
  const mod = await import('../../dist/core/codex-control/gpt-final-arbiter.js');
  const cases = [
    ['existing helper reimplementation', 'needs_more_work', 'reuse_existing_helper'],
    ['new dependency for simple CSV export despite stdlib support', 'needs_more_work', 'unnecessary_dependency'],
    ['one implementation factory for a single provider', 'needs_more_work', 'single_impl_abstraction'],
    ['hidden mock fallback for production success', 'needs_more_work', 'hidden_fallback'],
    ['caller duplicate guard symptom patch', 'needs_more_work', 'root_cause_missing'],
    ['delete validation one-liner', 'rejected', 'unsafe_candidate_patch']
  ];
  const old = snapshotEnv();
  enableHermeticFakeCodex();
  try {
    for (const [diff, status, blocker] of cases) {
      const result = await mod.runGptFinalArbiter(input(diff), { writeArtifact: false });
      assert.equal(result.result.status, status, diff);
      assert.equal(result.ok, false, diff);
      assert.ok(result.result.blockers.includes(blocker), `${diff}: ${result.result.blockers.join(', ')}`);
      assert.notEqual(result.result.lean_review.status, 'pass', diff);
    }
  } finally {
    restoreEnv(old);
  }
});

function input(label) {
  return {
    schema: 'sks.gpt-final-arbiter-input.v1',
    route: '$Naruto',
    mission_id: `M-${label}`,
    local_mode: 'local-parallel-gpt-final',
    candidate_outputs: [{ worker_id: 'slot-001/gen-1', backend: 'codex-sdk', summary: 'draft' }],
    candidate_diff: 'diff --git a/x b/x',
    candidate_patch_envelopes: [],
    verification_results: [{ ok: true, status: 'passed' }],
    side_effect_report: { ok: true },
    mutation_ledger: { ok: true },
    rollback_plan: { ok: true }
  };
}

function snapshotEnv() {
  return {
    NODE_ENV: process.env.NODE_ENV,
    SKS_CODEX_SDK_FAKE: process.env.SKS_CODEX_SDK_FAKE,
    SKS_GPT_FINAL_ARBITER_UNAVAILABLE: process.env.SKS_GPT_FINAL_ARBITER_UNAVAILABLE,
    SKS_CODEX_LB_AUTOBYPASS: process.env.SKS_CODEX_LB_AUTOBYPASS
  };
}

function enableHermeticFakeCodex() {
  process.env.NODE_ENV = 'test';
  process.env.SKS_CODEX_SDK_FAKE = '1';
  process.env.SKS_CODEX_LB_AUTOBYPASS = '1';
  delete process.env.SKS_GPT_FINAL_ARBITER_UNAVAILABLE;
}

function restoreEnv(old) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
