import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { ui as cliUi } from '../../cli/cli-theme.js'
import {
  createMission,
  findLatestMission,
  getOrCreateExplicitNarutoMission,
  getOrCreateSessionMission,
  loadStateForSession,
  loadMission,
  sessionStateKey,
  setCurrent,
  updateCurrentIfMissionAndRun
} from '../mission.js'
import {
  closeWorkOrderLedgerForRouteResult,
  createAndWriteWorkOrderLedgerForPrompt
} from '../work-order-ledger.js'
import {
  appendJsonl,
  exists,
  nowIso,
  readJson,
  sksRoot,
  writeJsonAtomic
} from '../fsx.js'
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
import { buildNarutoHelpResult, renderNarutoUsage } from '../subagents/naruto-help-contract.js'
import { parseNarutoArgs, type NarutoArgs } from '../subagents/naruto-command-args.js'
import { buildNarutoProofProjection } from '../subagents/naruto-proof-projection.js'
import {
  attachNarutoLaunchDiagnostics,
  normalizedNarutoOperatorActions
} from '../subagents/naruto-launch-diagnostics.js'
import { withFileLock } from '../locks/file-lock.js'
import {
  codexAppSessionKey,
  detectCodexAppSession,
  runOfficialSubagentWorkflow
} from '../subagents/official-subagent-runner.js'
import {
  NARUTO_GATE_FILENAME,
  NARUTO_RESULT_SCHEMA,
  NARUTO_SUMMARY_FILENAME,
  SUBAGENT_PLAN_FILENAME,
  buildNarutoGateResult,
  buildNarutoSummary,
  officialSubagentPreparationInProgress,
  prepareOfficialSubagentMission,
  withOfficialSubagentLifecycleLock,
  withNarutoMissionRunAdmission,
  type NarutoMissionRunLease,
  writeNarutoGate
} from '../subagents/official-subagent-preparation.js'
import { recordOfficialSubagentParentOutcomesTelemetry } from '../zellij/zellij-official-subagent-telemetry.js'
import { effectiveSubagentTarget, refreshSubagentWaveLifecycle } from '../subagents/wave-lifecycle.js'
import {
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
  bindParentSummaryToHostCapabilityEvidence,
  createHostCapabilityHookRuntimeBinding,
  resolveHostCapabilityHookRuntimeBinding
} from '../agent-bridge/host-capability-runtime.js'
import { renderHostCapabilityBlockedLines } from '../agent-bridge/host-capability-policy.js'
import { uniqueStrings } from '../text/strings.js'
import {
  completeNarutoTerminalBundle,
  refreshOfficialSubagentCompletionArtifacts
} from '../hooks-runtime/official-subagent-lifecycle.js'

export { buildNarutoGateResult } from '../subagents/official-subagent-preparation.js'
export { attachNarutoLaunchDiagnostics } from '../subagents/naruto-launch-diagnostics.js'
export { parseNarutoArgs } from '../subagents/naruto-command-args.js'
export { renderNarutoUsage as usage } from '../subagents/naruto-help-contract.js'

const MAX_PARENT_SUMMARY_STDIN_BYTES = 1024 * 1024

type NarutoPreparationFailureInjection =
  | 'after_marker_before_artifact'
  | 'after_cleanup_and_evidence_promotion_before_plan'
  | 'after_artifact_commit_before_state'
  | 'after_state_commit_before_marker_clear'

let nextNarutoPreparationFailureInjectionForTest: NarutoPreparationFailureInjection | null = null

export function injectNextNarutoPreparationFailureForTest(value: NarutoPreparationFailureInjection | null) {
  nextNarutoPreparationFailureInjectionForTest = value
}

export async function narutoCommand(commandOrArgs: string | string[] = 'naruto', maybeArgs: string[] = []) {
  const args = Array.isArray(commandOrArgs) ? commandOrArgs.map(String) : maybeArgs.map(String)
  if (args.some((arg) => arg === '--glm' || arg.startsWith('--glm='))) return blockGlmOverride(args.includes('--json'))

  const parsed = parseNarutoArgs(args)
  if (parsed.argumentErrors.length) {
    const result = argumentBlock(parsed.argumentErrors)
    return emit(parsed, result, () => {
      for (const line of renderNarutoBlockedLines(result.blockers)) console.error(line)
    }, true)
  }
  // A malformed provider or effort tier blocks the run before any mission state
  // is written, instead of silently falling back to the SKS-managed credential.
  const credentialPolicy = parsed.credentialPolicy
  if (parsed.action === 'run' && credentialPolicy.blockers.length) {
    const blocked = {
      schema: 'sks.naruto-credential-policy.v1',
      ok: false,
      blockers: credentialPolicy.blockers,
      hint: 'sks naruto run --auth-mode=host --model-provider=<config.toml provider block> --provider-env-key=<ENV NAME>'
    }
    if (args.includes('--json')) console.log(JSON.stringify(blocked, null, 2))
    else {
      console.error(`Naruto credential policy blocked: ${credentialPolicy.blockers.join(', ')}`)
      console.error(blocked.hint)
    }
    process.exitCode = 2
    return null
  }
  if (!parsed.json) cliUi.banner(parsed.action === 'run' ? 'naruto subagents' : `naruto ${parsed.action}`)
  if (parsed.action === 'help') return narutoHelp(parsed)
  if (parsed.action === 'status') return narutoStatus(parsed)
  if (parsed.action === 'subagents') return narutoSubagents(parsed)
  if (parsed.action === 'proof') return narutoProof(parsed)
  if (parsed.action === 'parent-summary') return narutoParentSummary(parsed)
  return narutoRun(parsed)
}

