import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, nowIso, randomId, readJson } from '../fsx.js';
import { guardedRm, guardContextForRoute } from '../safety/mutation-guard.js';
import { CONFIRMATION_REQUIRED, REQUESTED_SCOPE_CONTRACT_SCHEMA, type RequestedScopeContract } from '../safety/requested-scope-contract.js';

export interface FileLockInput {
  lockPath: string;
  timeoutMs: number;
  staleMs: number;
}

export interface FileLockOwnerSnapshot {
  schema: 'sks.file-lock-owner.v1';
  owner: string;
  pid: number;
  hostname: string;
  acquired_at: string;
  heartbeat_at: string;
  stale_ms: number;
  protected_pids?: number[];
}

export interface FileLockLease {
  readonly owner: string;
  readonly pid: number;
  readonly recovered: boolean;
  protectPid(pid: number): Promise<void>;
}

export type TryFileLockResult<T> =
  | { acquired: true; recovered: boolean; value: T }
  | { acquired: false; owner: FileLockOwnerSnapshot | null };

interface HeldFileLock {
  owner: string;
  protectedPids: Set<number>;
  recovered: boolean;
  acquiredAt: string;
}

const HEARTBEAT_MARGIN = 3;

export async function withFileLock<T>(input: FileLockInput, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.resolve(input.lockPath);
  const timeoutMs = Math.max(1, input.timeoutMs);
  const staleMs = Math.max(1, input.staleMs);
  const started = Date.now();
  await ensureDir(path.dirname(lockPath));

  let held: HeldFileLock | null = null;
  while (true) {
    held = await tryAcquireFileLock(lockPath, staleMs);
    if (held) {
      break;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`file_lock_timeout:${lockPath}`);
    }
    await sleep(jitterDelay());
  }

  return holdFileLock(lockPath, staleMs, held, async () => fn());
}

export async function tryWithFileLock<T>(
  input: Omit<FileLockInput, 'timeoutMs'>,
  fn: (lease: FileLockLease) => Promise<T>
): Promise<TryFileLockResult<T>> {
  const lockPath = path.resolve(input.lockPath);
  const staleMs = Math.max(1, input.staleMs);
  await ensureDir(path.dirname(lockPath));
  const held = await tryAcquireFileLock(lockPath, staleMs);
  if (!held) {
    return {
      acquired: false,
      owner: await readJson<FileLockOwnerSnapshot | null>(path.join(lockPath, 'owner.json'), null)
    };
  }
  const value = await holdFileLock(lockPath, staleMs, held, fn);
  return { acquired: true, recovered: held.recovered, value };
}

async function tryAcquireFileLock(lockPath: string, staleMs: number): Promise<HeldFileLock | null> {
  let recovered = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = `${process.pid}-${randomId(8)}`;
    const protectedPids = new Set<number>();
    try {
      await fsp.mkdir(lockPath);
      const acquiredAt = nowIso();
      await writeOwnerFile(lockPath, owner, staleMs, protectedPids, acquiredAt);
      return { owner, protectedPids, recovered, acquiredAt };
    } catch (err: unknown) {
      if (errorCode(err) !== 'EEXIST') throw err;
      if (attempt > 0) return null;
      recovered = await recoverStaleLock(lockPath, staleMs);
      if (!recovered) return null;
    }
  }
  return null;
}

async function holdFileLock<T>(
  lockPath: string,
  staleMs: number,
  held: HeldFileLock,
  fn: (lease: FileLockLease) => Promise<T>
): Promise<T> {
  const lease: FileLockLease = {
    owner: held.owner,
    pid: process.pid,
    recovered: held.recovered,
    protectPid: async (pid: number) => {
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
        throw new Error(`file_lock_invalid_protected_pid:${String(pid)}`);
      }
      held.protectedPids.add(pid);
      await writeOwnerFile(lockPath, held.owner, staleMs, held.protectedPids, held.acquiredAt);
    }
  };

  // Touch the owner file's heartbeat_at while we hold the lock so a stale
  // waiter never mistakes genuinely slow-but-alive work for an abandoned
  // lock (20차 P1-1) — recoverStaleLock only reclaims when both the
  // heartbeat is old AND the owning pid is actually dead.
  const heartbeat = setInterval(() => {
    /* intentional: a missed heartbeat tick just gets retried next interval; only matters if it stays stale for the full staleMs window */
    writeOwnerFile(lockPath, held.owner, staleMs, held.protectedPids, held.acquiredAt).catch(() => undefined);
  }, Math.max(250, Math.floor(staleMs / HEARTBEAT_MARGIN)));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  try {
    return await fn(lease);
  } finally {
    clearInterval(heartbeat);
    /* intentional: best-effort release — if it fails, the lock will still be reclaimed once it goes stale (owner-token/pid checked, never blind rm) */
    await releaseIfOwned(lockPath, held.owner).catch(() => undefined);
  }
}

async function writeOwnerFile(
  lockPath: string,
  owner: string,
  staleMs: number,
  protectedPids: ReadonlySet<number>,
  acquiredAt: string
): Promise<void> {
  await writeOwnerAtomic(path.join(lockPath, 'owner.json'), {
    schema: 'sks.file-lock-owner.v1',
    owner,
    pid: process.pid,
    hostname: os.hostname(),
    acquired_at: acquiredAt,
    heartbeat_at: nowIso(),
    stale_ms: staleMs,
    ...(protectedPids.size > 0 ? { protected_pids: [...protectedPids].sort((a, b) => a - b) } : {})
  } satisfies FileLockOwnerSnapshot);
}

