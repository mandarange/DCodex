/**
 * Crash recovery: read the journal a dead compile left behind and put the store
 * back into a state the next compile can start from.
 *
 * A temp index is offered back only when all of it holds: the phase reached
 * `indexed`, the fingerprints still match, the file is still there, and it still
 * verifies against its recorded checksum. Anything else is discarded and
 * rebuilt — a resume that skipped one of those checks would be
 * indistinguishable from committing a stale index.
 *
 * A corrupt journal is a fail-closed blocker. The bytes are left exactly as
 * found and the failure is logged rather than repaired: the corrupt journal is
 * the only record of what the crashed compile was doing, and rewriting it would
 * erase the evidence while authorising a rebuild over state nothing can
 * describe.
 */
import fsp from 'node:fs/promises';
import { nowIso, writeJsonAtomic } from '../../../fsx.js';
import { appendContextGraphEvent } from './event-log.js';
import { ContextIndexStoreError } from './generation-errors.js';
import { readJsonFile } from './generation-io.js';
import {
  contextIndexGenerationMetaPath,
  contextIndexMetaPath,
  contextIndexOperationJournalPath,
  contextIndexOperationTempPath,
} from './generation-layout.js';
import {
  parseContextIndexMeta,
  readContextIndexPointerLenient,
  type ContextIndexMeta,
} from './generation-pointer.js';
import { cleanContextIndexOperation, pruneToCurrentPointer } from './generation-retention.js';
import { verifyContextIndexFile } from './generation-verify.js';
import {
  ContextOperationJournalError,
  planContextOperationRecovery,
  readContextOperationJournalFile,
  removeContextOperationJournalFile,
  type ContextOperationExpectation,
  type ContextOperationJournal,
  type ContextOperationRecoveryAction,
  type ContextOperationRecoveryReason,
} from './operation-journal.js';

export interface ContextIndexRecoveryResult {
  readonly action: ContextOperationRecoveryAction;
  readonly reason: ContextOperationRecoveryReason;
  readonly journal: ContextOperationJournal | null;
  /** Absolute path of a temp index proven safe to reuse; `null` in every other case. */
  readonly resumableIndexPath: string | null;
  readonly metaReconciled: boolean;
  readonly removedGenerationFiles: number;
}

export async function recoverContextIndexOperation(
  root: string,
  expectation: ContextOperationExpectation,
): Promise<ContextIndexRecoveryResult> {
  const journalPath = contextIndexOperationJournalPath(root);
  let journal: ContextOperationJournal | null;
  try {
    journal = await readContextOperationJournalFile(journalPath);
  } catch (error: unknown) {
    if (error instanceof ContextOperationJournalError) {
      await appendContextGraphEvent(root, { type: 'compile.blocked', at: nowIso(), reason: error.publicCode });
    }
    throw error;
  }

  const plan = planContextOperationRecovery(journal, expectation);
  let resumableIndexPath: string | null = null;
  let reason = plan.reason;
  let action = plan.action;
  let removedGenerationFiles = 0;

  if (plan.journal && action === 'resume_index') {
    const tempIndexPath = contextIndexOperationTempPath(root, plan.journal);
    try {
      await verifyContextIndexFile(tempIndexPath, {
        snapshotHash: plan.journal.targetSnapshotHash,
        checksum: plan.journal.indexChecksum ?? undefined,
      });
      resumableIndexPath = tempIndexPath;
    } catch (error: unknown) {
      action = 'discard_temp';
      reason =
        error instanceof ContextIndexStoreError && error.code === 'temp_index_missing'
          ? 'temp_index_missing'
          : 'temp_index_checksum_mismatch';
    }
  }

  if (plan.journal && action === 'discard_temp') {
    await fsp.rm(contextIndexOperationTempPath(root, plan.journal), { force: true }).catch(() => undefined);
    await removeContextOperationJournalFile(journalPath);
    // A crash between the generation rename and the pointer replace leaves a
    // generation nothing references. It is content-addressed, so rebuilding it
    // costs the same as trusting it, and leaving it would keep an unattested
    // file sitting in the directory a reader resolves paths against.
    removedGenerationFiles = await pruneToCurrentPointer(root);
  }

  if (plan.journal && (action === 'finish_commit' || action === 'clear_journal')) {
    const cleanup = await cleanContextIndexOperation(root, plan.journal);
    removedGenerationFiles = cleanup.removedGenerationFiles;
  }

  const metaReconciled = await reconcileContextIndexMeta(root);
  return { action, reason, journal: plan.journal, resumableIndexPath, metaReconciled, removedGenerationFiles };
}

/**
 * Repair the meta mirror after a crash between the meta write and the pointer
 * replace, using the pointed generation's immutable sidecar.
 *
 * This is re-derivation from a committed artifact, not a preference between two
 * disagreeing records: the pointer is authoritative about what is current, and
 * the sidecar was written and fsynced with the generation it describes. When the
 * sidecar is gone the mirror is left alone so the divergence stays visible and
 * fails closed.
 */
async function reconcileContextIndexMeta(root: string): Promise<boolean> {
  const current = await readContextIndexPointerLenient(root);
  const metaRaw = await readJsonFile(contextIndexMetaPath(root));
  if (!current.pointer) {
    // Nothing is current, so a mirror describing a generation is describing one
    // that never got published.
    if (metaRaw === null) return false;
    await fsp.rm(contextIndexMetaPath(root), { force: true });
    return true;
  }
  if (metaRaw !== null) {
    try {
      const meta = parseContextIndexMeta(metaRaw);
      if (meta.snapshotHash === current.pointer.snapshotHash) return false;
    } catch {
      /* unparseable mirror is restored below when a sidecar exists */
    }
  }
  const sidecar = await readJsonFile(contextIndexGenerationMetaPath(root, current.pointer.snapshotHash));
  if (sidecar === null) return false;
  let restored: ContextIndexMeta;
  try {
    restored = parseContextIndexMeta(sidecar);
  } catch {
    return false;
  }
  if (restored.snapshotHash !== current.pointer.snapshotHash) return false;
  await writeJsonAtomic(contextIndexMetaPath(root), restored);
  return true;
}
