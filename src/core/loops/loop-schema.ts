export type SksLoopLevel = 'L0-report' | 'L1-assisted' | 'L2-action' | 'L3-unattended';
export type SksLoopStatus = 'planned' | 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'handoff' | 'cancelled';
export type SksLoopRole = 'triage' | 'maker' | 'checker' | 'integrator' | 'finalizer';

export interface SksLoopOwnerScope {
  files: string[];
  directories: string[];
  package_scripts: string[];
  release_gate_ids: string[];
  exclusive: boolean;
  collision_policy: 'skip' | 'wait' | 'handoff' | 'integration-only';
}

export interface SksLoopBudget {
  max_iterations: number;
  max_wall_ms: number;
  max_model_calls: number;
  max_subagents: number;
  max_tokens_estimate: number;
  max_changed_files: number;
  max_patch_bytes: number;
}

export interface SksLoopRisk {
  level: 'low' | 'medium' | 'high' | 'critical';
  reasons: string[];
  requires_worktree: boolean;
  requires_gpt_final: boolean;
  requires_human_handoff: boolean;
}

export interface SksLoopAgentPolicy {
  route: '$Naruto';
  role: 'implementer' | 'researcher' | 'fixer' | 'writer' | 'planner';
  worker_count: number;
  backend_preference: Array<'codex-sdk' | 'python-codex-sdk'>;
  local_draft_allowed: boolean;
  gpt_final_required: boolean;
}

export interface SksLoopCheckerPolicy {
  route: '$QA-LOOP' | '$DFix' | '$Research';
  worker_count: number;
  fresh_session_required: boolean;
  stronger_model_required: boolean;
  required_before_next_iteration: boolean;
}

export interface SksLoopGatePlan {
  triage: string[];
  local: string[];
  checker: string[];
  integration: string[];
  final: string[];
}

export interface SksLoopHandoffPolicy {
  allow_handoff: boolean;
  reasons: string[];
  artifact: string | null;
}

export interface SksLoopWorktreePolicy {
  required: boolean;
  mode: 'none' | 'reuse-existing' | 'new-worktree';
  branch_prefix: string;
  cleanup: 'on-success' | 'keep-on-failure' | 'always-keep';
}

export interface SksLoopMemoryHint {
  path: string;
  scope: string;
  summary: string;
}

export interface SksLoopNode {
  schema: 'sks.loop-node.v1';
  loop_id: string;
  mission_id: string;
  title: string;
  purpose: string;
  level: SksLoopLevel;
  route: '$Naruto' | '$QA-LOOP' | '$Research' | '$DFix' | '$Loop' | '$Integration';
  owner_scope: SksLoopOwnerScope;
  state_file: string;
  run_log_file: string;
  budget: SksLoopBudget;
  maker: SksLoopAgentPolicy;
  checker: SksLoopCheckerPolicy;
  gates: SksLoopGatePlan;
  dependencies: string[];
  handoff_policy: SksLoopHandoffPolicy;
  worktree: SksLoopWorktreePolicy;
  risk: SksLoopRisk;
  memory_hints?: SksLoopMemoryHint[];
  memory_hints_used?: SksLoopMemoryHint[];
  memory_did_not_expand_scope?: true;
}

export interface SksLoopPlan {
  schema: 'sks.loop-plan.v1';
  mission_id: string;
  request: string;
  generated_at: string;
  planner: {
    route: '$Loop';
    model_policy: 'deterministic' | 'codex-sdk' | 'gpt-assisted';
    confidence: 'low' | 'medium' | 'high';
  };
  graph: {
    nodes: SksLoopNode[];
    edges: Array<{ from: string; to: string; reason: string }>;
  };
  global_budget: SksLoopBudget;
  safety: SksLoopSafetyPolicy;
  integration_loop_id: string;
  compatibility: {
    goal_compat_artifact: string | null;
    source_command: 'goal' | 'loop' | 'naruto' | 'qa-loop' | 'research';
  };
  blockers: string[];
  domains_truncated?: string[];
  unassigned_work_order_items?: string[];
  project_memory?: {
    source: string;
    injected: boolean;
    summary: string[];
    memory_did_not_expand_scope?: true;
  };
  integration_merge?: {
    ok: boolean;
    artifact_path?: string;
    applied_loops?: string[];
    conflict_loops?: string[];
    strategy_summary?: Record<string, number>;
  };
  gpt_final_arbiter?: {
    ok: boolean;
    artifact_path?: string;
    verdict?: string;
    gate_contract_path?: string;
    handled_by?: 'loop-finalizer';
  };
  side_effect_report?: {
    ok: boolean;
    artifact_path?: string;
    blockers?: string[];
  };
}

