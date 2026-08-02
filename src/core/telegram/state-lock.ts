import fs from 'node:fs/promises';
import { constants as fsConstants, type Dirent } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { assertTestHomeWriteAllowed } from '../fsx.js';

const LOCK_SCHEMA = 'sks.telegram-lock.v1';
const LOCK_MAX_BYTES = 4096;
const LOCK_ATTEMPTS = 200;
const LOCK_RETRY_MS = 25;
const LOCK_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TelegramStateLockPaths {
  readonly stateDir: string;
  readonly stateLockPath: string;
}

interface LockOwner {
  readonly schema: typeof LOCK_SCHEMA;
  readonly pid: number;
  readonly token: string;
  readonly process_start_seconds?: number | null;
}

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly pid: number;
  readonly token: string;
}

interface InspectedLock {
  readonly dev: number;
  readonly ino: number;
  readonly owner: LockOwner;
}

interface LockCandidate {
  readonly path: string;
  readonly identity: LockIdentity;
}

interface ReclaimParticipant extends LockIdentity {
  readonly path: string;
}

export async function withTelegramStateLock<T>(
  paths: TelegramStateLockPaths,
  operation: () => Promise<T>
): Promise<T> {
  const identity = await acquireStateLock(paths);
  try {
    return await operation();
  } finally {
    await releaseStateLock(paths.stateLockPath, identity);
  }
}

async function acquireStateLock(paths: TelegramStateLockPaths): Promise<LockIdentity> {
  assertTestHomeWriteAllowed(paths.stateLockPath);
  const candidate = await createOwnerCandidate(paths.stateDir, '.telegram.lock');
  let published = false;
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      if (await reclaimBarrierExists(paths)) {
        await settleReclaimBarrier(paths);
        await retryDelay(attempt);
        continue;
      }
      try {
        await fs.link(candidate.path, paths.stateLockPath);
        published = true;
        const acquired = await inspectOwnerFile(paths.stateLockPath, 'lock');
        if (!sameIdentity(acquired, candidate.identity)) {
          throw new Error('telegram_state_lock_publish_identity_mismatch');
        }
        if (await reclaimBarrierExists(paths)) {
          await releaseStateLock(paths.stateLockPath, candidate.identity);
          published = false;
          await settleReclaimBarrier(paths);
          await retryDelay(attempt);
          continue;
        }
        await fs.unlink(candidate.path);
        published = false;
        return candidate.identity;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
        const existing = await inspectOwnerFile(paths.stateLockPath, 'lock').catch((inspectionError: unknown) => {
          if (isTransientLockInspection(inspectionError)) return null;
          throw inspectionError;
        });
        if (existing && ownerIsDead(existing.owner)) {
          if (await reclaimDeadStateLock(paths, existing)) continue;
        }
      }
      await retryDelay(attempt);
    }
    throw new Error('telegram_state_lock_timeout');
  } finally {
    await fs.unlink(candidate.path).catch(() => undefined);
    if (published) await releaseStateLock(paths.stateLockPath, candidate.identity);
  }
}

async function retryDelay(attempt: number): Promise<void> {
  if (attempt + 1 >= LOCK_ATTEMPTS) return;
  await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
}

async function reclaimDeadStateLock(paths: TelegramStateLockPaths, expected: InspectedLock): Promise<boolean> {
  const participant = await joinReclaimBarrier(paths);
  try {
    await cleanupDeadParticipants(paths);
    const current = await inspectOwnerFile(paths.stateLockPath, 'lock').catch((error: unknown) => {
      if (isTransientLockInspection(error)) return null;
      throw error;
    });
    if (!current || !sameInspectedLock(current, expected) || !ownerIsDead(current.owner)) return false;
    try {
      await fs.unlink(paths.stateLockPath);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
      throw error;
    }
  } finally {
    await leaveReclaimBarrier(paths, participant);
  }
}

async function settleReclaimBarrier(paths: TelegramStateLockPaths): Promise<void> {
  const participant = await joinReclaimBarrier(paths);
  try {
    await cleanupDeadParticipants(paths);
    const current = await inspectOwnerFile(paths.stateLockPath, 'lock').catch((error: unknown) => {
      if (isTransientLockInspection(error)) return null;
      throw error;
    });
    if (current && ownerIsDead(current.owner)) {
      await fs.unlink(paths.stateLockPath).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
      });
    }
  } finally {
    await leaveReclaimBarrier(paths, participant);
  }
}

