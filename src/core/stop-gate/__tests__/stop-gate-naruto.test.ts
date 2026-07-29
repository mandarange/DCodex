import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { checkStopGate } from '../stop-gate-check.js';
import { resolveStopGate } from '../stop-gate-resolver.js';
import { writeFinalStopGate } from '../stop-gate-writer.js';
import { evaluateStop } from '../../pipeline-internals/runtime-gates.js';
import { hasSubagentEvidence } from '../../pipeline-internals/runtime-core.js';
import { writeRouteCompletionProof } from '../../proof/route-adapter.js';
import { buildSubagentEvidence } from '../../subagents/subagent-evidence.js';
import { buildSsotGuard } from '../../safety/ssot-guard.js';

async function makeTempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-sg-root-'));
  return root;
}

async function setupMission(root: string, missionId: string): Promise<string> {
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeCurrent(root: string, patch: Record<string, unknown>): Promise<void> {
  const stateDir = path.join(root, '.sneakoscope', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  const statePath = path.join(stateDir, 'current.json');
  let existing: Record<string, unknown> = {};
  try { existing = JSON.parse(await fsp.readFile(statePath, 'utf8')); } catch { /* empty */ }
  await fsp.writeFile(statePath, JSON.stringify({ ...existing, ...patch, updated_at: new Date().toISOString() }, null, 2));
}

test('resolveStopGate finds naruto-gate.json in mission dir via current.json', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-001';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ passed: true, schema: 'sks.naruto-gate.v1' }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto' });

  const res = await resolveStopGate({ root, route: 'Naruto' });
  assert.ok(res.gate_path, 'should resolve a gate path');
  assert.ok(res.gate_path!.includes(missionId), 'gate path should be in mission dir');
  assert.equal(res.reason, 'mission_dir');
});

test('resolveStopGate finds a route-declared non-Naruto gate without an explicit path', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-align-001';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'route-context.json'), JSON.stringify({
    mission_id: missionId,
    route: 'Align',
    command: '$Align',
    stop_gate: 'align-gate.json'
  }));
  await fsp.writeFile(path.join(dir, 'align-gate.json'), JSON.stringify({
    schema: 'sks.align-gate.v2',
    mission_id: missionId,
    status: 'pass',
    passed: true,
    blockers: []
  }));

  const resolved = await resolveStopGate({
    root,
    route: 'Align',
    missionId,
    allowLatestFallback: false
  });
  assert.equal(resolved.reason, 'mission_declared_gate');
  assert.equal(resolved.gate_path, path.join(dir, 'align-gate.json'));

  const checked = await checkStopGate({
    root,
    route: 'Align',
    missionId,
    allowLatestFallback: false
  });
  assert.equal(checked.action, 'allow_stop');
  assert.equal(checked.ok, true);
  assert.equal(checked.gate_path, path.join(dir, 'align-gate.json'));
});

test('checkStopGate returns allow_stop for passed naruto gate', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-002';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ passed: true, schema: 'sks.naruto-gate.v1', terminal: true }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto' });

  const result = await checkStopGate({ root, route: 'Naruto' });
  assert.equal(result.action, 'allow_stop');
  assert.equal(result.ok, true);
  assert.ok(result.gate_path, 'should have gate_path');
});

test('checkStopGate returns continue for blocked gate', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-003';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ passed: false, schema: 'sks.naruto-gate.v1' }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO' });

  const result = await checkStopGate({ root, route: 'Naruto' });
  assert.equal(result.action, 'continue');
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.checked_paths.length > 0, 'should have checked paths');
});

test('checkStopGate returns hard_blocked when hard-blocker.json exists with evidence', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-004';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'hard-blocker.json'), JSON.stringify({ passed: false, status: 'hard_blocked', reason: 'native sessions unavailable', evidence: ['no codex native'] }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO' });

  const result = await checkStopGate({ root, route: 'Naruto' });
  assert.equal(result.action, 'hard_blocked');
  assert.equal(result.ok, false);
});

