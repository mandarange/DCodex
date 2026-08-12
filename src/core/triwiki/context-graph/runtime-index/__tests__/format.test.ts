import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_LIMITS,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  ContextIndexFormatError,
  checkedAdd,
  checkedMul,
  clampScore,
  contextIndexChecksum,
  encodeContextIndexHeader,
  encodeSectionDescriptor,
  quantizeTrust,
  readContextIndexHeader,
  readSectionTable,
  toFixedPoint,
  validateCsrOffsets,
  validateReferenceRange,
  validateSectionLayout,
  validateStringTable,
  type ContextIndexHeader,
  type SectionDescriptor,
} from '../format.js';

/**
 * The index is written by us and then read back as untrusted input, because a
 * file on disk can be truncated by a full volume, corrupted by a bad sector, or
 * left half-written by a crash. Every case below is a way the reader could be
 * talked into reading outside its buffer or allocating without bound.
 */

const NODE_COUNT = 2;
const EDGE_COUNT = 1;

interface BuildOverrides {
  formatRevision?: number;
  nodeCount?: number;
  sectionOverride?: (kind: number, payload: Uint8Array) => Uint8Array | undefined;
  descriptorOverride?: (descriptor: SectionDescriptor) => SectionDescriptor;
  extraDescriptors?: readonly SectionDescriptor[];
  strings?: readonly string[];
  csrOffsets?: readonly number[];
}

function u32Array(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value >>> 0, true));
  return bytes;
}

function stringTable(values: readonly string[]): Uint8Array {
  const encoded = values.map((value) => new TextEncoder().encode(value));
  const ends: number[] = [];
  let running = 0;
  for (const entry of encoded) {
    running += entry.length;
    ends.push(running);
  }
  const bytes = new Uint8Array(ends.length * 4 + running);
  bytes.set(u32Array(ends), 0);
  let at = ends.length * 4;
  for (const entry of encoded) {
    bytes.set(entry, at);
    at += entry.length;
  }
  return bytes;
}

function sectionPayload(kind: number, overrides: BuildOverrides): { payload: Uint8Array; count: number } {
  const nodeCount = overrides.nodeCount ?? NODE_COUNT;
  const csr = overrides.csrOffsets ?? [0, 1, 1];
  switch (kind) {
    case CONTEXT_INDEX_SECTION.STRING_TABLE: {
      const values = overrides.strings ?? ['alpha', 'beta'];
      return { payload: stringTable(values), count: values.length };
    }
    case CONTEXT_INDEX_SECTION.NODE_TABLE:
      // One u32 field per node in the fixture: the group id.
      return { payload: u32Array(new Array(nodeCount).fill(0)), count: nodeCount };
    case CONTEXT_INDEX_SECTION.EDGE_TABLE:
      // One u32 field per edge in the fixture: the target node.
      return { payload: u32Array([1]), count: EDGE_COUNT };
    case CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS:
    case CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS:
      return { payload: u32Array(csr), count: csr.length };
    case CONTEXT_INDEX_SECTION.OUT_CSR_EDGES:
    case CONTEXT_INDEX_SECTION.IN_CSR_EDGES:
      return { payload: u32Array([0]), count: EDGE_COUNT };
    default:
      return { payload: u32Array([0]), count: 1 };
  }
}

function buildIndex(overrides: BuildOverrides = {}): Uint8Array {
  const kinds = [...CONTEXT_INDEX_REQUIRED_SECTIONS];
  const descriptorCount = kinds.length + (overrides.extraDescriptors?.length ?? 0);
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + descriptorCount * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;

  const payloads: Array<{ kind: number; payload: Uint8Array; count: number }> = [];
  for (const kind of kinds) {
    const built = sectionPayload(kind, overrides);
    const replaced = overrides.sectionOverride?.(kind, built.payload);
    payloads.push({ kind, payload: replaced ?? built.payload, count: built.count });
  }

  let cursor = tableEnd;
  // Payload placement uses the true descriptors; the table may carry corrupted
  // ones. Overriding both would make the builder itself throw before the reader
  // ever sees the file.
  const descriptors: SectionDescriptor[] = payloads.map((entry) => {
    const offset = cursor;
    cursor += entry.payload.length;
    return {
      kind: entry.kind,
      count: entry.count,
      offset: BigInt(offset),
      length: BigInt(entry.payload.length),
      checksum: contextIndexChecksum(entry.payload),
    };
  });
  const tableDescriptors = overrides.descriptorOverride
    ? descriptors.map(overrides.descriptorOverride)
    : descriptors;
  const allDescriptors = [...tableDescriptors, ...(overrides.extraDescriptors ?? [])];

  const bytes = new Uint8Array(cursor);
  const header: ContextIndexHeader = {
    formatRevision: overrides.formatRevision ?? CONTEXT_INDEX_FORMAT_REVISION,
    schemaRevision: 1,
    flags: 0,
    nodeCount: overrides.nodeCount ?? NODE_COUNT,
    edgeCount: EDGE_COUNT,
    termCount: 1,
    provenanceCount: 1,
    snapshotHash: new Uint8Array(32).fill(0xa1),
    configHash: new Uint8Array(32).fill(0xb2),
    sectionCount: allDescriptors.length,
  };
  bytes.set(encodeContextIndexHeader(header), 0);
  allDescriptors.forEach((descriptor, index) => {
    bytes.set(encodeSectionDescriptor(descriptor), CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES);
  });
  for (const [index, entry] of payloads.entries()) {
    bytes.set(entry.payload, Number((descriptors[index] as SectionDescriptor).offset));
  }
  return bytes;
}

