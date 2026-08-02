import path from 'node:path';
import { nowIso, sha256 } from '../fsx.js';
import {
  type SksSkillSourceResolution
} from '../codex-native/sks-skill-paths.js';
import { resolveManagedSkillSourcesForAdmission } from './managed-skill-admission.js';
import {
  ADMISSION_SCHEMA,
  MAX_LIFECYCLE_GUARD_BYTES,
  MAX_LIFECYCLE_THREADS,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA,
  SubagentSkillAvailabilityGuardError,
  type SubagentSkillAvailabilityActiveBinding,
  type SubagentSkillAvailabilityAdmission,
  type SubagentSkillAvailabilityBlocker,
  validBlocker
} from './subagent-skill-availability-contract.js';
import {
  admissionFingerprint,
  admissionGuardRoots,
  admissionGuardRootsWithLegacyMirrors,
  blockedRunAdmissions,
  boundedAgentThreadId,
  invalidGuard,
  officialSubagentThreadIdFromSessions,
  officialSubagentThreadIdFromTranscript,
  preToolBlockReason,
  readAdmissionForThread,
  readAdmissionPair,
  readBoundedConfinedJson,
  readConfinedJson,
  safeRemoveGuard,
  threadGuardPath,
  turnGuardPath,
  writeAdmissionPair
} from './subagent-skill-availability-guards.js';
import {
  clearMatchingBlockerEvidence,
  emergencyRunBlockers,
  matchingArtifactBlockers,
  persistBlockerEvidence
} from './subagent-skill-availability-evidence.js';

export {
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA
} from './subagent-skill-availability-contract.js';
export type {
  SubagentSkillAvailabilityActiveBinding
} from './subagent-skill-availability-contract.js';

export function authoritativeSksSkillResolutionBlockers(
  resolution: SksSkillSourceResolution | null
): string[] {
  if (!resolution) return ['authoritative_sks_skill_resolution_failed'];
  const blockers = [
    ...resolution.unresolved.map((name) => `authoritative_sks_skill_unavailable:${name}`),
    ...(resolution.blockers.length ? ['authoritative_sks_skill_candidate_rejected'] : [])
  ];
  return [...new Set(blockers)];
}

export function renderSubagentSkillAvailabilityHandoff(blockers: readonly string[]): string {
  const codes = blockers.length ? blockers.join(', ') : 'authoritative_sks_skill_resolution_failed';
  return [
    'MANDATORY SKS PARENT-BLOCK HANDOFF:',
    '- Current managed SKS skill availability was not verified for this child thread.',
    '- Do not inspect files, call tools, run commands, modify anything, or spawn another agent.',
    '- Immediately return a concise blocked result to the root parent.',
    `- Return status=blocked with blockers=[${codes}].`,
    '- Do not reuse or mention any prior skill location.'
  ].join('\n');
}

