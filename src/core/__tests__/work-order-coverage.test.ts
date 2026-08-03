import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import {
  createWorkOrderLedger,
  writeWorkOrderLedger,
  readWorkOrderLedger,
  updateWorkOrderItem,
  evaluateWorkOrderCoverage,
  createAndWriteWorkOrderLedgerForPrompt,
  closeWorkOrderLedgerForRouteResult,
} from '../work-order-ledger.js';
import { evaluateStop } from '../pipeline-internals/runtime-gates.js';
import { buildSubagentEvidence } from '../subagents/subagent-evidence.js';
import { writeRouteCompletionProof } from '../proof/route-adapter.js';
import { buildSsotGuard } from '../safety/ssot-guard.js';
import { validateWorkOrderLedger } from '../artifact-schemas.js';

async function makeTempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sks-wo-coverage-'));
}

async function setupMission(root: string, missionId: string): Promise<string> {
  const dir = path.join(root, '.sneakoscope', 'missions', missionId);
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeCurrent(root: string, patch: Record<string, unknown>): Promise<void> {
  const stateDir = path.join(root, '.sneakoscope', 'state');
  await fsp.mkdir(stateDir, { recursive: true });
  await fsp.writeFile(path.join(stateDir, 'current.json'), JSON.stringify({ ...patch, updated_at: new Date().toISOString() }, null, 2));
}

async function writePassingOfficialNarutoArtifacts(dir: string, missionId: string): Promise<void> {
  const threadId = `${missionId}-thread-1`;
  const parentSummary = {
    schema: 'sks.subagent-parent-summary.v1',
    status: 'completed',
    summary: 'The bounded work-order coverage fixture completed.',
    thread_outcomes: [{ thread_id: threadId, status: 'completed', summary: 'Fixture slice completed.' }],
    changed_files: [],
    verification: ['fixture verification passed'],
    blockers: []
  };
  const events = [
    { event_name: 'SubagentStart', thread_id: threadId },
    { event_name: 'SubagentStop', thread_id: threadId }
  ];
  await fsp.writeFile(path.join(dir, 'subagent-plan.json'), JSON.stringify({
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    requested_subagents: 1,
    max_threads: 12,
    max_depth: 1,
    delegation_prompt: 'Delegate the bounded fixture and wait for completion.'
  }));
  await fsp.writeFile(path.join(dir, 'subagent-events.jsonl'), events.map((event) => JSON.stringify(event)).join('\n') + '\n');
  await fsp.writeFile(path.join(dir, 'subagent-parent-summary.json'), JSON.stringify(parentSummary));
  await fsp.writeFile(path.join(dir, 'subagent-evidence.json'), JSON.stringify(buildSubagentEvidence({
    requestedSubagents: 1,
    events,
    parentSummary
  })));
  await fsp.writeFile(path.join(dir, 'ssot-guard.json'), JSON.stringify(buildSsotGuard({ route: 'Naruto', mode: 'NARUTO', task: 'fixture' })));
  await fsp.writeFile(path.join(dir, 'naruto-summary.json'), JSON.stringify({
    schema: 'sks.naruto-subagent-workflow.v1',
    ok: true,
    status: 'completed',
    route: '$sks-naruto',
    workflow: 'official_codex_subagent',
    parent: { model: 'gpt-5.6-sol', model_reasoning_effort: 'max', observed_model_match: null },
    requested_subagents: 1,
    max_threads: 12,
    max_depth: 1,
    started_subagents: 1,
    completed_subagents: 1,
    failed_subagents: 0,
    verification: { budget: 'affected', checks: [] },
    parent_summary_present: true,
    parent_summary: parentSummary.summary,
    parent_thread_outcomes: parentSummary.thread_outcomes
  }));
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), JSON.stringify({
    schema: 'sks.naruto-gate.v1',
    workflow: 'official_codex_subagent',
    mission_id: missionId,
    status: 'passed',
    passed: true,
    terminal: true,
    terminal_state: 'completed',
    subagent_plan_ready: true,
    official_subagent_evidence: true,
    parent_summary_present: true,
    ssot_guard: true,
    session_cleanup: true,
    blockers: [],
    missing_fields: []
  }));
}