// Owner records are rewritten on every heartbeat, so they must stay cheap:
// tmp+rename keeps reads atomic, but we skip fsync and the content-compare
// read that writeJsonAtomic performs. Crash durability is already covered by
// recoverStaleLock — a missing/corrupt owner file falls back to directory
// mtime staleness, and the lock dir itself is created via bare mkdir (no
// parent fsync), so fsyncing owner.json would add cost with no extra
// guarantee. acquired_at is held in memory by the holder, which is the only
// writer of its own owner file, so no disk read is needed to preserve it.
async function writeOwnerAtomic(file: string, data: FileLockOwnerSnapshot): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomId(6)}.tmp`;
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close().catch(() => undefined);
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Reclaims an abandoned lock without ever directly deleting a lock another
// process might still legitimately hold. A dead-or-expired lock is renamed
// (a single atomic syscall) into a quarantine directory first; only the one
// waiter whose rename succeeds proceeds to retry acquisition, so two
// concurrent waiters can never both believe they reclaimed the same lock
// (the previous mtime-only check + direct rm -rf allowed exactly that).
async function recoverStaleLock(lockPath: string, requestedStaleMs: number): Promise<boolean> {
  const ownerPath = path.join(lockPath, 'owner.json');
  const info = await readJson<FileLockOwnerSnapshot | null>(ownerPath, null);
  let stale: boolean;
  if (!info || typeof info.pid !== 'number' || !info.heartbeat_at) {
    // No readable owner record: fall back to directory mtime so a lock left
    // over from before this format existed can still be reclaimed.
    stale = await isDirMtimeStale(lockPath, Math.max(1, requestedStaleMs));
  } else {
    const heartbeatAgeMs = Date.now() - Date.parse(info.heartbeat_at);
    const effectiveStaleMs = Math.min(
      Math.max(1, requestedStaleMs),
      Math.max(1, Number(info.stale_ms) || requestedStaleMs)
    );
    stale = Number.isFinite(heartbeatAgeMs)
      && heartbeatAgeMs > effectiveStaleMs
      && !ownerHasLivePid(info);
  }
  if (!stale) return false;
  const quarantinePath = `${lockPath}.stale-${Date.now()}-${randomId(6)}`;
  try {
    await fsp.rename(lockPath, quarantinePath);
  } catch {
    // Another waiter already reclaimed (or the holder released) it first.
    return false;
  }
  /* intentional: the quarantine rename already reclaimed the lock name; this is just disk cleanup of the orphaned directory and can be swept up later if it fails */
  await guardedRm(guardContextForRoute(process.cwd(), lockScopeContract(quarantinePath), 'remove quarantined stale SKS file lock directory'), quarantinePath, {
    recursive: true,
    force: true
  }).catch(() => undefined);
  return true;
}

async function releaseIfOwned(lockPath: string, owner: string): Promise<void> {
  const info = await readJson<FileLockOwnerSnapshot | null>(path.join(lockPath, 'owner.json'), null);
  // If the owner record is missing or names a different owner, this lock was
  // already reclaimed as stale out from under us — removing it now would
  // delete whoever holds it legitimately next.
  if (info && info.owner !== owner) return;
  await removeLockDir(lockPath);
}

function ownerHasLivePid(info: FileLockOwnerSnapshot): boolean {
  if (isPidAlive(info.pid, info.hostname)) return true;
  return Array.isArray(info.protected_pids)
    && info.protected_pids.some((pid) => Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid, info.hostname));
}

async function removeLockDir(lockPath: string): Promise<void> {
  await guardedRm(guardContextForRoute(process.cwd(), lockScopeContract(lockPath), 'remove SKS file lock directory'), lockPath, {
    recursive: true,
    force: true
  });
}

function isPidAlive(pid: number, hostname: string): boolean {
  // A pid recorded on a different host can't be liveness-checked locally;
  // treat it as alive (never force-reclaim across hosts from mtime alone).
  if (hostname && hostname !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return errorCode(err) !== 'ESRCH';
  }
}

async function isDirMtimeStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stat = await fsp.stat(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function lockScopeContract(lockPath: string): RequestedScopeContract {
  const resolved = path.resolve(lockPath);
  return {
    schema: REQUESTED_SCOPE_CONTRACT_SCHEMA,
    route: 'internal:file-lock',
    user_request: 'Remove only the current SKS file-lock directory.',
    allowed_mutations: {
      project_files: true,
      global_codex_config: false,
      codex_app_process: false,
      codex_lb_auth: false,
      package_install: false,
      zellij_install: false,
      network: false,
      skill_snapshot_promotion: false
    },
    allowed_paths: [resolved, `${resolved}/**`],
    forbidden_paths: ['~/.codex/config.toml', '/Applications/**'],
    requires_explicit_confirmation: [...CONFIRMATION_REQUIRED]
  };
}

function jitterDelay(): number {
  return 15 + Math.floor(Math.random() * 45);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
}
