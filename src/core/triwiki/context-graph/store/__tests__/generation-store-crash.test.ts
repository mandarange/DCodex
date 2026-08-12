import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  advanceContextIndexOperation,
  beginContextIndexOperation,
  commitContextIndexGeneration,
  contextIndexGenerationPath,
  contextIndexMetaPath,
  contextIndexOperationJournalPath,
  contextIndexOperationTempPath,
  listContextIndexGenerations,
  promoteContextIndexGeneration,
  publishContextIndexPointer,
  readContextIndexMeta,
  readContextIndexPointer,
  recoverContextIndexOperation,
  resolveCurrentContextIndex,
  stageContextIndexGeneration,
} from '../generation-store.js';
import {
  advanceContextOperationPhase,
  readContextOperationJournalFile,
  writeContextOperationJournalFile,
} from '../operation-journal.js';
import {
  CONFIG,
  HASH_A,
  HASH_B,
  HASH_C,
  PASS,
  SOURCE_A,
  SOURCE_B,
  buildIndexBytes,
  compile,
  fileExists,
  publicCodeIs,
  storeError,
  withRoot,
} from './generation-store-fixtures.js';

/**
 * A compile publishes a new index over several disk steps, and a crash can land
 * between any two of them. Every test below is one of those windows, and the
 * invariant is always the same pair: the pointer a query follows is either the
 * old generation or the new one, never something in between, and nothing
 * partial is ever reachable from it.
 *
 * The phases covered here are the fault-injection list from the work order card:
 * prepared, extracted, merged, indexed, before the pointer rename, after the
 * pointer rename, and during cleanup — plus the `indexed` variants where the
 * staged artifact drifted, was damaged, or vanished.
 */
// ---------------------------------------------------------------------------
// Crash windows
// ---------------------------------------------------------------------------

test('crash at prepared: nothing is current and the journal is discarded', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(journal.phase, 'prepared');
    assert.equal(await readContextIndexPointer(root), null);

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'discard_temp');
    assert.equal(recovery.reason, 'phase_not_resumable');
    assert.equal(await fileExists(contextIndexOperationJournalPath(root)), false);
    await assert.rejects(resolveCurrentContextIndex(root), storeError('pointer_missing', 'context_index_missing'));
  });
});

test('crash at extracted or merged: the previous pointer is untouched and half-written bytes are removed', async () => {
  for (const phase of ['extracted', 'merged'] as const) {
    await withRoot(async (root) => {
      await compile(root, { target: HASH_A });
      const pointerBefore = await fsp.readFile(
        path.join(root, '.sneakoscope/wiki/context-graph/current.json'),
        'utf8',
      );

      const journal = await beginContextIndexOperation(root, {
        targetSnapshotHash: HASH_B,
        configFingerprint: CONFIG,
        sourceFingerprint: SOURCE_A,
      });
      const crashed = await advanceContextIndexOperation(root, journal, phase);
      // A compile that died mid-write leaves a truncated temp file behind.
      const tempIndexPath = contextIndexOperationTempPath(root, crashed);
      await fsp.mkdir(path.dirname(tempIndexPath), { recursive: true });
      await fsp.writeFile(tempIndexPath, buildIndexBytes(HASH_B).subarray(0, 64));

      const recovery = await recoverContextIndexOperation(root, {
        targetSnapshotHash: HASH_B,
        configFingerprint: CONFIG,
        sourceFingerprint: SOURCE_A,
      });
      assert.equal(recovery.action, 'discard_temp', phase);
      assert.equal(recovery.reason, 'phase_not_resumable', phase);
      assert.equal(recovery.resumableIndexPath, null);
      assert.equal(await fileExists(tempIndexPath), false);
      assert.equal(await fileExists(contextIndexOperationJournalPath(root)), false);

      const resolved = await resolveCurrentContextIndex(root);
      assert.equal(resolved.pointer.snapshotHash, HASH_A);
      assert.equal(
        await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph/current.json'), 'utf8'),
        pointerBefore,
      );
      assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_B)), false);
    });
  }
});

test('crash at indexed: the verified temp index is offered back and the pointer has not moved', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));
    assert.equal(staged.journal.phase, 'indexed');

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'resume_index');
    assert.equal(recovery.reason, 'resume_candidate');
    assert.equal(recovery.resumableIndexPath, staged.tempIndexPath);
    // The journal is left in place: the operation is resumable, not finished.
    const surviving = await readContextOperationJournalFile(contextIndexOperationJournalPath(root));
    assert.equal(surviving?.phase, 'indexed');
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_A);
    assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_B)), false);
  });
});

test('crash at indexed with source drift: the temp index is discarded, never resumed', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_B,
    });
    assert.equal(recovery.action, 'discard_temp');
    assert.equal(recovery.reason, 'fingerprint_drift');
    assert.equal(recovery.resumableIndexPath, null);
    assert.equal(await fileExists(staged.tempIndexPath), false);
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_A);
  });
});

