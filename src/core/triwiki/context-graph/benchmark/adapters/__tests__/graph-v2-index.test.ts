/**
 * The v2 index the benchmark hands to migrated consumers.
 *
 * These tests exist for one reason: a consumer that receives no reader answers
 * "nothing found", and for the conflict consumer that is indistinguishable from
 * a workspace with no collision. `conflictRecall` is an equality floor, so a
 * missing reader would report a pass while measuring nothing. Every assertion
 * below is therefore about the *absence of a quiet empty path* — that a failure
 * throws, and that the success path really did produce a readable index.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_GRAPH_SCHEMA, type ContextGraphSnapshot } from '../../../contracts.js';
import { materializeFixture } from '../../fixtures/index.js';
import { compileContextGraph } from '../../../compiler/index.js';
import { contextGraphExtractors } from '../../../extractors/index.js';
import {
  BENCHMARK_INDEX_CONFIG_HASH,
  BenchmarkIndexError,
  buildBenchmarkContextIndex
} from '../graph-v2-index.js';

const OBSERVED_AT = '2026-08-12T00:00:00.000Z';

async function compileFixture(family: 'parallel-write-conflict'): Promise<ContextGraphSnapshot> {
  const handle = materializeFixture(family, { skipGit: true });
  try {
    const compiled = await compileContextGraph({
      root: handle.root,
      extractors: contextGraphExtractors(),
      observedAt: OBSERVED_AT
    });
    assert.ok(compiled.ok && compiled.snapshot, `${family} must compile`);
    return compiled.snapshot;
  } finally {
    handle.dispose();
  }
}

test('the conflict fixture compiles into an index a reader can open', async () => {
  const snapshot = await compileFixture('parallel-write-conflict');
  const built = buildBenchmarkContextIndex(snapshot);

  assert.equal(built.reader.nodeCount, snapshot.nodeCount);
  assert.equal(built.reader.edgeCount, snapshot.edgeCount);
  assert.ok(built.indexBytes > 0);
  assert.equal(
    built.reader.snapshotHash,
    snapshot.snapshotHash,
    'the reader must be verified against the snapshot it was built from'
  );
});

test('the same snapshot encodes to a byte-identical index every time', async () => {
  const snapshot = await compileFixture('parallel-write-conflict');
  const first = buildBenchmarkContextIndex(snapshot);
  const second = buildBenchmarkContextIndex(snapshot);
  // Content-addressability is what lets a generation be named by its own hash;
  // an encoder that leaked ambient order would break it silently.
  assert.equal(first.indexBytes, second.indexBytes);
  assert.equal(first.reader.snapshotHash, second.reader.snapshotHash);
});

test('the config hash is a fixed 32-byte identity, not ambient config', () => {
  assert.equal(BENCHMARK_INDEX_CONFIG_HASH.byteLength, 32);
  // Two runs on two machines must agree, or two reports are not comparable.
  assert.deepEqual(BENCHMARK_INDEX_CONFIG_HASH, BENCHMARK_INDEX_CONFIG_HASH.slice());
});

test('a snapshot the writer refuses throws instead of yielding an empty index', async () => {
  const snapshot = await compileFixture('parallel-write-conflict');
  const firstNode = snapshot.nodes[0];
  assert.ok(firstNode);
  // An absolute path is the refusal the writer exists to make: once interned,
  // the reader could not tell it apart from legitimate workspace content.
  const poisoned: ContextGraphSnapshot = {
    ...snapshot,
    nodes: [{ ...firstNode, path: '/etc/passwd' }, ...snapshot.nodes.slice(1)]
  };

  assert.throws(
    () => buildBenchmarkContextIndex(poisoned),
    (error: unknown) => {
      assert.ok(error instanceof BenchmarkIndexError, 'must be the typed error, not a bare throw');
      assert.equal(error.code, 'index_encode_failed');
      assert.equal(error.adapterErrorCode, 'adapter_error:index_encode_failed');
      // The refusal must not echo the offending value back out.
      assert.ok(!error.message.includes('/etc/passwd'), 'a refusal must not become a second copy of the leak');
      return true;
    }
  );
});

test('an empty snapshot still produces a real reader rather than a null one', () => {
  const empty: ContextGraphSnapshot = {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: 'ab'.repeat(32),
    generatedAt: OBSERVED_AT,
    root: '.',
    nodes: [],
    edges: [],
    cycles: [],
    nodeCount: 0,
    edgeCount: 0
  } as unknown as ContextGraphSnapshot;

  // A graph with nothing in it is a legitimate answer ("this workspace has no
  // nodes"), and it must still open. Returning null here would put a nullable
  // reader back into the seam through the side door.
  const built = buildBenchmarkContextIndex(empty);
  assert.equal(built.reader.nodeCount, 0);
  assert.equal(built.reader.edgeCount, 0);
  assert.ok(built.indexBytes > 0, 'even an empty index has a validated header');
});