test('createWorkOrderLedger maps requests to WO-00N items with verbatim source text preserved', () => {
  const ledger = createWorkOrderLedger({
    missionId: 'M-test',
    route: 'Naruto',
    requests: [{ verbatim: '첫번째 요청' }, { verbatim: '두번째 요청' }],
    sourcesComplete: true,
  });
  assert.equal(ledger.items.length, 2);
  assert.equal(ledger.items[0].id, 'WO-001');
  assert.equal(ledger.items[0].source.verbatim, '첫번째 요청');
  assert.equal(ledger.items[1].id, 'WO-002');
  assert.equal(ledger.all_customer_requests_preserved, true);
  assert.equal(ledger.source_inventory_complete, true);
  // Nothing has been mapped to implementation tasks or verified yet.
  assert.equal(ledger.all_customer_requests_mapped, false);
  assert.equal(ledger.all_work_items_verified, false);
  assert.equal(ledger.all_work_items_resolved, false);
});

test('work-order artifact validation accepts hash-bound attachment ranges and rejects incomplete pointers', () => {
  const attachmentLedger = {
    schema_version: 1,
    mission_id: 'M-attachment',
    route: 'Naruto',
    created_at: new Date().toISOString(),
    source_path: '/tmp/release-work-order.md',
    source_sha256: 'a'.repeat(64),
    source_line_count: 10,
    source_inventory_complete: true,
    all_customer_requests_preserved: true,
    all_customer_requests_mapped: true,
    all_work_items_verified: true,
    all_work_items_resolved: true,
    items: [{
      id: 'WO-001',
      source: { type: 'attachment', line_start: 1, line_end: 10, title: 'Release work order' },
      normalized_requirement: 'Implement the full attachment.',
      implementation_tasks: ['implementation'],
      owner: 'parent_orchestrator',
      status: 'verified',
      implementation_evidence: ['implementation.json'],
      verification_evidence: ['verification.json']
    }]
  };
  assert.equal(validateWorkOrderLedger(attachmentLedger).ok, true);
  assert.equal(validateWorkOrderLedger({ ...attachmentLedger, source_sha256: null }).ok, false);
  assert.equal(validateWorkOrderLedger({
    ...attachmentLedger,
    items: [{ ...attachmentLedger.items[0]!, source: { ...attachmentLedger.items[0]!.source, line_end: 11 } }]
  }).ok, false);
});

test('evaluateWorkOrderCoverage blocks while any item is pending, passes once every item is verified or honestly blocked', () => {
  let ledger = createWorkOrderLedger({
    missionId: 'M-test',
    route: 'Naruto',
    requests: [{ verbatim: 'item A' }, { verbatim: 'item B' }],
    sourcesComplete: true,
  });
  const pending = evaluateWorkOrderCoverage(ledger);
  assert.equal(pending.ok, false);
  assert.equal(pending.uncovered_count, 2);
  assert.ok(pending.blockers.some((b) => b.startsWith('work_order_uncovered:WO-001')));
  assert.ok(pending.blockers.some((b) => b.startsWith('work_order_uncovered:WO-002')));

  ledger = updateWorkOrderItem(ledger, 'WO-001', {
    status: 'verified',
    implementation_tasks: ['did the thing'],
    implementation_evidence: ['implementation.json'],
    verification_evidence: ['verification.json']
  });
  const halfDone = evaluateWorkOrderCoverage(ledger);
  assert.equal(halfDone.ok, false);
  assert.equal(halfDone.uncovered_count, 1);

  ledger = updateWorkOrderItem(ledger, 'WO-002', { status: 'blocked', blocker: { blocked: true, reason: 'out of scope', needed_to_unblock: 'n/a' } });
  assert.equal(ledger.all_work_items_verified, false);
  assert.equal(ledger.all_work_items_resolved, true);
  const done = evaluateWorkOrderCoverage(ledger);
  assert.equal(done.ok, true);
  assert.equal(done.uncovered_count, 0);
  assert.deepEqual(done.blockers, []);
});

test('evaluateWorkOrderCoverage blocks on a truncated source inventory even if every parsed item is resolved', () => {
  let ledger = createWorkOrderLedger({
    missionId: 'M-test',
    route: 'Naruto',
    requests: [{ verbatim: 'only item we kept' }],
    sourcesComplete: false, // parser signaled it dropped items beyond its ceiling
  });
  ledger = updateWorkOrderItem(ledger, 'WO-001', {
    status: 'verified',
    implementation_tasks: ['done'],
    implementation_evidence: ['implementation.json'],
    verification_evidence: ['verification.json']
  });
  const result = evaluateWorkOrderCoverage(ledger);
  assert.equal(result.ok, false);
  assert.ok(result.blockers.includes('work_order_inventory_truncated'));
});

