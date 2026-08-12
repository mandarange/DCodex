import assert from 'node:assert/strict';
import test from 'node:test';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTEXT_INDEX_FORMAT_REVISION } from '../../runtime-index/format.js';
import {
  ContextIndexStoreError,
  beginContextIndexOperation,
  cleanContextIndexOperation,
  commitContextIndexGeneration,
  contextIndexGenerationMetaPath,
  contextIndexGenerationPath,
  contextIndexGenerationsDir,
  contextIndexMetaPath,
  contextIndexOperationJournalPath,
  contextIndexOperationTempPath,
  listContextIndexGenerations,
  readContextIndexMeta,
  readContextIndexPointer,
  recoverContextIndexOperation,
  resolveCurrentContextIndex,
  stageContextIndexGeneration,
} from '../generation-store.js';
import {
  CONFIG,
  EDGE_COUNT,
  HASH_A,
  HASH_B,
  HASH_C,
  NODE_COUNT,
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
 * The store's steady-state behaviour: what a healthy commit produces, what it
 * refuses, and what it never writes into the workspace. Crash windows live in
 * `generation-store-crash.test.ts`.
 */

// ---------------------------------------------------------------------------
// Normal path
// ---------------------------------------------------------------------------
test('a committed generation is content-addressed and the pointer agrees with the meta', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });

    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, HASH_A);
    assert.equal(resolved.pointer.previousSnapshotHash, null);
    assert.equal(resolved.meta.snapshotHash, HASH_A);
    assert.equal(resolved.meta.nodeCount, NODE_COUNT);
    assert.equal(resolved.meta.edgeCount, EDGE_COUNT);
    assert.equal(resolved.generationPath, contextIndexGenerationPath(root, HASH_A));
    assert.equal(resolved.pointer.generationPath, `.sneakoscope/wiki/context-graph/generations/${HASH_A}.idx`);
    assert.ok(await fileExists(resolved.generationPath));
    // The journal exists only during a compile; a query must never find one.
    assert.equal(await fileExists(contextIndexOperationJournalPath(root)), false);
  });
});

test('the previous hash is recorded in small metadata, not by keeping a second pointer', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    await compile(root, { target: HASH_B });
    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, HASH_B);
    assert.equal(resolved.pointer.previousSnapshotHash, HASH_A);
    assert.equal(resolved.meta.previousSnapshotHash, HASH_A);
  });
});

test('exactly two generations survive a compile', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    await compile(root, { target: HASH_B });
    await compile(root, { target: HASH_C });

    assert.deepEqual([...(await listContextIndexGenerations(root))].sort(), [HASH_B, HASH_C].sort());
    const entries = await fsp.readdir(contextIndexGenerationsDir(root));
    assert.equal(entries.length, 4);
    assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_A)), false);
    assert.equal(await fileExists(contextIndexGenerationMetaPath(root, HASH_A)), false);
  });
});

test('re-running the same operation is idempotent and does not rewrite the pointer', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const before = await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph/current.json'), 'utf8');

    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A));
    const result = await commitContextIndexGeneration(root, staged, { lint: PASS });
    await cleanContextIndexOperation(root, result.journal);

    assert.equal(result.committed, false);
    assert.equal(result.reason, 'already_current');
    const after = await fsp.readFile(path.join(root, '.sneakoscope/wiki/context-graph/current.json'), 'utf8');
    assert.equal(after, before);
  });
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

test('a torn temp index is caught by its section checksums and never promoted', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));

    const torn = await fsp.readFile(staged.tempIndexPath);
    torn[torn.length - 3] = (torn[torn.length - 3] as number) ^ 0x5a;
    await fsp.writeFile(staged.tempIndexPath, torn);

    await assert.rejects(
      commitContextIndexGeneration(root, staged, { lint: PASS }),
      publicCodeIs('context_index_checksum_mismatch'),
    );
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_A);
    assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_B)), false);
  });
});

test('a structurally valid replacement is still refused: the whole-file checksum is what was recorded', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A, 'first'));
    await fsp.writeFile(staged.tempIndexPath, buildIndexBytes(HASH_A, 'second'));

    await assert.rejects(
      commitContextIndexGeneration(root, staged, { lint: PASS }),
      storeError('generation_checksum_mismatch', 'context_index_checksum_mismatch'),
    );
    assert.equal(await readContextIndexPointer(root), null);
  });
});

test('an index whose header claims a different snapshot cannot be filed under this content address', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    await assert.rejects(
      stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B)),
      storeError('generation_identity_mismatch', 'context_index_checksum_mismatch'),
    );
  });
});

test('a failed lint stops the commit before anything becomes current', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));

    await assert.rejects(
      commitContextIndexGeneration(root, staged, {
        lint: { passed: false, errorCount: 2, warningCount: 0 },
      }),
      storeError('lint_not_passed', 'context_index_commit_blocked'),
    );
    assert.equal((await resolveCurrentContextIndex(root)).pointer.snapshotHash, HASH_A);
    assert.equal(await fileExists(contextIndexGenerationPath(root, HASH_B)), false);
  });
});

test('a failed lint is not a successful compile even when the result is already current', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_A));
    await assert.rejects(
      commitContextIndexGeneration(root, staged, { lint: { passed: true, errorCount: 1, warningCount: 0 } }),
      storeError('lint_not_passed', 'context_index_commit_blocked'),
    );
  });
});

