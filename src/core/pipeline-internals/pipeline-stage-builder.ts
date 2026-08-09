/** Extracted stage/lane builders to keep runtime-core under the 1800-line budget. */
import { SPEED_LANE_POLICY } from '../proof-field.js';
import { OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID } from '../agents/agent-schema.js';
import { normalizeOfficialSubagentPolicy, officialSubagentPipelineStage } from '../agents/agent-plan.js';
import { looksLikeCodeChangingWork, reflectionRequiredForRoute, routeRequiresSubagents } from '../routes.js';
import { classifyTaskProfile, type GateProfile, type TaskProfile } from '../runtime/task-profile.js';
import { type VerificationBudget } from '../runtime/verification-budget.js';

export const LIGHTWEIGHT_ROUTES = new Set(['Answer', 'DFix', 'Help', 'Wiki', 'Goal']);

export const BLOCKING_GATE_LIMITS = Object.freeze({
  passthrough: 0,
  answer: 0,
  'tiny-change': 1,
  'bounded-work': 2,
  'parallel-read': 2,
  'parallel-write': 3,
  'high-risk': 4
} satisfies Readonly<Record<TaskProfile, number>>);

function routeNeedsEngineeringSanityReview(route: any, task: any) {
  const id = String(route?.id || '');
  if (['DB', 'MadSKS'].includes(id)) return true;
  if (['Answer', 'Help', 'Wiki', 'Goal', 'Research', 'AutoResearch', 'PPT', 'ImageUXReview', 'ComputerUse', 'GX'].includes(id)) return false;
  return looksLikeCodeChangingWork(String(task || ''));
}
export const GATE_PROFILE_STAGES = Object.freeze({
  none: [],
  minimal: ['route_classification', 'listed_verification'],
  scoped: ['route_classification', 'ownership', 'listed_verification', 'honest_summary'],
  full: ['route_classification', 'ambiguity_gate', 'safety_gate', 'ownership', 'listed_verification', 'honest_summary']
} satisfies Readonly<Record<GateProfile, readonly string[]>>);

export const STAGE_BLOCKING_GATE = Object.freeze({
  ambiguity_gate: 'scope',
  safety_gate: 'safety',
  ssot_guard: 'safety',
  context7_evidence: 'safety',
  mistake_recall: 'safety',
  ownership: 'ownership',
  pipeline_plan: 'ownership',
  focused_implementation: 'ownership',
  triwiki_use_first: 'ownership',
  subagent_plan: 'ownership',
  official_subagent_execution: 'ownership',
  parent_integration: 'ownership',
  route_materialization: 'ownership',
  work_order_coverage: 'ownership',
  architecture_map_baseline: 'ownership',
  engineering_sanity_check: 'verification',
  listed_verification: 'verification',
  triwiki_validate_before_final: 'verification',
  architecture_map_review: 'verification',
  completion_proof: 'verification',
  reflection: 'verification',
  honest_summary: 'verification'
} satisfies Readonly<Record<string, 'scope' | 'safety' | 'ownership' | 'verification'>>);

