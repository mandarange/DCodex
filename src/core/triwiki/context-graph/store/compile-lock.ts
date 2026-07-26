/**
 * Compile lock for the Context Graph.
 *
 * Two compilers may run at once — a manual refresh and a preflight, say — but
 * only one may commit a snapshot. This reuses the repository's file lock
 * (PID + heartbeat based stale recovery, quarantine-rename reclaim) rather than
 * introducing a second locking dialect; the loser is told the lock is held
 * instead of silently writing a second snapshot on top of the first.
 */
import { tryWithFileLock, type FileLockOwnerSnapshot } from '../../../locks/file-lock.js';
import { contextGraphLockPath } from '../paths.js';

/** A compile that has not touched its heartbeat for this long is treated as abandoned. */
export const CONTEXT_GRAPH_LOCK_STALE_MS = 120_000;

export interface ContextGraphLockHolder {
  pid: number;
  acquiredAt: string;
  heartbeatAt: string;
}

export type ContextGraphLockOutcome<T> =
  | { acquired: true; recovered: boolean; value: T }
  | { acquired: false; recovered: false; holder: ContextGraphLockHolder | null };

function holderOf(owner: FileLockOwnerSnapshot | null): ContextGraphLockHolder | null {
  if (!owner || typeof owner.pid !== 'number') return null;
  // Only pid/timestamps are surfaced: hostname and owner token are machine
  // identity and never belong in a caller-visible (or loggable) payload.
  return {
    pid: owner.pid,
    acquiredAt: String(owner.acquired_at ?? ''),
    heartbeatAt: String(owner.heartbeat_at ?? '')
  };
}

export interface ContextGraphLockOptions {
  staleMs?: number;
}

/**
 * Run `fn` while holding the compile lock. Never blocks: a contended compile
 * reports `acquired: false` so the caller can surface it instead of queueing.
 */
export async function withContextGraphCompileLock<T>(
  root: string,
  fn: () => Promise<T>,
  options: ContextGraphLockOptions = {}
): Promise<ContextGraphLockOutcome<T>> {
  const result = await tryWithFileLock(
    {
      lockPath: contextGraphLockPath(root),
      staleMs: Math.max(1, options.staleMs ?? CONTEXT_GRAPH_LOCK_STALE_MS)
    },
    async () => fn()
  );
  if (!result.acquired) return { acquired: false, recovered: false, holder: holderOf(result.owner) };
  return { acquired: true, recovered: result.recovered, value: result.value };
}
