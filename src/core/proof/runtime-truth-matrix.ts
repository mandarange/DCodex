import path from 'node:path'
import { nowIso, readJson, writeJsonAtomic } from '../fsx.js'
import {
  OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS,
  OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
  evaluateOfficialSubagentExecutionProof,
  type ProofEvidenceRole,
  type ProofLevel
} from './fake-real-proof-policy.js'
import { assessRuntimeEvidence, type RuntimeEvidenceSource, type RuntimeEvidenceStatus } from './runtime-evidence-policy.js'

export const RUNTIME_TRUTH_MATRIX_SCHEMA = 'sks.runtime-truth-matrix.v2'
export const RUNTIME_TRUTH_SUBSYSTEMS = [
  'official_codex_subagent',
  'zellij_pane',
  'cleanup',
  'intelligent_work_graph',
  'source_intelligence',
  'goal_mode',
  'route_blackbox',
  'dynamic_scheduler',
  'warp_mad_lanes',
  'codex_0_136',
  'codex_0_134',
  'mcp_0_134',
  'mcp_readonly_runtime_scheduler',
  'adhd_orchestration',
  'appshots',
  'parallel_write',
  'patch_proof',
  'native_worker_backend_router',
  'cleanup_v4',
  'ast_type_work_graph',
  'warp_mad_right_lanes'
] as const

export type RuntimeTruthSubsystem = typeof RUNTIME_TRUTH_SUBSYSTEMS[number]

export interface RuntimeTruthRow {
  subsystem: RuntimeTruthSubsystem
  proof_level: ProofLevel
  evidence_artifacts: string[]
  blockers: string[]
  next_action: string
  required_mode: boolean
  evidence_role: ProofEvidenceRole
  contract_status: 'valid' | 'invalid' | 'not_assessed'
  runtime_status: RuntimeEvidenceStatus
  evidence_source: RuntimeEvidenceSource
  working_claim_allowed: boolean
  receipts: unknown[]
}

export interface RuntimeTruthMatrix {
  schema: typeof RUNTIME_TRUTH_MATRIX_SCHEMA
  release_version: string
  generated_at: string
  ok: boolean
  execution_authority: {
    workflow: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
    subsystem: typeof OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY
    required_mode_source: 'explicit_input'
    evidence_artifacts: string[]
  }
  proof_levels: ProofLevel[]
  rows: RuntimeTruthRow[]
  subsystems: RuntimeTruthRow[]
  priorities: Record<string, { status: 'closed' | 'blocked' | 'not_applicable_with_proof'; evidence: string[]; blockers: string[] }>
  blockers: string[]
}

