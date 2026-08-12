import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_NODE_KINDS,
  type ContextGraphEdgeConfidence,
  type ContextGraphFreshness,
  type ContextGraphNode,
  type ContextGraphRisk,
} from '../../contracts.js';
import {
  CONTEXT_INDEX_EDGE_ROW_BYTES,
  CONTEXT_INDEX_METADATA_ROW_BYTES,
  CONTEXT_INDEX_NODE_ROW_BYTES,
  CONTEXT_INDEX_TERM_ROW_BYTES,
} from '../writer.js';
import { CONTEXT_INDEX_PROFILE_MASK_ALL, openContextIndex } from '../reader.js';
import {
  A,
  B,
  CONFIG_HASH_HEX,
  FIXTURE_EDGES,
  FIXTURE_NODES,
  GATE,
  SNAPSHOT_HASH,
  SYMBOL,
  encode,
  makeEdge,
  makeNode,
  makeSnapshot,
  openFixture,
} from './reader-fixtures.js';

/**
 * The reader's job is to answer questions about a graph it never builds. Every
 * test here is the same claim in a different place: the answer matches the
 * snapshot the writer was given, without the reader ever holding the graph.
 *
 * Refusal of impossible files lives in `reader-corrupt.test.ts`; the allocation
 * proofs live in `reader-laziness.test.ts`.
 */

test('an index round-trips its header facts', () => {
  const reader = openFixture();
  assert.equal(reader.snapshotHash, SNAPSHOT_HASH);
  assert.equal(reader.configHash, CONFIG_HASH_HEX);
  assert.equal(reader.nodeCount, FIXTURE_NODES.length);
  assert.equal(reader.edgeCount, FIXTURE_EDGES.length);
  assert.equal(reader.termCount, FIXTURE_NODES.length);
});

test('an exact term resolves to the node the writer interned', () => {
  const reader = openFixture();
  const hit = reader.exact('gate:release:proof');
  assert.equal(hit.length, 1);
  assert.equal(hit.node(0), GATE);
  assert.equal(reader.exact('file:src/a.ts').node(0), A);
  assert.equal(reader.exact('symbol:src/a.ts#run').node(0), SYMBOL);
  assert.equal(reader.exact('no-such-node').length, 0);
});

test('an empty field mask returns nothing rather than silently matching everything', () => {
  const reader = openFixture();
  assert.equal(reader.exact('file:src/a.ts', 0).length, 0);
  assert.equal(reader.exact('file:src/a.ts', 1).length, 1);
});

test('the basename lane returns every node sharing a path, in node order', () => {
  const reader = openFixture();
  const hits = reader.basename('src/a.ts');
  assert.equal(hits.length, 2);
  assert.deepEqual([hits.node(0), hits.node(1)], [A, SYMBOL]);
  assert.equal(reader.basename('src/missing.ts').length, 0);
});

test('a term resolves to the id the scored lanes take, and to -1 when unseen', () => {
  const reader = openFixture();
  // The id space is the string table, and the exact lane is keyed by the same
  // ids — so resolving a term and looking it up must agree, or the lexical
  // lanes would be searching a different dictionary than the anchor lane.
  const id = reader.termId('gate:release:proof');
  assert.ok(id >= 0 && id < reader.stringCount);
  assert.equal(reader.exact('gate:release:proof').node(0), GATE);
  assert.equal(reader.termId('never-interned'), -1);
  // Ids follow the interner's UTF-16 code-unit order, which is what lets a
  // term table be binary-searched by id.
  assert.ok(reader.termId('file:src/a.ts') < reader.termId('file:src/b.ts'));
});

test('a posting index outside the run throws instead of reading the next term', () => {
  const reader = openFixture();
  const hits = reader.exact('file:src/a.ts');
  assert.throws(() => hits.node(1), RangeError);
  assert.throws(() => hits.node(-1), RangeError);
});

test('hydrateNode materializes exactly the node the snapshot carried', () => {
  const reader = openFixture();
  const view = reader.hydrateNode(A);
  assert.equal(view.id, 'file:src/a.ts');
  assert.equal(view.kind, 'file');
  assert.equal(view.label, 'a.ts');
  assert.equal(view.path, 'src/a.ts');
  assert.equal(view.contentHash, 'sha256:aaaa');
  assert.equal(view.tokenCost, 120);
  assert.equal(view.freshness, 'fresh');
  assert.equal(view.risk, 'low');
  assert.ok(Math.abs(view.trust - 0.5) < 1e-4);
  assert.deepEqual({ ...view.metadata }, { language: 'ts', tags: 'core,query' });
  assert.equal(view.line, undefined);

  const symbol = reader.hydrateNode(SYMBOL);
  assert.equal(symbol.line, 12);
  assert.equal(symbol.column, 3);
  assert.equal(symbol.kind, 'symbol');

  const gate = reader.hydrateNode(GATE);
  assert.equal(gate.path, undefined);
  assert.equal(gate.contentHash, undefined);
  assert.equal(gate.risk, 'protected');
  assert.equal(gate.freshness, 'stale');
  assert.deepEqual({ ...gate.metadata }, {});
});

