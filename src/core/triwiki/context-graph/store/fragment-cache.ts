/**
 * Content-hash fragment cache.
 *
 * An extractor whose inputs did not move can be replayed from disk instead of
 * re-run. The key is a digest of everything the fragment depends on (extractor
 * identity + revision, the compile cache key, and the changed-path set), so a
 * cache hit is a byte-level guarantee, never a heuristic.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, sha256, writeJsonAtomic } from '../../../fsx.js';
import {
  CONTEXT_GRAPH_FRAGMENT_SCHEMA,
  type ContextGraphFragment
} from '../contracts.js';
import { contextGraphFragmentCacheDir } from '../paths.js';

export const CONTEXT_GRAPH_FRAGMENT_CACHE_MAX_ENTRIES = 64;

export interface FragmentCacheKeyInput {
  extractorId: string;
  extractorRevision: string;
  cacheKey: string;
  changedPaths: readonly string[] | null;
}

export function fragmentCacheKey(input: FragmentCacheKeyInput): string {
  return sha256(
    JSON.stringify([
      CONTEXT_GRAPH_FRAGMENT_SCHEMA,
      input.extractorId,
      input.extractorRevision,
      input.cacheKey,
      input.changedPaths === null ? null : [...input.changedPaths].sort()
    ])
  );
}

function entryPath(root: string, key: string): string {
  return path.join(contextGraphFragmentCacheDir(root), `${key}.json`);
}

function isFragment(value: unknown, extractorId: string): value is ContextGraphFragment {
  if (!value || typeof value !== 'object') return false;
  const fragment = value as Partial<ContextGraphFragment>;
  return (
    fragment.schema === CONTEXT_GRAPH_FRAGMENT_SCHEMA
    && fragment.extractor === extractorId
    && Array.isArray(fragment.nodes)
    && Array.isArray(fragment.edges)
    && Array.isArray(fragment.issues)
    && Array.isArray(fragment.skipped)
    && Boolean(fragment.inputHashes)
    && typeof fragment.inputHashes === 'object'
  );
}

/** `null` on any miss, corruption, or extractor mismatch — a bad cache entry is never repaired in place. */
export async function readCachedFragment(
  root: string,
  key: string,
  extractorId: string
): Promise<ContextGraphFragment | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(entryPath(root, key), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isFragment(parsed, extractorId) ? parsed : null;
  } catch {
    return null;
  }
}

export type FragmentCacheReadResult =
  | { status: 'HIT'; reason: 'content_hash_match'; fragment: ContextGraphFragment }
  | { status: 'MISS'; reason: 'entry_absent' | 'invalid_json' | 'schema_invalid' | 'extractor_mismatch'; fragment: null };

export async function readCachedFragmentWithReason(
  root: string,
  key: string,
  extractorId: string
): Promise<FragmentCacheReadResult> {
  let raw: string;
  try {
    raw = await fsp.readFile(entryPath(root, key), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'MISS', reason: 'entry_absent', fragment: null };
    return { status: 'MISS', reason: 'schema_invalid', fragment: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'MISS', reason: 'invalid_json', fragment: null };
  }
  if (parsed && typeof parsed === 'object' && (parsed as { extractor?: unknown }).extractor !== extractorId) {
    return { status: 'MISS', reason: 'extractor_mismatch', fragment: null };
  }
  if (!isFragment(parsed, extractorId)) return { status: 'MISS', reason: 'schema_invalid', fragment: null };
  return { status: 'HIT', reason: 'content_hash_match', fragment: parsed };
}

export async function writeCachedFragment(
  root: string,
  key: string,
  fragment: ContextGraphFragment
): Promise<void> {
  await ensureDir(contextGraphFragmentCacheDir(root));
  await writeJsonAtomic(entryPath(root, key), fragment);
}

/** Bound the cache by count, oldest first. Returns how many entries were removed. */
export async function pruneFragmentCache(
  root: string,
  maxEntries: number = CONTEXT_GRAPH_FRAGMENT_CACHE_MAX_ENTRIES
): Promise<number> {
  const dir = contextGraphFragmentCacheDir(root);
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'));
  } catch {
    return 0;
  }
  if (names.length <= maxEntries) return 0;
  const rows: Array<{ file: string; mtimeMs: number }> = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      rows.push({ file, mtimeMs: stat.mtimeMs });
    } catch {
      // vanished between readdir and stat; nothing to prune
    }
  }
  rows.sort((left, right) => right.mtimeMs - left.mtimeMs || (left.file < right.file ? -1 : 1));
  const removable = rows.slice(maxEntries);
  let removed = 0;
  for (const row of removable) {
    try {
      await fsp.rm(row.file, { force: true });
      removed += 1;
    } catch {
      // best effort; a surviving entry is still valid, just unpruned
    }
  }
  return removed;
}
