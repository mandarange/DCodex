/**
 * File header and section table: the first bytes a reader believes, and the
 * order in which it is safe to believe them.
 *
 * Magic, then header checksum, then format revision, and only then the counts.
 * An unknown layout means every later offset is being read at a position this
 * build does not understand, so a count taken from it describes a different
 * file's structure.
 */
import {
  OFFSET_FORMAT_REVISION,
  OFFSET_SCHEMA_REVISION,
  OFFSET_FLAGS,
  OFFSET_NODE_COUNT,
  OFFSET_EDGE_COUNT,
  OFFSET_TERM_COUNT,
  OFFSET_PROVENANCE_COUNT,
  OFFSET_SNAPSHOT_HASH,
  OFFSET_CONFIG_HASH,
  OFFSET_SECTION_COUNT,
  OFFSET_RESERVED,
  OFFSET_HEADER_CHECKSUM,

  CONTEXT_INDEX_HASH_BYTES,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_LIMITS,
  CONTEXT_INDEX_MAGIC,
  CONTEXT_INDEX_MAGIC_BYTES,
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  SECTION_KINDS,
  fail,
} from './format-contract.js';
import { checkedAdd, checkedMul, contextIndexChecksum } from './format-primitives.js';

// ---------------------------------------------------------------------------
// Header and section table
// ---------------------------------------------------------------------------

export interface ContextIndexHeader {
  readonly formatRevision: number;
  readonly schemaRevision: number;
  readonly flags: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly termCount: number;
  readonly provenanceCount: number;
  readonly snapshotHash: Uint8Array;
  readonly configHash: Uint8Array;
  readonly sectionCount: number;
}

export interface SectionDescriptor {
  readonly kind: number;
  readonly offset: bigint;
  readonly length: bigint;
  readonly count: number;
  readonly checksum: bigint;
}