async function narutoParentSummary(parsed: NarutoArgs) {
  const root = await sksRoot()
  const appSession = detectCodexAppSession()
  const sessionKey = appSession ? codexAppSessionKey() : null
  if (!appSession || !sessionKey) {
    return blockedParentSummary(parsed, ['naruto_parent_summary_app_session_required'])
  }
  return withFileLock({
    lockPath: path.join(root, '.sneakoscope', 'state', `naruto-session-${sessionStateKey(sessionKey)}.lock`),
    timeoutMs: 20_000,
    staleMs: 120_000
  }, () => narutoParentSummaryTransaction(parsed, root, sessionKey))
}

async function narutoParentSummaryTransaction(parsed: NarutoArgs, root: string, sessionKey: string) {
  const state = await loadStateForSession(root, sessionKey).catch(() => null)
  const route = String(state?.route || state?.route_command || state?.mode || '')
    .replace(/^\$/, '')
    .replace(/[-_]/g, '')
    .toUpperCase()
  const officialSubagentRoute = route === 'NARUTO'
    || (state?.subagents_required === true
      && typeof state?.official_subagent_run_id === 'string'
      && state.official_subagent_run_id.trim().length > 0)
  const stateBlockers = uniqueStrings([
    ...(state?._session_key === sessionStateKey(sessionKey) ? [] : ['naruto_parent_summary_session_state_mismatch']),
    ...(state?.session_scope === sessionKey ? [] : ['naruto_parent_summary_session_scope_mismatch']),
    ...(state?.mission_id === parsed.missionId ? [] : ['naruto_parent_summary_active_mission_mismatch']),
    ...(officialSubagentRoute ? [] : ['naruto_parent_summary_active_route_mismatch']),
    ...(state?.route_closed === true ? ['naruto_parent_summary_route_closed'] : [])
  ])
  if (stateBlockers.length > 0) return blockedParentSummary(parsed, stateBlockers)

  const loaded = await loadMission(root, parsed.missionId).catch(() => null)
  if (!loaded) return blockedParentSummary(parsed, [`naruto_parent_summary_mission_not_found:${parsed.missionId}`])
  const plan = await readJson<any>(path.join(loaded.dir, SUBAGENT_PLAN_FILENAME), null).catch(() => null)
  const workflowRunId = String(plan?.workflow_run_id || '').trim()
  const planBlockers = uniqueStrings([
    ...(plan?.schema === 'sks.subagent-plan.v1' ? [] : ['naruto_parent_summary_plan_schema_invalid']),
    ...(plan?.workflow === 'official_codex_subagent' ? [] : ['naruto_parent_summary_plan_workflow_invalid']),
    ...(plan?.mission_id === parsed.missionId ? [] : ['naruto_parent_summary_plan_mission_mismatch']),
    ...(plan?.session_scope === sessionKey ? [] : ['naruto_parent_summary_plan_session_scope_mismatch']),
    ...(workflowRunId ? [] : ['naruto_parent_summary_plan_run_id_missing']),
    ...(workflowRunId && state?.official_subagent_run_id === workflowRunId
      ? []
      : ['naruto_parent_summary_active_run_mismatch'])
  ])
  if (planBlockers.length > 0) return blockedParentSummary(parsed, planBlockers)

  const stdin = await readBoundedParentSummaryStdin()
  if (!stdin.ok) return blockedParentSummary(parsed, [stdin.blocker])
  const raw = stdin.value
  let submitted: unknown
  try {
    submitted = JSON.parse(raw)
  } catch {
    return blockedParentSummary(parsed, ['naruto_parent_summary_stdin_json_invalid'])
  }
  if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
    return blockedParentSummary(parsed, ['naruto_parent_summary_stdin_object_required'])
  }
  const normalized = normalizeSubagentParentSummary(submitted)
  const summaryBlockers = uniqueStrings([
    ...(normalized.trustworthy && normalized.raw ? [] : normalized.blockers.length
      ? normalized.blockers.map((blocker) => `naruto_parent_summary_schema:${blocker}`)
      : ['naruto_parent_summary_schema_invalid']),
    ...(!normalized.run_id
      ? ['naruto_parent_summary_run_id_missing']
      : normalized.run_id === workflowRunId
        ? []
        : ['naruto_parent_summary_run_id_mismatch'])
  ])
  if (summaryBlockers.length > 0) return blockedParentSummary(parsed, summaryBlockers)
  const submittedSummary = normalized.raw
  if (!submittedSummary) return blockedParentSummary(parsed, ['naruto_parent_summary_schema_invalid'])

  const existing = await readJson<any>(
    path.join(loaded.dir, SUBAGENT_PARENT_SUMMARY_FILENAME),
    null
  ).catch(() => null)
  if (existing !== null) {
    const normalizedExisting = normalizeSubagentParentSummary(existing)
    const [existingGate, existingSummary, existingEvidence] = await Promise.all([
      readJson<any>(path.join(loaded.dir, NARUTO_GATE_FILENAME), null).catch(() => null),
      readJson<any>(path.join(loaded.dir, NARUTO_SUMMARY_FILENAME), null).catch(() => null),
      readJson<any>(path.join(loaded.dir, SUBAGENT_EVIDENCE_FILENAME), null).catch(() => null)
    ])
    const terminal = completeNarutoTerminalBundle({
      workflowRunId,
      gate: existingGate,
      summary: existingSummary,
      evidence: existingEvidence,
      parentSummary: existing
    })
    if (terminal) {
      if (!normalizedExisting.trustworthy || !normalizedExisting.raw) {
        return blockedParentSummary(parsed, ['naruto_parent_summary_existing_canonical_invalid'])
      }
      if (normalizedExisting.run_id !== workflowRunId) {
        return blockedParentSummary(parsed, ['naruto_parent_summary_existing_run_id_mismatch'])
      }
      if (!sameParentAuthoredSummary(normalizedExisting.raw, submittedSummary)) {
        return blockedParentSummary(parsed, ['naruto_parent_summary_conflicts_with_canonical'])
      }
    }
  }

  const evidence = await refreshOfficialSubagentCompletionArtifacts(
    root,
    state,
    submittedSummary,
    sessionKey
  )
  if (!evidence) return blockedParentSummary(parsed, ['naruto_parent_summary_lifecycle_commit_rejected'])

  const [persisted, summary, gate] = await Promise.all([
    readJson<any>(path.join(loaded.dir, SUBAGENT_PARENT_SUMMARY_FILENAME), null).catch(() => null),
    readJson<any>(path.join(loaded.dir, NARUTO_SUMMARY_FILENAME), null).catch(() => null),
    readJson<any>(path.join(loaded.dir, NARUTO_GATE_FILENAME), null).catch(() => null)
  ])
  const normalizedPersisted = normalizeSubagentParentSummary(persisted)
  if (!normalizedPersisted.trustworthy
    || normalizedPersisted.run_id !== workflowRunId
    || !sameParentAuthoredSummary(normalizedPersisted.raw, submittedSummary)) {
    return blockedParentSummary(parsed, ['naruto_parent_summary_canonical_commit_mismatch'])
  }
  const hardBlocked = normalizedPersisted.status === 'failed'
  const completionEvidence = route === 'NARUTO'
    ? gate?.passed === true
    : evidence?.ok === true
  const completionBlockers = route === 'NARUTO'
    ? (Array.isArray(gate?.blockers) ? gate.blockers : [])
    : (Array.isArray(evidence?.blockers) ? evidence.blockers : [])
  const accepted = completionEvidence || hardBlocked
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    action: 'parent-summary',
    ok: completionEvidence,
    accepted,
    status: route === 'NARUTO'
      ? summary?.status || evidence?.status || normalizedPersisted.status || 'incomplete'
      : evidence?.status || normalizedPersisted.status || 'incomplete',
    mission_id: parsed.missionId,
    workflow_run_id: workflowRunId,
    parent_summary_status: normalizedPersisted.status,
    completion_evidence: completionEvidence,
    blockers: completionBlockers,
    artifacts: narutoArtifactLinks(evidence)
  }
  return emit(parsed, result, () => renderParentSummaryResult(result), result.ok !== true)
}

