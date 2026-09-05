import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  nowIso,
  randomId,
  readJson,
  readText,
  sha256,
  writeJsonAtomic,
  writeTextAtomic
} from '../fsx.js'
import { uniqueValues as unique } from '../text/strings.js'
import { buildOfficialSubagentPrompt, type OfficialSubagentSlice } from '../subagents/official-subagent-prompt.js'
import {
  codexAppSessionKey,
  detectCodexAppSession,
  runOfficialSubagentWorkflow,
  type OfficialSubagentWorkflowInput
} from '../subagents/official-subagent-runner.js'
import { readOfficialSubagentConfig } from '../subagents/official-subagent-config.js'
import {
  SUBAGENT_EVENT_LOG_FILENAME,
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  bindTrustworthySubagentParentSummaryToRun,
  normalizeSubagentParentSummary,
  persistOrReuseTrustworthySubagentParentSummary,
  readSubagentEvents,
  writeSubagentEvidence
} from '../subagents/subagent-evidence.js'
import { THINKING_SUBAGENT_MODEL, SUBAGENT_EFFORT } from '../subagents/model-policy.js'
import {
  RESEARCH_AGENT_COUNCIL,
  RESEARCH_REVIEWER_CONFIG_ARTIFACT,
  RESEARCH_REVIEWER_CUSTOM_AGENT,
  researchAgentAgentName,
  researchPaperArtifactForPlan
} from '../research.js'
import { normalizeResearchSynthesisOutput } from './research-synthesis-writer.js'
import {
  buildResearchReviewArtifactDigest,
  validateResearchReviewArtifactDigest,
  type ResearchReviewArtifactDigest
} from './research-review-artifact-digest.js'
import { eligibleResearchSourceIdSet, type ResearchEvidenceExecutionClass } from './research-source-evidence.js'
import {
  completeExecutionControl,
  normalizeExecutionControlState,
  preflightExecutionControl,
  recordExecutionObservation,
  stopExecutionControl
} from '../runtime/execution-control.js'

export const RESEARCH_ADVERSARIAL_PLAN_ARTIFACT = 'research-adversarial-plan.json'
export const RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT = 'research-adversarial-review.json'
export const RESEARCH_REVISION_LEDGER_ARTIFACT = 'research-revision-ledger.json'
export const RESEARCH_CONVERGENCE_GATE_ARTIFACT = 'research-adversarial-convergence.json'
export const RESEARCH_HONEST_MODE_ARTIFACT = 'research-honest-mode.json'
export const RESEARCH_EXECUTION_CONTROL_ARTIFACT = 'research-execution-control.json'

export type ResearchReviewerVerdict = 'approve' | 'revise' | 'reject'

export interface ResearchReviewObjection {
  id: string
  severity: 'critical' | 'major' | 'minor'
  claim_ids: string[]
  source_ids: string[]
  reason: string
  required_revision: string
}

export interface ResearchReviewerOutcome {
  schema: 'sks.research-adversarial-reviewer-outcome.v1'
  persona_id: string
  verdict: ResearchReviewerVerdict
  strongest_challenge: string
  evidence_source_ids: string[]
  critical_objections: ResearchReviewObjection[]
  major_objections: ResearchReviewObjection[]
  minor_objections: ResearchReviewObjection[]
  required_revisions: string[]
  falsifiers: string[]
  cheap_probes: string[]
  confidence: 'low' | 'medium' | 'high'
  review_artifact_bundle_sha256: string
  thread_id: string
  thread_status: 'completed' | 'blocked' | 'failed'
}

export interface ResearchAdversarialReviewLoopInput {
  root: string
  dir: string
  plan: any
  timeoutMs: number
  deadlineMs?: number
  maxCycles?: number
  maxThreads?: number
  mock?: boolean
  appSession?: boolean
  sessionKey?: string | null
  preliminaryBlockers?: string[]
  runWorkflowImpl?: (input: OfficialSubagentWorkflowInput) => Promise<any>
  reviewCycleImpl?: (input: ResearchAdversarialReviewLoopInput, cycle: number, maxThreads: number, reviewArtifacts: ResearchReviewArtifactDigest) => Promise<any>
  revisionCycleImpl?: (input: ResearchAdversarialReviewLoopInput, cycle: number, maxThreads: number, objectionIds: string[]) => Promise<any>
}

export async function runResearchAdversarialReviewLoop(input: ResearchAdversarialReviewLoopInput) {
  const maxCycles = Math.max(1, Math.min(3, Math.floor(Number(input.maxCycles || 3))))
  const config = input.mock ? null : await readOfficialSubagentConfig(input.root)
  const configuredThreads = Math.max(1, Math.floor(Number(input.maxThreads || config?.maxThreads || RESEARCH_AGENT_COUNCIL.length)))
  const maxThreads = Math.min(RESEARCH_AGENT_COUNCIL.length, configuredThreads)
  const executionClass = input.mock ? 'mock_fixture' : 'real'
  const modelPolicyEvidence = input.mock ? mockResearchModelPolicyEvidence() : await verifyResearchReviewerRoleConfig(input.root)
  const plan = buildResearchAdversarialPlan(input.plan, maxCycles, maxThreads, config, modelPolicyEvidence)
  await writeJsonAtomic(path.join(input.dir, RESEARCH_ADVERSARIAL_PLAN_ARTIFACT), plan)

  const reviewCycles: any[] = []
  const revisions: any[] = []
  const deadlineMs = Number.isFinite(Number(input.deadlineMs))
    ? Number(input.deadlineMs)
    : Date.now() + Math.max(1, Number(input.timeoutMs || 1))
  const runtimeBlockers: string[] = []
  const executionBudget = {
    max_attempts: maxCycles,
    max_elapsed_ms: Math.max(1, deadlineMs - Date.now()),
    max_tool_calls: maxCycles,
    max_tokens: null,
    max_no_progress: 1
  }
  let executionControl = normalizeExecutionControlState(null)
  let lastExecutionObservationAt = Date.now()
  await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
  const configBlockers = (config?.blockers || []).map((blocker) => `official_subagent_config:${blocker}`)
  const preliminaryBlockers = unique([...configBlockers, ...modelPolicyEvidence.blockers, ...normalizeStrings(input.preliminaryBlockers)])
  if (preliminaryBlockers.length) {
    const gate = await finalizeResearchAdversarialArtifacts(input, plan, reviewCycles, revisions, executionClass, preliminaryBlockers)
    return { ok: false, gate, plan, review_cycles: reviewCycles, revisions }
  }

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const preflight = preflightExecutionControl(executionControl, executionBudget)
    executionControl = preflight.state
    if (!preflight.allowed) {
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push(researchExecutionStopBlocker(executionControl.stop_reason))
      break
    }
    if (remainingTimeoutMs(deadlineMs) <= 0) {
      runtimeBlockers.push('research_cycle_timeout_exceeded')
      break
    }
    const reviewArtifacts = await buildResearchReviewArtifactDigest(input.dir, input.plan)
    const reviewResult = await runResearchOperationBeforeDeadline(deadlineMs, () => input.reviewCycleImpl
      ? input.reviewCycleImpl(input, cycle, maxThreads, reviewArtifacts)
      : input.mock
        ? mockReviewCycle(input, cycle, reviewArtifacts)
        : runOfficialReviewCycle({ ...input, timeoutMs: remainingTimeoutMs(deadlineMs), deadlineMs }, cycle, maxThreads, reviewArtifacts))
    if (reviewResult.timed_out) {
      executionControl = stopExecutionControl(executionControl, 'time_budget_exhausted', 'research review cycle exceeded its absolute deadline')
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push('research_cycle_timeout_exceeded')
      break
    }
    const review = reviewResult.value
    reviewCycles.push(review)
    await writeJsonAtomic(path.join(input.dir, 'research', 'adversarial', `cycle-${cycle}`, 'review.json'), review)
    const currentReviewArtifacts = await buildResearchReviewArtifactDigest(input.dir, input.plan)
    const convergence = evaluateReviewCycle(review, await sourceIdSet(input.dir, executionClass), currentReviewArtifacts)
    const observationAt = Date.now()
    executionControl = recordExecutionObservation(executionControl, executionBudget, {
      fingerprint: {
        material_objection_ids: [...convergence.material_objection_ids].sort(),
        blockers: [...convergence.blockers].sort(),
        reviewers: convergence.reviewers,
        material_objections: convergence.material_objections
      },
      elapsedMs: Math.max(0, observationAt - lastExecutionObservationAt),
      toolCalls: 1
    })
    lastExecutionObservationAt = observationAt
    if (remainingTimeoutMs(deadlineMs) <= 0) {
      executionControl = stopExecutionControl(executionControl, 'time_budget_exhausted', 'research review cycle completed after its absolute deadline')
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push('research_cycle_timeout_exceeded')
      break
    }
    if (convergence.ok) executionControl = completeExecutionControl(executionControl, true, 'adversarial reviewers converged with applicable evidence')
    await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
    if (convergence.ok) break
    if (executionControl.status !== 'running') {
      runtimeBlockers.push(researchExecutionStopBlocker(executionControl.stop_reason))
      break
    }
    if (cycle >= maxCycles || !convergence.revisable) {
      executionControl = stopExecutionControl(executionControl, 'explicit_stop', cycle >= maxCycles
        ? 'research review cycle budget exhausted without convergence'
        : 'research objections were not safely revisable')
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push(cycle >= maxCycles ? 'research_review_cycle_budget_exhausted' : 'research_review_not_revisable')
      break
    }
    if (remainingTimeoutMs(deadlineMs) <= 0) break
    const revisionResult = await runResearchOperationBeforeDeadline(deadlineMs, () => input.revisionCycleImpl
      ? input.revisionCycleImpl(input, cycle, maxThreads, convergence.material_objection_ids)
      : input.mock
        ? Promise.resolve(mockRevisionCycle(cycle, convergence.material_objection_ids))
        : runOfficialRevisionCycle({ ...input, timeoutMs: remainingTimeoutMs(deadlineMs), deadlineMs }, cycle, maxThreads, convergence.material_objection_ids))
    if (revisionResult.timed_out) {
      executionControl = stopExecutionControl(executionControl, 'time_budget_exhausted', 'research revision cycle exceeded its absolute deadline')
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push('research_cycle_timeout_exceeded')
      break
    }
    const revision = revisionResult.value
    revisions.push(revision)
    await writeJsonAtomic(path.join(input.dir, 'research', 'adversarial', `cycle-${cycle}`, 'revision.json'), revision)
    if (revision.ok !== true) {
      executionControl = stopExecutionControl(executionControl, 'explicit_stop', 'research revision failed')
      await writeJsonAtomic(path.join(input.dir, RESEARCH_EXECUTION_CONTROL_ARTIFACT), executionControl)
      runtimeBlockers.push('research_revision_failed')
      break
    }
    await syncSynthesisAfterRevision(input.dir, input.plan)
  }

  const gate = await finalizeResearchAdversarialArtifacts(input, plan, reviewCycles, revisions, executionClass, runtimeBlockers)
  return { ok: gate.passed === true, gate, plan, review_cycles: reviewCycles, revisions }
}

