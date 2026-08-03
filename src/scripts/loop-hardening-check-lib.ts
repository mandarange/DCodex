#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runProcess } from '../core/fsx.js';
import { decideLoopFixturePolicy } from '../core/loops/loop-fixture-policy.js';
import { writeLoopFinalArbiterGateContract } from '../core/loops/loop-final-arbiter-contract.js';
import { runLoopGates } from '../core/loops/loop-gate-runner.js';
import { runLoopMakerWorkers } from '../core/loops/loop-worker-runtime.js';
import { runLoopGptFinalArbiter } from '../core/loops/loop-gpt-final-arbiter.js';
import { mergeLoopWorktrees } from '../core/loops/loop-integration-merge.js';
import { mergeSingleLoopWorktree } from '../core/loops/loop-merge-strategy.js';
import { appendLoopMutationEvent, mutationLedgerFromLoopProofs, readLoopMutationLedger } from '../core/loops/loop-mutation-ledger.js';
import { buildLoopSideEffectReport } from '../core/loops/loop-side-effect-scanner.js';
import { interruptLoopWorkers, readLoopActiveWorkers, registerLoopActiveWorker } from '../core/loops/loop-interrupt-registry.js';
import { computeLoopConcurrencyBudget } from '../core/loops/loop-concurrency-budget.js';
import { defaultLoopBudget } from '../core/loops/loop-schema.js';
import { root } from './gate-lib.js';

