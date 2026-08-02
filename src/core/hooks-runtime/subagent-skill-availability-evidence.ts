import path from 'node:path';
import {
  inspectConfinedPath,
  removeManagedPathVerified
} from '../managed-path-safety.js';
import {
  EMERGENCY_DENIAL_DIR,
  MAX_EMERGENCY_DENIALS,
  MAX_LIFECYCLE_GUARD_BYTES,
  SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME,
  type MatchingArtifactEvidence,
  type SubagentSkillAvailabilityBlocker,
  validBlocker
} from './subagent-skill-availability-contract.js';
import {
  boundedDirectoryNames,
  readBoundedConfinedJson,
  safeWriteJson
} from './subagent-skill-availability-guards.js';
import { sha256 } from '../fsx.js';

export function uniqueArtifactDirs(...values: Array<string | null | undefined>): string[] {
  return [...new Set(values
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => path.resolve(value)))];
}

export async function persistBlockerEvidence(input: {
  root: string;
  artifactDir: string;
  sessionArtifactDir?: string | null | undefined;
  blocker: SubagentSkillAvailabilityBlocker;
  emergency: boolean;
}): Promise<boolean> {
  const emergencyArtifactDirs = input.emergency
    ? uniqueArtifactDirs(input.artifactDir, input.sessionArtifactDir)
    : [];
  const [sharedWrite, emergencyWrites] = await Promise.all([
    safeWriteJson(
      path.join(input.artifactDir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME),
      path.resolve(input.root),
      input.blocker
    ),
    Promise.all(emergencyArtifactDirs.map((artifactDir) => (
      persistEmergencyDenial(path.resolve(input.root), artifactDir, input.blocker)
    )))
  ]);
  return sharedWrite && emergencyWrites.every(Boolean);
}

export async function clearMatchingBlockerEvidence(input: {
  root: string;
  artifactDir: string;
  sessionArtifactDir?: string | null | undefined;
  threadHash: string;
}): Promise<boolean> {
  const root = path.resolve(input.root);
  const artifactDir = path.resolve(input.artifactDir);
  const file = path.join(artifactDir, SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME);
  try {
    const emergencyCleared = (await Promise.all(
      uniqueArtifactDirs(artifactDir, input.sessionArtifactDir).map((candidate) => (
        clearMatchingEmergencyDenials(root, candidate, input.threadHash)
      ))
    )).every(Boolean);
    const inspected = await inspectConfinedPath(root, file);
    if (!inspected.exists) return emergencyCleared;
    if (inspected.leafSymlink || !inspected.stat?.isFile()) return false;
    const blockerRead = await readBoundedConfinedJson(root, file, MAX_LIFECYCLE_GUARD_BYTES);
    if (blockerRead.status !== 'value' || !validBlocker(blockerRead.value)) return false;
    if (blockerRead.value.thread_id_hash !== input.threadHash) return emergencyCleared;
    await removeManagedPathVerified(root, file);
    return emergencyCleared && !(await inspectConfinedPath(root, file)).exists;
  } catch {
    return false;
  }
}

export async function matchingArtifactBlockers(
  root: string,
  artifactDir: string,
  sessionHash: string,
  turnHash: string
): Promise<MatchingArtifactEvidence | null> {
  const emergency = await matchingEmergencyDenial(root, artifactDir, sessionHash, turnHash);
  if (emergency) return emergency;
  const file = path.join(path.resolve(artifactDir), SUBAGENT_SKILL_AVAILABILITY_BLOCKER_FILENAME);
  const result = await readBoundedConfinedJson(
    path.resolve(root),
    file,
    MAX_LIFECYCLE_GUARD_BYTES
  );
  if (result.status === 'missing') return null;
  if (result.status !== 'value' || !validBlocker(result.value)) {
    return invalidArtifactEvidence();
  }
  const blocker = result.value;
  return blocker.session_scope_hash === sessionHash && blocker.turn_id_hash === turnHash
    ? {
        blockers: blocker.blockers,
        missionId: blocker.mission_id,
        workflowRunId: blocker.workflow_run_id
      }
    : null;
}

export async function emergencyRunBlockers(
  root: string,
  artifactDir: string,
  missionId: string,
  workflowRunId: string
): Promise<string[]> {
  const records = await readEmergencyDenials(root, artifactDir);
  const blockers: string[] = [];
  for (const record of records) {
    if (!record) {
      blockers.push('subagent_skill_availability_guard_invalid');
      continue;
    }
    if (record.mission_id === missionId && record.workflow_run_id === workflowRunId) {
      blockers.push(...record.blockers);
    }
  }
  return blockers;
}

function emergencyDenialDir(artifactDir: string): string {
  return path.join(artifactDir, EMERGENCY_DENIAL_DIR);
}

function emergencyDenialPath(artifactDir: string, sessionHash: string, turnHash: string): string {
  return path.join(
    emergencyDenialDir(artifactDir),
    `deny-${sha256(`${sessionHash}:${turnHash}`)}.json`
  );
}

