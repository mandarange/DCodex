import path from 'node:path';
import { appendJsonl, nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js';
import { missionDir, updateCurrentIfMissionAndRun } from '../mission.js';
import { ensureConfinedDirectory } from '../managed-path-safety.js';
import { NARUTO_PARENT_EFFORT, NARUTO_PARENT_MODEL } from '../subagents/model-policy.js';
import { officialSubagentRolePlan } from '../subagents/agent-catalog.js';
import {
  recordOfficialSubagentParentOutcomesTelemetry,
  recordOfficialSubagentZellijTelemetry
} from '../zellij/zellij-official-subagent-telemetry.js';
import {
  bindTrustworthySubagentParentSummaryToRun,
  normalizeSubagentEvent,
  normalizeSubagentParentSummary,
  persistOrReuseTrustworthySubagentParentSummary,
  readSubagentEvents,
  recordSubagentEvent,
  SUBAGENT_EVIDENCE_FILENAME,
  SUBAGENT_PARENT_SUMMARY_FILENAME,
  writeSubagentEvidence
} from '../subagents/subagent-evidence.js';
import {
  officialSubagentPreparationInProgress,
  withOfficialSubagentLifecycleLock,
  writeNarutoGate
} from '../subagents/official-subagent-preparation.js';
import {
  effectiveSubagentTarget,
  normalizeLegacySubagentCountFields,
  refreshSubagentWaveLifecycle,
  subagentCountContractBlockers
} from '../subagents/wave-lifecycle.js';
import { SSOT_GUARD_ARTIFACT, validateSsotGuardArtifact } from '../safety/ssot-guard.js';
import {
  HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME,
  HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME,
  HOST_CAPABILITY_HOOK_RUNTIME_FILENAME,
  bindParentSummaryToHostCapabilityEvidence,
  buildHostCapabilityEvidenceFromHookObservations,
  requestHostCapabilities,
  resolveHostCapabilityHookRuntimeBinding,
  type HostCapabilityExecutionEvidence
} from '../agent-bridge/host-capability-runtime.js';
import { observedParentModelMismatch } from './payload-signals.js';
import { finalizeNarutoTerminalProof } from './naruto-terminal-finalization.js';
import { subagentSkillAvailabilityRunBlockers } from './subagent-skill-availability.js';

export async function recordAndRefreshSubagentEvidence(
  root: string,
  state: any,
  payload: any,
  eventName: 'SubagentStart' | 'SubagentStop',
  sessionKey: any = null
) {
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  await ensureOfficialSubagentArtifactDirConfined(root, artifactDir);
  return withOfficialSubagentLifecycleLock(artifactDir, async () => {
    if (await officialSubagentPreparationInProgress(artifactDir)) return null;
    const plan: any = await readJson(path.join(artifactDir, 'subagent-plan.json'), {});
    const workflowRunId = String(plan?.workflow_run_id || state?.official_subagent_run_id || '').trim();
    const stateRunId = String(state?.official_subagent_run_id || '').trim();
    if (!workflowRunId || (stateRunId && stateRunId !== workflowRunId)) return null;
    const terminalGate: any = plan?.workflow === 'official_codex_subagent'
      ? await readJson(path.join(artifactDir, 'naruto-gate.json'), null).catch(() => null)
      : null;
    const terminalRunId = String(terminalGate?.workflow_run_id || '').trim();
    if (workflowRunId
      && terminalRunId === workflowRunId
      && terminalGate?.passed === true
      && terminalGate?.terminal === true) {
      return null;
    }
    const normalizedInputEvent = normalizeSubagentEvent(payload, eventName);
    const explicitRunId = normalizedInputEvent?.run_id || null;
    if (explicitRunId && explicitRunId !== workflowRunId) return null;
    let boundRunId = explicitRunId;
    if (!boundRunId && eventName === 'SubagentStop' && normalizedInputEvent?.thread_id) {
      const priorEvents = await readSubagentEvents(artifactDir);
      const matchingStartRuns = [...new Set(priorEvents
        .filter((row) => row.event_name === 'SubagentStart'
          && row.thread_id === normalizedInputEvent.thread_id
          && Boolean(row.run_id))
        .map((row) => row.run_id as string))];
      boundRunId = matchingStartRuns.length === 1
        ? matchingStartRuns[0] || null
        : null;
      if (!boundRunId) return null;
    } else if (!boundRunId) {
      boundRunId = workflowRunId || null;
    }
    const eventPayload = boundRunId && payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload, workflow_run_id: boundRunId }
      : payload;
    const event = await recordSubagentEvent(artifactDir, eventPayload, eventName);
    if (!event) return null;
    const zellijTelemetry = await recordOfficialSubagentZellijTelemetry({
      root,
      routeMissionId: plan?.mission_id || state?.mission_id || null,
      event,
      payload: eventPayload,
      plan
    }).catch(async (error: any) => {
      await appendJsonl(path.join(artifactDir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_zellij_telemetry_failed',
        event_name: eventName,
        thread_id: event.thread_id,
        error: String(error?.message || error)
      }).catch(() => null);
      return null;
    });
    if (zellijTelemetry?.blocker) {
      await appendJsonl(path.join(artifactDir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_zellij_telemetry_incomplete',
        event_name: eventName,
        thread_id: event.thread_id,
        blocker: zellijTelemetry.blocker,
        failed_mission_ids: 'failed_mission_ids' in zellijTelemetry ? zellijTelemetry.failed_mission_ids : []
      }).catch(() => null);
    }
    const lifecycle = await refreshSubagentWaveLifecycle(artifactDir, { plan, event }).catch(() => null);
    const refreshedPlan = lifecycle ? { ...plan, wave_lifecycle: lifecycle } : plan;
    const existing: any = await readJson(path.join(artifactDir, SUBAGENT_EVIDENCE_FILENAME), {});
    const parentSummary: any = await readJson(path.join(artifactDir, SUBAGENT_PARENT_SUMMARY_FILENAME), null);
    const countTarget = effectiveSubagentTarget(refreshedPlan, lifecycle?.cumulative_started || 0);
    const requestedSubagents = countTarget.requestedSubagents
      || Number(state?.requested_subagents || existing?.requested_subagents || 0);
    if (!Number.isFinite(requestedSubagents) || requestedSubagents < 1) return event;
    const skillAvailabilityBlockers = await subagentSkillAvailabilityRunBlockers(
      root,
      artifactDir,
      String(plan?.mission_id || state?.mission_id || '').trim(),
      workflowRunId
    );
    const evidence = await writeSubagentEvidence(artifactDir, {
      requestedSubagents,
      countPolicy: countTarget.countPolicy,
      targetSubagents: countTarget.targetSubagents,
      parentSummary,
      parentSummaryPresent: parentSummary !== null,
      workflowStatus: 'running',
      preparationOnly: false,
      runId: workflowRunId || null,
      additionalBlockers: [
        ...(Array.isArray(plan?.config_blockers)
          ? plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`)
          : []),
        ...subagentCountContractBlockers(refreshedPlan, lifecycle?.cumulative_started || 0),
        ...skillAvailabilityBlockers
      ]
    });
    return event;
  });
}

export function officialSubagentArtifactDir(root: any, state: any = {}, sessionKey: any = null) {
  if (state?.mission_id) return missionDir(root, state.mission_id);
  return path.join(root, '.sneakoscope', 'state', 'subagents', sha256(String(sessionKey || 'default')).slice(0, 32));
}

export async function ensureOfficialSubagentArtifactDirConfined(root: string, artifactDir: string): Promise<void> {
  await ensureConfinedDirectory(path.resolve(root), path.resolve(artifactDir));
}

export async function refreshOfficialSubagentCompletionArtifacts(
  root: any,
  state: any = {},
  parentSummary: any = '',
  sessionKey: any = null
) {
  const id = state?.mission_id;
  if (!id) return null;
  const dir = missionDir(root, id);
  await ensureOfficialSubagentArtifactDirConfined(root, dir);
  const snapshot: any = await withOfficialSubagentLifecycleLock(
    dir,
    () => refreshOfficialSubagentCompletionArtifactsLocked(root, state, parentSummary, sessionKey, dir)
  );
  if (snapshot?.terminal?.passed === true) {
    await finalizeNarutoTerminalProof(root, state, sessionKey, dir, snapshot.terminal);
  }
  return snapshot?.evidence ?? snapshot;
}

async function refreshOfficialSubagentCompletionArtifactsLocked(root: any, state: any, parentSummary: any, sessionKey: any, dir: string) {
  if (await officialSubagentPreparationInProgress(dir)) return null;
  const id = state?.mission_id;
  const plan = await readJson(path.join(dir, 'subagent-plan.json'), null).catch(() => null);
  if (plan?.workflow !== 'official_codex_subagent') return null;
  const workflowRunId = String(plan.workflow_run_id || state.official_subagent_run_id || '').trim();
  if (!workflowRunId || String(state.official_subagent_run_id || '').trim() !== workflowRunId) return null;
  const [existingGate, existingSummary, rawExistingEvidence, existingParentSummary] = await Promise.all([
    readJson(path.join(dir, 'naruto-gate.json'), null).catch(() => null),
    readJson(path.join(dir, 'naruto-summary.json'), null).catch(() => null),
    readJson(path.join(dir, SUBAGENT_EVIDENCE_FILENAME), null).catch(() => null),
    readJson(path.join(dir, SUBAGENT_PARENT_SUMMARY_FILENAME), null).catch(() => null)
  ]);
  const existingEvidence = normalizeLegacySubagentCountFields(rawExistingEvidence, plan);
  if (completeNarutoTerminalBundle({
    workflowRunId,
    gate: existingGate,
    summary: existingSummary,
    evidence: existingEvidence,
    parentSummary: existingParentSummary
  })) {
    return {
      evidence: existingEvidence,
      terminal: { passed: true, missionId: state.mission_id, workflowRunId, gate: existingGate }
    };
  }
  const events = await readSubagentEvents(dir);
  const lifecycle = await refreshSubagentWaveLifecycle(dir, { plan }).catch(() => plan.wave_lifecycle || null);
  const refreshedPlan = lifecycle ? { ...plan, wave_lifecycle: lifecycle } : plan;
  const countTarget = effectiveSubagentTarget(refreshedPlan, lifecycle?.cumulative_started || 0);
  const requestedSubagents = countTarget.requestedSubagents || Number(state.requested_subagents || 0);
  const skillAvailabilityBlockers = await subagentSkillAvailabilityRunBlockers(
    root,
    dir,
    String(id || '').trim(),
    workflowRunId
  );
  const hostCapabilityCompletion = await rebuildHostCapabilityEvidenceForFinalization({
    dir,
    state,
    plan: refreshedPlan,
    parentSummary,
    sessionKey,
    workflowRunId
  });
  const runBoundParentSummary = bindTrustworthySubagentParentSummaryToRun(
    hostCapabilityCompletion.parentSummary,
    workflowRunId
  );
  const effectiveParentSummary = await persistOrReuseTrustworthySubagentParentSummary(dir, runBoundParentSummary, {
    workflowStatus: 'parent_completed',
    runId: workflowRunId || null
  });
  const structuredParentSummary = normalizeSubagentParentSummary(effectiveParentSummary);
  const evidence = await writeSubagentEvidence(dir, {
    requestedSubagents,
    countPolicy: countTarget.countPolicy,
    targetSubagents: countTarget.targetSubagents,
    events,
    parentSummary: effectiveParentSummary,
    workflowStatus: 'parent_completed',
    preparationOnly: false,
    runId: workflowRunId || null,
    additionalBlockers: [
      ...(Array.isArray(plan.config_blockers)
        ? plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`)
        : []),
      ...subagentCountContractBlockers(refreshedPlan, lifecycle?.cumulative_started || 0),
      ...hostCapabilityCompletion.blockers,
      ...skillAvailabilityBlockers
    ],
    ...(hostCapabilityCompletion.evidence
      ? { hostCapabilityEvidence: hostCapabilityCompletion.evidence }
      : {})
  });
  if (structuredParentSummary.trustworthy) {
    const parentTelemetry = await recordOfficialSubagentParentOutcomesTelemetry({
      root,
      routeMissionId: id,
      parentSummary: structuredParentSummary.raw,
      plan: refreshedPlan
    }).catch(async (error: any) => {
      await appendJsonl(path.join(dir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_parent_outcome_telemetry_failed',
        error: String(error?.message || error)
      }).catch(() => null);
      return null;
    });
    if (parentTelemetry?.blocker) {
      await appendJsonl(path.join(dir, 'zellij-telemetry-warnings.jsonl'), {
        ts: nowIso(),
        warning: 'official_subagent_parent_outcome_telemetry_incomplete',
        blocker: parentTelemetry.blocker,
        failed_mission_ids: 'failed_mission_ids' in parentTelemetry ? parentTelemetry.failed_mission_ids : [],
        skipped_thread_ids: 'skipped_thread_ids' in parentTelemetry ? parentTelemetry.skipped_thread_ids : []
      }).catch(() => null);
    }
  }
  const isNaruto = String(state?.mode || '').toUpperCase() === 'NARUTO'
    || String(state?.route || state?.route_command || '').replace(/^\$/, '').toUpperCase() === 'NARUTO';
  if (!isNaruto) {
    await updateCurrentIfMissionAndRun(root, id, workflowRunId, {
      subagents_spawned: evidence.started_threads > 0,
      subagents_reported: evidence.completed_threads > 0,
      subagents_verified: evidence.ok,
      subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME,
      parent_summary_present: evidence.parent_summary_present
    }, { sessionKey: sessionKey || state._session_key });
    return { evidence, terminal: null };
  }
  const previousGate = existingGate || {};
  const parentModel = plan.observed_parent_model || state.observed_parent_model || null;
  const parentModelMismatch = previousGate.parent_model_match === false || observedParentModelMismatch(parentModel, NARUTO_PARENT_MODEL);
  const blockers = [...new Set([
    ...evidence.blockers,
    ...(Array.isArray(previousGate.config_blockers) ? previousGate.config_blockers.map(String) : []),
    ...(Array.isArray(plan.config_blockers) ? plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`) : [])
    // parent_model_mismatch is advisory LOD evidence on parent.observed_model_match —
    // never a hard blocker (App sessions cannot rewrite the parent model string).
  ])];
  const ssotValidation = validateSsotGuardArtifact(await readJson(path.join(dir, SSOT_GUARD_ARTIFACT), null).catch(() => null));
  blockers.push(...ssotValidation.issues.map((issue) => `${SSOT_GUARD_ARTIFACT}:${issue}`));
  const uniqueBlockers = [...new Set(blockers)];
  const passed = evidence.ok === true && ssotValidation.ok && uniqueBlockers.length === 0;
  const updatedAt = nowIso();
  const summary = {
    schema: 'sks.naruto-subagent-workflow.v1',
    ok: passed,
    completion_evidence: passed,
    workflow: 'official_codex_subagent',
    workflow_run_id: workflowRunId || null,
    mission_id: id,
    route: '$Naruto',
    status: passed ? 'completed' : evidence.status,
    parent: {
      model: NARUTO_PARENT_MODEL,
      model_reasoning_effort: NARUTO_PARENT_EFFORT,
      observed_model: parentModel,
      observed_model_match: parentModel ? !parentModelMismatch : null
    },
    requested_subagents: requestedSubagents,
    count_policy: evidence.count_policy,
    target_subagents: evidence.target_subagents,
    wave_lifecycle: lifecycle,
    max_threads: Number(plan.max_threads || state.subagent_max_threads || 0),
    max_depth: 1,
    started_subagents: evidence.started_threads,
    completed_subagents: evidence.completed_threads,
    failed_subagents: evidence.failed_threads,
    agents: officialSubagentRolePlan(),
    verification: {
      budget: plan.verification?.budget || plan.verification_budget || 'affected',
      checks: Array.isArray(plan.verification?.checks)
        ? plan.verification.checks
        : Array.isArray(plan.verification_checks)
          ? plan.verification_checks
          : []
    },
    parent_summary_present: evidence.parent_summary_present,
    parent_summary: structuredParentSummary.summary,
    parent_thread_outcomes: structuredParentSummary.raw?.thread_outcomes || [],
    subagent_evidence: SUBAGENT_EVIDENCE_FILENAME,
    blockers: uniqueBlockers,
    updated_at: updatedAt
  };
  await writeJsonAtomic(path.join(dir, 'naruto-summary.json'), summary);
  const gate = await writeNarutoGate(dir, {
    missionId: id,
    workflowRunId,
    evidence,
    passed,
    blockers: uniqueBlockers,
    configBlockers: [
      ...(Array.isArray(previousGate.config_blockers) ? previousGate.config_blockers.map(String) : []),
      ...(Array.isArray(plan.config_blockers) ? plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`) : [])
    ],
    observedParentModel: parentModel,
    parentModelMatch: parentModel ? !parentModelMismatch : null
  });
  await updateCurrentIfMissionAndRun(root, id, workflowRunId, {
    subagents_spawned: evidence.started_threads > 0,
    subagents_reported: evidence.completed_threads > 0,
    subagents_verified: evidence.ok,
    subagent_evidence_file: SUBAGENT_EVIDENCE_FILENAME,
    parent_summary_present: evidence.parent_summary_present
  }, { sessionKey: sessionKey || state._session_key });
  return {
    evidence,
    terminal: passed ? { passed: true, missionId: id, workflowRunId, gate } : null
  };
}

