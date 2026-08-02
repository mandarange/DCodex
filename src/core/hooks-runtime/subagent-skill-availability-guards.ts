import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256, writeJsonAtomic } from '../fsx.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  removeManagedPathVerified
} from '../managed-path-safety.js';
import {
  ADMISSION_SCHEMA,
  GUARD_DIR,
  MAX_GUARD_DIRECTORY_ENTRIES,
  MAX_LIFECYCLE_GUARD_BYTES,
  MAX_LIFECYCLE_THREADS,
  MAX_SUBAGENT_PLAN_BYTES,
  SUBAGENT_ADMISSION_BLOCKER_RE,
  SubagentSkillAvailabilityGuardError,
  type BoundedJsonResult,
  type GuardRoot,
  type GuardRunBinding,
  type SubagentSkillAvailabilityAdmission
} from './subagent-skill-availability-contract.js';

const MAX_OFFICIAL_TRANSCRIPT_FIRST_LINE_BYTES = 64 * 1024;
const MAX_OFFICIAL_TRANSCRIPT_DISCOVERY_ENTRIES = 4_096;
const MAX_OFFICIAL_TRANSCRIPT_DISCOVERY_DEPTH = 4;

function rootGuardDir(root: string): string {
  return path.join(root, '.sneakoscope', 'guards', GUARD_DIR);
}

function artifactGuardDir(artifactDir: string): string {
  return path.join(artifactDir, GUARD_DIR);
}

function homeGuardDir(home: string, canonicalRoot: string): string {
  return path.join(home, '.sneakoscope', 'guards', GUARD_DIR, sha256(canonicalRoot));
}

export function threadGuardPath(guardRoot: string, threadHash: string): string {
  return path.join(guardRoot, `thread-${threadHash}.json`);
}

export function turnGuardPath(guardRoot: string, sessionHash: string, turnHash: string): string {
  return path.join(guardRoot, `turn-${sha256(`${sessionHash}:${turnHash}`)}.json`);
}

function validAdmission(value: any): value is SubagentSkillAvailabilityAdmission {
  const blockers = Array.isArray(value?.blockers) ? value.blockers : null;
  return value?.schema === ADMISSION_SCHEMA
    && ['allowed', 'blocked'].includes(String(value?.status || ''))
    && (value?.mission_id === null || typeof value?.mission_id === 'string')
    && (value?.workflow_run_id === null || typeof value?.workflow_run_id === 'string')
    && /^[a-f0-9]{64}$/.test(String(value?.thread_id_hash || ''))
    && /^[a-f0-9]{64}$/.test(String(value?.session_scope_hash || ''))
    && /^[a-f0-9]{64}$/.test(String(value?.turn_id_hash || ''))
    && blockers !== null
    && (value.status === 'allowed'
      ? blockers.length === 0
      : blockers.length > 0 && blockers.every((item: unknown) => (
        SUBAGENT_ADMISSION_BLOCKER_RE.test(String(item || ''))
      )));
}

export async function readConfinedJson(boundary: string, file: string): Promise<any | null> {
  const result = await readBoundedConfinedJson(
    path.resolve(boundary),
    path.resolve(file),
    MAX_SUBAGENT_PLAN_BYTES
  );
  return result.status === 'value' ? result.value : null;
}

export async function admissionGuardRoots(
  root: string,
  artifactDir?: string | null,
  binding?: GuardRunBinding | null
): Promise<GuardRoot[]> {
  const projectRoot = path.resolve(root);
  const canonicalRoot = await fsp.realpath(projectRoot);
  const home = path.resolve(process.env.HOME || os.homedir());
  const roots: GuardRoot[] = [
    { root: rootGuardDir(projectRoot), boundary: projectRoot, missionIndependent: true },
    ...(artifactDir ? [{
      root: artifactGuardDir(path.resolve(artifactDir)),
      boundary: projectRoot,
      missionIndependent: false
    }] : []),
    { root: homeGuardDir(home, canonicalRoot), boundary: home, missionIndependent: true }
  ];
  const missionId = String(binding?.missionId || '').trim();
  const workflowRunId = String(binding?.workflowRunId || '').trim();
  const runPartition = missionId && workflowRunId
    ? `run-${sha256(JSON.stringify([missionId, workflowRunId]))}`
    : null;
  const unique = new Map<string, GuardRoot>();
  for (const entry of roots) {
    const previous = unique.get(entry.root);
    if (!previous || (!previous.missionIndependent && entry.missionIndependent)) {
      unique.set(entry.root, {
        ...entry,
        root: runPartition ? path.join(entry.root, runPartition) : entry.root
      });
    }
  }
  return [...unique.values()];
}