async function persistEmergencyDenial(
  root: string,
  artifactDir: string,
  blocker: SubagentSkillAvailabilityBlocker
): Promise<boolean> {
  const written = await safeWriteJson(
    emergencyDenialPath(artifactDir, blocker.session_scope_hash, blocker.turn_id_hash),
    root,
    blocker
  );
  if (!written) return false;
  return pruneEmergencyDenials(root, artifactDir);
}

async function matchingEmergencyDenial(
  root: string,
  artifactDir: string,
  sessionHash: string,
  turnHash: string
): Promise<MatchingArtifactEvidence | null> {
  const file = emergencyDenialPath(path.resolve(artifactDir), sessionHash, turnHash);
  try {
    const result = await readBoundedConfinedJson(
      path.resolve(root),
      file,
      MAX_LIFECYCLE_GUARD_BYTES
    );
    if (result.status === 'missing') return null;
    if (result.status !== 'value' || !validBlocker(result.value)
      || result.value.session_scope_hash !== sessionHash
      || result.value.turn_id_hash !== turnHash) {
      return invalidArtifactEvidence();
    }
    return {
      blockers: result.value.blockers,
      missionId: result.value.mission_id,
      workflowRunId: result.value.workflow_run_id
    };
  } catch {
    return null;
  }
}

async function clearMatchingEmergencyDenials(
  root: string,
  artifactDir: string,
  threadHash: string
): Promise<boolean> {
  const records = await readEmergencyDenialsWithFiles(root, artifactDir);
  if (records === null) return false;
  let ok = records.every((entry) => Boolean(entry.blocker));
  for (const { file, blocker } of records) {
    if (!blocker || blocker.thread_id_hash !== threadHash) continue;
    try {
      const entry = await inspectConfinedPath(root, file);
      if (entry.leafSymlink || !entry.stat?.isFile() || entry.stat.size > MAX_LIFECYCLE_GUARD_BYTES) {
        ok = false;
        continue;
      }
      await removeManagedPathVerified(root, file);
      if ((await inspectConfinedPath(root, file)).exists) ok = false;
    } catch {
      ok = false;
    }
  }
  return ok;
}

async function pruneEmergencyDenials(root: string, artifactDir: string): Promise<boolean> {
  const dir = emergencyDenialDir(artifactDir);
  // One writer may temporarily create the entry immediately above the retained
  // bound. Admit exactly that transition so it can be pruned back to the hard
  // live-thread limit instead of leaving the directory permanently overflowed.
  const records = await readEmergencyDenialsWithFiles(
    root,
    artifactDir,
    MAX_EMERGENCY_DENIALS + 1
  );
  if (records === null) return false;
  const ordered = records
    .filter((entry): entry is { file: string; blocker: SubagentSkillAvailabilityBlocker } => (
      Boolean(entry.blocker)
    ))
    .sort((left, right) => right.blocker.recorded_at.localeCompare(left.blocker.recorded_at));
  let ok = records.every((entry) => Boolean(entry.blocker));
  for (const entry of ordered.slice(MAX_EMERGENCY_DENIALS)) {
    try {
      await removeManagedPathVerified(root, entry.file);
      if ((await inspectConfinedPath(root, entry.file)).exists) ok = false;
    } catch {
      ok = false;
    }
  }
  const inspected = await inspectConfinedPath(root, dir).catch(() => null);
  return ok && Boolean(inspected?.exists && inspected.stat?.isDirectory() && !inspected.leafSymlink);
}

async function readEmergencyDenials(
  root: string,
  artifactDir: string
): Promise<Array<SubagentSkillAvailabilityBlocker | null>> {
  const records = await readEmergencyDenialsWithFiles(root, artifactDir);
  return records === null ? [null] : records.map((entry) => entry.blocker);
}

async function readEmergencyDenialsWithFiles(
  root: string,
  artifactDir: string,
  maxEntries = MAX_EMERGENCY_DENIALS
): Promise<Array<{ file: string; blocker: SubagentSkillAvailabilityBlocker | null }> | null> {
  const dir = emergencyDenialDir(artifactDir);
  let inspected;
  try {
    inspected = await inspectConfinedPath(root, dir);
  } catch {
    return null;
  }
  if (!inspected.exists) return [];
  if (inspected.leafSymlink || !inspected.stat?.isDirectory()) return null;
  const names = await boundedDirectoryNames(dir, maxEntries);
  if (names === null) return null;
  const records: Array<{ file: string; blocker: SubagentSkillAvailabilityBlocker | null }> = [];
  for (const name of names.filter((item) => /^deny-[a-f0-9]{64}\.json$/.test(item)).sort()) {
    const file = path.join(dir, name);
    const result = await readBoundedConfinedJson(root, file, MAX_LIFECYCLE_GUARD_BYTES);
    records.push({
      file,
      blocker: result.status === 'value' && validBlocker(result.value) ? result.value : null
    });
  }
  return records;
}

function invalidArtifactEvidence(): MatchingArtifactEvidence {
  return {
    blockers: ['subagent_skill_availability_guard_invalid'],
    missionId: null,
    workflowRunId: null
  };
}