test('writeFinalStopGate writes canonical stop-gate.json and updates current state', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-005';
  const dir = await setupMission(root, missionId);

  const gate = await writeFinalStopGate({
    root,
    missionId,
    route: 'Naruto',
    routeCommand: '$Naruto',
    status: 'passed',
    terminal: true,
    terminalState: 'completed',
    evidence: {
      build_passed: true,
      tests_passed: true,
      route_evidence_passed: true,
      regression_test_added: false,
      regression_test_failed_before_fix: false
    },
    nativeGateFile: 'naruto-gate.json',
  });

  assert.equal(gate.passed, true);
  assert.equal(gate.schema, 'sks.stop-gate.v1');

  // Canonical files exist
  const stopGate = JSON.parse(await fsp.readFile(path.join(dir, 'stop-gate.json'), 'utf8'));
  assert.equal(stopGate.passed, true);
  assert.equal(stopGate.schema, 'sks.stop-gate.v1');

  const latest = JSON.parse(await fsp.readFile(path.join(dir, 'stop-gate.latest.json'), 'utf8'));
  assert.equal(latest.passed, true);

  const verify = JSON.parse(await fsp.readFile(path.join(dir, 'stop-gate-write-verify.json'), 'utf8'));
  assert.equal(verify.verified, true);

  // Current state has abs path
  const state = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope', 'state', 'current.json'), 'utf8'));
  assert.equal(state.stop_gate_status, 'passed');
  assert.ok(state.stop_gate_abs_path, 'should have stop_gate_abs_path');
  assert.equal(state.stop_gate_passed, true);

  // checkStopGate now returns allow_stop via abs path
  const result = await checkStopGate({ root, route: 'Naruto', explicitGatePath: state.stop_gate_abs_path });
  assert.equal(result.action, 'allow_stop');
});

test('regression: naruto-gate passed but hook blocked — resolver finds mission dir gate', async () => {
  // This reproduces the reported bug: naruto-gate.json is passed but hook looks in cwd
  const root = await makeTempRoot();
  const missionId = 'M-test-006';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ passed: true, schema: 'sks.naruto-gate.v1', terminal: true }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto' });

  // A stray naruto-gate.json in root should NOT be picked up instead of mission dir
  await fsp.writeFile(path.join(root, 'naruto-gate.json'), JSON.stringify({ passed: false }));

  const result = await checkStopGate({ root, route: 'Naruto' });
  assert.equal(result.action, 'allow_stop', 'should allow stop because mission dir gate is passed');
  assert.ok(result.gate_path!.includes(missionId), 'should select mission dir gate, not root gate');
});

test('passed legacy Naruto gate is not accepted as official evidence without a legacy marker', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-legacy-unmarked';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({
    schema: 'sks.naruto-gate.v1',
    passed: true,
    status: 'passed',
    terminal: true,
    blockers: [],
    missing_fields: []
  }));
  const state = { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false };
  const decision: any = await evaluateStop(root, state, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.match(decision?.reason, /Official subagent evidence/i);
  assert.match(decision?.reason, /subagent-plan\.json/);
});

test('non-canonical subagent-evidence.jsonl is never accepted as official evidence', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-legacy-jsonl';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'subagent-evidence.jsonl'), [
    JSON.stringify({ stage: 'spawn_agent', workflow: 'legacy_process_swarm' }),
    JSON.stringify({ stage: 'result', workflow: 'legacy_process_swarm' })
  ].join('\n') + '\n');
  assert.equal(await hasSubagentEvidence(root, { mission_id: missionId, subagents_required: true, native_sessions_required: false }), false);
  assert.equal(await hasSubagentEvidence(root, { mission_id: missionId, legacy_subagent_workflow: true }), false);
});