export async function admissionGuardRootsWithLegacyMirrors(
  root: string,
  artifactDir: string | null | undefined,
  binding: GuardRunBinding
): Promise<{ scoped: GuardRoot[]; legacy: GuardRoot[] }> {
  const [scoped, legacy] = await Promise.all([
    admissionGuardRoots(root, artifactDir, binding),
    admissionGuardRoots(root, artifactDir)
  ]);
  return { scoped, legacy };
}

export async function writeAdmissionPair(
  root: GuardRoot,
  admission: SubagentSkillAvailabilityAdmission
): Promise<boolean> {
  const [threadWrite, turnWrite] = await Promise.all([
    safeWriteJson(threadGuardPath(root.root, admission.thread_id_hash), root.boundary, admission),
    safeWriteJson(
      turnGuardPath(root.root, admission.session_scope_hash, admission.turn_id_hash),
      root.boundary,
      admission
    )
  ]);
  return threadWrite && turnWrite;
}

export async function readAdmissionPair(
  root: GuardRoot,
  expectedThreadHash: string | null,
  expectedSessionHash: string,
  expectedTurnHash: string
): Promise<SubagentSkillAvailabilityAdmission | null> {
  const turnFile = turnGuardPath(root.root, expectedSessionHash, expectedTurnHash);
  const turnAdmission = await readAdmission(turnFile, root.boundary);
  if (expectedThreadHash) {
    const threadFile = threadGuardPath(root.root, expectedThreadHash);
    const threadAdmission = await readAdmission(threadFile, root.boundary);
    if (!turnAdmission && !threadAdmission) return null;
    if (!turnAdmission && threadAdmission) {
      if (threadAdmission.thread_id_hash !== expectedThreadHash) throw invalidGuard(true);
      const currentTurnPartiallyPersisted = threadAdmission.session_scope_hash === expectedSessionHash
        && threadAdmission.turn_id_hash === expectedTurnHash;
      if (currentTurnPartiallyPersisted) throw invalidGuard(true);
      // A reused official thread can begin a later turn without another
      // SubagentStart. Its stable thread guard may therefore still identify
      // the prior turn while the new turn has no pair yet. Treat that exact
      // shape as missing admission so the bounded active-run recovery path can
      // re-resolve the managed skills and publish a fresh pair.
      return null;
    }
    if (turnAdmission && !threadAdmission) throw invalidGuard(true);
    if (!turnAdmission || !threadAdmission) return null;
    validateAdmissionBinding(turnAdmission, expectedThreadHash, expectedSessionHash, expectedTurnHash);
    validateAdmissionBinding(threadAdmission, expectedThreadHash, expectedSessionHash, expectedTurnHash);
    if (admissionFingerprint(turnAdmission) !== admissionFingerprint(threadAdmission)) {
      throw invalidGuard(true);
    }
    return turnAdmission;
  }
  if (!turnAdmission) return null;
  validateAdmissionBinding(turnAdmission, turnAdmission.thread_id_hash, expectedSessionHash, expectedTurnHash);
  let threadAdmission: SubagentSkillAvailabilityAdmission | null;
  try {
    threadAdmission = await readAdmission(
      threadGuardPath(root.root, turnAdmission.thread_id_hash),
      root.boundary
    );
  } catch {
    throw invalidGuard(true);
  }
  if (!threadAdmission || admissionFingerprint(turnAdmission) !== admissionFingerprint(threadAdmission)) {
    throw invalidGuard(true);
  }
  return turnAdmission;
}

export async function readAdmissionForThread(
  root: GuardRoot,
  expectedThreadHash: string
): Promise<SubagentSkillAvailabilityAdmission | null> {
  const admission = await readAdmission(
    threadGuardPath(root.root, expectedThreadHash),
    root.boundary
  );
  if (!admission) return null;
  if (admission.thread_id_hash !== expectedThreadHash) throw invalidGuard(true);
  return admission;
}

async function readAdmission(
  file: string,
  boundary: string
): Promise<SubagentSkillAvailabilityAdmission | null> {
  const result = await readBoundedConfinedJson(boundary, file, MAX_LIFECYCLE_GUARD_BYTES);
  if (result.status === 'missing') return null;
  if (result.status === 'invalid') throw invalidGuard(result.childEvidence);
  if (!validAdmission(result.value)) throw invalidGuard(true);
  return result.value;
}