export interface SksLoopSafetyPolicy {
  no_unrequested_fallback_code: boolean;
  require_owner_lease: boolean;
  require_checker_for_action: boolean;
  require_gpt_final_for_source_mutation: boolean;
}

export interface SksLoopState {
  schema: 'sks.loop-state.v1';
  mission_id: string;
  loop_id: string;
  status: SksLoopStatus;
  iteration: number;
  acting_on: {
    files: string[];
    worktree_id: string | null;
    branch: string | null;
  };
  current_phase: 'triage' | 'maker' | 'checker' | 'gates' | 'integration' | 'finalizer' | 'handoff';
  last_action: string | null;
  last_gate_result: string | null;
  last_checker_result: string | null;
  blockers: string[];
  handoff: {
    required: boolean;
    reason: string | null;
    artifact: string | null;
  };
  budget_used: {
    wall_ms: number;
    model_calls: number;
    subagents: number;
    iterations: number;
    changed_files: number;
    patch_bytes: number;
  };
  updated_at: string;
}

export interface SksLoopProof {
  schema: 'sks.loop-proof.v1';
  mission_id: string;
  loop_id: string;
  status: SksLoopStatus;
  iterations: number;
  owner_scope: SksLoopOwnerScope;
  worktree: {
    id: string | null;
    path: string | null;
    branch: string | null;
  };
  maker_result: {
    ok: boolean;
    worker_count: number;
    artifacts: string[];
    patch_candidates: string[];
    backend?: string;
    changed_files?: string[];
    runtime_proof_path?: string | null;
  };
  checker_result: {
    ok: boolean;
    worker_count: number;
    artifacts: string[];
    blockers: string[];
    backend?: string;
    checker_findings?: string[];
    fresh_session?: boolean;
    runtime_proof_path?: string | null;
  };
  gate_result: {
    ok: boolean;
    selected_gates: string[];
    passed_gates: string[];
    failed_gates: string[];
    skipped_gates: string[];
    blockers?: string[];
  };
  budget: {
    used: SksLoopState['budget_used'];
    max: SksLoopBudget;
  };
  changed_files: string[];
  patch_bytes: number;
  handoff: SksLoopState['handoff'];
  blockers: string[];
  integration_merge?: {
    ok: boolean;
    artifact_path?: string;
    applied_loops?: string[];
    conflict_loops?: string[];
    strategy_summary?: Record<string, number>;
  };
  gpt_final_arbiter?: {
    ok: boolean;
    artifact_path?: string;
    verdict?: string;
    gate_contract_path?: string;
    handled_by?: 'loop-finalizer';
  };
  side_effect_report?: {
    ok: boolean;
    artifact_path?: string;
    blockers?: string[];
  };
}

export interface SksLoopGraphProof {
  schema: 'sks.loop-graph-proof.v1';
  mission_id: string;
  ok: boolean;
  total_loops: number;
  completed_loops: number;
  blocked_loops: number;
  failed_loops: number;
  handoff_loops: number;
  parallelism: {
    max_active_loops: number;
    max_active_workers: number;
    wall_ms: number;
    sequential_estimate_ms: number;
    speedup_ratio: number;
  };
  gates: {
    selected: string[];
    passed: string[];
    failed: string[];
    skipped: string[];
  };
  blockers: string[];
  integration_merge?: {
    ok: boolean;
    artifact_path?: string;
    applied_loops?: string[];
    conflict_loops?: string[];
    strategy_summary?: Record<string, number>;
  };
  gpt_final_arbiter?: {
    ok: boolean;
    artifact_path?: string;
    verdict?: string;
    gate_contract_path?: string;
    handled_by?: 'loop-finalizer';
  };
  side_effect_report?: {
    ok: boolean;
    artifact_path?: string;
    blockers?: string[];
  };
}

