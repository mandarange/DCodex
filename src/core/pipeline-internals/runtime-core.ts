import path from 'node:path';
import { appendJsonl, exists, nowIso, readJson, readText, writeJsonAtomic } from '../fsx.js';
import { containsUserQuestion, noQuestionContinuationReason } from '../no-question-guard.js';
import { createMission, getOrCreateSessionMission, missionDir, sessionStateKey, setCurrent } from '../mission.js';
import { buildQuestionSchemaForRoute, buildRequestIntake, REQUEST_INTAKE_ARTIFACT, writeQuestions } from '../questions.js';
import { sealContract } from '../decision-contract.js';
import { scanDbSafety } from '../db-safety.js';
import {
  createDbAccessReviewSeed,
  createDbReviewSeed,
  DB_ACCESS_CANDIDATES_ARTIFACT,
  DB_ACCESS_REVIEW_ARTIFACT,
  DB_MANUAL_MIGRATION_ARTIFACT,
  DB_REVIEW_ARTIFACT,
  scanDbAccessCandidates
} from '../db-review.js';
import {
  createEngineeringSanityReviewSeed,
  ENGINEERING_SANITY_CODE_STRUCTURE_REPORT,
  ENGINEERING_SANITY_REVIEW_ARTIFACT
} from '../engineering-sanity-review.js';
import { createAndWriteWorkOrderLedgerForPrompt } from '../work-order-ledger.js';
import { resolveChangedScopeBase, writeCodeStructureReport } from '../code-structure.js';
import { writeMemorySweepReport } from '../memory-governor.js';
import { writeMistakeMemoryReport } from '../mistake-memory.js';
import { MISTAKE_RECALL_ARTIFACT, mistakeRecallGateStatus } from '../mistake-recall.js';
import { recordSkillDreamEvent, SKILL_DREAM_POLICY, writeSkillForgeReport } from '../skill-forge.js';
import { evaluateResearchGate, researchPaperArtifactForPlan, writeResearchPlan } from '../research.js';
import {
  ALIGN_GATE_ARTIFACT,
  ALIGN_LEDGER_ARTIFACT,
  ALIGN_PLAN_ARTIFACT,
  alignNextActionText,
  writeAlignRouteArtifacts
} from '../align/align-route.js';
import { PPT_REQUIRED_GATE_FIELDS, writePptRouteArtifacts } from '../ppt.js';
import { writeQaLoopArtifacts } from '../qa-loop.js';
import { IMAGE_UX_REVIEW_GATE_ARTIFACT, IMAGE_UX_REVIEW_POLICY_ARTIFACT, IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT, IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT, IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT, IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT, IMAGE_UX_REVIEW_REQUIRED_GATE_FIELDS, writeImageUxReviewRouteArtifacts } from '../image-ux-review.js';
import { responseLanguageInstruction } from '../language-preference.js';
import { buildSsotGuard } from '../safety/ssot-guard.js';
import { SPEED_LANE_POLICY } from '../proof-field.js';
import { validateRouteCompletionProof } from '../proof/route-proof-gate.js';
import { routeFromState, routeRequiresCompletionProof } from '../proof/route-proof-policy.js';
import { permissionGateSummary } from '../permission-gates.js';
import { prepareMadSksSqlPlaneMission } from '../mad-sks/sql-plane/coordinator.js';
import { MAD_SKS_SQL_PLANE_CAPABILITY_FILE, madSksSqlPlaneRelativePath } from '../mad-sks/sql-plane/paths.js';
import { OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID } from '../agents/agent-schema.js';
import { normalizeOfficialSubagentPolicy, officialSubagentPipelineStage } from '../agents/agent-plan.js';
import { CODEX_APP_IMAGE_GENERATION_DOC_URL, CODEX_COMPUTER_USE_EVIDENCE_SOURCE, CODEX_COMPUTER_USE_ONLY_POLICY, CODEX_IMAGEGEN_REQUIRED_POLICY, CODEX_WEB_VERIFICATION_POLICY, FROM_CHAT_IMG_CHECKLIST_ARTIFACT, FROM_CHAT_IMG_COVERAGE_ARTIFACT, FROM_CHAT_IMG_QA_LOOP_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_ARTIFACT, FROM_CHAT_IMG_TEMP_TRIWIKI_SESSIONS, chatCaptureIntakeText, context7RequirementText, dollarCommand, evidenceMentionsForbiddenBrowserAutomation, explicitManagedSkillNames, hasFromChatImgSignal, hasMadSksSignal, imageUxReviewPipelinePolicyText, looksLikeCodeChangingWork, managedSkillNamesForPrompt, pptPipelineAllowlistPolicyText, reflectionRequiredForRoute, reasoningInstruction, routeNeedsContext7, routePrompt, routeReasoning, routeRequiresSubagents, stripDollarCommand, stripMadSksSignal, stripVisibleDecisionAnswerBlocks, subagentExecutionPolicyText, stackCurrentDocsPolicyText, triwikiContextTracking } from '../routes.js';
import { coreEngineeringDirectiveReferenceText, engineeringSanityPolicyText } from '../lean-engineering-policy.js';
import { classifyTaskProfile, gateProfileForTask, type GateProfile, type TaskProfile } from '../runtime/task-profile.js';
import { chooseVerificationBudget, type VerificationBudget } from '../runtime/verification-budget.js';
import { NARUTO_PARENT_MODEL } from '../subagents/model-policy.js';
import { HARD_NARUTO_MAX_THREADS } from '../subagents/thread-budget.js';
import {
  NARUTO_GATE_FILENAME,
  NARUTO_SUMMARY_FILENAME,
  SUBAGENT_PLAN_FILENAME,
  prepareOfficialSubagentMission
} from '../subagents/official-subagent-preparation.js';
import {
  buildSubagentEvidence,
  readSubagentEvents,
  recordSubagentEvent,
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_EVENT_LOG_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME
} from '../subagents/subagent-evidence.js';
import {
  effectiveSubagentTarget,
  normalizeLegacySubagentCountFields,
  subagentCountContractBlockers
} from '../subagents/wave-lifecycle.js';
import { officialSubagentEvidenceReady } from '../subagents/terminal-subagent-state.js';
import {
  createArchitectureMapPlanBinding,
  maybeSeedArchitectureMapForPlan,
  planStagesArchitectureMap
} from '../architecture-map-pipeline.js';
import {
  BLOCKING_GATE_LIMITS,
  LIGHTWEIGHT_ROUTES,
  GATE_PROFILE_STAGES,
  STAGE_BLOCKING_GATE,
  selectPipelineLane,
  buildPipelineStages,
  planVerification,
  pipelineInvariants
} from './pipeline-stage-builder.js';

export { routePrompt };
export { LIGHTWEIGHT_ROUTES, GATE_PROFILE_STAGES, STAGE_BLOCKING_GATE, BLOCKING_GATE_LIMITS };

export const PIPELINE_PLAN_ARTIFACT = 'pipeline-plan.json';
export const PIPELINE_PLAN_SCHEMA_VERSION = 1;
const SKILL_DREAM_HOT_PATH_COUNTERS = new Map<string, number>();

function ambientGoalContinuation() {
  return {
    schema_version: 1,
    enabled: true,
    mode: 'codex_native_goal_only',
    native_slash_command: '/goal',
    non_disruptive: true,
    rule: 'Codex native Goal is the only persisted goal owner. SKS must not create Goal missions, bridge artifacts, compatibility loops, or fallback goal state.'
  };
}
const REFLECTION_ARTIFACT = 'reflection.md';
const REFLECTION_GATE = 'reflection-gate.json';
const REFLECTION_MEMORY_PATH = '.sneakoscope/memory/q2_facts/post-route-reflection.md';
const COMPLIANCE_LOOP_GUARD_ARTIFACT = 'compliance-loop-guard.json';
const HARD_BLOCKER_ARTIFACT = 'hard-blocker.json';
const DEFAULT_COMPLIANCE_LOOP_LIMIT = 3;
const CLARIFICATION_BYPASS_ROUTES = new Set(['Answer', 'DFix', 'Help', 'Wiki', 'ComputerUse', 'Goal']);
const QUESTION_GATE_ROUTES = new Set(['QALoop', 'PPT']);
function reflectionInstructionText(commandPrefix: any = 'sks') {
  return `Post-route reflection: full routes load \`reflection\` after work/tests and before final; DFix/Answer/Help/Wiki/SKS discovery are exempt. Write ${REFLECTION_ARTIFACT}; record only real misses/gaps, or no_issue_acknowledged. For lessons, append TriWiki claim rows to ${REFLECTION_MEMORY_PATH}. Run "${commandPrefix} wiki refresh" or pack, validate, then pass ${REFLECTION_GATE}.`;
}

export function buildPipelinePlan(input: any = {}) {
  const route = input.route || routePrompt(input.task || '$SKS');
  const task = String(input.task || '').trim();
  const taskProfile: TaskProfile = input.taskProfile || taskProfileForRoute(route, task, classifyTaskProfile(task));
  const gateProfile = gateProfileForTask(taskProfile);
  const requestIntake = input.requestIntake || null;
  const executionPrompt = String(requestIntake?.transformed_prompt || task || '').trim();
  const ambiguity = normalizeAmbiguity(input.ambiguity, route);
  const proof = normalizeProofField(input.proofField);
  const subagentsRequired = routeRequiresSubagents(route, task, taskProfile);
  const lane = selectPipelineLane(route, task, proof, taskProfile);
  const explicitSubagentOptions = input.agents && typeof input.agents === 'object' && !Array.isArray(input.agents)
    ? input.agents
    : input.agents === undefined
      ? {}
      : { agents: input.agents };
  const officialSubagentPolicy = normalizeOfficialSubagentPolicy(route, task, {
    ...explicitSubagentOptions,
    required: subagentsRequired,
    taskProfile
  });
  const verificationBudget: VerificationBudget = input.verificationBudget || chooseVerificationBudget({
    taskProfile,
    changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : []
  });
  const stages = buildPipelineStages(route, task, taskProfile, gateProfile, ambiguity, lane, Boolean(input.required), officialSubagentPolicy);
  const verification = planVerification(route, task, proof, verificationBudget);
  const skipped = stages.filter((stage: any) => stage.status === 'skipped').map((stage: any) => stage.id);
  const kept = stages.filter((stage: any) => stage.status !== 'skipped' && stage.status !== 'not_applicable').map((stage: any) => stage.id);
  const routeEconomy = routeEconomyPlan(proof);
  const invariants = pipelineInvariants({ taskProfile, gateProfile, stages, verificationBudget });
  return {
    schema_version: PIPELINE_PLAN_SCHEMA_VERSION,
    generated_at: nowIso(),
    mission_id: input.missionId || null,
    route: {
      id: route?.id || 'SKS',
      command: route?.command || '$SKS',
      mode: route?.mode || 'SKS',
      stop_gate: route?.stopGate || 'honest_mode',
      required_skills: route?.requiredSkills || [],
      context7_required: Boolean(input.required),
      subagents_required: subagentsRequired,
      native_sessions_required: false,
      reflection_required: reflectionRequiredForRoute(route)
    },
    task_profile: taskProfile,
    gate_profile: gateProfile,
    gate_budget: {
      blocking_gate_limit: BLOCKING_GATE_LIMITS[taskProfile],
      blocking_gate_count: countBlockingGateStages(stages),
      blocking_stage_count: countBlockingStages(stages),
      blocking_gate_ids: blockingGateIds(stages)
    },
    task,
    request_intake: requestIntake ? {
      artifact: REQUEST_INTAKE_ARTIFACT,
      prompt_hash: requestIntake.prompt_hash || null,
      interpreted_goal: requestIntake.interpreted_intent?.goal || null,
      requirement_count: Array.isArray(requestIntake.requirements) ? requestIntake.requirements.length : 0,
      transformed_prompt_available: Boolean(requestIntake.transformed_prompt),
      wiki_context_used: requestIntake.wiki_context_used?.source || null
    } : {
      artifact: REQUEST_INTAKE_ARTIFACT,
      status: 'not_attached'
    },
    execution_prompt: executionPrompt,
    ambiguity_gate: ambiguity,
    runtime_lane: lane,
    stages,
    stage_summary: {
      total: stages.length,
      kept: kept.length,
      skipped: skipped.length,
      not_applicable: stages.filter((stage: any) => stage.status === 'not_applicable').length
    },
    skipped_stages: skipped,
    kept_stages: kept,
    verification_budget: verificationBudget,
    verification,
    // Filled in by writePipelinePlan once the mission's changed-scope base is
    // resolved; a persisted plan without it never seeded the review artifact
    // and must never turn the engineering-sanity Stop gate on.
    engineering_sanity_review: null as EngineeringSanityReviewBinding | null,
    architecture_map: null as null | {
      baseline_artifact: string;
      review_artifact: string;
      capsule_artifact: string;
      manifest_artifact: string;
      required: true;
      seeded_at: string;
    },
    invariants,
    proof_field: proof,
    ssot_guard: buildSsotGuard({ route: route?.id || 'SKS', mode: route?.mode || 'SKS', task }),
    route_economy: routeEconomy,
    official_subagents: officialSubagentPolicy,
    skill_dream: input.skillDream || { attached: false, reason: 'skill dreaming uses cheap counters and only runs inventory at threshold' },
    goal_continuation: ambientGoalContinuation(),
    next_actions: planNextActions(route, task, taskProfile, ambiguity, lane),
    no_unrequested_fallback_code: true
  };
}

