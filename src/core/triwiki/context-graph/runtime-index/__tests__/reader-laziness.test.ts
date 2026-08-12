import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTEXT_INDEX_PROFILE_MASK_ALL, openContextIndex } from '../reader.js';
import { A, buildLargeIndex, openFixture } from './reader-fixtures.js';

/**
 * The proof that the reader is lazy.
 *
 * These are the only tests that can fail if someone reintroduces the per-edge
 * object or the materialized graph — every other test in the suite would still
 * pass against an implementation that parsed the whole file into objects and
 * answered from those. Weakening the comparison here would leave the card's
 * central claim unproven.
 */

/**
 * Heap delta around one measurement. The value is returned so the optimizer
 * cannot drop the work, and so retained allocations are still alive at the
 * second reading.
 */
function heapDelta(run: () => unknown): number {
  const before = process.memoryUsage().heapUsed;
  const held = run();
  const after = process.memoryUsage().heapUsed;
  assert.notEqual(held, undefined, 'the measured work must produce something');
  return after - before;
}

/**
 * Compares the subject's allocation against a baseline that deliberately does
 * allocate per item, so the claim is a ratio rather than a byte count copied
 * from whichever machine ran it first.
 *
 * A collection inside a sample makes that sample's delta meaningless — it can
 * even be negative — so a sample whose baseline did not grow is resampled
 * rather than read as evidence. An implementation that really allocates per
 * item fails every sample; raising the attempt count cannot rescue it.
 */
function assertAllocatesFarLess(
  label: string,
  subject: () => unknown,
  baseline: () => unknown,
  minimumBaselineBytes: number,
): void {
  let lastSubject = 0;
  let lastBaseline = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const baselineDelta = heapDelta(baseline);
    const subjectDelta = heapDelta(subject);
    lastBaseline = baselineDelta;
    lastSubject = subjectDelta;
    if (baselineDelta < minimumBaselineBytes) continue;
    if (subjectDelta * 4 < baselineDelta) return;
  }
  assert.fail(`${label}: allocated ${lastSubject} bytes against a per-item baseline of ${lastBaseline} bytes`);
}

test('traversing every edge allocates far less than one object per edge', () => {
  const bytes = buildLargeIndex(400, 50);
  const reader = openContextIndex(bytes);
  assert.ok(reader.edgeCount >= 19_000, `expected a large fixture, got ${reader.edgeCount}`);

  const walk = (): number => {
    let sum = 0;
    for (let node = 0; node < reader.nodeCount; node += 1) {
      const cursor = reader.outgoing(node, CONTEXT_INDEX_PROFILE_MASK_ALL);
      while (cursor.next()) sum += cursor.target + cursor.type + cursor.confidence + cursor.edge;
    }
    return sum;
  };
  walk();

  const materialize = (): unknown[] => {
    const sink: unknown[] = [];
    for (let node = 0; node < reader.nodeCount; node += 1) {
      const cursor = reader.outgoing(node, CONTEXT_INDEX_PROFILE_MASK_ALL);
      while (cursor.next()) {
        sink.push({ edge: cursor.edge, target: cursor.target, type: cursor.type, confidence: cursor.confidence });
      }
    }
    return sink;
  };

  assertAllocatesFarLess('cursor traversal', walk, materialize, 500_000);
});

test('opening an index does not build the object graph', () => {
  const bytes = buildLargeIndex(400, 50);
  openContextIndex(bytes);

  const materialize = (): unknown[] => {
    const reader = openContextIndex(bytes);
    const graph: unknown[] = [];
    for (let node = 0; node < reader.nodeCount; node += 1) graph.push(reader.hydrateNode(node));
    for (let edge = 0; edge < reader.edgeCount; edge += 1) graph.push(reader.hydrateEdge(edge));
    return graph;
  };
  assertAllocatesFarLess('opening an index', () => openContextIndex(bytes), materialize, 500_000);
});

test('the same reader answers the same question identically across calls', () => {
  // Lazy decoding is exactly what could make a second read differ from the
  // first, so repeat-stability is part of the laziness claim, not separate.
  const reader = openFixture();
  const first = reader.exact('file:src/a.ts');
  const second = reader.exact('file:src/a.ts');
  assert.equal(first.node(0), second.node(0));
  assert.deepEqual(reader.hydrateNode(A), reader.hydrateNode(A));
});
