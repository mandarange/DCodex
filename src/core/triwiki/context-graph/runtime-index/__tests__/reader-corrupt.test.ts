import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_SECTION,
  ContextIndexFormatError,
  contextIndexChecksum,
  readContextIndexHeader,
  readSectionTable,
} from '../format.js';
import {
  ContextIndexReaderError,
  contextIndexFailureOf,
  openContextIndex,
} from '../reader.js';
import {
  CONFIG_HASH_HEX,
  FIXTURE_BYTES,
  FIXTURE_EDGES,
  FIXTURE_NODES,
  GATE,
  SNAPSHOT_HASH,
  encode,
  makeNode,
  makeSnapshot,
  openFixture,
  patchSection,
  rejects,
} from './reader-fixtures.js';

/**
 * The index is written by us and then read back as untrusted input: a file on
 * disk can be truncated by a full volume, corrupted by a bad sector, or left
 * half-written by a crash. Each case below is a way a reader could be talked
 * into reading outside its buffer, decoding an enum that does not exist, or
 * searching a table whose sort order is a lie.
 *
 * None of them is repaired in place. Corrupt input is refused with a code and
 * one repair command, because a reader that guesses is a reader whose output
 * nothing can attest to.
 */

test('a truncated file is rejected before any count is believed', () => {
  rejects(FIXTURE_BYTES.subarray(0, CONTEXT_INDEX_HEADER_BYTES - 1), 'header_truncated');
});

test('a file that is not an index is rejected on magic', () => {
  const bytes = FIXTURE_BYTES.slice();
  bytes[3] = 0x00;
  rejects(bytes, 'magic_invalid');
});

test('an index from a newer layout is rejected and points at an update', () => {
  const bytes = FIXTURE_BYTES.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(8, 2, true);
  view.setUint32(100, Number(contextIndexChecksum(bytes, 0, 100) & 0xffffffffn), true);
  const error = rejects(bytes, 'revision_unsupported');
  assert.equal(contextIndexFailureOf(error)?.repairCommand, 'sks update');
});

test('a flipped byte anywhere in a section is caught by its checksum', () => {
  const header = readContextIndexHeader(FIXTURE_BYTES);
  for (const descriptor of readSectionTable(FIXTURE_BYTES, header)) {
    if (descriptor.length === 0n) continue;
    const bytes = FIXTURE_BYTES.slice();
    const at = Number(descriptor.offset);
    bytes[at] = (bytes[at] as number) ^ 0xff;
    rejects(bytes, 'section_checksum_mismatch');
  }
});

test('a header count that disagrees with the table it describes is rejected', () => {
  const bytes = FIXTURE_BYTES.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint32(16, FIXTURE_NODES.length + 1, true);
  view.setUint32(100, Number(contextIndexChecksum(bytes, 0, 100) & 0xffffffffn), true);
  rejects(bytes, 'count_limit_exceeded');
});

test('an unknown node kind is rejected rather than decoded to undefined', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_TABLE, (_payload, view) => {
    view.setUint8(0, 200);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('an unknown edge type is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.EDGE_TABLE, (_payload, view) => {
    view.setUint8(4, 99);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('an edge whose target is not a live node is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.EDGE_TABLE, (_payload, view) => {
    view.setUint32(0, 9_999, true);
  });
  const error = rejects(bytes, 'reference_out_of_range');
  assert.equal(error.detail.value, 9_999);
});

test('a node label pointing outside the string table is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_TABLE, (_payload, view) => {
    view.setUint32(12, 4_000, true);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('an absent-path sentinel is accepted while a bogus path id is not', () => {
  // The sentinel is the one value a reference check must not reject; a reader
  // that ran every field through the same bound would refuse every node
  // without a path.
  assert.equal(openFixture().hydrateNode(GATE).path, undefined);
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_TABLE, (_payload, view) => {
    view.setUint32(16, 4_000, true);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('a metadata row attached to a node that does not exist is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_METADATA, (_payload, view) => {
    view.setUint32(0, 77, true);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('a group id that disagrees with the group table is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.GROUP_TABLE, (_payload, view) => {
    view.setUint32(0, FIXTURE_NODES.length - 1, true);
  });
  rejects(bytes, 'section_checksum_mismatch');
});

test('a non-monotonic CSR row is rejected before it can produce a negative run', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS, (_payload, view) => {
    view.setUint32(4, 0xffff, true);
  });
  rejects(bytes, 'csr_not_monotonic');
});