function researchExecutionStopBlocker(reason: unknown) {
  return reason === 'no_progress'
    ? 'research_review_no_progress'
    : `research_review_${String(reason || 'execution_stopped')}`
}

export function parseOfficialReviewParentSummary(raw: unknown) {
  const normalizedParent = normalizeSubagentParentSummary(raw)
  const blockers: string[] = [...normalizedParent.blockers]
  const parent = normalizedParent.raw
  if (!parent || !normalizedParent.trustworthy) {
    return {
      ok: false,
      parent: parent || null,
      reviewers: [] as ResearchReviewerOutcome[],
      blockers: unique(['official_subagent_parent_summary_invalid', ...blockers])
    }
  }
  if (normalizedParent.status !== 'completed') blockers.push(`official_subagent_parent_status:${String(parent.status || 'missing')}`)
  const rows = Array.isArray(parent.thread_outcomes) ? parent.thread_outcomes : []
  if (!rows.length) blockers.push('official_subagent_thread_outcomes_missing')
  const reviewers: ResearchReviewerOutcome[] = []
  for (const row of rows) {
    const parsed = parseJsonObject(row?.summary)
    if (!parsed) {
      blockers.push(`reviewer_outcome_unstructured:${String(row?.thread_id || 'unknown')}`)
      continue
    }
    const shapeBlockers = validateReviewerOutcomeShape(parsed, row)
    if (shapeBlockers.length) {
      blockers.push(...shapeBlockers)
      continue
    }
    const normalized = normalizeReviewerOutcome(parsed, row)
    reviewers.push(normalized)
  }
  for (const duplicate of duplicates(reviewers.map((reviewer) => reviewer.thread_id))) {
    blockers.push(`reviewer_thread_duplicate:${duplicate || 'missing'}`)
  }
  return { ok: blockers.length === 0, parent, reviewers, blockers: unique(blockers) }
}

export function evaluateReviewCycle(review: any, knownSourceIds: Set<string> = new Set(), currentReviewArtifacts: ResearchReviewArtifactDigest | null = null) {
  const reviewers: ResearchReviewerOutcome[] = Array.isArray(review?.reviewers) ? review.reviewers : []
  const blockers = [...normalizeStrings(review?.blockers)]
  const expectedIds = RESEARCH_AGENT_COUNCIL.map((agent: any) => String(agent.id))
  const personaIds = reviewers.map((reviewer) => reviewer.persona_id)
  const threadIds = reviewers.map((reviewer) => reviewer.thread_id)
  const recordedReviewArtifacts = review?.review_artifacts
  const expectedArtifactBundle = String(recordedReviewArtifacts?.bundle_sha256 || '')
  if (currentReviewArtifacts) blockers.push(...validateResearchReviewArtifactDigest(recordedReviewArtifacts, currentReviewArtifacts))
  else if (!expectedArtifactBundle) blockers.push('research_review_artifact_bundle_sha256_missing')
  for (const id of expectedIds) {
    if (!personaIds.includes(id)) blockers.push(`structured_reviewer_missing:${id}`)
  }
  for (const duplicate of duplicates(personaIds)) blockers.push(`structured_reviewer_duplicate:${duplicate}`)
  for (const duplicate of duplicates(threadIds)) blockers.push(`reviewer_thread_duplicate:${duplicate || 'missing'}`)
  for (const reviewer of reviewers) {
    if (reviewer.schema !== 'sks.research-adversarial-reviewer-outcome.v1') blockers.push(`reviewer_schema_invalid:${reviewer.persona_id || 'unknown'}`)
    if (!reviewer.thread_id) blockers.push(`reviewer_thread_id_missing:${reviewer.persona_id || 'unknown'}`)
    if (reviewer.thread_status !== 'completed') blockers.push(`reviewer_thread_not_completed:${reviewer.persona_id}`)
    if (!reviewer.strongest_challenge.trim()) blockers.push(`reviewer_challenge_missing:${reviewer.persona_id}`)
    if (!reviewer.evidence_source_ids.length) blockers.push(`reviewer_evidence_missing:${reviewer.persona_id}`)
    if (!reviewer.falsifiers.length) blockers.push(`reviewer_falsifiers_missing:${reviewer.persona_id}`)
    if (!reviewer.cheap_probes.length) blockers.push(`reviewer_cheap_probes_missing:${reviewer.persona_id}`)
    if (!reviewer.review_artifact_bundle_sha256) blockers.push(`reviewer_artifact_bundle_sha256_missing:${reviewer.persona_id}`)
    if (expectedArtifactBundle && reviewer.review_artifact_bundle_sha256 !== expectedArtifactBundle) blockers.push(`reviewer_artifact_bundle_sha256_mismatch:${reviewer.persona_id}`)
    for (const sourceId of reviewer.evidence_source_ids) {
      if (!knownSourceIds.has(sourceId)) blockers.push(`reviewer_evidence_source_unknown:${reviewer.persona_id}:${sourceId}`)
    }
    const objections = [...reviewer.critical_objections, ...reviewer.major_objections, ...reviewer.minor_objections]
    for (const objection of objections) {
      if (!objection.id || !objection.reason || !objection.required_revision) blockers.push(`reviewer_objection_invalid:${reviewer.persona_id}`)
      for (const sourceId of objection.source_ids) {
        if (!knownSourceIds.has(sourceId)) blockers.push(`reviewer_objection_source_unknown:${reviewer.persona_id}:${sourceId}`)
      }
    }
    const materialObjections = [...reviewer.critical_objections, ...reviewer.major_objections]
    if (reviewer.verdict === 'approve' && (materialObjections.length || reviewer.required_revisions.length)) {
      blockers.push(`reviewer_approve_with_unresolved_revision:${reviewer.persona_id}`)
    }
    if (reviewer.verdict !== 'approve' && !materialObjections.length && !reviewer.required_revisions.length) {
      blockers.push(`reviewer_nonapproval_without_objection:${reviewer.persona_id}`)
    }
  }
  const materialObjections = reviewers.flatMap((reviewer) => [
    ...reviewer.critical_objections,
    ...reviewer.major_objections,
    ...reviewer.required_revisions.map((revision, index) => ({
      id: `${reviewer.persona_id}-required-${index + 1}`,
      severity: 'major' as const,
      claim_ids: [],
      source_ids: reviewer.evidence_source_ids,
      reason: revision,
      required_revision: revision
    }))
  ])
  const advisoryObjections = reviewers.flatMap((reviewer) => reviewer.minor_objections)
  const allApproved = reviewers.length === expectedIds.length && reviewers.every((reviewer) => reviewer.verdict === 'approve')
  if (materialObjections.some((objection) => objection.severity === 'critical')) blockers.push('critical_objections_unresolved')
  if (materialObjections.some((objection) => objection.severity === 'major')) blockers.push('major_objections_unresolved')
  if (materialObjections.length) blockers.push('material_objections_unresolved')
  const convergenceOnly = new Set([
    'critical_objections_unresolved',
    'major_objections_unresolved',
    'material_objections_unresolved'
  ])
  const structuralBlockers = unique(blockers).filter((blocker) => !convergenceOnly.has(blocker) && !blocker.startsWith('reviewer_approve_with_unresolved_revision:'))
  return {
    ok: unique(blockers).length === 0,
    blockers: unique(blockers),
    reviewers: reviewers.length,
    all_approved: allApproved,
    critical_objections: materialObjections.filter((objection) => objection.severity === 'critical').length,
    major_objections: materialObjections.filter((objection) => objection.severity === 'major').length,
    material_objections: materialObjections.length,
    advisory_objections: advisoryObjections.length,
    material_objection_ids: unique(materialObjections.map((objection) => objection.id)),
    revisable: structuralBlockers.length === 0
      && reviewers.length === expectedIds.length
      && new Set(threadIds).size === expectedIds.length
      && reviewers.every((reviewer) => reviewer.thread_status === 'completed')
      && materialObjections.length > 0
  }
}

