/**
 * SKSCG2 binary index format — header, section table, and the validation that
 * makes an untrusted file safe to read.
 *
 * The index is a generated cache that a reader memory-maps and indexes into by
 * offset. That makes every count and offset in the file a load-bearing security
 * boundary: a truncated length, an overlapping section, or a CSR row that walks
 * backwards is enough to read outside the buffer or to allocate until the
 * process dies. So this module treats the file as hostile input even though we
 * wrote it, and it refuses rather than repairs. There is deliberately no
 * best-effort salvage path — an index that a reader guessed at is an index
 * whose results nothing can attest to.
 *
 * `formatRevision` is a property of the layout, never of the product. A release
 * that does not change the layout must produce byte-identical indexes.
 *
 * Errors carry a code and numeric facts only. The file holds interned strings
 * from the workspace, so echoing any byte of it into an error message would
 * turn a corrupt-index report into a content leak.
 */

export const CONTEXT_INDEX_MAGIC = Uint8Array.from([0x53, 0x4b, 0x53, 0x43, 0x47, 0x32, 0x00, 0x00]);
export const CONTEXT_INDEX_MAGIC_BYTES = 8;
export const CONTEXT_INDEX_FORMAT_REVISION = 1;
export const CONTEXT_INDEX_HEADER_BYTES = 104;
export const CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES = 32;
export const CONTEXT_INDEX_HASH_BYTES = 32;

/** Header field offsets. Little-endian throughout. */
const OFFSET_FORMAT_REVISION = 8;
const OFFSET_SCHEMA_REVISION = 10;
const OFFSET_FLAGS = 12;
const OFFSET_NODE_COUNT = 16;
const OFFSET_EDGE_COUNT = 20;
const OFFSET_TERM_COUNT = 24;
const OFFSET_PROVENANCE_COUNT = 28;
const OFFSET_SNAPSHOT_HASH = 32;
const OFFSET_CONFIG_HASH = 64;
const OFFSET_SECTION_COUNT = 96;
const OFFSET_RESERVED = 98;
const OFFSET_HEADER_CHECKSUM = 100;

export const CONTEXT_INDEX_SECTION = {
  STRING_TABLE: 1,
  NODE_TABLE: 2,
  NODE_METADATA: 3,
  EDGE_TABLE: 4,
  OUT_CSR_OFFSETS: 5,
  OUT_CSR_EDGES: 6,
  IN_CSR_OFFSETS: 7,
  IN_CSR_EDGES: 8,
  EXACT_TERM_TABLE: 9,
  EXACT_POSTINGS: 10,
  BASENAME_TABLE: 11,
  BASENAME_POSTINGS: 12,
  LEXICON_TABLE: 13,
  LEXICON_POSTINGS: 14,
  COARSE_TERM_TABLE: 15,
  COARSE_POSTINGS: 16,
  PROVENANCE_TABLE: 17,
  GROUP_TABLE: 18,
  CYCLE_TABLE: 19,
  SOURCE_HASH_TABLE: 20,
} as const;

export type ContextIndexSectionKind = (typeof CONTEXT_INDEX_SECTION)[keyof typeof CONTEXT_INDEX_SECTION];

/** Every section in §5.3 is required; an optional one would be a silent-degradation path. */
export const CONTEXT_INDEX_REQUIRED_SECTIONS: readonly ContextIndexSectionKind[] =
  Object.freeze(Object.values(CONTEXT_INDEX_SECTION) as ContextIndexSectionKind[]);

const SECTION_KINDS = new Set<number>(CONTEXT_INDEX_REQUIRED_SECTIONS);

/**
 * Caps sized well above the largest real workspace (measured baseline: 26,973
 * nodes, 70,832 edges) and well below what would exhaust memory if a corrupt
 * count were believed.
 */
export const CONTEXT_INDEX_LIMITS = Object.freeze({
  maxNodeCount: 1 << 24,
  maxEdgeCount: 1 << 26,
  maxTermCount: 1 << 24,
  maxProvenanceCount: 1 << 26,
  maxSectionCount: 64,
  maxSectionCountValue: 1 << 27,
  maxFileBytes: 1n << 33n,
  maxSectionBytes: 1n << 32n,
});

