import fsp from 'node:fs/promises';
import path from 'node:path';
import { appendJsonl, nowIso, readJson, sha256, writeJsonAtomic } from '../fsx.js';
import { missionDir, updateCurrentIfMissionAndRun } from '../mission.js';
import { ensureConfinedDirectory } from '../managed-path-safety.js';
import { NARUTO_PARENT_EFFORT, NARUTO_PARENT_MODEL } from '../subagents/model-policy.js';
import { officialSubagentRolePlan } from '../subagents/agent-catalog.js';
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
  SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR,
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
import { MAX_LIFECYCLE_THREADS } from './subagent-skill-availability-contract.js';
import {
  officialSubagentEvidenceReady,
  terminalBlockedNarutoGate
} from '../subagents/terminal-subagent-state.js';

const SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_SCHEMA = 'sks.subagent-lifecycle-capture-failure.v1';
const MAX_SUBAGENT_LIFECYCLE_CAPTURE_FAILURES = 528;

export type ActiveOfficialSubagentWorkflow =
  | { status: 'inactive' }
  | { status: 'invalid'; missionId: string; workflowRunId: string; reason: string }
  | { status: 'active'; missionId: string; workflowRunId: string; openThreads: number };

export async function inspectActiveOfficialSubagentWorkflow(
  root: string,
  state: any,
  sessionKey: any = null
): Promise<ActiveOfficialSubagentWorkflow> {
  const missionId = String(state?.mission_id || '').trim();
  const workflowRunId = String(state?.official_subagent_run_id || '').trim();
  if (!missionId || !workflowRunId || state?.route_closed === true) return { status: 'inactive' };
  const ownedSession = String(state?.session_scope || '').trim();
  const currentSession = String(sessionKey || '').trim();
  if (ownedSession && currentSession && ownedSession !== currentSession) {
    return { status: 'invalid', missionId, workflowRunId, reason: 'session_scope_mismatch' };
  }
  const artifactDir = officialSubagentArtifactDir(root, state, sessionKey);
  try {
    await ensureOfficialSubagentArtifactDirConfined(root, artifactDir);
    const plan: any = await readJson(path.join(artifactDir, 'subagent-plan.json'), null);
    if (plan?.schema !== 'sks.subagent-plan.v1'
      || plan?.workflow !== 'official_codex_subagent'
      || String(plan?.mission_id || '').trim() !== missionId
      || String(plan?.workflow_run_id || '').trim() !== workflowRunId) {
      return { status: 'invalid', missionId, workflowRunId, reason: 'active_plan_binding_invalid' };
    }
    const gate: any = await readJson(path.join(artifactDir, 'naruto-gate.json'), null).catch(() => null);
    if (gate?.terminal === true
      && (gate?.passed === true || terminalBlockedNarutoGate(gate))
      && String(gate?.workflow_run_id || '').trim() === workflowRunId) {
      return { status: 'inactive' };
    }
    const events = (await readSubagentEvents(artifactDir)).filter((event) => event.run_id === workflowRunId);
    const liveThreads = new Set<string>();
    for (const event of events) {
      if (!event.thread_id) continue;
      if (event.event_name === 'SubagentStart') liveThreads.add(event.thread_id);
      else if (event.event_name === 'SubagentStop') liveThreads.delete(event.thread_id);
    }
    if (liveThreads.size > MAX_LIFECYCLE_THREADS) {
      return { status: 'invalid', missionId, workflowRunId, reason: 'active_event_bound_exceeded' };
    }
    const lifecycle = plan?.wave_lifecycle;
    if (lifecycle != null) {
      const openThreads = Number(lifecycle?.open_threads);
      if (lifecycle?.schema !== 'sks.subagent-wave-lifecycle.v1'
        || lifecycle?.owner !== 'root_parent'
        || String(lifecycle?.workflow_run_id || '').trim() !== workflowRunId
        || !Number.isSafeInteger(openThreads)
        || openThreads < 0
        || openThreads > MAX_LIFECYCLE_THREADS) {
        return { status: 'invalid', missionId, workflowRunId, reason: 'active_lifecycle_invalid' };
      }
      if (events.length > 0 && openThreads !== liveThreads.size) {
        return { status: 'invalid', missionId, workflowRunId, reason: 'active_lifecycle_event_mismatch' };
      }
      return { status: 'active', missionId, workflowRunId, openThreads };
    }
    return { status: 'active', missionId, workflowRunId, openThreads: liveThreads.size };
  } catch {
    return { status: 'invalid', missionId, workflowRunId, reason: 'active_workflow_inspection_failed' };
  }
}

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
    const priorEvents = await readSubagentEvents(artifactDir);
    let boundRunId = explicitRunId;
    if (!boundRunId
      && eventName === 'SubagentStop'
      && normalizedInputEvent?.thread_id
      && String(payload?.turn_id || '').trim()) {
      const matchingStartRuns = [...new Set(priorEvents
        .filter((row) => row.event_name === 'SubagentStart'
          && row.thread_id === normalizedInputEvent.thread_id
          && Boolean(row.run_id))
        .map((row) => row.run_id as string))];
      boundRunId = matchingStartRuns.length === 1
        ? matchingStartRuns[0] || null
        : null;
      if (!boundRunId) return null;
    } else if (!boundRunId && eventName === 'SubagentStop') {
      // A delayed Stop without an explicit run or generation-bound turn is
      // indistinguishable from a reused thread in the active run. Preserve the
      // current lifecycle and guard state instead of guessing.
      return null;
    } else if (!boundRunId) {
      boundRunId = workflowRunId || null;
    }
    const eventPayload = boundRunId && payload && typeof payload === 'object' && !Array.isArray(payload)
      ? { ...payload, workflow_run_id: boundRunId }
      : payload;
    const event = await recordSubagentEvent(artifactDir, eventPayload, eventName);
    if (!event) return null;
    const events = [...priorEvents, event];
    await clearOfficialSubagentLifecycleCaptureFailure(
      artifactDir,
      state,
      eventPayload,
      eventName
    );
    const lifecycle = await refreshSubagentWaveLifecycle(artifactDir, { plan, event, events });
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
    const lifecycleCaptureBlockers = await officialSubagentLifecycleCaptureBlockers(
      artifactDir,
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
      events,
      additionalBlockers: [
        ...(Array.isArray(plan?.config_blockers)
          ? plan.config_blockers.map((item: any) => `official_subagent_config:${String(item)}`)
          : []),
        ...subagentCountContractBlockers(refreshedPlan, lifecycle?.cumulative_started || 0),
        ...skillAvailabilityBlockers,
        ...lifecycleCaptureBlockers
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
  if (snapshot?.terminal?.terminal === true) {
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
      terminal: {
        passed: existingGate?.passed === true,
        terminal: true,
        missionId: state.mission_id,
        workflowRunId,
        gate: existingGate
      }
    };
  }
  const events = await readSubagentEvents(dir);
  const lifecycle = await refreshSubagentWaveLifecycle(dir, { plan, events });
  const refreshedPlan = lifecycle ? { ...plan, wave_lifecycle: lifecycle } : plan;
  const countTarget = effectiveSubagentTarget(refreshedPlan, lifecycle?.cumulative_started || 0);
  const requestedSubagents = countTarget.requestedSubagents || Number(state.requested_subagents || 0);
  const skillAvailabilityBlockers = await subagentSkillAvailabilityRunBlockers(
    root,
    dir,
    String(id || '').trim(),
    workflowRunId
  );
  const lifecycleCaptureBlockers = await officialSubagentLifecycleCaptureBlockers(
    dir,
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
      ...skillAvailabilityBlockers,
      ...lifecycleCaptureBlockers
    ],
    ...(hostCapabilityCompletion.evidence
      ? { hostCapabilityEvidence: hostCapabilityCompletion.evidence }
      : {})
  });
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
    terminal: gate.terminal === true
      ? { passed, terminal: true, missionId: id, workflowRunId, gate }
      : null
  };
}