async function readBoundedParentSummaryStdin(): Promise<
  { ok: true; value: string } | { ok: false; blocker: string }
> {
  let value = ''
  let bytes = 0
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) {
    const text = String(chunk)
    bytes += Buffer.byteLength(text, 'utf8')
    if (bytes > MAX_PARENT_SUMMARY_STDIN_BYTES) {
      return { ok: false, blocker: `naruto_parent_summary_stdin_too_large:${MAX_PARENT_SUMMARY_STDIN_BYTES}` }
    }
    value += text
  }
  if (!value.trim()) return { ok: false, blocker: 'naruto_parent_summary_stdin_empty' }
  return { ok: true, value }
}

function sameParentAuthoredSummary(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== 'object' || Array.isArray(left)) return false
  if (!right || typeof right !== 'object' || Array.isArray(right)) return false
  const omitHostReceipts = (value: Record<string, unknown>) => {
    const { artifacts: _artifacts, capabilities_used: _capabilitiesUsed, ...authored } = value
    return authored
  }
  return isDeepStrictEqual(
    omitHostReceipts(left as Record<string, unknown>),
    omitHostReceipts(right as Record<string, unknown>)
  )
}

function blockedParentSummary(parsed: NarutoArgs, blockers: string[]) {
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    action: 'parent-summary',
    ok: false,
    accepted: false,
    status: 'blocked',
    mission_id: parsed.missionId || null,
    blockers: uniqueStrings(blockers)
  }
  return emit(parsed, result, () => {
    for (const line of renderNarutoBlockedLines(result.blockers)) console.error(line)
  }, true)
}

async function narutoRun(parsed: NarutoArgs) {
  const root = await sksRoot()
  const appSession = detectCodexAppSession()
  const sessionKey = appSession ? codexAppSessionKey() : null
  if (appSession && sessionKey) {
    return withFileLock({
      lockPath: path.join(root, '.sneakoscope', 'state', `naruto-session-${sessionStateKey(sessionKey)}.lock`),
      timeoutMs: 20_000,
      staleMs: 120_000
    }, () => narutoRunTransaction(parsed, root, appSession, sessionKey))
  }
  if (appSession) return narutoRunTransaction(parsed, root, true, null)
  const mission = await resolveRunMission(root, parsed, sessionKey)
  if (!mission) return missingRunMission(parsed)
  if (!mission.ok) return blockedRunMission(parsed, mission.blockers)
  const admission = await withNarutoMissionRunAdmission({
    missionId: mission.id,
    missionDir: mission.dir,
    prompt: parsed.prompt
  }, (lease) => narutoRunTransaction(parsed, root, false, null, mission, lease))
  if (admission.kind === 'executed') return admission.value
  const response = admission.kind === 'reused'
    ? { ...admission.response, artifacts: terminalNarutoArtifactLinks(admission.response) }
    : admission.response
  return emit(parsed, response, () => renderRunResult(response), response.status === 'blocked')
}

