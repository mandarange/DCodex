/**
 * Shared fixtures for the reader suite.
 *
 * Indexes are built by calling the real writer rather than by hand-assembling
 * bytes: a fixture that agreed with the reader but not with the writer would
 * prove nothing about the file the compiler actually produces.
 *
 * The corruption helpers exist because a mutation alone is not a useful test.
 * A flipped byte is caught by the section checksum before any semantic check
 * runs, so `patchSection` re-lays the file and repairs every checksum around
 * the change — which is what makes the reader answer the question the test is
 * actually asking.
 */
import assert from 'node:assert/strict';
import {
  CONTEXT_GRAPH_SCHEMA,
  type ContextGraphEdge,
  type ContextGraphEdgeConfidence,
  type ContextGraphFreshness,
  type ContextGraphMetadata,
  type ContextGraphNode,
  type ContextGraphNodeKind,
  type ContextGraphRisk,
  type ContextGraphSnapshot,
} from '../../contracts.js';
import {
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  ContextIndexFormatError,
  contextIndexChecksum,
  encodeContextIndexHeader,
  encodeSectionDescriptor,
  readContextIndexHeader,
  readSectionTable,
  type SectionDescriptor,
} from '../format.js';
import { CONTEXT_INDEX_TERM_ROW_BYTES, encodeContextIndex } from '../writer.js';
import { contextIndexFailureOf, openContextIndex, type ContextIndexReader } from '../reader.js';

export const SNAPSHOT_HASH = '0123456789abcdef'.repeat(4);
export const CONFIG_HASH = new Uint8Array(32).fill(0xb2);
export const CONFIG_HASH_HEX = 'b2'.repeat(32);

export interface NodeSpec {
  id: string;
  kind?: ContextGraphNodeKind;
  label?: string;
  path?: string;
  line?: number;
  column?: number;
  contentHash?: string;
  trust?: number;
  freshness?: ContextGraphFreshness;
  risk?: ContextGraphRisk;
  tokenCost?: number;
  metadata?: ContextGraphMetadata;
}

export function makeNode(spec: NodeSpec): ContextGraphNode {
  return {
    id: spec.id,
    kind: spec.kind ?? 'file',
    label: spec.label ?? spec.id,
    ...(spec.path === undefined ? {} : { path: spec.path }),
    ...(spec.line === undefined
      ? {}
      : { locator: { line: spec.line, ...(spec.column === undefined ? {} : { column: spec.column }) } }),
    ...(spec.contentHash === undefined ? {} : { contentHash: spec.contentHash }),
    trust: spec.trust ?? 0.5,
    freshness: spec.freshness ?? 'fresh',
    risk: spec.risk ?? 'low',
    tokenCost: spec.tokenCost ?? 10,
    metadata: spec.metadata ?? {},
  };
}

export interface EdgeSpec {
  from: string;
  to: string;
  type?: ContextGraphEdge['type'];
  confidence?: ContextGraphEdgeConfidence;
  path?: string;
  line?: number;
  hash?: string;
  extractor?: string;
}

export function makeEdge(spec: EdgeSpec): ContextGraphEdge {
  const type = spec.type ?? 'imports';
  return {
    id: `edge:${spec.from}->${spec.to}:${type}`,
    from: spec.from,
    to: spec.to,
    type,
    confidence: spec.confidence ?? 'exact',
    provenance: {
      path: spec.path ?? 'src/a.ts',
      ...(spec.line === undefined ? {} : { line: spec.line }),
      hash: spec.hash ?? 'sha256:aa',
      extractor: spec.extractor ?? 'typescript',
    },
    observedAt: '2026-01-01T00:00:00.000Z',
  };
}

export function makeSnapshot(
  nodes: readonly ContextGraphNode[],
  edges: readonly ContextGraphEdge[],
): ContextGraphSnapshot {
  const sortedNodes = [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const sortedEdges = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: '1.0.0',
    snapshotHash: SNAPSHOT_HASH,
    nodes: sortedNodes,
    edges: sortedEdges,
    cycles: [],
    extractors: [],
    nodeCount: sortedNodes.length,
    edgeCount: sortedEdges.length,
  };
}

export function encode(snapshot: ContextGraphSnapshot): Uint8Array {
  return encodeContextIndex({ snapshot, configHash: CONFIG_HASH, schemaRevision: 1 }).bytes;
}

// ---------------------------------------------------------------------------
// The shared fixture: four nodes, three edges, one path shared by two nodes
// ---------------------------------------------------------------------------

export const FIXTURE_NODES: readonly ContextGraphNode[] = [
  makeNode({
    id: 'file:src/a.ts',
    kind: 'file',
    label: 'a.ts',
    path: 'src/a.ts',
    contentHash: 'sha256:aaaa',
    trust: 0.5,
    tokenCost: 120,
    metadata: { language: 'ts', tags: ['core', 'query'] },
  }),
  makeNode({ id: 'file:src/b.ts', kind: 'file', label: 'b.ts', path: 'src/b.ts', contentHash: 'sha256:bbbb', tokenCost: 44 }),
  makeNode({ id: 'gate:release:proof', kind: 'gate', label: 'release proof', risk: 'protected', freshness: 'stale', tokenCost: 8 }),
  makeNode({
    id: 'symbol:src/a.ts#run',
    kind: 'symbol',
    label: 'run',
    path: 'src/a.ts',
    line: 12,
    column: 3,
    contentHash: 'sha256:cccc',
    tokenCost: 30,
  }),
];