test('scalar node accessors agree with the hydrated view without building one', () => {
  const reader = openFixture();
  for (let node = 0; node < reader.nodeCount; node += 1) {
    const view = reader.hydrateNode(node);
    const fields = reader.nodeScoreFields(node);
    assert.equal(reader.nodeFlags(node), view.flags);
    assert.equal(reader.nodeTokenCost(node), view.tokenCost);
    assert.equal(reader.nodeGroup(node), view.group);
    assert.equal(reader.nodeKind(node), CONTEXT_GRAPH_NODE_KINDS.indexOf(view.kind));
    assert.equal(fields.flags, view.flags);
    assert.equal(fields.tokenCost, view.tokenCost);
    assert.equal(fields.trust, reader.nodeTrust(node));
    assert.equal(fields.outDegree, reader.outDegree(node));
    assert.equal(fields.inDegree, reader.inDegree(node));
  }
  assert.equal(reader.outDegree(A), 2);
  assert.equal(reader.inDegree(GATE), 1);
  assert.throws(() => reader.nodeFlags(reader.nodeCount), RangeError);
  assert.throws(() => reader.nodeFlags(-1), RangeError);
});

test('outgoing traversal yields the snapshot edges and nothing else', () => {
  const reader = openFixture();
  const cursor = reader.outgoing(A, CONTEXT_INDEX_PROFILE_MASK_ALL);
  assert.equal(cursor.source, A);
  assert.equal(cursor.edge, -1);
  const seen: Array<[number, string]> = [];
  while (cursor.next()) {
    seen.push([cursor.target, CONTEXT_GRAPH_EDGE_TYPES[cursor.type] as string]);
  }
  assert.deepEqual(seen, [[B, 'imports'], [SYMBOL, 'defines']]);
  assert.equal(cursor.edge, -1, 'an exhausted cursor holds no edge');
  assert.equal(cursor.visited, 2);
  assert.equal(reader.outgoing(GATE, CONTEXT_INDEX_PROFILE_MASK_ALL).next(), false);
});

test('incoming traversal reports the edge source the row never stored', () => {
  const reader = openFixture();
  const cursor = reader.incoming(GATE, CONTEXT_INDEX_PROFILE_MASK_ALL);
  assert.equal(cursor.next(), true);
  assert.equal(cursor.target, SYMBOL);
  assert.equal(CONTEXT_GRAPH_EDGE_TYPES[cursor.type], 'verified_by');
  assert.equal(cursor.next(), false);

  const intoSymbol = reader.incoming(SYMBOL, CONTEXT_INDEX_PROFILE_MASK_ALL);
  assert.equal(intoSymbol.next(), true);
  assert.equal(intoSymbol.target, A);
});

test('a profile mask that matches no edge yields nothing but still counts the rows', () => {
  const reader = openFixture();
  const cursor = reader.outgoing(A, 0);
  assert.equal(cursor.next(), false);
  assert.equal(cursor.visited, 2, 'filtered rows still cost an edge visit');
});

test('hydrateEdge and provenance resolve the interned strings', () => {
  const reader = openFixture();
  const cursor = reader.outgoing(SYMBOL, CONTEXT_INDEX_PROFILE_MASK_ALL);
  assert.equal(cursor.next(), true);
  const edge = reader.hydrateEdge(cursor.edge);
  assert.equal(edge.target, GATE);
  assert.equal(edge.type, 'verified_by');
  assert.equal(edge.confidence, 'manifest');
  assert.equal(edge.provenance.path, 'release-gates.v2.json');
  assert.equal(edge.provenance.hash, 'sha256:dddd');
  assert.equal(edge.provenance.extractor, 'gate-manifest');
  assert.throws(() => reader.hydrateEdge(reader.edgeCount), RangeError);
});