export async function persistSubagentSkillAvailabilityBlocker(input: {
  root: string;
  artifactDir: string;
  sessionArtifactDir?: string | null;
  state: any;
  payload: any;
  blockers: readonly string[];
}): Promise<SubagentSkillAvailabilityAdmission> {
  const threadId = String(input.payload?.agent_id || '').trim();
  const sessionScope = String(input.payload?.session_id || '').trim();
  const turnId = String(input.payload?.turn_id || '').trim();
  if (!threadId || !sessionScope || !turnId) {
    throw new Error('subagent_skill_availability_guard_identity_missing');
  }
  const plan: any = await readConfinedJson(input.root, path.join(input.artifactDir, 'subagent-plan.json'));
  const blockers = [...new Set(input.blockers.map((item) => String(item || '').trim()).filter(Boolean))];
  const admission: SubagentSkillAvailabilityAdmission = {
    schema: ADMISSION_SCHEMA,
    status: blockers.length ? 'blocked' : 'allowed',
    mission_id: String(input.state?.mission_id || plan?.mission_id || '').trim() || null,
    workflow_run_id: String(input.state?.official_subagent_run_id || plan?.workflow_run_id || '').trim() || null,
    thread_id_hash: sha256(threadId),
    session_scope_hash: sha256(sessionScope),
    turn_id_hash: sha256(turnId),
    blockers,
    recorded_at: nowIso()
  };
  const binding = {
    missionId: admission.mission_id,
    workflowRunId: admission.workflow_run_id
  };
  const { scoped: roots } = await admissionGuardRootsWithLegacyMirrors(
    input.root,
    input.artifactDir,
    binding
  );
  // Publish a bounded denial before clearing stale evidence so an earlier
  // allowed pair cannot survive a partial healthy restart.
  const guardedAdmission: SubagentSkillAvailabilityAdmission = blockers.length
    ? admission
    : {
        ...admission,
        status: 'blocked',
        blockers: ['subagent_skill_availability_blocker_artifact_write_failed']
      };
  const rootWrites = await Promise.all(
    roots.map((guardRoot) => writeAdmissionPair(guardRoot, guardedAdmission))
  );
  const stableGuardMissing = !rootWrites.some((written, index) => (
    written && roots[index]?.missionIndependent
  ));
  const evidenceBlockers = stableGuardMissing
    ? [...new Set([...blockers, 'subagent_skill_availability_guard_persistence_failed'])]
    : blockers;
  let evidenceWrite: boolean;
  if (evidenceBlockers.length) {
    const blocker: SubagentSkillAvailabilityBlocker = {
      schema: SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA,
      status: 'blocked',
      mission_id: admission.mission_id,
      workflow_run_id: admission.workflow_run_id,
      thread_id_hash: admission.thread_id_hash,
      session_scope_hash: admission.session_scope_hash,
      turn_id_hash: admission.turn_id_hash,
      blockers: evidenceBlockers,
      recorded_at: admission.recorded_at
    };
    evidenceWrite = await persistBlockerEvidence({
      root: input.root,
      artifactDir: input.artifactDir,
      sessionArtifactDir: input.sessionArtifactDir,
      blocker,
      emergency: stableGuardMissing
    });
  } else {
    evidenceWrite = await clearMatchingBlockerEvidence({
      root: input.root,
      artifactDir: input.artifactDir,
      sessionArtifactDir: input.sessionArtifactDir,
      threadHash: admission.thread_id_hash
    });
  }
  if (stableGuardMissing) throw new Error('subagent_skill_availability_guard_persistence_failed');
  if (!evidenceWrite) throw new Error('subagent_skill_availability_blocker_artifact_write_failed');
  if (!blockers.length) {
    const allowedWrites = await Promise.all(
      roots.map((guardRoot) => writeAdmissionPair(guardRoot, admission))
    );
    const guardedRootCommitFailed = rootWrites.some((guardedWrite, index) => (
      guardedWrite && !allowedWrites[index]
    ));
    const stableAllowedCommitMissing = !allowedWrites.some((written, index) => (
      written && roots[index]?.missionIndependent
    ));
    if (stableAllowedCommitMissing || guardedRootCommitFailed) {
      throw new Error('subagent_skill_availability_guard_persistence_failed');
    }
  }
  return admission;
}

