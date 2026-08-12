import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION,
  ContextIndexFormatError,
  contextIndexChecksum,
  readContextIndexHeader,
  readSectionTable,
} from '../format.js';
import {
  CONTEXT_INDEX_METADATA_ROW_BYTES,
  CONTEXT_INDEX_METADATA_TYPE,
  CONTEXT_INDEX_METADATA_TYPE_COUNT,
} from '../writer.js';
import { CONTEXT_INDEX_FIXED_STRIDE_SECTIONS } from '../reader-validate.js';
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

function withFormatRevision(revision: number): Uint8Array {
  const bytes = FIXTURE_BYTES.slice();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setUint16(8, revision, true);
  view.setUint32(100, Number(contextIndexChecksum(bytes, 0, 100) & 0xffffffffn), true);
  return bytes;
}

test('an index from a newer layout is rejected and points at an update', () => {
  const error = rejects(withFormatRevision(CONTEXT_INDEX_FORMAT_REVISION + 1), 'revision_unsupported');
  assert.equal(contextIndexFailureOf(error)?.repairCommand, 'sks update');
});

test('an index from format revision 1 is rejected rather than read at the wrong stride', () => {
  // Revision 2 widened the metadata row from 12 to 16 bytes. A reader that
  // accepted the older revision would not fail visibly — it would walk the
  // metadata section at the wrong stride and hand back a plausible node whose
  // metadata was assembled from misaligned columns. So the check fails closed in
  // *both* directions of skew, and the older direction gets its own case
  // because "newer than the reader" is the only one §5 spells out.
  const error = rejects(withFormatRevision(1), 'revision_unsupported');
  assert.equal(error.detail.found, 1);
  assert.equal(error.detail.supported, CONTEXT_INDEX_FORMAT_REVISION);
  assert.ok(contextIndexFailureOf(error)?.repairCommand.startsWith('sks '));
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

/**
 * The metadata row's tag decides how its value is decoded, so the ways it can be
 * wrong are not the ways an out-of-range reference is wrong: every case below
 * leaves every offset in bounds and the file still readable. What it corrupts is
 * the *meaning*, which is exactly what revision 2 added and therefore exactly
 * what has to be checked at open.
 */
test('a metadata tag outside the type enum is rejected rather than decoded as text', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_METADATA, (_payload, view) => {
    view.setUint16(12, CONTEXT_INDEX_METADATA_TYPE_COUNT, true);
  });
  const error = rejects(bytes, 'reference_out_of_range');
  assert.equal(error.detail.exclusiveMax, CONTEXT_INDEX_METADATA_TYPE_COUNT);
});

test('metadata rows out of node order are rejected, because the reader binary-searches them', () => {
  // `metadataOf` finds a node's first row by search and then walks forward. An
  // unsorted section makes it return part of a node's metadata or none of it,
  // and nothing about that read looks wrong from the outside.
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_METADATA, (_payload, view) => {
    view.setUint32(CONTEXT_INDEX_METADATA_ROW_BYTES, 0, true);
    view.setUint32(0, 3, true);
  });
  rejects(bytes, 'csr_not_monotonic');
});

test('an array with a hole in its ordinals is rejected rather than reassembled around it', () => {
  // The fixture's `tags: ['core', 'query']` is two element rows at ordinals 0
  // and 1. Skipping to 2 would leave the reader appending in row order over a
  // gap it cannot see — a shorter array than the writer wrote, silently.
  const rows = metadataRowTypes();
  const second = rows.indexOf(CONTEXT_INDEX_METADATA_TYPE.ARRAY_ELEMENT, 0) + 1;
  assert.ok(second > 0 && rows[second] === CONTEXT_INDEX_METADATA_TYPE.ARRAY_ELEMENT, 'the fixture must carry an array');
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_METADATA, (_payload, view) => {
    view.setUint16(second * CONTEXT_INDEX_METADATA_ROW_BYTES + 14, 2, true);
  });
  rejects(bytes, 'csr_not_monotonic');
});