export async function recordOfficialSubagentLifecycleCaptureFailure(
  artifactDir: string,
  state: any,
  payload: any,
  eventName: 'SubagentStart' | 'SubagentStop'
): Promise<string> {
  const identity = subagentLifecycleCaptureIdentity(state, payload, eventName);
  const directory = path.join(artifactDir, SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR);
  await ensureConfinedDirectory(path.resolve(artifactDir), directory);
  const runDirectory = path.join(directory, identity.runKey);
  await ensureConfinedDirectory(directory, runDirectory);
  await writeJsonAtomic(
    path.join(runDirectory, `${identity.key}.json`),
    {
      schema: SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_SCHEMA,
      recorded_at: nowIso(),
      event_name: eventName,
      thread_id: identity.threadId,
      run_id: identity.runId,
      blocker: identity.blocker
    }
  );
  return identity.blocker;
}

export async function officialSubagentLifecycleCaptureBlockers(
  artifactDir: string,
  workflowRunId: string
): Promise<string[]> {
  const directory = path.join(artifactDir, SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR);
  const runKey = subagentLifecycleCaptureRunKey(workflowRunId);
  const runDirectory = path.join(directory, runKey);
  const rows = await readDirectoryOrEmptyWhenMissing(runDirectory, true);
  const files = rows
    .filter((row) => row.isFile() && row.name.endsWith('.json'))
    .sort((left, right) => left.name.localeCompare(right.name));
  const blockers = files.length > MAX_SUBAGENT_LIFECYCLE_CAPTURE_FAILURES
    ? ['official_subagent_lifecycle_capture_failure_overflow']
    : [];
  for (const row of files.slice(0, MAX_SUBAGENT_LIFECYCLE_CAPTURE_FAILURES)) {
    const failure: any = await readJson(path.join(runDirectory, row.name), null);
    if (failure?.schema !== SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_SCHEMA
      || String(failure?.run_id || '') !== workflowRunId) {
      continue;
    }
    const blocker = String(failure?.blocker || '').trim();
    if (/^official_subagent_lifecycle_capture_failed:(?:SubagentStart|SubagentStop):[a-f0-9]{16}$/.test(blocker)) {
      blockers.push(blocker);
    }
  }
  return [...new Set(blockers)].sort();
}

