/**
 * On-disk layout of the generation store, and the one number that governs how
 * much of it survives a compile.
 *
 * ```text
 * .sneakoscope/wiki/context-graph/
 *   current.json                    small atomic pointer, replaced last
 *   context-graph.meta.json         meta mirror for the current generation
 *   context-graph-operation.json    journal; exists only during a compile
 *   generations/
 *     <snapshotHash>.idx            immutable, content-addressed
 *     <snapshotHash>.meta.json      immutable sidecar for that generation
 * .sneakoscope/cache/context-graph/operations/
 *   <operationId>.idx               staged index, invisible to every reader
 * ```
 *
 * Generation paths are content-addressed, so a given snapshot always names the
 * same file and a rebuild of unchanged sources is a no-op rather than a new
 * file. The relative forms exist because those strings are written *into* the
 * pointer, the meta, and the journal, and an absolute path in any of them would
 * be a leak (work order §1.4).
 */
import path from 'node:path';
import { refuseStore } from './generation-errors.js';
import type { ContextOperationJournal } from './operation-journal.js';

/**
 * Current plus previous, and nothing else (ADR §6). Older generations are
 * removed at compile end: they are immutable and content-addressed, so an
 * unreferenced one is dead weight that also widens the window for a stale
 * reader to find something plausible-looking to open.
 */
export const CONTEXT_INDEX_GENERATION_RETENTION = 2;

export const CONTEXT_INDEX_GENERATION_SUFFIX = '.idx' as const;
export const CONTEXT_INDEX_GENERATION_META_SUFFIX = '.meta.json' as const;

const STORE_SEGMENTS = ['.sneakoscope', 'wiki', 'context-graph'] as const;
const OPERATION_CACHE_SEGMENTS = ['.sneakoscope', 'cache', 'context-graph', 'operations'] as const;

export function contextIndexStoreDir(root: string): string {
  return path.join(root, ...STORE_SEGMENTS);
}

export function contextIndexPointerPath(root: string): string {
  return path.join(contextIndexStoreDir(root), 'current.json');
}

export function contextIndexMetaPath(root: string): string {
  return path.join(contextIndexStoreDir(root), 'context-graph.meta.json');
}

export function contextIndexOperationJournalPath(root: string): string {
  return path.join(contextIndexStoreDir(root), 'context-graph-operation.json');
}

export function contextIndexGenerationsDir(root: string): string {
  return path.join(contextIndexStoreDir(root), 'generations');
}

export function contextIndexGenerationPath(root: string, snapshotHash: string): string {
  return path.join(contextIndexGenerationsDir(root), `${snapshotHash}${CONTEXT_INDEX_GENERATION_SUFFIX}`);
}

export function contextIndexGenerationMetaPath(root: string, snapshotHash: string): string {
  return path.join(contextIndexGenerationsDir(root), `${snapshotHash}${CONTEXT_INDEX_GENERATION_META_SUFFIX}`);
}

/** Workspace-relative because it is written into the journal, which is workspace state. */
export function contextIndexOperationTempIndexRelative(operationId: string): string {
  return `${OPERATION_CACHE_SEGMENTS.join('/')}/${operationId}${CONTEXT_INDEX_GENERATION_SUFFIX}`;
}

export function contextIndexGenerationRelative(snapshotHash: string): string {
  return `${STORE_SEGMENTS.join('/')}/generations/${snapshotHash}${CONTEXT_INDEX_GENERATION_SUFFIX}`;
}

/** Matches both files a generation owns, so retention removes them as a unit. */
export const CONTEXT_INDEX_GENERATION_NAME = /^([0-9a-f]{16,64})(\.idx|\.meta\.json)$/;

export function contextIndexOperationTempPath(root: string, journal: ContextOperationJournal): string {
  const absolute = path.resolve(root, journal.tempIndex);
  const relative = path.relative(path.resolve(root), absolute);
  // Defence in depth: the journal already rejects escaping paths on parse, so a
  // path that escapes here means the file was edited between checks.
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) refuseStore('unsafe_store_path', { at: 1 });
  return absolute;
}