function captureError(run: () => unknown): ContextIndexFormatError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ContextIndexFormatError, `expected a format error, got ${String(error)}`);
    return error;
  }
  return assert.fail('expected the input to be rejected');
}

function rejects(bytes: Uint8Array, code: string): ContextIndexFormatError {
  const error = captureError(() => {
    const header = readContextIndexHeader(bytes);
    const descriptors = readSectionTable(bytes, header);
    validateSectionLayout(bytes, header, descriptors);
  });
  assert.equal(error.code, code);
  assert.ok(error.publicCode.startsWith('context_index_'), 'every failure maps to a public code');
  assert.ok(error.repairCommand.startsWith('sks '), 'every failure names a repair command');
  return error;
}

test('a normal fixture round-trips through header, table, and layout validation', () => {
  const bytes = buildIndex();
  const header = readContextIndexHeader(bytes);
  assert.equal(header.formatRevision, CONTEXT_INDEX_FORMAT_REVISION);
  assert.equal(header.nodeCount, NODE_COUNT);
  assert.equal(header.sectionCount, CONTEXT_INDEX_REQUIRED_SECTIONS.length);
  const descriptors = readSectionTable(bytes, header);
  const byKind = validateSectionLayout(bytes, header, descriptors);
  assert.equal(byKind.size, CONTEXT_INDEX_REQUIRED_SECTIONS.length);
  validateStringTable(bytes, byKind.get(CONTEXT_INDEX_SECTION.STRING_TABLE) as SectionDescriptor);
  validateCsrOffsets(
    bytes,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_EDGES) as SectionDescriptor,
    header.nodeCount,
  );
  validateReferenceRange(bytes, byKind.get(CONTEXT_INDEX_SECTION.EDGE_TABLE) as SectionDescriptor, 4, 0, header.nodeCount);
});

test('a minimal index with no nodes and no edges is valid', () => {
  const bytes = buildIndex({ nodeCount: 0, csrOffsets: [0], strings: [] });
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header);
  const byKind = validateSectionLayout(bytes, header, descriptors);
  assert.equal(header.nodeCount, 0);
  validateStringTable(bytes, byKind.get(CONTEXT_INDEX_SECTION.STRING_TABLE) as SectionDescriptor);
});

test('a truncated header is rejected before any count is believed', () => {
  rejects(buildIndex().subarray(0, CONTEXT_INDEX_HEADER_BYTES - 1), 'header_truncated');
});

test('a file that is not an index is rejected on magic', () => {
  const bytes = buildIndex();
  bytes[2] = 0x00;
  rejects(bytes, 'magic_invalid');
});

test('an index from a newer build is rejected and points at an update', () => {
  const error = rejects(buildIndex({ formatRevision: CONTEXT_INDEX_FORMAT_REVISION + 1 }), 'revision_unsupported');
  assert.equal(error.publicCode, 'context_index_format_unsupported');
  assert.equal(error.repairCommand, 'sks update');
});

/**
 * The direction this test covers is the one every existing workspace takes on
 * upgrade, and it was the one the rule got wrong.
 *
 * `context_index_format_unsupported` was written assuming the artifact is always
 * ahead of the reader, so it always answered `sks update`. When revision 2
 * shipped, the common case inverted: the build is current and the on-disk index
 * is stale. Answering `sks update` there names a command that changes nothing
 * and never mentions the only repair that works, so the user's index stays
 * unreadable while the tool insists it is up to date. Same public code — the
 * vocabulary is frozen — different repair.
 */
