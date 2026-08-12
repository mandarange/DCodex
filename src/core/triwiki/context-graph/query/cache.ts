/**
 * One cache for both index readers and query responses, budgeted in bytes.
 *
 * The v1 cache held two entries. Two entries is not a memory bound: one entry
 * can be 50 MB or 50 KB, so the cache either wasted a workspace's worth of
 * residency or blew past whatever the process could afford, and nothing in the
 * design could tell which. This one budgets in real resident bytes, taken from
 * the backing buffer's own length rather than estimated from a node count, so
 * the number in the stats is the number the process is actually holding.
 *
 * Responses live inside the generation that produced them instead of in a
 * second cache. A response is only meaningful against the index it was computed
 * from, so a separate response cache would need its own invalidation rule, and
 * a second invalidation rule is a second chance to serve an answer that no
 * longer matches the workspace.
 *
 * Two eviction rules, and they are different events:
 *
 * - A new generation for a workspace evicts that workspace's previous
 *   generation *immediately*, not when the budget is next under pressure.
 *   Waiting would leave a superseded index resident across a rebuild, which is
 *   exactly when memory is tightest.
 * - Budget pressure evicts least-recently-used generations until both the byte
 *   budget and the workspace count hold.
 *
 * Nothing here stores or emits an absolute path. The workspace is a short
 * digest, so a key, a stat block, or a benchmark record cannot leak a home
 * directory.
 */
import path from 'node:path';
import { shortDigest } from '../ids.js';
import type { ContextIndexReader } from '../runtime-index/reader.js';

export interface IndexCacheBudget {
  /** Total resident index bytes. An index larger than this is never retained. */
  maxBytes: number;
  /** Distinct workspaces kept resident at once. */
  maxWorkspaces: number;
}

/**
 * Sized above one compiled index for the measured baseline workspace and below
 * what a CLI process can afford to hold while also compiling.
 */
export const CONTEXT_INDEX_CACHE_DEFAULT_BUDGET: IndexCacheBudget = Object.freeze({
  maxBytes: 96 * 1024 * 1024,
  maxWorkspaces: 4,
});

export interface ContextIndexCacheStats {
  readonly generations: number;
  readonly workspaces: number;
  readonly residentBytes: number;
  readonly maxBytes: number;
  readonly maxWorkspaces: number;
  readonly hits: number;
  readonly misses: number;
  /** Generations dropped under byte or workspace pressure. */
  readonly evictions: number;
  /** Generations dropped because a newer generation for the same workspace arrived. */
  readonly superseded: number;
  /** Indexes never retained because a single one exceeded the whole budget. */
  readonly rejected: number;
  readonly responseEntries: number;
  readonly responseBytes: number;
  readonly responseHits: number;
  readonly responseMisses: number;
  /** hits / (hits + misses); 0 before the first lookup. */
  readonly hitRate: number;
}

interface ResponseEntry {
  readonly value: unknown;
  readonly bytes: number;
}

interface GenerationEntry {
  readonly workspaceKey: string;
  readonly snapshotHash: string;
  readonly reader: ContextIndexReader;
  readonly indexBytes: number;
  responseBytes: number;
  readonly responses: Map<string, ResponseEntry>;
  order: number;
}

/** `shortDigest` of the resolved root: identity without the path. */
export function contextIndexWorkspaceKey(root: string): string {
  return shortDigest(path.resolve(String(root ?? '')));
}

export class ContextIndexCache {
  private readonly generations = new Map<string, GenerationEntry>();
  private readonly budget: IndexCacheBudget;
  private residentBytes = 0;
  private responseBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private superseded = 0;
  private rejected = 0;
  private responseHits = 0;
  private responseMisses = 0;
  private clock = 0;

  constructor(budget: IndexCacheBudget = CONTEXT_INDEX_CACHE_DEFAULT_BUDGET) {
    this.budget = {
      maxBytes: Math.max(0, Math.trunc(budget.maxBytes)),
      maxWorkspaces: Math.max(0, Math.trunc(budget.maxWorkspaces)),
    };
  }

  private static key(workspaceKey: string, snapshotHash: string): string {
    return `${workspaceKey}:${snapshotHash}`;
  }

  getReader(root: string, snapshotHash: string): ContextIndexReader | null {
    if (!snapshotHash) {
      this.misses += 1;
      return null;
    }
    const entry = this.generations.get(ContextIndexCache.key(contextIndexWorkspaceKey(root), snapshotHash));
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.clock += 1;
    entry.order = this.clock;
    this.hits += 1;
    return entry.reader;
  }

  /**
   * The hash comes from the caller (the pointer), not from the reader, and the
   * two must agree: caching a reader under a hash it does not carry is how a
   * stale answer survives a rebuild.
   */
  setReader(root: string, snapshotHash: string, reader: ContextIndexReader): void {
    if (!snapshotHash) return;
    if (reader.snapshotHash !== snapshotHash) {
      throw new Error('context index cache: reader snapshot hash does not match the pointer');
    }
    const workspaceKey = contextIndexWorkspaceKey(root);
    this.dropWorkspace(workspaceKey, 'superseded');

    const indexBytes = reader.byteLength;
    if (indexBytes > this.budget.maxBytes || this.budget.maxWorkspaces === 0) {
      // Retaining it would put the cache over the budget its owner declared,
      // with nothing left to evict. The query still runs; it just re-reads.
      this.rejected += 1;
      return;
    }
    this.clock += 1;
    this.generations.set(ContextIndexCache.key(workspaceKey, snapshotHash), {
      workspaceKey,
      snapshotHash,
      reader,
      indexBytes,
      responseBytes: 0,
      responses: new Map(),
      order: this.clock,
    });
    this.residentBytes += indexBytes;
    this.enforceBudget();
  }

