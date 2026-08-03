import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNativeAgentOrchestrator } from '../agents/agent-orchestrator.js';
import { ensureDir, nowIso, readJson, runProcess, writeJsonAtomic } from '../fsx.js';
import type { NarutoWorkGraph, NarutoWorkItem } from '../naruto/naruto-work-item.js';
import type { SksLoopNode, SksLoopPlan } from './loop-schema.js';
import { loopNodeRoot } from './loop-artifacts.js';
import { computeLoopConcurrencyBudget, loopWorkerBudgetFor } from './loop-concurrency-budget.js';
import { decideLoopFixturePolicy, writeLoopFixturePolicyDecision, type LoopFixturePolicyDecision } from './loop-fixture-policy.js';
import { buildLoopCheckerPrompt, buildLoopMakerPrompt } from './loop-worker-prompts.js';
import { resolveCodexAppExecutionProfile } from '../codex-app/codex-app-execution-profile.js';
import type { CodexAppExecutionProfile } from '../codex-app/codex-app-types.js';
import { resolveCodexNativeInvocationPlan, type CodexNativeInvocationPlan } from '../codex-native/codex-native-invocation-router.js';

export interface LoopWorkerRunInput {
  root: string;
  plan: SksLoopPlan;
  node: SksLoopNode;
  phase: 'maker' | 'checker';
  worktree?: {
    id: string | null;
    path: string | null;
    branch: string | null;
  };
  /** Read-only execution (checker phase). Does NOT imply fixture mode. */
  noMutation?: boolean;
  /** Deterministic fixture run (test-only / gate checks). */
  fixture?: boolean;
  timeoutMs?: number;
  makerArtifacts?: string[];
}

export interface LoopWorkerRunResult {
  schema: 'sks.loop-worker-run-result.v1';
  ok: boolean;
  mission_id: string;
  loop_id: string;
  phase: 'maker' | 'checker';
  worker_count: number;
  backend: 'native-agent-orchestrator' | 'deterministic-fixture' | 'mock';
  artifacts: string[];
  patch_candidates: string[];
  checker_findings: string[];
  changed_files: string[];
  blockers: string[];
  runtime_proof_path: string | null;
  worker_ids: string[];
  session_ids: string[];
  codex_app_execution_profile?: Pick<CodexAppExecutionProfile, 'mode' | 'agent_role_strategy' | 'artifact_path' | 'agent_type_probe_artifact_path'>;
  codex_native_invocation_plan?: Pick<CodexNativeInvocationPlan, 'route' | 'desired_capability' | 'selected_strategy' | 'required_artifacts' | 'proof_policy' | 'env' | 'blockers' | 'warnings'>;
  fixture_policy?: LoopFixturePolicyDecision;
  fixture_allowed_reason?: string | null;
}

export async function runLoopMakerWorkers(input: Omit<LoopWorkerRunInput, 'phase'>): Promise<LoopWorkerRunResult> {
  return runLoopWorkers({ ...input, phase: 'maker' });
}

export async function runLoopCheckerWorkers(input: Omit<LoopWorkerRunInput, 'phase'>): Promise<LoopWorkerRunResult> {
  return runLoopWorkers({ ...input, phase: 'checker', noMutation: true });
}

async function runLoopWorkers(input: LoopWorkerRunInput): Promise<LoopWorkerRunResult> {
  if (shouldUseFixture(input)) return runLoopWorkerFixture(input);
  return runLoopWorkerNative(input);
}

// `noMutation` used to force fixture mode here, which silently turned EVERY
// checker run into a deterministic fixture (checkers always pass
// noMutation: true for read-only semantics) — real model verification never
// happened. Fixture mode is now an explicit, separate test-only signal.
function shouldUseFixture(input: LoopWorkerRunInput): boolean {
  const requested = input.fixture === true || process.env.SKS_LOOP_RUNTIME_FIXTURE === '1';
  if (!requested) return false;
  const decision = decideLoopFixturePolicy({
    root: input.root,
    missionId: input.plan.mission_id,
    mode: 'worker',
    requested
  });
  void writeLoopFixturePolicyDecision(input.root, input.plan.mission_id, decision).catch(() => undefined);
  if (!decision.allowed) {
    throw new Error(`loop_fixture_runtime_forbidden:${decision.reason}:${decision.blockers.join(',')}`);
  }
  return true;
}

