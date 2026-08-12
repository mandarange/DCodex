/**
 * The commit path: how bytes a compiler produced become the index every query
 * reads.
 *
 * This is the only place in CRK2 where a crash can hand a reader something
 * half-built, so the ordering is the contract, not an implementation detail
 * (ADR §6, work order §9.2):
 *
 *   temp write → durability → section checksum verify → atomic rename into
 *   `generations/<snapshotHash>.idx` → meta → **atomic pointer replace, last**
 *
 * The pointer moves last because it is the only thing readers follow. Everything
 * before it is invisible: a crash at any earlier step leaves the previous
 * pointer byte-identical and the previous generation intact, and leaves the
 * partial artifact somewhere no query looks. The pointer is also only replaced
 * once every lint *and* every checksum has passed — a failed lint stops the
 * compile here rather than being reported alongside a commit.
 *
 * **Meta is written twice on purpose**: an immutable per-generation sidecar next
 * to the `.idx`, and the mirror at `context-graph.meta.json` that readers use.
 * Without the sidecar, a crash in the window between the mirror and the pointer
 * would leave the mirror describing a generation that never became current and
 * nothing to re-derive the real one from — and the only remaining move would be
 * to guess. Recovery uses the sidecar to put the mirror back.
 *
 * Concurrency is handled by comparing the pointer against the base hash the
 * operation captured, twice: once before the rename and once immediately before
 * the replace. Two compilers may run, but the one that started from an older
 * pointer cannot overwrite the newer one.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { nowIso, writeBinaryAtomic, writeJsonAtomic } from '../../../fsx.js';
import { CONTEXT_INDEX_FORMAT_REVISION, type ContextIndexHeader } from '../runtime-index/format.js';
import { appendContextGraphEvent } from './event-log.js';
import { refuseStore } from './generation-errors.js';
import { renameOrRewrite, syncDirectory } from './generation-io.js';
import {
  contextIndexGenerationMetaPath,
  contextIndexGenerationPath,
  contextIndexGenerationRelative,
  contextIndexGenerationsDir,
  contextIndexMetaPath,
  contextIndexOperationJournalPath,
  contextIndexOperationTempIndexRelative,
  contextIndexOperationTempPath,
  contextIndexPointerPath,
  contextIndexStoreDir,
} from './generation-layout.js';
import {
  CONTEXT_INDEX_META_SCHEMA,
  CONTEXT_INDEX_POINTER_SCHEMA,
  assertContextIndexPointerMetaAgreement,
  readContextIndexMeta,
  readContextIndexPointerLenient,
  type ContextIndexMeta,
  type ContextIndexPointer,
} from './generation-pointer.js';
import { assertGenerationIdentity, verifyContextIndexBytes, verifyContextIndexFile } from './generation-verify.js';
import {
  advanceContextOperationPhase,
  buildContextOperationJournal,
  contextOperationPhaseRank,
  deriveContextOperationId,
  readContextOperationJournalFile,
  writeContextOperationJournalFile,
  type ContextOperationJournal,
} from './operation-journal.js';

export interface ContextIndexOperationInput {
  readonly targetSnapshotHash: string;
  readonly configFingerprint: string;
  readonly sourceFingerprint: string;
  readonly fragmentManifestHash?: string | null | undefined;
  readonly now?: string | undefined;
}

/**
 * Open an operation. The base snapshot hash is captured from the pointer here
 * and checked again at publish time: that pair is what stops a second compiler
 * that started from an older current pointer from overwriting the newer one.
 */
export async function beginContextIndexOperation(
  root: string,
  input: ContextIndexOperationInput,
): Promise<ContextOperationJournal> {
  const journalPath = contextIndexOperationJournalPath(root);
  const current = await readContextIndexPointerLenient(root);
  const baseSnapshotHash = current.pointer?.snapshotHash ?? null;
  const operationId = deriveContextOperationId({
    baseSnapshotHash,
    targetSnapshotHash: input.targetSnapshotHash,
    configFingerprint: input.configFingerprint,
    sourceFingerprint: input.sourceFingerprint,
  });

  const existing = await readContextOperationJournalFile(journalPath);
  if (existing) {
    // Same operation re-entered after a crash: idempotent, so the caller can
    // resume. A *different* operation means an unrecovered one is still in
    // flight and recovery has to run before anything new is staged.
    if (existing.operationId === operationId) return existing;
    refuseStore('operation_in_flight', { phase: contextOperationPhaseRank(existing.phase) });
  }

  const journal = buildContextOperationJournal({
    operationId,
    baseSnapshotHash,
    targetSnapshotHash: input.targetSnapshotHash,
    configFingerprint: input.configFingerprint,
    sourceFingerprint: input.sourceFingerprint,
    tempIndex: contextIndexOperationTempIndexRelative(operationId),
    phase: 'prepared',
    fragmentManifestHash: input.fragmentManifestHash ?? null,
    startedAt: input.now ?? nowIso(),
  });
  return writeContextOperationJournalFile(journalPath, journal);
}