export async function buildRuntimeTruthMatrix(input: {
  root?: string
  releaseVersion: string
  agentRoot?: string
  required?: Partial<Record<RuntimeTruthSubsystem, boolean>>
  reports?: Record<string, any>
}): Promise<RuntimeTruthMatrix> {
  const root = path.resolve(input.root || process.cwd())
  const reportDir = path.join(root, '.sneakoscope', 'reports')
  const agentRoot = input.agentRoot ? path.resolve(input.agentRoot) : ''
  const readReport = async (name: string, fallbackNames: string[] = []) => {
    if (input.reports?.[name]) return input.reports[name]
    for (const candidate of [name, ...fallbackNames]) {
      const value = await readJson<any>(path.join(reportDir, candidate), null)
      if (value) return value
      if (agentRoot) {
        const agentValue = await readJson<any>(path.join(agentRoot, candidate), null)
        if (agentValue) return agentValue
      }
    }
    return null
  }
  const required = { ...(input.required || {}) } as Partial<Record<RuntimeTruthSubsystem, boolean>>
  const [subagentPlan, subagentEvidence, narutoSummary, narutoGate, zellijPane, workerBackendRouter, zellijRightLanePhysical, zellijRightLaneCoordinate, zellijRightLaneContent, madWarpRightLaneAttach, cleanup, workGraph, fakeReal, sourceIntel, goalMode, scheduler, warpMad, codex0136, codex0134, mcp0134, mcpReadonlyRuntime, adhdOrchestration, appshots, parallelWrite, patchProof] = await Promise.all([
    readReport('subagent-plan.json'),
    readReport('subagent-evidence.json'),
    readReport('naruto-summary.json'),
    readReport('naruto-gate.json'),
    readReport('zellij-pane-proof.json'),
    readReport('agent-worker-backend-router.json', ['worker-backend-router-report.json']),
    readReport('zellij-layout-proof.json'),
    readReport('zellij-coordinate-proof.json'),
    readReport('zellij-content-proof.json'),
    readReport('mad-sks-zellij-launch.json'),
    readReport(`agent-cleanup-executor-v2-${input.releaseVersion}.json`, ['agent-cleanup-proof.json']),
    readReport(`agent-intelligent-work-graph-v2-${input.releaseVersion}.json`, ['agent-intelligent-work-graph.json']),
    readReport('fake-real-proof-policy.json'),
    readReport('source-intelligence-evidence.json'),
    readReport('goal-mode-applied.json'),
    readReport('agent-scheduler-state.json'),
    readReport('zellij-session.json'),
    readReport('codex-0.136-compat.json'),
    readReport('codex-0-134-official-compat.json'),
    readReport('mcp-0-134-modernization.json'),
    readReport('mcp-readonly-runtime-scheduler.json'),
    readReport('strategy-gate.json', ['strategy-adhd-orchestrating-gate.json', 'adhd-orchestrating-gate.json']),
    readReport('appshots-evidence.json'),
    readReport('agent-parallel-write-kernel.json'),
    readReport('agent-patch-proof.json')
  ])
  const official = evaluateOfficialSubagentExecutionProof({
    subagent_plan: subagentPlan,
    subagent_evidence: subagentEvidence,
    naruto_summary: narutoSummary,
    naruto_gate: narutoGate
  }, {
    required: required.official_codex_subagent === true
  })
  const schedulerRuntime = schedulerRuntimeTruthReport(scheduler)
  const rows: RuntimeTruthRow[] = [
    row('official_codex_subagent', official.proof_level, official.evidence_artifacts, official.required_mode, { blockers: official.blockers }, official.next_action, 'execution_authority'),
    row('zellij_pane', levelFromOk(zellijPane, required.zellij_pane === true ? 'real_required_missing' : 'integration_optional'), ['zellij-pane-proof.json'], required.zellij_pane === true, zellijPane, 'capture current Zellij pane evidence'),
    row('cleanup', levelFromOk(cleanup, 'integration_optional'), ['agent-cleanup-proof.json'], false, cleanup, 'run the managed cleanup verification'),
    row('intelligent_work_graph', levelFromWorkGraph(workGraph || fakeReal), ['agent-intelligent-work-graph-v2.json', 'agent-symbol-ownership-map.json'], false, workGraph, 'run AST-aware work-graph verification'),
    row('source_intelligence', sourceIntel?.ok === true ? 'proven' : 'integration_optional', ['source-intelligence-evidence.json'], false, sourceIntel, 'refresh source intelligence evidence'),
    row('goal_mode', goalMode?.ok === true ? 'proven' : 'integration_optional', ['goal-mode-applied.json'], false, goalMode, 'record official goal mode evidence'),
    row('route_blackbox', fakeReal?.subsystem_levels?.route_blackbox || (official.proof_level === 'proven' ? 'proven' : 'integration_optional'), ['subagent-evidence.json', 'naruto-gate.json', 'fake-real-proof-policy.json'], false, fakeReal, official.next_action),
    row('dynamic_scheduler', schedulerRuntime.proof_level, ['agent-scheduler-state.json'], false, schedulerRuntime.report, 'record scheduler drain evidence'),
    row('warp_mad_lanes', levelFromWarp(warpMad || madWarpRightLaneAttach || zellijRightLanePhysical, required.warp_mad_lanes === true), ['zellij-session.json', 'zellij-pane-proof.json'], required.warp_mad_lanes === true, warpMad || madWarpRightLaneAttach || zellijRightLanePhysical, 'capture visible MAD Zellij lane evidence'),
    row('codex_0_136', levelFromOk(codex0136, 'integration_optional'), ['codex-0.136-compat.json'], false, codex0136, 'run `npm run codex:0.136-compat`'),
    row('codex_0_134', levelFromOk(codex0134, 'integration_optional'), ['codex-0-134-official-compat.json'], false, codex0134, 'run `npm run codex:0.134-official-compat`'),
    row('mcp_0_134', levelFromOk(mcp0134, 'integration_optional'), ['mcp-0-134-modernization.json'], false, mcp0134, 'run `npm run mcp:0.134-modernization`'),
    row('mcp_readonly_runtime_scheduler', levelFromOk(mcpReadonlyRuntime, 'integration_optional'), ['mcp-readonly-runtime-scheduler.json'], false, mcpReadonlyRuntime, 'run `npm run mcp:readonly-runtime-scheduler`'),
    row('adhd_orchestration', levelFromOk(adhdOrchestration, 'integration_optional'), ['strategy-gate.json', 'adhd-orchestrating-gate.json'], false, adhdOrchestration, 'run `npm run strategy:adhd-orchestrating-gate`'),
    row('appshots', levelFromAppshots(appshots), ['appshots-evidence.json'], false, appshots, 'run `npm run appshots:evidence`'),
    row('parallel_write', levelFromOk(parallelWrite, 'integration_optional'), ['agent-parallel-write-kernel.json'], false, parallelWrite, 'run parallel-write kernel verification'),
    row('patch_proof', levelFromOk(patchProof, 'integration_optional'), ['agent-patch-proof.json'], false, patchProof, 'run patch handoff verification'),
    row('native_worker_backend_router', levelFromOk(workerBackendRouter, 'integration_optional'), ['agent-worker-backend-router.json', 'worker-backend-router-report.json'], false, workerBackendRouter, 'run current backend-router verification'),
    row('cleanup_v4', levelFromOk(cleanup, 'integration_optional'), ['agent-cleanup-proof.json'], false, cleanup, 'run the managed cleanup verification'),
    row('ast_type_work_graph', levelFromWorkGraph(workGraph || fakeReal), ['agent-intelligent-work-graph-v2.json', 'agent-symbol-ownership-map.json'], false, workGraph, 'run AST-aware work-graph verification'),
    row('warp_mad_right_lanes', levelFromWarp(warpMad || madWarpRightLaneAttach || zellijRightLanePhysical || zellijRightLaneCoordinate || zellijRightLaneContent, required.warp_mad_lanes === true), ['zellij-session.json', 'zellij-pane-proof.json'], required.warp_mad_lanes === true, warpMad || madWarpRightLaneAttach || zellijRightLanePhysical || zellijRightLaneCoordinate || zellijRightLaneContent, 'capture visible MAD Zellij right-lane evidence')
  ]
  const blockers = rows.flatMap((item) => item.required_mode && ['blocked', 'real_required_missing', 'integration_optional'].includes(item.proof_level)
    ? [`required_runtime_truth_missing:${item.subsystem}`, ...item.blockers]
    : item.blockers)
  const priorities = Object.fromEntries(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'].map((priority) => {
    const priorityBlockers = priority === 'P0' || priority === 'P1' ? blockers : []
    return [priority, {
      status: priorityBlockers.length ? 'blocked' : 'closed',
      evidence: rows.map((item) => item.evidence_artifacts[0]).filter(Boolean),
      blockers: priorityBlockers
    }]
  })) as RuntimeTruthMatrix['priorities']
  return {
    schema: RUNTIME_TRUTH_MATRIX_SCHEMA,
    release_version: input.releaseVersion,
    generated_at: nowIso(),
    ok: blockers.length === 0,
    execution_authority: {
      workflow: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      subsystem: OFFICIAL_SUBAGENT_EXECUTION_AUTHORITY,
      required_mode_source: 'explicit_input',
      evidence_artifacts: [...OFFICIAL_SUBAGENT_EXECUTION_ARTIFACTS]
    },
    proof_levels: ['fixture_only', 'fixture_instrumented_real', 'proven', 'integration_optional', 'real_required_missing', 'partial', 'blocked'],
    rows,
    subsystems: rows,
    priorities,
    blockers
  }
}