async function clearOfficialSubagentLifecycleCaptureFailure(
  artifactDir: string,
  state: any,
  payload: any,
  eventName: 'SubagentStart' | 'SubagentStop'
): Promise<void> {
  const identity = subagentLifecycleCaptureIdentity(state, payload, eventName);
  const runDirectory = path.join(
    artifactDir,
    SUBAGENT_LIFECYCLE_CAPTURE_FAILURE_DIR,
    identity.runKey
  );
  await fsp.rm(path.join(runDirectory, `${identity.key}.json`), { force: true });
  const remaining = await readDirectoryOrEmptyWhenMissing(runDirectory, false);
  if (remaining.length === 0) {
    await fsp.rmdir(runDirectory).catch((error: any) => {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY') throw error;
    });
  }
}

function subagentLifecycleCaptureIdentity(
  state: any,
  payload: any,
  eventName: 'SubagentStart' | 'SubagentStop'
) {
  const normalized = normalizeSubagentEvent(payload, eventName);
  const runId = String(
    normalized?.run_id
    || state?.official_subagent_run_id
    || 'unbound'
  ).trim();
  const threadId = String(normalized?.thread_id || 'unknown').trim();
  const key = sha256(`${runId}\0${threadId}\0${eventName}`).slice(0, 32);
  const blocker = `official_subagent_lifecycle_capture_failed:${eventName}:${
    sha256(threadId).slice(0, 16)
  }`;
  return {
    key,
    runKey: subagentLifecycleCaptureRunKey(runId),
    runId,
    threadId,
    blocker
  };
}

function subagentLifecycleCaptureRunKey(runId: string): string {
  return sha256(String(runId || 'unbound')).slice(0, 32);
}

async function readDirectoryOrEmptyWhenMissing(
  directory: string,
  withFileTypes: true
): Promise<any[]>;
async function readDirectoryOrEmptyWhenMissing(
  directory: string,
  withFileTypes: false
): Promise<string[]>;
async function readDirectoryOrEmptyWhenMissing(
  directory: string,
  withFileTypes: boolean
): Promise<any[]> {
  try {
    return withFileTypes
      ? await fsp.readdir(directory, { withFileTypes: true })
      : await fsp.readdir(directory);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
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
  const completed = Boolean(
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
  const blocked = Boolean(
    runId
      && input.gate?.workflow_run_id === runId
      && terminalBlockedNarutoGate(input.gate)
      && input.summary?.workflow_run_id === runId
      && input.summary?.ok !== true
      && input.summary?.status === 'blocked'
      && input.evidence?.run_id === runId
      && officialSubagentEvidenceReady(input.evidence)
      && parent.trustworthy
      && parent.status === 'blocked'
      && parent.run_id === runId
  );
  return completed || blocked;
}