export function buildResearchAdversarialPlan(plan: any, maxCycles = 3, maxThreads = RESEARCH_AGENT_COUNCIL.length, config: any = null, modelPolicyEvidence: any = null) {
  return {
    schema: 'sks.research-adversarial-plan.v1',
    mission_id: String(plan?.mission_id || ''),
    generated_at: nowIso(),
    workflow: 'official_codex_subagent',
    max_depth: 1,
    max_threads: maxThreads,
    max_review_cycles: maxCycles,
    reviewer_count: RESEARCH_AGENT_COUNCIL.length,
    reviewers: RESEARCH_AGENT_COUNCIL.map((agent: any) => ({
      id: agent.id,
      display_name: researchAgentAgentName(agent),
      persona: agent.persona,
      persona_boundary: agent.persona_boundary,
      custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
      model_policy: `${THINKING_SUBAGENT_MODEL} ${SUBAGENT_EFFORT}`,
      model_policy_source: modelPolicyEvidence?.source || RESEARCH_REVIEWER_CONFIG_ARTIFACT,
      model_policy_sha256: modelPolicyEvidence?.sha256 || null
    })),
    convergence_policy: 'three distinct evidence-correlated official threads completed; no critical, major, or required revision remains; minor concerns remain recorded as advisory findings',
    revision_policy: 'bounded mission-artifact-only revision followed by a fresh independent review cycle',
    guarantees: {
      novelty: false,
      publication_acceptance: false
    },
    config_warnings: config?.warnings || [],
    config_blockers: config?.blockers || [],
    model_policy_evidence: modelPolicyEvidence || null
  }
}

async function runOfficialReviewCycle(
  input: ResearchAdversarialReviewLoopInput,
  cycle: number,
  maxThreads: number,
  reviewArtifacts: ResearchReviewArtifactDigest
) {
  const slices: OfficialSubagentSlice[] = RESEARCH_AGENT_COUNCIL.map((agent: any) => ({
    id: String(agent.id),
    title: `${researchAgentAgentName(agent)} adversarial paper review`,
    kind: 'expert',
    agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
    readOnly: true,
    paths: researchReviewArtifacts(input.plan),
    description: reviewerTaskDescription(agent, cycle, reviewArtifacts.bundle_sha256)
  }))
  const goal = reviewGoal(input, cycle, reviewArtifacts)
  const prompt = buildOfficialSubagentPrompt({
    goal,
    slices,
    maxThreads,
    requestedSubagents: slices.length,
    decompositionStatus: 'ready'
  })
  const lifecyclePlan = await prepareResearchSubagentRun(input, {
    phase: 'review',
    cycle,
    requested_subagents: slices.length,
    max_threads: maxThreads,
    slices,
    review_artifacts: reviewArtifacts
  })
  const run = await runWorkflow(input, {
    root: input.root,
    goal,
    prompt,
    requestedSubagents: slices.length,
    maxThreads,
    appSession: input.appSession ?? detectCodexAppSession(),
    missionId: String(input.plan?.mission_id || ''),
    sessionKey: input.sessionKey ?? codexAppSessionKey(),
    timeoutMs: input.timeoutMs,
    env: process.env
  })
  const lifecycle = await finalizeResearchSubagentRun(input, lifecyclePlan, run)
  const parsed = parseOfficialReviewParentSummary(lifecycle.parent_summary)
  const parsedThreadIds = parsed.reviewers.map((reviewer) => reviewer.thread_id).sort()
  const completedThreadIds = [...(lifecycle.evidence?.completed_thread_ids || [])].sort()
  const lifecycleThreadCorrelation = parsedThreadIds.length === completedThreadIds.length
    && parsedThreadIds.every((threadId, index) => threadId === completedThreadIds[index])
  return {
    schema: 'sks.research-adversarial-review-cycle.v1',
    cycle,
    execution_class: 'real',
    reviewed_at: nowIso(),
    workflow: sanitizeWorkflowRun(run),
    workflow_run_id: lifecyclePlan.workflow_run_id,
    review_artifacts: reviewArtifacts,
    subagent_evidence: lifecycle.evidence,
    reviewers: parsed.reviewers,
    blockers: unique([
      ...(run?.status === 'parent_completed' ? [] : [`official_subagent_review_status:${String(run?.status || 'missing')}`]),
      ...(run?.prepared === true ? ['official_subagent_review_preparation_only'] : []),
      ...(lifecycle.evidence?.ok === true ? [] : (lifecycle.evidence?.blockers || ['official_subagent_review_evidence_missing'])),
      ...(lifecycleThreadCorrelation ? [] : ['official_subagent_review_thread_correlation_failed']),
      ...parsed.blockers
    ])
  }
}

async function mockReviewCycle(input: ResearchAdversarialReviewLoopInput, cycle: number, reviewArtifacts: ResearchReviewArtifactDigest) {
  const sourceIds = [...await sourceIdSet(input.dir, 'mock_fixture')]
  const reviewers: ResearchReviewerOutcome[] = RESEARCH_AGENT_COUNCIL.map((agent: any, index: number) => ({
    schema: 'sks.research-adversarial-reviewer-outcome.v1',
    persona_id: String(agent.id),
    verdict: 'approve',
    strongest_challenge: `${researchAgentAgentName(agent)} fixture attempts to falsify unsupported synthesis, source gaps, and replication weakness.`,
    evidence_source_ids: sourceIds.slice(index, index + 2).length ? sourceIds.slice(index, index + 2) : sourceIds.slice(0, 1),
    critical_objections: [],
    major_objections: [],
    minor_objections: [],
    required_revisions: [],
    falsifiers: ['Remove cited source rows or leave a critical objection unresolved.'],
    cheap_probes: ['Run the adversarial convergence unit test.'],
    confidence: 'high',
    review_artifact_bundle_sha256: reviewArtifacts.bundle_sha256,
    thread_id: `mock-review-${cycle}-${agent.id}`,
    thread_status: 'completed'
  }))
  return {
    schema: 'sks.research-adversarial-review-cycle.v1',
    cycle,
    execution_class: 'mock_fixture',
    reviewed_at: nowIso(),
    workflow: { status: 'mock_fixture', workflow: 'official_codex_subagent_contract_fixture' },
    review_artifacts: reviewArtifacts,
    reviewers,
    blockers: []
  }
}

