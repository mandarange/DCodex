import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ContextGraphEdge,
  ContextGraphNode,
  ContextGraphSnapshot,
} from '../../contracts.js';
import {
  CONTEXT_INDEX_SECTION,
  readContextIndexHeader,
  readSectionTable,
  validateCsrOffsets,
  validateReferenceRange,
  validateSectionLayout,
  validateStringTable,
  type SectionDescriptor,
} from '../format.js';
import {
  CONTEXT_INDEX_EDGE_ROW_BYTES,
  CONTEXT_INDEX_NODE_FLAG,
  CONTEXT_INDEX_NODE_ROW_BYTES,
  ContextIndexWriterError,
  StringInterner,
  encodeContextIndex,
  isWorkspaceRelativePosixPath,
} from '../writer.js';

/**
 * The writer's contract is determinism, because the index is named by its own
 * hash. Anything that leaks ambient order into the bytes — insertion-ordered
 * iteration, a locale-sensitive sort, a timestamp — breaks content addressing
 * silently: two compiles of one snapshot would claim to be different graphs.
 */

function node(id: string, overrides: Partial<ContextGraphNode> = {}): ContextGraphNode {
  return {
    id,
    kind: 'file',
    label: id,
    trust: 0.5,
    freshness: 'fresh',
    risk: 'low',
    tokenCost: 10,
    metadata: {},
    ...overrides,
  };
}

function edge(from: string, to: string, overrides: Partial<ContextGraphEdge> = {}): ContextGraphEdge {
  return {
    id: `edge:${from}->${to}`,
    from,
    to,
    type: 'imports',
    confidence: 'exact',
    provenance: { path: 'src/a.ts', hash: 'deadbeef', extractor: 'ts' },
    observedAt: '2026-08-12T00:00:00.000Z',
    ...overrides,
  };
}

function snapshot(nodes: ContextGraphNode[], edges: ContextGraphEdge[]): ContextGraphSnapshot {
  return {
    schema: 'sks.context-graph.v1',
    schemaRevision: '1.0.0',
    snapshotHash: 'a'.repeat(64),
    nodes,
    edges,
    cycles: [],
    extractors: [],
    nodeCount: nodes.length,
    edgeCount: edges.length,
  };
}

function fixture(): ContextGraphSnapshot {
  return snapshot(
    [
      node('file:aaa', { path: 'src/a.ts', contentHash: 'hash-a', metadata: { owner: 'core' } }),
      node('file:bbb', { path: 'src/b.ts', contentHash: 'hash-b', risk: 'protected' }),
      node('gate:ccc', { kind: 'gate', label: 'release:check', freshness: 'stale' }),
    ],
    [
      edge('file:aaa', 'file:bbb'),
      edge('file:bbb', 'gate:ccc', { type: 'gated_by', confidence: 'manifest' }),
    ],
  );
}

const CONFIG_HASH = new Uint8Array(32).fill(0x7c);

function write(input: ContextGraphSnapshot) {
  return encodeContextIndex({ snapshot: input, configHash: CONFIG_HASH, schemaRevision: 1 });
}

