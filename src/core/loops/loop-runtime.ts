import { writeJsonAtomic } from '../fsx.js';
import { loopBudgetPath, loopProofPath, loopStatePath } from './loop-artifacts.js';
import { computeLoopConcurrencyBudget, writeLoopConcurrencyBudget } from './loop-concurrency-budget.js';
import { writeLoopCheckpoint } from './loop-checkpoint.js';
import { finalizeLoopGraph } from './loop-finalizer.js';
import { runLoopGates } from './loop-gate-runner.js';
import { acquireLoopLease, releaseLoopLease, type SksLoopLease } from './loop-lease.js';
import { checkpointCancelledLoop, shouldKillLoop } from './loop-runtime-control.js';
import { scheduleLoopGraph } from './loop-scheduler.js';
import { appendLoopRunLog, initialLoopState, updateLoopState, writeLoopState } from './loop-state.js';
import { runLoopCheckerWorkers, runLoopMakerWorkers, type LoopWorkerRunResult } from './loop-worker-runtime.js';
import { allocateLoopWorktree, computeLoopDiff, type LoopDiffSummary, type LoopWorktreeRecord } from './loop-worktree-runtime.js';
import type { SksLoopGraphResult, SksLoopNode, SksLoopPlan, SksLoopProof } from './loop-schema.js';

export async function runLoopPlan(input: {
  root: string;
  plan: SksLoopPlan;
  parallelism?: 'safe' | 'balanced' | 'extreme';
  dryRun?: boolean;
  noMutation?: boolean;
}): Promise<SksLoopGraphResult> {
  const started = Date.now();
  const concurrencyBudget = computeLoopConcurrencyBudget({ plan: input.plan, parallelism: input.parallelism || 'safe' });
  await writeLoopConcurrencyBudget(input.root, concurrencyBudget);
  const schedule = scheduleLoopGraph(input.plan.graph.nodes, input.parallelism || 'safe', concurrencyBudget);
  const proofs: SksLoopProof[] = [];
  for (const batch of schedule.batches) {
    if (await shouldKillLoop(input.root, input.plan.mission_id, 'all')) break;
    const batchProofs = await Promise.all(batch.map((node) => runLoopNode({
      root: input.root,
      plan: input.plan,
      node,
      noMutation: Boolean(input.noMutation || input.dryRun)
    })));
    proofs.push(...batchProofs);
  }
  const graphProof = await finalizeLoopGraph({
    root: input.root,
    plan: input.plan,
    proofs,
    maxActiveLoops: concurrencyBudget.max_active_loops,
    maxActiveWorkers: concurrencyBudget.max_active_workers,
    wallMs: Math.max(1, Date.now() - started)
  });
  return {
    ok: schedule.ok && graphProof.ok,
    mission_id: input.plan.mission_id,
    proofs,
    graph_proof: graphProof,
    blockers: [...schedule.blockers, ...graphProof.blockers]
  };
}