async function runOfficialRevisionCycle(input: ResearchAdversarialReviewLoopInput, cycle: number, maxThreads: number, objectionIds: string[]) {
  const before = await manuscriptHashes(input.dir, input.plan)
  const slice: OfficialSubagentSlice = {
    id: `research_revision_${cycle}`,
    title: `Evidence-bound manuscript revision cycle ${cycle}`,
    kind: 'expert',
    agent: 'research_synthesizer',
    readOnly: false,
    paths: researchReviewArtifacts(input.plan),
    description: [
      `Resolve only the objections recorded for review cycle ${cycle}: ${objectionIds.join(', ')}.`,
      'Edit only mission-local research-report.md, the dated research paper artifact, and research-synthesis-output.json.',
      'Do not invent evidence. If an objection needs unavailable evidence, downgrade/remove the claim or return blocked.',
      'Your thread outcome summary must itself be JSON: {"schema":"sks.research-revision-outcome.v1","status":"revised|blocked","addressed_objection_ids":[],"changed_artifacts":[],"remaining_blockers":[]}.'
    ].join(' ')
  }
  const goal = `Revise the Research manuscript in .sneakoscope/missions/${input.plan?.mission_id || ''}/ using review cycle ${cycle}. Preserve source IDs and falsifiability; never overstate novelty, breakthrough, or publication acceptance.`
  const prompt = buildOfficialSubagentPrompt({
    goal,
    slices: [slice],
    maxThreads: Math.min(1, maxThreads),
    requestedSubagents: 1,
    decompositionStatus: 'ready'
  })
  const lifecyclePlan = await prepareResearchSubagentRun(input, {
    phase: 'revision',
    cycle,
    requested_subagents: 1,
    max_threads: 1,
    slices: [slice]
  })
  const run = await runWorkflow(input, {
    root: input.root,
    goal,
    prompt,
    requestedSubagents: 1,
    maxThreads: 1,
    appSession: input.appSession ?? detectCodexAppSession(),
    missionId: String(input.plan?.mission_id || ''),
    sessionKey: input.sessionKey ?? codexAppSessionKey(),
    timeoutMs: input.timeoutMs,
    env: process.env
  })
  const lifecycle = await finalizeResearchSubagentRun(input, lifecyclePlan, run)
  const parent = parseJsonObject(lifecycle.parent_summary)
  const outcomeRow = Array.isArray(parent?.thread_outcomes) ? parent.thread_outcomes[0] : null
  const outcome = parseJsonObject(outcomeRow?.summary)
  const after = await manuscriptHashes(input.dir, input.plan)
  const changedArtifacts = Object.keys(after).filter((artifact) => after[artifact] !== before[artifact])
  const blockers = [
    ...(run?.status === 'parent_completed' ? [] : [`official_subagent_revision_status:${String(run?.status || 'missing')}`]),
    ...(run?.prepared === true ? ['official_subagent_revision_preparation_only'] : []),
    ...(lifecycle.evidence?.ok === true ? [] : (lifecycle.evidence?.blockers || ['official_subagent_revision_evidence_missing'])),
    ...(parent?.status === 'completed' ? [] : ['official_subagent_revision_parent_not_completed']),
    ...(outcome?.schema === 'sks.research-revision-outcome.v1' ? [] : ['research_revision_outcome_unstructured']),
    ...(outcome?.status === 'revised' ? [] : normalizeStrings(outcome?.remaining_blockers).length ? normalizeStrings(outcome.remaining_blockers) : ['research_revision_not_completed']),
    ...(changedArtifacts.length ? [] : ['research_revision_artifacts_unchanged'])
  ]
  return {
    schema: 'sks.research-revision-cycle.v1',
    cycle,
    revised_at: nowIso(),
    ok: unique(blockers).length === 0,
    objection_ids: objectionIds,
    addressed_objection_ids: normalizeStrings(outcome?.addressed_objection_ids),
    changed_artifacts: changedArtifacts,
    before,
    after,
    workflow: sanitizeWorkflowRun(run),
    workflow_run_id: lifecyclePlan.workflow_run_id,
    subagent_evidence: lifecycle.evidence,
    blockers: unique(blockers)
  }
}

function mockRevisionCycle(cycle: number, objectionIds: string[]) {
  return {
    schema: 'sks.research-revision-cycle.v1',
    cycle,
    revised_at: nowIso(),
    ok: false,
    objection_ids: objectionIds,
    addressed_objection_ids: [],
    changed_artifacts: [],
    workflow: { status: 'mock_fixture_no_revision_needed' },
    blockers: ['mock_revision_not_expected']
  }
}

async function finalizeResearchAdversarialArtifacts(
  input: ResearchAdversarialReviewLoopInput,
  plan: any,
  reviewCycles: any[],
  revisions: any[],
  executionClass: 'real' | 'mock_fixture',
  initialBlockers: string[]
) {
  const finalReview = reviewCycles.at(-1) || null
  const currentReviewArtifacts = await buildResearchReviewArtifactDigest(input.dir, input.plan)
  const convergence = evaluateReviewCycle(finalReview, await sourceIdSet(input.dir, executionClass), currentReviewArtifacts)
  const honest = await buildResearchHonestMode(input.dir, input.plan, executionClass)
  const blockers = unique([
    ...initialBlockers,
    ...(finalReview ? [] : ['adversarial_review_cycle_missing']),
    ...convergence.blockers,
    ...(honest.ok ? [] : honest.blockers),
    ...(reviewCycles.length > plan.max_review_cycles ? ['adversarial_review_cycle_budget_exceeded'] : [])
  ])
  const gate = {
    schema: 'sks.research-adversarial-convergence.v1',
    checked_at: nowIso(),
    execution_class: executionClass,
    passed: blockers.length === 0,
    official_subagent_workflow: true,
    official_subagent_evidence_ok: executionClass === 'mock_fixture' ? true : finalReview?.subagent_evidence?.ok === true,
    workflow_run_id: finalReview?.workflow_run_id || null,
    reviewer_count_required: RESEARCH_AGENT_COUNCIL.length,
    reviewer_count_observed: convergence.reviewers,
    review_cycles: reviewCycles.length,
    revision_cycles: revisions.length,
    review_artifacts: finalReview?.review_artifacts || null,
    review_artifact_bundle_sha256: finalReview?.review_artifacts?.bundle_sha256 || null,
    current_artifact_bundle_sha256: currentReviewArtifacts.bundle_sha256,
    review_artifact_hashes_ok: !convergence.blockers.some((blocker) => blocker.includes('artifact')),
    unresolved_critical_objections: convergence.critical_objections,
    unresolved_major_objections: convergence.major_objections,
    unresolved_material_objections: convergence.material_objections,
    advisory_objections: convergence.advisory_objections,
    honest_mode_ok: honest.ok,
    novelty_guaranteed: false,
    publication_acceptance_guaranteed: false,
    reviewer_model_policy: {
      custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
      model: THINKING_SUBAGENT_MODEL,
      reasoning_effort: SUBAGENT_EFFORT,
      enforcement_source: plan?.model_policy_evidence?.source || RESEARCH_REVIEWER_CONFIG_ARTIFACT,
      config_sha256: plan?.model_policy_evidence?.sha256 || null,
      observed_model_exposed_by_hook: false
    },
    blockers
  }
  const ledger = {
    schema: 'sks.research-adversarial-review-ledger.v1',
    generated_at: nowIso(),
    execution_class: executionClass,
    review_cycles: reviewCycles,
    final_cycle: finalReview?.cycle || null,
    convergence_artifact: RESEARCH_CONVERGENCE_GATE_ARTIFACT,
    blockers
  }
  const revisionLedger = {
    schema: 'sks.research-revision-ledger.v1',
    generated_at: nowIso(),
    bounded_max_cycles: plan.max_review_cycles,
    revisions,
    blockers: revisions.flatMap((revision) => normalizeStrings(revision?.blockers))
  }
  await writeJsonAtomic(path.join(input.dir, RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT), ledger)
  await writeJsonAtomic(path.join(input.dir, RESEARCH_REVISION_LEDGER_ARTIFACT), revisionLedger)
  await writeJsonAtomic(path.join(input.dir, RESEARCH_CONVERGENCE_GATE_ARTIFACT), gate)
  await writeJsonAtomic(path.join(input.dir, RESEARCH_HONEST_MODE_ARTIFACT), honest)
  await writeCompatibilityCouncilArtifacts(input.dir, input.plan, finalReview, gate)
  return gate
}