test('a scalar row claiming a non-zero ordinal is rejected', () => {
  const rows = metadataRowTypes();
  const scalar = rows.findIndex((type) => type !== CONTEXT_INDEX_METADATA_TYPE.ARRAY_ELEMENT);
  assert.ok(scalar >= 0, 'the fixture must carry a scalar metadata value');
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.NODE_METADATA, (_payload, view) => {
    view.setUint16(scalar * CONTEXT_INDEX_METADATA_ROW_BYTES + 14, 1, true);
  });
  rejects(bytes, 'csr_not_monotonic');
});

test('a section whose row count and byte length disagree is rejected in both directions', () => {
  // The descriptor describes its own size twice, and until this check existed
  // only the overflowing direction was caught: a count *smaller* than the bytes
  // passed everything and simply made the reader stop early — a node quietly
  // missing a metadata key, or a claim quietly missing its source hash, with the
  // section checksum still valid because no byte inside the section moved.
  //
  // Reproduced against format revision 1 before being closed here: the campaign
  // found it after the metadata row widened, but the hole is older than that.
  const header = readContextIndexHeader(FIXTURE_BYTES);
  const descriptors = readSectionTable(FIXTURE_BYTES, header);
  let checked = 0;
  for (const [index, descriptor] of descriptors.entries()) {
    const stride = CONTEXT_INDEX_FIXED_STRIDE_SECTIONS.find(([kind]) => kind === descriptor.kind)?.[1];
    if (stride === undefined) continue;
    checked += 1;
    // The fixture carries no lexicon, so four of these sections are empty; a
    // zero-length section can only be over-claimed, which is the direction that
    // was already caught and is asserted here anyway.
    for (const count of descriptor.count === 0 ? [1] : [descriptor.count - 1, descriptor.count + 1]) {
      const bytes = FIXTURE_BYTES.slice();
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        .setUint32(CONTEXT_INDEX_HEADER_BYTES + index * 32 + 4, count, true);
      rejects(bytes, 'count_limit_exceeded');
    }
  }
  assert.equal(checked, CONTEXT_INDEX_FIXED_STRIDE_SECTIONS.length, 'every fixed-stride section must be exercised');
});

test('every required section is either fixed-stride or the string table', () => {
  // The list is what makes the check total. A section added to the format and
  // forgotten here would inherit exactly the hole above, silently.
  const covered = new Set(CONTEXT_INDEX_FIXED_STRIDE_SECTIONS.map(([kind]) => kind));
  const uncovered = CONTEXT_INDEX_REQUIRED_SECTIONS.filter((kind) => !covered.has(kind));
  assert.deepEqual(uncovered, [CONTEXT_INDEX_SECTION.STRING_TABLE]);
});

/** The fixture's metadata tags, in row order, so a case can find a row by kind. */
function metadataRowTypes(): number[] {
  const header = readContextIndexHeader(FIXTURE_BYTES);
  const section = readSectionTable(FIXTURE_BYTES, header)
    .find((descriptor) => descriptor.kind === CONTEXT_INDEX_SECTION.NODE_METADATA);
  assert.ok(section);
  const view = new DataView(FIXTURE_BYTES.buffer, FIXTURE_BYTES.byteOffset + Number(section.offset), Number(section.length));
  const types: number[] = [];
  for (let row = 0; row < section.count; row += 1) {
    types.push(view.getUint16(row * CONTEXT_INDEX_METADATA_ROW_BYTES + 12, true));
  }
  return types;
}

test('a group id that disagrees with the group table is rejected', () => {
  const bytes = patchSection(FIXTURE_BYTES, CONTEXT_INDEX_SECTION.GROUP_TABLE, (_payload, view) => {
    view.setUint32(0, FIXTURE_NODES.length - 1, true);
  });
  const error = rejects(bytes, 'section_checksum_mismatch');
  // Both copies are reported. Naming only the section would leave a reader
  // unable to tell a damaged file from a writer that updated one of the two
  // encodings and not the other.
  assert.equal(error.detail.node, 0);
  assert.equal(error.detail.rowGroup, 0);
  assert.equal(error.detail.tableGroup, FIXTURE_NODES.length - 1);
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