function taskProfileForRoute(route: any, task: string, classified: TaskProfile): TaskProfile {
  if (classified !== 'answer' && classified !== 'passthrough') return classified;
  const routeId = String(route?.id || '');
  if (['DB', 'MadSKS', 'ReleaseReview'].includes(routeId) && /\b(apply|execute|run|fix|change|migrate|deploy|release|publish)\b|적용|실행|수정|변경|마이그레이션|배포|릴리즈|출시/i.test(task)) return 'high-risk';
  if (['Research', 'AutoResearch', 'QALoop', 'PPT', 'ImageUXReview', 'GX', 'DB', 'MadSKS', 'ReleaseReview'].includes(routeId)) return 'bounded-work';
  return classified;
}

export async function writePipelinePlan(dir: any, input: any = {}) {
  const route = input.route || routePrompt(input.task || '$SKS');
  const taskProfile: TaskProfile = input.taskProfile || taskProfileForRoute(route, String(input.task || ''), classifyTaskProfile(input.task || ''));
  if ((taskProfile === 'passthrough' || taskProfile === 'answer') && input.forceLightweightPlan !== true) {
    return buildPipelinePlan({ ...input, taskProfile, requestIntake: input.requestIntake || null });
  }
  const requestIntake = input.requestIntake || await writeRequestIntakeArtifact(dir, input);
  const plan = buildPipelinePlan({ ...input, taskProfile, requestIntake });
  const root = input.root || rootFromMissionDir(dir);
  if (planStagesEngineeringSanityReview(plan)) {
    plan.engineering_sanity_review = {
      artifact: ENGINEERING_SANITY_REVIEW_ARTIFACT,
      code_structure_report: ENGINEERING_SANITY_CODE_STRUCTURE_REPORT,
      changed_scope_base: resolveChangedScopeBase(root)
    };
  }
  if (planStagesArchitectureMap(plan)) {
    plan.architecture_map = createArchitectureMapPlanBinding();
  }
  await writeJsonAtomic(path.join(dir, PIPELINE_PLAN_ARTIFACT), plan);
  if (plan.engineering_sanity_review) {
    const report = await writeCodeStructureReport(root, dir, {
      missionId: input.missionId || null,
      changedSince: plan.engineering_sanity_review.changed_scope_base,
      includeOk: true
    });
    const reportText = await readText(path.join(dir, ENGINEERING_SANITY_CODE_STRUCTURE_REPORT), '');
    const reviewFile = path.join(dir, ENGINEERING_SANITY_REVIEW_ARTIFACT);
    if (!(await exists(reviewFile))) {
      await writeJsonAtomic(reviewFile, createEngineeringSanityReviewSeed(
        plan.route?.command || plan.route?.id || null,
        report,
        reportText
      ));
    }
  }
  await maybeSeedArchitectureMapForPlan({
    root, dir, plan, missionId: input.missionId, taskProfile
  });
  return plan;
}

export interface EngineeringSanityReviewBinding {
  artifact: string;
  code_structure_report: string;
  changed_scope_base: string;
}

function planStagesEngineeringSanityReview(plan: any) {
  return Array.isArray(plan?.stages) && plan.stages.some((stage: any) => (
    String(stage?.id || '') === 'engineering_sanity_check'
    && !['skipped', 'not_applicable'].includes(String(stage?.status || ''))
  ));
}

// Single source of truth for the engineering-sanity Stop gate: the route state
// may only require the review when this plan actually seeded it. Deriving the
// requirement from any other predicate (for example the prompt wording alone)
// re-creates the drift where a route demands an artifact no plan ever wrote,
// which the Stop gate can only answer with an unsatisfiable blocker.
export function pipelinePlanState(plan: any) {
  const sanity = plan?.engineering_sanity_review || null;
  return {
    pipeline_plan_ready: validatePipelinePlan(plan).ok,
    pipeline_plan_path: PIPELINE_PLAN_ARTIFACT,
    engineering_sanity_required: Boolean(sanity),
    engineering_sanity_scope_base: sanity?.changed_scope_base || null,
    architecture_map_required: Boolean(plan?.architecture_map)
  };
}

export async function writeRequestIntakeArtifact(dir: any, input: any = {}) {
  const file = path.join(dir, REQUEST_INTAKE_ARTIFACT);
  if (!input.requestIntake && !input.forceRequestIntakeRewrite) {
    const existing = await readJson(file, null);
    if (existing) return existing;
  }
  const root = input.root || rootFromMissionDir(dir);
  const wikiContext = input.wikiContext !== undefined
    ? input.wikiContext
    : await readJson(path.join(root, '.sneakoscope', 'wiki', 'context-pack.json'), null);
  const intake = input.requestIntake || buildRequestIntake(input.task || '', {}, {
    wikiContext,
    route: input.route || null
  });
  await writeJsonAtomic(file, intake);
  return intake;
}

function rootFromMissionDir(dir: any) {
  const resolved = path.resolve(dir);
  const parts = resolved.split(path.sep);
  const idx = parts.lastIndexOf('.sneakoscope');
  if (idx > 0) return parts.slice(0, idx).join(path.sep) || path.sep;
  return path.resolve(resolved, '..', '..', '..');
}

export function validatePipelinePlan(plan: any = {}) {
  const issues: any[] = [];
  const taskProfile: TaskProfile = plan.task_profile || classifyTaskProfile(plan.task || '');
  const expectedGateProfile = gateProfileForTask(taskProfile);
  const gateProfile = plan.gate_profile || expectedGateProfile;
  const verificationBudget: VerificationBudget = plan.verification_budget || chooseVerificationBudget({ taskProfile, changedFiles: [] });
  const expectedBlockingGateLimit = BLOCKING_GATE_LIMITS[taskProfile];
  const declaredBlockingGateLimit = Number(plan.gate_budget?.blocking_gate_limit);
  const actualBlockingGateCount = countBlockingGateStages(plan.stages);
  if (plan.schema_version !== PIPELINE_PLAN_SCHEMA_VERSION) issues.push('schema_version');
  if (!plan.route?.id || !plan.route?.command) issues.push('route');
  if (!plan.runtime_lane?.lane) issues.push('runtime_lane');
  if (gateProfile !== expectedGateProfile) issues.push('gate_profile');
  if (!Number.isInteger(declaredBlockingGateLimit) || declaredBlockingGateLimit !== expectedBlockingGateLimit) issues.push('gate_budget.blocking_gate_limit');
  if (actualBlockingGateCount > expectedBlockingGateLimit) issues.push(`gate_budget.blocking_gate_limit_exceeded:${actualBlockingGateCount}>${expectedBlockingGateLimit}`);
  if (plan.gate_budget?.blocking_gate_count !== undefined && Number(plan.gate_budget.blocking_gate_count) !== actualBlockingGateCount) issues.push('gate_budget.blocking_gate_count');
  if (plan.gate_budget?.blocking_stage_count !== undefined && Number(plan.gate_budget.blocking_stage_count) !== countBlockingStages(plan.stages)) issues.push('gate_budget.blocking_stage_count');
  if (!sameStringArray(plan.gate_budget?.blocking_gate_ids, blockingGateIds(plan.stages))) issues.push('gate_budget.blocking_gate_ids');
  if (!Array.isArray(plan.stages) || (gateProfile !== 'none' && !plan.stages.length)) issues.push('stages');
  else {
    issues.push(...validateRequiredGateProfileStages(plan, expectedGateProfile));
    issues.push(...validateStageBlockingMetadata(plan.stages));
  }
  if (!Array.isArray(plan.verification) || (verificationBudget !== 'none' && !plan.verification.length)) issues.push('verification');
  if (!plan.route_economy?.mode) issues.push('route_economy');
  const routeEconomyLatticeIssues = validateRouteEconomyDecisionLattice(plan.route_economy, plan.proof_field);
  if (routeEconomyLatticeIssues.length) issues.push(...routeEconomyLatticeIssues.map((issue: any) => `route_economy.decision_lattice:${issue}`));
  if (plan.no_unrequested_fallback_code !== true || !plan.invariants?.includes('no_unrequested_fallback_code')) issues.push('fallback_guard');
  if (plan.invariants?.includes('ssot_guard')) {
    if (!plan.ssot_guard?.required) issues.push('ssot_guard');
    if (!plan.stages?.some((stage: any) => stage.id === 'ssot_guard' && !['skipped', 'not_applicable'].includes(stage.status))) issues.push('ssot_guard_stage');
  }
  if (gateProfile !== 'none' && !plan.next_actions?.length) issues.push('next_actions');
  if (plan.official_subagents?.required && !plan.stages?.some((stage: any) => stage.id === OFFICIAL_SUBAGENT_EXECUTION_STAGE_ID
    && stage.workflow === 'official_codex_subagent'
    && Number(stage.requested_subagents || 0) === Number(plan.official_subagents.requested_subagents || 0)
    && Number(stage.requested_subagents || 0) > 0
    && Number(stage.max_threads || 0) > 0
    && Number(stage.max_depth || 0) === 1
    && Array.isArray(stage.outputs)
    && stage.outputs.includes(SUBAGENT_EVIDENCE_FILENAME))) issues.push('official_subagent_execution_stage');
  return { ok: issues.length === 0, issues };
}

function validateRequiredGateProfileStages(plan: any, gateProfile: GateProfile): string[] {
  const issues: string[] = [];
  const stages = Array.isArray(plan.stages) ? plan.stages : [];
  const activeStatuses = new Set(['keep', 'required', 'passed', 'completed']);
  for (const id of GATE_PROFILE_STAGES[gateProfile]) {
    const matches = stages.filter((stage: any) => String(stage?.id || '') === id);
    if (matches.length !== 1) {
      issues.push(`stages.required_count:${id}:${matches.length}`);
      continue;
    }
    const status = String(matches[0]?.status || '');
    const validNotApplicable = id === 'ambiguity_gate'
      && plan.ambiguity_gate?.required === false
      && status === 'not_applicable';
    if (!activeStatuses.has(status) && !validNotApplicable) {
      issues.push(`stages.required_inactive:${id}:${status || 'missing'}`);
    }
  }
  return issues;
}

function countBlockingGateStages(stages: any): number {
  return blockingGateIds(stages).length;
}

function countBlockingStages(stages: any): number {
  if (!Array.isArray(stages)) return 0;
  return stages.filter((stage: any) => stage?.blocking === true && !['skipped', 'not_applicable'].includes(String(stage?.status || ''))).length;
}

function blockingGateIds(stages: any): string[] {
  if (!Array.isArray(stages)) return [];
  return [...new Set(stages
    .filter((stage: any) => stage?.blocking === true && !['skipped', 'not_applicable'].includes(String(stage?.status || '')))
    .map((stage: any) => String(stage?.blocking_gate || '').trim())
    .filter(Boolean))].sort();
}

function validateStageBlockingMetadata(stages: any[]): string[] {
  const issues: string[] = [];
  for (const stage of stages) {
    const id = String(stage?.id || 'missing');
    if (typeof stage?.blocking !== 'boolean') issues.push(`stages.blocking_metadata_missing:${id}`);
    if (stage?.blocking === true && !String(stage?.blocking_gate || '').trim()) issues.push(`stages.blocking_gate_missing:${id}`);
    if (stage?.blocking !== true && stage?.blocking_gate != null) issues.push(`stages.nonblocking_gate_present:${id}`);
  }
  return issues;
}

function sameStringArray(left: any, right: string[]): boolean {
  return Array.isArray(left)
    && left.length === right.length
    && left.every((value: any, index: number) => String(value) === right[index]);
}

function validateRouteEconomyDecisionLattice(routeEconomy: any = {}, proof: any = {}) {
  const lattice = routeEconomy.decision_lattice;
  if (!lattice) return [];
  const issues: any[] = [];
  if (routeEconomy.report_only !== true || routeEconomy.mode !== 'report_only') issues.push('requires_report_only_route_economy');
  if (lattice.report_only !== true) issues.push('report_only');
  if (!lattice.selected_path) issues.push('selected_path');
  if (!Number.isFinite(Number(lattice.selected_f_score))) issues.push('selected_f_score');
  if (!Number.isFinite(Number(lattice.frontier_count)) || Number(lattice.frontier_count) < 1) issues.push('frontier_count');
  if (!Number.isFinite(Number(lattice.rejected_alternatives_count))) issues.push('rejected_alternatives_count');
  if (proof?.attached && proof.decision_lattice) {
    const source = proof.decision_lattice;
    if (lattice.selected_path !== source.selected_path?.id) issues.push('selected_path_mismatch');
    if (Number(lattice.frontier_count) !== Number(source.frontier?.expanded_order?.length || 0)) issues.push('frontier_count_mismatch');
    if (Number(lattice.rejected_alternatives_count) !== Number(source.rejected_alternatives?.length || 0)) issues.push('rejected_alternatives_count_mismatch');
  }
  return issues;
}