export const FIXTURE_EDGES: readonly ContextGraphEdge[] = [
  makeEdge({ from: 'file:src/a.ts', to: 'file:src/b.ts', type: 'imports', line: 4 }),
  makeEdge({ from: 'file:src/a.ts', to: 'symbol:src/a.ts#run', type: 'defines', line: 12 }),
  makeEdge({
    from: 'symbol:src/a.ts#run',
    to: 'gate:release:proof',
    type: 'verified_by',
    confidence: 'manifest',
    path: 'release-gates.v2.json',
    hash: 'sha256:dddd',
    extractor: 'gate-manifest',
  }),
];

/** Node integers are assigned in sorted node-id order, so these are stable. */
export const A = 0;
export const B = 1;
export const GATE = 2;
export const SYMBOL = 3;

export const FIXTURE_BYTES = encode(makeSnapshot(FIXTURE_NODES, FIXTURE_EDGES));

export function openFixture(): ContextIndexReader {
  return openContextIndex(FIXTURE_BYTES);
}

/** A wide fixture for the allocation measurements: 400 nodes, ~20,000 edges. */
export function buildLargeIndex(nodeCount: number, fanOut: number): Uint8Array {
  const nodes = Array.from({ length: nodeCount }, (_, index) => makeNode({
    id: `file:src/f${String(index).padStart(5, '0')}.ts`,
    path: `src/f${String(index).padStart(5, '0')}.ts`,
    contentHash: `sha256:${index}`,
  }));
  const edges: ContextGraphEdge[] = [];
  for (let from = 0; from < nodeCount; from += 1) {
    for (let step = 1; step <= fanOut; step += 1) {
      const to = (from + step) % nodeCount;
      if (to === from) continue;
      edges.push(makeEdge({
        from: nodes[from]?.id as string,
        to: nodes[to]?.id as string,
        type: 'imports',
        path: `src/f${String(from).padStart(5, '0')}.ts`,
        line: step,
      }));
    }
  }
  return encode(makeSnapshot(nodes, edges));
}

// ---------------------------------------------------------------------------
// Corruption
// ---------------------------------------------------------------------------

/**
 * Re-lays the file with replacement payloads, recomputing offsets and every
 * checksum. Without this the section checksum would catch every mutation first
 * and the semantic checks under test would never run.
 */
export function rewriteSections(
  bytes: Uint8Array,
  replacements: ReadonlyMap<number, { payload: Uint8Array; count: number }>,
): Uint8Array {
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header);
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + descriptors.length * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;
  let cursor = tableEnd;
  const laid = descriptors.map((descriptor) => {
    const replacement = replacements.get(descriptor.kind);
    const payload = replacement
      ? replacement.payload
      : bytes.slice(Number(descriptor.offset), Number(descriptor.offset + descriptor.length));
    const next: SectionDescriptor = {
      kind: descriptor.kind,
      count: replacement ? replacement.count : descriptor.count,
      offset: BigInt(cursor),
      length: BigInt(payload.length),
      checksum: contextIndexChecksum(payload),
    };
    cursor += payload.length;
    return { descriptor: next, payload };
  });
  const out = new Uint8Array(cursor);
  out.set(encodeContextIndexHeader(header), 0);
  laid.forEach((entry, index) => {
    out.set(
      encodeSectionDescriptor(entry.descriptor),
      CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
    );
  });
  for (const entry of laid) out.set(entry.payload, Number(entry.descriptor.offset));
  return out;
}

export function sectionBytes(bytes: Uint8Array, kind: number): { payload: Uint8Array; count: number } {
  const header = readContextIndexHeader(bytes);
  const descriptor = readSectionTable(bytes, header).find((entry) => entry.kind === kind) as SectionDescriptor;
  return {
    payload: bytes.slice(Number(descriptor.offset), Number(descriptor.offset + descriptor.length)),
    count: descriptor.count,
  };
}

/** Mutates one section's bytes and repairs every checksum around it. */
export function patchSection(
  bytes: Uint8Array,
  kind: number,
  mutate: (payload: Uint8Array, view: DataView) => number | void,
): Uint8Array {
  const current = sectionBytes(bytes, kind);
  const view = new DataView(current.payload.buffer, current.payload.byteOffset, current.payload.byteLength);
  const count = mutate(current.payload, view);
  return rewriteSections(bytes, new Map([[kind, { payload: current.payload, count: count ?? current.count }]]));
}

export function u32Array(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

/** Builds a term table and its postings in the writer's own row layout. */
export function termTable(entries: readonly (readonly [number, readonly number[]])[]): {
  table: { payload: Uint8Array; count: number };
  postings: { payload: Uint8Array; count: number };
} {
  const table = new Uint8Array(entries.length * CONTEXT_INDEX_TERM_ROW_BYTES);
  const view = new DataView(table.buffer);
  const postings: number[] = [];
  entries.forEach(([termId, nodes], position) => {
    const at = position * CONTEXT_INDEX_TERM_ROW_BYTES;
    view.setUint32(at, termId, true);
    view.setUint32(at + 4, postings.length, true);
    view.setUint32(at + 8, nodes.length, true);
    postings.push(...nodes);
  });
  return {
    table: { payload: table, count: entries.length },
    postings: { payload: u32Array(postings), count: postings.length },
  };
}

/** Asserts that opening these bytes fails with one granular code and a repair command. */
export function rejects(bytes: Uint8Array, code: string): ContextIndexFormatError {
  try {
    openContextIndex(bytes);
  } catch (error) {
    assert.ok(error instanceof ContextIndexFormatError, `expected a format error, got ${String(error)}`);
    assert.equal(error.code, code);
    const failure = contextIndexFailureOf(error);
    assert.ok(failure, 'every rejection maps to a public failure');
    assert.ok(failure.repairCommand.startsWith('sks '), 'every rejection names a repair command');
    return error;
  }
  return assert.fail('expected the index to be rejected');
}