async function writeCompatibilityCouncilArtifacts(dir: string, plan: any, finalReview: any, gate: any) {
  const reviews: ResearchReviewerOutcome[] = Array.isArray(finalReview?.reviewers) ? finalReview.reviewers : []
  const byPersona = new Map(reviews.map((review) => [review.persona_id, review]))
  const agents = RESEARCH_AGENT_COUNCIL.map((agent: any) => {
    const review = byPersona.get(String(agent.id))
    if (!review) return null
    return {
      id: agent.id,
      agent_name: researchAgentAgentName(agent),
      display_name: agent.display_name,
      persona: agent.persona,
      persona_boundary: agent.persona_boundary,
      role: agent.role,
      mandate: agent.mandate,
      model_policy: {
        custom_agent: RESEARCH_REVIEWER_CUSTOM_AGENT,
        model: THINKING_SUBAGENT_MODEL,
        reasoning_effort: SUBAGENT_EFFORT,
        enforcement_source: gate?.reviewer_model_policy?.enforcement_source || RESEARCH_REVIEWER_CONFIG_ARTIFACT,
        config_sha256: gate?.reviewer_model_policy?.config_sha256 || null
      },
      observed_model: null,
      observed_reasoning_effort: null,
      model_observation_status: 'official_hook_schema_does_not_expose_model; enforced by verified research-reviewer.toml',
      official_subagent_thread_id: review.thread_id,
      review_verdict: review.verdict,
      findings: [{
        id: `${agent.id}-adversarial-review`,
        claim: review.strongest_challenge,
        source_ids: review.evidence_source_ids,
        status: review.verdict === 'approve' ? 'survived_adversarial_review' : 'revision_required'
      }],
      falsifiers: review.falsifiers,
      cheap_probes: review.cheap_probes,
      challenge_or_response: review.strongest_challenge
    }
  }).filter(Boolean)
  await writeJsonAtomic(path.join(dir, 'agent-ledger.json'), {
    schema_version: 1,
    council_mode: 'official_subagent_independent_adversarial_review',
    created_at: nowIso(),
    agents,
    synthesis: {
      surviving_claims: gate.passed ? ['manuscript_survived_all_structured_reviews'] : [],
      downgraded_claims: [],
      unresolved_conflicts: reviews.flatMap((review) => [...review.critical_objections, ...review.major_objections, ...review.minor_objections].map((objection) => objection.id))
    }
  })
  await writeJsonAtomic(path.join(dir, 'debate-ledger.json'), {
    schema_version: 1,
    created_at: nowIso(),
    mode: 'independent_adversarial_reviews_with_bounded_revision_cycles',
    required_participants: RESEARCH_AGENT_COUNCIL.map((agent: any) => agent.id),
    participant_display_names: RESEARCH_AGENT_COUNCIL.map((agent: any) => researchAgentAgentName(agent)),
    consensus_iterations: Math.max(1, Number(finalReview?.cycle || 0)),
    review_complete: gate.passed === true,
    agent_agreements: reviews.map((review) => ({
      agent_id: review.persona_id,
      agent_name: researchAgentAgentName(RESEARCH_AGENT_COUNCIL.find((agent: any) => agent.id === review.persona_id)),
      material_objections_resolved: review.critical_objections.length === 0
        && review.major_objections.length === 0
        && review.required_revisions.length === 0,
      final_position: review.strongest_challenge,
      source_ids: review.evidence_source_ids
    })),
    exchanges: reviews.map((review, index) => ({
      id: `official-adversarial-review-${index + 1}`,
      from: review.persona_id,
      to: 'research_synthesis',
      stance: 'challenge',
      claim: review.strongest_challenge,
      source_ids: review.evidence_source_ids,
      verdict: review.verdict
    })),
    synthesis_pressure: {
      strongest_disagreement: reviews.find((review) => review.verdict !== 'approve')?.strongest_challenge || 'All reviewers attempted falsification and approved the bounded evidence claims.',
      changed_minds: [],
      unresolved_conflicts: reviews.flatMap((review) => [...review.critical_objections, ...review.major_objections, ...review.minor_objections].map((objection) => objection.id))
    }
  })
}

export async function buildResearchHonestMode(dir: string, plan: any, executionClass: 'real' | 'mock_fixture') {
  const report = await readText(path.join(dir, 'research-report.md'), '')
  const paper = await readText(path.join(dir, researchPaperArtifactForPlan(plan)), '')
  const claimMatrix = await readJson(path.join(dir, 'claim-evidence-matrix.json'), null)
  const noveltyLedger = await readJson(path.join(dir, 'novelty-ledger.json'), null)
  const sourceLedger = await readJson(path.join(dir, 'source-ledger.json'), null)
  const text = `${report}\n${paper}`
  const overclaims = detectUnsupportedResearchOverclaims(text)
  const structuredAudit = auditStructuredResearchClaims(text, claimMatrix, noveltyLedger, sourceLedger)
  const blockers = unique([
    ...overclaims.map((claim) => `unsupported_research_overclaim:${claim}`),
    ...structuredAudit.blockers
  ])
  return {
    schema: 'sks.research-honest-mode.v1',
    checked_at: nowIso(),
    execution_class: executionClass,
    ok: blockers.length === 0,
    guarantees: {
      novelty: false,
      breakthrough: false,
      publication_acceptance: false
    },
    verified_claim: executionClass === 'mock_fixture'
      ? 'Only artifact shape and fail-closed gate behavior were exercised.'
      : 'Only source-linked claims that survived the recorded structured reviews may be presented as supported.',
    unverified: ['scientific novelty absent an external prior-art study', 'peer-review or publication acceptance'],
    overclaims,
    claim_level_checks: structuredAudit.claim_level_checks,
    prior_art_proof: structuredAudit.prior_art_proof,
    blockers
  }
}