test('crash at indexed with a damaged temp index: resume is refused on the checksum, not on the phase', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A));
    const damaged = await fsp.readFile(staged.tempIndexPath);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] as number) ^ 0xff;
    await fsp.writeFile(staged.tempIndexPath, damaged);

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'discard_temp');
    assert.equal(recovery.reason, 'temp_index_checksum_mismatch');
    assert.equal(await fileExists(staged.tempIndexPath), false);
  });
});

test('crash at indexed with a vanished temp index: recovery reports the absence instead of inventing one', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A));
    await fsp.rm(staged.tempIndexPath, { force: true });

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'discard_temp');
    assert.equal(recovery.reason, 'temp_index_missing');
  });
});

test('crash after the generation rename but before the pointer replace: the old generation stays current', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));
    await promoteContextIndexGeneration(root, staged, { lint: PASS });

    // The new generation exists on disk and the meta mirror already describes it,
    // but the pointer — the only thing a query follows — still names A.
    assert.ok(await fileExists(contextIndexGenerationPath(root, HASH_B)));
    assert.equal((await readContextIndexPointer(root))?.snapshotHash, HASH_A);
    assert.equal((await readContextIndexMeta(root))?.snapshotHash, HASH_B);

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'discard_temp');
    assert.equal(recovery.metaReconciled, true);

    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, HASH_A);
    assert.equal(resolved.meta.snapshotHash, HASH_A);
    // The unreferenced generation goes with the discarded operation.
    assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_B)), false);
    assert.ok(await fileExists(contextIndexGenerationPath(root, HASH_A)));
  });
});

test('crash before the first pointer ever exists: the store reports missing, not the staged generation', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A));
    await promoteContextIndexGeneration(root, staged, { lint: PASS });

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.metaReconciled, true);
    assert.equal(await fileExists(contextIndexMetaPath(root)), false);
    assert.deepEqual(await listContextIndexGenerations(root), []);
    await assert.rejects(resolveCurrentContextIndex(root), storeError('pointer_missing', 'context_index_missing'));
  });
});

test('crash after the pointer replace: recovery finishes the cleanup it owed', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));
    const promoted = await promoteContextIndexGeneration(root, staged, { lint: PASS });
    await publishContextIndexPointer(root, promoted);

    const committed = await readContextOperationJournalFile(contextIndexOperationJournalPath(root));
    assert.equal(committed?.phase, 'committed');

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'finish_commit');
    assert.equal(recovery.reason, 'commit_completed');
    assert.equal(await fileExists(contextIndexOperationJournalPath(root)), false);

    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, HASH_B);
    assert.equal(resolved.meta.snapshotHash, HASH_B);
    assert.equal(await fileExists(staged.tempIndexPath), false);
  });
});

test('crash during cleanup: the pruning is finished and retention lands back on two', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    await compile(root, { target: HASH_B });

    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_C,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_C));
    const result = await commitContextIndexGeneration(root, staged, { lint: PASS });
    // The journal reaches `cleaned` before the prune runs, so this is the state a
    // crash in the middle of deleting old generations leaves behind.
    await writeContextOperationJournalFile(
      contextIndexOperationJournalPath(root),
      advanceContextOperationPhase(result.journal, 'cleaned'),
    );
    assert.equal((await listContextIndexGenerations(root)).length, 3);

    const recovery = await recoverContextIndexOperation(root, {
      targetSnapshotHash: HASH_C,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(recovery.action, 'clear_journal');
    assert.equal(recovery.reason, 'stale_journal');
    assert.equal(recovery.removedGenerationFiles, 2);
    assert.deepEqual([...(await listContextIndexGenerations(root))].sort(), [HASH_B, HASH_C].sort());
    assert.equal(await fileExists(contextIndexOperationJournalPath(root)), false);
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_C);
  });
});

test('a corrupt journal blocks and is left exactly as found', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journalPath = contextIndexOperationJournalPath(root);
    const corrupt = '{"schema":"sks.context-graph-operation.v2","phase":"indexed"';
    await fsp.writeFile(journalPath, corrupt, 'utf8');

    await assert.rejects(
      recoverContextIndexOperation(root, {
        targetSnapshotHash: HASH_B,
        configFingerprint: CONFIG,
        sourceFingerprint: SOURCE_A,
      }),
      publicCodeIs('context_operation_journal_corrupt'),
    );

    // Fail closed: the corrupt bytes are evidence, not something to rewrite.
    assert.equal(await fsp.readFile(journalPath, 'utf8'), corrupt);
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_A);
    const events = await fsp.readFile(
      path.join(root, '.sneakoscope/wiki/context-graph-events.jsonl'),
      'utf8',
    );
    assert.ok(events.includes('compile.blocked'));
    assert.ok(events.includes('context_operation_journal_corrupt'));
  });
});
