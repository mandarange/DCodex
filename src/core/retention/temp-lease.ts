import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exists, readJson, rmrf, SKS_TEMP_LEASE_FILE } from '../fsx.js';

const TEMP_RETENTION_SCAN_MAX_ENTRIES = 100_000;
const TEMP_RETENTION_SCAN_MAX_DEPTH = 20;

export async function inspectTempPath(target: string) {
  const rootStat = await fs.lstat(target).catch(() => null);
  if (!rootStat || rootStat.isSymbolicLink()) {
    return {
      complete: false,
      latestMtimeMs: 0,
      bytes: 0,
      blockers: [rootStat ? 'temp_path_is_symlink' : 'temp_path_missing_or_unreadable']
    };
  }
  let latestMtimeMs = rootStat.mtimeMs;
  let bytes = rootStat.isFile() ? rootStat.size : 0;
  let entryCount = 0;
  const blockers: string[] = [];
  const stack: Array<{ dir: string; depth: number }> = rootStat.isDirectory()
    ? [{ dir: target, depth: 0 }]
    : [];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: Array<{ name: string }>;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      blockers.push('temp_path_readdir_failed');
      continue;
    }
    for (const entry of entries) {
      entryCount += 1;
      if (entryCount > TEMP_RETENTION_SCAN_MAX_ENTRIES) {
        blockers.push(`temp_path_max_entries_exceeded:${TEMP_RETENTION_SCAN_MAX_ENTRIES}`);
        return { complete: false, latestMtimeMs, bytes, blockers: [...new Set(blockers)] };
      }
      const child = path.join(current.dir, entry.name);
      const stat = await fs.lstat(child).catch(() => null);
      if (!stat) {
        blockers.push('temp_path_stat_failed');
        continue;
      }
      latestMtimeMs = Math.max(latestMtimeMs, stat.mtimeMs);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (current.depth >= TEMP_RETENTION_SCAN_MAX_DEPTH) {
          blockers.push(`temp_path_max_depth_exceeded:${TEMP_RETENTION_SCAN_MAX_DEPTH}`);
        } else {
          stack.push({ dir: child, depth: current.depth + 1 });
        }
        continue;
      }
      if (stat.isFile()) bytes += stat.size;
    }
  }
  return {
    complete: blockers.length === 0,
    latestMtimeMs,
    bytes,
    blockers: [...new Set(blockers)]
  };
}

export function currentProcessOwns(stat: Awaited<ReturnType<typeof fs.lstat>>) {
  if (typeof process.getuid !== 'function') return true;
  return stat.uid === process.getuid();
}

export function sharedTempEntryMatchesProject(entryName: string, projectHash: string) {
  return entryName === `sks-${projectHash}` || entryName.startsWith(`sks-${projectHash}-`);
}

export function activeTempEnvironmentKey(target: string): string | null {
  const resolvedTarget = path.resolve(target);
  for (const key of ['SKS_TMP_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
    const raw = process.env[key];
    if (!raw) continue;
    const activePath = path.resolve(raw);
    if (isWithin(resolvedTarget, activePath)) return key;
  }
  return null;
}

export async function liveTempLease(
  target: string
): Promise<{ path: string; pid: number; kind: string | null } | null> {
  const leasePath = path.join(target, SKS_TEMP_LEASE_FILE);
  const stat = await fs.lstat(leasePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !currentProcessOwns(stat)) return null;
  const lease = await readJson(leasePath, null).catch(() => null);
  const pid = Number(lease?.pid);
  if (lease?.schema !== 'sks.temp-lease.v1' || !processIdAlive(pid)) return null;
  return {
    path: leasePath,
    pid,
    kind: lease?.kind ? String(lease.kind) : null
  };
}

export async function removeDeadCanonicalTestLease(
  base: string,
  target: string,
  targetStat: Awaited<ReturnType<typeof fs.lstat>>,
  dryRun: boolean,
  actions: any[]
) {
  if (!targetStat.isDirectory() || targetStat.isSymbolicLink() || !currentProcessOwns(targetStat)) return false;
  const [realBase, realTarget] = await Promise.all([
    fs.realpath(base).catch(() => null),
    fs.realpath(target).catch(() => null)
  ]);
  if (!realBase || !realTarget || path.dirname(realTarget) !== realBase || !isWithin(realBase, realTarget)) return false;

  const leasePath = path.join(target, SKS_TEMP_LEASE_FILE);
  const leaseLstat = await fs.lstat(leasePath).catch(() => null);
  if (!leaseLstat?.isFile()
    || leaseLstat.isSymbolicLink()
    || !currentProcessOwns(leaseLstat)
    || leaseLstat.size > 4096) return false;

  const leaseHandle = await fs.open(leasePath, 'r').catch(() => null);
  if (!leaseHandle) return false;
  let lease: any = null;
  try {
    const leaseStat = await leaseHandle.stat();
    if (!leaseStat.isFile()
      || !currentProcessOwns(leaseStat)
      || leaseStat.dev !== leaseLstat.dev
      || leaseStat.ino !== leaseLstat.ino) return false;
    lease = JSON.parse(await leaseHandle.readFile({ encoding: 'utf8' }));
  } catch {
    return false;
  } finally {
    await leaseHandle.close().catch(() => undefined);
  }

  const leaseKeys = lease && typeof lease === 'object' && !Array.isArray(lease)
    ? Object.keys(lease).sort()
    : [];
  const pid = Number(lease?.pid);
  if (lease?.schema !== 'sks.temp-lease.v1'
    || lease?.kind !== 'canonical-test-runner'
    || !Number.isSafeInteger(pid)
    || pid <= 0
    || typeof lease?.created_at !== 'string'
    || !Number.isFinite(Date.parse(lease.created_at))
    || leaseKeys.join(',') !== 'created_at,kind,pid,schema'
    || processIdAlive(pid)) return false;

  const currentTargetStat = await fs.lstat(target).catch(() => null);
  if (!currentTargetStat?.isDirectory()
    || currentTargetStat.isSymbolicLink()
    || !currentProcessOwns(currentTargetStat)
    || currentTargetStat.dev !== targetStat.dev
    || currentTargetStat.ino !== targetStat.ino) return false;

  const action = {
    action: 'remove_sks_temp',
    path: target,
    reason: 'dead_canonical_test_lease',
    lease_path: leasePath,
    owner_pid: pid,
    lease_kind: lease.kind
  };
  if (dryRun) {
    actions.push(action);
    return true;
  }

  const quarantine = path.join(realBase, `.sks-retention-quarantine-${process.pid}-${randomUUID()}`);
  try {
    await fs.rename(target, quarantine);
  } catch {
    return false;
  }
  const quarantinedStat = await fs.lstat(quarantine).catch(() => null);
  if (!quarantinedStat
    || quarantinedStat.dev !== targetStat.dev
    || quarantinedStat.ino !== targetStat.ino) {
    if (!(await exists(target))) await fs.rename(quarantine, target).catch(() => undefined);
    return false;
  }
  await rmrf(quarantine);
  actions.push(action);
  return true;
}

function processIdAlive(pid: number) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === 'EPERM';
  }
}

function isWithin(parent: string, candidate: string) {
  const rel = path.relative(path.resolve(parent), path.resolve(candidate));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