export async function blockedRunAdmissions(
  guardRoot: GuardRoot,
  missionId: string,
  workflowRunId: string
): Promise<string[]> {
  let inspected;
  try {
    inspected = await inspectConfinedPath(guardRoot.boundary, guardRoot.root);
  } catch {
    return ['subagent_skill_availability_guard_invalid'];
  }
  if (!inspected.exists) return [];
  if (inspected.leafSymlink || !inspected.stat?.isDirectory()) {
    return ['subagent_skill_availability_guard_invalid'];
  }
  const names = await boundedDirectoryNames(guardRoot.root, MAX_GUARD_DIRECTORY_ENTRIES);
  if (names === null) return ['subagent_skill_availability_guard_invalid'];
  const blockers: string[] = [];
  const threadNames = names.filter((item) => /^thread-[a-f0-9]{64}\.json$/.test(item)).sort();
  if (threadNames.length > MAX_LIFECYCLE_THREADS) {
    return ['subagent_skill_availability_guard_invalid'];
  }
  for (const name of threadNames) {
    let admission: SubagentSkillAvailabilityAdmission | null;
    try {
      admission = await readAdmission(path.join(guardRoot.root, name), guardRoot.boundary);
    } catch {
      blockers.push('subagent_skill_availability_guard_invalid');
      continue;
    }
    if (!admission
      || admission.mission_id !== missionId
      || admission.workflow_run_id !== workflowRunId
      || admission.status !== 'blocked') continue;
    blockers.push(...admission.blockers);
  }
  return blockers;
}

function validateAdmissionBinding(
  admission: SubagentSkillAvailabilityAdmission,
  expectedThreadHash: string,
  expectedSessionHash: string,
  expectedTurnHash: string
) {
  if (admission.thread_id_hash !== expectedThreadHash
    || admission.session_scope_hash !== expectedSessionHash
    || admission.turn_id_hash !== expectedTurnHash) {
    throw invalidGuard(true);
  }
}

export function invalidGuard(childEvidence: boolean): SubagentSkillAvailabilityGuardError {
  return new SubagentSkillAvailabilityGuardError(childEvidence);
}

export function admissionFingerprint(admission: SubagentSkillAvailabilityAdmission): string {
  return sha256(JSON.stringify([
    admission.schema,
    admission.status,
    admission.mission_id,
    admission.workflow_run_id,
    admission.thread_id_hash,
    admission.session_scope_hash,
    admission.turn_id_hash,
    admission.blockers,
    admission.recorded_at
  ]));
}

export async function safeWriteJson(file: string, boundary: string, value: unknown): Promise<boolean> {
  try {
    if (Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8') > MAX_LIFECYCLE_GUARD_BYTES) {
      return false;
    }
    await ensureConfinedDirectory(boundary, path.dirname(file));
    const before = await inspectConfinedPath(boundary, file);
    if (before.exists && (before.leafSymlink || !before.stat?.isFile())) return false;
    await writeJsonAtomic(file, value);
    const after = await inspectConfinedPath(boundary, file);
    return after.exists && !after.leafSymlink && Boolean(after.stat?.isFile());
  } catch {
    return false;
  }
}

export async function safeRemoveGuard(file: string, boundary: string): Promise<void> {
  try {
    const inspected = await inspectConfinedPath(boundary, file);
    if (!inspected.exists) return;
    if (inspected.leafSymlink || !inspected.stat?.isFile()) return;
    await removeManagedPathVerified(boundary, file);
  } catch {
    return;
  }
}