function auditStructuredResearchClaims(text: string, claimMatrix: any, noveltyLedger: any, sourceLedger: any) {
  const claims = Array.isArray(claimMatrix?.claims) ? claimMatrix.claims : []
  const entries = Array.isArray(noveltyLedger?.entries) ? noveltyLedger.entries : []
  const keyClaimIds = new Set((Array.isArray(claimMatrix?.key_claim_ids) ? claimMatrix.key_claim_ids : claims.map((claim: any) => claim?.id)).map(String).filter(Boolean))
  const sourceRows = [
    ...(Array.isArray(sourceLedger?.sources) ? sourceLedger.sources : []),
    ...(Array.isArray(sourceLedger?.counterevidence_sources) ? sourceLedger.counterevidence_sources : [])
  ]
  const verifiedSourceIds = new Set(sourceRows
    .filter((source: any) => String(source?.acquisition_verdict || '') === 'verified_content'
      && Boolean(String(source?.content_artifact || '').trim())
      && /^[a-f0-9]{64}$/i.test(String(source?.content_sha256 || ''))
      && Number(source?.content_length || 0) > 0
      && source?.super_search_provenance?.validated === true)
    .map((source: any) => String(source?.id || source?.source_id || '')).filter(Boolean))
  const entriesByClaim = new Map(entries.map((entry: any) => [String(entry?.claim_id || entry?.id || ''), entry]))
  const claimLevelChecks = claims.map((claim: any) => {
    const claimId = String(claim?.id || '')
    const claimText = String(claim?.claim || claim?.text || '')
    const entry = entriesByClaim.get(claimId) as any
    const priorArtSourceIds = normalizeStrings([
      ...(Array.isArray(entry?.prior_art_source_ids) ? entry.prior_art_source_ids : []),
      ...(Array.isArray(entry?.prior_art_evidence_ids) ? entry.prior_art_evidence_ids : []),
      ...(Array.isArray(entry?.prior_art_ids) ? entry.prior_art_ids : [])
    ])
    const verifiedPriorArtSourceIds = priorArtSourceIds.filter((sourceId) => verifiedSourceIds.has(sourceId))
    const noveltyAsserted = detectAssertiveNoveltyClaims(claimText).length > 0
    const guaranteeOverclaims = detectUnsupportedResearchOverclaims(claimText)
    const blockers = [
      ...guaranteeOverclaims.map(() => `unsupported_structured_claim:${claimId || 'unknown'}`),
      ...(noveltyAsserted && verifiedPriorArtSourceIds.length === 0 ? [`novelty_claim_without_prior_art_proof:${claimId || 'unknown'}`] : [])
    ]
    return {
      claim_id: claimId || null,
      key_claim: keyClaimIds.has(claimId),
      novelty_asserted: noveltyAsserted,
      prior_art_source_ids: priorArtSourceIds,
      verified_prior_art_source_ids: verifiedPriorArtSourceIds,
      guarantee_overclaim_count: guaranteeOverclaims.length,
      ok: blockers.length === 0,
      blockers
    }
  })
  const manuscriptNoveltyAssertions = detectAssertiveNoveltyClaims(text)
  const keyClaimChecks = claimLevelChecks.filter((check: any) => check.key_claim)
  const priorArtCoverageComplete = keyClaimChecks.length > 0
    && keyClaimChecks.every((check: any) => check.verified_prior_art_source_ids.length > 0)
  const blockers = unique([
    ...claimLevelChecks.flatMap((check: any) => check.blockers),
    ...(manuscriptNoveltyAssertions.length > 0 && !priorArtCoverageComplete
      ? manuscriptNoveltyAssertions.map((sentence) => `novelty_claim_without_prior_art_proof:${sentence.slice(0, 180)}`)
      : [])
  ])
  return {
    claim_level_checks: claimLevelChecks,
    prior_art_proof: {
      key_claim_count: keyClaimChecks.length,
      key_claims_with_verified_prior_art: keyClaimChecks.filter((check: any) => check.verified_prior_art_source_ids.length > 0).length,
      coverage_complete: priorArtCoverageComplete,
      manuscript_novelty_assertions: manuscriptNoveltyAssertions
    },
    blockers
  }
}