test('stop hook does not hidden-block after canonical Naruto allow_stop', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-007';
  const dir = await setupMission(root, missionId);
  // Naruto is a coverage_required route: a real naruto run always creates and
  // closes a work-order-ledger, so a fully-resolved ledger here matches reality.
  await fsp.writeFile(path.join(dir, 'work-order-ledger.json'), JSON.stringify({
    schema_version: 1,
    mission_id: missionId,
    route: 'Naruto',
    source_inventory_complete: true,
    all_customer_requests_preserved: true,
    all_customer_requests_mapped: true,
    all_work_items_verified: true,
    items: []
  }));
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    requested_subagents: 2,
    max_threads: 12,
    max_depth: 1,
    delegation_prompt: 'delegate two independent slices and wait for both'
  }));
  await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), [
    JSON.stringify({ event_name: 'SubagentStart', thread_id: 'a1' }),
    JSON.stringify({ event_name: 'SubagentStart', thread_id: 'a2' }),
    JSON.stringify({ event_name: 'SubagentStop', thread_id: 'a1', outcome: 'stopped' }),
    JSON.stringify({ event_name: 'SubagentStop', thread_id: 'a2', outcome: 'stopped' })
  ].join('\n') + '\n');
  const parentSummary = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'Both independent slices completed and were integrated.',
    thread_outcomes: [
      { thread_id: 'a1', status: 'completed', summary: 'a1 completed' },
      { thread_id: 'a2', status: 'completed', summary: 'a2 completed' }
    ],
    changed_files: [],
    verification: [],
    blockers: []
  };
  await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify(parentSummary));
  await fsp.writeFile(path.join(dir, 'subagent-evidence.json'), JSON.stringify(buildSubagentEvidence({
    requestedSubagents: 2,
    parentSummary,
    events: [
      { event_name: 'SubagentStart', thread_id: 'a1' },
      { event_name: 'SubagentStart', thread_id: 'a2' },
      { event_name: 'SubagentStop', thread_id: 'a1' },
      { event_name: 'SubagentStop', thread_id: 'a2' }
    ]
  })));
  await fsp.writeFile(path.join(dir, 'ssot-guard.json'), JSON.stringify(buildSsotGuard({ route: 'Naruto', mode: 'NARUTO', task: 'fixture' })));
  await fsp.writeFile(path.join(dir, 'naruto-summary.json'), JSON.stringify({
    schema: 'sks.naruto-subagent-workflow.v1',
    ok: true,
    status: 'completed',
    route: '$Naruto',
    workflow: 'official_codex_subagent',
    parent: { model: 'gpt-5.6-sol', model_reasoning_effort: 'max', observed_model_match: null },
    requested_subagents: 2,
    max_threads: 12,
    max_depth: 1,
    started_subagents: 2,
    completed_subagents: 2,
    failed_subagents: 0,
    verification: { budget: 'affected', checks: [] },
    parent_summary_present: true,
    parent_summary: 'Both independent slices completed and were integrated.',
    parent_thread_outcomes: parentSummary.thread_outcomes
  }));
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({
    schema: 'sks.naruto-gate.v1',
    workflow: 'official_codex_subagent',
    status: 'passed',
    passed: true,
    terminal: true,
    terminal_state: 'completed',
    mission_id: missionId,
    subagent_plan_ready: true,
    official_subagent_evidence: true,
    parent_summary_present: true,
    ssot_guard: true,
    session_cleanup: true,
    blockers: [],
    missing_fields: []
  }));
  await fsp.writeFile(path.join(dir, 'stop-gate.json'), JSON.stringify({
    schema: 'sks.stop-gate.v1',
    route: 'Naruto',
    route_command: '$Naruto',
    mission_id: missionId,
    gate_file: 'naruto-gate.json',
    gate_abs_path: path.join(dir, 'stop-gate.json'),
    status: 'passed',
    passed: true,
    terminal: true,
    terminal_state: 'completed',
    evidence: { route_evidence_passed: true, proof_required: false, proof_passed: true, reflection_required: true, reflection_passed: true },
    blockers: [],
    missing_fields: [],
    created_at: new Date().toISOString()
  }));
  await writeRouteCompletionProof(root, {
    missionId,
    route: '$Naruto',
    status: 'verified',
    executionClass: 'real',
    lightweightEvidence: true,
    gate: {
      workflow: 'official_codex_subagent',
      official_subagent_evidence: true,
      parent_summary_present: true
    },
    summary: { manual_review_required: false }
  });
  await fsp.writeFile(path.join(dir, 'reflection.md'), '# Reflection\n\nNo issue found.\n');
  await fsp.writeFile(path.join(dir, 'reflection-gate.json'), JSON.stringify({
    passed: true,
    created_at: new Date().toISOString(),
    reflection_artifact: true,
    no_issue_acknowledged: true,
    wiki_refreshed_or_packed: true,
    wiki_validated: true
  }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'stop-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, subagents_required: true, proof_required: false, reflection_required: true });

  const decision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'stop-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, subagents_required: true, proof_required: false, reflection_required: true }, { message: 'done' });
  assert.equal(decision?.continue, true);
  assert.match(decision?.systemMessage, /canonical stop-gate passed/);

  await fsp.rm(path.join(dir, 'subagent-parent-summary.json'));
  assert.equal(await hasSubagentEvidence(root, { mission_id: missionId, subagents_required: true }), false);
  const missingParentDecision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'stop-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, subagents_required: true, proof_required: false, reflection_required: true }, { message: 'done' });
  assert.equal(missingParentDecision?.decision, 'block');
  assert.match(missingParentDecision?.reason || missingParentDecision?.systemMessage || '', /parent_summary|parent summary/i);
});