export async function boundedDirectoryNames(
  directory: string,
  maxEntries = MAX_GUARD_DIRECTORY_ENTRIES
): Promise<string[] | null> {
  let handle;
  try {
    handle = await fsp.opendir(directory);
    const names: string[] = [];
    for await (const entry of handle) {
      names.push(entry.name);
      if (names.length > maxEntries) return null;
    }
    return names.sort((left, right) => left.localeCompare(right));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readBoundedConfinedJson(
  boundary: string,
  file: string,
  maxBytes: number
): Promise<BoundedJsonResult> {
  const absoluteBoundary = path.resolve(boundary);
  const absoluteFile = path.resolve(file);
  let childEvidence = false;
  try {
    const inspected = await inspectConfinedPath(absoluteBoundary, absoluteFile);
    if (!inspected.exists) return { status: 'missing' };
    childEvidence = true;
    if (inspected.leafSymlink || !inspected.stat?.isFile() || inspected.stat.size > maxBytes) {
      return { status: 'invalid', childEvidence };
    }
    const handle = await fsp.open(absoluteFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) return { status: 'invalid', childEvidence };
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes || bytesRead !== stat.size) {
        return { status: 'invalid', childEvidence };
      }
      return { status: 'value', value: JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) };
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch {
    return { status: 'invalid', childEvidence };
  }
}

export function preToolBlockReason(blockers: readonly string[]): string {
  return `SKS blocked this child tool call because managed skill availability failed (${blockers.join(', ')}). Return the blocker to the root parent without using tools.`;
}

export function boundedAgentThreadId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  if (!candidate
    || Buffer.byteLength(candidate, 'utf8') > 512
    || /[\u0000-\u001f\u007f]/.test(candidate)) return null;
  return candidate;
}

export async function officialSubagentThreadIdFromTranscript(value: unknown): Promise<string | null> {
  const file = String(value || '').trim();
  if (!file) return null;
  const sessionsRoot = path.resolve(
    process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'sessions')
      : path.join(process.env.HOME || os.homedir(), '.codex', 'sessions')
  );
  const [sessionsReal, fileReal] = await Promise.all([
    fsp.realpath(sessionsRoot).catch(() => null),
    fsp.realpath(file).catch(() => null)
  ]);
  if (!sessionsReal || !fileReal || !pathIsInside(sessionsReal, fileReal)) return null;
  const stat = await fsp.lstat(file).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
  const handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const statAfterOpen = await handle.stat();
    if (!statAfterOpen.isFile() || statAfterOpen.size < 1) return null;
    const buffer = Buffer.alloc(MAX_OFFICIAL_TRANSCRIPT_FIRST_LINE_BYTES + 1);
    const read = await handle.read(buffer, 0, buffer.length, 0);
    if (read.bytesRead < 1) return null;
    const bytes = buffer.subarray(0, read.bytesRead);
    const newline = bytes.indexOf(0x0a);
    if (newline < 0 && statAfterOpen.size > read.bytesRead) return null;
    const firstLine = newline >= 0 ? bytes.subarray(0, newline) : bytes;
    if (firstLine.byteLength > MAX_OFFICIAL_TRANSCRIPT_FIRST_LINE_BYTES) return null;
    const line = firstLine.toString('utf8').replace(/\r$/, '').trim();
    if (!line) return null;
    const row = JSON.parse(line);
    const source = row?.payload?.source?.subagent;
    const threadSpawn = source?.thread_spawn;
    if (row?.type !== 'session_meta' || !source || typeof source !== 'object'
      || !threadSpawn || typeof threadSpawn !== 'object') return null;
    return String(row?.payload?.id || row?.payload?.session_id || '').trim() || null;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function officialSubagentThreadIdFromSessions(
  claimedThreadId: unknown
): Promise<string | null> {
  const threadId = boundedAgentThreadId(claimedThreadId);
  if (!threadId) return null;
  const sessionsRoot = path.resolve(
    process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'sessions')
      : path.join(process.env.HOME || os.homedir(), '.codex', 'sessions')
  );
  const sessionsReal = await fsp.realpath(sessionsRoot).catch(() => null);
  if (!sessionsReal) return null;
  const suffix = `-${threadId}.jsonl`;
  let inspectedEntries = 0;
  const matches: string[] = [];

  const visit = async (directory: string, depth: number): Promise<boolean> => {
    let handle;
    try {
      handle = await fsp.opendir(directory);
      for await (const entry of handle) {
        inspectedEntries += 1;
        if (inspectedEntries > MAX_OFFICIAL_TRANSCRIPT_DISCOVERY_ENTRIES) return false;
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (depth >= MAX_OFFICIAL_TRANSCRIPT_DISCOVERY_DEPTH) continue;
          if (!await visit(candidate, depth + 1)) return false;
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
        const resolvedThreadId = await officialSubagentThreadIdFromTranscript(candidate);
        if (resolvedThreadId !== threadId) continue;
        matches.push(candidate);
        if (matches.length > 1) return false;
      }
      return true;
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  };

  if (!await visit(sessionsReal, 0) || matches.length !== 1) return null;
  return threadId;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return Boolean(relative)
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}