export async function runLoopHardeningCheck(id) {
  const assertions = [];
  const assert = (condition, message, detail = {}) => assertions.push({ ok: Boolean(condition), message, detail });
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), `sks-312-${safe(id)}-`));
  await fs.mkdir(path.join(temp, '.sneakoscope', 'missions'), { recursive: true });

  if (id === 'loop:fixture-policy') {
    const allowed = decideLoopFixturePolicy({ root: temp, missionId: 'M-check-fixture-policy', mode: 'gate', requested: true, argv: ['/x/dist/scripts/loop-fixture-policy-check.js'], env: {} });
    const denied = decideLoopFixturePolicy({ root, missionId: 'M-prod-fixture-policy', mode: 'gate', requested: true, argv: ['sks', 'loop', 'run'], env: { SKS_LOOP_GATE_FIXTURE: '1' } });
    assert(allowed.allowed && allowed.reason.includes('release_check_script'), 'fixture policy allows check/blackbox temp runs', allowed);
    assert(!denied.allowed && denied.blockers.includes('loop_gate_fixture_forbidden_in_production'), 'fixture policy blocks production command fixture', denied);
  } else if (id === 'loop:gate-fixture-guard') {
    const node = sampleNode('loop-runtime', 'M-prod-gate-fixture');
    const prev = process.env.SKS_LOOP_GATE_FIXTURE;
    const argv = replaceArgv(['sks', 'loop', 'run']);
    await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({ scripts: { 'release:version-truth': 'node -e "process.exit(0)"' } }, null, 2));
    process.env.SKS_LOOP_GATE_FIXTURE = '1';
    const gates = await runLoopGates({ root: temp, missionId: node.mission_id, node, gates: { triage: [], local: ['release:version-truth'], checker: [], integration: [], final: [] } });
    restoreEnv('SKS_LOOP_GATE_FIXTURE', prev);
    restoreArgv(argv);
    assert(!gates.ok && gates.blockers.includes('loop_gate_fixture_forbidden_in_production'), 'production gate fixture cannot synthetic-pass');
  } else if (id === 'loop:worker-fixture-guard') {
    const plan = samplePlan('M-prod-worker-fixture', [sampleNode('loop-runtime', 'M-prod-worker-fixture')]);
    const prev = process.env.SKS_LOOP_RUNTIME_FIXTURE;
    const argv = replaceArgv(['sks', 'loop', 'run']);
    process.env.SKS_LOOP_RUNTIME_FIXTURE = '1';
    try {
      await runLoopMakerWorkers({ root: temp, plan, node: plan.graph.nodes[0], fixture: true });
      assert(false, 'production worker fixture throws');
    } catch (err) {
      assert(String(err).includes('loop_fixture_runtime_forbidden'), 'production worker fixture throws forbidden error', { message: String(err) });
    }
    restoreEnv('SKS_LOOP_RUNTIME_FIXTURE', prev);
    restoreArgv(argv);
  } else if (id === 'loop:gpt-final-fixture-guard') {
    const plan = samplePlan('M-prod-gpt-fixture', [sampleNode('loop-runtime', 'M-prod-gpt-fixture')]);
    const argv = replaceArgv(['sks', 'loop', 'run']);
    const arbiter = await runLoopGptFinalArbiter({ root: temp, plan, proofs: [sampleProof('loop-runtime', 'M-prod-gpt-fixture', ['src/core/runtime/a.ts'])], integrationMerge: sampleMerge(['src/core/runtime/a.ts']), forceVerdict: 'approve' });
    restoreArgv(argv);
    assert(!arbiter.ok && arbiter.blockers.includes('loop_gpt_final_fixture_forbidden_in_production'), 'production GPT final fixture cannot approve');
  } else if (id === 'loop:fixture-production-misuse-blackbox') {
    const gate = decideLoopFixturePolicy({ root, missionId: 'M-normal-production', mode: 'gate', requested: true, env: { SKS_LOOP_GATE_FIXTURE: '1' }, argv: ['sks', 'loop', 'run'] });
    const worker = decideLoopFixturePolicy({ root, missionId: 'M-normal-production', mode: 'worker', requested: true, env: { SKS_LOOP_RUNTIME_FIXTURE: '1' }, argv: ['sks', 'naruto'] });
    const allowed = decideLoopFixturePolicy({ root: temp, missionId: 'M-check-production-misuse', mode: 'worker', requested: true, env: { SKS_TEST_RUNTIME_FIXTURE_ALLOWED: '1' }, argv: ['/x/dist/scripts/loop-fixture-production-misuse-blackbox.js'] });
    assert(!gate.allowed && !worker.allowed, 'production gate/worker fixtures are denied');
    assert(allowed.allowed, 'M-check temp fixture remains allowed');
  } else if (id === 'loop:final-arbiter-contract') {
    const contract = await writeLoopFinalArbiterGateContract(temp, 'M-check-final-contract');
    assert(contract.handled_by === 'loop-finalizer' && contract.production_fixture_allowed === false, 'final arbiter contract is finalizer-owned');
    assert(await exists(path.join(temp, '.sneakoscope/missions/M-check-final-contract/loops/gpt-final-arbiter-gate-contract.json')), 'contract artifact written');
  } else if (id === 'loop:gpt-final-gate-contract') {
    const node = sampleNode('loop-runtime', 'M-check-gpt-final-gate');
    const result = await runLoopGates({ root: temp, missionId: node.mission_id, node, gates: { triage: [], local: [], checker: [], integration: [], final: ['gpt:final-arbiter'] } });
    const artifact = await readJson(path.join(temp, '.sneakoscope/missions/M-check-gpt-final-gate/loops/loop-runtime/gates/gpt-final-arbiter.json'));
    assert(result.ok && result.skipped_gates.includes('gpt:final-arbiter'), 'gpt final pseudo gate is skipped by gate runner');
    assert(artifact.handled_by === 'loop-finalizer' && artifact.deferred_contract_path, 'gate artifact points to finalizer contract');
  } else if (id === 'loop:gpt-final-contract-crossref') {
    const plan = samplePlan('M-check-gpt-crossref', [sampleNode('loop-runtime', 'M-check-gpt-crossref')]);
    const arbiter = await runLoopGptFinalArbiter({ root: temp, plan, proofs: [sampleProof('loop-runtime', plan.mission_id, ['src/core/runtime/a.ts'])], integrationMerge: sampleMerge(['src/core/runtime/a.ts']), forceVerdict: 'approve' });
    assert(arbiter.ok, 'check mission may use forced GPT final verdict');
    assert(await exists(path.join(temp, '.sneakoscope/missions/M-check-gpt-crossref/loops/fixture-policy.json')), 'GPT final fixture policy artifact written');
  } else if (id === 'loop:merge-strategy' || id === 'loop:merge-strategy-blackbox') {
    const fixture = await gitFixture('merge-strategy');
    const proof = sampleProof('loop-runtime', 'M-check-merge-strategy', ['src/core/runtime/a.ts']);
    proof.worktree.path = fixture.worktree;
    proof.worktree.branch = 'loop-branch';
    await fs.writeFile(path.join(fixture.worktree, 'src/core/runtime/a.ts'), 'changed\n');
    const merge = await mergeSingleLoopWorktree({ root: fixture.root, proof, worktreePath: fixture.worktree, allowBranchMerge: true });
    assert(merge.ok && ['apply', 'apply-3way', 'cherry-pick', 'already_applied'].includes(String(merge.selected_strategy)), 'merge strategy ladder applies simple patch', merge);
    if (id === 'loop:merge-strategy-blackbox') {
      const again = await mergeSingleLoopWorktree({ root: fixture.root, proof, worktreePath: fixture.worktree, allowBranchMerge: true });
      assert(again.ok && again.selected_strategy === 'already_applied', 'already applied patch is handled');
    }
  } else if (id === 'loop:integration-merge-strategy') {
    const fixture = await gitFixture('integration-merge');
    await fs.writeFile(path.join(fixture.worktree, 'src/core/runtime/a.ts'), 'integrated\n');
    const proof = sampleProof('loop-runtime', 'M-check-integration-merge', ['src/core/runtime/a.ts']);
    proof.worktree.path = fixture.worktree;
    const plan = samplePlan('M-check-integration-merge', [
      sampleNode('loop-runtime', 'M-check-integration-merge'),
      sampleNode('loop-integration', 'M-check-integration-merge')
    ]);
    const result = await mergeLoopWorktrees({ root: fixture.root, plan, proofs: [proof] });
    assert(result.ok && result.merge_attempts?.['loop-runtime'], 'integration merge records merge strategy attempts');
  } else if (id === 'loop:mutation-ledger') {
    await appendLoopMutationEvent(temp, 'M-check-ledger', { loop_id: 'loop-runtime', event_type: 'file_changed', file_path: 'src/core/runtime/a.ts', source: 'git-diff', allowed_by_owner_scope: true, details: {} });
    const rows = await readLoopMutationLedger(temp, 'M-check-ledger');
    assert(rows.length === 1 && rows[0].event_type === 'file_changed', 'mutation ledger append/read works');
  } else if (id === 'loop:side-effect-scanner' || id === 'loop:side-effect-blackbox') {
    const proofs = [sampleProof('loop-runtime', 'M-check-side-effect', ['package.json'])];
    await mutationLedgerFromLoopProofs({ root: temp, missionId: 'M-check-side-effect', proofs, integrationMerge: sampleMerge(['package.json']) });
    const report = await buildLoopSideEffectReport({ root: temp, missionId: 'M-check-side-effect', proofs, integrationMerge: sampleMerge(['package.json']) });
    assert(!report.ok && report.unexpected_package_changes.includes('package.json'), 'side-effect scanner blocks non-integration package mutation', report);
    if (id === 'loop:side-effect-blackbox') assert(report.blockers.some((row) => row.includes('unexpected_package_change')), 'side-effect blackbox exposes blocker');
  } else if (id === 'loop:side-effect-final-arbiter') {
    const plan = samplePlan('M-check-side-effect-final', [sampleNode('loop-runtime', 'M-check-side-effect-final')]);
    const report = await buildLoopSideEffectReport({ root: temp, missionId: plan.mission_id, proofs: [sampleProof('loop-runtime', plan.mission_id, ['package.json'])], integrationMerge: sampleMerge(['package.json']) });
    const arbiter = await runLoopGptFinalArbiter({ root: temp, plan, proofs: [sampleProof('loop-runtime', plan.mission_id, ['package.json'])], integrationMerge: sampleMerge(['package.json']), sideEffectReport: report });
    assert(!arbiter.ok && arbiter.verdict === 'reject', 'side-effect block rejects before GPT can approve');
  } else if (id === 'loop:interrupt-registry' || id === 'loop:worker-handle-registration') {
    await registerLoopActiveWorker(temp, { mission_id: 'M-check-interrupt', loop_id: 'loop-runtime', phase: 'maker', worker_id: 'w1', session_id: 's1', pid: null, interrupt_supported: true });
    const handles = await readLoopActiveWorkers(temp, 'M-check-interrupt');
    assert(handles.length === 1 && handles[0].status === 'running', 'active worker handle registers');
  } else if (id === 'loop:worker-interrupt' || id === 'loop:kill-interrupt-real-blackbox') {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    await registerLoopActiveWorker(temp, { mission_id: 'M-check-interrupt-real', loop_id: 'loop-runtime', phase: 'maker', worker_id: 'sleepy', session_id: null, pid: child.pid || null, interrupt_supported: true });
    const result = await interruptLoopWorkers({ root: temp, missionId: 'M-check-interrupt-real', target: 'loop-runtime', graceMs: 50 });
    assert(result.interrupted.includes('sleepy'), 'active worker receives interrupt');
    child.kill('SIGKILL');
  } else if (id === 'loop:concurrency-budget' || id === 'loop:concurrency-budget-runtime' || id === 'loop:concurrency-oversubscription-blackbox') {
    const plan = samplePlan('M-check-budget', Array.from({ length: 10 }, (_, i) => sampleNode(`loop-${i}`, 'M-check-budget', 8, 8)));
    const budget = computeLoopConcurrencyBudget({ plan, parallelism: 'extreme', env: { SKS_LOOP_MAX_ACTIVE_WORKERS: '16', SKS_LOOP_MAX_ACTIVE_LOOPS: '4', SKS_LOOP_MAX_MODEL_CALLS: '8' } });
    assert(budget.max_active_workers === 4 && budget.max_active_loops === 4, 'env concurrency requests cannot raise the desktop-safe loop budget', budget);
    assert(budget.per_loop_worker_budget.reduce((sum, row) => sum + row.maker_workers + row.checker_workers, 0) <= 16, 'per-loop worker budget does not oversubscribe');
  } else if (id === 'loop:mesh-production-e2e-blackbox') {
    const fixture = await gitFixture('mesh-e2e');
    const proof = sampleProof('loop-runtime', 'M-check-mesh-e2e', ['src/core/runtime/a.ts']);
    proof.worktree.path = fixture.worktree;
    await fs.writeFile(path.join(fixture.worktree, 'src/core/runtime/a.ts'), 'mesh\n');
    const merge = await mergeSingleLoopWorktree({ root: fixture.root, proof, worktreePath: fixture.worktree, allowBranchMerge: true });
    const side = await buildLoopSideEffectReport({ root: fixture.root, missionId: 'M-check-mesh-e2e', proofs: [proof], integrationMerge: sampleMerge(['src/core/runtime/a.ts']) });
    const fixturePolicy = decideLoopFixturePolicy({ root: fixture.root, missionId: 'M-check-mesh-e2e', mode: 'gpt-final', requested: true, argv: ['/x/dist/scripts/loop-mesh-production-e2e-blackbox.js'], env: {} });
    assert(merge.ok && side.ok && fixturePolicy.allowed, 'production e2e blackbox covers merge, side effects, and check-only final fixture');
  } else if (id === 'loop:status-proof-ux') {
    const text = await fs.readFile(path.join(root, 'src/core/commands/loop-command.ts'), 'utf8');
    assert(['active_worker_handles', 'side_effects', 'strategy_summary', 'Final arbiter'].every((token) => text.includes(token)), 'loop status/proof UX exposes hardening fields');
  } else if (id === 'changelog:loop-productionization') {
    const text = await fs.readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
    assert(text.includes('## [3.1.2] - 2026-06-13'), 'changelog has 3.1.2 section');
    for (const token of ['fixture misuse guard', 'Finalizer-owned GPT final arbiter', 'merge strategy ladder', 'side-effect scanner', 'kill interrupt', 'concurrency budget', 'production e2e blackbox']) {
      assert(text.toLowerCase().includes(token.toLowerCase()), `changelog mentions ${token}`);
    }
  } else if (id === 'docs:loop-productionization') {
    const docs = await Promise.all(['docs/loop-runtime.md', 'docs/naruto-loop-mesh.md', 'docs/loop-fixture-policy.md', 'docs/loop-merge-strategy.md'].map((file) => fs.readFile(path.join(root, file), 'utf8')));
    for (const token of ['fixture', 'gpt:final-arbiter', 'merge strategy', 'side-effect', 'interrupt', 'concurrency']) {
      assert(docs.some((text) => text.toLowerCase().includes(token.toLowerCase())), `docs mention ${token}`);
    }
  } else {
    assert(false, `unknown loop hardening check id: ${id}`);
  }

  const failed = assertions.filter((row) => !row.ok);
  const report = { schema: 'sks.loop-hardening-check.v1', id, ok: failed.length === 0, assertions, temp_root: temp };
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
}