test('evaluateWorkOrderCoverage treats a missing ledger as ok (nothing to enforce yet)', () => {
  const result = evaluateWorkOrderCoverage(null);
  assert.equal(result.ok, true);
  assert.deepEqual(result.blockers, []);
});

test('createAndWriteWorkOrderLedgerForPrompt persists one ledger item per numbered work-order line', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission');
  await fsp.mkdir(dir, { recursive: true });
  const prompt = '1. 첫번째 작업\n2. 두번째 작업\n3. 세번째 작업';
  await createAndWriteWorkOrderLedgerForPrompt(dir, { missionId: 'M-wo-1', route: 'Naruto', prompt });
  const ledger = await readWorkOrderLedger(dir);
  assert.ok(ledger);
  assert.equal(ledger.items.length, 3);
  assert.equal(ledger.items[0].source.verbatim, '첫번째 작업');
  assert.equal(ledger.items[2].source.verbatim, '세번째 작업');
  assert.equal(ledger.source_inventory_complete, true);
});

test('createAndWriteWorkOrderLedgerForPrompt splits explicit semantic slices without turning the instruction tail into work', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission');
  await fsp.mkdir(dir, { recursive: true });
  const prompt = '6.1.0 final independent release audit across five slices: Voxel TriWiki integrity; Codex Desktop fast-mode and codex-lb UI/tool compatibility; native Computer Use Browser Chrome ImageGen self-healing; retention and temporary-file lifecycle; package publish readiness. Inspect only the assigned slice with at most 10 read-only shell commands, never edit or run builds/tests/publish, and return findings, blockers, and evidence paths.';
  const ledger = await createAndWriteWorkOrderLedgerForPrompt(dir, { missionId: 'M-wo-slices', route: 'Naruto', prompt });

  assert.deepEqual(ledger.items.map((item: any) => item.source.verbatim), [
    'Voxel TriWiki integrity',
    'Codex Desktop fast-mode and codex-lb UI/tool compatibility',
    'native Computer Use Browser Chrome ImageGen self-healing',
    'retention and temporary-file lifecycle',
    'package publish readiness'
  ]);
  assert.ok(ledger.items.every((item: any) => item.acceptance_criteria.length === 1));
  assert.ok(ledger.items.every((item: any) => item.acceptance_criteria[0].startsWith('Inspect only the assigned slice')));
  assert.ok(ledger.items.every((item: any) => item.normalized_requirement.startsWith('6.1.0 final independent release audit across five:')));
});

test('createAndWriteWorkOrderLedgerForPrompt keeps an ordinary single requirement whole', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission');
  await fsp.mkdir(dir, { recursive: true });
  const prompt = 'Voxel TriWiki integrity and temporary-file lifecycle를 함께 감사해줘.';
  const ledger = await createAndWriteWorkOrderLedgerForPrompt(dir, { missionId: 'M-wo-single', route: 'Naruto', prompt });
  assert.equal(ledger.items.length, 1);
  assert.equal(ledger.items[0].source.verbatim, prompt);
});

test('reused session missions append new work-order prompts without duplicating repeated prompts', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-work-order-session-merge-'));
  const dir = path.join(root, '.sneakoscope', 'missions', 'M-wo-session');
  await fsp.mkdir(dir, { recursive: true });

  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: 'M-wo-session',
    route: 'Naruto',
    prompt: 'Define the official custom agent catalog.'
  });
  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: 'M-wo-session',
    route: 'Naruto',
    prompt: 'Define the official custom agent catalog.'
  });
  const merged = await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: 'M-wo-session',
    route: 'Naruto',
    prompt: 'Show official subagent activity in the native Codex task view.'
  });

  assert.equal(merged.items.length, 2);
  assert.deepEqual(merged.items.map((item: any) => item.id), ['WO-001', 'WO-002']);
  assert.match(merged.items[0].source.verbatim, /custom agent catalog/i);
  assert.match(merged.items[1].source.verbatim, /native Codex task view/i);
});