export function selectPipelineLane(route: any, task: any, proof: any, taskProfile: TaskProfile = classifyTaskProfile(task)) {
  if (proof.attached && proof.lane) {
    return {
      lane: proof.lane,
      source: 'proof_field',
      fast_lane_allowed: Boolean(proof.fast_lane_allowed),
      reason: proof.fast_lane_allowed ? 'Proof Field allowed the fast lane.' : `Proof Field selected ${proof.lane}.`,
      blockers: proof.blockers || [],
      skip_when_fast: proof.fast_lane_allowed ? SPEED_LANE_POLICY.skip_when_fast : [],
      keep: proof.keep || SPEED_LANE_POLICY.always_keep
    };
  }
  if (taskProfile === 'passthrough' || taskProfile === 'answer') return { lane: 'no_pipeline', source: 'task_profile', fast_lane_allowed: true, reason: 'Light conversation does not create an execution pipeline.', blockers: [], skip_when_fast: [], keep: [] };
  if (route?.id === 'ComputerUse') return { lane: 'computer_use_fast_lane', source: 'route_policy', fast_lane_allowed: true, reason: 'Computer Use route is intentionally direct and defers wiki/honest checks to closeout.', blockers: [], skip_when_fast: ['planning_debate'], keep: ['focused_implementation', 'triwiki_validate_before_final', 'honest_mode'] };
  if (taskProfile === 'tiny-change') return { lane: 'minimal_change_lane', source: 'task_profile', fast_lane_allowed: true, reason: 'Tiny change uses one blocking gate and one focused check at most.', blockers: [], skip_when_fast: SPEED_LANE_POLICY.skip_when_fast, keep: ['listed_verification'] };
  if (LIGHTWEIGHT_ROUTES.has(route?.id)) return { lane: `${String(route.id).toLowerCase()}_lightweight_lane`, source: 'route_policy', fast_lane_allowed: true, reason: 'Lightweight route bypasses full mission orchestration by design.', blockers: [], skip_when_fast: SPEED_LANE_POLICY.skip_when_fast, keep: ['focused_implementation', 'listed_verification', 'honest_mode'] };
  if (routeRequiresSubagents(route, task, taskProfile)) return { lane: 'official_subagent_lane', source: 'task_profile', fast_lane_allowed: false, reason: 'Explicit Naruto or parallel work uses the Codex subagent workflow.', blockers: [], skip_when_fast: [], keep: ['subagent_plan', 'official_subagent_execution', 'parent_integration', 'listed_verification', 'honest_summary'] };
  if (taskProfile === 'high-risk') return { lane: SPEED_LANE_POLICY.full_lane, source: 'task_profile', fast_lane_allowed: false, reason: 'High-risk work uses the full risk gate profile.', blockers: [], skip_when_fast: [], keep: SPEED_LANE_POLICY.always_keep };
  return { lane: SPEED_LANE_POLICY.balanced_lane, source: 'route_policy', fast_lane_allowed: false, reason: 'Balanced parent-owned route until Proof Field proves a narrower lane.', blockers: ['proof_field_not_attached'], skip_when_fast: [], keep: SPEED_LANE_POLICY.always_keep };
}