test('an index from an older build is rejected and points at a rebuild, not an update', () => {
  const error = rejects(buildIndex({ formatRevision: CONTEXT_INDEX_FORMAT_REVISION - 1 }), 'revision_unsupported');
  assert.equal(error.publicCode, 'context_index_format_unsupported');
  assert.equal(error.repairCommand, 'sks align run --rebuild-index');
  assert.notEqual(error.repairCommand, 'sks update', 'the build is already current; updating repairs nothing');
});

test('a non-revision unsupported-format cause still points at an update', () => {
  // Bad magic says nothing about which side is stale, so the conservative
  // instruction stands. Pinned so the direction branch cannot widen past the
  // one code where the two revisions are actually known.
  const bytes = buildIndex();
  bytes[0] = 0x00;
  const error = rejects(bytes, 'magic_invalid');
  assert.equal(error.repairCommand, 'sks update');
});

test('a tampered header is caught by its own checksum', () => {
  const bytes = buildIndex();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 999, true);
  rejects(bytes, 'header_checksum_mismatch');
});

test('a duplicate section is rejected rather than resolved to one of the two', () => {
  const bytes = buildIndex({
    extraDescriptors: [{
      kind: CONTEXT_INDEX_SECTION.STRING_TABLE,
      count: 1,
      offset: BigInt(CONTEXT_INDEX_HEADER_BYTES + 21 * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES),
      length: 4n,
      checksum: 0n,
    }],
  });
  rejects(bytes, 'section_duplicate');
});

test('overlapping sections are rejected', () => {
  const bytes = buildIndex({
    descriptorOverride: (descriptor) => descriptor.kind === CONTEXT_INDEX_SECTION.NODE_TABLE
      ? { ...descriptor, offset: descriptor.offset - 2n }
      : descriptor,
  });
  rejects(bytes, 'section_overlap');
});

test('a section that runs past the end of the file is rejected', () => {
  const bytes = buildIndex({
    descriptorOverride: (descriptor) => descriptor.kind === CONTEXT_INDEX_SECTION.GROUP_TABLE
      ? { ...descriptor, length: descriptor.length + 4096n }
      : descriptor,
  });
  rejects(bytes, 'section_out_of_bounds');
});

test('a section offset that would overflow is rejected without allocating', () => {
  const bytes = buildIndex({
    descriptorOverride: (descriptor) => descriptor.kind === CONTEXT_INDEX_SECTION.CYCLE_TABLE
      ? { ...descriptor, offset: (1n << 62n) }
      : descriptor,
  });
  rejects(bytes, 'offset_overflow');
});

test('a count past its cap is rejected instead of sizing an allocation from it', () => {
  const bytes = buildIndex();
  const view = new DataView(bytes.buffer);
  view.setUint32(16, CONTEXT_INDEX_LIMITS.maxNodeCount + 1, true);
  view.setUint32(100, Number(contextIndexChecksum(bytes, 0, 100) & 0xffffffffn), true);
  rejects(bytes, 'count_limit_exceeded');
});

test('a section whose bytes changed is caught by its checksum', () => {
  const bytes = buildIndex();
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header);
  const target = descriptors.find((entry) => entry.kind === CONTEXT_INDEX_SECTION.EDGE_TABLE) as SectionDescriptor;
  bytes[Number(target.offset)] = (bytes[Number(target.offset)] as number) ^ 0xff;
  rejects(bytes, 'section_checksum_mismatch');
});

test('an unknown section kind is rejected', () => {
  const bytes = buildIndex({
    descriptorOverride: (descriptor) => descriptor.kind === CONTEXT_INDEX_SECTION.SOURCE_HASH_TABLE
      ? { ...descriptor, kind: 250 }
      : descriptor,
  });
  rejects(bytes, 'section_kind_unknown');
});

test('a missing required section is rejected, never treated as an empty one', () => {
  const bytes = buildIndex();
  const header = readContextIndexHeader(bytes);
  const descriptors = readSectionTable(bytes, header).filter(
    (entry) => entry.kind !== CONTEXT_INDEX_SECTION.CYCLE_TABLE,
  );
  const error = captureError(() => validateSectionLayout(bytes, header, descriptors));
  assert.equal(error.code, 'section_missing');
});

test('invalid UTF-8 in the string table is rejected', () => {
  const bytes = buildIndex({
    sectionOverride: (kind, payload) => {
      if (kind !== CONTEXT_INDEX_SECTION.STRING_TABLE) return undefined;
      const copy = payload.slice();
      copy[copy.length - 1] = 0xff;
      copy[copy.length - 2] = 0xfe;
      return copy;
    },
  });
  const header = readContextIndexHeader(bytes);
  const byKind = validateSectionLayout(bytes, header, readSectionTable(bytes, header));
  const error = captureError(() => validateStringTable(bytes, byKind.get(CONTEXT_INDEX_SECTION.STRING_TABLE) as SectionDescriptor));
  assert.equal(error.code, 'string_not_utf8');
});

