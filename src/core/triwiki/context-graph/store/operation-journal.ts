/**
 * Compile operation journal — public entry point and file access.
 *
 * A compile publishes a new index over several disk steps and a crash can land
 * between any two of them. The journal is what the next compile reads to tell a
 * temp artifact it can *prove* safe from one it merely hopes is safe.
 *
 * Two rules govern the file itself:
 *
 * - **The journal is compile-side state only.** A query that consulted it could
 *   act on an index that has not passed lint or checksum verification yet, which
 *   is exactly the partial-index read ADR §6 forbids. Nothing on the read path
 *   imports this module.
 * - **A journal that does not parse is a cleanup blocker, never something to
 *   patch up.** Half-understood journal state would authorize reusing a temp
 *   artifact whose provenance nothing can attest to, so an unreadable file
 *   throws rather than reading as absent.
 *
 * The schema, validation, and phase algebra live in `operation-journal-schema.ts`;
 * the pure recovery planner lives in `operation-journal-recovery.ts`. Both are
 * re-exported here, so importers only ever need this module.
 */
import fsp from 'node:fs/promises';
import { writeJsonAtomic } from '../../../fsx.js';
import {
  ContextOperationJournalError,
  parseContextOperationJournal,
  type ContextOperationJournal,
} from './operation-journal-schema.js';

export * from './operation-journal-schema.js';
export * from './operation-journal-recovery.js';

/**
 * `null` means no operation is in flight — the only benign absence. Anything
 * present but unreadable throws: treating a corrupt journal as absent would
 * silently license a rebuild over state we cannot describe.
 */
export async function readContextOperationJournalFile(
  journalPath: string,
): Promise<ContextOperationJournal | null> {
  let text: string;
  try {
    text = await fsp.readFile(journalPath, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw new ContextOperationJournalError('journal_unreadable', { errno: 1 });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ContextOperationJournalError('journal_unreadable', { errno: 2 });
  }
  return parseContextOperationJournal(parsed);
}

export async function writeContextOperationJournalFile(
  journalPath: string,
  journal: ContextOperationJournal,
): Promise<ContextOperationJournal> {
  // Re-validated on the way out so a caller-constructed object cannot put an
  // absolute path or a free-text blocker into the file.
  const validated = parseContextOperationJournal(journal);
  await writeJsonAtomic(journalPath, validated);
  return validated;
}

export async function removeContextOperationJournalFile(journalPath: string): Promise<void> {
  await fsp.rm(journalPath, { force: true });
}
