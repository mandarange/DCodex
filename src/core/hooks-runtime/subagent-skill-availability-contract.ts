import { HARD_NARUTO_MAX_THREADS } from '../subagents/thread-budget.js';

export const SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME = 'subagent-skill-availability-blocker.json';
export const SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA = 'sks.subagent-skill-availability-blocker.v1';
export const GUARD_DIR = 'subagent-skill-availability';
export const EMERGENCY_DENIAL_DIR = 'subagent-skill-availability-emergency-denials';
export const MAX_LIFECYCLE_THREADS = HARD_NARUTO_MAX_THREADS;
export const MAX_EMERGENCY_DENIALS = MAX_LIFECYCLE_THREADS;
// Each live child owns one thread admission and one turn admission. Keep the
// directory scan bounded while leaving a small margin for in-flight rotation.
export const MAX_GUARD_DIRECTORY_ENTRIES = (HARD_NARUTO_MAX_THREADS * 2) + 16;
export const MAX_LIFECYCLE_GUARD_BYTES = 64 * 1024;
export const MAX_SUBAGENT_PLAN_BYTES = 256 * 1024;
export const ADMISSION_SCHEMA = 'sks.subagent-skill-availability-admission.v1';
export const SUBAGENT_ADMISSION_BLOCKER_RE = /^(?:authoritative_sks_skill_resolution_failed|authoritative_sks_skill_candidate_rejected|authoritative_sks_skill_unavailable:sks(?:-[a-z0-9]+)*|subagent_skill_availability_(?:artifact_dir_unsafe|blocker_artifact_write_failed|guard_invalid|guard_persistence_failed))$/;

export interface SubagentSkillAvailabilityBlocker {
  schema: typeof SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA;
  status: 'blocked';
  mission_id: string | null;
  workflow_run_id: string | null;
  thread_id_hash: string;
  session_scope_hash: string;
  turn_id_hash: string;
  blockers: string[];
  recorded_at: string;
}

export interface SubagentSkillAvailabilityAdmission {
  schema: typeof ADMISSION_SCHEMA;
  status: 'allowed' | 'blocked';
  mission_id: string | null;
  workflow_run_id: string | null;
  thread_id_hash: string;
  session_scope_hash: string;
  turn_id_hash: string;
  blockers: string[];
  recorded_at: string;
}

export interface GuardRoot {
  root: string;
  boundary: string;
  missionIndependent: boolean;
}

export interface GuardRunBinding {
  missionId: unknown;
  workflowRunId: unknown;
}

export interface SubagentSkillAvailabilityActiveBinding {
  missionId: unknown;
  workflowRunId: unknown;
}

export interface MatchingArtifactEvidence {
  blockers: string[];
  missionId: string | null;
  workflowRunId: string | null;
}

export type BoundedJsonResult =
  | { status: 'missing' }
  | { status: 'invalid'; childEvidence: boolean }
  | { status: 'value'; value: any };

export class SubagentSkillAvailabilityGuardError extends Error {
  constructor(readonly childEvidence: boolean) {
    super('subagent_skill_availability_guard_invalid');
  }
}

export function validBlocker(value: any): value is SubagentSkillAvailabilityBlocker {
  return value?.schema === SUBAGENT_SKILL_AVAILABILITY_BLOCKER_SCHEMA
    && value?.status === 'blocked'
    && (value?.mission_id === null || typeof value?.mission_id === 'string')
    && (value?.workflow_run_id === null || typeof value?.workflow_run_id === 'string')
    && /^[a-f0-9]{64}$/.test(String(value?.thread_id_hash || ''))
    && /^[a-f0-9]{64}$/.test(String(value?.session_scope_hash || ''))
    && /^[a-f0-9]{64}$/.test(String(value?.turn_id_hash || ''))
    && Array.isArray(value?.blockers)
    && value.blockers.length > 0
    && value.blockers.every((item: unknown) => (
      SUBAGENT_ADMISSION_BLOCKER_RE.test(String(item || ''))
    ));
}