test('pointer and meta divergence is raised, not resolved by preferring one of them', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const meta = await readContextIndexMeta(root);
    assert.ok(meta);
    await fsp.writeFile(
      contextIndexMetaPath(root),
      JSON.stringify({ ...meta, configFingerprint: 'f0'.repeat(16) }, null, 2),
      'utf8',
    );
    await assert.rejects(
      resolveCurrentContextIndex(root),
      storeError('pointer_meta_divergent', 'context_index_pointer_meta_divergent'),
    );
  });
});

test('the previous generation is not a rollback target', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    await compile(root, { target: HASH_B });
    await fsp.rm(contextIndexGenerationPath(root, HASH_B), { force: true });

    await assert.rejects(
      resolveCurrentContextIndex(root),
      storeError('generation_missing', 'context_index_missing'),
    );
    // The previous generation is still on disk for incremental merge and audit —
    // being available is precisely why refusing to serve it has to be explicit.
    assert.ok(await fileExists(contextIndexGenerationPath(root, HASH_A)));
  });
});

test('a generation that lost bytes since commit is reported as truncated', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const generationPath = contextIndexGenerationPath(root, HASH_A);
    const bytes = await fsp.readFile(generationPath);
    await fsp.writeFile(generationPath, bytes.subarray(0, bytes.length - 8));

    await assert.rejects(
      resolveCurrentContextIndex(root),
      storeError('generation_size_mismatch', 'context_index_truncated'),
    );
  });
});

test('a stale source fingerprint is an error with a repair command, not a downgrade', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A, source: SOURCE_A });
    await assert.rejects(
      resolveCurrentContextIndex(root, { expectedSourceFingerprint: SOURCE_B }),
      storeError('source_fingerprint_stale', 'context_index_stale'),
    );
  });
});

test('a pointer from a newer format revision is unsupported, not corrupt', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    const pointerPath = path.join(root, '.sneakoscope/wiki/context-graph/current.json');
    const pointer = JSON.parse(await fsp.readFile(pointerPath, 'utf8')) as Record<string, unknown>;
    await fsp.writeFile(
      pointerPath,
      JSON.stringify({ ...pointer, formatRevision: CONTEXT_INDEX_FORMAT_REVISION + 1 }, null, 2),
      'utf8',
    );
    await assert.rejects(resolveCurrentContextIndex(root), (error: unknown) => {
      assert.ok(error instanceof ContextIndexStoreError);
      assert.equal(error.code, 'format_revision_unsupported');
      assert.equal(error.publicCode, 'context_index_format_unsupported');
      assert.equal(error.repairCommand, 'sks update');
      return true;
    });
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('a second operation cannot open while one is in flight', async () => {
  await withRoot(async (root) => {
    await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    await assert.rejects(
      beginContextIndexOperation(root, {
        targetSnapshotHash: HASH_B,
        configFingerprint: CONFIG,
        sourceFingerprint: SOURCE_A,
      }),
      storeError('operation_in_flight', 'context_index_commit_blocked'),
    );
  });
});

test('a writer whose base pointer moved cannot commit over the winner', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });

    // Compiler one starts from A and stages its index.
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_B,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    const staged = await stageContextIndexGeneration(root, journal, buildIndexBytes(HASH_B));

    // Compiler two commits C in the meantime.
    await fsp.rm(contextIndexOperationJournalPath(root), { force: true });
    await compile(root, { target: HASH_C });

    await assert.rejects(
      commitContextIndexGeneration(root, staged, { lint: PASS }),
      storeError('stale_writer', 'context_index_commit_blocked'),
    );
    const resolved = await resolveCurrentContextIndex(root);
    assert.equal(resolved.pointer.snapshotHash, HASH_C);
    assert.equal(resolved.pointer.previousSnapshotHash, HASH_A);
  });
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test('nothing the store writes carries an absolute, home, or temp path', async () => {
  await withRoot(async (root) => {
    await compile(root, { target: HASH_A });
    await compile(root, { target: HASH_B });

    const written = [
      path.join(root, '.sneakoscope/wiki/context-graph/current.json'),
      contextIndexMetaPath(root),
      contextIndexGenerationMetaPath(root, HASH_B),
      path.join(root, '.sneakoscope/wiki/context-graph-events.jsonl'),
    ];
    for (const target of written) {
      const text = await fsp.readFile(target, 'utf8');
      assert.ok(!text.includes(root), target);
      assert.ok(!text.includes(os.tmpdir()), target);
      assert.ok(!text.includes(os.homedir()), target);
      assert.ok(!/"[^"]*\/(?:var|tmp|Users|home)\//.test(text), target);
    }
  });
});

test('a journal that points outside the workspace is refused before any path is joined', async () => {
  await withRoot(async (root) => {
    const journal = await beginContextIndexOperation(root, {
      targetSnapshotHash: HASH_A,
      configFingerprint: CONFIG,
      sourceFingerprint: SOURCE_A,
    });
    assert.equal(journal.tempIndex.startsWith('.sneakoscope/cache/context-graph/operations/'), true);
    assert.equal(
      contextIndexOperationTempPath(root, journal),
      path.join(root, journal.tempIndex),
    );
    await fsp.writeFile(
      contextIndexOperationJournalPath(root),
      JSON.stringify({ ...journal, tempIndex: '../outside.idx' }, null, 2),
      'utf8',
    );
    await assert.rejects(
      recoverContextIndexOperation(root, {
        targetSnapshotHash: HASH_A,
        configFingerprint: CONFIG,
        sourceFingerprint: SOURCE_A,
      }),
      publicCodeIs('context_operation_journal_corrupt'),
    );
  });
});