async function joinReclaimBarrier(paths: TelegramStateLockPaths): Promise<ReclaimParticipant> {
  const candidate = await createOwnerCandidate(paths.stateDir, '.telegram.reclaim');
  const barrierPath = reclaimBarrierPath(paths);
  const participantPath = path.join(
    barrierPath,
    `.owner.${candidate.identity.pid}.${candidate.identity.token}`
  );
  try {
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      await ensureReclaimBarrier(paths);
      try {
        await fs.link(candidate.path, participantPath);
        const inspected = await inspectOwnerFile(participantPath, 'reclaim');
        if (!sameIdentity(inspected, candidate.identity)) {
          throw new Error('telegram_state_reclaim_participant_identity_mismatch');
        }
        await fs.unlink(candidate.path);
        return { ...candidate.identity, path: participantPath };
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== 'ENOENT' && code !== 'EEXIST' && code !== 'EINVAL') throw error;
      }
      await retryDelay(attempt);
    }
    throw new Error('telegram_state_reclaim_barrier_timeout');
  } finally {
    await fs.unlink(candidate.path).catch(() => undefined);
  }
}

async function leaveReclaimBarrier(
  paths: TelegramStateLockPaths,
  participant: ReclaimParticipant
): Promise<void> {
  await unlinkOwnedFile(participant.path, participant, 'reclaim');
  await cleanupDeadParticipants(paths);
  await fs.rmdir(reclaimBarrierPath(paths)).catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  });
}

async function cleanupDeadParticipants(paths: TelegramStateLockPaths): Promise<void> {
  const barrierPath = reclaimBarrierPath(paths);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(barrierPath, { withFileTypes: true });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error('telegram_state_reclaim_participant_unsafe_type');
    }
    const participantPath = path.join(barrierPath, entry.name);
    const inspected = await inspectOwnerFile(participantPath, 'reclaim').catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
      throw error;
    });
    if (!inspected) continue;
    if (entry.name !== `.owner.${inspected.owner.pid}.${inspected.owner.token}`) {
      throw new Error('telegram_state_reclaim_participant_name_mismatch');
    }
    if (ownerIsDead(inspected.owner)) {
      await unlinkOwnedFile(participantPath, {
        dev: inspected.dev,
        ino: inspected.ino,
        pid: inspected.owner.pid,
        token: inspected.owner.token
      }, 'reclaim');
    }
  }
}

async function ensureReclaimBarrier(paths: TelegramStateLockPaths): Promise<void> {
  const barrierPath = reclaimBarrierPath(paths);
  assertTestHomeWriteAllowed(barrierPath);
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(barrierPath, { mode: 0o700 });
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException | null)?.code !== 'EEXIST') throw error;
    }
    if (await inspectReclaimBarrier(barrierPath)) return;
    await retryDelay(attempt);
  }
  throw new Error('telegram_state_reclaim_barrier_timeout');
}

async function reclaimBarrierExists(paths: TelegramStateLockPaths): Promise<boolean> {
  return inspectReclaimBarrier(reclaimBarrierPath(paths));
}

async function inspectReclaimBarrier(barrierPath: string): Promise<boolean> {
  const pathStat = await fs.lstat(barrierPath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!pathStat) return false;
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error('telegram_state_reclaim_barrier_unsafe_type');
  }
  if ((pathStat.mode & 0o777) !== 0o700) throw new Error('telegram_state_reclaim_barrier_mode_not_0700');
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && pathStat.uid !== expectedUid) {
    throw new Error('telegram_state_reclaim_barrier_owner_mismatch');
  }
  const handle = await fs.open(
    barrierPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
  ).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    throw error;
  });
  if (!handle) return false;
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory()) throw new Error('telegram_state_reclaim_barrier_unsafe_type');
    if ((stat.mode & 0o777) !== 0o700) throw new Error('telegram_state_reclaim_barrier_mode_not_0700');
    if (expectedUid !== null && stat.uid !== expectedUid) {
      throw new Error('telegram_state_reclaim_barrier_owner_mismatch');
    }
    if (stat.dev !== pathStat.dev || stat.ino !== pathStat.ino) return false;
  } finally {
    await handle.close();
  }
  return true;
}

function reclaimBarrierPath(paths: TelegramStateLockPaths): string {
  return `${paths.stateLockPath}.reclaim`;
}

async function createOwnerCandidate(stateDir: string, prefix: string): Promise<LockCandidate> {
  const token = randomUUID();
  const owner: LockOwner = {
    schema: LOCK_SCHEMA,
    pid: process.pid,
    token,
    process_start_seconds: readProcessStartSeconds(process.pid)
  };
  const candidatePath = path.join(stateDir, `${prefix}.${process.pid}.${token}.tmp`);
  assertTestHomeWriteAllowed(candidatePath);
  const handle = await fs.open(
    candidatePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  let closed = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) throw new Error('telegram_state_lock_candidate_unsafe');
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (expectedUid !== null && stat.uid !== expectedUid) {
      throw new Error('telegram_state_lock_candidate_owner_mismatch');
    }
    await handle.close();
    closed = true;
    return { path: candidatePath, identity: { dev: stat.dev, ino: stat.ino, pid: process.pid, token } };
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await fs.unlink(candidatePath).catch(() => undefined);
    throw error;
  }
}