export async function advanceContextIndexOperation(
  root: string,
  journal: ContextOperationJournal,
  phase: ContextOperationJournal['phase'],
): Promise<ContextOperationJournal> {
  return writeContextOperationJournalFile(
    contextIndexOperationJournalPath(root),
    advanceContextOperationPhase(journal, phase),
  );
}

export interface StagedContextIndexGeneration {
  readonly journal: ContextOperationJournal;
  readonly tempIndexPath: string;
  readonly header: ContextIndexHeader;
  readonly byteLength: number;
  readonly checksum: string;
}

/**
 * Steps 1–3 of §9.2: write the temp index, make it durable, verify it from disk.
 *
 * The journal only reaches `indexed` once the bytes on disk have passed full
 * section verification, which is what makes `indexed` the one phase a later
 * recovery is allowed to treat as a resume candidate.
 */
export async function stageContextIndexGeneration(
  root: string,
  journal: ContextOperationJournal,
  bytes: Uint8Array,
): Promise<StagedContextIndexGeneration> {
  if (contextOperationPhaseRank(journal.phase) >= contextOperationPhaseRank('indexed')) {
    refuseStore('phase_out_of_order', { phase: contextOperationPhaseRank(journal.phase) });
  }
  const inMemory = verifyContextIndexBytes(bytes);
  assertGenerationIdentity(inMemory.header, journal.targetSnapshotHash);

  const tempIndexPath = contextIndexOperationTempPath(root, journal);
  await fsp.mkdir(path.dirname(tempIndexPath), { recursive: true });
  await writeBinaryAtomic(tempIndexPath, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  await syncDirectory(path.dirname(tempIndexPath));

  const persisted = await verifyContextIndexFile(tempIndexPath, {
    snapshotHash: journal.targetSnapshotHash,
    checksum: inMemory.checksum,
  });

  const advanced = await writeContextOperationJournalFile(
    contextIndexOperationJournalPath(root),
    advanceContextOperationPhase(journal, 'indexed', { indexChecksum: persisted.checksum }),
  );
  return {
    journal: advanced,
    tempIndexPath,
    header: persisted.header,
    byteLength: persisted.byteLength,
    checksum: persisted.checksum,
  };
}

export interface ContextIndexLintOutcome {
  readonly passed: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
}

export interface PromotedContextIndexGeneration {
  readonly journal: ContextOperationJournal;
  readonly meta: ContextIndexMeta;
  readonly previousSnapshotHash: string | null;
}

export interface ContextIndexPromoteOptions {
  readonly lint: ContextIndexLintOutcome;
  readonly now?: string | undefined;
}

function assertLintPassed(lint: ContextIndexLintOutcome): void {
  if (!lint.passed || lint.errorCount > 0) {
    refuseStore('lint_not_passed', { errors: lint.errorCount, warnings: lint.warningCount });
  }
}

/**
 * Steps 4 and 6–7 of §9.2: rename the verified temp index into its immutable
 * content-addressed path and record the meta — everything except the pointer.
 *
 * Nothing here is reachable by a query, so the whole step is invisible until
 * `publishContextIndexPointer` runs.
 */
export async function promoteContextIndexGeneration(
  root: string,
  staged: StagedContextIndexGeneration,
  options: ContextIndexPromoteOptions,
): Promise<PromotedContextIndexGeneration> {
  const journal = staged.journal;
  if (journal.phase !== 'indexed') {
    refuseStore('phase_out_of_order', { phase: contextOperationPhaseRank(journal.phase) });
  }
  assertLintPassed(options.lint);

  const verified = await verifyContextIndexFile(staged.tempIndexPath, {
    snapshotHash: journal.targetSnapshotHash,
    checksum: journal.indexChecksum ?? staged.checksum,
  });

  const current = await readContextIndexPointerLenient(root);
  if ((current.pointer?.snapshotHash ?? null) !== journal.baseSnapshotHash) {
    refuseStore('stale_writer', { present: current.present ? 1 : 0 });
  }

  const generationsDir = contextIndexGenerationsDir(root);
  await fsp.mkdir(generationsDir, { recursive: true });
  await renameOrRewrite(staged.tempIndexPath, contextIndexGenerationPath(root, journal.targetSnapshotHash));
  await syncDirectory(generationsDir);

  const previousSnapshotHash =
    current.pointer && current.pointer.snapshotHash !== journal.targetSnapshotHash
      ? current.pointer.snapshotHash
      : (current.pointer?.previousSnapshotHash ?? null);

  const meta: ContextIndexMeta = Object.freeze({
    schema: CONTEXT_INDEX_META_SCHEMA,
    formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
    snapshotHash: journal.targetSnapshotHash,
    configFingerprint: journal.configFingerprint,
    sourceFingerprint: journal.sourceFingerprint,
    generationPath: contextIndexGenerationRelative(journal.targetSnapshotHash),
    previousSnapshotHash,
    indexBytes: verified.byteLength,
    indexChecksum: verified.checksum,
    // Counts come from the verified header rather than from a caller argument:
    // one source of truth means the meta cannot disagree with the file it
    // describes.
    nodeCount: verified.header.nodeCount,
    edgeCount: verified.header.edgeCount,
    termCount: verified.header.termCount,
    provenanceCount: verified.header.provenanceCount,
    operationId: journal.operationId,
    committedAt: options.now ?? nowIso(),
  });

  await writeJsonAtomic(contextIndexGenerationMetaPath(root, meta.snapshotHash), meta);
  await writeJsonAtomic(contextIndexMetaPath(root), meta);
  return { journal, meta, previousSnapshotHash };
}

/** Step 5 of §9.2, and the only step a query can observe. */
export async function publishContextIndexPointer(
  root: string,
  promoted: PromotedContextIndexGeneration,
): Promise<ContextIndexPointer> {
  const { journal, meta } = promoted;
  const current = await readContextIndexPointerLenient(root);
  // Re-checked immediately before the replace: between promote and publish the
  // only thing that could have moved the pointer is another compiler, and the
  // loser must not overwrite the winner.
  if ((current.pointer?.snapshotHash ?? null) !== journal.baseSnapshotHash) {
    refuseStore('stale_writer', { present: current.present ? 1 : 0 });
  }

  const pointer: ContextIndexPointer = Object.freeze({
    schema: CONTEXT_INDEX_POINTER_SCHEMA,
    formatRevision: CONTEXT_INDEX_FORMAT_REVISION,
    snapshotHash: meta.snapshotHash,
    configFingerprint: meta.configFingerprint,
    sourceFingerprint: meta.sourceFingerprint,
    generationPath: meta.generationPath,
    previousSnapshotHash: meta.previousSnapshotHash,
    indexBytes: meta.indexBytes,
    indexChecksum: meta.indexChecksum,
    committedAt: meta.committedAt,
  });
  await writeJsonAtomic(contextIndexPointerPath(root), pointer);
  await syncDirectory(contextIndexStoreDir(root));
  await writeContextOperationJournalFile(
    contextIndexOperationJournalPath(root),
    advanceContextOperationPhase(journal, 'committed'),
  );
  await appendContextGraphEvent(root, {
    type: 'compile.committed',
    at: pointer.committedAt || nowIso(),
    snapshotHash: pointer.snapshotHash,
    previousSnapshotHash: pointer.previousSnapshotHash,
    nodeCount: meta.nodeCount,
    edgeCount: meta.edgeCount,
  });
  return pointer;
}

export interface ContextIndexCommitResult {
  readonly committed: boolean;
  readonly reason: 'committed' | 'already_current';
  readonly pointer: ContextIndexPointer;
  readonly meta: ContextIndexMeta;
  readonly journal: ContextOperationJournal;
}

/**
 * The normal path: promote then publish, in that order, with the pointer last.
 *
 * A re-run of an operation whose result is already current is a no-op — the same
 * inputs produce the same content address, so there is nothing to replace and
 * nothing to log.
 */
export async function commitContextIndexGeneration(
  root: string,
  staged: StagedContextIndexGeneration,
  options: ContextIndexPromoteOptions,
): Promise<ContextIndexCommitResult> {
  const journal = staged.journal;
  // Checked before the already-current shortcut too: a failed lint must never
  // come back as a successful compile, even when there is nothing to replace.
  assertLintPassed(options.lint);
  const current = await readContextIndexPointerLenient(root);
  const pointer = current.pointer;
  if (
    pointer &&
    pointer.snapshotHash === journal.targetSnapshotHash &&
    pointer.configFingerprint === journal.configFingerprint &&
    pointer.sourceFingerprint === journal.sourceFingerprint
  ) {
    const meta = await readContextIndexMeta(root);
    if (!meta) refuseStore('meta_missing', {});
    assertContextIndexPointerMetaAgreement(pointer, meta);
    const advanced =
      journal.phase === 'committed' ? journal : await advanceContextIndexOperation(root, journal, 'committed');
    return { committed: false, reason: 'already_current', pointer, meta, journal: advanced };
  }

  const promoted = await promoteContextIndexGeneration(root, staged, options);
  const published = await publishContextIndexPointer(root, promoted);
  const journalAfter = await readContextOperationJournalFile(contextIndexOperationJournalPath(root));
  return {
    committed: true,
    reason: 'committed',
    pointer: published,
    meta: promoted.meta,
    journal: journalAfter ?? promoted.journal,
  };
}
