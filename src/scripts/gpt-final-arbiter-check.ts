#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertGate, emitGate, importDist, readJsonFile, root } from './lib/codex-sdk-gate-lib.js';

const mod = await importDist('core/codex-control/gpt-final-arbiter.js');
const old = snapshotEnv();
process.env.NODE_ENV = 'test';
process.env.SKS_CODEX_SDK_FAKE = '1';
delete process.env.SKS_GPT_FINAL_ARBITER_UNAVAILABLE;

try {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-gpt-final-arbiter-'));
  const approved = await mod.runGptFinalArbiter(fixtureInput('approved'), { cwd: root, mutationLedgerRoot: tmp });
  assertGate(approved.ok === true, 'GPT final arbiter fixture must approve safe candidate', approved);
  assertGate(approved.backend === 'codex-sdk', 'GPT final arbiter backend must be codex-sdk');
  assertGate(approved.result.status === 'approved', 'safe candidate must return approved');
  assertGate(approved.result.lean_review?.status === 'pass', 'safe candidate must pass lean review');
  assertGate(approved.result.lean_review?.selected_rung === 'minimal-custom', 'lean review must record selected rung');
  assertGate(approved.final_gate.ok === true, 'approved arbiter result must pass final gate');
  const artifact = await readJsonFile(path.join(tmp, 'gpt-final-arbiter.json'));
  assertGate(artifact.result.schema === 'sks.gpt-final-arbiter-result.v1', 'arbiter artifact must contain schema-valid result');
  assertGate(artifact.result.lean_review?.verification_minimum_present === true, 'arbiter artifact must record lean verification minimum');

  const unsafeTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-gpt-final-arbiter-unsafe-'));
  const rejected = await mod.runGptFinalArbiter({ ...fixtureInput('unsafe'), candidate_diff: 'unsafe delete all credential patch' }, { cwd: root, mutationLedgerRoot: unsafeTmp });
  assertGate(rejected.ok === false, 'unsafe candidate must not pass final arbiter');
  assertGate(rejected.result.status === 'rejected', 'unsafe candidate must be rejected');
  assertGate(rejected.result.lean_review?.status === 'rejected', 'unsafe candidate must reject lean review');
  assertGate(rejected.blockers.includes('unsafe_candidate_patch'), 'unsafe rejection blocker must be preserved');

  emitGate('gpt-final:arbiter', { approved: approved.result.status, rejected: rejected.result.status });
} finally {
  restoreEnv(old);
}

function fixtureInput(label: string) {
  return {
    schema: 'sks.gpt-final-arbiter-input.v1',
    route: '$Naruto',
    mission_id: `M-${label}`,
    candidate_outputs: [
      { worker_id: 'slot-001/gen-1', backend: 'codex-sdk', summary: 'candidate patch drafted', patch_envelopes: [], proof: 'worktree draft' }
    ],
    candidate_diff: 'diff --git a/example.ts b/example.ts',
    candidate_patch_envelopes: [],
    verification_results: [{ ok: true, status: 'passed' }],
    side_effect_report: { ok: true },
    mutation_ledger: { ok: true },
    rollback_plan: { ok: true }
  };
}

function snapshotEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: process.env.NODE_ENV,
    SKS_CODEX_SDK_FAKE: process.env.SKS_CODEX_SDK_FAKE,
    SKS_GPT_FINAL_ARBITER_UNAVAILABLE: process.env.SKS_GPT_FINAL_ARBITER_UNAVAILABLE
  };
}

function restoreEnv(old: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(old)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