async function narutoRunTransaction(
  parsed: NarutoArgs,
  root: string,
  appSession: boolean,
  sessionKey: string | null,
  resolvedMission?: { ok: true; id: string; dir: string },
  missionLease?: NarutoMissionRunLease
) {
  const mission = resolvedMission || await resolveRunMission(root, parsed, sessionKey)
  if (!mission) return missingRunMission(parsed)
  if (!mission.ok) return blockedRunMission(parsed, mission.blockers)
  const { id, dir } = mission
  if (appSession && sessionKey) {
    const pending = await readPendingAppNarutoRun(root, { id, dir }, sessionKey, parsed.prompt)
    if (pending) return emit(parsed, pending, () => renderRunResult(pending))
  }
  await createAndWriteWorkOrderLedgerForPrompt(dir, {
    missionId: id,
    route: 'Naruto',
    prompt: parsed.prompt
  })

  const preparationFailureInjection = nextNarutoPreparationFailureInjectionForTest
  nextNarutoPreparationFailureInjectionForTest = null

  const preparation = await prepareOfficialSubagentMission({
    root,
    dir,
    missionId: id,
    goal: parsed.prompt,
    route: '$Naruto',
    sessionScope: sessionKey,
    ...(parsed.requestedSubagents === undefined ? {} : { requestedSubagents: parsed.requestedSubagents }),
    requestedSubagentsExplicit: parsed.requestedSubagents !== undefined,
    ...(parsed.maxThreads === undefined ? {} : { maxThreads: parsed.maxThreads }),
    mode: 'naruto',
    readOnly: parsed.readOnly,
    preparationOnly: true,
    ...(preparationFailureInjection ? { failureInjection: preparationFailureInjection } : {}),
    statePatch: ({ budget: preparedBudget, workflowRunId: preparedRunId }) => ({
      mission_id: id,
      route: 'Naruto',
      route_command: '$Naruto',
      mode: 'NARUTO',
      phase: 'NARUTO_DELEGATION_CONTEXT_READY',
      questions_allowed: false,
      implementation_allowed: true,
      subagents_required: true,
      subagents_verified: false,
      subagents_spawned: false,
      subagents_reported: false,
      subagent_evidence_file: 'subagent-evidence.json',
      parent_summary_present: false,
      native_sessions_required: false,
      native_sessions_verified: false,
      agents_required: false,
      requested_subagents: preparedBudget.requestedSubagents,
      target_subagents: preparedBudget.requestedSubagents,
      max_threads: preparedBudget.maxThreads,
      max_depth: preparedBudget.maxDepth,
      official_subagent_run_id: preparedRunId,
      session_scope: sessionKey,
      stop_gate: NARUTO_GATE_FILENAME,
      naruto_gate_file: NARUTO_GATE_FILENAME,
      naruto_gate_passed: false,
      reflection_invalidation_required: false,
      reflection_invalidated_at: null,
      reflection_invalidation_reason: null,
      reflection_invalidated_for_workflow_run_id: null,
      reflection_invalidated_for_proof_digest: null,
      prompt: parsed.prompt
    })
  })
  const {
    plan,
    evidence: preparationEvidence,
    budget,
    verification,
    delegationPrompt,
    workflowRunId,
    configBlockers
  } = preparation
  if (configBlockers.length > 0) {
    return emit(parsed, {
      schema: NARUTO_RESULT_SCHEMA,
      ok: false,
      action: 'run',
      status: 'blocked',
      mission_id: id,
      workflow_run_id: workflowRunId,
      blockers: configBlockers
    }, () => {
      for (const line of renderNarutoBlockedLines(configBlockers)) console.error(line)
    }, true)
  }
  const run = await runOfficialSubagentWorkflow({
    root,
    goal: parsed.prompt,
    prompt: delegationPrompt,
    requestedSubagents: budget.requestedSubagents,
    maxThreads: budget.maxThreads,
    appSession,
    projectTrusted: parsed.trustedProject,
    missionId: id,
    workflowRunId,
    sessionKey,
    credentialPolicy: parsed.credentialPolicy,
    ...(missionLease ? { onChildSpawn: missionLease.protectChildPid } : {})
  })
  const result = await withOfficialSubagentLifecycleLock(dir, async () => {
  if (await officialSubagentPreparationInProgress(dir)) return null
  const completedPlan = await readJson<any>(path.join(dir, SUBAGENT_PLAN_FILENAME), plan).catch(() => plan)
  if (String(completedPlan?.workflow_run_id || '').trim() !== workflowRunId) return null
  const finalBudget = {
    ...budget,
    requestedSubagents: Number(completedPlan?.requested_subagents || budget.requestedSubagents),
    maxThreads: Number(completedPlan?.max_threads || budget.maxThreads),
    firstWave: Number(completedPlan?.first_wave ?? budget.firstWave),
    waveCount: Number(completedPlan?.wave_count ?? budget.waveCount),
    capacity: completedPlan?.capacity_controller || budget.capacity
  }
  const hostCapabilityHookBinding = appSession && sessionKey && run.host_capability_runtime
    ? createHostCapabilityHookRuntimeBinding({
        missionId: id,
        workflowRunId,
        sessionScope: sessionKey,
        runtime: run.host_capability_runtime
      })
    : null
  if (hostCapabilityHookBinding) {
    await writeJsonAtomic(path.join(dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), hostCapabilityHookBinding)
  }
  const hostCapabilityBinding = run.host_capability_evidence
    ? bindParentSummaryToHostCapabilityEvidence(run.parent_summary, run.host_capability_evidence)
    : { value: run.parent_summary, blockers: [] }
  const runBoundParentSummary = bindTrustworthySubagentParentSummaryToRun(hostCapabilityBinding.value, workflowRunId)
  const effectiveParentSummary = await persistOrReuseTrustworthySubagentParentSummary(dir, runBoundParentSummary, {
    workflowStatus: run.status,
    runId: workflowRunId
  })
  const waveLifecycle = await refreshSubagentWaveLifecycle(dir, {
    plan: completedPlan
  }).catch(() => completedPlan?.wave_lifecycle || null)
  const countTarget = effectiveSubagentTarget(
    waveLifecycle ? { ...completedPlan, wave_lifecycle: waveLifecycle } : completedPlan,
    waveLifecycle?.cumulative_started || 0
  )
  const evidence = await writeSubagentEvidence(dir, {
    requestedSubagents: finalBudget.requestedSubagents,
    countPolicy: countTarget.countPolicy,
    targetSubagents: countTarget.targetSubagents,
    parentSummary: effectiveParentSummary,
    workflowStatus: run.status,
    preparationOnly: appSession,
    runId: workflowRunId,
    additionalBlockers: [...configBlockers, ...hostCapabilityBinding.blockers],
    ...(run.host_capability_evidence ? { hostCapabilityEvidence: run.host_capability_evidence } : {})
  })
  if (!appSession) {
    const parentTelemetry = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId: id,
      parentSummary: effectiveParentSummary,
      plan: completedPlan
    }).catch(async (error: any) => {
      await appendJsonl(path.join(dir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_parent_outcome_telemetry_failed',
        error: String(error?.message || error)
      }).catch(() => undefined)
      return null
    })
    if (parentTelemetry?.blocker) {
      await appendJsonl(path.join(dir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_parent_outcome_telemetry_incomplete',
        blocker: parentTelemetry.blocker,
        failed_mission_ids: 'failed_mission_ids' in parentTelemetry ? parentTelemetry.failed_mission_ids : [],
        skipped_thread_ids: 'skipped_thread_ids' in parentTelemetry ? parentTelemetry.skipped_thread_ids : []
      }).catch(() => undefined)
    }
  }
  const candidatePassed = run.ok === true && evidence.ok === true && appSession === false
  const blockers = uniqueStrings([
    ...(Array.isArray(evidence.blockers) ? evidence.blockers : []),
    ...configBlockers,
    ...hostCapabilityBinding.blockers,
    ...(Array.isArray(run.blockers) ? run.blockers : []),
    ...(appSession && run.status === 'delegation_context_ready'
      ? ['official_subagent_execution_pending_in_current_parent']
      : [])
  ])
  const gate = await writeNarutoGate(dir, {
    missionId: id,
    workflowRunId,
    evidence,
    passed: candidatePassed,
    blockers
  })
  const passed = gate.passed === true
  const status = passed
    ? 'completed'
    : appSession && run.status === 'delegation_context_ready'
      ? 'delegation_context_ready'
      : run.ok === true
        ? 'incomplete'
        : 'blocked'
  const summary = attachNarutoLaunchDiagnostics(
    buildNarutoSummary({
      missionId: id,
      workflowRunId,
      budget: finalBudget,
      evidence,
      verification,
      status,
      ok: passed,
      parentSummary: effectiveParentSummary,
      blockers: gate.blockers,
      appSession,
      sessionKey,
      suggestedAgents: Array.isArray(completedPlan?.suggested_agents) ? completedPlan.suggested_agents : [],
      waveLifecycle
    }),
    run
  )
  await writeJsonAtomic(path.join(dir, NARUTO_SUMMARY_FILENAME), summary)
  await updateCurrentIfMissionAndRun(root, id, workflowRunId, {
    mission_id: id,
    official_subagent_run_id: workflowRunId,
    session_scope: sessionKey,
    phase: passed
      ? 'NARUTO_COMPLETE'
      : appSession && run.status === 'delegation_context_ready'
        ? 'NARUTO_DELEGATION_CONTEXT_READY'
        : 'NARUTO_BLOCKED',
    subagents_verified: evidence.ok === true,
    requested_subagents: finalBudget.requestedSubagents,
    target_subagents: evidence.target_subagents,
    max_threads: finalBudget.maxThreads,
    naruto_gate_passed: passed,
    route_closed: false
  }, { sessionKey })
  if (!appSession) {
    await closeWorkOrderLedgerForRouteResult(dir, { ok: passed, blockers: gate.blockers })
    if (!passed) process.exitCode = 1
  }

  return {
    ...summary,
    mission_id: id,
    attached_to_pending_run: false,
    additionalContext: appSession && run.status === 'delegation_context_ready' ? run.additionalContext : undefined,
    artifacts: narutoArtifactLinks(evidence)
  }
  })
  if (!result) {
    const currentSummary = await readJson<any>(path.join(dir, NARUTO_SUMMARY_FILENAME), null).catch(() => null)
    const currentEvidence = await readJson<any>(path.join(dir, 'subagent-evidence.json'), null).catch(() => null)
    const staleResult = {
      ...(currentSummary || {}),
      schema: NARUTO_RESULT_SCHEMA,
      ok: currentSummary?.ok === true,
      completion_evidence: currentSummary?.completion_evidence === true,
      mission_id: id,
      attached_to_pending_run: true,
      stale_run_discarded: workflowRunId,
      artifacts: narutoArtifactLinks(currentEvidence)
    }
    return emit(parsed, staleResult, () => renderRunResult(staleResult))
  }
  return emit(parsed, result, () => renderRunResult(result))
}