function detectAssertiveNoveltyClaims(text: unknown): string[] {
  const sentences = String(text || '').split(/(?<=[.!?。！？\n])\s*/u).map((row) => row.trim()).filter(Boolean)
  const assertions = [
    /\b(?:establish(?:es|ed)?|prov(?:e|es|ed)|demonstrat(?:e|es|ed)|confirm(?:s|ed)?|validat(?:e|es|ed))\b[^.!?\n]{0,80}\b(?:novelty|novel|world[- ]?first|unprecedented|original contribution)\b/i,
    /\b(?:novelty|world[- ]?first status|original contribution)\b[^.!?\n]{0,60}\b(?:is|was|has been)\s+(?:established|proven|demonstrated|confirmed|validated)\b/i,
    /(?:신규성|독창성|세계\s*최초)[^。！？\n]{0,60}(?:입증|확립|검증|증명)(?:했다|한다|되었다|됐다|합니다)?/i
  ]
  const negations = [
    /\b(?:not|never|cannot|can't|unverified|unproven|not yet)\b/i,
    /(?:입증되지\s*않|확립되지\s*않|검증되지\s*않|증명할\s*수\s*없|미검증)/i
  ]
  return unique(sentences.filter((sentence) => !negations.some((pattern) => pattern.test(sentence)) && assertions.some((pattern) => pattern.test(sentence))).map((sentence) => sentence.slice(0, 240)))
}

export function detectUnsupportedResearchOverclaims(text: unknown): string[] {
  const sentences = String(text || '').split(/(?<=[.!?。！？\n])\s*/u).map((row) => row.trim()).filter(Boolean)
  const positivePatterns = [
    /\bguarantee(?:d|s|ing)?\b[^.!?\n]{0,80}\b(?:genius(?:-level)?|novel(?:ty)?|breakthrough|world[- ]?first|publication acceptance|peer[- ]?review acceptance)\b/i,
    /\b(?:einstein|von neumann)[-\s]+level\b[^.!?\n]{0,60}\b(?:intelligence|quality|genius|paper|research)\b/i,
    /\b(?:proven|demonstrably|certainly|definitively)\b[^.!?\n]{0,60}\b(?:novel|breakthrough|revolutionary|world[- ]?first)\b/i,
    /\bthis\s+is\s+(?:an?\s+)?(?:world[- ]?first|breakthrough|revolutionary|unprecedented|definitively\s+novel)\b[^.!?\n]{0,50}\b(?:paper|research|study|result|discovery|theory|method|achievement)\b/i,
    /\b(?:this|our)\s+(?:world[- ]?first|breakthrough|revolutionary|unprecedented|definitively\s+novel)\s+(?:paper|research|study|result|discovery|theory|method|achievement)\b/i,
    /\b(?:this|our)\s+(?:paper|research|study|result|work|discovery|method)\s+(?:is|represents|constitutes|delivers|establishes|proves|demonstrates)\s+(?:an?\s+)?(?:world[- ]?first|breakthrough|revolutionary|unprecedented|definitively\s+novel|novel\s+(?:theory|method|discovery))\b/i,
    /\bpeer[- ]?reviewers?\s+(?:will|would|must)\s+(?:(?:certainly|definitely|inevitably)\s+)?(?:accept|approve|publish)\b/i,
    /\b(?:publication|peer[- ]?review)\s+acceptance\s+(?:is|will\s+be)\s+(?:certain|assured|guaranteed|inevitable)\b/i,
    /(?:아인슈타인급|폰\s*노이만급|천재급)[^。！？\n]{0,80}(?:지능|천재성|수준|품질|논문|연구)/i,
    /(?:세계\s*최초|전례\s*없는|혁명적|돌파구)[^。！？\n]{0,80}(?:논문|연구|발견|성과|혁신)/i,
    /(?:천재성|독창성|신규성|혁신성|세계\s*최초|출판|게재|채택)[^。！？\n]{0,80}(?:보장(?:한다|합니다|됨|된다)|입증(?:했다|합니다|됨|된다)|확실(?:하다|합니다))/i
  ]
  const negationPatterns = [
    /\b(?:do|does|did)\s+not\s+guarantee\b/i,
    /\b(?:cannot|can't|never|no)\s+(?:be\s+)?guarantee(?:d)?\b/i,
    /\bno\s+guarantee\b/i,
    /\b(?:not|never)\s+(?:proven|established|verified|claimed)\b/i,
    /\b(?:is|are|was|were)\s+not\s+(?:an?\s+)?(?:world[- ]?first|breakthrough|revolutionary|unprecedented|novel)\b/i,
    /\bpeer[- ]?reviewers?\s+(?:will|would)\s+not\s+(?:necessarily\s+)?(?:accept|approve|publish)\b/i,
    /(?:보장하지\s*않|보장할\s*수\s*없|보장되지\s*않|주장하지\s*않|입증되지\s*않|확인되지\s*않|아니며|아니다|미보장)/i
  ]
  const overclaims: string[] = []
  for (const sentence of sentences) {
    if (negationPatterns.some((pattern) => pattern.test(sentence))) continue
    if (positivePatterns.some((pattern) => pattern.test(sentence))) overclaims.push(sentence.slice(0, 240))
  }
  return unique(overclaims)
}

function reviewGoal(input: ResearchAdversarialReviewLoopInput, cycle: number, reviewArtifacts: ResearchReviewArtifactDigest): string {
  return [
    `Adversarially review Research mission ${input.plan?.mission_id || 'unknown'} cycle ${cycle}.`,
    `Topic: ${input.plan?.prompt || ''}`,
    'Read source-ledger.json, claim-evidence-matrix.json, falsification-ledger.json, research-report.md, and the dated research paper artifact.',
    `Review only the exact artifact bundle with SHA-256 ${reviewArtifacts.bundle_sha256}. The per-artifact hashes are ${JSON.stringify(reviewArtifacts.artifacts)}.`,
    'Attempt to reject the manuscript. Approve only if the strongest challenge fails against cited evidence and no material revision remains. Record minor concerns as advisory findings.',
    'Each subagent thread outcome summary must itself be one compact JSON object matching sks.research-adversarial-reviewer-outcome.v1.',
    'Do not overstate novelty, breakthrough status, peer review, or publication acceptance.'
  ].join(' ')
}

function reviewerTaskDescription(agent: any, cycle: number, artifactBundleSha256: string): string {
  return [
    `Cycle ${cycle}. Apply the ${agent.display_name} review dimension: ${agent.mandate}`,
    agent.persona_boundary,
    `The exact review artifact bundle SHA-256 is ${artifactBundleSha256}. Copy it unchanged into review_artifact_bundle_sha256.`,
    'Return your thread outcome summary as JSON with fields:',
    '{"schema":"sks.research-adversarial-reviewer-outcome.v1","persona_id":"' + agent.id + '","verdict":"approve|revise|reject","strongest_challenge":"...","evidence_source_ids":[],"critical_objections":[{"id":"...","severity":"critical","claim_ids":[],"source_ids":[],"reason":"...","required_revision":"..."}],"major_objections":[],"minor_objections":[],"required_revisions":[],"falsifiers":[],"cheap_probes":[],"confidence":"low|medium|high","review_artifact_bundle_sha256":"' + artifactBundleSha256 + '"}.',
    'Use only source IDs that exist in source-ledger.json. An approve verdict must have no critical or major objection and no required revision. Minor objections are advisory. Return nonempty falsifiers and cheap_probes.'
  ].join(' ')
}

function researchReviewArtifacts(plan: any): string[] {
  const prefix = `.sneakoscope/missions/${plan?.mission_id || ''}/`
  return [
    'source-ledger.json',
    'claim-evidence-matrix.json',
    'falsification-ledger.json',
    'research-report.md',
    researchPaperArtifactForPlan(plan),
    RESEARCH_ADVERSARIAL_REVIEW_ARTIFACT
  ].map((artifact) => `${prefix}${artifact}`)
}

async function runWorkflow(input: ResearchAdversarialReviewLoopInput, workflow: OfficialSubagentWorkflowInput) {
  return (input.runWorkflowImpl || runOfficialSubagentWorkflow)(workflow)
}

function sanitizeWorkflowRun(run: any) {
  return {
    schema: run?.schema || null,
    workflow: run?.workflow || null,
    status: run?.status || null,
    ok: run?.ok === true,
    prepared: run?.prepared === true,
    requested_subagents: Number(run?.requested_subagents || 0),
    max_threads: Number(run?.max_threads || 0),
    max_depth: Number(run?.max_depth || 0),
    parent_model: run?.parent_model || null,
    parent_reasoning_effort: run?.parent_reasoning_effort || null,
    session_scope: run?.session_scope || null,
    codex_exit_code: run?.codex_exit_code ?? null
  }
}

function normalizeReviewerOutcome(value: any, threadRow: any): ResearchReviewerOutcome {
  return {
    schema: 'sks.research-adversarial-reviewer-outcome.v1',
    persona_id: String(value?.persona_id || '').trim(),
    verdict: ['approve', 'revise', 'reject'].includes(value?.verdict) ? value.verdict : 'reject',
    strongest_challenge: String(value?.strongest_challenge || '').trim(),
    evidence_source_ids: normalizeStrings(value?.evidence_source_ids),
    critical_objections: normalizeObjections(value?.critical_objections, 'critical'),
    major_objections: normalizeObjections(value?.major_objections, 'major'),
    minor_objections: normalizeObjections(value?.minor_objections, 'minor'),
    required_revisions: normalizeStrings(value?.required_revisions),
    falsifiers: normalizeStrings(value?.falsifiers),
    cheap_probes: normalizeStrings(value?.cheap_probes),
    confidence: ['low', 'medium', 'high'].includes(value?.confidence) ? value.confidence : 'low',
    review_artifact_bundle_sha256: String(value?.review_artifact_bundle_sha256 || '').trim(),
    thread_id: String(threadRow?.thread_id || '').trim(),
    thread_status: ['completed', 'blocked', 'failed'].includes(threadRow?.status) ? threadRow.status : 'failed'
  }
}

function validateReviewerOutcomeShape(value: any, threadRow: any): string[] {
  const threadId = String(threadRow?.thread_id || '').trim()
  const personaId = String(value?.persona_id || '').trim()
  const blockers: string[] = []
  const allowedKeys = new Set([
    'schema',
    'persona_id',
    'verdict',
    'strongest_challenge',
    'evidence_source_ids',
    'critical_objections',
    'major_objections',
    'minor_objections',
    'required_revisions',
    'falsifiers',
    'cheap_probes',
    'confidence',
    'review_artifact_bundle_sha256'
  ])
  if (value?.schema !== 'sks.research-adversarial-reviewer-outcome.v1') blockers.push(`reviewer_schema_invalid:${threadId || 'unknown'}`)
  if (!threadId) blockers.push('reviewer_thread_id_missing:unknown')
  if (threadRow?.status !== 'completed') blockers.push(`reviewer_thread_not_completed:${threadId || 'unknown'}`)
  if (!personaId) blockers.push(`reviewer_persona_missing:${threadId || 'unknown'}`)
  if (!['approve', 'revise', 'reject'].includes(value?.verdict)) blockers.push(`reviewer_verdict_invalid:${personaId || threadId || 'unknown'}`)
  if (!String(value?.strongest_challenge || '').trim()) blockers.push(`reviewer_challenge_missing:${personaId || threadId || 'unknown'}`)
  for (const key of ['evidence_source_ids', 'critical_objections', 'major_objections', 'minor_objections', 'required_revisions', 'falsifiers', 'cheap_probes']) {
    if (!Array.isArray(value?.[key])) blockers.push(`reviewer_field_not_array:${personaId || threadId || 'unknown'}:${key}`)
  }
  if (!['low', 'medium', 'high'].includes(value?.confidence)) blockers.push(`reviewer_confidence_invalid:${personaId || threadId || 'unknown'}`)
  if (!/^[a-f0-9]{64}$/i.test(String(value?.review_artifact_bundle_sha256 || ''))) blockers.push(`reviewer_artifact_bundle_sha256_invalid:${personaId || threadId || 'unknown'}`)
  for (const key of Object.keys(value || {})) {
    if (!allowedKeys.has(key)) blockers.push(`reviewer_unknown_field:${personaId || threadId || 'unknown'}:${key}`)
  }
  for (const [field, severity] of [['critical_objections', 'critical'], ['major_objections', 'major'], ['minor_objections', 'minor']] as const) {
    for (const [index, objection] of (Array.isArray(value?.[field]) ? value[field] : []).entries()) {
      if (!objection || typeof objection !== 'object' || Array.isArray(objection)) {
        blockers.push(`reviewer_objection_invalid:${personaId || threadId || 'unknown'}:${field}:${index}`)
        continue
      }
      if (objection.severity !== severity) blockers.push(`reviewer_objection_severity_invalid:${personaId || threadId || 'unknown'}:${field}:${index}`)
      if (!String(objection.id || '').trim() || !String(objection.reason || '').trim() || !String(objection.required_revision || '').trim()) {
        blockers.push(`reviewer_objection_invalid:${personaId || threadId || 'unknown'}:${field}:${index}`)
      }
      if (!Array.isArray(objection.claim_ids) || !Array.isArray(objection.source_ids)) blockers.push(`reviewer_objection_links_invalid:${personaId || threadId || 'unknown'}:${field}:${index}`)
    }
  }
  return unique(blockers)
}

interface ResearchSubagentRunPlan {
  workflow_run_id: string
  phase: 'review' | 'revision'
  cycle: number
  requested_subagents: number
  max_threads: number
  slices: OfficialSubagentSlice[]
  review_artifacts?: ResearchReviewArtifactDigest
}

async function prepareResearchSubagentRun(
  input: ResearchAdversarialReviewLoopInput,
  opts: Omit<ResearchSubagentRunPlan, 'workflow_run_id'>
): Promise<ResearchSubagentRunPlan> {
  const plan: ResearchSubagentRunPlan = {
    ...opts,
    workflow_run_id: `research-${opts.phase}-${opts.cycle}-${randomId(12)}`
  }
  await Promise.all([
    fsp.rm(path.join(input.dir, SUBAGENT_EVENT_LOG_FILENAME), { force: true }),
    fsp.rm(path.join(input.dir, SUBAGENT_EVIDENCE_FILENAME), { force: true }),
    fsp.rm(path.join(input.dir, SUBAGENT_PARENT_SUMMARY_FILENAME), { force: true })
  ])
  await writeJsonAtomic(path.join(input.dir, 'subagent-plan.json'), {
    schema: 'sks.subagent-plan.v1',
    workflow: 'official_codex_subagent',
    route: '$Research',
    mission_id: String(input.plan?.mission_id || ''),
    workflow_run_id: plan.workflow_run_id,
    phase: plan.phase,
    cycle: plan.cycle,
    requested_subagents: plan.requested_subagents,
    max_threads: plan.max_threads,
    max_depth: 1,
    ...(plan.review_artifacts ? { review_artifacts: plan.review_artifacts } : {}),
    slices: plan.slices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      kind: slice.kind,
      agent: slice.agent || null,
      read_only: slice.readOnly === true,
      paths: slice.paths || []
    })),
    model_policy: {
      custom_agent: plan.phase === 'review' ? RESEARCH_REVIEWER_CUSTOM_AGENT : 'research_synthesizer',
      model: THINKING_SUBAGENT_MODEL,
      reasoning_effort: SUBAGENT_EFFORT,
      config: plan.phase === 'review' ? RESEARCH_REVIEWER_CONFIG_ARTIFACT : '.codex/agents/research-synthesizer.toml'
    }
  })
  await writeTextAtomic(path.join(input.dir, SUBAGENT_EVENT_LOG_FILENAME), '')
  await writeJsonAtomic(path.join(input.dir, 'research', 'adversarial', `cycle-${plan.cycle}`, `${plan.phase}-subagent-plan.json`), plan)
  return plan
}

