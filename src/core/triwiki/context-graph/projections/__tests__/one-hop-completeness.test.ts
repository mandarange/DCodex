/**
 * A one-hop projection answer is complete, or it says it is not — and it does not
 * depend on how the index happened to store its adjacency.
 *
 * Two defects of one shape, both in `graph-facts.ts`:
 *
 * - `contextOneHopNeighbours` discarded `walk.truncated`, so a node past
 *   `PROJECTION_ONE_HOP_CAPS` returned a subset that read exactly like a complete
 *   neighbourhood, and `module-view.ts` restated the subset's size as the
 *   module's file count in text that `index_digest` hashes.
 * - Both it and `contextGroundedProvenance` answered in *adjacency order*, which
 *   is ascending node id only because `runtime-index/writer.ts` sorts its CSR
 *   buckets by target index. Nothing in the projections said so, so a writer that
 *   re-sorted buckets would move module citations and anchor `source_hash`es with
 *   nothing failing.
 *
 * The ordering cases run every projection twice over the *same index*, once
 * through a reader whose edge buckets replay in reverse. That is the only way to
 * test the claim: the encoder always sorts, so no snapshot permutation can
 * produce a differently-ordered index — reversing the snapshot's node and edge
 * arrays and re-encoding is byte-identical. A reversed cursor is exactly the
 * writer change the ordering rule exists to survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ContextGraphEdge,
  ContextGraphNode,
  ContextGraphSnapshot
} from '../../contracts.js';
import { buildContextGraphSnapshot } from '../../compiler/serialize.js';
import { contextGraphEdgeId, contextGraphNodeId } from '../../ids.js';
import { contextGraphQueryProfile } from '../../profiles.js';
import { HydrationCursor, type ContextIndexReader, type EdgeCursor } from '../../query/index.js';
import { CONTEXT_GRAPH_RANKING_CONFIG } from '../../query/ranking-config.js';
import {
  PROJECTION_ALL_EDGE_TYPES,
  PROJECTION_ONE_HOP_CAPS,
  contextGroundedProvenance,
  contextOneHopNeighbours
} from '../graph-facts.js';
import { rankModuleCandidates } from '../module-view.js';
import { HUB_FILE, HUB_MODULE_LABEL, removeProjectionFixture } from './projection-fixtures.js';
import { createIndexedProjectionFixture } from './projection-index-fixtures.js';

const HUB_MODULE_DIR = 'src/core/hooks';
const HUB_MODULE_ID = contextGraphNodeId({ kind: 'module', moduleId: HUB_MODULE_DIR });
/** Comfortably past `PROJECTION_ONE_HOP_CAPS.maxNodes` (512, one of which is the root). */
const SYNTHETIC_FILES = 600;

interface EdgeRow {
  readonly edge: number;
  readonly target: number;
  readonly type: number;
  readonly confidence: number;
  readonly flags: number;
  readonly provenance: number;
}

/** Replays a bucket back-to-front, which is all a different CSR comparator would do. */
function reversedCursor(cursor: EdgeCursor, source: number): EdgeCursor {
  const rows: EdgeRow[] = [];
  while (cursor.next()) {
    rows.push({
      edge: cursor.edge,
      target: cursor.target,
      type: cursor.type,
      confidence: cursor.confidence,
      flags: cursor.flags,
      provenance: cursor.provenance
    });
  }
  rows.reverse();
  let at = -1;
  const row = (): EdgeRow | undefined => rows[at];
  return {
    source,
    get edge(): number { return row()?.edge ?? -1; },
    get target(): number { return row()?.target ?? -1; },
    get type(): number { return row()?.type ?? -1; },
    get confidence(): number { return row()?.confidence ?? 0; },
    get flags(): number { return row()?.flags ?? 0; },
    get provenance(): number { return row()?.provenance ?? -1; },
    get visited(): number { return Math.min(at + 1, rows.length); },
    next(): boolean {
      if (at >= rows.length - 1) {
        at = rows.length;
        return false;
      }
      at += 1;
      return true;
    }
  };
}