test('semantic slice parsing also respects numbered and sentence boundaries', async () => {
  const root = await makeTempRoot();
  const numberedDir = path.join(root, 'numbered');
  const sentenceDir = path.join(root, 'sentences');
  await fsp.mkdir(numberedDir, { recursive: true });
  await fsp.mkdir(sentenceDir, { recursive: true });

  const numbered = await createAndWriteWorkOrderLedgerForPrompt(numberedDir, {
    missionId: 'M-wo-numbered-slices', route: 'Naruto',
    prompt: 'Audit slices: 1. wiki integrity 2. Fast UI compatibility 3. publish readiness. Verify each assigned slice and report evidence.'
  });
  assert.deepEqual(numbered.items.map((item: any) => item.source.verbatim), ['wiki integrity', 'Fast UI compatibility', 'publish readiness']);
  assert.ok(numbered.items.every((item: any) => item.acceptance_criteria[0].startsWith('Verify each assigned slice')));

  const sentences = await createAndWriteWorkOrderLedgerForPrompt(sentenceDir, {
    missionId: 'M-wo-sentence-slices', route: 'Naruto',
    prompt: 'Audit slices: wiki integrity. Fast UI compatibility. publish readiness. Inspect only the assigned slice and report evidence.'
  });
  assert.deepEqual(sentences.items.map((item: any) => item.source.verbatim), ['wiki integrity', 'Fast UI compatibility', 'publish readiness']);
  assert.ok(sentences.items.every((item: any) => item.acceptance_criteria[0].startsWith('Inspect only the assigned slice')));
});

test('semantic slice parsing recognizes repeated Scope N markers without a scopes colon', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'repeated-scopes');
  await fsp.mkdir(dir, { recursive: true });
  const ledger = await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: 'M-wo-repeated-scopes',
    route: 'Naruto',
    prompt: 'Final audit across exactly three assigned scopes. Scope 1: TriWiki integrity. Scope 2: Fast UI compatibility. Scope 3: publish readiness. Inspect only the assigned Scope and report evidence.'
  });
  assert.deepEqual(ledger.items.map((item: any) => item.source.verbatim), [
    'TriWiki integrity',
    'Fast UI compatibility',
    'publish readiness'
  ]);
  assert.ok(ledger.items.every((item: any) => item.acceptance_criteria[0].startsWith('Inspect only the assigned Scope')));
});

test('semantic slice parsing recognizes Korean 영역 markers without affecting ordinary prompts', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'korean-marker');
  await fsp.mkdir(dir, { recursive: true });
  const ledger = await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: 'M-wo-korean-slices', route: 'Naruto',
    prompt: '6.1.0 최종 감사 영역: 복셀 트라이위키 무결성; 빠른 모드 UI 호환성; 배포 준비 상태. 검사 시 할당된 영역만 읽고 증거 경로를 보고한다.'
  });
  assert.deepEqual(ledger.items.map((item: any) => item.source.verbatim), ['복셀 트라이위키 무결성', '빠른 모드 UI 호환성', '배포 준비 상태']);
  assert.ok(ledger.items.every((item: any) => item.acceptance_criteria[0].startsWith('검사 시 할당된 영역')));
});

test('closeWorkOrderLedgerForRouteResult resolves every item to verified on success and to blocked with the real reason on failure', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission');
  await fsp.mkdir(dir, { recursive: true });
  await writeWorkOrderLedger(dir, createWorkOrderLedger({
    missionId: 'M-wo-2',
    route: 'Goal',
    requests: [{ verbatim: 'a' }, { verbatim: 'b' }],
    sourcesComplete: true,
  }));

  await closeWorkOrderLedgerForRouteResult(dir, { ok: false, blockers: ['some_real_blocker'] });
  let closed = await readWorkOrderLedger(dir);
  assert.ok(closed);
  assert.ok(closed.items.every((item: any) => item.status === 'blocked'));
  assert.ok(closed.items.every((item: any) => item.blocker.reason === 'some_real_blocker'));
  assert.equal(closed.all_work_items_verified, false);
  assert.equal(closed.all_work_items_resolved, true);
  assert.equal(evaluateWorkOrderCoverage(closed).ok, true, 'an honestly blocked ledger is a passing coverage check');

  await fsp.writeFile(path.join(dir, 'completion-proof.json'), '{"ok":true}\n');
  await closeWorkOrderLedgerForRouteResult(dir, { ok: true, blockers: [] });
  closed = await readWorkOrderLedger(dir);
  assert.ok(closed.items.every((item: any) => item.status === 'verified'));
  assert.ok(closed.items.every((item: any) => item.blocker.blocked === false));
  assert.ok(closed.items.every((item: any) => item.blocker.reason === null));
  assert.ok(closed.items.every((item: any) => item.implementation_evidence.includes('completion-proof.json')));
  assert.ok(closed.items.every((item: any) => item.verification_evidence.includes('completion-proof.json')));
  assert.equal(evaluateWorkOrderCoverage(closed).ok, true);
});