function normalizeAmbiguity(value: any = {}, route: any) {
  const required = value.required ?? !CLARIFICATION_BYPASS_ROUTES.has(route?.id);
  const slots = Number(value.slots || 0);
  let status = value.status || (required ? 'required' : 'not_required');
  if (required && value.auto_sealed) status = 'auto_sealed';
  else if (required && slots > 0) status = 'awaiting_answers';
  else if (required && value.passed) status = 'contract_sealed';
  return {
    required: Boolean(required),
    status,
    slots,
    auto_sealed: Boolean(value.auto_sealed),
    passed: Boolean(value.passed || value.auto_sealed || status === 'contract_sealed'),
    contract_hash: value.contract_hash || null
  };
}

function normalizeProofField(report: any) {
  if (!report) return { attached: false, reason: 'not built during route intake; attach with sks pipeline plan --proof-field after concrete scope/changed files are known' };
  return {
    attached: true,
    lane: report.execution_lane?.lane || null,
    fast_lane_allowed: Boolean(report.execution_lane?.fast_lane_allowed),
    score: Number(report.execution_lane?.score || report.simplicity_scorecard?.score || 0),
    blockers: report.execution_lane?.blockers || report.fast_lane_decision?.blockers || [],
    skip_when_fast: report.execution_lane?.skip_when_fast || [],
    keep: report.execution_lane?.keep || SPEED_LANE_POLICY.always_keep,
    verification: report.execution_lane?.verification || report.fast_lane_decision?.verification || [],
    proof_cones: (report.proof_cones || []).map((cone: any) => cone.id),
    source_hash: report.source_hash || null,
    contract_clarity: report.contract_clarity || null,
    workflow_complexity: report.workflow_complexity || null,
    naruto_trigger_matrix: report.naruto_trigger_matrix || null,
    verification_stage_cache: report.verification_stage_cache || null,
    decision_lattice: report.decision_lattice || null
  };
}

function routeEconomyPlan(proof: any = {}) {
  if (!proof.attached) {
    return {
      schema_version: 1,
      mode: 'unavailable',
      report_only: true,
      reason: proof.reason || 'Proof Field not attached yet'
    };
  }
  const triggers = proof.naruto_trigger_matrix?.active_triggers || [];
  return {
    schema_version: 1,
    mode: 'report_only',
    report_only: true,
    contract_clarity_score: Number(proof.contract_clarity?.score || 0),
    contract_clarity_passed: proof.contract_clarity?.passed === true,
    ask_recommended: proof.contract_clarity?.ask_recommended === true,
    workflow_complexity_score: Number(proof.workflow_complexity?.score || 0),
    workflow_complexity_band: proof.workflow_complexity?.band || null,
    naruto_trigger_count: triggers.length,
    active_naruto_triggers: triggers,
    verification_stage_cache_key: proof.verification_stage_cache?.cache_key || null,
    decision_lattice: proof.decision_lattice ? {
      selected_path: proof.decision_lattice.selected_path?.id || null,
      selected_f_score: proof.decision_lattice.selected_path?.cost?.f ?? null,
      frontier_count: proof.decision_lattice.frontier?.expanded_order?.length || 0,
      rejected_alternatives_count: proof.decision_lattice.rejected_alternatives?.length || 0,
      report_only: proof.decision_lattice.report_only === true
    } : null,
    deletion_policy: 'do_not_delete_or_skip_pipeline_stages_until_report_only_metrics_are_calibrated'
  };
}



function planNextActions(route: any, task: any, taskProfile: TaskProfile, ambiguity: any, lane: any) {
  if (taskProfile === 'passthrough' || taskProfile === 'answer') return [];
  if (ambiguity.required && !ambiguity.passed) {
    return [
      `read ${REQUEST_INTAKE_ARTIFACT} and preserve its source-order requirements`,
      'auto-seal execution contract from inferred answers',
      'continue with decision-contract.json'
    ];
  }
  const actions = [`read ${REQUEST_INTAKE_ARTIFACT} and use its transformed_prompt`, 'read pipeline-plan.json before work', 'execute kept stages only', 'run listed verification'];
  if (!lane.fast_lane_allowed && routeRequiresSubagents(route, task, taskProfile)) {
    actions.splice(1, 0, route?.id === 'Naruto'
      ? 'read subagent-plan.json, create independent disjoint slices, run the official Codex subagent workflow, wait for all requested agent threads, and integrate their results'
      : 'materialize the route-specific subagent plan before implementation');
  }
  actions.push('refresh/validate TriWiki when required', 'finish with completion summary and Honest Mode');
  return actions;
}

export function promptPipelineContext(prompt: any, route: any = null) {
  const cleanPrompt = stripVisibleDecisionAnswerBlocks(prompt);
  route = route || routePrompt(cleanPrompt);
  if (!route) return '';
  const required = routeNeedsContext7(route, cleanPrompt);
  const reasoning = routeReasoning(route, cleanPrompt);
  const directFix = route?.id === 'DFix';
  if (directFix) return dfixQuickContext(cleanPrompt, route);
  if (route?.id === 'Answer') return answerOnlyContext(cleanPrompt, route);
  if (route?.id === 'Goal') return goalNativeOnlyContext(cleanPrompt, route);
  if (route?.id === 'ComputerUse') return computerUseFastContext(cleanPrompt, route);
  const lines = [
    `SKS skill-first pipeline active. Route: ${route?.command || '$SKS'} (${route?.route || 'general SKS workflow'}).`,
    reasoningInstruction(reasoning),
    responseLanguageInstruction(cleanPrompt),
    coreEngineeringDirectiveReferenceText(),
    engineeringSanityPolicyText(),
    'Load only the selected route skills and route-specific instructions; do not inject unrelated route policy.',
    'Codex native /goal is the only persisted goal owner. Goal persistence must not replace or skip the selected route gates.',
    `When a mission exists, read ${REQUEST_INTAKE_ARTIFACT} as a structured projection of the current request. Preserve the literal request and current code as authority; never let generic intake heuristics replace an explicit requirement.`,
    subagentExecutionPolicyText(route, cleanPrompt),
    'TriWiki: read the bounded current context pack before each stage, hydrate risky or stale claims from source, refresh after material changes, and validate before handoff or final.',
    required ? stackCurrentDocsPolicyText() : '',
    context7RequirementText(required),
    'Do not stop at a plan when implementation was requested; continue until the route gate passes or a hard blocker is honestly recorded.',
    'Before final answer, include a user-visible completion summary that explains what changed and how it was verified, then run SKS Honest Mode: verify evidence/tests, state gaps, and confirm the goal is genuinely complete.'
  ].filter(Boolean);
  if (hasFromChatImgSignal(cleanPrompt)) lines.push(chatCaptureIntakeText());
  if (reflectionRequiredForRoute(route)) lines.push(reflectionInstructionText());
  if (route?.id === 'Naruto') lines.push('Naruto route: prepare subagent-plan.json, delegate independent slices through official Codex worker/expert agent threads, record SubagentStart/SubagentStop events, wait for every requested thread, integrate the parent summary, run scoped verification, and pass naruto-gate.json. Process counts, PID evidence, custom process pools, and verification DAGs are not completion evidence.');
  if (route?.id === 'PPT') lines.push(`PPT route: before design or PDF work, infer and seal delivery context, audience profile including average age/job/industry, STP strategy, decision context, and at least three pain-point to solution mappings from the prompt, TriWiki/current-code defaults, and conservative policy. Keep the visual system simple, restrained, and information-first; design detail should come from hierarchy, spacing, alignment, rules, and subtle accents rather than decorative overdesign. ${pptPipelineAllowlistPolicyText()} If generated image assets or slide visual critique are needed, actively invoke the loaded imagegen skill through Codex App $imagegen/gpt-image-2 (${CODEX_APP_IMAGE_GENERATION_DOC_URL}), save the selected raster output into the mission assets/review evidence path, and record that real path before build/final. Direct API fallback, placeholders, HTML/CSS stand-ins, and prose-only substitutes do not satisfy the route gate. ${CODEX_IMAGEGEN_REQUIRED_POLICY} Then build source ledger, fact ledger, image asset ledger, storyboard with aha moments, style tokens, editable source HTML under source-html/, PDF artifact, render QA, bounded review ledger/iteration report, PPT-only temporary build file cleanup, and ppt-parallel-report.json so independent strategy/render/file-write phases stay parallel-friendly, then reflection and Honest Mode.`);
  if (route?.id === 'ImageUXReview') lines.push(`Image UX Review route: ${imageUxReviewPipelinePolicyText()} Use ${IMAGE_UX_REVIEW_POLICY_ARTIFACT}, ${IMAGE_UX_REVIEW_SCREEN_INVENTORY_ARTIFACT}, ${IMAGE_UX_REVIEW_GENERATED_REVIEW_LEDGER_ARTIFACT}, ${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}, ${IMAGE_UX_REVIEW_ITERATION_REPORT_ARTIFACT}, and ${IMAGE_UX_REVIEW_GATE_ARTIFACT} as the route evidence set. The route may suggest safe fixes only when the user requested fixing; otherwise report findings and blockers.`);
  if (route?.id === 'AutoResearch') lines.push('AutoResearch route: load autoresearch-loop for experiments and benchmarking. SEO/GEO, discoverability, README, npm, GitHub search visibility, and AI-search visibility should use the first-class $SEO-GEO-OPTIMIZER parent route unless the selected route explicitly needs a child experiment.');
  if (route?.id === 'DB') lines.push('DB route: scan/check database risk first; destructive DB operations remain forbidden.');
  if (route?.id === 'MadSKS') lines.push('MAD-SKS SQL-plane: explicit invocation is the approval boundary. Use the mission-local write-capable Supabase MCP profile only for the bound cycle, verify execute_sql/apply_migration inventory before claiming ready, execute requested SQL-plane mutations, read back postconditions, then close the capability/profile and prove normal read-only restoration. Supabase project/account/billing/credential control-plane actions remain denied.');
  if (route?.id === 'GX') lines.push('GX route: use deterministic vgraph/beta render, validate, drift, and snapshot artifacts.');
  if (route?.id === 'Align') lines.push('Align route: modernize SKS prompts, settings, and generated skill/command surfaces against current GPT-5.6 prompting, programmatic tool calling, Agents, Codex skill-schema, and Plugins contracts. Record official source receipts plus explicit PTC and Agents adoption decisions; audit every generated surface; remove superseded compatibility settings; deduplicate policy without weakening success criteria, permissions, safety, tool routing, or validation; protect immutable core skills; keep align-ledger.json current; and pass align-gate.json.');
  return lines.join('\n');
}

export function dfixQuickContext(prompt: any, route: any = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  const routeLabel = route?.command || '$DFix';
  return [
    `DFix ultralight pipeline active. Route: ${routeLabel} (Direct Fix: tiny copy/config/docs/labels/spacing/translation/simple mechanical edits).`,
    responseLanguageInstruction(task),
    engineeringSanityPolicyText(),
    'Bypass: do not enter the general SKS prompt pipeline, mission creation, ambiguity gate, TriWiki refresh, Context7 routing, native-session orchestration, Goal, Research, eval, or broad planning.',
    `Task: ${task}`,
    'Task list:',
    '1. Infer the smallest visible Direct Fix target from the request and current files.',
    '2. Inspect only the files needed to locate that target.',
    `3. Apply only the listed Direct Fix edit; keep broad implementation routed to Naruto, and for UI/UX micro-edits read design.md when present and use imagegen for any image/logo/raster asset. ${CODEX_IMAGEGEN_REQUIRED_POLICY}`,
    '4. Run only cheap verification when useful, such as syntax check, focused test, or local render smoke.',
    '5. Final response: start with `DFix 완료 요약:` and include one `DFix 솔직모드:` line with verified / not verified / remaining issue status. Do not create TriWiki/TriFix/reflection/state records and do not enter repeated full-route Honest Mode loops.'
  ].join('\n');
}