export function encodeContextIndexHeader(header: ContextIndexHeader): Uint8Array {
  const bytes = new Uint8Array(CONTEXT_INDEX_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  bytes.set(CONTEXT_INDEX_MAGIC, 0);
  view.setUint16(OFFSET_FORMAT_REVISION, header.formatRevision, true);
  view.setUint16(OFFSET_SCHEMA_REVISION, header.schemaRevision, true);
  view.setUint32(OFFSET_FLAGS, header.flags >>> 0, true);
  view.setUint32(OFFSET_NODE_COUNT, header.nodeCount >>> 0, true);
  view.setUint32(OFFSET_EDGE_COUNT, header.edgeCount >>> 0, true);
  view.setUint32(OFFSET_TERM_COUNT, header.termCount >>> 0, true);
  view.setUint32(OFFSET_PROVENANCE_COUNT, header.provenanceCount >>> 0, true);
  bytes.set(fixedHash(header.snapshotHash), OFFSET_SNAPSHOT_HASH);
  bytes.set(fixedHash(header.configHash), OFFSET_CONFIG_HASH);
  view.setUint16(OFFSET_SECTION_COUNT, header.sectionCount, true);
  view.setUint16(OFFSET_RESERVED, 0, true);
  view.setUint32(OFFSET_HEADER_CHECKSUM, Number(contextIndexChecksum(bytes, 0, OFFSET_HEADER_CHECKSUM) & 0xffffffffn), true);
  return bytes;
}

function fixedHash(hash: Uint8Array): Uint8Array {
  if (hash.length !== CONTEXT_INDEX_HASH_BYTES) {
    const padded = new Uint8Array(CONTEXT_INDEX_HASH_BYTES);
    padded.set(hash.subarray(0, CONTEXT_INDEX_HASH_BYTES));
    return padded;
  }
  return hash;
}

export function readContextIndexHeader(bytes: Uint8Array): ContextIndexHeader {
  if (bytes.length < CONTEXT_INDEX_HEADER_BYTES) {
    fail('header_truncated', { size: bytes.length, required: CONTEXT_INDEX_HEADER_BYTES });
  }
  for (let index = 0; index < CONTEXT_INDEX_MAGIC_BYTES; index += 1) {
    if (bytes[index] !== CONTEXT_INDEX_MAGIC[index]) fail('magic_invalid', { at: index });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const stored = view.getUint32(OFFSET_HEADER_CHECKSUM, true);
  const computed = Number(contextIndexChecksum(bytes, 0, OFFSET_HEADER_CHECKSUM) & 0xffffffffn);
  if (stored !== computed) fail('header_checksum_mismatch', {});

  const formatRevision = view.getUint16(OFFSET_FORMAT_REVISION, true);
  // Checked before any count is believed: an unknown layout means every offset
  // below is being read at a position this build does not understand.
  if (formatRevision !== CONTEXT_INDEX_FORMAT_REVISION) {
    fail('revision_unsupported', { found: formatRevision, supported: CONTEXT_INDEX_FORMAT_REVISION });
  }
  if (view.getUint16(OFFSET_RESERVED, true) !== 0) fail('reserved_not_zero', {});

  const nodeCount = view.getUint32(OFFSET_NODE_COUNT, true);
  const edgeCount = view.getUint32(OFFSET_EDGE_COUNT, true);
  const termCount = view.getUint32(OFFSET_TERM_COUNT, true);
  const provenanceCount = view.getUint32(OFFSET_PROVENANCE_COUNT, true);
  const sectionCount = view.getUint16(OFFSET_SECTION_COUNT, true);
  if (nodeCount > CONTEXT_INDEX_LIMITS.maxNodeCount) fail('count_limit_exceeded', { nodeCount });
  if (edgeCount > CONTEXT_INDEX_LIMITS.maxEdgeCount) fail('count_limit_exceeded', { edgeCount });
  if (termCount > CONTEXT_INDEX_LIMITS.maxTermCount) fail('count_limit_exceeded', { termCount });
  if (provenanceCount > CONTEXT_INDEX_LIMITS.maxProvenanceCount) fail('count_limit_exceeded', { provenanceCount });
  if (sectionCount > CONTEXT_INDEX_LIMITS.maxSectionCount) fail('count_limit_exceeded', { sectionCount });

  return {
    formatRevision,
    schemaRevision: view.getUint16(OFFSET_SCHEMA_REVISION, true),
    flags: view.getUint32(OFFSET_FLAGS, true),
    nodeCount,
    edgeCount,
    termCount,
    provenanceCount,
    snapshotHash: bytes.slice(OFFSET_SNAPSHOT_HASH, OFFSET_SNAPSHOT_HASH + CONTEXT_INDEX_HASH_BYTES),
    configHash: bytes.slice(OFFSET_CONFIG_HASH, OFFSET_CONFIG_HASH + CONTEXT_INDEX_HASH_BYTES),
    sectionCount,
  };
}

export function encodeSectionDescriptor(descriptor: SectionDescriptor): Uint8Array {
  const bytes = new Uint8Array(CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, descriptor.kind >>> 0, true);
  view.setUint32(4, descriptor.count >>> 0, true);
  view.setBigUint64(8, descriptor.offset, true);
  view.setBigUint64(16, descriptor.length, true);
  view.setBigUint64(24, descriptor.checksum, true);
  return bytes;
}

export function readSectionTable(bytes: Uint8Array, header: ContextIndexHeader): readonly SectionDescriptor[] {
  const tableBytes = Number(checkedMul(BigInt(header.sectionCount), BigInt(CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES)));
  const tableEnd = CONTEXT_INDEX_HEADER_BYTES + tableBytes;
  if (bytes.length < tableEnd) fail('section_table_truncated', { size: bytes.length, required: tableEnd });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const descriptors: SectionDescriptor[] = [];
  for (let index = 0; index < header.sectionCount; index += 1) {
    const at = CONTEXT_INDEX_HEADER_BYTES + index * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES;
    const kind = view.getUint32(at, true);
    if (!SECTION_KINDS.has(kind)) fail('section_kind_unknown', { kind, index });
    const count = view.getUint32(at + 4, true);
    if (count > CONTEXT_INDEX_LIMITS.maxSectionCountValue) fail('count_limit_exceeded', { kind, count });
    descriptors.push({
      kind,
      count,
      offset: view.getBigUint64(at + 8, true),
      length: view.getBigUint64(at + 16, true),
      checksum: view.getBigUint64(at + 24, true),
    });
  }
  return descriptors;
}

/**
 * Bounds, duplicates, overlap, and completeness — in that order, because each
 * later check is only meaningful once the earlier one holds.
 */
export function validateSectionLayout(
  bytes: Uint8Array,
  header: ContextIndexHeader,
  descriptors: readonly SectionDescriptor[],
): ReadonlyMap<number, SectionDescriptor> {
  const fileSize = BigInt(bytes.length);
  const tableEnd = BigInt(CONTEXT_INDEX_HEADER_BYTES + descriptors.length * CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES);
  const byKind = new Map<number, SectionDescriptor>();

  for (const descriptor of descriptors) {
    if (byKind.has(descriptor.kind)) fail('section_duplicate', { kind: descriptor.kind });
    if (descriptor.length > CONTEXT_INDEX_LIMITS.maxSectionBytes) {
      fail('count_limit_exceeded', { kind: descriptor.kind, length: descriptor.length });
    }
    const end = checkedAdd(descriptor.offset, descriptor.length);
    if (descriptor.offset < tableEnd || end > fileSize) {
      fail('section_out_of_bounds', { kind: descriptor.kind, offset: descriptor.offset, end, size: fileSize });
    }
    byKind.set(descriptor.kind, descriptor);
  }

  const ordered = [...descriptors].sort((a, b) => (a.offset < b.offset ? -1 : a.offset > b.offset ? 1 : 0));
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1] as SectionDescriptor;
    const current = ordered[index] as SectionDescriptor;
    if (previous.offset + previous.length > current.offset) {
      fail('section_overlap', { first: previous.kind, second: current.kind });
    }
  }

  for (const required of CONTEXT_INDEX_REQUIRED_SECTIONS) {
    if (!byKind.has(required)) fail('section_missing', { kind: required });
  }

  for (const descriptor of descriptors) {
    const start = Number(descriptor.offset);
    const end = start + Number(descriptor.length);
    if (contextIndexChecksum(bytes, start, end) !== descriptor.checksum) {
      fail('section_checksum_mismatch', { kind: descriptor.kind });
    }
  }

  void header;
  return byKind;
}