async function finalizeResearchSubagentRun(input: ResearchAdversarialReviewLoopInput, plan: ResearchSubagentRunPlan, run: any) {
  const boundParentSummary = bindTrustworthySubagentParentSummaryToRun(run?.parent_summary, plan.workflow_run_id)
  const parentSummary = await persistOrReuseTrustworthySubagentParentSummary(input.dir, boundParentSummary, {
    workflowStatus: run?.status || null
  })
  const events = await readSubagentEvents(input.dir)
  const evidence = await writeSubagentEvidence(input.dir, {
    requestedSubagents: plan.requested_subagents,
    events,
    parentSummary,
    parentSummaryPresent: parentSummary !== null && parentSummary !== undefined,
    workflowStatus: run?.status || null,
    preparationOnly: run?.prepared === true,
    runId: plan.workflow_run_id,
    additionalBlockers: [
      ...(run?.status === 'parent_completed' ? [] : [`official_subagent_workflow_status:${String(run?.status || 'missing')}`]),
      ...(run?.codex_exit_code === undefined || run?.codex_exit_code === null || run?.codex_exit_code === 0 ? [] : [`official_subagent_codex_exit:${run.codex_exit_code}`])
    ]
  })
  const prefix = path.join(input.dir, 'research', 'adversarial', `cycle-${plan.cycle}`)
  await writeJsonAtomic(path.join(prefix, `${plan.phase}-subagent-evidence.json`), evidence)
  await writeTextAtomic(path.join(prefix, `${plan.phase}-subagent-events.jsonl`), await readText(path.join(input.dir, SUBAGENT_EVENT_LOG_FILENAME), ''))
  const normalizedParent = normalizeSubagentParentSummary(parentSummary)
  if (normalizedParent.raw) await writeJsonAtomic(path.join(prefix, `${plan.phase}-subagent-parent-summary.json`), normalizedParent.raw)
  return { parent_summary: parentSummary, evidence }
}

async function verifyResearchReviewerRoleConfig(root: string) {
  const source = RESEARCH_REVIEWER_CONFIG_ARTIFACT
  const text = await readText(path.join(root, source), '')
  const name = /^\s*name\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] || ''
  const model = /^\s*model\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] || ''
  const effort = /^\s*model_reasoning_effort\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] || ''
  const sandbox = /^\s*sandbox_mode\s*=\s*"([^"]+)"\s*$/m.exec(text)?.[1] || ''
  const blockers = [
    ...(text.trim() ? [] : ['research_reviewer_agent_config_missing']),
    ...(name === RESEARCH_REVIEWER_CUSTOM_AGENT ? [] : [`research_reviewer_name_mismatch:${name || 'missing'}`]),
    ...(model === THINKING_SUBAGENT_MODEL ? [] : [`research_reviewer_model_mismatch:${model || 'missing'}`]),
    ...(effort === SUBAGENT_EFFORT ? [] : [`research_reviewer_effort_mismatch:${effort || 'missing'}`]),
    ...(sandbox === 'read-only' ? [] : [`research_reviewer_sandbox_mismatch:${sandbox || 'missing'}`])
  ]
  return {
    ok: blockers.length === 0,
    source,
    name,
    model,
    reasoning_effort: effort,
    sandbox_mode: sandbox,
    sha256: text ? sha256(text) : null,
    observed_model: null,
    observed_reasoning_effort: null,
    blockers
  }
}

function mockResearchModelPolicyEvidence() {
  return {
    ok: true,
    source: 'mock_fixture:research_reviewer',
    name: RESEARCH_REVIEWER_CUSTOM_AGENT,
    model: THINKING_SUBAGENT_MODEL,
    reasoning_effort: SUBAGENT_EFFORT,
    sandbox_mode: 'read-only',
    sha256: null,
    observed_model: null,
    observed_reasoning_effort: null,
    blockers: []
  }
}

function normalizeObjections(value: any, severity: ResearchReviewObjection['severity']): ResearchReviewObjection[] {
  return (Array.isArray(value) ? value : []).map((row: any, index: number) => ({
    id: String(row?.id || `${severity}-objection-${index + 1}`).trim(),
    severity,
    claim_ids: normalizeStrings(row?.claim_ids),
    source_ids: normalizeStrings(row?.source_ids),
    reason: String(row?.reason || '').trim(),
    required_revision: String(row?.required_revision || '').trim()
  }))
}

function parseJsonObject(value: unknown): any | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  const text = String(value || '').trim()
  if (!text) return null
  const fencedMatch = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text)
  const unfenced = (fencedMatch?.[1] || text).trim()
  try {
    const parsed = JSON.parse(unfenced)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

async function sourceIdSet(dir: string, executionClass: ResearchEvidenceExecutionClass): Promise<Set<string>> {
  const ledger = await readJson<any>(path.join(dir, 'source-ledger.json'), null)
  return eligibleResearchSourceIdSet(dir, ledger, executionClass)
}

async function manuscriptHashes(dir: string, plan: any): Promise<Record<string, string>> {
  const artifacts = ['research-report.md', researchPaperArtifactForPlan(plan), 'research-synthesis-output.json']
  const rows = await Promise.all(artifacts.map(async (artifact) => [artifact, sha256(await readText(path.join(dir, artifact), ''))] as const))
  return Object.fromEntries(rows)
}

async function syncSynthesisAfterRevision(dir: string, plan: any) {
  const existing = await readJson<any>(path.join(dir, 'research-synthesis-output.json'), null)
  if (!existing) return
  const report = await readText(path.join(dir, 'research-report.md'), '')
  const paper = await readText(path.join(dir, researchPaperArtifactForPlan(plan)), '')
  const normalized = normalizeResearchSynthesisOutput({ ...existing, report_markdown: report, paper_markdown: paper })
  await writeJsonAtomic(path.join(dir, 'research-synthesis-output.json'), normalized)
}

function remainingTimeoutMs(deadlineMs: number): number {
  return Math.max(0, Math.floor(deadlineMs - Date.now()))
}

async function runResearchOperationBeforeDeadline<T>(
  deadlineMs: number,
  operation: () => Promise<T>
): Promise<{ timed_out: false; value: T } | { timed_out: true }> {
  const remainingMs = remainingTimeoutMs(deadlineMs)
  if (remainingMs <= 0) return { timed_out: true }

  let timeout: ReturnType<typeof setTimeout> | null = null
  const deadline = new Promise<{ timed_out: true }>((resolve) => {
    timeout = setTimeout(() => resolve({ timed_out: true }), remainingMs)
  })
  const result = Promise.resolve()
    .then(operation)
    .then((value) => ({ timed_out: false as const, value }))
  try {
    return await Promise.race([result, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function normalizeStrings(value: any): string[] {
  return unique((Array.isArray(value) ? value : value == null ? [] : [value]).map((item) => String(item || '').trim()).filter(Boolean))
}

function duplicates(values: string[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates]
}