export function answerOnlyContext(prompt: any, route: any = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  const required = routeNeedsContext7(route, task);
  return [
    `SKS answer-only pipeline active. Route: ${route?.command || '$Answer'} (${route?.route || 'answer-only research'}).`,
    responseLanguageInstruction(task),
    'Intent classification: answer/research question, not implementation. Do not create route mission state, ask ambiguity-gate questions, open worker sessions, continue active Naruto/Goal work, or edit files unless the user explicitly asks for implementation.',
    `Question: ${task}`,
    'Evidence flow:',
    '1. Check current repo facts and TriWiki context first; hydrate low-trust wiki claims from source paths before relying on them.',
    '2. Use web search for current, external, or uncertain facts when browsing is available or the user asks for latest/source-backed information.',
    '3. Use Context7 resolve-library-id plus query-docs when the answer depends on package, API, framework, SDK, MCP, or generated documentation behavior.',
    '4. For stack additions or version changes, preserve current-doc findings as high-priority TriWiki claims before recommending syntax or implementation.',
    `5. ${context7RequirementText(required)}`,
    '6. Finish with a clear answer summary plus Honest Mode fact-checking: separate verified facts, source-backed inferences, and remaining uncertainty.',
    'Answer directly and concisely. If the prompt is actually asking for code/work after inspection, state the re-route and use the proper execution pipeline.'
  ].join('\n');
}

export function goalNativeOnlyContext(prompt: any, route: any = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  return [
    `Codex native Goal control requested. Route label: ${route?.command || '$Goal'}.`,
    responseLanguageInstruction(task),
    'Use only Codex native Goal functionality. Do not create or continue an SKS mission, bridge artifact, compatibility loop, fallback goal state, work-order ledger, TriWiki route, or subagent workflow for this control turn.',
    'If a native goal tool is callable, use it directly. Otherwise provide the exact native /goal, /goal edit, /goal pause, /goal resume, or /goal clear command for the user to run.',
    `Requested goal: ${task}`,
    'Before create or edit, expand the objective into explicit Outcome, Scope, Constraints, Verification, Done when, Stop conditions, and Non-goals.',
    'Completion conditions must be measurable and must stop the run once satisfied; prohibit unrelated refactors, speculative expansion, and open-ended polishing.',
    'Codex native Goal remains the sole persisted source of truth.'
  ].join('\n');
}

export async function prepareRoute(root: any, prompt: any, state: any = {}, opts: any = {}): Promise<any> {
  const cleanPrompt = stripVisibleDecisionAnswerBlocks(prompt);
  const selectedRoute = routePrompt(cleanPrompt);
  const explicitlyInvokedSkills = explicitManagedSkillNames(cleanPrompt);
  const route = selectedRoute ? {
    ...selectedRoute,
    requiredSkills: managedSkillNamesForPrompt(selectedRoute, cleanPrompt)
  } : null;
  const codexThreadId = String(process.env.CODEX_THREAD_ID || '').trim();
  const sessionKey = opts.sessionKey || codexThreadId || state?._session_key || null;
  const madSksAuthorization = hasMadSksSignal(cleanPrompt);
  const task = stripDollarCommand(stripMadSksSignal(cleanPrompt)) || stripMadSksSignal(stripDollarCommand(cleanPrompt)) || String(cleanPrompt || '').trim();
  const explicit = Boolean(dollarCommand(cleanPrompt));
  if (!route) return { route: null, additionalContext: promptPipelineContext(prompt, null) };
  const dreamContext = await routeSkillDreamContext(root, route, task);
  const required = routeNeedsContext7(route, cleanPrompt);
  const reasoning = routeReasoning(route, cleanPrompt);
  const subagentsRequired = routeRequiresSubagents(route, cleanPrompt);
  const finish = async (prepared: any) => {
    const materialized = subagentsRequired && !['Naruto', 'Goal'].includes(route.id)
      ? await materializeOfficialSubagentOverlay(root, prepared, route, task, { sessionKey, parentModel: opts.parentModel || null })
      : prepared;
    return withSkillDreamContext(materialized, dreamContext);
  };
  if (route.id === 'DFix') return finish(await prepareDfixQuickRoute(route, task));
  if (route.id === 'Answer') return finish(await prepareAnswerOnlyRoute(route, task));
  if (route.id === 'ComputerUse') return finish(await prepareComputerUseFastRoute(route, task));
  if (route.id === 'Wiki') return finish(await prepareWikiQuickRoute(route, task));
  if (route.id === 'Goal') return finish(await prepareGoalNativeOnlyRoute(route, task));
  if (route.id === 'ImageUXReview') return finish(await prepareImageUxReview(root, route, task, required, { sessionKey }));
  if (route.id === 'MadSKS') return finish(await prepareMadSksSqlPlane(root, route, task, required, { sessionKey }));
  if (route.id === 'DB' && madSksAuthorization) {
    const madRouteBase = routePrompt('$MAD-SKS');
    if (!madRouteBase) throw new Error('mad_sks_route_missing');
    const madRoute = {
      ...madRouteBase,
      requiredSkills: Array.from(new Set([
        ...(route.requiredSkills || []),
        ...(madRouteBase.requiredSkills || [])
      ]))
    };
    const prepared = await prepareMadSksSqlPlane(root, madRoute, task, routeNeedsContext7(madRoute, cleanPrompt), { sessionKey });
    return withSkillDreamContext(prepared, dreamContext);
  }
  if (QUESTION_GATE_ROUTES.has(route.id)) return finish(await prepareClarificationGate(root, route, task, required, { madSksAuthorization, sessionKey }));
  if (route.id === 'Naruto' && subagentsRequired) return finish(await prepareNaruto(root, route, task, required, { madSksAuthorization, sessionKey, parentModel: opts.parentModel || null }));
  if (route.id === 'Naruto') return finish(await prepareLightRoute(root, parentOwnedProfileRoute(route, explicitlyInvokedSkills), task, required, { sessionKey }));
  if (route.id === 'Research') return finish(await prepareResearch(root, route, task, required, { sessionKey }));
  if (route.id === 'AutoResearch') return finish(await prepareAutoResearch(root, route, task, required, { sessionKey }));
  if (route.id === 'Align') return finish(await prepareAlign(root, route, task, required, { sessionKey }));
  if (route.id === 'DB') return finish(await prepareDb(root, route, task, required, { sessionKey }));
  if (route.id === 'GX') return finish(await prepareGx(root, route, task, required, { sessionKey }));
  if (explicit || required) return finish(await prepareLightRoute(root, route, task, required, { sessionKey }));
  return finish({
    route,
    additionalContext: `${promptPipelineContext(prompt, route)}\n\nReasoning: ${reasoning.effort} (${reasoning.reason}); temporary profile ${reasoning.profile}.\nRequired skills: ${route.requiredSkills.join(', ')}.\nOfficial subagents required: ${subagentsRequired ? 'yes' : 'no'}.`
  });
}

function parentOwnedProfileRoute(route: any, explicitlyInvokedSkills: readonly string[] = []) {
  return {
    ...route,
    id: 'SKS',
    command: '$SKS',
    mode: 'SKS',
    route: 'profiled parent-owned execution',
    description: 'Parent-owned bounded execution selected by the task profile; no subagent workflow is required.',
    requiredSkills: Array.from(new Set([
      'sks-pipeline-runner',
      'sks-prompt-pipeline',
      'sks-honest-mode',
      ...explicitlyInvokedSkills
    ])),
    lifecycle: ['task_profile', 'ownership', 'focused_implementation', 'listed_verification', 'honest_summary'],
    stopGate: 'honest_mode',
    coverage_required: false,
    explicit_invocation: false
  };
}

async function routeSkillDreamContext(root: any, route: any, task: any) {
  try {
    const counterKey = path.resolve(root);
    const observed = (SKILL_DREAM_HOT_PATH_COUNTERS.get(counterKey) || 0) + 1;
    SKILL_DREAM_HOT_PATH_COUNTERS.set(counterKey, observed);
    if (observed % SKILL_DREAM_POLICY.min_events_between_runs !== 0) return '';
    const result = await recordSkillDreamEvent(root, {
      route: route.id,
      command: route.command,
      required_skills: route.requiredSkills || [],
      prompt: task
    }, { event_count: SKILL_DREAM_POLICY.min_events_between_runs });
    if (!result.report) return '';
    return [
      'Skill dreaming threshold reached.',
      `Report: ${path.relative(root, result.report.report_path)}`,
      `Mode: ${result.report.apply_mode}; no_auto_delete=${result.report.no_auto_delete}.`,
      'Review keep/merge/prune/improve candidates before adding more generated skills.'
    ].join('\n');
  } catch (err: any) {
    return `Skill dreaming record failed: ${err.message || err}. Do not claim .sneakoscope/skills/dream-state.json was updated.`;
  }
}

function withSkillDreamContext(result: any, dreamContext: any) {
  if (!dreamContext) return result;
  return { ...result, additionalContext: `${result.additionalContext || ''}\n\n${dreamContext}`.trim() };
}

async function prepareDfixQuickRoute(route: any, task: any) {
  return {
    route,
    additionalContext: dfixQuickContext(task, route)
  };
}

async function prepareAnswerOnlyRoute(route: any, task: any) {
  return {
    route,
    additionalContext: answerOnlyContext(task, route)
  };
}

async function prepareComputerUseFastRoute(route: any, task: any) {
  return {
    route,
    additionalContext: computerUseFastContext(task, route)
  };
}

export function computerUseFastContext(prompt: any, route: any = routePrompt(prompt)) {
  const task = stripDollarCommand(prompt) || String(prompt || '').trim();
  return [
    `Native Computer Use fast lane active. Route: ${route?.command || '$Computer-Use'} (${route?.route || 'native Computer Use fast lane'}).`,
    responseLanguageInstruction(task),
    'Speed contract: do not enter Naruto, QA-LOOP clarification, repeated upfront TriWiki refresh, Context7, native-session orchestration, debate, reflection, or broad planning unless the user explicitly requests that heavier route.',
    `Task: ${task}`,
    'Execution order:',
    '1. Infer the smallest native Mac, desktop-app, OS-settings, or non-web visual target and acceptance from the prompt and current app context.',
    '2. Use Codex Computer Use directly only for that native/non-web action or inspection.',
    '3. If the target is browser, localhost, website, webapp, or web-based verification, leave this lane and use the Codex Chrome Extension gate; if the extension is missing, stop and ask the user to complete setup.',
    '4. If Computer Use is unavailable for a native/non-web target, mark native visual evidence unverified and stop with the exact blocker instead of switching tools.',
    '5. Apply only safe, directly requested fixes when the prompt asks for correction; otherwise report observed evidence only.',
    '6. At the end only, run `sks wiki refresh` or `sks wiki pack`, then `sks wiki validate .sneakoscope/wiki/context-pack.json` when the repo/runtime is available.',
    '7. Final response must include a short completion summary plus SKS Honest Mode: evidence used, tests/checks run, and any unverified native visual claims.',
    CODEX_WEB_VERIFICATION_POLICY,
    CODEX_COMPUTER_USE_ONLY_POLICY
  ].join('\n');
}

async function prepareWikiQuickRoute(route: any, task: any) {
  return {
    route,
    additionalContext: [
      `SKS wiki pipeline active. Route: ${route.command} (${route.route}).`,
      responseLanguageInstruction(task),
      `Task: ${task || 'refresh and validate TriWiki'}`,
      'Run policy: refresh/update/갱신 -> `sks wiki refresh` then validate; prune/clean/정리 -> `sks wiki refresh --prune` or dry-run prune first; pack -> `sks wiki pack` then validate.',
      stackCurrentDocsPolicyText(),
      'Report claims, anchors, trust, validation, and blockers. Do not create mission state, ask ambiguity-gate questions, open worker sessions, or run unrelated work.'
    ].join('\n')
  };
}

async function prepareImageUxReview(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir, mission } = await createMission(root, { mode: 'image-ux-review', prompt: task, sessionKey: opts.sessionKey });
  const contract = {
    prompt: task,
    answers: {
      TARGET_SURFACE: task,
      IMAGE_UX_REVIEW_SOURCE_IMAGES: []
    },
    sealed_hash: null,
    mission_id: id
  };
  const artifacts = await writeImageUxReviewRouteArtifacts(dir, contract);
  await writeJsonAtomic(path.join(dir, 'route-context.json'), {
    route: route.id,
    command: route.command,
    mode: route.mode,
    task,
    mission_id: mission.id,
    required_skills: route.requiredSkills,
    context7_required: required,
    context_tracking: triwikiContextTracking(),
    stop_gate: route.stopGate,
    artifact_policy: 'imagegen_generated_review_image_required_before_issue_extraction'
  });
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'IMAGE_UX_REVIEW_READY', required, {
    prompt: task,
    implementation_allowed: true,
    ambiguity_gate_required: false,
    ambiguity_gate_passed: true,
    stop_gate: route.stopGate,
    image_ux_review_gate_ready: true,
    image_ux_review_policy_ready: true,
    ...pipelinePlanState(pipelinePlan)
  }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, `Capture or attach source UI screenshots, run Codex App $imagegen/gpt-image-2 to generate annotated review images, extract those generated images into ${IMAGE_UX_REVIEW_ISSUE_LEDGER_ARTIFACT}, then update ${IMAGE_UX_REVIEW_GATE_ARTIFACT}. ${CODEX_IMAGEGEN_REQUIRED_POLICY} Initial gate blockers: ${(artifacts.gate.blockers || []).join(', ') || 'none'}.`);
}