function sampleNode(loopId, missionId, makerWorkers = 2, checkerWorkers = 1) {
  return {
    schema: 'sks.loop-node.v1',
    loop_id: loopId,
    mission_id: missionId,
    title: loopId,
    purpose: 'fixture node',
    level: 'L2-action',
    route: loopId.includes('integration') ? '$Integration' : '$Loop',
    owner_scope: { files: [], directories: ['src/core/runtime'], package_scripts: [], release_gate_ids: [], exclusive: true, collision_policy: 'handoff' },
    state_file: 'state.json',
    run_log_file: 'run.jsonl',
    budget: defaultLoopBudget({ max_model_calls: 8, max_subagents: makerWorkers + checkerWorkers }),
    maker: { route: '$Naruto', role: 'implementer', worker_count: makerWorkers, backend_preference: ['codex-sdk'], local_draft_allowed: false, gpt_final_required: false },
    checker: { route: '$QA-LOOP', worker_count: checkerWorkers, fresh_session_required: true, stronger_model_required: false, required_before_next_iteration: true },
    gates: { triage: [], local: [], checker: [], integration: [], final: [] },
    dependencies: [],
    handoff_policy: { allow_handoff: true, reasons: [], artifact: null },
    worktree: { required: false, mode: 'none', branch_prefix: 'loop', cleanup: 'keep-on-failure' },
    risk: { level: 'medium', reasons: [], requires_worktree: false, requires_gpt_final: true, requires_human_handoff: false }
  };
}