async function runLoopWorkerNative(input: LoopWorkerRunInput): Promise<LoopWorkerRunResult> {
  const prompt = input.phase === 'maker'
    ? buildLoopMakerPrompt({ plan: input.plan, node: input.node, worktreePath: input.worktree?.path || null })
    : buildLoopCheckerPrompt({ plan: input.plan, node: input.node, makerArtifacts: input.makerArtifacts || [] });
  const workerCount = effectiveLoopWorkerCount(input);
  const executionProfile = await resolveCodexAppExecutionProfile({ root: input.root }).catch(() => null);
  const invocationPlan = await resolveCodexNativeInvocationPlan({
    root: input.root,
    missionId: input.plan.mission_id,
    route: '$Loop',
    desiredCapability: 'agent-role'
  }).catch(() => null);
  const workGraph = buildLoopNarutoWorkGraph(input, workerCount, executionProfile, invocationPlan);
  // Keep the orchestrator rooted in the main repository while each worker receives
  // its bounded worktree below. Native workers are process-based and need no UI placement.
  const orchestrator = await runNativeAgentOrchestrator({
    root: input.root,
    missionId: input.plan.mission_id,
    prompt,
    route: '$Naruto',
    backend: 'codex-sdk',
    readonly: input.phase === 'checker',
    workspaceWrite: input.phase === 'maker',
    // Bug fix: agents must be explicitly bounded to workerCount here. Without it,
    // buildAgentRoster()'s normalizeAgentCount() falls back to DEFAULT_AGENT_COUNT (5)
    // while maxAgentCount below is capped to workerCount, so any loop node with a
    // worker_count/max_subagents budget under 5 (the common case) threw
    // "Agent count 5 exceeds max N" instead of clamping to the smaller budget.
    agents: Math.max(1, workerCount),
    desiredWorkItemCount: workGraph.total_work_items,
    minimumWorkItems: 1,
    maxAgentCount: Math.max(1, workerCount),
    targetActiveSlots: Math.max(1, workerCount),
    narutoWorkGraph: workGraph,
    env: {
      SKS_LOOP_ID: input.node.loop_id,
      SKS_LOOP_PHASE: input.phase,
      SKS_LOOP_MAIN_ROOT: input.root,
      SKS_LOOP_WORKER_BUDGET: String(workerCount),
      SKS_CODEX_APP_EXECUTION_PROFILE: executionProfile?.mode || 'unknown',
      SKS_CODEX_AGENT_ROLE_STRATEGY: executionProfile?.agent_role_strategy || 'message-role',
      SKS_CODEX_NATIVE_STRATEGY: invocationPlan?.selected_strategy || 'message-role-fallback',
      SKS_CODEX_NATIVE_AGENT_ROLE_STRATEGY: invocationPlan?.env.SKS_CODEX_NATIVE_AGENT_ROLE_STRATEGY || executionProfile?.agent_role_strategy || 'message-role',
      SKS_CODEX_NATIVE_FEATURE_MATRIX: invocationPlan?.feature_matrix_artifact || '.sneakoscope/reports/codex-native-feature-matrix.json'
    },
    ...(input.worktree?.path ? {
      worktree: {
        id: input.worktree.id || `loop-${input.node.loop_id}-${input.phase}`,
        path: input.worktree.path,
        branch: input.worktree.branch || 'unknown',
        main_repo_root: input.root
      }
    } : {}),
    gitWorktreePolicy: input.worktree?.path ? {
      mode: 'patch-envelope-only',
      required: false,
      main_repo_root: input.root,
      worktree_root: input.worktree.path,
      fallback_reason: null
    } : null
  });
  return normalizeNativeResult(input, orchestrator, executionProfile, invocationPlan);
}

async function normalizeNativeResult(input: LoopWorkerRunInput, result: any, executionProfile: CodexAppExecutionProfile | null, invocationPlan: CodexNativeInvocationPlan | null): Promise<LoopWorkerRunResult> {
  const artifacts = collectArtifactPaths(result);
  const changedFiles = stringArray(result?.changed_files || result?.proof?.changed_files || result?.results?.flatMap?.((row: any) => row?.changed_files || []));
  const blockers = [
    ...(result?.ok === true ? [] : ['loop_worker_native_orchestrator_not_ok']),
    ...stringArray(result?.blockers || result?.proof?.blockers)
  ];
  const proofPath = path.join(loopNodeRoot(input.root, input.plan.mission_id, input.node.loop_id), input.phase, 'worker-runtime-result.json');
  const normalized: LoopWorkerRunResult = {
    schema: 'sks.loop-worker-run-result.v1',
    ok: blockers.length === 0,
    mission_id: input.plan.mission_id,
    loop_id: input.node.loop_id,
    phase: input.phase,
    worker_count: effectiveLoopWorkerCount(input),
    backend: 'native-agent-orchestrator',
    artifacts,
    patch_candidates: input.phase === 'maker' ? artifacts.filter((artifact) => artifact.includes('patch')) : [],
    checker_findings: input.phase === 'checker' ? artifacts.filter((artifact) => artifact.includes('checker') || artifact.includes('finding')) : [],
    changed_files: changedFiles,
    blockers: [...new Set(blockers)],
    runtime_proof_path: proofPath,
    worker_ids: stringArray(result?.results?.map?.((row: any) => row?.agent_id || row?.id)),
    session_ids: stringArray(result?.results?.map?.((row: any) => row?.session_id)),
    ...(executionProfile ? {
      codex_app_execution_profile: {
        mode: executionProfile.mode,
        agent_role_strategy: executionProfile.agent_role_strategy,
        artifact_path: executionProfile.artifact_path,
        agent_type_probe_artifact_path: executionProfile.agent_type_probe_artifact_path
      }
    } : {}),
    ...(invocationPlan ? {
      codex_native_invocation_plan: compactInvocationPlan(invocationPlan)
    } : {})
  };
  await writeJsonAtomic(proofPath, { ...normalized, native_result_summary: summarizeNativeResult(result), generated_at: nowIso() });
  return normalized;
}