export async function activeRouteContext(root: any, state: any) {
  if (!state?.route && !state?.mode) return '';
  const id = state.route || state.mode;
  const reasoningNote = state.reasoning_effort ? ` Temporary reasoning remains ${state.reasoning_effort} (${state.reasoning_profile}); return to the default profile after this route completes.` : '';
  const planNote = await activePipelinePlanNote(root, state);
  if (state.honest_loop_required || /HONEST_LOOPBACK_AFTER_CLARIFICATION/.test(String(state.phase || ''))) {
    return `SKS Honest Mode found unresolved gaps for ${state.route_command || state.route || state.mode}. Do not ask ambiguity questions again. Continue from the sealed decision-contract.json, inspect .sneakoscope/missions/${state.mission_id}/honest-loopback.json, fix gaps, rerun verification, refresh/validate TriWiki, then retry final Honest Mode.${reasoningNote}${planNote}`;
  }
  if (state.clarification_required && String(state.phase || '').includes('CLARIFICATION_AWAITING_ANSWERS')) {
    return clarificationAwaitingAnswersContext(root, state);
  }
  if (state.clarification_passed && String(state.phase || '').includes('CLARIFICATION_CONTRACT_SEALED')) {
    return `Route contract sealed for ${state.route_command || state.route || state.mode}. Use decision-contract.json and ${PIPELINE_PLAN_ARTIFACT} before executing the route. Before the next route phase, read relevant TriWiki context, hydrate low-trust claims from source, and refresh/validate TriWiki again after new findings or artifact changes. Next atomic action: continue the original route lifecycle with the inferred goal, constraints, non-goals, risk boundary, and test scope.${planNote}`;
  }
  if (state.mode === 'NARUTO') {
    if (state.session_scope) {
      const parentEvidenceState = await appNarutoParentEvidenceState(root, state);
      if (parentEvidenceState === 'completed') {
        return `Active Codex App Naruto mission ${state.mission_id || 'latest'} has trustworthy current-run parent evidence and a passed Naruto gate. Do not resubmit or expose the sks.subagent-parent-summary.v1 JSON. Return concise Markdown in the user's language with an explicit completion summary, verification, remaining gaps, and Honest Mode.${reasoningNote}${planNote}`;
      }
      if (parentEvidenceState === 'blocked') {
        return `Active Codex App Naruto mission ${state.mission_id || 'latest'} has trustworthy current-run blocked or failed parent evidence. Do not resubmit or expose the sks.subagent-parent-summary.v1 JSON. Return concise Markdown in the user's language that states the blocker or failure first, avoids completion or success wording, and includes verification, remaining gaps, and Honest Mode.${reasoningNote}${planNote}`;
      }
      return `Active Codex App Naruto mission ${state.mission_id || 'latest'} uses the official Codex subagent workflow. Read subagent-plan.json, keep ${SUBAGENT_EVENT_LOG_FILENAME} and ${SUBAGENT_EVIDENCE_FILENAME} current from SubagentStart/SubagentStop, and wait for all requested agent threads. Build the exact sks.subagent-parent-summary.v1 object with run_id matching subagent-plan.json.workflow_run_id, then send it only through stdin to "sks naruto parent-summary --mission ${state.mission_id} --stdin --json". Do not expose, paste, embed, quote, or fence that JSON in the user-visible response. Only after the command accepts it, return concise Markdown in the user's language with completion summary, verification, remaining gaps/blockers, and Honest Mode. A successful response must visibly include the completion summary and Honest Mode assessment. If any parent/thread status is blocked or failed, or blockers remain, state that first and do not use completion or success wording. Do not substitute process counts, PID evidence, retired process-pool artifacts, or a custom active pool.${reasoningNote}${planNote}`;
    }
    return `Active Naruto mission ${state.mission_id || 'latest'} uses the official Codex subagent workflow. Read subagent-plan.json, keep ${SUBAGENT_EVENT_LOG_FILENAME} and ${SUBAGENT_EVIDENCE_FILENAME} current from SubagentStart/SubagentStop, wait for all requested agent threads, then return the exact sks.subagent-parent-summary.v1 JSON result so SKS can persist ${SUBAGENT_PARENT_SUMMARY_FILENAME} and derive naruto-summary.json/naruto-gate.json. Do not substitute process counts, PID evidence, retired process-pool artifacts, or a custom active pool.${reasoningNote}${planNote}`;
  }
  if (state.subagents_required && !(await hasSubagentEvidence(root, state))) {
    return `Active SKS route ${id} requires official subagent evidence before completion. Delegate independent slices to worker/expert custom agents, record matched SubagentStart/SubagentStop thread ids, wait for every requested agent thread, and provide the parent integration summary.${reasoningNote}${planNote}`;
  }
  if (state.mode === 'GOAL') return `Legacy SKS Goal state ${state.mission_id || 'latest'} is non-authoritative. Do not update its mission or artifacts; use Codex native /goal controls as the sole persisted Goal surface.${planNote}`;
  if (state.context7_required && !(await hasContext7DocsEvidence(root, state))) {
    return `Active SKS route ${id} still requires Context7 evidence. Use resolve-library-id, then query-docs for relevant docs/APIs before completing.${reasoningNote}${planNote}`;
  }
  return planNote.trim();
}

async function appNarutoParentEvidenceState(root: any, state: any): Promise<'completed' | 'blocked' | null> {
  const missionId = String(state?.mission_id || '').trim();
  const workflowRunId = String(state?.official_subagent_run_id || '').trim();
  if (!missionId || !workflowRunId) return null;
  const dir = missionDir(root, missionId);
  const [evidence, summary, gate] = await Promise.all([
    subagentEvidence(root, state).catch(() => null),
    readJson(path.join(dir, NARUTO_SUMMARY_FILENAME), null).catch(() => null),
    readJson(path.join(dir, NARUTO_GATE_FILENAME), null).catch(() => null)
  ]);
  const currentRun = evidence?.run_id === workflowRunId
    && summary?.workflow_run_id === workflowRunId
    && gate?.workflow_run_id === workflowRunId;
  if (!currentRun || evidence?.parent_summary_trustworthy !== true) return null;
  if (evidence.ok === true
    && evidence.status === 'completed'
    && summary?.status === 'completed'
    && summary?.completion_evidence === true
    && gate?.passed === true
    && gate?.terminal === true
    && gate?.terminal_state === 'completed') {
    return 'completed';
  }
  if (['blocked', 'failed'].includes(String(evidence.parent_summary_status || ''))
    && ['blocked', 'incomplete'].includes(String(summary?.status || ''))
    && summary?.completion_evidence !== true
    && gate?.passed !== true
    && gate?.terminal_state === 'blocked') {
    return 'blocked';
  }
  return null;
}

async function activePipelinePlanNote(root: any, state: any = {}) {
  if (!state?.mission_id) return '';
  const plan = await readJson(path.join(missionDir(root, state.mission_id), PIPELINE_PLAN_ARTIFACT), null);
  if (!plan) return '';
  const lane = plan.runtime_lane?.lane || 'unknown';
  const kept = plan.stage_summary?.kept ?? plan.kept_stages?.length ?? 0;
  const skipped = plan.stage_summary?.skipped ?? plan.skipped_stages?.length ?? 0;
  const next = Array.isArray(plan.next_actions) && plan.next_actions.length ? ` Next planned action: ${plan.next_actions[0]}.` : '';
  const intake = plan.request_intake?.artifact ? ` Request intake: .sneakoscope/missions/${state.mission_id}/${plan.request_intake.artifact}; execution prompt=${plan.request_intake.transformed_prompt_available ? 'available' : 'missing'}.` : '';
  return ` Pipeline plan: .sneakoscope/missions/${state.mission_id}/${PIPELINE_PLAN_ARTIFACT} (${lane}; kept=${kept}, skipped=${skipped}).${intake}${next}`;
}

async function prepareGoalNativeOnlyRoute(route: any, task: any): Promise<any> {
  return {
    route,
    additionalContext: goalNativeOnlyContext(`${route.command || '$Goal'} ${task}`.trim(), route),
    native_goal_only: true,
    state_written: false
  };
}

async function prepareClarificationGate(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir, mission } = await createMission(root, { mode: String(route.mode || route.id || 'route').toLowerCase(), prompt: task, sessionKey: opts.sessionKey });
  const schema = buildQuestionSchemaForRoute(route, task);
  if (opts.madSksAuthorization) applyMadSksAuthorizationToSchema(schema);
  await writeQuestions(dir, schema);
  const routeContext = { route: route.id, command: route.command, mode: route.mode, task, required_skills: route.requiredSkills, context7_required: required, original_stop_gate: route.stopGate, clarification_gate: true, mad_sks_authorization: Boolean(opts.madSksAuthorization || route.id === 'MadSKS') };
  await writeJsonAtomic(path.join(dir, 'route-context.json'), routeContext);
  {
    await writeJsonAtomic(path.join(dir, 'answers.json'), autoAnswersForSchema(schema));
    const result = await sealContract(dir, mission);
    let materialized: any = {};
    if (result.ok && route?.id === 'MadSKS') {
      materialized = await materializeAutoSealedMadSks(dir, id, route, routeContext, result.contract || {});
    } else if (result.ok && route?.id === 'QALoop') {
      const artifactResult = await writeQaLoopArtifacts(dir, mission, result.contract);
      materialized = {
        phase: 'QALOOP_CLARIFICATION_CONTRACT_SEALED',
        prompt: routeContext.task || task,
        state: {
          qa_loop_artifacts_ready: true,
          qa_report_file: artifactResult.report_file,
          qa_checklist_count: artifactResult.checklist_count,
          questions_allowed: false
        }
      };
    } else if (result.ok && route?.id === 'PPT') {
      await writePptRouteArtifacts(dir, result.contract);
      materialized = {
        phase: 'PPT_AUDIENCE_STRATEGY_READY',
        prompt: routeContext.task || task,
        state: {
          ppt_audience_strategy_ready: true,
          ppt_gate_ready: true,
          questions_allowed: false
        }
      };
    }
    const effectiveTask = materialized.prompt || task;
    const plan = await writePipelinePlan(dir, { missionId: id, route, task: effectiveTask, required, ambiguity: { required: true, slots: 0, auto_sealed: result.ok, passed: result.ok, contract_hash: result.contract?.sealed_hash || null } });
    await appendJsonl(path.join(dir, 'events.jsonl'), { ts: nowIso(), type: 'route.clarification.auto_sealed', route: route.id, slots: 0, ok: result.ok });
    await setCurrent(root, routeState(id, route, result.ok ? (materialized.phase || `${route.mode}_CLARIFICATION_CONTRACT_SEALED`) : `${route.mode}_CLARIFICATION_AWAITING_ANSWERS`, required, {
      prompt: effectiveTask,
      questions_allowed: false,
      implementation_allowed: result.ok,
      clarification_required: false,
      clarification_passed: result.ok,
      ambiguity_gate_required: true,
      ambiguity_gate_passed: result.ok,
      ...pipelinePlanState(plan),
      original_stop_gate: route.stopGate,
      stop_gate: route.stopGate,
      ...(materialized.state || {})
    }), { sessionKey: opts.sessionKey });
    const materializedLine = materialized.phase ? `\nRoute artifacts were materialized immediately; state advanced to ${materialized.phase}.` : '';
    return {
      route,
      mission_id: id,
      additionalContext: `${promptPipelineContext(task, route)}

Route contract auto-sealed for ${route.command}: contract answers were inferred from the prompt, TriWiki/current-code defaults, and conservative SKS safety policy.
Mission: ${id}
Decision contract: .sneakoscope/missions/${id}/decision-contract.json
Resolved answers: .sneakoscope/missions/${id}/resolved-answers.json
Pipeline plan: .sneakoscope/missions/${id}/${PIPELINE_PLAN_ARTIFACT}
${materializedLine}
Next atomic action: continue the original route lifecycle with the sealed decision-contract.json.`
    };
  }
}

function autoAnswersForSchema(schema: any = {}) {
  const answers = { ...(schema.inferred_answers || {}) };
  for (const slot of schema.slots || []) {
    if (answers[slot.id] !== undefined) continue;
    if (slot.options) answers[slot.id] = slot.type === 'array' ? [slot.options[0]] : slot.options[0];
    else if (slot.type === 'array' || slot.type === 'array_or_string') answers[slot.id] = [];
    else answers[slot.id] = slot.id === 'DB_MAX_BLAST_RADIUS' ? 'no_live_dml' : 'infer_from_prompt_triwiki_and_current_code';
  }
  return answers;
}

