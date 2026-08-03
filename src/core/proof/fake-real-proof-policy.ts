import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import { normalizeProofRoute } from './route-proof-policy.js'
import {
  effectiveSubagentTarget,
  normalizeLegacySubagentCountFields,
  subagentCountContractBlockers
} from '../subagents/wave-lifecycle.js'
import { uniqueStrings } from '../text/strings.js'

export const FAKE_REAL_PROOF_POLICY_SCHEMA = 'sks.fake-real-proof-policy.v3'
export const OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY = 'official_codex_subagent'
export const OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS = [
  'subagent-plan.json',
  'subagent-events.jsonl',
  'subagent-parent-summary.json',
  'subagent-evidence.json',
  'naruto-summary.json',
  'naruto-gate.json'
] as const

export type ProofLevel = 'fixture_only' | 'fixture_instrumented_real' | 'proven' | 'integration_optional' | 'real_required_missing' | 'partial' | 'blocked'
export type ProofEvidenceRole = 'execution_authority' | 'supporting'

export interface OfficialSubagentExecutionEvaluation {
  authority: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
  workflow: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
  proof_level: ProofLevel
  required_mode: boolean
  present: boolean
  evidence_artifacts: string[]
  blockers: string[]
  next_action: string
}

export interface FakeRealProofPolicyReport {
  schema: typeof FAKE_REAL_PROOF_POLICY_SCHEMA
  generated_at: string
  ok: boolean
  proof_level: ProofLevel
  execution_authority: {
    workflow: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
    subsystem: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
    required_mode_source: 'explicit_input'
    evidence_artifacts: string[]
  }
  fake_claims: string[]
  real_claims: string[]
  supporting_claims: string[]
  integration_optional: string[]
  subsystems: Record<string, {
    proof_level: ProofLevel
    evidence_artifacts: string[]
    blockers: string[]
    next_action: string
    required_mode: boolean
    evidence_role: ProofEvidenceRole
  }>
  subsystem_levels: Record<string, ProofLevel>
  blockers: string[]
}

export function evaluateOfficialSubagentExecutionProof(
  input: any = {},
  options: { required?: boolean } = {}
): OfficialSubagentExecutionEvaluation {
  const required = options.required === true
  const plan = record(input.subagent_plan || input.plan)
  const evidence = record(normalizeLegacySubagentCountFields(officialEvidence(input), plan))
  const summary = record(normalizeLegacySubagentCountFields(record(input.naruto_summary || input.summary), plan))
  const gate = record(normalizeLegacySubagentCountFields(record(input.naruto_gate || input.route_gate || input.gate), plan))
  const present = Boolean(plan || evidence || summary || gate)

  if (!present) {
    return {
      authority: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      workflow: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      proof_level: required ? 'real_required_missing' : 'integration_optional',
      required_mode: required,
      present: false,
      evidence_artifacts: [...OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS],
      blockers: required ? ['official_subagent_evidence_required_missing'] : [],
      next_action: 'run `sks naruto run "<task>" --json` and retain the official subagent evidence set'
    }
  }

  const observedStarts = runScopedObservedStarts(plan, evidence)
  const countTarget = effectiveSubagentTarget(plan, observedStarts)
  const blockers = uniqueStrings([
    ...(!plan ? ['official_subagent_plan_missing'] : validatePlan(plan, observedStarts)),
    ...(!evidence ? ['official_subagent_evidence_missing'] : validateEvidence(evidence)),
    ...(!summary ? ['naruto_summary_missing'] : validateSummary(summary)),
    ...(!gate ? ['naruto_gate_missing'] : validateGate(gate)),
    ...validateRunBinding(plan, evidence, summary, gate, countTarget)
  ])

  return {
    authority: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
    workflow: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
    proof_level: blockers.length ? 'blocked' : 'proven',
    required_mode: required,
    present: true,
    evidence_artifacts: [...OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS],
    blockers,
    next_action: blockers.length
      ? 'repair the Naruto mission evidence, then run `sks naruto proof --mission <mission-id> --json`'
      : 'no action required'
  }
}