function schedulerRuntimeTruthReport(report: any): { proof_level: ProofLevel; report: any } {
  if (!report) return { proof_level: 'integration_optional', report: null }
  const declaredBlockers = Array.isArray(report.blockers) ? report.blockers.map(String).filter(Boolean) : []
  const stateBlockers = [
    ...(report.status === 'drained' ? [] : [`scheduler_status_${String(report.status || 'missing')}`]),
    ...(report.completion_claim_allowed === true ? [] : ['scheduler_completion_claim_disallowed']),
    ...(report.pending_queue_drained === true ? [] : ['scheduler_pending_queue_not_drained']),
    ...(report.all_slots_closed_after_drain === true ? [] : ['scheduler_slots_not_closed']),
    ...(report.all_generations_closed === true ? [] : ['scheduler_generations_not_closed']),
    ...declaredBlockers
  ]
  if (stateBlockers.length > 0) {
    return {
      proof_level: 'blocked',
      report: { ...report, proof_level: 'blocked', blockers: [...new Set(stateBlockers)] }
    }
  }
  if (report.runtime_evidence?.schema !== 'sks.runtime-evidence.v1') {
    return {
      proof_level: 'blocked',
      report: { ...report, proof_level: 'blocked', blockers: ['scheduler_runtime_receipt_missing'] }
    }
  }
  return { proof_level: 'proven', report: report.runtime_evidence }
}