function applyMadSksAuthorizationToSchema(schema: any = {}) {
  schema.domain_hints = Array.from(new Set([...(schema.domain_hints || []), 'mad-sks']));
  schema.inferred_answers = {
    ...(schema.inferred_answers || {}),
    MAD_SKS_MODE: 'explicit_invocation_only',
    DATABASE_TARGET_ENVIRONMENT: 'main_branch',
    DATABASE_WRITE_MODE: 'mad_sks_full_mcp_write_for_invocation',
    SUPABASE_MCP_POLICY: 'mad_sks_project_scoped_write_for_invocation',
    DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'mad_sks_scoped_except_catastrophic_db_wipe',
    DB_BACKUP_OR_BRANCH_REQUIRED: 'recommended_but_not_required_in_mad_sks',
    DB_MAX_BLAST_RADIUS: 'mad_sks_active_invocation_only_catastrophic_wipe_blocked',
    DB_MIGRATION_APPLY_ALLOWED: 'mad_sks_active_invocation_only',
    DB_READ_ONLY_QUERY_LIMIT: '100'
  };
  schema.inference_notes = {
    ...(schema.inference_notes || {}),
    MAD_SKS_MODE: 'explicit dollar command modifier is the permission boundary',
    DESTRUCTIVE_DB_OPERATIONS_ALLOWED: 'MAD-SKS opens live-server DB changes, Supabase MCP cleanup, direct SQL, and needed migrations while blocking only catastrophic database wipe operations'
  };
  schema.slots = (schema.slots || []).filter((slot: any) => !/^(DB_|DATABASE_|DESTRUCTIVE_DB_|SUPABASE_MCP_POLICY$)/.test(slot.id));
  return schema;
}

async function materializeAutoSealedMadSks(dir: any, id: any, route: any, routeContext: any = {}, contract: any = {}) {
  await writeJsonAtomic(path.join(dir, 'mad-sks-gate.json'), {
    schema_version: 1,
    passed: false,
    mad_sks_permission_active: true,
    permissions_deactivated: false,
    supabase_mcp_schema_cleanup_allowed: true,
    direct_execute_sql_allowed: true,
    normal_db_writes_allowed: true,
    live_server_writes_allowed: true,
    migration_apply_allowed: true,
    sql_plane: {
      requested: false,
      capability_id: null,
      operation_classes: [],
      read_back_passed: false,
      profile_closed: false
    },
    catastrophic_safety_guard_active: true,
    permission_profile: permissionGateSummary(),
    contract_hash: contract.sealed_hash || null
  });
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mad_sks.scoped_permission_opened',
    route: route?.id || 'MadSKS',
    catastrophic_safety_guard_active: true
  });
  return {
    phase: 'MADSKS_SCOPED_PERMISSION_ACTIVE',
    prompt: routeContext.task || '',
    state: {
      mad_sks_active: true,
      mad_sks_modifier: true,
      mad_sks_gate_file: 'mad-sks-gate.json',
      mad_sks_gate_ready: true,
      supabase_mcp_schema_cleanup_allowed: true,
      direct_execute_sql_allowed: true,
      normal_db_writes_allowed: true,
      live_server_writes_allowed: true,
      migration_apply_allowed: true,
      catastrophic_safety_guard_active: true
    }
  };
}

async function materializeMadSksAuthorization(dir: any, id: any, route: any, routeContext: any = {}, contract: any = {}) {
  if (!routeContext.mad_sks_authorization || route?.id === 'MadSKS') return {};
  const gateFile = route?.stopGate || 'done-gate.json';
  await writeJsonAtomic(path.join(dir, 'mad-sks-authorization.json'), {
    schema_version: 1,
    mission_id: id,
    route: route?.command || route?.id || null,
    status: 'active',
    active_only_for_current_route: true,
    deactivates_when_gate_passed: gateFile,
    supabase_mcp_schema_cleanup_allowed: true,
    direct_execute_sql_allowed: true,
    normal_db_writes_allowed: true,
    live_server_writes_allowed: true,
    migration_apply_allowed: true,
    catastrophic_safety_guard_active: true,
    permission_profile: permissionGateSummary(),
    contract_hash: contract.sealed_hash || null
  });
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mad_sks.modifier_authorization_opened',
    route: route?.id || null,
    gate: gateFile,
    catastrophic_safety_guard_active: true
  });
  return {
    mad_sks_active: true,
    mad_sks_modifier: true,
    mad_sks_gate_file: gateFile,
    supabase_mcp_schema_cleanup_allowed: true,
    direct_execute_sql_allowed: true,
    normal_db_writes_allowed: true,
    live_server_writes_allowed: true,
    migration_apply_allowed: true,
    catastrophic_safety_guard_active: true
  };
}

async function prepareResearch(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: 'research', prompt: task, sessionKey: opts.sessionKey });
  const researchPlan = await writeResearchPlan(dir, task, {});
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'RESEARCH_PREPARED', required, { prompt: task, ...pipelinePlanState(pipelinePlan) }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, `Run sks research run latest as a real long-running source-gathering pass, never an automatic mock fallback; do not modify repository source code. Run layered Super Search first and allow only correlated verified-content rows to support real claims. Then run exactly three independent official research_reviewer threads on GPT-5.6 Sol Max. Any objection requires a mission-local research_synthesizer revision and a fresh three-thread review cycle; do not launch a custom scheduler or debate pool. Keep subagent-plan.json, subagent-events.jsonl, subagent-parent-summary.json, and subagent-evidence.json current, write research-report.md and ${researchPaperArtifactForPlan(researchPlan)}, and pass the adversarial convergence, Honest Mode, and research-gate.json checks.`);
}

async function prepareAutoResearch(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: 'autoresearch', prompt: task, sessionKey: opts.sessionKey });
  await writeJsonAtomic(path.join(dir, 'autoresearch-plan.json'), { schema_version: 1, task, loop: ['program', 'hypothesis', 'experiment', 'measure', 'keep_or_discard', 'falsify', 'honest_conclusion'] });
  await writeJsonAtomic(path.join(dir, 'experiment-ledger.json'), { schema_version: 1, entries: [] });
  await writeJsonAtomic(path.join(dir, 'autoresearch-gate.json'), { passed: false, experiment_ledger_present: true, metric_present: false, keep_or_discard_decision: false, falsification_present: false, honest_conclusion: false, context7_evidence: false });
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'AUTORESEARCH_EXPERIMENT_LOOP', required, { prompt: task, ...pipelinePlanState(pipelinePlan) }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, 'Run the smallest useful experiment loop, update experiment-ledger.json, falsify the result, and pass autoresearch-gate.json.');
}

async function prepareDb(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: 'db', prompt: task, sessionKey: opts.sessionKey });
  const [scan, accessCandidates] = await Promise.all([
    scanDbSafety(root, { includeMigrations: true }).catch((err: any) => ({ ok: false, findings: [{ id: 'db_scan_failed', severity: 'high', reason: err.message }] })),
    scanDbAccessCandidates(root)
  ]);
  await writeJsonAtomic(path.join(dir, 'db-safety-scan.json'), scan);
  await writeJsonAtomic(path.join(dir, DB_ACCESS_CANDIDATES_ARTIFACT), accessCandidates);
  await writeJsonAtomic(path.join(dir, DB_REVIEW_ARTIFACT), createDbReviewSeed(scan.ok));
  await writeJsonAtomic(path.join(dir, DB_ACCESS_REVIEW_ARTIFACT), createDbAccessReviewSeed(accessCandidates));
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'DB_REVIEW_REQUIRED', required, {
    prompt: task,
    db_access_review_required: true,
    ...pipelinePlanState(pipelinePlan)
  }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, `Inspect the real DB entry points and callers first, then complete ${DB_ACCESS_REVIEW_ARTIFACT} for canonical adapter/query-helper reuse, pool ownership/acquire/release/shutdown/exhaustion, N+1/repeated I/O, and sensitive transaction integrity. Outside MAD-SKS, do not mutate any database: when a migration is required, finish with exactly one mission-local ${DB_MANUAL_MIGRATION_ARTIFACT} containing active forward SQL and a complete rollback section that remains commented out, record its SHA-256 and manual-apply notice in ${DB_REVIEW_ARTIFACT}, and tell the user to apply it directly. Only an active capability-v2 MAD-SKS SQL-plane may execute through MCP, with independent read-back and final read-only restoration.`);
}

async function prepareMadSksSqlPlane(root: any, route: any, task: any, required: any, opts: any = {}) {
  const prepared = await prepareMadSksSqlPlaneMission({ root, task, verifyTools: false, sessionKey: opts.sessionKey, route: 'MadSKS', routeCommand: '$MAD-SKS' });
  const dir = missionDir(root, prepared.mission_id);
  const accessCandidates = await scanDbAccessCandidates(root);
  await writeJsonAtomic(path.join(dir, DB_ACCESS_CANDIDATES_ARTIFACT), accessCandidates);
  if (!(await exists(path.join(dir, DB_ACCESS_REVIEW_ARTIFACT)))) {
    await writeJsonAtomic(path.join(dir, DB_ACCESS_REVIEW_ARTIFACT), createDbAccessReviewSeed(accessCandidates));
  }
  const pipelinePlan = await writePipelinePlan(dir, {
    missionId: prepared.mission_id,
    route,
    task,
    required,
    ambiguity: { required: true, slots: 0, auto_sealed: true, passed: true, contract_hash: prepared.capability.operator_intent_hash }
  });
  await appendJsonl(path.join(dir, 'events.jsonl'), {
    ts: nowIso(),
    type: 'mad_sks_sql_plane.route_prepared',
    mission_id: prepared.mission_id,
    cycle_id: prepared.cycle_id,
    blockers: prepared.blockers
  });
  await setCurrent(root, routeState(prepared.mission_id, route, prepared.ok ? 'MADSKS_SQL_PLANE_CAPABILITY_ACTIVE' : 'MADSKS_SQL_PLANE_BLOCKED', required, {
    prompt: task,
    questions_allowed: false,
    implementation_allowed: prepared.ok,
    ambiguity_gate_required: true,
    ambiguity_gate_passed: true,
    mad_sks_sql_plane_active: prepared.ok,
    mad_sks_sql_plane_cycle_id: prepared.cycle_id,
    mad_sks_sql_plane_runtime_session_id: prepared.capability.runtime_session_id,
    mad_sks_sql_plane_profile_sha256: prepared.capability.transport.profile_sha256,
    mad_sks_sql_plane_capability_mission_id: prepared.mission_id,
    mad_sks_sql_plane_capability_file: madSksSqlPlaneRelativePath(MAD_SKS_SQL_PLANE_CAPABILITY_FILE),
    mad_sks_gate_file: 'mad-sks-gate.json',
    db_access_review_required: true,
    stop_gate: 'mad-sks-gate.json',
    ...pipelinePlanState(pipelinePlan)
  }), { sessionKey: opts.sessionKey });
  return routeContext(route, prepared.mission_id, task, required, `MAD-SKS SQL-plane mission/capability/profile were created atomically for cycle ${prepared.cycle_id}. Inspect the existing canonical DB access and complete ${DB_ACCESS_REVIEW_ARTIFACT} before mutation. Then verify Supabase MCP tool inventory exposes execute_sql and apply_migration, execute the requested SQL immediately through the bound MCP SQL-plane rather than generating a manual migration file, independently read back the postconditions, and finally close the profile/capability and prove normal read-only restoration.`);
}

async function prepareGx(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: 'gx', prompt: task, sessionKey: opts.sessionKey });
  await writeJsonAtomic(path.join(dir, 'gx-gate.json'), { passed: false, vgraph_beta_render: false, validation: false, drift_snapshot: false, context7_evidence: false });
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'GX_VALIDATE_REQUIRED', required, { prompt: task, ...pipelinePlanState(pipelinePlan) }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, 'Run sks gx init/render/validate/drift/snapshot, then pass gx-gate.json.');
}

async function prepareAlign(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: 'align', prompt: task, sessionKey: opts.sessionKey });
  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: id,
    route: route.command,
    prompt: task
  });
  const artifacts = await writeAlignRouteArtifacts(dir, id, task);
  await writeJsonAtomic(path.join(dir, 'route-context.json'), {
    route: route.id,
    command: route.command,
    mode: route.mode,
    task,
    mission_id: id,
    required_skills: route.requiredSkills,
    context7_required: required,
    context_tracking: triwikiContextTracking(),
    stop_gate: route.stopGate,
    purpose: artifacts.plan.purpose,
    requires_cleanup_receipt: artifacts.plan.requires_cleanup_receipt,
    source_policy: artifacts.plan.source_policy,
    scan_limits: artifacts.plan.limits,
    acceptance: artifacts.plan.acceptance,
    outputs: artifacts.plan.outputs,
    artifacts: {
      plan: ALIGN_PLAN_ARTIFACT,
      ledger: ALIGN_LEDGER_ARTIFACT,
      gate: ALIGN_GATE_ARTIFACT,
      work_order_ledger: 'work-order-ledger.json'
    }
  });
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'direct_route' } });
  await setCurrent(root, routeState(id, route, 'ALIGN_PREPARED', required, {
    prompt: task,
    stop_gate: route.stopGate,
    ...pipelinePlanState(pipelinePlan)
  }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, alignNextActionText(id));
}