export async function runLoopNode(input: {
  root: string;
  plan: SksLoopPlan;
  node: SksLoopNode;
  iterationStart?: number;
  noMutation?: boolean;
}): Promise<SksLoopProof> {
  const started = Date.now();
  const node = input.node;
  const iteration = input.iterationStart || 1;
  const files = [...node.owner_scope.files, ...node.owner_scope.directories];
  let lease: SksLoopLease | null = null;
  let worktree: LoopWorktreeRecord | null = null;
  try {
    await writeLoopState(input.root, initialLoopState({ missionId: node.mission_id, loopId: node.loop_id, files }));
    await writeJsonAtomic(loopBudgetPath(input.root, node.mission_id, node.loop_id), node.budget);
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_started', status: 'running', message: node.purpose });
    await checkpoint(input.root, node, iteration, 'triage', false);
    await updateLoopState(input.root, node.mission_id, node.loop_id, { status: 'running', iteration, current_phase: 'triage' });
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_triage_completed', status: 'running' });

    lease = await acquireLoopLease(input.root, input.plan, node);
    if (lease.blockers.length) return blockedProof(input.root, node, lease.blockers, started, 'owner_collision', 'handoff');

    worktree = await allocateLoopWorktree({
      root: input.root,
      plan: input.plan,
      node,
      ...(input.noMutation === undefined ? {} : { noMutation: input.noMutation })
    });
    if (worktree.blockers.length) return blockedProof(input.root, node, worktree.blockers, started, 'worktree_blocked', 'blocked', lease, worktree);

    await updateLoopState(input.root, node.mission_id, node.loop_id, {
      current_phase: 'maker',
      acting_on: { files, worktree_id: worktree.worktree_id || lease.worktree_id, branch: worktree.branch }
    });
    if (await shouldCancel(input.root, node, iteration, 'maker')) return cancelledProof(input.root, node, started, lease, worktree, 'maker');
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_maker_started', status: 'running' });
    const maker = await runLoopMakerWorkers({
      root: input.root,
      plan: input.plan,
      node,
      worktree: { id: worktree.worktree_id || lease.worktree_id, path: worktree.path, branch: worktree.branch },
      ...(input.noMutation === undefined ? {} : { noMutation: input.noMutation })
    });
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_maker_completed', status: maker.ok ? 'running' : 'blocked' });
    await checkpoint(input.root, node, iteration, 'maker', true);
    if (!maker.ok) return workerBlockedProof(input.root, node, maker, null, started, 'maker_failed', lease, worktree);

    await updateLoopState(input.root, node.mission_id, node.loop_id, { current_phase: 'checker', last_action: 'maker_workers_completed' });
    if (await shouldCancel(input.root, node, iteration, 'checker')) return cancelledProof(input.root, node, started, lease, worktree, 'checker');
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_checker_started', status: 'running' });
    const checker = await runLoopCheckerWorkers({
      root: input.root,
      plan: input.plan,
      node,
      worktree: { id: worktree.worktree_id || lease.worktree_id, path: worktree.path, branch: worktree.branch },
      // Checker is read-only by definition; fixture mode requires an explicit test-only runtime flag.
      noMutation: true,
      makerArtifacts: maker.artifacts
    });
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_checker_completed', status: checker.ok ? 'running' : 'blocked' });
    await checkpoint(input.root, node, iteration, 'checker', true);
    if (!checker.ok) return workerBlockedProof(input.root, node, maker, checker, started, 'checker_failed', lease, worktree);

    const diff = input.noMutation ? emptyDiff() : await computeLoopDiff({
      root: input.root,
      worktreePath: worktree.path,
      ownerScope: node.owner_scope
    });
    const changedFiles = [...new Set([...maker.changed_files, ...diff.changed_files])];
    const patchBytes = Math.max(diff.patch_bytes, ...maker.patch_candidates.map((artifact) => artifact.length), 0);
    if (diff.blockers.length) return completedOrBlockedProof({ root: input.root, node, maker, checker, gate: emptyGate(), lease, worktree, diff, changedFiles, patchBytes, started, extraBlockers: diff.blockers });

    await updateLoopState(input.root, node.mission_id, node.loop_id, { current_phase: 'gates', last_checker_result: 'fresh_checker_passed' });
    if (await shouldCancel(input.root, node, iteration, 'gates')) return cancelledProof(input.root, node, started, lease, worktree, 'gates');
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_gate_started', status: 'running' });
    const gate = await runLoopGates({
      root: input.root,
      missionId: node.mission_id,
      node,
      gates: node.gates,
      checkerArtifacts: checker.checker_findings,
      cacheKey: JSON.stringify({
        base_revision: diff.base_revision,
        diff_sha256: diff.diff_sha256,
        changed_files: [...changedFiles].sort(),
        checker_artifacts: [...checker.checker_findings].sort()
      })
    });
    await appendLoopRunLog(input.root, node.mission_id, node.loop_id, { event_type: 'loop_gate_completed', status: gate.ok ? 'completed' : 'blocked' });
    return completedOrBlockedProof({ root: input.root, node, maker, checker, gate, lease, worktree, diff, changedFiles, patchBytes, started, extraBlockers: [] });
  } catch (err: unknown) {
    return blockedProof(input.root, node, [`loop_runtime_exception:${err instanceof Error ? err.message : String(err)}`], started, 'runtime_exception', 'failed', lease, worktree);
  } finally {
    if (lease?.status === 'active') await releaseLoopLease(input.root, node.mission_id, node.loop_id).catch(() => undefined);
  }
}

