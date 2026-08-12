/**
 * Retention and end-of-compile cleanup.
 *
 * Exactly two generations survive a compile: current and previous (ADR §6). The
 * previous one is kept for incremental merge and audit — it is **not** a
 * rollback target, and nothing here or in the resolve path will serve it.
 *
 * Cleanup writes the `cleaned` phase to the journal *before* it starts deleting,
 * so a crash in the middle of the prune is recognisable on the next run; the
 * journal file itself is removed only once there is nothing left to finish.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { refuseStore } from './generation-errors.js';
import {
  CONTEXT_INDEX_GENERATION_NAME,
  CONTEXT_INDEX_GENERATION_RETENTION,
  contextIndexGenerationsDir,
  contextIndexOperationJournalPath,
  contextIndexOperationTempPath,
} from './generation-layout.js';
import { readContextIndexPointerLenient } from './generation-pointer.js';
import {
  advanceContextOperationPhase,
  removeContextOperationJournalFile,
  writeContextOperationJournalFile,
  type ContextOperationJournal,
} from './operation-journal.js';

export async function listContextIndexGenerations(root: string): Promise<readonly string[]> {
  const entries = await fsp.readdir(contextIndexGenerationsDir(root)).catch(() => [] as string[]);
  const hashes = new Set<string>();
  for (const entry of entries) {
    const matched = CONTEXT_INDEX_GENERATION_NAME.exec(entry);
    if (matched) hashes.add(matched[1] as string);
  }
  return Object.freeze([...hashes].sort());
}

/**
 * Removes every generation outside `keep`, index and sidecar together.
 * Generations are immutable and content-addressed, so an unreferenced one is
 * dead weight that also widens the window for a stale reader to find something
 * plausible-looking to open.
 */
export async function pruneContextIndexGenerations(
  root: string,
  keep: readonly (string | null)[],
): Promise<number> {
  const retained = new Set(keep.filter((hash): hash is string => typeof hash === 'string' && hash.length > 0));
  if (retained.size > CONTEXT_INDEX_GENERATION_RETENTION) {
    // A caller asking to keep more than current+previous has lost track of which
    // generations are live; refusing beats quietly retaining an unbounded set.
    refuseStore('retention_overflow', { keep: retained.size, limit: CONTEXT_INDEX_GENERATION_RETENTION });
  }
  const generationsDir = contextIndexGenerationsDir(root);
  const entries = await fsp.readdir(generationsDir).catch(() => [] as string[]);
  let removed = 0;
  for (const entry of entries) {
    const matched = CONTEXT_INDEX_GENERATION_NAME.exec(entry);
    if (!matched) continue;
    if (retained.has(matched[1] as string)) continue;
    await fsp.rm(path.join(generationsDir, entry), { force: true });
    removed += 1;
  }
  return removed;
}

/** Prune to whatever the pointer currently names; used by cleanup and by recovery. */
export async function pruneToCurrentPointer(root: string): Promise<number> {
  const current = await readContextIndexPointerLenient(root);
  return pruneContextIndexGenerations(root, [
    current.pointer?.snapshotHash ?? null,
    current.pointer?.previousSnapshotHash ?? null,
  ]);
}

export interface ContextIndexCleanupResult {
  readonly removedGenerationFiles: number;
  readonly removedTempIndex: boolean;
}

/** Step 8 of §9.2. */
export async function cleanContextIndexOperation(
  root: string,
  journal: ContextOperationJournal,
): Promise<ContextIndexCleanupResult> {
  const journalPath = contextIndexOperationJournalPath(root);
  const cleaned =
    journal.phase === 'cleaned'
      ? journal
      : await writeContextOperationJournalFile(journalPath, advanceContextOperationPhase(journal, 'cleaned'));

  const tempIndexPath = contextIndexOperationTempPath(root, cleaned);
  const hadTempIndex = await fsp
    .stat(tempIndexPath)
    .then(() => true)
    .catch(() => false);
  await fsp.rm(tempIndexPath, { force: true });

  const removedGenerationFiles = await pruneToCurrentPointer(root);
  await removeContextOperationJournalFile(journalPath);
  return { removedGenerationFiles, removedTempIndex: hadTempIndex };
}