async function readPendingAppNarutoRun(
  root: string,
  mission: { id: string; dir: string },
  sessionKey: string,
  prompt: string
) {
  if (await officialSubagentPreparationInProgress(mission.dir)) return null
  const [plan, evidence, summary, gate, state, rawHostCapabilityBinding] = await Promise.all([
    readJson<any>(path.join(mission.dir, SUBAGENT_PLAN_FILENAME), null),
    readJson<any>(path.join(mission.dir, 'subagent-evidence.json'), null),
    readJson<any>(path.join(mission.dir, NARUTO_SUMMARY_FILENAME), null),
    readJson<any>(path.join(mission.dir, NARUTO_GATE_FILENAME), null),
    loadStateForSession(root, sessionKey).catch(() => null),
    readJson<any>(path.join(mission.dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), null).catch(() => null)
  ])
  const workflowRunId = String(plan?.workflow_run_id || '').trim()
  const sessionMatches = state?._session_key === sessionStateKey(sessionKey)
  const hostCapabilityScopeMatches = Boolean(resolveHostCapabilityHookRuntimeBinding(rawHostCapabilityBinding, {
    missionId: mission.id,
    workflowRunId,
    sessionScope: sessionKey
  }).binding)
  const pending = Boolean(
    workflowRunId
      && plan?.schema === 'sks.subagent-plan.v1'
      && plan?.workflow === 'official_codex_subagent'
      && plan?.mission_id === mission.id
      && String(plan?.goal || '').trim() === String(prompt || '').trim()
      && plan?.session_scope === sessionKey
      && evidence?.run_id === workflowRunId
      && evidence?.preparation_only === true
      && evidence?.ok !== true
      && summary?.workflow_run_id === workflowRunId
      && summary?.mission_id === mission.id
      && summary?.app_session === true
      && summary?.session_scope === sessionKey
      && summary?.status === 'delegation_context_ready'
      && summary?.ok !== true
      && summary?.completion_evidence !== true
      && gate?.workflow_run_id === workflowRunId
      && gate?.mission_id === mission.id
      && gate?.passed !== true
      && sessionMatches
      && state?.mission_id === mission.id
      && state?.official_subagent_run_id === workflowRunId
      && state?.session_scope === sessionKey
      && state?.route_closed !== true
      && state?.phase === 'NARUTO_DELEGATION_CONTEXT_READY'
      && hostCapabilityScopeMatches
  )
  if (!pending) return null

  return {
    ...summary,
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    completion_evidence: false,
    status: 'delegation_context_ready',
    workflow_run_id: workflowRunId,
    mission_id: mission.id,
    app_session: true,
    session_scope: sessionKey,
    attached_to_pending_run: true,
    additionalContext: plan.delegation_prompt,
    artifacts: narutoArtifactLinks(evidence)
  }
}