/** Granular cause. `publicCode` is what a caller sees, with a repair command. */
export const CONTEXT_INDEX_FORMAT_ERRORS = {
  magic_invalid: 'context_index_format_unsupported',
  revision_unsupported: 'context_index_format_unsupported',
  header_truncated: 'context_index_truncated',
  header_checksum_mismatch: 'context_index_checksum_mismatch',
  reserved_not_zero: 'context_index_format_unsupported',
  section_table_truncated: 'context_index_truncated',
  section_kind_unknown: 'context_index_format_unsupported',
  section_duplicate: 'context_index_checksum_mismatch',
  section_missing: 'context_index_truncated',
  section_overlap: 'context_index_checksum_mismatch',
  section_out_of_bounds: 'context_index_truncated',
  section_checksum_mismatch: 'context_index_checksum_mismatch',
  count_limit_exceeded: 'context_index_truncated',
  offset_overflow: 'context_index_truncated',
  string_offset_invalid: 'context_index_checksum_mismatch',
  string_not_utf8: 'context_index_checksum_mismatch',
  csr_not_monotonic: 'context_index_checksum_mismatch',
  csr_length_mismatch: 'context_index_checksum_mismatch',
  reference_out_of_range: 'context_index_checksum_mismatch',
} as const;

export type ContextIndexFormatErrorCode = keyof typeof CONTEXT_INDEX_FORMAT_ERRORS;

export const CONTEXT_INDEX_REPAIR_COMMAND = 'sks align run --rebuild-index' as const;
export const CONTEXT_INDEX_UPDATE_COMMAND = 'sks update' as const;

/**
 * Carries the failing code and integers only.
 *
 * `detail` is typed to numbers on purpose: a `string` field here would sooner
 * or later be filled with a decoded label from the very file being rejected.
 */
export class ContextIndexFormatError extends Error {
  readonly code: ContextIndexFormatErrorCode;
  readonly publicCode: string;
  readonly repairCommand: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextIndexFormatErrorCode, detail: Record<string, number | bigint> = {}) {
    super(code);
    this.name = 'ContextIndexFormatError';
    this.code = code;
    this.publicCode = CONTEXT_INDEX_FORMAT_ERRORS[code];
    this.repairCommand = this.publicCode === 'context_index_format_unsupported'
      ? CONTEXT_INDEX_UPDATE_COMMAND
      : CONTEXT_INDEX_REPAIR_COMMAND;
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      const asNumber = typeof value === 'bigint' ? Number(value) : value;
      if (Number.isFinite(asNumber)) numeric[key] = asNumber;
    }
    this.detail = Object.freeze(numeric);
  }
}

function fail(code: ContextIndexFormatErrorCode, detail?: Record<string, number | bigint>): never {
  throw new ContextIndexFormatError(code, detail);
}

// ---------------------------------------------------------------------------
// Checked arithmetic
// ---------------------------------------------------------------------------

/**
 * `offset + length` on numbers read from the file. Both operands are attacker
 * controlled, so the sum is checked against the file-size cap rather than
 * against `Number.MAX_SAFE_INTEGER` after the fact.
 */
export function checkedAdd(a: bigint, b: bigint, limit = CONTEXT_INDEX_LIMITS.maxFileBytes): bigint {
  if (a < 0n || b < 0n) fail('offset_overflow', { a, b });
  const sum = a + b;
  if (sum > limit) fail('offset_overflow', { a, b, limit });
  return sum;
}

export function checkedMul(a: bigint, b: bigint, limit = CONTEXT_INDEX_LIMITS.maxSectionBytes): bigint {
  if (a < 0n || b < 0n) fail('offset_overflow', { a, b });
  const product = a * b;
  if (product > limit) fail('offset_overflow', { a, b, limit });
  return product;
}

// ---------------------------------------------------------------------------
// Fixed point
// ---------------------------------------------------------------------------

/**
 * Scores decide result order, so they must not depend on the platform's float
 * rounding. Everything is integer until the public API boundary.
 */
export const CONTEXT_INDEX_FIXED_POINT_SCALE = 1_000;
export const CONTEXT_INDEX_TRUST_SCALE = 65_535;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export function toFixedPoint(value: number, scale = CONTEXT_INDEX_FIXED_POINT_SCALE): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * scale);
}

export function fromFixedPoint(value: number, scale = CONTEXT_INDEX_FIXED_POINT_SCALE): number {
  return value / scale;
}