/** The same index, read as though its buckets had been written in the other order. */
function withReversedBuckets(reader: ContextIndexReader): ContextIndexReader {
  return new Proxy(reader, {
    get(target, property, _receiver): unknown {
      if (property === 'outgoing') {
        return (node: number, mask: number): EdgeCursor => reversedCursor(target.outgoing(node, mask), node);
      }
      if (property === 'incoming') {
        return (node: number, mask: number): EdgeCursor => reversedCursor(target.incoming(node, mask), node);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
  }) as ContextIndexReader;
}

function nodeIndexOf(reader: ContextIndexReader, id: string): number {
  const postings = reader.exact(id);
  assert.ok(postings.length > 0, `the fixture must contain ${id}`);
  return postings.node(0);
}

function moduleCandidateText(reader: ContextIndexReader, cursor: HydrationCursor, label: string): string {
  const candidates = rankModuleCandidates(reader, cursor, contextGraphQueryProfile('implementation'), 'normal');
  const found = candidates.find((candidate) => candidate.node.label === label);
  assert.ok(found, `no module candidate for ${label}`);
  return found.text;
}

/**
 * The hub module, widened past the node cap.
 *
 * The synthetic files are graph rows only — nothing reads their bytes in this
 * projection — but they carry the hub file's real path and hash as provenance so
 * every edge is as well-formed as the compiler's own. `fileCount` is set to the
 * module's true size, which is the fact the headline must prefer once the walk
 * can no longer see all of it.
 */
function inflateHubModule(count: number) {
  return (snapshot: ContextGraphSnapshot): ContextGraphSnapshot => inflatedSnapshot(snapshot, count);
}

function inflatedSnapshot(snapshot: ContextGraphSnapshot, count: number): ContextGraphSnapshot {
  const hub = snapshot.nodes.find((node) => node.id === HUB_MODULE_ID);
  assert.ok(hub, 'the projection fixture must have a hub module');
  const hubFile = snapshot.nodes.find((node) => node.path === HUB_FILE && node.kind === 'file');
  assert.ok(hubFile?.contentHash, 'the hub file must be byte-backed');
  const hash = hubFile.contentHash;

  const existing = snapshot.edges.filter((edge) => edge.from === HUB_MODULE_ID && edge.type === 'contains').length;
  const nodes: ContextGraphNode[] = [];
  const edges: ContextGraphEdge[] = [];
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const relative = `${HUB_MODULE_DIR}/generated/part-${String(ordinal).padStart(4, '0')}.ts`;
    const id = contextGraphNodeId({ kind: 'file', path: relative });
    nodes.push({
      id,
      kind: 'file',
      label: `part-${String(ordinal).padStart(4, '0')}.ts`,
      path: relative,
      contentHash: hash,
      trust: 1,
      freshness: 'fresh',
      risk: 'low',
      tokenCost: 8,
      metadata: { language: 'typescript', lines: 3, bytes: 40, fanIn: 0, isTest: false }
    });
    edges.push({
      id: contextGraphEdgeId({ from: HUB_MODULE_ID, to: id, type: 'contains' }),
      from: HUB_MODULE_ID,
      to: id,
      type: 'contains',
      confidence: 'exact',
      provenance: { path: HUB_FILE, line: 1, hash, extractor: 'projection-fixture' },
      observedAt: '2026-02-02T00:00:00.000Z'
    });
  }

  const rewritten = snapshot.nodes.map((node) =>
    node.id === HUB_MODULE_ID
      ? { ...node, metadata: { ...node.metadata, fileCount: existing + count } }
      : node
  );
  return buildContextGraphSnapshot({
    nodes: [...rewritten, ...nodes],
    edges: [...snapshot.edges, ...edges],
    cycles: [...snapshot.cycles],
    extractors: [...snapshot.extractors]
  });
}

test('a one-hop answer is ordered by canonical node id, not by bucket order', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 3 }, inflateHubModule(6));
  try {
    const reversed = withReversedBuckets(fixture.reader);
    const reversedCursorView = new HydrationCursor(reversed);
    const moduleNode = nodeIndexOf(fixture.reader, HUB_MODULE_ID);

    const forward = contextOneHopNeighbours(
      fixture.reader, fixture.cursor, moduleNode, HUB_MODULE_ID, PROJECTION_ALL_EDGE_TYPES
    );
    const backward = contextOneHopNeighbours(
      reversed, reversedCursorView, moduleNode, HUB_MODULE_ID, PROJECTION_ALL_EDGE_TYPES
    );

    assert.ok(forward.neighbours.length > 2, 'a two-neighbour bucket barely shows an ordering rule');
    const ids = forward.neighbours.map((neighbour) => neighbour.view.id);
    assert.deepEqual(ids, [...ids].sort(), 'neighbours must be in ascending canonical node id');
    assert.deepEqual(
      backward.neighbours.map((neighbour) => `${neighbour.type}:${neighbour.view.id}`),
      forward.neighbours.map((neighbour) => `${neighbour.type}:${neighbour.view.id}`),
      'the answer must not depend on the order the index stores its edges in'
    );

    // The consumer consequence: which files a module cites, and the sentence the
    // pack ships, must both be invariant under the same reversal.
    assert.equal(
      moduleCandidateText(reversed, reversedCursorView, HUB_MODULE_LABEL),
      moduleCandidateText(fixture.reader, fixture.cursor, HUB_MODULE_LABEL)
    );
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('grounded provenance picks the same incident edge under either bucket order', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 1 });
  try {
    const reversed = withReversedBuckets(fixture.reader);
    const reversedCursorView = new HydrationCursor(reversed);
    const limit = Math.max(1, CONTEXT_GRAPH_RANKING_CONFIG.maxProvenancePerNode);

    const moduleNode = fixture.cursor.node(nodeIndexOf(fixture.reader, HUB_MODULE_ID));
    assert.ok(moduleNode, 'the hub module must hydrate');
    // A module addresses a directory, so it has no source record of its own and
    // this is the incident-edge fallback — the arm whose answer used to be
    // whichever `contains` edge the bucket happened to list first.
    const forward = contextGroundedProvenance(fixture.reader, fixture.cursor, moduleNode, limit);
    assert.ok(forward.length > 0, 'the module must ground through an incident edge');

    const reversedModule = reversedCursorView.node(nodeIndexOf(reversed, HUB_MODULE_ID));
    assert.ok(reversedModule);
    const backward = contextGroundedProvenance(reversed, reversedCursorView, reversedModule, limit);
    assert.deepEqual(backward, forward, 'the grounding edge must not be chosen by bucket order');
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a one-hop walk past its node cap reports that it was cut', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 0 }, inflateHubModule(SYNTHETIC_FILES));
  try {
    const moduleNode = nodeIndexOf(fixture.reader, HUB_MODULE_ID);
    const hop = contextOneHopNeighbours(
      fixture.reader, fixture.cursor, moduleNode, HUB_MODULE_ID, PROJECTION_ALL_EDGE_TYPES
    );
    assert.equal(hop.truncated, true, 'a walk stopped by its node cap must say so');
    assert.equal(
      hop.neighbours.length,
      PROJECTION_ONE_HOP_CAPS.maxNodes - 1,
      'the root occupies one of the walk`s node budget slots'
    );
    assert.ok(
      hop.neighbours.length < SYNTHETIC_FILES,
      'the fixture must actually exceed the cap or this proves nothing'
    );
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a module whose contains walk was cut states its recorded size, not the walked one', async () => {
  const fixture = await createIndexedProjectionFixture({ fillerModules: 0 }, inflateHubModule(SYNTHETIC_FILES));
  try {
    const recorded = SYNTHETIC_FILES + 2; // the two files the base fixture puts in the hub module
    const text = moduleCandidateText(fixture.reader, fixture.cursor, HUB_MODULE_LABEL);
    assert.match(text, new RegExp(`\\(${recorded} files,`), 'the headline must state the module size the compiler recorded');
    assert.doesNotMatch(
      text,
      new RegExp(`\\(${PROJECTION_ONE_HOP_CAPS.maxNodes - 1} files,`),
      'the truncated walk`s own count must not be published as the module size'
    );
  } finally {
    removeProjectionFixture(fixture.root);
  }
});

test('a module the walk saw whole still states the count it walked', async () => {
  // The guard on the previous case: preferring the recorded metadata
  // unconditionally would also pass it, and would let a stale `fileCount` outrank
  // a walk that actually counted the files.
  const fixture = await createIndexedProjectionFixture({ fillerModules: 0 }, (snapshot) => ({
    ...snapshot,
    nodes: snapshot.nodes.map((node) =>
      node.id === HUB_MODULE_ID ? { ...node, metadata: { ...node.metadata, fileCount: 999 } } : node
    )
  }));
  try {
    const text = moduleCandidateText(fixture.reader, fixture.cursor, HUB_MODULE_LABEL);
    assert.match(text, /\(2 files,/, 'a complete walk is the authority on what it counted');
    assert.doesNotMatch(text, /\(999 files,/);
  } finally {
    removeProjectionFixture(fixture.root);
  }
});