async function inspectOwnerFile(file: string, kind: 'lock' | 'reclaim'): Promise<InspectedLock> {
  const prefix = kind === 'lock' ? 'telegram_state_lock' : 'telegram_state_reclaim_participant';
  const pathStat = await fs.lstat(file);
  if (pathStat.isSymbolicLink() || !pathStat.isFile()) throw new Error(`${prefix}_unsafe_type`);
  if ((pathStat.mode & 0o777) !== 0o600) throw new Error(`${prefix}_mode_not_0600`);
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && pathStat.uid !== expectedUid) throw new Error(`${prefix}_owner_mismatch`);
  if (pathStat.size <= 0 || pathStat.size > LOCK_MAX_BYTES) throw new Error(`${prefix}_owner_record_invalid`);
  const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== pathStat.dev || before.ino !== pathStat.ino
      || (before.mode & 0o777) !== 0o600 || (expectedUid !== null && before.uid !== expectedUid)) {
      throw new Error(`${prefix}_identity_mismatch`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const pathAfter = await fs.lstat(file);
    if (bytes.length <= 0 || bytes.length > LOCK_MAX_BYTES || after.dev !== before.dev
      || after.ino !== before.ino || after.size !== before.size || pathAfter.dev !== after.dev
      || pathAfter.ino !== after.ino || pathAfter.isSymbolicLink() || !pathAfter.isFile()
      || (pathAfter.mode & 0o777) !== 0o600 || (expectedUid !== null && pathAfter.uid !== expectedUid)) {
      throw new Error(`${prefix}_identity_mismatch`);
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch { throw new Error(`${prefix}_owner_record_invalid`); }
    if (!isLockOwner(parsed)) throw new Error(`${prefix}_owner_record_invalid`);
    return { dev: after.dev, ino: after.ino, owner: parsed };
  } finally {
    await handle.close();
  }
}

async function unlinkOwnedFile(
  file: string,
  identity: LockIdentity,
  kind: 'lock' | 'reclaim'
): Promise<boolean> {
  const current = await inspectOwnerFile(file, kind).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
      || (kind === 'lock' && isTransientLockInspection(error))) return null;
    throw error;
  });
  if (!current || !sameIdentity(current, identity)) return false;
  try {
    await fs.unlink(file);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return false;
    throw error;
  }
}

async function releaseStateLock(lockPath: string, identity: LockIdentity): Promise<boolean> {
  if (identity.pid !== process.pid) return false;
  return unlinkOwnedFile(lockPath, identity, 'lock');
}

function sameIdentity(current: InspectedLock, expected: LockIdentity): boolean {
  return current.dev === expected.dev && current.ino === expected.ino
    && current.owner.pid === expected.pid && current.owner.token === expected.token;
}

function sameInspectedLock(left: InspectedLock, right: InspectedLock): boolean {
  return left.dev === right.dev && left.ino === right.ino
    && left.owner.pid === right.owner.pid && left.owner.token === right.owner.token;
}

function ownerIsDead(owner: LockOwner): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ESRCH') return true;
    if (code !== 'EPERM') return false;
  }
  if (owner.process_start_seconds === undefined || owner.process_start_seconds === null) return false;
  const observed = readProcessStartSeconds(owner.pid);
  return observed !== null && observed !== owner.process_start_seconds;
}

function isTransientLockInspection(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
    || (error instanceof Error && error.message === 'telegram_state_lock_identity_mismatch');
}

function readProcessStartSeconds(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === 'win32') return null;
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8', timeout: 1_000, maxBuffer: 4_096
  });
  if (result.status !== 0) return null;
  const milliseconds = Date.parse(String(result.stdout || '').trim().replace(/\s+/g, ' '));
  return Number.isFinite(milliseconds) ? Math.floor(milliseconds / 1_000) : null;
}

function isLockOwner(value: unknown): value is LockOwner {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.some((key) => !['schema', 'pid', 'token', 'process_start_seconds'].includes(key))) return false;
  return keys.includes('schema') && keys.includes('pid') && keys.includes('token')
    && value.schema === LOCK_SCHEMA
    && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number(value.pid) <= 2_147_483_647
    && typeof value.token === 'string' && LOCK_TOKEN_PATTERN.test(value.token)
    && (value.process_start_seconds === undefined || value.process_start_seconds === null
      || (Number.isSafeInteger(value.process_start_seconds) && Number(value.process_start_seconds) > 0));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