export function buildPipelineStages(
  route: any,
  task: any,
  taskProfile: TaskProfile,
  gateProfile: GateProfile,
  ambiguity: any,
  lane: any,
  context7Required: any,
  officialSubagentPolicy: any = normalizeOfficialSubagentPolicy(route, task, {})
) {
  if (gateProfile === 'none') return [];
  const ids: string[] = [...GATE_PROFILE_STAGES[gateProfile]];
  const specializedRoute = Boolean(route?.id && !LIGHTWEIGHT_ROUTES.has(route.id) && route.id !== 'SKS');
  if (gateProfile === 'scoped' || gateProfile === 'full' || specializedRoute) ids.push('pipeline_plan', 'focused_implementation');
  if ((gateProfile === 'full' || specializedRoute) && !ids.includes('ssot_guard')) ids.push('ssot_guard');
  if (context7Required) ids.push('context7_evidence');
  if ((gateProfile === 'scoped' || gateProfile === 'full') && !LIGHTWEIGHT_ROUTES.has(route?.id)) {
    ids.push('triwiki_use_first', 'triwiki_validate_before_final', 'mistake_recall', 'work_order_coverage');
  }
  if (routeNeedsEngineeringSanityReview(route, task)) ids.push('engineering_sanity_check');
  // Architecture Map stages reuse ownership/verification buckets (no BLOCKING_GATE_LIMITS bump).
  // Answer/Help/DFix/Wiki/Goal/GX/DB exempt — same collision surface as engineering_sanity / GX tiny-change.
  if ((gateProfile === 'scoped' || gateProfile === 'full') && route?.id !== 'GX' && route?.id !== 'DB' && !LIGHTWEIGHT_ROUTES.has(route?.id)) {
    ids.push('architecture_map_baseline', 'architecture_map_review');
  }
  if (routeRequiresSubagents(route, task, taskProfile)) ids.push('subagent_plan', 'official_subagent_execution', 'parent_integration');
  if (specializedRoute) ids.push('route_materialization');
  if (specializedRoute) ids.push('completion_proof');
  if (reflectionRequiredForRoute(route)) ids.push('reflection');

  return [...new Set(ids)].map((id: any) => {
    const configuredGate = (STAGE_BLOCKING_GATE as Record<string, string>)[id] || null;
    const blockingGate = configuredGate === 'safety' && gateProfile !== 'full'
      ? 'ownership'
      : configuredGate;
    const blocking = Boolean(blockingGate);
    const metadata = { blocking, blocking_gate: blocking ? blockingGate : null };
    if (id === OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID) return { ...officialSubagentPipelineStage(officialSubagentPolicy), status: 'required', reason: officialSubagentPolicy.reason, ...metadata };
    if (id === 'engineering_sanity_check') {
      return {
        id,
        status: 'keep',
        reason: 'required_for_code_and_database_quality',
        checks: [
          'trace actual callers and preserve basic SOLID responsibility and dependency boundaries',
          'inspect loops, collections, resolvers, and serializers for N+1 or repeated I/O',
          'prove render, recursion, event, retry, and polling loops are bounded and cancellable',
          'reject disabled checks, swallowed errors, placeholder success, and verification bypasses',
          'for DB work, verify the existing canonical adapter and connection/pool lifecycle before changes',
          'for sensitive or multi-step DB work, verify transaction rollback, error propagation, idempotency, and post-commit invariants'
        ],
        ...metadata
      };
    }
    if (id === 'ambiguity_gate' && ambiguity?.required === false) return { id, status: 'not_applicable', reason: 'ambiguity_gate_not_required_for_entrypoint', ...metadata };
    if (id === 'ambiguity_gate' && ambiguity?.passed) return { id, status: 'passed', reason: 'ambiguity_contract_already_sealed', ...metadata };
    return { id, status: 'keep', reason: lane.fast_lane_allowed ? 'task_profile_minimal_lane' : 'required_by_task_and_route_profile', ...metadata };
  });
}

export function planVerification(route: any, task: any, proof: any, budget: VerificationBudget) {
  if (budget === 'none') return [];
  const out = new Set(proof.verification || []);
  if (budget === 'single-check') out.add('run one focused check for the changed surface');
  if (budget === 'affected') out.add('run affected tests or checks for changed files');
  if (budget === 'confidence') {
    out.add('run the focused build or typecheck for the affected package');
    out.add('run affected regression tests and the risk-specific safety check');
  }
  if (budget === 'release') {
    out.add('npm run packcheck');
    out.add('sks selftest --mock --json');
  }
  if (route?.id === 'Naruto') out.add('validate official subagent evidence and the parent integration summary');
  if (routeNeedsEngineeringSanityReview(route, task)) {
    out.add('complete the engineering sanity review for SOLID boundaries, N+1/repeated I/O, bounded loops, and verification bypasses');
  }
  if (route?.id === 'DB' || route?.id === 'MadSKS') {
    out.add('verify existing canonical DB access, pool lifecycle, and transaction integrity for sensitive or multi-step mutations');
  }
  if (reflectionRequiredForRoute(route)) out.add('sks wiki validate .sneakoscope/wiki/context-pack.json');
  return [...out];
}

export function pipelineInvariants(input: { taskProfile: TaskProfile; gateProfile: GateProfile; stages: any[]; verificationBudget: VerificationBudget }) {
  const out = ['no_unrequested_fallback_code'];
  if (input.stages.some((stage: any) => stage.id === 'engineering_sanity_check')) out.push('engineering_sanity_check');
  if (input.verificationBudget !== 'none') out.push('listed_verification');
  if (input.stages.some((stage: any) => stage.id === 'ssot_guard' && stage.status !== 'not_applicable')) out.push('ssot_guard');
  if (input.stages.some((stage: any) => stage.id === 'triwiki_validate_before_final')) out.push('triwiki_validate_before_final');
  if (input.gateProfile !== 'none') out.push('honest_summary');
  return out;
}