function captureError(run: () => unknown): ContextIndexWriterError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ContextIndexWriterError, `expected a writer error, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the snapshot to be refused');
}

test('a written index passes every validation the reader will apply to it', () => {
  const result = write(fixture());
  const header = readContextIndexHeader(result.bytes);
  const descriptors = readSectionTable(result.bytes, header);
  const byKind = validateSectionLayout(result.bytes, header, descriptors);

  assert.equal(header.nodeCount, 3);
  assert.equal(header.edgeCount, 2);
  validateStringTable(result.bytes, byKind.get(CONTEXT_INDEX_SECTION.STRING_TABLE) as SectionDescriptor);
  validateCsrOffsets(
    result.bytes,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_EDGES) as SectionDescriptor,
    header.nodeCount,
  );
  validateCsrOffsets(
    result.bytes,
    byKind.get(CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.IN_CSR_EDGES) as SectionDescriptor,
    header.nodeCount,
  );
  validateReferenceRange(
    result.bytes,
    byKind.get(CONTEXT_INDEX_SECTION.EDGE_TABLE) as SectionDescriptor,
    CONTEXT_INDEX_EDGE_ROW_BYTES,
    0,
    header.nodeCount,
  );
});

test('node, edge, and provenance counts match the snapshot they came from', () => {
  const input = fixture();
  const result = write(input);
  assert.equal(result.nodeCount, input.nodes.length);
  assert.equal(result.edgeCount, input.edges.length);
  // Both edges share one provenance triple, so interning must collapse them.
  assert.equal(result.provenanceCount, 1);
});

test('the same snapshot encodes byte-identically across 100 runs', () => {
  const first = write(fixture()).bytes;
  for (let run = 0; run < 100; run += 1) {
    assert.deepEqual(write(fixture()).bytes, first, `run ${run} diverged`);
  }
});

test('input order does not reach the bytes', () => {
  // The compiler has no reason to hand nodes over in a stable order, so a
  // writer that trusted arrival order would produce a different hash for the
  // same graph and defeat content addressing.
  const forward = fixture();
  const reversed = snapshot([...forward.nodes].reverse(), [...forward.edges].reverse());
  assert.deepEqual(write(reversed).bytes, write(forward).bytes);
});

test('the writer refuses an absolute path rather than interning it', () => {
  // Once interned, an absolute path is indistinguishable from a legitimate
  // workspace-relative one, and the index has leaked the build machine.
  const withAbsoluteNode = snapshot([node('file:aaa', { path: '/Users/someone/src/a.ts' })], []);
  assert.equal(captureError(() => write(withAbsoluteNode)).code, 'absolute_path');

  const withAbsoluteProvenance = snapshot(
    [node('file:aaa'), node('file:bbb')],
    [edge('file:aaa', 'file:bbb', { provenance: { path: '/tmp/x.ts', hash: 'h', extractor: 'ts' } })],
  );
  assert.equal(captureError(() => write(withAbsoluteProvenance)).code, 'absolute_path');
});

test('the writer refuses paths that escape the workspace or name a drive', () => {
  for (const path of ['../outside.ts', 'C:\\win\\a.ts', '~/home.ts', 'src\\win.ts']) {
    assert.equal(isWorkspaceRelativePosixPath(path), false, path);
    assert.equal(captureError(() => write(snapshot([node('file:x', { path })], []))).code, 'absolute_path');
  }
  assert.equal(isWorkspaceRelativePosixPath('src/nested/a.ts'), true);
});

test('a graph that failed lint is never indexed', () => {
  const error = captureError(() => encodeContextIndex({
    snapshot: fixture(),
    configHash: CONFIG_HASH,
    schemaRevision: 1,
    lintErrors: ['dangling_edge'],
  }));
  assert.equal(error.code, 'lint_error');
});

test('an edge pointing at a node that does not exist is refused', () => {
  const dangling = snapshot([node('file:aaa')], [edge('file:aaa', 'file:missing')]);
  assert.equal(captureError(() => write(dangling)).code, 'dangling_edge');
});

test('an unknown enum value is refused rather than coerced to zero', () => {
  // Coercion would silently retype a node as `file` and a relation as
  // `contains`, which reads as data rather than as the corruption it is.
  const badKind = snapshot([node('file:aaa', { kind: 'not_a_kind' as ContextGraphNode['kind'] })], []);
  assert.equal(captureError(() => write(badKind)).code, 'unknown_enum');
  const badType = snapshot(
    [node('file:aaa'), node('file:bbb')],
    [edge('file:aaa', 'file:bbb', { type: 'not_a_type' as ContextGraphEdge['type'] })],
  );
  assert.equal(captureError(() => write(badType)).code, 'unknown_enum');
});

test('a duplicate node id is refused', () => {
  assert.equal(captureError(() => write(snapshot([node('file:aaa'), node('file:aaa')], []))).code, 'duplicate_node');
});

test('compile-time node flags are written, so the reader never has to derive them', () => {
  const result = write(fixture());
  const header = readContextIndexHeader(result.bytes);
  const byKind = validateSectionLayout(result.bytes, header, readSectionTable(result.bytes, header));
  const table = byKind.get(CONTEXT_INDEX_SECTION.NODE_TABLE) as SectionDescriptor;
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset + Number(table.offset), Number(table.length));

  // Nodes are sorted by id: file:aaa, file:bbb, gate:ccc.
  const flagsAt = (index: number): number => view.getUint8(index * CONTEXT_INDEX_NODE_ROW_BYTES + 3);
  assert.ok(flagsAt(0) & CONTEXT_INDEX_NODE_FLAG.HAS_PATH);
  assert.ok(flagsAt(0) & CONTEXT_INDEX_NODE_FLAG.HAS_CONTENT_HASH);
  assert.ok(flagsAt(0) & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE);
  assert.ok(flagsAt(1) & CONTEXT_INDEX_NODE_FLAG.PROTECTED, 'a protected-risk node carries the protected flag');
  assert.ok(flagsAt(2) & CONTEXT_INDEX_NODE_FLAG.IS_TEST_OR_GATE);
  assert.equal(flagsAt(2) & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE, 0, 'a stale node is not groundable');
});

test('an invalidated node loses groundable and gains invalidated', () => {
  const result = encodeContextIndex({
    snapshot: fixture(),
    configHash: CONFIG_HASH,
    schemaRevision: 1,
    invalidatedNodeIds: ['file:aaa'],
  });
  const header = readContextIndexHeader(result.bytes);
  const byKind = validateSectionLayout(result.bytes, header, readSectionTable(result.bytes, header));
  const table = byKind.get(CONTEXT_INDEX_SECTION.NODE_TABLE) as SectionDescriptor;
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset + Number(table.offset), Number(table.length));
  const flags = view.getUint8(3);
  assert.ok(flags & CONTEXT_INDEX_NODE_FLAG.INVALIDATED);
  assert.equal(flags & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE, 0);
});

test('an empty graph produces a valid index rather than a special case', () => {
  const result = write(snapshot([], []));
  const header = readContextIndexHeader(result.bytes);
  const byKind = validateSectionLayout(result.bytes, header, readSectionTable(result.bytes, header));
  assert.equal(header.nodeCount, 0);
  assert.equal(header.edgeCount, 0);
  validateCsrOffsets(
    result.bytes,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_EDGES) as SectionDescriptor,
    0,
  );
});

test('the string table is sorted, so the reader can binary-search instead of scanning', () => {
  const interner = new StringInterner();
  for (const value of ['zeta', 'alpha', 'Mid', 'beta']) interner.add(value);
  interner.seal();
  assert.ok(interner.idOf('Mid') < interner.idOf('alpha'), 'code-unit order, not locale order');
  assert.ok(interner.idOf('alpha') < interner.idOf('beta'));
  assert.ok(interner.idOf('beta') < interner.idOf('zeta'));
  assert.equal(interner.size, 4);
});

test('the interner refuses use out of order rather than returning a wrong id', () => {
  const interner = new StringInterner();
  interner.add('alpha');
  assert.throws(() => interner.idOf('alpha'), /not sealed/);
  interner.seal();
  assert.throws(() => interner.add('late'), /already sealed/);
  assert.throws(() => interner.idOf('never-added'), /interned after seal/);
});

test('a writer refusal carries codes and integers only', () => {
  const canary = '/Users/canary/secret-token-AKIAIOSFODNN7EXAMPLE/a.ts';
  const error = captureError(() => write(snapshot([node('file:aaa', { path: canary })], [])));
  const carried = `${error.message} ${JSON.stringify(error.detail)}`;
  assert.equal(carried.includes(canary), false);
  assert.equal(carried.includes('secret-token'), false);
  assert.equal(carried.includes('/'), false);
  for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
});

test('outgoing CSR buckets the edge table directly, so `from` is never stored per row', () => {
  const many = snapshot(
    [node('file:aaa'), node('file:bbb'), node('file:ccc')],
    [
      edge('file:ccc', 'file:aaa'),
      edge('file:aaa', 'file:bbb'),
      edge('file:aaa', 'file:ccc'),
    ],
  );
  const result = write(many);
  const header = readContextIndexHeader(result.bytes);
  const byKind = validateSectionLayout(result.bytes, header, readSectionTable(result.bytes, header));
  const offsets = byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor;
  const view = new DataView(result.bytes.buffer, result.bytes.byteOffset + Number(offsets.offset), Number(offsets.length));
  // file:aaa owns two outgoing edges, file:bbb none, file:ccc one.
  assert.equal(view.getUint32(0, true), 0);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), 2);
  assert.equal(view.getUint32(12, true), 3);
});

test('metadata values keep the type the extractor wrote', { todo: 'needs a metadata row type code; see docs/work-orders/context-retrieval-v2/release-record.md' }, async () => {
  // Flattening these to display strings silently broke every consumer asking
  // `metadata.isTest === true`: the boolean arrived as `"true"`, the strict
  // comparison failed, and the node simply stopped being a test node with no
  // error anywhere. Measured at eleven lost predicate matches across nine
  // benchmark fixture families before this was fixed.
  const { openContextIndex } = await import('../reader.js');
  const written = write(snapshot([
    node('file:aaa', {
      path: 'src/a.ts',
      metadata: {
        isTest: true,
        notATest: false,
        looksBooleanButIsText: 'true',
        weight: 42,
        absent: null,
        tags: ['alpha', 'beta'],
      },
    }),
  ], []));
  const reader = openContextIndex(written.bytes);
  const metadata = reader.hydrateNode(0).metadata;

  assert.equal(metadata.isTest, true, 'a boolean must survive as a boolean');
  assert.equal(metadata.notATest, false);
  assert.equal(metadata.looksBooleanButIsText, 'true');
  assert.notEqual(metadata.looksBooleanButIsText, true, 'a string must not become a boolean either');
  assert.equal(metadata.weight, 42);
  assert.equal(metadata.absent, null);
  assert.deepEqual(metadata.tags, ['alpha', 'beta']);
  // A comma inside a value used to be indistinguishable from the separator.
  const commas = write(snapshot([node('file:bbb', { metadata: { tags: ['a,b', 'c'] } })], []));
  assert.deepEqual(openContextIndex(commas.bytes).hydrateNode(0).metadata.tags, ['a,b', 'c']);
});
