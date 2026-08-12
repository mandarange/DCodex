import { CONTEXT_GRAPH_REBUILD_INDEX_COMMAND, CONTEXT_GRAPH_UPDATE_COMMAND } from '../contracts.js';
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
 * **Revision 2** widens the metadata row from 12 to 16 bytes and adds a type tag
 * to it, so a boolean an extractor wrote reads back as a boolean. See
 * `writer-contract.ts` for the row. A revision-2 reader does **not** read a
 * revision-1 index, in either direction of skew: the index is a content-
 * addressed cache that `sks align run --rebuild-index` reproduces deterministic-
 * ally, so there is nothing to migrate, and a stride-conditional decoder would
 * turn "which layout am I reading" into a per-row question when §2 makes it an
 * open-time one. `revision_unsupported` is raised before any count in the header
 * is believed.
 *
 * Errors carry a code and numeric facts only. The file holds interned strings
 * from the workspace, so echoing any byte of it into an error message would
 * turn a corrupt-index report into a content leak.
 */

export const CONTEXT_INDEX_MAGIC = Uint8Array.from([0x53, 0x4b, 0x53, 0x43, 0x47, 0x32, 0x00, 0x00]);
export const CONTEXT_INDEX_MAGIC_BYTES = 8;
export const CONTEXT_INDEX_FORMAT_REVISION = 2;
export const CONTEXT_INDEX_HEADER_BYTES = 104;
export const CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES = 32;
export const CONTEXT_INDEX_HASH_BYTES = 32;

/** Header field offsets. Little-endian throughout. */
export const OFFSET_FORMAT_REVISION = 8;
export const OFFSET_SCHEMA_REVISION = 10;
export const OFFSET_FLAGS = 12;
export const OFFSET_NODE_COUNT = 16;
export const OFFSET_EDGE_COUNT = 20;
export const OFFSET_TERM_COUNT = 24;
export const OFFSET_PROVENANCE_COUNT = 28;
export const OFFSET_SNAPSHOT_HASH = 32;
export const OFFSET_CONFIG_HASH = 64;
export const OFFSET_SECTION_COUNT = 96;
export const OFFSET_RESERVED = 98;
export const OFFSET_HEADER_CHECKSUM = 100;

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

export const SECTION_KINDS = new Set<number>(CONTEXT_INDEX_REQUIRED_SECTIONS);

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

export const CONTEXT_INDEX_REPAIR_COMMAND = CONTEXT_GRAPH_REBUILD_INDEX_COMMAND;
export const CONTEXT_INDEX_UPDATE_COMMAND = CONTEXT_GRAPH_UPDATE_COMMAND;

/**
 * An unsupported revision has two directions and only one of them is `sks update`.
 *
 * The original rule assumed the artifact was always ahead of the reader — an
 * index written by a newer build, repaired by upgrading. Revision 2 makes the
 * opposite case the common one: on upgrade, every existing workspace holds a
 * revision-1 index and a reader that is already current. Telling that user to
 * update names a command that will change nothing, and leaves the only real
 * repair — rebuilding the index — unsaid.
 *
 * So the direction decides. Older artifact than reader: rebuild. Newer artifact,
 * or any other unsupported-format cause (bad magic, unknown section kind), where
 * nothing here can know the artifact is merely stale: update.
 */
function formatRepairCommandFor(
  code: ContextIndexFormatErrorCode,
  detail: Record<string, number | bigint>
): string {
  if (CONTEXT_INDEX_FORMAT_ERRORS[code] !== 'context_index_format_unsupported') {
    return CONTEXT_INDEX_REPAIR_COMMAND;
  }
  if (code !== 'revision_unsupported') return CONTEXT_INDEX_UPDATE_COMMAND;
  const found = Number(detail.found);
  const supported = Number(detail.supported);
  if (!Number.isFinite(found) || !Number.isFinite(supported)) return CONTEXT_INDEX_UPDATE_COMMAND;
  return found < supported ? CONTEXT_INDEX_REPAIR_COMMAND : CONTEXT_INDEX_UPDATE_COMMAND;
}

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
    this.repairCommand = formatRepairCommandFor(code, detail);
    const numeric: Record<string, number> = {};
    for (const [key, value] of Object.entries(detail)) {
      const asNumber = typeof value === 'bigint' ? Number(value) : value;
      if (Number.isFinite(asNumber)) numeric[key] = asNumber;
    }
    this.detail = Object.freeze(numeric);
  }
}

/**
 * Shared by every module in the split: a rejection is always a throw, never a
 * partial result, so no caller can accidentally continue on corrupt bytes.
 */
export function fail(code: ContextIndexFormatErrorCode, detail?: Record<string, number | bigint>): never {
  throw new ContextIndexFormatError(code, detail);
}