async function completedOrBlockedProof(input: {
  root: string;
  node: SksLoopNode;
  maker: LoopWorkerRunResult;
  checker: LoopWorkerRunResult;
  gate: SksLoopProof['gate_result'] & { blockers?: string[] };
  lease: SksLoopLease;
  worktree: LoopWorktreeRecord;
  diff: LoopDiffSummary;
  changedFiles: string[];
  patchBytes: number;
  started: number;
  extraBlockers: string[];
}): Promise<SksLoopProof> {
  const blockers = [
    ...input.extraBlockers,
    ...(input.gate.blockers || []),
    ...(input.node.risk.requires_human_handoff ? ['human_handoff_required'] : [])
  ];
  const status = blockers.length ? (input.node.risk.requires_human_handoff ? 'handoff' : 'blocked') : 'completed';
  const proof = buildProof({
    node: input.node,
    status,
    started: input.started,
    maker: input.maker,
    checker: input.checker,
    gate: input.gate,
    lease: input.lease,
    worktree: input.worktree,
    changedFiles: input.changedFiles,
    patchBytes: input.patchBytes,
    blockers
  });
  await writeProofAndState(input.root, proof);
  return proof;
}

async function workerBlockedProof(root: string, node: SksLoopNode, maker: LoopWorkerRunResult, checker: LoopWorkerRunResult | null, started: number, reason: string, lease: SksLoopLease, worktree: LoopWorktreeRecord): Promise<SksLoopProof> {
  const blockers = [...maker.blockers, ...(checker?.blockers || []), reason];
  const proof = buildProof({
    node,
    status: 'blocked',
    started,
    maker,
    checker: checker || emptyWorker(node, 'checker'),
    gate: emptyGate(),
    lease,
    worktree,
    changedFiles: maker.changed_files,
    patchBytes: 0,
    blockers
  });
  await writeProofAndState(root, proof);
  return proof;
}

async function cancelledProof(root: string, node: SksLoopNode, started: number, lease: SksLoopLease, worktree: LoopWorktreeRecord, phase: string): Promise<SksLoopProof> {
  await checkpointCancelledLoop(root, node, 1, phase);
  const proof = buildProof({
    node,
    status: 'cancelled',
    started,
    maker: emptyWorker(node, 'maker'),
    checker: emptyWorker(node, 'checker'),
    gate: emptyGate(),
    lease,
    worktree,
    changedFiles: [],
    patchBytes: 0,
    blockers: [`loop_cancelled:${phase}`]
  });
  await writeProofAndState(root, proof);
  return proof;
}

async function blockedProof(root: string, node: SksLoopNode, blockers: string[], started: number, reason: string, status: 'blocked' | 'failed' | 'handoff' = 'handoff', lease?: SksLoopLease | null, worktree?: LoopWorktreeRecord | null): Promise<SksLoopProof> {
  const proof = buildProof({
    node,
    status,
    started,
    maker: emptyWorker(node, 'maker'),
    checker: emptyWorker(node, 'checker'),
    gate: emptyGate(),
    lease: lease || null,
    worktree: worktree || null,
    changedFiles: [],
    patchBytes: 0,
    blockers: [...blockers, reason]
  });
  await writeProofAndState(root, proof);
  return proof;
}