test('a node carries its own provenance so a seed is never reported unattested', () => {
  const reader = openFixture();
  const seed = reader.provenance(A, []);
  assert.equal(seed.length, 1);
  assert.equal(seed[0]?.path, 'src/a.ts');
  assert.equal(seed[0]?.hash, 'sha256:aaaa');
  assert.equal(seed[0]?.extractor, undefined);

  // A gate has no path of its own; the parent edge is what grounds it.
  const cursor = reader.incoming(GATE, CONTEXT_INDEX_PROFILE_MASK_ALL);
  assert.equal(cursor.next(), true);
  const gated = reader.provenance(GATE, [cursor.edge, cursor.edge]);
  assert.equal(gated.length, 1, 'a repeated parent edge is one provenance record');
  assert.equal(gated[0]?.path, 'release-gates.v2.json');
  assert.equal(gated[0]?.extractor, 'gate-manifest');
});

test('compile-time source hashes keep every claim a path carries', () => {
  const reader = openFixture();
  const hashes = reader.sourceHashes().map((entry) => `${entry.path}=${entry.hash}`).sort();
  // `src/a.ts` is hashed twice — once as a file, once as the symbol inside it.
  // Collapsing that to one entry would drop evidence the validator must check.
  assert.deepEqual(hashes, [
    'src/a.ts=sha256:aaaa',
    'src/a.ts=sha256:cccc',
    'src/b.ts=sha256:bbbb',
  ]);
  assert.equal(hashes.some((entry) => entry.startsWith('gate:')), false);
});

test('every enum value survives the writer/reader round trip', () => {
  // The reader duplicates the writer's private code tables. This is the test
  // that fails if either side reorders one.
  const nodes = CONTEXT_GRAPH_NODE_KINDS.map((kind, index) => makeNode({
    id: `${String(index).padStart(2, '0')}:${kind}`,
    kind,
    freshness: (['fresh', 'stale', 'unknown'] as const)[index % 3] as ContextGraphFreshness,
    risk: (['low', 'medium', 'high', 'protected'] as const)[index % 4] as ContextGraphRisk,
  }));
  const confidences: readonly ContextGraphEdgeConfidence[] = ['exact', 'syntactic', 'manifest', 'observed', 'derived'];
  const edges = CONTEXT_GRAPH_EDGE_TYPES.map((type, index) => makeEdge({
    from: nodes[index % nodes.length]?.id as string,
    to: nodes[(index + 1) % nodes.length]?.id as string,
    type,
    confidence: confidences[index % confidences.length] as ContextGraphEdgeConfidence,
  }));
  const reader = openContextIndex(encode(makeSnapshot(nodes, edges)));

  const seenKinds = new Set<string>();
  const seenFreshness = new Set<string>();
  const seenRisk = new Set<string>();
  for (let node = 0; node < reader.nodeCount; node += 1) {
    const view = reader.hydrateNode(node);
    const original = nodes.find((entry) => entry.id === view.id) as ContextGraphNode;
    assert.equal(view.kind, original.kind);
    assert.equal(view.freshness, original.freshness);
    assert.equal(view.risk, original.risk);
    seenKinds.add(view.kind);
    seenFreshness.add(view.freshness);
    seenRisk.add(view.risk);
  }
  assert.equal(seenKinds.size, CONTEXT_GRAPH_NODE_KINDS.length);
  assert.equal(seenFreshness.size, 3);
  assert.equal(seenRisk.size, 4);

  const seenTypes = new Set<string>();
  const seenConfidence = new Set<string>();
  for (let edge = 0; edge < reader.edgeCount; edge += 1) {
    const view = reader.hydrateEdge(edge);
    seenTypes.add(view.type);
    seenConfidence.add(view.confidence);
  }
  assert.equal(seenTypes.size, CONTEXT_GRAPH_EDGE_TYPES.length);
  assert.equal(seenConfidence.size, confidences.length);
});

test('an index with no nodes and no edges opens and answers empty', () => {
  const reader = openContextIndex(encode(makeSnapshot([], [])));
  assert.equal(reader.nodeCount, 0);
  assert.equal(reader.edgeCount, 0);
  assert.equal(reader.exact('anything').length, 0);
  assert.equal(reader.lexical([0, 1], { postingCapPerTerm: 8, candidateBudget: 8 }).length, 0);
  assert.throws(() => reader.outgoing(0, CONTEXT_INDEX_PROFILE_MASK_ALL), RangeError);
});

test('the row layouts the reader decodes are the ones the writer declares', () => {
  // A silent stride change in the writer would make every field read garbage
  // that still passes every bounds check.
  assert.equal(CONTEXT_INDEX_NODE_ROW_BYTES, 40);
  assert.equal(CONTEXT_INDEX_EDGE_ROW_BYTES, 16);
  assert.equal(CONTEXT_INDEX_TERM_ROW_BYTES, 12);
  assert.equal(CONTEXT_INDEX_METADATA_ROW_BYTES, 12);
});