export interface SksLoopGraphResult {
  ok: boolean;
  mission_id: string;
  proofs: SksLoopProof[];
  graph_proof: SksLoopGraphProof;
  blockers: string[];
}

export function defaultLoopBudget(overrides: Partial<SksLoopBudget> = {}): SksLoopBudget {
  return {
    max_iterations: 2,
    max_wall_ms: 15 * 60 * 1000,
    max_model_calls: 8,
    max_subagents: 4,
    max_tokens_estimate: 120000,
    max_changed_files: 16,
    max_patch_bytes: 256000,
    ...overrides
  };
}

export function validateLoopPlan(plan: SksLoopPlan): { ok: boolean; blockers: string[] } {
  const blockers = [
    ...(plan.schema !== 'sks.loop-plan.v1' ? ['loop_plan_schema_invalid'] : []),
    ...(!plan.mission_id ? ['loop_plan_mission_id_missing'] : []),
    ...(!plan.request ? ['loop_plan_request_missing'] : []),
    ...(!plan.integration_loop_id ? ['loop_plan_integration_loop_missing'] : []),
    ...(plan.graph.nodes.length === 0 ? ['loop_plan_nodes_missing'] : []),
    ...(!plan.graph.nodes.some((node) => node.loop_id === plan.integration_loop_id) ? ['loop_plan_integration_node_missing'] : [])
  ];
  const ids = new Set<string>();
  for (const node of plan.graph.nodes) {
    const result = validateLoopNode(node);
    blockers.push(...result.blockers);
    if (ids.has(node.loop_id)) blockers.push(`loop_node_duplicate:${node.loop_id}`);
    ids.add(node.loop_id);
  }
  for (const edge of plan.graph.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) blockers.push(`loop_edge_unknown:${edge.from}->${edge.to}`);
  }
  return { ok: blockers.length === 0, blockers };
}

export function validateLoopNode(node: SksLoopNode): { ok: boolean; blockers: string[] } {
  const blockers = [
    ...(node.schema !== 'sks.loop-node.v1' ? [`loop_node_schema_invalid:${node.loop_id}`] : []),
    ...(!node.loop_id ? ['loop_node_id_missing'] : []),
    ...(!node.mission_id ? [`loop_node_mission_missing:${node.loop_id}`] : []),
    ...(!node.state_file ? [`loop_state_file_missing:${node.loop_id}`] : []),
    ...(!node.run_log_file ? [`loop_run_log_file_missing:${node.loop_id}`] : []),
    ...(!node.owner_scope ? [`loop_owner_scope_missing:${node.loop_id}`] : []),
    ...validateLoopBudget(node.budget).blockers.map((blocker) => `${node.loop_id}:${blocker}`),
    ...(node.level === 'L3-unattended' && ['high', 'critical'].includes(node.risk.level) ? [`loop_l3_risk_blocked:${node.loop_id}`] : []),
    ...(node.level === 'L2-action' && !node.checker.required_before_next_iteration ? [`loop_action_checker_missing:${node.loop_id}`] : [])
  ];
  return { ok: blockers.length === 0, blockers };
}

export function validateLoopBudget(budget: SksLoopBudget): { ok: boolean; blockers: string[] } {
  const blockers: string[] = [];
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isFinite(value) || value < 0) blockers.push(`loop_budget_invalid:${key}`);
  }
  if (budget.max_iterations < 1) blockers.push('loop_budget_iterations_missing');
  return { ok: blockers.length === 0, blockers };
}

export function allGateIds(gates: SksLoopGatePlan): string[] {
  return [...new Set([...gates.triage, ...gates.local, ...gates.checker, ...gates.integration, ...gates.final])];
}