export function evaluateFakeRealProofPolicy(input: any = {}): FakeRealProofPolicyReport {
  const official = evaluateOfficialSubagentExecutionProof(input, {
    required: input.require_official_subagents === true
  })
  const backend = String(input.backend || input.agent_orchestration?.backend || '')
  const routeBlackboxKind = String(input.route_blackbox_kind || '')
  const sourceIntelligenceOk = input.source_intelligence?.ok === true
    || input.source_intelligence_generation_refs_ok === true
    || input.task_graph_source_refs_ok === true
  const goalModeOk = input.goal_mode?.ok === true
    || input.goal_mode_generation_refs_ok === true
    || input.task_graph_goal_refs_ok === true
  const dynamicSchedulerOk = input.scheduler_state === 'agent-scheduler-state.json'
    || input.scheduler?.pending_queue_drained === true
    || input.pending_queue_drained === true
  const cleanupLevel: ProofLevel = input.cleanup_proof?.ok === true || input.real_truth_summary?.cleanup_executor_status === 'passed' ? 'proven'
    : input.cleanup_proof || input.real_truth_summary?.cleanup_executor_status === 'blocked' ? 'blocked'
    : 'integration_optional'
  const graphScore = Number(input.work_graph_quality_score ?? input.real_truth_summary?.work_graph_quality_score ?? 0)
  const workGraphLevel: ProofLevel = graphScore >= 0.7 ? 'proven' : graphScore >= 0.35 ? 'partial' : 'blocked'
  const unsupportedExecutionClaim = input.real_parallel_claim === true
  const structuredOutputEvidence = input.output_schema_used === true
    && Boolean(input.output_last_message_path)

  const fakeClaims = uniqueStrings([
    ...(backend === 'fake' ? ['fake_backend_evidence'] : []),
    ...(routeBlackboxKind.includes('fixture') || routeBlackboxKind.includes('mock') ? ['fixture_route_blackbox'] : [])
  ])
  const realClaims = official.proof_level === 'proven'
    ? ['official_codex_subagent_execution']
    : []
  const supportingClaims = uniqueStrings([
    ...(cleanupLevel === 'proven' ? ['cleanup_evidence'] : []),
    ...(workGraphLevel === 'proven' ? ['work_graph_evidence'] : []),
    ...(sourceIntelligenceOk ? ['source_intelligence_evidence'] : []),
    ...(goalModeOk ? ['goal_mode_evidence'] : []),
    ...(dynamicSchedulerOk ? ['scheduler_evidence'] : []),
    ...(structuredOutputEvidence ? ['codex_structured_output_evidence'] : [])
  ])
  const integrationOptional = uniqueStrings([
    ...(official.present === false ? ['official_subagent_execution_not_available'] : [])
  ])
  const blockers = uniqueStrings([
    ...official.blockers,
    ...(backend === 'fake' && unsupportedExecutionClaim ? ['fake_backend_claimed_real_execution'] : []),
    ...(unsupportedExecutionClaim && official.proof_level !== 'proven' ? ['unsupported_execution_claim_without_official_subagent_evidence'] : []),
    ...(input.real_route_command_used === false ? ['route_standin_cannot_satisfy_real_route'] : [])
  ])
  const proofLevel: ProofLevel = official.proof_level === 'proven' && blockers.length === 0 ? 'proven'
    : official.proof_level === 'real_required_missing' ? 'real_required_missing'
    : blockers.length ? 'blocked'
    : fakeClaims.length ? 'fixture_only'
    : official.proof_level === 'integration_optional' || integrationOptional.length ? 'integration_optional'
    : 'fixture_only'
  const routeBlackboxLevel: ProofLevel = routeBlackboxKind.includes('fixture') || routeBlackboxKind.includes('mock')
    ? 'fixture_only'
    : input.real_route_command_used === false
      ? 'blocked'
      : official.proof_level === 'proven'
        ? 'proven'
        : 'integration_optional'
  const subsystems: FakeRealProofPolicyReport['subsystems'] = {
    official_codex_subagent: row(
      official.proof_level,
      official.evidence_artifacts,
      official.next_action,
      official.required_mode,
      official.blockers,
      'execution_authority'
    ),
    cleanup: row(cleanupLevel, ['agent-cleanup-proof.json'], cleanupLevel === 'proven' ? 'cleanup after-state verified' : 'run the managed cleanup verification', false, cleanupLevel === 'blocked' ? ['cleanup_proof_blocked'] : []),
    intelligent_work_graph: row(workGraphLevel, ['agent-intelligent-work-graph-v2.json', 'agent-symbol-ownership-map.json'], workGraphLevel === 'proven' ? 'AST work graph quality sufficient' : workGraphLevel === 'partial' ? 'raise AST coverage or ownership confidence' : 'build AST-aware work graph evidence', false, workGraphLevel === 'blocked' ? ['work_graph_quality_too_low'] : []),
    source_intelligence: row(sourceIntelligenceOk ? 'proven' : 'integration_optional', ['source-intelligence-evidence.json'], sourceIntelligenceOk ? 'source intelligence refs are present' : 'hydrate source intelligence evidence before risky claims', false, []),
    goal_mode: row(goalModeOk ? 'proven' : 'integration_optional', ['goal-mode-applied.json'], goalModeOk ? 'Goal mode refs are present' : 'record official goal mode evidence', false, []),
    route_blackbox: row(routeBlackboxLevel, ['subagent-evidence.json', 'naruto-gate.json'], input.real_route_command_used === false ? 'use the actual Naruto route, not a stand-in' : official.next_action, false, input.real_route_command_used === false ? ['route_standin_cannot_satisfy_real_route'] : []),
    dynamic_scheduler: row(dynamicSchedulerOk ? 'proven' : 'partial', ['agent-scheduler-state.json'], dynamicSchedulerOk ? 'scheduler drain evidence present' : 'record scheduler drain evidence', false, [])
  }
  const subsystemLevels: Record<string, ProofLevel> = Object.fromEntries(Object.entries(subsystems).map(([key, value]) => [key, value.proof_level]))
  subsystemLevels.execution = official.proof_level
  subsystemLevels.work_graph = subsystemLevels.intelligent_work_graph || workGraphLevel
  return {
    schema: FAKE_REAL_PROOF_POLICY_SCHEMA,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    proof_level: proofLevel,
    execution_authority: {
      workflow: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      subsystem: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      required_mode_source: 'explicit_input',
      evidence_artifacts: [...OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS]
    },
    fake_claims: fakeClaims,
    real_claims: realClaims,
    supporting_claims: supportingClaims,
    integration_optional: integrationOptional,
    subsystems,
    subsystem_levels: subsystemLevels,
    blockers
  }
}