async function runLoopWorkerFixture(input: LoopWorkerRunInput): Promise<LoopWorkerRunResult> {
  const fixturePolicy = decideLoopFixturePolicy({
    root: input.root,
    missionId: input.plan.mission_id,
    mode: 'worker',
    requested: true
  });
  const dir = path.join(loopNodeRoot(input.root, input.plan.mission_id, input.node.loop_id), input.phase);
  await ensureDir(dir);
  const invocationPlan = await resolveCodexNativeInvocationPlan({
    root: input.root,
    missionId: input.plan.mission_id,
    route: '$Loop',
    desiredCapability: 'agent-role'
  }).catch(() => null);
  const resultPath = path.join(dir, 'worker-runtime-result.json');
  const childInputPath = path.join(dir, 'worker-fixture-intake.json');
  await writeJsonAtomic(childInputPath, {
    schema: 'sks.loop-worker-fixture-intake.v1',
    root: input.root,
    mission_id: input.plan.mission_id,
    loop_id: input.node.loop_id,
    phase: input.phase,
    worker_count: input.phase === 'maker' ? input.node.maker.worker_count : input.node.checker.worker_count,
    result_path: resultPath,
    owner_scope: input.node.owner_scope,
    maker_artifacts: input.makerArtifacts || [],
    codex_native_invocation_plan: invocationPlan ? compactInvocationPlan(invocationPlan) : null
  });
  const child = await runProcess(process.execPath, [fixtureChildEntrypoint(), childInputPath], {
    cwd: input.root,
    timeoutMs: input.timeoutMs || 30000,
    maxOutputBytes: 64 * 1024
  });
  const result = await readJson<LoopWorkerRunResult | null>(resultPath, null);
  if (!result) {
    return {
      schema: 'sks.loop-worker-run-result.v1',
      ok: false,
      mission_id: input.plan.mission_id,
      loop_id: input.node.loop_id,
      phase: input.phase,
      worker_count: 0,
      backend: 'deterministic-fixture',
      artifacts: [],
      patch_candidates: [],
      checker_findings: [],
      changed_files: [],
      blockers: [`loop_worker_fixture_child_missing_result:${child.code}`],
      runtime_proof_path: resultPath,
      worker_ids: [],
      session_ids: [],
      fixture_policy: fixturePolicy,
      fixture_allowed_reason: fixturePolicy.allowed ? fixturePolicy.reason : null
    };
  }
  return {
    ...result,
    ok: result.ok && child.code === 0,
    blockers: [
      ...result.blockers,
      ...(child.code === 0 ? [] : [`loop_worker_fixture_child_exit:${child.code}`])
    ],
    fixture_policy: fixturePolicy,
    fixture_allowed_reason: fixturePolicy.allowed ? fixturePolicy.reason : null
  };
}