export function quantizeTrust(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = value <= 0 ? 0 : value >= 1 ? 1 : value;
  return Math.round(clamped * CONTEXT_INDEX_TRUST_SCALE);
}

export function dequantizeTrust(value: number): number {
  return value / CONTEXT_INDEX_TRUST_SCALE;
}

/** Saturating rather than wrapping: a wrapped score silently reorders results. */
export function clampScore(value: bigint): bigint {
  if (value > I64_MAX) return I64_MAX;
  if (value < I64_MIN) return I64_MIN;
  return value;
}

// ---------------------------------------------------------------------------
// Checksum
// ---------------------------------------------------------------------------

/**
 * Two 32-bit lanes combined into a u64. A BigInt-per-byte hash would be correct
 * and unusable: the measured graph is 55 MB, and this runs over every section.
 */
export function contextIndexChecksum(bytes: Uint8Array, start = 0, end = bytes.length): bigint {
  if (start < 0 || end > bytes.length || start > end) fail('offset_overflow', { start, end, size: bytes.length });
  let lo = 0x811c9dc5 | 0;
  let hi = 0x01000193 | 0;
  for (let index = start; index < end; index += 1) {
    const byte = bytes[index] as number;
    lo = Math.imul(lo ^ byte, 0x01000193);
    hi = Math.imul((hi + byte) | 0, 0x85ebca6b) ^ (hi >>> 13);
  }
  return (BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0);
}

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

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * String table: `count` u32 end-offsets followed by the UTF-8 blob.
 *
 * Validating decodability up front is what lets the reader hand out slices
 * later without a try/catch per lookup.
 */
export function validateStringTable(bytes: Uint8Array, descriptor: SectionDescriptor): void {
  const start = Number(descriptor.offset);
  const length = Number(descriptor.length);
  const indexBytes = descriptor.count * 4;
  if (indexBytes > length) fail('string_offset_invalid', { count: descriptor.count, length });
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
  const blobStart = indexBytes;
  let previous = 0;
  for (let index = 0; index < descriptor.count; index += 1) {
    const end = view.getUint32(index * 4, true);
    if (end < previous) fail('string_offset_invalid', { index, end, previous });
    if (blobStart + end > length) fail('string_offset_invalid', { index, end, length });
    previous = end;
  }
  try {
    utf8Decoder.decode(bytes.subarray(start + blobStart, start + blobStart + previous));
  } catch {
    fail('string_not_utf8', { count: descriptor.count });
  }
}

/**
 * CSR row offsets must be non-decreasing and must end exactly at the edge
 * count. A row that walks backwards yields a negative slice length, which is
 * the shape that turns a corrupt file into an out-of-bounds read.
 */
export function validateCsrOffsets(
  bytes: Uint8Array,
  offsets: SectionDescriptor,
  edges: SectionDescriptor,
  nodeCount: number,
): void {
  if (offsets.count !== nodeCount + 1) {
    fail('csr_length_mismatch', { count: offsets.count, expected: nodeCount + 1 });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset + Number(offsets.offset), Number(offsets.length));
  if (offsets.count * 4 > Number(offsets.length)) {
    fail('csr_length_mismatch', { count: offsets.count, length: Number(offsets.length) });
  }
  let previous = 0;
  for (let index = 0; index < offsets.count; index += 1) {
    const value = view.getUint32(index * 4, true);
    if (value < previous) fail('csr_not_monotonic', { index, value, previous });
    previous = value;
  }
  if (previous !== edges.count) fail('csr_length_mismatch', { terminal: previous, edgeCount: edges.count });
}

/** Every u32 in a reference section must address a live row. */
export function validateReferenceRange(
  bytes: Uint8Array,
  descriptor: SectionDescriptor,
  stride: number,
  fieldOffset: number,
  exclusiveMax: number,
): void {
  const base = bytes.byteOffset + Number(descriptor.offset);
  const length = Number(descriptor.length);
  if (descriptor.count * stride > length) {
    fail('reference_out_of_range', { count: descriptor.count, stride, length });
  }
  const view = new DataView(bytes.buffer, base, length);
  for (let index = 0; index < descriptor.count; index += 1) {
    const value = view.getUint32(index * stride + fieldOffset, true);
    if (value >= exclusiveMax) fail('reference_out_of_range', { index, value, exclusiveMax });
  }
}