function row(
  proofLevel: ProofLevel,
  evidenceArtifacts: string[],
  nextAction: string,
  requiredMode: boolean,
  blockers: string[],
  evidenceRole: ProofEvidenceRole = 'supporting'
) {
  return {
    proof_level: proofLevel,
    evidence_artifacts: evidenceArtifacts,
    blockers: uniqueStrings(blockers),
    next_action: nextAction,
    required_mode: requiredMode,
    evidence_role: evidenceRole
  }
}

export async function writeFakeRealProofPolicyReport(root: string, input: any = {}) {
  const directEvidence = officialEvidence(input)
  const [subagentEvidence, subagentPlan, narutoSummary, narutoGate, legacyEvidence] = await Promise.all([
    directEvidence ? directEvidence : readJson(path.join(root, 'subagent-evidence.json'), null),
    readJson(path.join(root, 'subagent-plan.json'), null),
    readJson(path.join(root, 'naruto-summary.json'), null),
    readJson(path.join(root, 'naruto-gate.json'), null),
    input?.schema ? input : readJson(path.join(root, 'agent-proof-evidence.json'), {})
  ])
  const report = evaluateFakeRealProofPolicy({
    ...(record(legacyEvidence) || {}),
    ...(record(input) || {}),
    subagent_evidence: subagentEvidence,
    subagent_plan: subagentPlan,
    naruto_summary: narutoSummary,
    naruto_gate: narutoGate
  })
  await writeJsonAtomic(path.join(root, 'fake-real-proof-policy.json'), report)
  return report
}