export async function writeRuntimeTruthMatrix(root: string, matrix: RuntimeTruthMatrix, opts: { agentRoot?: string } = {}) {
  const reportName = `runtime-truth-matrix-${matrix.release_version}.json`
  await writeJsonAtomic(path.join(root, '.sneakoscope', 'reports', reportName), matrix)
  if (opts.agentRoot) await writeJsonAtomic(path.join(opts.agentRoot, 'runtime-truth-matrix.json'), matrix)
  return matrix
}

function row(
  subsystem: RuntimeTruthSubsystem,
  proofLevel: ProofLevel,
  evidenceArtifacts: string[],
  requiredMode: boolean,
  report: any,
  nextAction: string,
  evidenceRole: ProofEvidenceRole = 'supporting'
): RuntimeTruthRow {
  const evidenceAssessment = assessRuntimeEvidence(report, {
    candidateProofLevel: proofLevel,
    missingProofLevel: requiredMode ? 'real_required_missing' : 'integration_optional',
    required: requiredMode,
    trustedRuntimeValidator: evidenceRole === 'execution_authority' && proofLevel === 'proven',
    trustedArtifacts: evidenceArtifacts
  })
  const blockers = evidenceAssessment.blockers
  return {
    subsystem,
    proof_level: evidenceAssessment.proof_level,
    evidence_artifacts: evidenceArtifacts,
    blockers,
    next_action: blockers.length ? nextAction : evidenceAssessment.proof_level === 'integration_optional' || evidenceAssessment.proof_level === 'real_required_missing' ? nextAction : 'no action required',
    required_mode: requiredMode,
    evidence_role: evidenceRole,
    contract_status: evidenceAssessment.contract_status,
    runtime_status: evidenceAssessment.runtime_status,
    evidence_source: evidenceAssessment.evidence_source,
    working_claim_allowed: evidenceAssessment.working_claim_allowed,
    receipts: evidenceAssessment.receipts
  }
}

function levelFromOk(report: any, missing: ProofLevel): ProofLevel {
  if (!report) return missing
  const declared = String(report.proof_level || '') as ProofLevel
  if (['fixture_only', 'fixture_instrumented_real', 'proven', 'integration_optional', 'real_required_missing', 'partial', 'blocked'].includes(declared)) return declared
  const status = String(report.runtime_status || report.status || '').toLowerCase()
  if (report.ok === true || report.passed === true || ['passed', 'completed', 'verified', 'proven', 'working'].includes(status)) return 'proven'
  if (report.ok === false || report.passed === false || ['failed', 'blocked', 'error'].includes(status)) return 'blocked'
  return missing
}

function levelFromAppshots(report: any): ProofLevel {
  if (!report) return 'integration_optional'
  const evidence = report.evidence || report
  if (evidence.status === 'not_required' || evidence.proof_level === 'not_required') return 'integration_optional'
  if (Array.isArray(evidence.blockers) && evidence.blockers.length > 0) return 'blocked'
  if (evidence.ok !== true && report.ok !== true) return 'blocked'
  if (evidence.proof_level === 'proven') return 'proven'
  if (evidence.proof_level === 'fixture_instrumented_real') return 'fixture_instrumented_real'
  const sources = Array.isArray(evidence.source_verification) ? evidence.source_verification : []
  if (sources.length && sources.every((source: any) => source?.accepted === true)) {
    return sources.some((source: any) => source?.fixture === true) ? 'fixture_instrumented_real' : 'proven'
  }
  return 'blocked'
}

function levelFromWorkGraph(report: any): ProofLevel {
  if (!report) return 'integration_optional'
  if (report.proof_level) return report.proof_level
  const score = Number(report.work_graph_quality_score || 0)
  return score >= 0.7 ? 'proven' : score >= 0.35 ? 'partial' : 'blocked'
}

function levelFromWarp(report: any, required: boolean): ProofLevel {
  if (!report) return required ? 'real_required_missing' : 'integration_optional'
  if (report.proof_level) return report.proof_level
  if (report.ok === true && report.visible_lane_contract === true) return 'proven'
  return required ? 'real_required_missing' : 'blocked'
}