test('a non-monotonic CSR row is rejected before it can produce a negative slice', () => {
  const bytes = buildIndex({ csrOffsets: [0, 5, 1] });
  const header = readContextIndexHeader(bytes);
  const byKind = validateSectionLayout(bytes, header, readSectionTable(bytes, header));
  const error = captureError(() => validateCsrOffsets(
    bytes,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_EDGES) as SectionDescriptor,
    header.nodeCount,
  ));
  assert.equal(error.code, 'csr_not_monotonic');
});

test('a CSR terminal that disagrees with the edge count is rejected', () => {
  const bytes = buildIndex({ csrOffsets: [0, 0, 0] });
  const header = readContextIndexHeader(bytes);
  const byKind = validateSectionLayout(bytes, header, readSectionTable(bytes, header));
  const error = captureError(() => validateCsrOffsets(
    bytes,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS) as SectionDescriptor,
    byKind.get(CONTEXT_INDEX_SECTION.OUT_CSR_EDGES) as SectionDescriptor,
    header.nodeCount,
  ));
  assert.equal(error.code, 'csr_length_mismatch');
});

test('an edge whose target is not a live node is rejected', () => {
  const bytes = buildIndex({
    sectionOverride: (kind) => kind === CONTEXT_INDEX_SECTION.EDGE_TABLE ? u32Array([9_999]) : undefined,
  });
  const header = readContextIndexHeader(bytes);
  const byKind = validateSectionLayout(bytes, header, readSectionTable(bytes, header));
  const error = captureError(() => validateReferenceRange(
    bytes,
    byKind.get(CONTEXT_INDEX_SECTION.EDGE_TABLE) as SectionDescriptor,
    4,
    0,
    header.nodeCount,
  ));
  assert.equal(error.code, 'reference_out_of_range');
  assert.equal(error.detail.value, 9_999);
});

test('the same input encodes byte-identically across 100 runs', () => {
  const first = buildIndex();
  for (let run = 0; run < 100; run += 1) {
    assert.deepEqual(buildIndex(), first, `run ${run} diverged`);
  }
});

test('a rejection reproduces no byte of the file it rejected', () => {
  // The table interns workspace strings. If a canary reaches an error message,
  // a corrupt-index report has become a content disclosure.
  const canary = '/Users/canary/secret-token-AKIAIOSFODNN7EXAMPLE';
  const bytes = buildIndex({ strings: [canary, 'beta'] });
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 999, true);
  const error = captureError(() => readContextIndexHeader(bytes));
  // The stack legitimately names this test's own source path, so the canary is
  // checked everywhere while the "no workspace content" rule is checked against
  // what the error itself carries.
  const rendered = `${error.message} ${error.stack ?? ''} ${JSON.stringify(error.detail)}`;
  assert.equal(rendered.includes(canary), false);
  assert.equal(rendered.includes('secret-token'), false);
  const carried = `${error.message} ${JSON.stringify(error.detail)}`;
  assert.equal(carried.includes('/'), false, 'an error must not carry a path fragment');
  assert.equal(/[^a-z_0-9{}":, ]/.test(carried), false, 'an error carries codes and integers only');
  for (const value of Object.values(error.detail)) assert.equal(typeof value, 'number');
});

test('checked arithmetic refuses rather than wrapping', () => {
  assert.throws(() => checkedAdd(1n << 40n, 1n << 40n), ContextIndexFormatError);
  assert.throws(() => checkedMul(1n << 20n, 1n << 20n), ContextIndexFormatError);
  assert.throws(() => checkedAdd(-1n, 0n), ContextIndexFormatError);
  assert.equal(checkedAdd(2n, 3n), 5n);
  assert.equal(checkedMul(4n, 5n), 20n);
});

test('fixed-point conversion keeps ordering off the platform float path', () => {
  assert.equal(toFixedPoint(0.125), 125);
  assert.equal(toFixedPoint(Number.NaN), 0);
  assert.equal(quantizeTrust(1), 65_535);
  assert.equal(quantizeTrust(0), 0);
  assert.equal(quantizeTrust(2), 65_535);
  assert.equal(quantizeTrust(-1), 0);
  // Saturating, because a wrapped score silently reorders results.
  assert.equal(clampScore((1n << 70n)), (1n << 63n) - 1n);
  assert.equal(clampScore(-(1n << 70n)), -(1n << 63n));
});