test('forged persisted official evidence cannot pass without raw event correlation', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-forged-evidence';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    requested_subagents: 1,
    max_threads: 1,
    max_depth: 1,
    delegation_prompt: 'delegate one slice'
  }));
  await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), '');
  await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify({
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'Claimed completion.',
    thread_outcomes: [{ thread_id: 'a1', status: 'completed', summary: 'Claimed completion.' }],
    blockers: []
  }));
  await fsp.writeFile(path.join(dir, 'subagent-evidence.json'), JSON.stringify({
    schema: 'sks.subagent-evidence.v1',
    workflow: 'official_codex_subagent',
    requested_subagents: 1,
    started_threads: 1,
    completed_threads: 1,
    failed_threads: 0,
    parent_summary_present: true,
    parent_summary_trustworthy: true,
    ok: true,
    blockers: []
  }));
  assert.equal(await hasSubagentEvidence(root, { mission_id: missionId, subagents_required: true }), false);
});

test('generic route stop hook accepts recorded hard blocker before completion proof gate', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-007b';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'hard-blocker.json'), JSON.stringify({
    schema: 'sks.hard-blocker.v1',
    passed: false,
    status: 'hard_blocked',
    reason: 'managed_config_requires_human_remedy',
    evidence: ['db-safety-scan.json: critical finding']
  }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'db-review.json', mode: 'DB', route: 'DB', route_command: '$DB' });

  const decision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'db-review.json', mode: 'DB', route: 'DB', route_command: '$DB' }, { message: 'done' });
  assert.equal(decision?.continue, true);
  assert.equal(decision?.action, 'hard_blocked');
  assert.equal(decision?.gate, 'hard-blocker.json');
  assert.match(decision?.systemMessage, /managed_config_requires_human_remedy/);
});

test('a not_applicable active gate is satisfied without bypassing independent gates', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-not-applicable';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'optional-gate.json'), JSON.stringify({
    schema: 'sks.optional-gate.v1',
    status: 'not_applicable',
    reason: 'task_profile_passthrough'
  }));
  const state = {
    mission_id: missionId,
    stop_gate: 'optional-gate.json',
    mode: 'SKS',
    route: 'SKS',
    route_command: '$SKS',
    proof_required: false,
    reflection_required: true
  };
  const decision: any = await evaluateStop(root, state, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.match(decision?.reason || decision?.systemMessage || '', /reflection/i);
  assert.doesNotMatch(decision?.reason || decision?.systemMessage || '', /Pass optional-gate\.json/i);
});