function samplePlan(missionId, nodes) {
  return {
    schema: 'sks.loop-plan.v1',
    mission_id: missionId,
    request: 'fixture plan',
    generated_at: new Date().toISOString(),
    planner: { route: '$Loop', model_policy: 'deterministic', confidence: 'high' },
    graph: { nodes, edges: [] },
    global_budget: defaultLoopBudget({ max_model_calls: 32, max_subagents: 32 }),
    safety: { no_unrequested_fallback_code: true, require_owner_lease: true, require_checker_for_action: true, require_gpt_final_for_source_mutation: true },
    integration_loop_id: nodes.at(-1)?.loop_id || 'loop-integration',
    compatibility: { goal_compat_artifact: null, source_command: 'loop' },
    blockers: []
  };
}

function sampleProof(loopId, missionId, changedFiles) {
  return {
    schema: 'sks.loop-proof.v1',
    mission_id: missionId,
    loop_id: loopId,
    status: 'completed',
    iterations: 1,
    owner_scope: { files: [], directories: ['src/core/runtime'], package_scripts: [], release_gate_ids: [], exclusive: true, collision_policy: 'handoff' },
    worktree: { id: loopId, path: null, branch: null },
    maker_result: { ok: true, worker_count: 1, artifacts: [], patch_candidates: [], backend: 'deterministic-fixture', changed_files: changedFiles, runtime_proof_path: null },
    checker_result: { ok: true, worker_count: 1, artifacts: [], blockers: [], backend: 'deterministic-fixture', checker_findings: [], fresh_session: true, runtime_proof_path: null },
    gate_result: { ok: true, selected_gates: [], passed_gates: [], failed_gates: [], skipped_gates: [], blockers: [] },
    budget: { used: { wall_ms: 1, model_calls: 1, subagents: 2, iterations: 1, changed_files: changedFiles.length, patch_bytes: 1 }, max: defaultLoopBudget() },
    changed_files: changedFiles,
    patch_bytes: 1,
    handoff: { required: false, reason: null, artifact: null },
    blockers: []
  };
}