function buildProof(input: {
  node: SksLoopNode;
  status: SksLoopProof['status'];
  started: number;
  maker: LoopWorkerRunResult;
  checker: LoopWorkerRunResult;
  gate: SksLoopProof['gate_result'] & { blockers?: string[] };
  lease: SksLoopLease | null;
  worktree: LoopWorktreeRecord | null;
  changedFiles: string[];
  patchBytes: number;
  blockers: string[];
}): SksLoopProof {
  const handoffRequired = input.status === 'handoff';
  return {
    schema: 'sks.loop-proof.v1',
    mission_id: input.node.mission_id,
    loop_id: input.node.loop_id,
    status: input.status,
    iterations: 1,
    owner_scope: input.node.owner_scope,
    worktree: {
      id: input.worktree?.worktree_id || input.lease?.worktree_id || null,
      path: input.worktree?.path || null,
      branch: input.worktree?.branch || null
    },
    maker_result: {
      ok: input.maker.ok,
      worker_count: input.maker.worker_count,
      artifacts: input.maker.artifacts,
      patch_candidates: input.maker.patch_candidates,
      backend: input.maker.backend,
      changed_files: input.maker.changed_files,
      runtime_proof_path: input.maker.runtime_proof_path
    },
    checker_result: {
      ok: input.checker.ok,
      worker_count: input.checker.worker_count,
      artifacts: input.checker.artifacts,
      checker_findings: input.checker.checker_findings,
      blockers: input.checker.blockers,
      backend: input.checker.backend,
      fresh_session: input.checker.session_ids.every((session) => !input.maker.session_ids.includes(session)),
      runtime_proof_path: input.checker.runtime_proof_path
    },
    gate_result: input.gate,
    budget: {
      used: {
        wall_ms: Math.max(1, Date.now() - input.started),
        model_calls: input.node.route === '$Integration' ? 1 : 2,
        subagents: input.maker.worker_count + input.checker.worker_count,
        iterations: 1,
        changed_files: input.changedFiles.length,
        patch_bytes: input.patchBytes
      },
      max: input.node.budget
    },
    changed_files: input.changedFiles,
    patch_bytes: input.patchBytes,
    handoff: {
      required: handoffRequired,
      reason: handoffRequired ? input.blockers.join(',') : null,
      artifact: handoffRequired ? `${input.node.loop_id}/handoff.md` : null
    },
    blockers: [...new Set(input.blockers)]
  };
}

async function writeProofAndState(root: string, proof: SksLoopProof): Promise<void> {
  await writeJsonAtomic(loopProofPath(root, proof.mission_id, proof.loop_id), proof);
  await updateLoopState(root, proof.mission_id, proof.loop_id, {
    status: proof.status,
    current_phase: proof.status === 'completed' ? 'finalizer' : 'handoff',
    last_gate_result: proof.gate_result.ok ? 'passed' : 'blocked',
    blockers: proof.blockers,
    handoff: proof.handoff,
    budget_used: proof.budget.used
  });
  await appendLoopRunLog(root, proof.mission_id, proof.loop_id, { event_type: proof.status === 'completed' ? 'loop_completed' : 'loop_blocked', status: proof.status });
}

async function shouldCancel(root: string, node: SksLoopNode, iteration: number, phase: string): Promise<boolean> {
  if (!(await shouldKillLoop(root, node.mission_id, node.loop_id))) return false;
  await checkpointCancelledLoop(root, node, iteration, phase);
  return true;
}

async function checkpoint(root: string, node: SksLoopNode, iteration: number, phase: string, resumable: boolean): Promise<void> {
  await writeLoopCheckpoint({
    root,
    mission_id: node.mission_id,
    loop_id: node.loop_id,
    iteration,
    phase,
    state_path: loopStatePath(root, node.mission_id, node.loop_id),
    proof_path: loopProofPath(root, node.mission_id, node.loop_id),
    resumable
  });
}

function emptyWorker(node: SksLoopNode, phase: 'maker' | 'checker'): LoopWorkerRunResult {
  return {
    schema: 'sks.loop-worker-run-result.v1',
    ok: false,
    mission_id: node.mission_id,
    loop_id: node.loop_id,
    phase,
    worker_count: 0,
    backend: 'mock',
    artifacts: [],
    patch_candidates: [],
    checker_findings: [],
    changed_files: [],
    blockers: [],
    runtime_proof_path: null,
    worker_ids: [],
    session_ids: []
  };
}

function emptyGate(): SksLoopProof['gate_result'] & { blockers: string[] } {
  return { ok: false, selected_gates: [], passed_gates: [], failed_gates: [], skipped_gates: [], blockers: [] };
}

function emptyDiff(): LoopDiffSummary {
  return { changed_files: [], patch_bytes: 0, diff_stat: '', base_revision: null, diff_sha256: 'sha256:empty', blockers: [] };
}