test('a CSR terminal that disagrees with the edge count is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS, (_payload, view) => {
    view.setUint32(FIXTURE_NODES.length * 4, FIXTURE_EDGES.length + 1, true);
  });
  rejects(bytes, 'csr_length_mismatch');
});

test('invalid UTF-8 in the string table is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.STRING_TABLE, (payload) => {
    payload[payload.length - 1] = 0xff;
    payload[payload.length - 2] = 0xfe;
  });
  rejects(bytes, 'string_not_utf8');
});

test('a CSR edge slot pointing outside the edge table is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.IN_CSR_EDGES, (_payload, view) => {
    view.setUint32(0, 500, true);
  });
  rejects(bytes, 'reference_out_of_range');
});

test('a stale index is refused with the align command, not read anyway', () => {
  try {
    openContextIndex(FIXTURE_BYTES, { expectedSnapshotHash: 'f'.repeat(64) });
    assert.fail('expected a stale index to be refused');
  } catch (error) {
    assert.ok(error instanceof ContextIndexReaderError);
    assert.equal(error.code, 'context_index_stale');
    assert.equal(error.repairCommand, 'sks align run');
  }
  // The matching hash still opens: staleness is a claim about the workspace,
  // not about the bytes.
  assert.equal(openContextIndex(FIXTURE_BYTES, { expectedSnapshotHash: SNAPSHOT_HASH }).nodeCount, 4);
});

test('a pointer and meta that disagree on the config fingerprint are refused', () => {
  try {
    openContextIndex(FIXTURE_BYTES, { expectedConfigHash: 'a'.repeat(64) });
    assert.fail('expected divergence to be refused');
  } catch (error) {
    assert.ok(error instanceof ContextIndexReaderError);
    assert.equal(error.code, 'context_index_pointer_meta_divergent');
    assert.equal(error.repairCommand, 'sks align run --rebuild-index');
  }
  assert.equal(openContextIndex(FIXTURE_BYTES, { expectedConfigHash: CONFIG_HASH_HEX }).nodeCount, 4);
});

test('every frozen error code names exactly one repair command', () => {
  const missing = new ContextIndexReaderError('context_index_missing');
  assert.equal(missing.repairCommand, 'sks align run');
  assert.equal(contextIndexFailureOf(missing)?.code, 'context_index_missing');
  assert.equal(contextIndexFailureOf(new Error('unrelated')), null);
});

test('a rejection reproduces no byte of the file it rejected', () => {
  const canary = '/Users/canary/secret-token-AKIAIOSFODNN7EXAMPLE';
  const nodes = [makeNode({ id: 'file:src/a.ts', path: 'src/a.ts', metadata: { note: canary } })];
  const bytes = encode(makeSnapshot(nodes, []));
  const corrupt = patchSection(bytes, CONTEXT_INDEX_SECTION.NODE_TABLE, (_payload, view) => {
    view.setUint8(0, 200);
  });
  let raised: unknown = null;
  try {
    openContextIndex(corrupt);
  } catch (error) {
    raised = error;
  }
  assert.ok(raised instanceof ContextIndexFormatError);
  const carried = `${raised.message} ${JSON.stringify(raised.detail)}`;
  assert.equal(carried.includes(canary), false);
  assert.equal(carried.includes('secret-token'), false);
  assert.equal(carried.includes('/'), false, 'an error must not carry a path fragment');
  for (const value of Object.values(raised.detail)) assert.equal(typeof value, 'number');
});