function officialEvidence(input: any): Record<string, any> | null {
  if (input?.schema === 'sks.subagent-evidence.v1') return input
  return record(input?.official_subagent_evidence || input?.subagent_evidence)
}

function validatePlan(plan: Record<string, any>, observedStarts: number): string[] {
  return uniqueStrings([
    ...(plan.schema !== 'sks.subagent-plan.v1' ? ['official_subagent_plan_schema_invalid'] : []),
    ...(plan.workflow !== OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY ? ['official_subagent_plan_workflow_invalid'] : []),
    ...(normalizeProofRoute(plan.route) !== '$Naruto' ? ['official_subagent_plan_route_invalid'] : []),
    ...(Number(plan.requested_subagents || 0) < 1 ? ['official_subagent_plan_requested_subagents_invalid'] : []),
    ...(Number(plan.max_depth) !== 1 ? ['official_subagent_plan_max_depth_invalid'] : []),
    ...subagentCountContractBlockers(plan, observedStarts),
    ...(Array.isArray(plan.config_blockers) && plan.config_blockers.length ? plan.config_blockers.map((value: unknown) => `official_subagent_config:${String(value)}`) : [])
  ])
}

function validateEvidence(evidence: Record<string, any>): string[] {
  const requested = Number(evidence.requested_subagents || 0)
  const target = Number(evidence.target_subagents || 0)
  const started = Number(evidence.started_threads || 0)
  const completed = Number(evidence.completed_threads || 0)
  const failed = Number(evidence.failed_threads || 0)
  const eventSources = new Set(Array.isArray(evidence.event_sources) ? evidence.event_sources.map(String) : [])
  return uniqueStrings([
    ...(evidence.schema !== 'sks.subagent-evidence.v1' ? ['official_subagent_evidence_schema_invalid'] : []),
    ...(evidence.workflow !== OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY ? ['official_subagent_evidence_workflow_invalid'] : []),
    ...(evidence.ok !== true || evidence.status !== 'completed' ? ['official_subagent_evidence_not_completed'] : []),
    ...(evidence.preparation_only === true ? ['official_subagent_evidence_preparation_only'] : []),
    ...(requested < 1 ? ['official_subagent_requested_subagents_invalid'] : []),
    ...(!['exact', 'dynamic_automatic'].includes(String(evidence.count_policy || '')) ? ['official_subagent_count_policy_invalid'] : []),
    ...(target < 1 ? ['official_subagent_target_subagents_invalid'] : []),
    ...(target > 0 && started !== target ? ['official_subagent_start_count_mismatch'] : []),
    ...(target > 0 && completed !== target ? ['official_subagent_completion_count_mismatch'] : []),
    ...(failed !== 0 ? ['official_subagent_failed_threads_present'] : []),
    ...(Array.isArray(evidence.open_thread_ids) && evidence.open_thread_ids.length ? ['official_subagent_open_threads_present'] : []),
    ...(!eventSources.has('SubagentStart') || !eventSources.has('SubagentStop') ? ['official_subagent_event_sources_incomplete'] : []),
    ...(evidence.parent_summary_present !== true ? ['official_subagent_parent_summary_missing'] : []),
    ...(evidence.parent_summary_trustworthy !== true || evidence.parent_summary_status !== 'completed' ? ['official_subagent_parent_summary_untrustworthy'] : []),
    ...(Array.isArray(evidence.blockers) ? evidence.blockers.map((value: unknown) => `official_subagent_evidence:${String(value)}`) : [])
  ])
}