function buildLoopNarutoWorkGraph(input: LoopWorkerRunInput, workerCount: number, executionProfile: CodexAppExecutionProfile | null, invocationPlan: CodexNativeInvocationPlan | null): NarutoWorkGraph {
  const profilePayload = executionProfile ? {
    mode: executionProfile.mode,
    agent_role_strategy: executionProfile.agent_role_strategy,
    artifact_path: executionProfile.artifact_path,
    agent_type_probe_artifact_path: executionProfile.agent_type_probe_artifact_path
  } : undefined;
  const invocationPayload = invocationPlan ? compactInvocationPlan(invocationPlan) : undefined;
  const workItems: NarutoWorkItem[] = Array.from({ length: Math.max(1, workerCount) }, (_, index) => {
    const id = `${input.node.loop_id}-${input.phase}-${index + 1}`;
    const writeAllowed = input.phase === 'maker';
    return {
      id,
      kind: writeAllowed ? 'code_modification' : 'verification',
      title: `${input.phase} worker ${index + 1} for ${input.node.loop_id}`,
      target_paths: [...input.node.owner_scope.files, ...input.node.owner_scope.directories],
      readonly_paths: input.phase === 'checker' ? [...input.node.owner_scope.files, ...input.node.owner_scope.directories] : [],
      write_paths: writeAllowed ? [...input.node.owner_scope.files, ...input.node.owner_scope.directories] : [],
      required_role: input.phase,
      write_allowed: writeAllowed,
      verification_required: input.phase === 'checker',
      dependencies: [],
      can_run_in_parallel_with: [],
      conflicts_with: [],
      estimated_cost: { tokens: 8000, latency_ms: 30000, cpu_weight: 1, memory_mb: 512, gpu_weight: 0 },
      lease_requirements: input.node.owner_scope.files.map((file) => ({ path: file, kind: writeAllowed ? 'write' as const : 'read' as const })),
      acceptance: { requires_patch_envelope: writeAllowed, requires_verification: !writeAllowed, requires_gpt_final: input.node.risk.requires_gpt_final },
      owner: input.node.loop_id,
      allocation_reason: 'loop-worker-runtime',
      allocation_score: 1,
      allocation_hints: null,
      lane: input.phase,
      worktree: {
        mode: input.worktree?.path ? 'patch-envelope-only' : 'git-worktree',
        required: input.node.worktree.required,
        allocation_required: false
      },
      ...(profilePayload ? { codex_app_execution_profile: profilePayload } : {}),
      ...(invocationPayload ? { codex_native_invocation_plan: invocationPayload } : {})
    };
  });
  return {
    schema: 'sks.naruto-work-graph.v1',
    route: '$Naruto',
    requested_workers: workerCount,
    total_work_items: workItems.length,
    readonly: input.phase === 'checker',
    write_capable: input.phase === 'maker',
    work_items: workItems,
    active_waves: [{ wave_id: `${input.node.loop_id}-${input.phase}`, work_item_ids: workItems.map((item) => item.id), write_paths: workItems.flatMap((item) => item.write_paths), conflict_count: 0 }],
    mixed_work_kinds: [...new Set(workItems.map((item) => item.kind))],
    write_allowed_count: workItems.filter((item) => item.write_allowed).length,
    worktree_policy: {
      mode: input.worktree?.path ? 'patch-envelope-only' : 'git-worktree',
      required: input.node.worktree.required,
      main_repo_root: input.root,
      worktree_root: null,
      fallback_reason: input.worktree?.path ? 'loop_worktree_already_allocated' : null
    },
    ...(profilePayload ? { codex_app_execution_profile: profilePayload } : {}),
    ...(invocationPayload ? { codex_native_invocation_plan: invocationPayload } : {}),
    blockers: [],
    ok: true
  };
}

function compactInvocationPlan(plan: CodexNativeInvocationPlan): Pick<CodexNativeInvocationPlan, 'route' | 'desired_capability' | 'selected_strategy' | 'required_artifacts' | 'proof_policy' | 'env' | 'blockers' | 'warnings'> {
  return {
    route: plan.route,
    desired_capability: plan.desired_capability,
    selected_strategy: plan.selected_strategy,
    required_artifacts: plan.required_artifacts,
    proof_policy: plan.proof_policy,
    env: plan.env,
    blockers: plan.blockers,
    warnings: plan.warnings
  };
}

function collectArtifactPaths(result: any): string[] {
  return stringArray([
    result?.ledger_root,
    result?.proof?.artifact,
    ...(Array.isArray(result?.results) ? result.results.flatMap((row: any) => row?.artifacts || row?.patch_queue_refs || []) : [])
  ]);
}

function summarizeNativeResult(result: any): Record<string, unknown> {
  return {
    ok: result?.ok === true,
    status: result?.status || null,
    mission_id: result?.mission_id || null,
    backend: result?.backend || null,
    result_count: Array.isArray(result?.results) ? result.results.length : 0,
    blockers: stringArray(result?.blockers || result?.proof?.blockers).slice(0, 20)
  };
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flat().map((item) => String(item || '').trim()).filter(Boolean))];
}

function fixtureChildEntrypoint(): string {
  return fileURLToPath(new URL('../../scripts/loop-worker-fixture-child.js', import.meta.url));
}

function effectiveLoopWorkerCount(input: LoopWorkerRunInput): number {
  const requested = input.phase === 'maker' ? input.node.maker.worker_count : input.node.checker.worker_count;
  const budget = computeLoopConcurrencyBudget({ plan: input.plan });
  return loopWorkerBudgetFor(budget, input.node.loop_id, input.phase, requested);
}