async function prepareLightRoute(root: any, route: any, task: any, required: any, opts: any = {}) {
  const { id, dir } = await createMission(root, { mode: route.id.toLowerCase(), prompt: task, sessionKey: opts.sessionKey });
  await writeJsonAtomic(path.join(dir, 'route-context.json'), { route: route.id, command: route.command, task, required_skills: route.requiredSkills, context7_required: required, context_tracking: triwikiContextTracking(), stop_gate: 'honest_mode' });
  const pipelinePlan = await writePipelinePlan(dir, { missionId: id, route, task, required, ambiguity: { required: false, status: 'light_route' } });
  await setCurrent(root, routeState(id, route, 'ROUTE_CONTEXT_READY', required, { prompt: task, stop_gate: 'none', ...pipelinePlanState(pipelinePlan) }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, task, required, 'Load the route skill context, execute the smallest matching action, and finish with Honest Mode.');
}

async function materializeOfficialSubagentOverlay(root: any, prepared: any, route: any, task: any, opts: any = {}) {
  const id = String(prepared?.mission_id || '').trim();
  if (!id) throw new Error(`official_subagent_overlay_mission_missing:${route?.id || 'unknown'}`);
  const dir = missionDir(root, id);
  const cleanTask = stripDollarCommand(task) || String(task || '').trim();
  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: id,
    route: route?.command || route?.id || 'official-subagent-overlay',
    prompt: cleanTask
  });
  const subagentOptions = officialSubagentOptionsFromTask(cleanTask);
  const requestedSubagents = subagentOptions.requestedSubagents;
  const observedParentModel = typeof opts.parentModel === 'string' && opts.parentModel.trim()
    ? opts.parentModel.trim()
    : null;
  const preparation = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: id,
    goal: cleanTask,
    route: route?.command || route?.id || 'specialized-route',
    sessionScope: opts.sessionKey || null,
    ...(requestedSubagents === undefined ? {} : { requestedSubagents }),
    requestedSubagentsExplicit: requestedSubagents !== undefined,
    ...(subagentOptions.maxThreads === undefined ? {} : { maxThreads: subagentOptions.maxThreads }),
    mode: 'generic',
    observedParentModel,
    preparationOnly: true,
    statePatch: ({ budget: preparedBudget, workflowRunId }) => ({
      mission_id: id,
      subagents_required: true,
      subagents_verified: false,
      native_sessions_required: false,
      native_sessions_verified: false,
      requested_subagents: preparedBudget.requestedSubagents,
      subagent_max_threads: preparedBudget.maxThreads,
      subagent_max_depth: preparedBudget.maxDepth,
      official_subagent_run_id: workflowRunId,
      session_scope: opts.sessionKey || null,
      subagent_plan_file: SUBAGENT_PLAN_FILENAME,
      subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME
    })
  });
  const { budget, delegationPrompt, plan } = preparation;
  await setCurrent(root, {
    mission_id: id,
    subagents_required: true,
    subagents_verified: false,
    native_sessions_required: false,
    native_sessions_verified: false,
    requested_subagents: budget.requestedSubagents,
    subagent_max_threads: budget.maxThreads,
    subagent_max_depth: budget.maxDepth,
    official_subagent_run_id: plan.workflow_run_id,
    session_scope: opts.sessionKey || null,
    subagent_plan_file: SUBAGENT_PLAN_FILENAME,
    subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME
  }, { sessionKey: opts.sessionKey });
  return {
    ...prepared,
    mission_id: id,
    additionalContext: [
      prepared.additionalContext,
      `Official Codex subagent overlay for ${route?.command || route?.id || 'this route'}: use ${SUBAGENT_PLAN_FILENAME}, record matched SubagentStart/SubagentStop events in ${SUBAGENT_EVENT_LOG_FILENAME}, and provide the required structured parent thread-outcome summary before this route's own gate can pass. This generic overlay does not create ${NARUTO_SUMMARY_FILENAME}, ${NARUTO_GATE_FILENAME}, or close the work-order ledger.`,
      delegationPrompt
    ].filter(Boolean).join('\n\n')
  };
}

async function prepareNaruto(root: any, route: any, task: any, required: any, opts: any = {}) {
  const cleanTask = stripDollarCommand(task) || String(task || '').trim();
  const fromChatImgRequired = hasFromChatImgSignal(cleanTask);
  const subagentOptions = officialSubagentOptionsFromTask(cleanTask);
  const requestedSubagents = subagentOptions.requestedSubagents;
  const observedParentModel = typeof opts.parentModel === 'string' && opts.parentModel.trim()
    ? opts.parentModel.trim()
    : null;
  const mission = opts.sessionKey
    ? await getOrCreateSessionMission(root, {
        mode: 'naruto',
        prompt: cleanTask,
        sessionKey: opts.sessionKey,
        selectMissionId: (state) => {
          const activeRoute = String(state?.route || state?.route_command || state?.mode || '').replace(/^\$/, '').toUpperCase();
          const sessionMatches = state?._session_key === sessionStateKey(opts.sessionKey);
          return sessionMatches && state?.mission_id && state?.route_closed !== true && activeRoute === 'NARUTO'
            ? String(state.mission_id)
            : null;
        }
      })
    : await createMission(root, { mode: 'naruto', prompt: cleanTask, sessionKey: opts.sessionKey });
  const { id, dir } = mission;
  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: id,
    route: 'Naruto',
    prompt: cleanTask
  });
  const preparation = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: id,
    goal: cleanTask,
    route: '$Naruto',
    sessionScope: opts.sessionKey || null,
    ...(requestedSubagents === undefined ? {} : { requestedSubagents }),
    requestedSubagentsExplicit: requestedSubagents !== undefined,
    ...(subagentOptions.maxThreads === undefined ? {} : { maxThreads: subagentOptions.maxThreads }),
    mode: 'naruto',
    observedParentModel,
    preparationOnly: true,
    statePatch: ({ budget: preparedBudget, workflowRunId: preparedRunId }) => ({
      mission_id: id,
      route: 'Naruto',
      route_command: '$Naruto',
      mode: 'NARUTO',
      phase: 'NARUTO_PREPARING',
      implementation_allowed: true,
      subagents_required: true,
      subagents_verified: false,
      native_sessions_required: false,
      native_sessions_verified: false,
      requested_subagents: preparedBudget.requestedSubagents,
      subagent_max_threads: preparedBudget.maxThreads,
      subagent_max_depth: preparedBudget.maxDepth,
      official_subagent_run_id: preparedRunId,
      session_scope: opts.sessionKey || null,
      subagent_plan_file: SUBAGENT_PLAN_FILENAME,
      subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME,
      stop_gate: NARUTO_GATE_FILENAME,
      naruto_gate_file: NARUTO_GATE_FILENAME,
      prompt: cleanTask
    })
  });
  const {
    budget,
    delegationPrompt,
    workflowRunId,
    taskProfile,
    officialConfig,
    triwikiAttention,
    parentModelMatch
  } = preparation;
  const routeContextPayload = {
    route: 'Naruto',
    command: '$Naruto',
    mode: 'NARUTO',
    task: cleanTask,
    required_skills: route.requiredSkills || ['sks-naruto', 'sks-pipeline-runner', 'sks-prompt-pipeline', 'sks-honest-mode'],
    context7_required: required,
    context_tracking: triwikiContextTracking(),
    stop_gate: NARUTO_GATE_FILENAME,
    workflow: 'official_codex_subagent',
    workflow_run_id: workflowRunId,
    session_scope: opts.sessionKey || null,
    requested_subagents: budget.requestedSubagents,
    requested_subagents_explicit: requestedSubagents !== undefined,
    max_threads: budget.maxThreads,
    max_depth: budget.maxDepth,
    parent_model_policy: NARUTO_PARENT_MODEL,
    observed_parent_model: observedParentModel,
    parent_model_match: parentModelMatch,
    config_sources: officialConfig.sources,
    config_blockers: officialConfig.blockers,
    triwiki_attention: triwikiAttention,
    from_chat_img_required: fromChatImgRequired,
    mad_sks_authorization: Boolean(opts.madSksAuthorization)
  };
  await writeJsonAtomic(path.join(dir, 'route-context.json'), routeContextPayload);
  if (fromChatImgRequired) {
    const gate = await readJson(path.join(dir, NARUTO_GATE_FILENAME), {});
    await writeJsonAtomic(path.join(dir, NARUTO_GATE_FILENAME), {
      ...gate,
      from_chat_img_required: true,
      from_chat_img_request_coverage: false
    });
  }
  const pipelinePlan = await writePipelinePlan(dir, {
    missionId: id,
    route,
    task: cleanTask,
    taskProfile,
    required,
    forceRequestIntakeRewrite: mission.reused === true,
    ambiguity: { required: false, status: 'direct_naruto' }
  });
  await setCurrent(root, routeState(id, route, 'NARUTO_READY', required, {
    prompt: cleanTask,
    route: 'Naruto',
    route_command: '$Naruto',
    mode: 'NARUTO',
    implementation_allowed: true,
    ambiguity_gate_required: false,
    ambiguity_gate_passed: true,
    stop_gate: NARUTO_GATE_FILENAME,
    required_skills: routeContextPayload.required_skills,
    subagents_required: true,
    native_sessions_required: false,
    requested_subagents: budget.requestedSubagents,
    subagent_max_threads: budget.maxThreads,
    subagent_max_depth: budget.maxDepth,
    subagent_plan_file: SUBAGENT_PLAN_FILENAME,
    subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME,
    official_subagent_run_id: workflowRunId,
    session_scope: opts.sessionKey || null,
    observed_parent_model: observedParentModel,
    parent_model_match: parentModelMatch,
    from_chat_img_required: fromChatImgRequired,
    naruto_gate_file: NARUTO_GATE_FILENAME,
    ...pipelinePlanState(pipelinePlan)
  }), { sessionKey: opts.sessionKey });
  return routeContext(route, id, cleanTask, required, `Use the delegation context below in the current Codex parent session. First replace parent_required with a defensible independent/disjoint decomposition, then spawn and wait for every requested agent thread. Record official events and integrate the parent summary before passing ${NARUTO_GATE_FILENAME}.\n\n${delegationPrompt}`);
}

function officialSubagentOptionsFromTask(task: any): {
  requestedSubagents?: number;
  maxThreads?: number;
} {
  const text = String(task || '');
  const requestedSubagents = strictNarutoIntegerOption(text, '--agents');
  const maxThreads = strictNarutoIntegerOption(text, '--max-threads');
  return {
    ...(requestedSubagents === undefined ? {} : { requestedSubagents }),
    ...(maxThreads === undefined ? {} : { maxThreads })
  };
}

function strictNarutoIntegerOption(text: string, option: '--agents' | '--max-threads'): number | undefined {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flag = new RegExp(`(?:^|\\s)${escaped}(?:(?:=|\\s+)([^\\s]+))?`, 'gi');
  const matches = [...text.matchAll(flag)];
  if (!matches.length) return undefined;
  if (matches.length > 1) throw new Error(`duplicate_naruto_option:${option}`);
  const raw = String(matches[0]?.[1] || '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`invalid_naruto_option:${option}`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > HARD_NARUTO_MAX_THREADS) {
    throw new Error(
      `naruto_option_out_of_range:${option}:${raw}:1-${HARD_NARUTO_MAX_THREADS}`
    );
  }
  return parsed;
}

function routeState(id: any, route: any, phase: any, context7Required: any, extra: any = {}) {
  const reasoning = routeReasoning(route, extra.prompt || '');
  const subagentsRequired = routeRequiresSubagents(route, extra.prompt || '');
  // Default off: only a caller that spread pipelinePlanState(plan) — i.e. a
  // plan that seeded engineering-sanity-review.json — may turn this gate on.
  return { mission_id: id, route: route.id, route_command: route.command, mode: route.mode, phase, context7_required: context7Required, context7_verified: false, subagents_required: subagentsRequired, subagents_verified: !subagentsRequired, native_sessions_required: false, native_sessions_verified: false, reflection_required: reflectionRequiredForRoute(route), engineering_sanity_required: false, engineering_sanity_scope_base: null, architecture_map_required: false, visible_progress_required: true, context_tracking: 'triwiki', required_skills: route.requiredSkills, stop_gate: route.stopGate, reasoning_effort: reasoning.effort, reasoning_profile: reasoning.profile, reasoning_temporary: true, goal_continuation: ambientGoalContinuation(), ...extra };
}