function narutoArtifactLinks(evidence: any) {
  return {
    plan: SUBAGENT_PLAN_FILENAME,
    events: SUBAGENT_EVENT_LOG_FILENAME,
    parent_summary: evidence?.parent_summary_trustworthy === true ? SUBAGENT_PARENT_SUMMARY_FILENAME : null,
    evidence: 'subagent-evidence.json',
    summary: NARUTO_SUMMARY_FILENAME,
    gate: NARUTO_GATE_FILENAME
  }
}

function terminalNarutoArtifactLinks(response: Record<string, unknown>) {
  return {
    plan: SUBAGENT_PLAN_FILENAME,
    events: SUBAGENT_EVENT_LOG_FILENAME,
    parent_summary: response.parent_summary_present === true ? SUBAGENT_PARENT_SUMMARY_FILENAME : null,
    evidence: 'subagent-evidence.json',
    summary: NARUTO_SUMMARY_FILENAME,
    gate: NARUTO_GATE_FILENAME
  }
}

async function narutoStatus(parsed: NarutoArgs) {
  const resolved = await resolveReadMission(parsed)
  if (!resolved) return missingMission(parsed, 'status')
  const [plan, evidence, summary, gate] = await Promise.all([
    readJson<any>(path.join(resolved.dir, SUBAGENT_PLAN_FILENAME), null),
    readJson<any>(path.join(resolved.dir, 'subagent-evidence.json'), null),
    readJson<any>(path.join(resolved.dir, NARUTO_SUMMARY_FILENAME), null),
    readJson<any>(path.join(resolved.dir, NARUTO_GATE_FILENAME), null)
  ])
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    ok: Boolean(plan || evidence || summary || gate),
    action: 'status',
    mission_id: resolved.id,
    status: summary?.status || evidence?.status || 'prepared',
    requested_subagents: plan?.requested_subagents ?? evidence?.requested_subagents ?? null,
    count_policy: evidence?.count_policy ?? plan?.wave_lifecycle?.count_policy ?? null,
    target_subagents: evidence?.target_subagents ?? plan?.wave_lifecycle?.target_subagents ?? null,
    max_threads: plan?.max_threads ?? null,
    wave_lifecycle: plan?.wave_lifecycle ?? null,
    started_subagents: evidence?.started_threads ?? 0,
    completed_subagents: evidence?.completed_threads ?? 0,
    failed_subagents: evidence?.failed_threads ?? 0,
    gate_passed: gate?.passed === true,
    blockers: gate?.blockers || evidence?.blockers || []
  }
  return emit(parsed, result, () => renderStatusResult(result))
}