async function rebuildHostCapabilityEvidenceForFinalization(input: {
  dir: string;
  state: any;
  plan: any;
  parentSummary: unknown;
  sessionKey: any;
  workflowRunId: string;
}): Promise<{
  parentSummary: unknown;
  evidence: HostCapabilityExecutionEvidence | null;
  blockers: string[];
}> {
  const request = requestHostCapabilities(input.plan?.goal || input.state?.prompt || '');
  const hostEvidenceRequired = request.capability_ids.length > 0;
  const sessionScope = String(input.state?.session_scope || input.sessionKey || '').trim();
  const rawBinding = await readJson(path.join(input.dir, HOST_CAPABILITY_HOOK_RUNTIME_FILENAME), null).catch(() => null);
  const resolved = resolveHostCapabilityHookRuntimeBinding(rawBinding, {
    missionId: input.state?.mission_id,
    workflowRunId: input.workflowRunId,
    sessionScope,
    request
  });
  if (!resolved.binding) {
    return {
      parentSummary: input.parentSummary,
      evidence: null,
      blockers: hostEvidenceRequired ? [resolved.blocker] : []
    };
  }
  const observations = await readJson(
    path.join(input.dir, HOST_CAPABILITY_HOOK_OBSERVATIONS_FILENAME),
    null
  ).catch(() => null);
  const evidence = buildHostCapabilityEvidenceFromHookObservations({ binding: resolved.binding, observations });
  const bound = bindParentSummaryToHostCapabilityEvidence(input.parentSummary, evidence);
  await writeJsonAtomic(path.join(input.dir, HOST_CAPABILITY_HOOK_EVIDENCE_FILENAME), evidence);
  return {
    parentSummary: bound.value,
    evidence,
    blockers: bound.blockers
  };
}

export function completeNarutoTerminalBundle(input: any) {
  const runId = String(input.workflowRunId || '').trim();
  const parent = normalizeSubagentParentSummary(input.parentSummary);
  return Boolean(
    runId
      && input.gate?.workflow_run_id === runId
      && input.gate?.passed === true
      && input.gate?.terminal === true
      && input.summary?.workflow_run_id === runId
      && input.summary?.ok === true
      && input.summary?.status === 'completed'
      && input.evidence?.run_id === runId
      && input.evidence?.ok === true
      && input.evidence?.status === 'completed'
      && parent.trustworthy
      && parent.status === 'completed'
      && parent.run_id === runId
  );
}
