import { writeJsonAtomic } from '../fsx.js';
import { decomposeRequestIntoLoopDomains } from './loop-decomposer.js';
import { loopPlanPath, loopRunLogPath, loopStatePath } from './loop-artifacts.js';
import { selectLoopGates } from './loop-gate-selector.js';
import { inferLoopOwnerScope } from './loop-owner-inference.js';
import { classifyLoopRisk } from './loop-risk-classifier.js';
import { defaultLoopBudget, validateLoopPlan, type SksLoopNode, type SksLoopPlan } from './loop-schema.js';
import { readInitDeepMemory, readInitDeepMemoryHints, type InitDeepMemoryHint } from '../codex-app/codex-init-deep.js';

export async function planLoopsFromRequest(input: {
  root: string;
  missionId: string;
  request: string;
  sourceCommand: 'goal' | 'loop' | 'naruto' | 'qa-loop' | 'research';
  mode?: 'deterministic' | 'codex-assisted';
  maxLoops?: number;
  parallelism?: 'safe' | 'balanced' | 'extreme';
}): Promise<SksLoopPlan> {
  const parallelism = input.parallelism || 'safe';
  const maxLoops = Math.max(1, Math.min(32, input.maxLoops || 8));
  const allDomains = decomposeRequestIntoLoopDomains(input.request);
  const domains = allDomains.slice(0, maxLoops);
  const domainsTruncated = allDomains.slice(maxLoops).map((domain) => domain.id);
  const actionNodes = domains.map((domain): SksLoopNode => {
    const loopId = `loop-${domain.id}`;
    const ownerScope = inferLoopOwnerScope({ domain });
    const risk = classifyLoopRisk({ loop_id: loopId, owner_scope: ownerScope, level: 'L2-action' });
    const nodeBase = makeNode({
      missionId: input.missionId,
      loopId,
      title: titleFromDomain(domain.id),
      purpose: `Execute ${domain.id} slice for: ${input.request}`,
      ownerScope,
      dependencies: [],
      route: domain.id === 'docs' ? '$Loop' : '$Naruto',
      level: domain.id === 'docs' ? 'L1-assisted' : 'L2-action',
      risk,
      parallelism
    });
    return { ...nodeBase, gates: selectLoopGates({ node: nodeBase, changedFiles: [...ownerScope.files, ...ownerScope.directories], risk }) };
  });
  const integrationOwner = inferLoopOwnerScope({ domain: { id: 'integration', dirs: [], files: [], gates: ['release:dag-full-coverage'], covers_work_order_items: [] }, integration: true });
  const integrationRisk = classifyLoopRisk({ loop_id: 'loop-integration', owner_scope: integrationOwner, level: 'L1-assisted' });
  const integrationBase = makeNode({
    missionId: input.missionId,
    loopId: 'loop-integration',
    title: 'Integration loop finalizer',
    purpose: 'Merge loop proofs, run integration gates, and require GPT final arbitration when source mutation exists.',
    ownerScope: integrationOwner,
    dependencies: actionNodes.map((node) => node.loop_id),
    route: '$Integration',
    level: 'L1-assisted',
    risk: integrationRisk,
    parallelism
  });
  const integrationNode = {
    ...integrationBase,
    gates: selectLoopGates({
      node: integrationBase,
      changedFiles: ['package.json', 'release-gates.v2.json', 'CHANGELOG.md'],
      risk: integrationRisk,
      packageScriptsChanged: ['loop:runtime'],
      releaseGateIdsChanged: ['release:dag-full-coverage']
    })
  };
  const nodes = [...actionNodes, integrationNode];
  const memoryHints = await readInitDeepMemoryHints(input.root, scopePathsForNodes(nodes)).catch(() => []);
  const nodesWithMemory = nodes.map((node) => {
    const hints = memoryHints.filter((hint) => hintAppliesToNode(hint, node)).slice(0, 5);
    return {
      ...node,
      ...(hints.length ? { memory_hints: hints } : {}),
      memory_hints_used: hints,
      memory_did_not_expand_scope: true as const
    };
  });
  const plan: SksLoopPlan = {
    schema: 'sks.loop-plan.v1',
    mission_id: input.missionId,
    request: input.request,
    generated_at: new Date().toISOString(),
    planner: {
      route: '$Loop',
      model_policy: input.mode === 'codex-assisted' ? 'codex-sdk' : 'deterministic',
      confidence: actionNodes.length ? 'high' : 'medium'
    },
    graph: {
      nodes: nodesWithMemory,
      edges: actionNodes.map((node) => ({ from: node.loop_id, to: integrationNode.loop_id, reason: 'integration_after_loop_proof' }))
    },
    global_budget: defaultLoopBudget({
      max_iterations: Math.max(...nodesWithMemory.map((node) => node.budget.max_iterations)),
      max_subagents: nodesWithMemory.reduce((sum, node) => sum + node.budget.max_subagents, 0)
    }),
    safety: {
      no_unrequested_fallback_code: true,
      require_owner_lease: true,
      require_checker_for_action: true,
      require_gpt_final_for_source_mutation: true
    },
    integration_loop_id: integrationNode.loop_id,
    compatibility: {
      goal_compat_artifact: input.sourceCommand === 'goal' ? `.sneakoscope/missions/${input.missionId}/goal-compat.json` : null,
      source_command: input.sourceCommand
    },
    blockers: [],
    domains_truncated: domainsTruncated,
    unassigned_work_order_items: [...domainsTruncated]
  };
  const projectMemory = await readInitDeepMemory(input.root).catch(() => null);
  if (projectMemory) {
    plan.project_memory = {
      source: projectMemory.path,
      injected: true,
      summary: projectMemory.text.split(/\r?\n/).filter((line) => /^##\s+/.test(line)).slice(0, 8),
      memory_did_not_expand_scope: true
    };
  }
  const validation = validateLoopPlan(plan);
  plan.blockers = validation.blockers;
  await writeJsonAtomic(loopPlanPath(input.root, input.missionId), plan);
  return plan;
}

function makeNode(input: {
  missionId: string;
  loopId: string;
  title: string;
  purpose: string;
  ownerScope: SksLoopNode['owner_scope'];
  dependencies: string[];
  route: SksLoopNode['route'];
  level: SksLoopNode['level'];
  risk: SksLoopNode['risk'];
  parallelism: 'safe' | 'balanced' | 'extreme';
}): SksLoopNode {
  const makerWorkerCount = dynamicMakerWorkerCount(input);
  const checkerWorkerCount = dynamicCheckerWorkerCount(input);
  const budget = defaultLoopBudget({
    max_subagents: input.route === '$Integration' ? 2 : Math.max(4, makerWorkerCount + checkerWorkerCount + 1),
    max_changed_files: input.ownerScope.files.length ? Math.max(4, input.ownerScope.files.length + 2) : 12
  });
  return {
    schema: 'sks.loop-node.v1',
    loop_id: input.loopId,
    mission_id: input.missionId,
    title: input.title,
    purpose: input.purpose,
    level: input.level,
    route: input.route,
    owner_scope: input.ownerScope,
    state_file: loopStatePath('', input.missionId, input.loopId).replace(/^\/?/, ''),
    run_log_file: loopRunLogPath('', input.missionId, input.loopId).replace(/^\/?/, ''),
    budget,
    maker: {
      route: '$Naruto',
      role: input.route === '$Integration' ? 'planner' : input.loopId.includes('docs') ? 'writer' : 'implementer',
      worker_count: makerWorkerCount,
      backend_preference: ['codex-sdk', 'python-codex-sdk'],
      local_draft_allowed: input.risk.level !== 'critical',
      gpt_final_required: input.risk.requires_gpt_final
    },
    checker: {
      route: input.loopId.includes('research') ? '$Research' : input.loopId.includes('docs') ? '$DFix' : '$QA-LOOP',
      worker_count: checkerWorkerCount,
      fresh_session_required: true,
      stronger_model_required: input.risk.level === 'high' || input.risk.level === 'critical',
      required_before_next_iteration: input.level === 'L2-action'
    },
    gates: { triage: [], local: [], checker: [], integration: [], final: [] },
    dependencies: input.dependencies,
    handoff_policy: {
      allow_handoff: true,
      reasons: input.risk.requires_human_handoff ? ['critical_risk_requires_handoff'] : [],
      artifact: null
    },
    worktree: {
      required: input.risk.requires_worktree,
      mode: input.risk.requires_worktree ? 'new-worktree' : 'none',
      branch_prefix: `sks/loop/${input.missionId}`,
      cleanup: input.risk.level === 'low' ? 'on-success' : 'keep-on-failure'
    },
    risk: input.risk
  };
}

// Maker parallelism scales with the loop's owned scope instead of a flat 2:
// Naruto can fan out far wider, and a fixed count starved wide scopes while
// over-provisioning single-file loops. Risk still clamps the ceiling so
// critical work cannot stampede, and 'safe' mode keeps the old behavior.
function dynamicMakerWorkerCount(input: {
  route: SksLoopNode['route'];
  ownerScope: SksLoopNode['owner_scope'];
  risk: SksLoopNode['risk'];
  parallelism: 'safe' | 'balanced' | 'extreme';
}): number {
  if (input.route === '$Integration') return 1;
  const scopeSize = input.ownerScope.files.length + input.ownerScope.directories.length * 3;
  const modeCap = input.parallelism === 'safe' ? 2 : input.parallelism === 'extreme' ? 8 : 6;
  const riskCap = input.risk.level === 'critical' ? 2 : modeCap;
  const riskFloor = input.risk.level === 'high' ? 3 : 2;
  const scopeScaled = Math.max(riskFloor, Math.ceil(scopeSize / 3));
  return Math.max(1, Math.min(modeCap, riskCap, scopeScaled));
}

// Checker workers are read-only GPT review lanes. They scale more conservatively
// than makers, but wide/high-risk owner scopes get more than one fresh reviewer.
function dynamicCheckerWorkerCount(input: {
  route: SksLoopNode['route'];
  ownerScope: SksLoopNode['owner_scope'];
  risk: SksLoopNode['risk'];
  parallelism: 'safe' | 'balanced' | 'extreme';
}): number {
  if (input.route === '$Integration') return 1;
  const scopeSize = input.ownerScope.files.length + input.ownerScope.directories.length * 3;
  const modeCap = input.parallelism === 'safe' ? 1 : input.parallelism === 'extreme' ? 4 : 3;
  const riskFloor = input.risk.level === 'high' || input.risk.level === 'critical' ? 2 : 1;
  const riskCap = input.risk.level === 'critical' ? Math.min(2, modeCap) : modeCap;
  const scopeScaled = Math.max(riskFloor, Math.ceil(scopeSize / 6));
  return Math.max(1, Math.min(modeCap, riskCap, scopeScaled));
}

function titleFromDomain(domainId: string): string {
  return domainId === 'loop-general-coding' ? 'General coding loop' : `${domainId} loop`;
}

function scopePathsForNodes(nodes: SksLoopNode[]): string[] {
  return nodes.flatMap((node) => [
    ...node.owner_scope.files,
    ...node.owner_scope.directories
  ]).filter(Boolean);
}

function hintAppliesToNode(hint: InitDeepMemoryHint, node: SksLoopNode): boolean {
  if (hint.scope === '.') return true;
  const scopes = [...node.owner_scope.files, ...node.owner_scope.directories].map((value) => value.replace(/^\.?\//, ''));
  return scopes.some((scope) => scope === hint.scope || scope.startsWith(`${hint.scope}/`) || hint.scope.startsWith(`${scope}/`));
}