async function narutoSubagents(parsed: NarutoArgs) {
  const resolved = await resolveReadMission(parsed)
  if (!resolved) return missingMission(parsed, 'subagents')
  const [evidence, events] = await Promise.all([
    readJson<any>(path.join(resolved.dir, 'subagent-evidence.json'), null),
    readSubagentEvents(resolved.dir)
  ])
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    ok: Boolean(evidence),
    action: 'subagents',
    mission_id: resolved.id,
    requested_subagents: evidence?.requested_subagents ?? null,
    count_policy: evidence?.count_policy ?? null,
    target_subagents: evidence?.target_subagents ?? null,
    started_subagents: evidence?.started_threads ?? 0,
    completed_subagents: evidence?.completed_threads ?? 0,
    failed_subagents: evidence?.failed_threads ?? 0,
    started_thread_ids: evidence?.started_thread_ids || [],
    completed_thread_ids: evidence?.completed_thread_ids || [],
    failed_thread_ids: evidence?.failed_thread_ids || [],
    events
  }
  return emit(parsed, result, () => renderStatusResult(result))
}

async function narutoProof(parsed: NarutoArgs) {
  const resolved = await resolveReadMission(parsed)
  if (!resolved) return missingMission(parsed, 'proof')
  const result = await buildNarutoProofProjection({ artifactDir: resolved.dir, missionId: resolved.id })
  return emit(parsed, result, () => {
    if (result.status !== 'completed' && result.blockers?.length) {
      for (const line of renderNarutoBlockedLines(result.blockers)) console.log(line)
      return
    }
    console.log(`Naruto proof ${resolved.id}: ${result.status}`)
  })
}

function narutoHelp(parsed: NarutoArgs) {
  const result = buildNarutoHelpResult()
  return emit(parsed, result, () => {
    cliUi.ok('Naruto parallel workflow help available')
    console.log(renderNarutoUsage())
    console.log(`Parent: ${result.parent.model} / ${result.parent.model_reasoning_effort}`)
    const worker = result.agents.worker
    const expert = result.agents.expert
    if (worker) console.log(`Worker: ${worker.model} / ${worker.model_reasoning_effort}`)
    if (expert) console.log(`Expert: ${expert.model} / ${expert.model_reasoning_effort}`)
    console.log(`Starting Naruto children: ${result.default_requested_subagents}; normal ceiling ${result.automatic_subagent_ceiling}, mass ceiling ${result.mass_automatic_subagent_ceiling}, hard frame cap ${result.absolute_hard_frame_cap}`)
    console.log(`Nesting: max_depth=${result.max_depth}; Naruto children must not spawn children`)
    console.log('Context: bounded TriWiki attention.use_first anchors with on-demand source hydration')
    console.log('Evidence: SubagentStop is lifecycle-only; completion requires subagent-parent-summary.json with one structured outcome per Naruto child thread.')
    console.log('Codex App finalization: submit the structured object with parent-summary --mission <id> --stdin, then return localized Markdown without exposing JSON.')
  })
}

async function resolveRunMission(
  root: string,
  parsed: NarutoArgs,
  sessionKey: string | null = null
): Promise<{ ok: true; id: string; dir: string } | { ok: false; blockers: string[] } | null> {
  if (parsed.missionId && parsed.missionId !== 'latest') {
    const resolved = await getOrCreateExplicitNarutoMission(root, {
      requestedId: parsed.missionId,
      prompt: parsed.prompt,
      sessionKey
    })
    if (!resolved.ok) return { ok: false, blockers: resolved.blockers }
    return { ok: true, id: resolved.id, dir: resolved.dir }
  }
  if (sessionKey) {
    const resolved = await getOrCreateSessionMission(root, {
      mode: 'naruto',
      prompt: parsed.prompt,
      sessionKey,
      syncRequestIntake: true,
      selectMissionId: (state) => {
        const route = String(state?.route || state?.route_command || state?.mode || '').replace(/^\$/, '').toUpperCase()
        const sessionMatches = state?._session_key === sessionStateKey(sessionKey)
        return sessionMatches && state?.mission_id && state?.route_closed !== true && route === 'NARUTO'
          ? String(state.mission_id)
          : null
      }
    })
    return { ok: true, id: String(resolved.id), dir: String(resolved.dir) }
  }
  const created = await createMission(root, { mode: 'naruto', prompt: parsed.prompt, sessionKey })
  return { ok: true, id: String(created.id), dir: String(created.dir) }
}

