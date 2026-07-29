import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { maybeFinalizeRoute } from '../auto-finalize.js';
import { validateRouteCompletionProof } from '../route-proof-gate.js';

async function makeMission(missionId: string, gate: Record<string, unknown>) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-auto-finalize-'));
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'mission.json'), JSON.stringify({ id: missionId, prompt: 'fixture' }, null, 2));
  await fsp.writeFile(path.join(dir, 'route-gate.json'), JSON.stringify(gate, null, 2));
  return { root, dir };
}

async function readProof(dir: string) {
  return JSON.parse(await fsp.readFile(path.join(dir, 'completion-proof.json'), 'utf8'));
}

test('gate failure rejects upgraded statusHint verified', async () => {
  const missionId = 'M-auto-failed-gate';
  const { root, dir } = await makeMission(missionId, { passed: false, ok: true, blockers: [], execution_class: 'real' });
  const result = await maybeFinalizeRoute(root, {
    missionId,
    route: '$DFix',
    gateFile: 'route-gate.json',
    statusHint: 'verified',
    lightweightEvidence: true,
    agents: false
  });
  const proof = await readProof(dir);
  assert.equal(result.status_hint, 'blocked');
  assert.equal(proof.status, 'blocked');
  assert.equal(proof.status_hint_rejected.requested, 'verified');
  assert.equal(proof.status_hint_rejected.computed, 'blocked');
});

test('passed gate allows statusHint downgrade to verified_partial', async () => {
  const missionId = 'M-auto-downgrade';
  const { root, dir } = await makeMission(missionId, { passed: true, ok: true, blockers: [], execution_class: 'real' });
  await maybeFinalizeRoute(root, {
    missionId,
    route: '$DFix',
    gateFile: 'route-gate.json',
    statusHint: 'verified_partial',
    lightweightEvidence: true,
    agents: false
  });
  const proof = await readProof(dir);
  assert.equal(proof.status, 'verified_partial');
  assert.equal(proof.execution_class, 'real');
});

test('explicit blockers force blocked despite upgraded statusHint', async () => {
  const missionId = 'M-auto-blocker';
  const { root, dir } = await makeMission(missionId, { passed: true, ok: true, blockers: [], execution_class: 'real' });
  await maybeFinalizeRoute(root, {
    missionId,
    route: '$DFix',
    gateFile: 'route-gate.json',
    blockers: ['fixture_blocker'],
    statusHint: 'verified',
    lightweightEvidence: true,
    agents: false
  });
  const proof = await readProof(dir);
  assert.equal(proof.status, 'blocked');
  assert.ok(proof.blockers.includes('fixture_blocker'));
});

test('mock official-subagent blockers remain visible and mock proof is not passing', async () => {
  const missionId = 'M-auto-mock-subagents';
  const { root, dir } = await makeMission(missionId, {
    passed: true,
    ok: true,
    blockers: [],
    execution_class: 'mock_fixture',
    workflow: 'official_codex_subagent',
    official_subagent_evidence: false,
    parent_summary_present: false
  });
  await maybeFinalizeRoute(root, {
    missionId,
    route: '$Naruto',
    gateFile: 'route-gate.json',
    blockers: ['official_subagent_evidence_missing', 'official_subagent_parent_summary_missing'],
    mock: true,
    statusHint: 'verified',
    lightweightEvidence: true,
    agents: false
  });
  const proof = await readProof(dir);
  assert.equal(proof.status, 'mock_only');
  assert.equal(proof.execution_class, 'mock_fixture');
  assert.equal(proof.route, '$sks-naruto');
  assert.ok(proof.blockers.includes('official_subagent_evidence_missing'));
  assert.ok(proof.blockers.includes('official_subagent_parent_summary_missing'));
  assert.equal(proof.evidence.route_gate.workflow, 'official_codex_subagent');
  assert.equal(proof.evidence.route_gate.official_subagent_evidence, false);
  assert.equal(proof.evidence.route_gate.parent_summary_present, false);
});