test('closeWorkOrderLedgerForRouteResult never verifies success without a persisted route proof', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission-without-proof');
  await fsp.mkdir(dir, { recursive: true });
  await writeWorkOrderLedger(dir, createWorkOrderLedger({
    missionId: 'M-wo-no-proof',
    route: 'Naruto',
    requests: [{ verbatim: 'audit item' }],
    sourcesComplete: true
  }));
  const closed = await closeWorkOrderLedgerForRouteResult(dir, { ok: true });
  assert.equal(closed.items[0].status, 'blocked');
  assert.equal(closed.items[0].blocker.reason, 'route_completion_evidence_missing');
});

test('closeWorkOrderLedgerForRouteResult does not bulk-close attachment release ledgers', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'attachment-release-ledger');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'naruto-gate.json'), '{"passed":true}\n');
  const ledger = {
    ...createWorkOrderLedger({ missionId: 'M-release', route: 'Naruto', requests: [{ verbatim: 'release attachment' }], sourcesComplete: true }),
    source_path: '/tmp/release-work-order.md',
    source_sha256: 'a'.repeat(64),
    source_line_count: 1,
    items: [{
      id: 'WO-000',
      source: { type: 'attachment', line_start: 1, line_end: 1, slice_sha256: 'b'.repeat(64) },
      normalized_requirement: 'release requirement',
      implementation_tasks: ['implement independently'],
      status: 'pending',
      implementation_evidence: [],
      verification_evidence: []
    }]
  };
  await writeWorkOrderLedger(dir, ledger);

  const closed = await closeWorkOrderLedgerForRouteResult(dir, { ok: true });
  assert.equal(closed.items[0].status, 'pending');
  assert.deepEqual(closed.items[0].implementation_evidence, []);
  assert.equal(closed.all_work_items_verified, false);
});

test('closeWorkOrderLedgerForRouteResult is a no-op when there is no ledger to close', async () => {
  const root = await makeTempRoot();
  const dir = path.join(root, 'mission');
  await fsp.mkdir(dir, { recursive: true });
  const result = await closeWorkOrderLedgerForRouteResult(dir, { ok: true });
  assert.equal(result, null);
});

test('evaluateStop blocks a Naruto mission with unresolved work-order-ledger items even though its own gate passed', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-wo-block';
  const dir = await setupMission(root, missionId);
  await writePassingOfficialNarutoArtifacts(dir, missionId);
  await writeWorkOrderLedger(dir, createWorkOrderLedger({
    missionId,
    route: 'Naruto',
    requests: [{ verbatim: 'unfinished item' }],
    sourcesComplete: true,
  }));
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false });

  const decision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false }, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.match(decision?.reason, /unresolved work-order-ledger items/);
});

test('evaluateStop allows a Naruto mission to stop once its official, proof, and work-order gates resolve', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-wo-allow';
  const dir = await setupMission(root, missionId);
  await writePassingOfficialNarutoArtifacts(dir, missionId);
  let ledger = createWorkOrderLedger({
    missionId,
    route: 'Naruto',
    requests: [{ verbatim: 'finished item' }],
    sourcesComplete: true,
  });
  ledger = updateWorkOrderItem(ledger, 'WO-001', {
    status: 'verified',
    implementation_tasks: ['done'],
    implementation_evidence: ['naruto-gate.json'],
    verification_evidence: ['naruto-gate.json']
  });
  await writeWorkOrderLedger(dir, ledger);
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
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false });

  const decision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false }, { message: 'done' });
  assert.equal(decision?.continue, true, 'evaluateStop allows stop once every independent route/proof/coverage gate passes');
  assert.match(decision?.systemMessage, /canonical stop-gate passed/);
});

test('evaluateStop blocks a coverage_required route entirely missing its work-order-ledger', async () => {
  const root = await makeTempRoot();
  const missionId = 'M-wo-missing';
  const dir = await setupMission(root, missionId);
  await writePassingOfficialNarutoArtifacts(dir, missionId);
  await writeCurrent(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false });

  const decision: any = await evaluateStop(root, { mission_id: missionId, stop_gate: 'naruto-gate.json', mode: 'NARUTO', route: 'Naruto', route_command: '$Naruto', agents_required: false, proof_required: false, reflection_required: false }, { message: 'done' });
  assert.equal(decision?.decision, 'block');
  assert.match(decision?.reason, /work_order_ledger_missing/);
});