function routeContext(route: any, id: any, task: any, required: any, next: any) {
  const visibleTask = stripVisibleDecisionAnswerBlocks(task);
  return {
    route,
    mission_id: id,
    additionalContext: `${promptPipelineContext(visibleTask, route)}

${route.command} route prepared.
Mission: ${id}
Task: ${visibleTask}
Request intake: .sneakoscope/missions/${id}/${REQUEST_INTAKE_ARTIFACT}
Execution prompt: request-intake.transformed_prompt
Pipeline plan: .sneakoscope/missions/${id}/${PIPELINE_PLAN_ARTIFACT}
Required skills: ${route.requiredSkills.join(', ')}
Stop gate: ${route.stopGate}
Official subagents: ${routeRequiresSubagents(route, visibleTask) ? 'required for this explicit Naruto/parallel task; use independent disjoint slices, official agent threads, matched SubagentStart/SubagentStop events, and a parent integration summary.' : 'not required by this task profile; keep the work parent-owned unless a concrete independent decomposition emerges.'}
TriWiki: use only a coordinate+voxel-overlay context pack before each route phase, hydrate low-trust claims during the phase, refresh after new findings or artifact changes, and validate before handoffs/final claims. Coordinate-only packs are invalid and must be refreshed before pipeline decisions.
Final closeout: every pipeline final answer must summarize what was done, what changed for the user/repo, what was verified, and any remaining gaps.
${reflectionRequiredForRoute(route) ? `Reflection: ${reflectionInstructionText()}` : 'Reflection: not required for this lightweight route.'}
Reasoning: ${routeReasoning(route, visibleTask).effort} temporary; return to default after completion.
Goal continuation: ambient /goal overlay may be used for persistence when it helps completion, but route gates remain authoritative.
Next atomic action: ${next}`
  };
}

async function clarificationAwaitingAnswersContext(root: any, state: any) {
  const id = state.mission_id;
  if (!id) return '';
  const planNote = await activePipelinePlanNote(root, state);
  return `Active SKS route ${state.route_command || state.route || state.mode} is paused at its ambiguity gate and waiting for explicit user answers. Do not advance to implementation, tests, route materialization, or a new pipeline stage. If the user's reply is now available, seal it with "sks pipeline answer ${id} --stdin"; otherwise show only the missing slot ids from .sneakoscope/missions/${id}/questions.md and wait.${planNote}`;
}

function clarificationVisibleResponseContract(id: any) {
  const answerCommand = `sks pipeline answer ${id} --stdin`;
  return `

VISIBLE RESPONSE CONTRACT:
- Do not show a prequestion sheet in chat.
- Seal internally with inferred answers using \`${answerCommand}\`, or re-prepare the current prompt so the route auto-seals.`;
}

function clarificationPlanHint(route: any, id: any) {
  const command = `sks pipeline answer ${id} --stdin`;
  return `

Codex plan-tool interaction:
Use update_plan only for real execution work:
- in_progress: Auto-seal inferred route contract for ${route.command || '$SKS'}
- pending: Continue the original route lifecycle with decision-contract.json
Do not surface a prequestion sheet. If auto-sealing cannot proceed, use \`${command}\`.`;
}

function formatRequiredQuestions(schema: any) {
  return schema.slots.map((s: any, i: any) => {
    const options = s.options ? ` Options: ${s.options.join(', ')}.` : '';
    const examples = s.examples ? ` Examples: ${s.examples.join(', ')}.` : '';
    return `${i + 1}. ${s.id}: ${s.question}${options}${examples}`;
  }).join('\n');
}

export async function clarificationStopReason(root: any, state: any, kind: any) {
  const id = state?.mission_id || 'latest';
  const routeName = state?.route_command || state?.route || state?.mode || 'route';
  const files = state?.mission_id ? `
Answer schema: .sneakoscope/missions/${state.mission_id}/required-answers.schema.json` : '';
  const command = `sks pipeline answer ${id} --stdin`;
  const title = `SKS ${routeName} is paused for explicit user answers.`;
  return `${title}
Do not continue to implementation or the next pipeline stage until the ambiguity gate is sealed. Ask only the missing slot ids if they have not already been shown, then wait for the user. When the user's reply is available, seal it with "${command}".${files}

After the contract is sealed, continue the original ${routeName} route.`;
}

export async function recordContext7Evidence(root: any, state: any, payload: any) {
  const stage = context7Stage(payload);
  if (!stage) return null;
  if (!await shouldWritePipelineEvidence(root, state)) return null;
  const id = state?.mission_id;
  const file = id ? path.join(missionDir(root, id), 'context7-evidence.jsonl') : path.join(root, '.sneakoscope', 'state', 'context7-evidence.jsonl');
  const record = {
    ts: nowIso(),
    stage,
    tool: context7ToolName(payload),
    payload_keys: Object.keys(payload || {}).sort(),
    dedupe_key: context7DedupeKey(stage, payload)
  };
  if (await hasContext7EvidenceRecord(file, record.dedupe_key)) return null;
  await appendJsonl(file, record);
  if (id) {
    const evidence = await context7Evidence(root, state);
    await setCurrent(root, { context7_resolved: evidence.resolve, context7_docs: evidence.docs, context7_verified: evidence.ok }, { sessionKey: state._session_key });
  }
  return record;
}

export async function recordSubagentEvidence(root: any, state: any, payload: any) {
  if (!await shouldWritePipelineEvidence(root, state)) return null;
  const id = state?.mission_id;
  const dir = id ? missionDir(root, id) : path.join(root, '.sneakoscope', 'state', 'subagents');
  const explicitEventName = payload?.hook_event_name
    || payload?.hookEventName
    || payload?.event_name
    || payload?.eventName
    || payload?.event
    || null;
  const officialEvent = await recordSubagentEvent(dir, payload, explicitEventName);
  if (officialEvent) return officialEvent;
  return null;
}

async function shouldWritePipelineEvidence(root: any, state: any = {}) {
  if (state?.mission_id) return exists(missionDir(root, state.mission_id));
  return exists(path.join(root, '.sneakoscope', 'state', 'current.json'));
}

export async function subagentEvidence(root: any, state: any): Promise<any> {
  const id = state?.mission_id;
  if (!id) return { spawn: false, result: false, exception: false, ok: false, count: 0, workflow: 'official_codex_subagent' };
  const dir = missionDir(root, id);
  const plan = await readJson(path.join(dir, 'subagent-plan.json'), null).catch(() => null);
  if (plan?.workflow === 'official_codex_subagent') {
    const [events, persistedParentSummary, summary, canonical] = await Promise.all([
      readSubagentEvents(dir),
      readJson(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), null).catch(() => null),
      readJson(path.join(dir, 'naruto-summary.json'), null).catch(() => null),
      readJson(path.join(dir, SUBAGENT_EVIDENCE_FILENAME), null).catch(() => null)
    ]);
    const workflowRunId = String(plan.workflow_run_id || '').trim();
    const observedStarts = new Set(events
        .filter((event: any) => event.event_name === 'SubagentStart' && event.run_id === workflowRunId)
        .map((event: any) => event.thread_id)
        .filter(Boolean)).size;
    const countTarget = effectiveSubagentTarget(plan, observedStarts);
    const evidence = buildSubagentEvidence({
      requestedSubagents: countTarget.requestedSubagents,
      countPolicy: countTarget.countPolicy,
      targetSubagents: countTarget.targetSubagents,
      events,
      parentSummary: persistedParentSummary,
      workflowStatus: summary?.status || null,
      preparationOnly: summary?.status === 'delegation_context_ready' || canonical?.preparation_only === true,
      runId: workflowRunId || null,
      additionalBlockers: Array.isArray(plan.config_blockers)
        ? [
            ...plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`),
            ...subagentCountContractBlockers(plan, observedStarts)
          ]
        : subagentCountContractBlockers(plan, observedStarts)
    });
    const canonicalMismatch = canonicalEvidenceMismatch(normalizeLegacySubagentCountFields(canonical, plan), evidence);
    const blockers = [...new Set([
      ...(Array.isArray(evidence.blockers) ? evidence.blockers : []),
      ...(canonicalMismatch ? [canonicalMismatch] : [])
    ])];
    return {
      ...evidence,
      ok: evidence.ok === true && blockers.length === 0,
      blockers,
      spawn: evidence.started_threads > 0,
      result: evidence.completed_threads > 0,
      exception: evidence.failed_threads > 0,
      count: events.length
    };
  }
  return { spawn: false, result: false, exception: false, ok: false, count: 0, workflow: 'official_codex_subagent' };
}

function canonicalEvidenceMismatch(canonical: any, recomputed: any): string | null {
  if (canonical?.schema !== 'sks.subagent-evidence.v1' || canonical?.workflow !== 'official_codex_subagent') {
    return 'persisted_subagent_evidence_schema_invalid';
  }
  const scalarKeys = [
    'requested_subagents', 'count_policy', 'target_subagents', 'started_threads', 'completed_threads', 'failed_threads',
    'parent_summary_present', 'parent_summary_trustworthy', 'parent_summary_status',
    'preparation_only', 'status', 'ok'
  ];
  for (const key of scalarKeys) {
    if (canonical?.[key] !== recomputed?.[key]) return `persisted_subagent_evidence_mismatch:${key}`;
  }
  const arrayKeys = [
    'started_thread_ids', 'completed_thread_ids', 'failed_thread_ids', 'open_thread_ids',
    'unmatched_stop_thread_ids', 'ambiguous_stop_thread_ids', 'event_sources', 'blockers'
  ];
  for (const key of arrayKeys) {
    if (JSON.stringify(canonical?.[key] || []) !== JSON.stringify(recomputed?.[key] || [])) {
      return `persisted_subagent_evidence_mismatch:${key}`;
    }
  }
  return null;
}

export async function hasSubagentEvidence(root: any, state: any) {
  return officialSubagentEvidenceReady(await subagentEvidence(root, state));
}

function context7ToolName(payload: any) {
  const obj = payload || {};
  return String(obj.tool_name || obj.name || obj.tool?.name || obj.mcp_tool || obj.command || obj.type || '');
}

function context7Stage(payload: any) {
  const tool = context7ToolName(payload);
  const direct = context7DirectSignal(payload);
  if (!direct && !context7ToolLooksRelevant(tool)) return null;
  const hay = [tool, direct].filter(Boolean).join('\n');
  if (!/(context7|resolve[-_]?library[-_]?id|get[-_]?library[-_]?docs|query[-_]?docs)/i.test(hay)) return null;
  if (/resolve[-_]?library[-_]?id/i.test(hay)) return 'resolve-library-id';
  if (/get[-_]?library[-_]?docs|query[-_]?docs/i.test(hay)) return 'get-library-docs';
  return 'context7';
}

function context7ToolLooksRelevant(tool: any) {
  return /(^|[_:/.-])(context7|resolve[-_]?library[-_]?id|get[-_]?library[-_]?docs|query[-_]?docs)($|[_:/.-])/i.test(String(tool || ''));
}

function context7DirectSignal(payload: any = {}) {
  const source = String(payload.source || '');
  const tool = context7ToolName(payload);
  if (/^sks context7 evidence/i.test(source)) {
    return [
      tool,
      source,
      payload.library,
      payload.library_id,
      payload.docs_tool
    ].filter(Boolean).join('\n');
  }
  if (context7ToolLooksRelevant(tool)) {
    const input = payload.tool_input || payload.toolInput || payload.input || payload.tool?.input || {};
    return JSON.stringify({
      tool,
      library: payload.library,
      library_id: payload.library_id,
      docs_tool: payload.docs_tool,
      input: context7SafeInput(input)
    });
  }
  return '';
}

function context7SafeInput(input: any) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input ?? null;
  const out: Record<string, any> = {};
  for (const key of ['name', 'tool', 'library', 'libraryName', 'library_id', 'libraryId', 'context7CompatibleLibraryID', 'query', 'topic', 'tokens']) {
    if (Object.prototype.hasOwnProperty.call(input, key)) out[key] = input[key];
  }
  return out;
}

function context7DedupeKey(stage: any, payload: any = {}) {
  const input = payload.tool_input || payload.toolInput || payload.input || payload.tool?.input || {};
  const library = payload.library_id
    || payload.library
    || input.libraryId
    || input.context7CompatibleLibraryID
    || input.libraryName
    || input.library
    || '';
  const query = input.query || input.topic || payload.query || payload.topic || '';
  return [
    stage,
    context7ToolName(payload),
    String(library).trim().toLowerCase(),
    String(query).trim().toLowerCase()
  ].join('|');
}

async function hasContext7EvidenceRecord(file: any, key: any) {
  const text = await readText(file, '');
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.dedupe_key === key) return true;
    } catch {}
  }
  return false;
}

export async function context7Evidence(root: any, state: any) {
  const id = state?.mission_id;
  if (!id) return { resolve: false, docs: false, ok: false, count: 0 };
  const text = await readText(path.join(missionDir(root, id), 'context7-evidence.jsonl'), '');
  const lines = text.split(/\n/).filter(Boolean);
  let resolve = false;
  let docs = false;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.stage === 'resolve-library-id') resolve = true;
      if (entry.stage === 'get-library-docs') docs = true;
    } catch {}
  }
  return { resolve, docs, ok: resolve && docs, count: lines.length };
}

export async function hasContext7DocsEvidence(root: any, state: any) {
  return (await context7Evidence(root, state)).ok;
}

export { projectGateStatus, evaluateStop } from './runtime-gates.js';