  getResponse<T>(root: string, snapshotHash: string, queryKey: string): T | null {
    const entry = this.generationOf(root, snapshotHash);
    const response = entry?.responses.get(queryKey);
    if (!entry || !response) {
      this.responseMisses += 1;
      return null;
    }
    this.clock += 1;
    entry.order = this.clock;
    this.responseHits += 1;
    return response.value as T;
  }

  /**
   * A response is stored against a resident generation or not at all. Keeping
   * one whose index has been evicted would leave an answer nothing can
   * re-derive or attest to, which is the silent-staleness the ADR forbids.
   */
  setResponse(root: string, snapshotHash: string, queryKey: string, value: unknown, bytes: number): void {
    const entry = this.generationOf(root, snapshotHash);
    if (!entry) return;
    const cost = Math.max(0, Math.trunc(bytes));
    const previous = entry.responses.get(queryKey);
    if (previous) {
      entry.responseBytes -= previous.bytes;
      this.residentBytes -= previous.bytes;
      this.responseBytes -= previous.bytes;
    }
    entry.responses.set(queryKey, { value, bytes: cost });
    entry.responseBytes += cost;
    this.residentBytes += cost;
    this.responseBytes += cost;
    this.clock += 1;
    entry.order = this.clock;
    this.enforceBudget();
  }

  private generationOf(root: string, snapshotHash: string): GenerationEntry | undefined {
    if (!snapshotHash) return undefined;
    return this.generations.get(ContextIndexCache.key(contextIndexWorkspaceKey(root), snapshotHash));
  }

  private dropWorkspace(workspaceKey: string, reason: 'superseded' | 'evictions'): void {
    for (const [key, entry] of [...this.generations]) {
      if (entry.workspaceKey !== workspaceKey) continue;
      this.remove(key, entry, reason);
    }
  }

  private remove(key: string, entry: GenerationEntry, reason: 'superseded' | 'evictions'): void {
    this.generations.delete(key);
    this.residentBytes -= entry.indexBytes + entry.responseBytes;
    this.responseBytes -= entry.responseBytes;
    if (reason === 'superseded') this.superseded += 1;
    else this.evictions += 1;
  }

  /**
   * Least-recently-used first. `order` comes from a monotonic counter rather
   * than a clock, so eviction order is the same on every machine and in every
   * run — a benchmark that reports eviction counts has to be reproducible.
   */
  private enforceBudget(): void {
    while (this.generations.size > 0 && (this.residentBytes > this.budget.maxBytes || this.workspaceCount() > this.budget.maxWorkspaces)) {
      let oldestKey: string | null = null;
      let oldest: GenerationEntry | null = null;
      for (const [key, entry] of this.generations) {
        if (oldest === null || entry.order < oldest.order) {
          oldestKey = key;
          oldest = entry;
        }
      }
      if (oldestKey === null || oldest === null) break;
      this.remove(oldestKey, oldest, 'evictions');
    }
  }

  private workspaceCount(): number {
    const workspaces = new Set<string>();
    for (const entry of this.generations.values()) workspaces.add(entry.workspaceKey);
    return workspaces.size;
  }

  clear(): void {
    this.generations.clear();
    this.residentBytes = 0;
    this.responseBytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.superseded = 0;
    this.rejected = 0;
    this.responseHits = 0;
    this.responseMisses = 0;
    this.clock = 0;
  }

  stats(): ContextIndexCacheStats {
    const lookups = this.hits + this.misses;
    let responseEntries = 0;
    for (const entry of this.generations.values()) responseEntries += entry.responses.size;
    return Object.freeze({
      generations: this.generations.size,
      workspaces: this.workspaceCount(),
      residentBytes: this.residentBytes,
      maxBytes: this.budget.maxBytes,
      maxWorkspaces: this.budget.maxWorkspaces,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      superseded: this.superseded,
      rejected: this.rejected,
      responseEntries,
      responseBytes: this.responseBytes,
      responseHits: this.responseHits,
      responseMisses: this.responseMisses,
      hitRate: lookups === 0 ? 0 : this.hits / lookups,
    });
  }
}

let shared: ContextIndexCache | null = null;

/**
 * Process-wide cache. It is a singleton because residency is a process
 * property: two caches with the same budget would hold twice the budget.
 */
export function sharedContextIndexCache(): ContextIndexCache {
  if (shared === null) shared = new ContextIndexCache();
  return shared;
}

/** Test seam. Replacing the shared cache is how a suite runs against a small budget. */
export function setSharedContextIndexCache(cache: ContextIndexCache | null): void {
  shared = cache;
}