async function resolveReadMission(parsed: NarutoArgs) {
  const root = await sksRoot()
  const explicitId = parsed.missionId && parsed.missionId !== 'latest' ? parsed.missionId : null
  const sessionKey = detectCodexAppSession() ? codexAppSessionKey() : null
  let id = explicitId
  if (!id && sessionKey) {
    const state = await loadStateForSession(root, sessionKey).catch(() => null)
    const route = String(state?.route || state?.route_command || state?.mode || '').replace(/^\$/, '').toUpperCase()
    if (state?._session_key === sessionStateKey(sessionKey) && state?.route_closed !== true && route === 'NARUTO') {
      id = String(state.mission_id || '') || null
    }
  }
  if (!id && !sessionKey) id = await findLatestMission(root, { mode: 'naruto' })
  if (!id) return null
  const loaded = await loadMission(root, id).catch(() => null)
  return loaded ? { root, id, dir: loaded.dir } : null
}

function blockGlmOverride(json: boolean) {
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    status: 'blocked',
    reason: 'naruto_gpt_5_6_family_only_glm_override_forbidden',
    blockers: ['naruto_gpt_5_6_family_only_glm_override_forbidden'],
    hint: 'Use normal sks naruto for the official Codex subagent workflow. OpenRouter models are selected in SKS Center Providers via Use OpenRouter.'
  }
  process.exitCode = 1
  if (json) console.log(JSON.stringify(result, null, 2))
  else for (const line of renderNarutoBlockedLines(result.blockers)) console.error(line)
  return result
}

function argumentBlock(errors: string[]) {
  return {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    status: 'blocked',
    reason: 'invalid_naruto_arguments',
    blockers: errors.map((error) => `invalid_naruto_argument:${error}`),
    hint: 'Provide a non-empty quoted task and valid positive integers for --agents/--max-threads. Use only official Naruto options.'
  }
}

function missingMission(parsed: NarutoArgs, action: string) {
  return emit(parsed, {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    action,
    status: 'missing_mission'
  }, () => console.log('No Naruto mission found.'))
}

function missingRunMission(parsed: NarutoArgs) {
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    status: 'blocked',
    blockers: [`naruto_mission_not_found:${parsed.missionId}`]
  }
  return emit(parsed, result, () => {
    for (const line of renderNarutoBlockedLines(result.blockers)) console.error(line)
  }, true)
}

function blockedRunMission(parsed: NarutoArgs, blockers: string[]) {
  const result = {
    schema: NARUTO_RESULT_SCHEMA,
    ok: false,
    status: 'blocked',
    blockers
  }
  return emit(parsed, result, () => {
    for (const line of renderNarutoBlockedLines(result.blockers)) console.error(line)
  }, true)
}

function emit(parsed: Pick<NarutoArgs, 'json'>, result: any, human: () => void, failed = false) {
  if (failed) process.exitCode = 1
  if (parsed.json) console.log(JSON.stringify(result, null, 2))
  else human()
  return result
}

function renderRunResult(result: any) {
  const operatorActionLines = renderNarutoOperatorActionLines(result)
  if (['blocked', 'incomplete'].includes(result.status) && Array.isArray(result.blockers) && result.blockers.length) {
    for (const line of renderNarutoBlockedLines(result.blockers)) console.log(line)
    for (const line of operatorActionLines) console.log(line)
    return
  }
  console.log(`$sks-naruto ${result.status}: ${result.mission_id}`)
  console.log(`Naruto children: requested ${result.requested_subagents}, target ${result.target_subagents ?? result.requested_subagents}, policy ${result.count_policy || 'exact'}, max threads ${result.max_threads}`)
  console.log(`Started/completed/failed: ${result.started_subagents}/${result.completed_subagents}/${result.failed_subagents}`)
  if (result.status === 'delegation_context_ready') console.log('Continue in the current Naruto parent and wait for every requested child before summarizing.')
  for (const line of operatorActionLines) console.log(line)
}

export function renderNarutoOperatorActionLines(result: any): string[] {
  return ['blocked', 'incomplete'].includes(result?.status)
    ? normalizedNarutoOperatorActions(result?.operator_actions).map((action) => `Action: ${action}`)
    : []
}

function renderParentSummaryResult(result: any) {
  if (result.ok !== true) {
    for (const line of renderNarutoBlockedLines(result.blockers || [])) console.log(line)
    return
  }
  console.log(`$sks-naruto parent summary committed: ${result.mission_id}`)
  console.log(`Workflow run: ${result.workflow_run_id}`)
}

function renderStatusResult(result: any) {
  if (['blocked', 'incomplete'].includes(result.status) && Array.isArray(result.blockers) && result.blockers.length) {
    for (const line of renderNarutoBlockedLines(result.blockers)) console.log(line)
    return
  }
  console.log(`Naruto ${result.action || 'status'}: ${result.mission_id}`)
  console.log(`Requested/target/policy: ${result.requested_subagents ?? 0}/${result.target_subagents ?? result.requested_subagents ?? 0}/${result.count_policy || 'exact'}`)
  console.log(`Started/completed/failed: ${result.started_subagents || 0}/${result.completed_subagents || 0}/${result.failed_subagents || 0}`)
}

export function renderNarutoBlockedLines(blockers: readonly unknown[]): string[] {
  return renderHostCapabilityBlockedLines(blockers, {
    reason: 'Naruto 실행이 완료 조건을 충족하지 못했습니다.',
    action: '세부 코드를 확인해 가장 먼저 표시된 원인을 해결한 뒤 다시 실행하세요.'
  })
}