function validateSummary(summary: Record<string, any>): string[] {
  return uniqueStrings([
    ...(summary.schema !== 'sks.naruto-subagent-workflow.v1' ? ['naruto_summary_schema_invalid'] : []),
    ...(summary.workflow !== OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY ? ['naruto_summary_workflow_invalid'] : []),
    ...(normalizeProofRoute(summary.route) !== '$Naruto' ? ['naruto_summary_route_invalid'] : []),
    ...(summary.ok !== true || summary.completion_evidence !== true || summary.status !== 'completed' ? ['naruto_summary_not_completed'] : []),
    ...(summary.parent_summary_present !== true ? ['naruto_summary_parent_summary_missing'] : []),
    ...(Array.isArray(summary.blockers) ? summary.blockers.map((value: unknown) => `naruto_summary:${String(value)}`) : [])
  ])
}

function validateGate(gate: Record<string, any>): string[] {
  return uniqueStrings([
    ...(gate.schema !== 'sks.naruto-gate.v1' ? ['naruto_gate_schema_invalid'] : []),
    ...(gate.workflow !== OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY ? ['naruto_gate_workflow_invalid'] : []),
    ...(normalizeProofRoute(gate.route) !== '$Naruto' ? ['naruto_gate_route_invalid'] : []),
    ...(gate.passed !== true || gate.status !== 'passed' || gate.terminal !== true || gate.terminal_state !== 'completed' ? ['naruto_gate_not_passed'] : []),
    ...(gate.official_subagent_evidence !== true || gate.subagent_evidence_ready !== true ? ['naruto_gate_official_subagent_evidence_missing'] : []),
    ...(gate.parent_summary_present !== true ? ['naruto_gate_parent_summary_missing'] : []),
    ...(gate.session_cleanup !== true ? ['naruto_gate_session_cleanup_incomplete'] : []),
    ...(gate.native_process_proof_required !== false ? ['naruto_gate_native_process_proof_contract_invalid'] : []),
    ...(Array.isArray(gate.blockers) ? gate.blockers.map((value: unknown) => `naruto_gate:${String(value)}`) : [])
  ])
}

function validateRunBinding(
  plan: Record<string, any> | null,
  evidence: Record<string, any> | null,
  summary: Record<string, any> | null,
  gate: Record<string, any> | null,
  countTarget: ReturnType<typeof effectiveSubagentTarget>
): string[] {
  const runIds = [plan?.workflow_run_id, evidence?.run_id, summary?.workflow_run_id, gate?.workflow_run_id]
    .map((value) => String(value || '').trim())
  if (runIds.some((value) => !value)) return ['official_subagent_run_id_missing']
  if (new Set(runIds).size !== 1) return ['official_subagent_run_id_mismatch']
  const requested = [plan?.requested_subagents, evidence?.requested_subagents, summary?.requested_subagents, gate?.requested_subagents]
    .map((value) => Number(value || 0))
  if (requested.some((value) => value < 1) || new Set(requested).size !== 1) return ['official_subagent_requested_subagents_mismatch']
  const policies = [countTarget.countPolicy, evidence?.count_policy, summary?.count_policy, gate?.count_policy]
    .map((value) => String(value || '').trim())
  if (policies.some((value) => !['exact', 'dynamic_automatic'].includes(value)) || new Set(policies).size !== 1) {
    return ['official_subagent_count_policy_mismatch']
  }
  const targets = [countTarget.targetSubagents, evidence?.target_subagents, summary?.target_subagents, gate?.target_subagents]
    .map((value) => Number(value || 0))
  if (targets.some((value) => value < 1) || new Set(targets).size !== 1) return ['official_subagent_target_subagents_mismatch']
  return []
}

function runScopedObservedStarts(
  plan: Record<string, any> | null,
  evidence: Record<string, any> | null
): number {
  const planRunId = String(plan?.workflow_run_id || '').trim()
  const evidenceRunId = String(evidence?.run_id || '').trim()
  if (!planRunId || evidenceRunId !== planRunId) return 0
  return Math.max(0, Math.floor(Number(evidence?.started_threads) || 0))
}

function record(value: unknown): Record<string, any> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null
}