test('generic route proof binds current official-subagent evidence to its own route gate', async () => {
  const missionId = 'M-auto-generic-subagents';
  const runId = 'official-generic-run';
  const { root, dir } = await makeMission(missionId, {
    schema: 'sks.dfix-gate.v1',
    passed: true,
    ok: true,
    blockers: [],
    execution_class: 'real'
  });
  const threadIds = ['agent-1', 'agent-2'];
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    workflow_run_id: runId,
    requested_subagents: 2,
    wave_lifecycle: {
      count_policy: 'dynamic_automatic',
      target_subagents: 2
    }
  }, null, 2));
  await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify({
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'all slices completed',
    run_id: runId,
    thread_outcomes: threadIds.map((thread_id) => ({ thread_id, status: 'completed', summary: 'done' })),
    blockers: []
  }, null, 2));
  await fsp.writeFile(path.join(dir, 'subagent-evidence.json'), JSON.stringify({
    schema: 'sks.subagent-evidence.v1',
    workflow: 'official_codex_subagent',
    run_id: runId,
    requested_subagents: 2,
    count_policy: 'dynamic_automatic',
    target_subagents: 2,
    started_threads: 2,
    completed_threads: 2,
    failed_threads: 0,
    open_thread_ids: [],
    event_sources: ['SubagentStart', 'SubagentStop'],
    parent_summary_present: true,
    parent_summary_trustworthy: true,
    parent_summary_status: 'completed',
    preparation_only: false,
    status: 'completed',
    ok: true,
    blockers: []
  }, null, 2));

  await maybeFinalizeRoute(root, {
    missionId,
    route: '$DFix',
    gateFile: 'route-gate.json',
    statusHint: 'verified_partial',
    lightweightEvidence: true,
    agents: false
  });

  const proof = await readProof(dir);
  const currentGate = JSON.parse(await fsp.readFile(path.join(dir, 'route-gate.json'), 'utf8'));
  assert.equal(proof.evidence.route_gate.workflow, 'official_codex_subagent');
  assert.equal(proof.evidence.route_gate.workflow_run_id, runId);
  assert.equal(proof.evidence.route_gate.official_subagent_evidence, true);
  assert.equal(proof.evidence.route_gate.parent_summary_present, true);
  assert.equal(proof.evidence.route_gate.count_policy, 'dynamic_automatic');
  assert.equal(proof.evidence.route_gate.target_subagents, 2);
  assert.deepEqual(proof.evidence.route_gate, currentGate);
  for (const artifactPath of [
    'subagent-plan.json',
    'subagent-events.jsonl',
    'subagent-parent-summary.json',
    'subagent-evidence.json'
  ]) {
    const artifact = proof.evidence.artifacts.find((row: any) => row?.path === artifactPath);
    assert.equal(artifact?.kind, 'agent', artifactPath);
    assert.equal(artifact?.source, 'real', artifactPath);
    assert.equal(artifact?.ignoreStale, true, artifactPath);
  }

  const validation = await validateRouteCompletionProof(root, {
    missionId,
    route: '$DFix',
    state: {
      proof_required: true,
      subagents_required: true,
      official_subagent_run_id: runId,
      stop_gate: 'route-gate.json'
    }
  });
  assert.equal(validation.issues.includes('official_subagent_current_gate_missing'), false);
  assert.equal(validation.issues.includes('official_subagent_current_gate_mismatch'), false);
  assert.equal(validation.issues.includes('official_subagent_workflow_missing'), false);
  assert.equal(validation.issues.includes('official_subagent_evidence_missing'), false);
  assert.equal(validation.issues.includes('official_subagent_parent_summary_missing'), false);
});

test('generic route proof fails closed while current official-subagent evidence is incomplete', async () => {
  const missionId = 'M-auto-generic-subagents-incomplete';
  const { root, dir } = await makeMission(missionId, {
    schema: 'sks.dfix-gate.v1',
    passed: true,
    ok: true,
    blockers: [],
    execution_class: 'real'
  });
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    workflow_run_id: 'official-incomplete-run',
    requested_subagents: 2,
    wave_lifecycle: {
      count_policy: 'exact',
      requested_target_subagents: 2,
      target_subagents: 2
    }
  }, null, 2));

  await maybeFinalizeRoute(root, {
    missionId,
    route: '$DFix',
    gateFile: 'route-gate.json',
    statusHint: 'verified',
    lightweightEvidence: true,
    agents: false
  });

  const proof = await readProof(dir);
  const currentGate = JSON.parse(await fsp.readFile(path.join(dir, 'route-gate.json'), 'utf8'));
  assert.equal(proof.status, 'blocked');
  assert.equal(currentGate.workflow, 'official_codex_subagent');
  assert.equal(currentGate.official_subagent_evidence, false);
  assert.equal(currentGate.parent_summary_present, false);
  assert.ok(proof.blockers.includes('official_subagent_evidence_missing'));
  assert.ok(proof.blockers.includes('official_subagent_parent_summary_missing'));
});