export async function subagentSkillAvailabilityPreToolBlockReason(
  root: string,
  payload: any,
  artifactDir: string | null | undefined,
  activeBinding: SubagentSkillAvailabilityActiveBinding
): Promise<string | null> {
  const rawPayloadThreadId = payload?.agent_id;
  const payloadThreadId = boundedAgentThreadId(rawPayloadThreadId);
  const payloadThreadIdClaimed = typeof rawPayloadThreadId === 'string'
    ? Boolean(rawPayloadThreadId.trim())
    : rawPayloadThreadId !== undefined && rawPayloadThreadId !== null;
  if (payloadThreadIdClaimed && !payloadThreadId) throw invalidGuard(true);
  const rawTranscriptThreadId = await officialSubagentThreadIdFromTranscript(payload?.transcript_path);
  const transcriptThreadId = boundedAgentThreadId(rawTranscriptThreadId);
  if (rawTranscriptThreadId && !transcriptThreadId) throw invalidGuard(true);
  if (payloadThreadId && transcriptThreadId && payloadThreadId !== transcriptThreadId) {
    throw invalidGuard(true);
  }
  const threadId = payloadThreadId || transcriptThreadId;
  const threadHash = threadId ? sha256(threadId) : null;
  const activeMissionId = String(activeBinding?.missionId || '').trim() || null;
  const activeWorkflowRunId = String(activeBinding?.workflowRunId || '').trim() || null;
  if (threadId && (!activeMissionId || !activeWorkflowRunId)) {
    return preToolBlockReason(['subagent_skill_availability_guard_invalid']);
  }
  const sessionScope = String(payload?.session_id || '').trim();
  const turnId = String(payload?.turn_id || '').trim();
  if (!sessionScope || !turnId) {
    return threadId ? preToolBlockReason(['subagent_skill_availability_admission_missing']) : null;
  }
  const sessionHash = sha256(sessionScope);
  const turnHash = sha256(turnId);
  const artifactEvidence = artifactDir
    ? await matchingArtifactBlockers(root, artifactDir, sessionHash, turnHash)
    : null;
  const admissions: SubagentSkillAvailabilityAdmission[] = [];
  const errors: unknown[] = [];
  const binding = { missionId: activeMissionId, workflowRunId: activeWorkflowRunId };
  const { scoped, legacy } = await admissionGuardRootsWithLegacyMirrors(root, artifactDir, binding);
  const readRoots = async (roots: typeof scoped) => {
    for (const guardRoot of roots) {
      try {
        const admission = await readAdmissionPair(guardRoot, threadHash, sessionHash, turnHash);
        if (admission) admissions.push(admission);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
  };
  await readRoots(scoped);
  // Legacy exact-path guards are compatibility-only. They are consulted only
  // when the run-partition source of truth has no evidence, so stale mirrors
  // cannot conflict with or grow alongside current admissions.
  if (!admissions.length && !errors.length) await readRoots(legacy);
  const invalidChildEvidence = errors.some((error) => (
    error instanceof SubagentSkillAvailabilityGuardError && error.childEvidence
  ));
  if (artifactEvidence) {
    if (!activeMissionId
      || !activeWorkflowRunId
      || artifactEvidence.missionId !== activeMissionId
      || artifactEvidence.workflowRunId !== activeWorkflowRunId) {
      return preToolBlockReason(['subagent_skill_availability_guard_invalid']);
    }
    return preToolBlockReason(artifactEvidence.blockers);
  }
  if (errors.length && (threadId || admissions.length || invalidChildEvidence)) throw errors[0];
  if (errors.length) return null;
  if (!admissions.length) {
    return threadId ? preToolBlockReason(['subagent_skill_availability_admission_missing']) : null;
  }
  if (!activeMissionId
    || !activeWorkflowRunId
    || admissions.some((admission) => (
      admission.mission_id !== activeMissionId
      || admission.workflow_run_id !== activeWorkflowRunId
    ))) {
    return preToolBlockReason(['subagent_skill_availability_guard_invalid']);
  }
  const fingerprints = new Set(admissions.map(admissionFingerprint));
  if (fingerprints.size !== 1) return preToolBlockReason(['subagent_skill_availability_guard_invalid']);
  const admission = admissions[0]!;
  return admission.status === 'blocked' ? preToolBlockReason(admission.blockers) : null;
}

export function isSubagentSkillAvailabilityAdmissionMissingReason(reason: string | null): boolean {
  return reason === preToolBlockReason(['subagent_skill_availability_admission_missing']);
}

export async function recoverResumedOfficialSubagentSkillAvailabilityAdmission(input: {
  root: string;
  payload: any;
  artifactDir: string;
  sessionArtifactDir?: string | null;
  activeBinding: SubagentSkillAvailabilityActiveBinding;
  skillNames: readonly unknown[];
}): Promise<boolean> {
  const rawPayloadThreadId = input.payload?.agent_id;
  const payloadThreadId = boundedAgentThreadId(rawPayloadThreadId);
  const payloadThreadIdClaimed = typeof rawPayloadThreadId === 'string'
    ? Boolean(rawPayloadThreadId.trim())
    : rawPayloadThreadId !== undefined && rawPayloadThreadId !== null;
  if (payloadThreadIdClaimed && !payloadThreadId) return false;
  const transcriptPath = String(input.payload?.transcript_path || '').trim();
  const rawTranscriptThreadId = transcriptPath
    ? await officialSubagentThreadIdFromTranscript(transcriptPath)
    : payloadThreadId
      ? await officialSubagentThreadIdFromSessions(payloadThreadId)
      : null;
  const transcriptThreadId = boundedAgentThreadId(rawTranscriptThreadId);
  if (!transcriptThreadId
    || (payloadThreadId && payloadThreadId !== transcriptThreadId)) return false;
  const sessionScope = String(input.payload?.session_id || '').trim();
  const turnId = String(input.payload?.turn_id || '').trim();
  const activeMissionId = String(input.activeBinding?.missionId || '').trim();
  const activeWorkflowRunId = String(input.activeBinding?.workflowRunId || '').trim();
  if (!sessionScope || !turnId || !activeMissionId || !activeWorkflowRunId) return false;
  const plan: any = await readConfinedJson(
    input.root,
    path.join(input.artifactDir, 'subagent-plan.json')
  );
  if (!resumedOfficialThreadBelongsToActiveRun(
    plan,
    activeMissionId,
    activeWorkflowRunId,
    transcriptThreadId
  )) return false;
  const skillNames = [...new Set(input.skillNames
    .map((name) => String(name || '').trim())
    .filter(Boolean))];
  if (!skillNames.length) return false;
  const resolution = await resolveManagedSkillSourcesForAdmission({
    root: input.root,
    skillNames,
    repairMode: 'stale-generation'
  }).catch(() => null);
  if (authoritativeSksSkillResolutionBlockers(resolution).length) return false;
  await persistSubagentSkillAvailabilityBlocker({
    root: input.root,
    artifactDir: input.artifactDir,
    ...(input.sessionArtifactDir !== undefined
      ? { sessionArtifactDir: input.sessionArtifactDir }
      : {}),
    state: {
      mission_id: activeMissionId,
      official_subagent_run_id: activeWorkflowRunId
    },
    payload: { ...input.payload, agent_id: transcriptThreadId },
    blockers: []
  });
  return true;
}

export async function clearSubagentSkillAvailabilityGuards(
  root: string,
  payload: any,
  artifactDir?: string | null,
  activeBinding?: SubagentSkillAvailabilityActiveBinding | null
): Promise<void> {
  const threadId = boundedAgentThreadId(payload?.agent_id);
  const sessionScope = String(payload?.session_id || '').trim();
  const turnId = String(payload?.turn_id || '').trim();
  const missionId = String(activeBinding?.missionId || '').trim();
  const workflowRunId = String(activeBinding?.workflowRunId || '').trim();
  const payloadWorkflowRunId = String(
    payload?.workflow_run_id || payload?.run_id || ''
  ).trim();
  if (!threadId || !missionId || !workflowRunId) return;
  if (payloadWorkflowRunId && payloadWorkflowRunId !== workflowRunId) return;
  const threadHash = sha256(threadId);
  const sessionHash = sessionScope ? sha256(sessionScope) : null;
  const turnHash = turnId ? sha256(turnId) : null;
  const { scoped, legacy } = await admissionGuardRootsWithLegacyMirrors(root, artifactDir, {
    missionId,
    workflowRunId
  });
  await Promise.all([...scoped, ...legacy].map(async (guardRoot) => {
    let admission: SubagentSkillAvailabilityAdmission | null;
    try {
      admission = await readAdmissionForThread(guardRoot, threadHash);
      if (admission) {
        admission = await readAdmissionPair(
          guardRoot,
          threadHash,
          admission.session_scope_hash,
          admission.turn_id_hash
        );
      }
    } catch {
      return;
    }
    if (!admission
      || admission.mission_id !== missionId
      || admission.workflow_run_id !== workflowRunId
      || (sessionHash && admission.session_scope_hash !== sessionHash)
      || (turnHash && admission.turn_id_hash !== turnHash)) return;
    await Promise.all([
      safeRemoveGuard(threadGuardPath(guardRoot.root, threadHash), guardRoot.boundary),
      safeRemoveGuard(
        turnGuardPath(
          guardRoot.root,
          admission.session_scope_hash,
          admission.turn_id_hash
        ),
        guardRoot.boundary
      )
    ]);
  }));
}

export async function subagentSkillAvailabilityRunBlockers(
  root: string,
  artifactDir: string,
  missionId: string,
  workflowRunId: string
): Promise<string[]> {
  const blockers: string[] = [];
  for (const guardRoot of await admissionGuardRoots(root, artifactDir, {
    missionId,
    workflowRunId
  })) {
    blockers.push(...await blockedRunAdmissions(guardRoot, missionId, workflowRunId));
  }
  blockers.push(...await emergencyRunBlockers(root, artifactDir, missionId, workflowRunId));
  const file = path.join(artifactDir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME);
  const blockerRead = await readBoundedConfinedJson(
    path.resolve(root),
    file,
    MAX_LIFECYCLE_GUARD_BYTES
  );
  if (blockerRead.status === 'missing') return [...new Set(blockers)];
  if (blockerRead.status !== 'value' || !validBlocker(blockerRead.value)) {
    return [...new Set([...blockers, 'subagent_skill_availability_blocker_artifact_invalid'])];
  }
  const blocker = blockerRead.value;
  if (!missionId || blocker.mission_id !== missionId) {
    return [...new Set([...blockers, 'subagent_skill_availability_blocker_artifact_invalid'])];
  }
  if (!workflowRunId || blocker.workflow_run_id !== workflowRunId) return [...new Set(blockers)];
  return [...new Set([...blockers, ...blocker.blockers])];
}

export function resumedOfficialThreadBelongsToActiveRun(
  plan: any,
  missionId: string,
  workflowRunId: string,
  threadId: string
): boolean {
  if (plan?.schema !== 'sks.subagent-plan.v1'
    || plan?.workflow !== 'official_codex_subagent'
    || String(plan?.mission_id || '').trim() !== missionId
    || String(plan?.workflow_run_id || '').trim() !== workflowRunId) return false;
  const lifecycle = plan?.wave_lifecycle;
  if (lifecycle?.schema !== 'sks.subagent-wave-lifecycle.v1'
    || lifecycle?.owner !== 'root_parent'
    || String(lifecycle?.workflow_run_id || '').trim() !== workflowRunId
    || !Array.isArray(lifecycle?.waves)
    || lifecycle.waves.length < 1
    || lifecycle.waves.length > MAX_LIFECYCLE_THREADS) return false;
  const assigned = new Set<string>();
  const settled = new Set<string>();
  for (const wave of lifecycle.waves) {
    if (!wave || typeof wave !== 'object' || Array.isArray(wave)
      || !Array.isArray(wave.thread_ids)
      || !Array.isArray(wave.settled_thread_ids)) return false;
    const waveAssigned = new Set<string>();
    for (const rawThreadId of wave.thread_ids) {
      const boundedThreadId = boundedAgentThreadId(rawThreadId);
      if (!boundedThreadId || boundedThreadId !== rawThreadId || assigned.has(boundedThreadId)) return false;
      waveAssigned.add(boundedThreadId);
      assigned.add(boundedThreadId);
      if (assigned.size > MAX_LIFECYCLE_THREADS) return false;
    }
    for (const rawThreadId of wave.settled_thread_ids) {
      const boundedThreadId = boundedAgentThreadId(rawThreadId);
      if (!boundedThreadId || boundedThreadId !== rawThreadId
        || !waveAssigned.has(boundedThreadId)
        || settled.has(boundedThreadId)) return false;
      settled.add(boundedThreadId);
    }
  }
  return assigned.has(threadId) && settled.has(threadId);
}