test('explicitly closed route bypasses stale native agent intake requirements', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-closed-route';
  const dir = await setupMission(root, missionId);
  const state = {
    mission_id: missionId,
    stop_gate: 'naruto-gate.json',
    mode: 'NARUTO',
    route: 'Naruto',
    route_command: '$Naruto',
    route_closed: true,
    route_closed_at: new Date().toISOString(),
    implementation_allowed: false,
    agents_required: true,
    subagents_required: true,
    reflection_required: true,
    proof_required: true
  };
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({
    schema: 'sks.naruto-gate.v1',
    passed: false,
    blockers: ['naruto_run_not_started']
  }));
  await writeCurrent(root, state);

  const decision: any = await evaluateStop(root, state, { message: 'done' }, { noQuestion: true });

  assert.equal(decision?.continue, true);
  assert.equal(decision?.action, 'route_closed');
  assert.match(decision?.systemMessage, /explicitly closed route accepted/);
  await assert.rejects(fsp.access(path.join(dir, 'compliance-loop-guard.json')));
});

test('strict pass rule rejects status blocked or blockers', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-008';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'stop-gate.json'), JSON.stringify({
    schema: 'sks.stop-gate.v1',
    route: 'Naruto',
    route_command: '$Naruto',
    mission_id: missionId,
    gate_file: 'naruto-gate.json',
    gate_abs_path: path.join(dir, 'stop-gate.json'),
    status: 'blocked',
    passed: true,
    terminal: true,
    terminal_state: 'completed',
    evidence: {},
    blockers: ['x'],
    missing_fields: [],
    created_at: new Date().toISOString()
  }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'stop-gate.json', mode: 'NARUTO', route: 'Naruto' });
  const result = await checkStopGate({ root, route: 'Naruto' });
  assert.equal(result.action, 'continue');
  assert.ok(result.diagnostics.missing_fields.includes('status'));
  assert.ok(result.diagnostics.missing_fields.includes('blockers'));
});

test('writeFinalStopGate preserves existing native gate fields', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-test-009';
  const dir = await setupMission(root, missionId);
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({ schema: 'sks.naruto-gate.v1', worker_roster_built: true, custom_detail: 'keep-me', passed: false }));
  await writeFinalStopGate({
    root,
    missionId,
    route: 'Naruto',
    routeCommand: '$Naruto',
    status: 'passed',
    terminal: true,
    terminalState: 'completed',
    evidence: { route_evidence_passed: true, proof_required: false, proof_passed: true, reflection_required: false, reflection_passed: 'not_required' },
    nativeGateFile: 'naruto-gate.json'
  });
  const native = JSON.parse(await fsp.readFile(path.join(dir, 'naruto-gate.json'), 'utf8'));
  assert.equal(native.worker_roster_built, true);
  assert.equal(native.custom_detail, 'keep-me');
  assert.equal(native.passed, true);
  const canonical = JSON.parse(await fsp.readFile(path.join(dir, 'stop-gate.json'), 'utf8'));
  assert.equal(canonical.schema, 'sks.stop-gate.v1');
});

test('diagnostics are written when no stop gate exists', async () => {
  const root = await makeTempRoot();
  const result = await checkStopGate({ root, route: 'Naruto', missionId: 'M-test-010' });
  assert.equal(result.action, 'continue');
  const diagnostics = JSON.parse(await fsp.readFile(path.join(root, '.sneakoscope', 'reports', 'stop-gate-last-check.json'), 'utf8'));
  assert.equal(diagnostics.reason, 'no_gate_file_found');
});
