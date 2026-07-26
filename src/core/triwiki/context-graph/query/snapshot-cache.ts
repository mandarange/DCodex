/**
 * In-process snapshot/index cache keyed by (workspace, snapshotHash).
 *
 * A compiled snapshot on a real repository is tens of megabytes; parsing it and
 * rebuilding its adjacency on every query would dominate the latency budget. The
 * cache holds the *built index*, which already owns the parsed snapshot, so a
 * repeat query in the same process does no JSON work at all.
 *
 * Two rules keep memory bounded. Storing a new hash for a workspace evicts that
 * workspace's previous generation immediately, so a rebuild never leaves the old
 * snapshot alive; and the whole cache is a small LRU, so a process that touches
 * several workspaces cannot accumulate them.
 *
 * The key never stores an absolute path — the workspace is identified by a short
 * digest, so nothing here can leak a home directory into a log or a dump.
 */
import path from 'node:path';
import type { ContextGraphIndex } from '../graph-index.js';
import { shortDigest } from '../ids.js';

/** Distinct workspaces kept resident at once. Deliberately small: each entry owns a full snapshot. */
export const CONTEXT_GRAPH_SNAPSHOT_CACHE_MAX_ENTRIES = 2;

interface CacheEntry {
  readonly workspaceKey: string;
  readonly snapshotHash: string;
  readonly index: ContextGraphIndex;
  order: number;
}

export interface ContextGraphSnapshotCacheStats {
  readonly entries: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  /** hits / (hits + misses); 0 when nothing has been looked up yet. */
  readonly hitRate: number;
}

const entries = new Map<string, CacheEntry>();
let hits = 0;
let misses = 0;
let evictions = 0;
let clock = 0;

export function contextGraphWorkspaceKey(root: string): string {
  return shortDigest(path.resolve(String(root ?? '')));
}

function cacheKey(workspaceKey: string, snapshotHash: string): string {
  return `${workspaceKey}:${snapshotHash}`;
}

export function getCachedContextGraphIndex(root: string, snapshotHash: string): ContextGraphIndex | null {
  if (!snapshotHash) {
    misses += 1;
    return null;
  }
  const key = cacheKey(contextGraphWorkspaceKey(root), snapshotHash);
  const entry = entries.get(key);
  if (!entry) {
    misses += 1;
    return null;
  }
  clock += 1;
  entry.order = clock;
  hits += 1;
  return entry.index;
}

export function cacheContextGraphIndex(root: string, snapshotHash: string, index: ContextGraphIndex): void {
  if (!snapshotHash) return;
  const workspaceKey = contextGraphWorkspaceKey(root);
  for (const [key, entry] of [...entries]) {
    // A newer generation for the same workspace replaces the old one outright.
    if (entry.workspaceKey === workspaceKey) entries.delete(key);
  }
  clock += 1;
  entries.set(cacheKey(workspaceKey, snapshotHash), { workspaceKey, snapshotHash, index, order: clock });

  while (entries.size > CONTEXT_GRAPH_SNAPSHOT_CACHE_MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestOrder = Number.POSITIVE_INFINITY;
    for (const [key, entry] of entries) {
      if (entry.order < oldestOrder) {
        oldestOrder = entry.order;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    entries.delete(oldestKey);
    evictions += 1;
  }
}

export function clearContextGraphSnapshotCache(): void {
  entries.clear();
  hits = 0;
  misses = 0;
  evictions = 0;
  clock = 0;
}

export function contextGraphSnapshotCacheStats(): ContextGraphSnapshotCacheStats {
  const lookups = hits + misses;
  return {
    entries: entries.size,
    hits,
    misses,
    evictions,
    hitRate: lookups === 0 ? 0 : hits / lookups
  };
}