function sampleMerge(changedFiles) {
  return { schema: 'sks.loop-integration-merge.v1', ok: true, applied_loops: ['loop-runtime'], conflict_loops: [], changed_files: changedFiles, blockers: [] };
}

async function gitFixture(name) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `sks-312-git-${safe(name)}-`));
  await fs.mkdir(path.join(repo, 'src/core/runtime'), { recursive: true });
  await fs.writeFile(path.join(repo, 'src/core/runtime/a.ts'), 'base\n');
  await runProcess('git', ['init'], { cwd: repo, maxOutputBytes: 10000 });
  await runProcess('git', ['config', 'user.email', 'sks@example.invalid'], { cwd: repo, maxOutputBytes: 10000 });
  await runProcess('git', ['config', 'user.name', 'SKS Check'], { cwd: repo, maxOutputBytes: 10000 });
  await runProcess('git', ['add', '.'], { cwd: repo, maxOutputBytes: 10000 });
  await runProcess('git', ['commit', '-m', 'base'], { cwd: repo, maxOutputBytes: 20000 });
  const worktree = `${repo}-worktree`;
  await runProcess('git', ['worktree', 'add', '-b', 'loop-branch', worktree], { cwd: repo, maxOutputBytes: 20000 });
  return { root: repo, worktree };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function replaceArgv(next) {
  const previous = [...process.argv];
  process.argv.splice(0, process.argv.length, ...next);
  return previous;
}

function restoreArgv(previous) {
  process.argv.splice(0, process.argv.length, ...previous);
}

function safe(value) {
  return String(value).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'check';
}
