/**
 * Compiles a `ContextGraphSnapshot` into the SKSCG2 binary layout.
 *
 * The writer's contract is determinism: the same snapshot must produce
 * byte-identical output, on any machine, in any process. That is what makes the
 * index content-addressable, which is in turn what lets a generation be named
 * by its own hash and swapped in by an atomic rename. Anything that leaks
 * ambient order into the bytes — a `Map` iterated in insertion order, a
 * `Date.now()`, a locale-sensitive sort — breaks that chain silently, so every
 * table here is built from an explicit sort over stable identifiers.
 *
 * The writer is also the last place that can refuse. A snapshot carrying an
 * absolute path or a lint error must not reach the index, because once it is
 * interned into the string table the reader has no way to tell it apart from
 * legitimate workspace content.
 */
import {
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_NODE_KINDS,
  type ContextGraphEdge,
  type ContextGraphEdgeConfidence,
  type ContextGraphFreshness,
  type ContextGraphMetadataValue,
  type ContextGraphNode,
  type ContextGraphRisk,
  type ContextGraphSnapshot,
} from '../contracts.js';
import {
  CONTEXT_INDEX_FORMAT_REVISION,
  CONTEXT_INDEX_HEADER_BYTES,
  CONTEXT_INDEX_LIMITS,
  CONTEXT_INDEX_REQUIRED_SECTIONS,
  CONTEXT_INDEX_SECTION,
  CONTEXT_INDEX_SECTION_DESCRIPTOR_BYTES,
  ContextIndexFormatError,
  contextIndexChecksum,
  encodeContextIndexHeader,
  encodeSectionDescriptor,
  quantizeTrust,
  type ContextIndexSectionKind,
  type SectionDescriptor,
} from './format.js';

export const CONTEXT_INDEX_NODE_ROW_BYTES = 40;
export const CONTEXT_INDEX_EDGE_ROW_BYTES = 16;
export const CONTEXT_INDEX_PROVENANCE_ROW_BYTES = 16;
export const CONTEXT_INDEX_TERM_ROW_BYTES = 12;
export const CONTEXT_INDEX_METADATA_ROW_BYTES = 16;
export const CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES = 8;

// ---------------------------------------------------------------------------
// The metadata row (format revision 2)
// ---------------------------------------------------------------------------

/**
 * Field offsets for the metadata row, declared **once** and re-exported by
 * `reader-layout.ts`.
 *
 * Every other row in the file has its offsets duplicated on the reader side, on
 * the argument that the enum round-trip test guards the copy. This row does not,
 * because its `type` column is not merely a position: it decides how the `value`
 * column is *interpreted*, so a writer and a reader that disagreed about where
 * the tag lives would not read garbage — they would read a plausible value of
 * the wrong type, which is the exact failure format revision 2 exists to remove.
 */
export const CONTEXT_INDEX_METADATA_NODE_AT = 0;
export const CONTEXT_INDEX_METADATA_KEY_AT = 4;
export const CONTEXT_INDEX_METADATA_VALUE_AT = 8;
export const CONTEXT_INDEX_METADATA_TYPE_AT = 12;
export const CONTEXT_INDEX_METADATA_ORDINAL_AT = 14;

/**
 * How the row's `value` string is to be read back.
 *
 * `value` is **always** a string-table id, whatever the tag says. That is the
 * security property of this layout rather than a convenience: `reader-validate`
 * can bound-check the column unconditionally, so a corrupt tag can at worst
 * produce a wrong-typed value from an in-bounds string, and can never decide
 * that four bytes are an offset instead of an id.
 *
 * It is also why the lexicon survives. The interned text is the value's own
 * canonical serialization and nothing else — `'kernel'` is interned as
 * `kernel`, not as `"kernel"` — so a fixture that seeds a lexicon term through a
 * metadata value still resolves under `termId`. JSON-encoding the value was
 * tried and reverted for precisely that reason; the tag carries the type so the
 * text does not have to.
 */
export const CONTEXT_INDEX_METADATA_TYPE = {
  STRING: 0,
  BOOLEAN: 1,
  NUMBER: 2,
  NULL: 3,
  /** One row per element, `ordinal` carrying its position. */
  ARRAY_ELEMENT: 4,
  /** A zero-length array, which has no element to hang a row on. */
  ARRAY_EMPTY: 5,
} as const;

export const CONTEXT_INDEX_METADATA_TYPE_COUNT = 6;

/**
 * `ordinal` is a `u16`, so an array longer than this cannot be addressed. The
 * writer refuses rather than truncating: a silently shortened array is the
 * class of loss this revision exists to end.
 */
export const CONTEXT_INDEX_METADATA_MAX_ARRAY_LENGTH = 0x10000;

/** One row's worth of a metadata value: the tag, the text to intern, its position. */
export interface ContextIndexMetadataCell {
  readonly type: number;
  readonly text: string;
  readonly ordinal: number;
}

/**
 * The rows one metadata entry becomes.
 *
 * Called twice per entry — once to intern, once to emit — so the two passes
 * cannot disagree about what was interned. A scalar is one row; an array is one
 * row per element, which is what makes `['a,b', 'c']` distinguishable from
 * `['a', 'b', 'c']` at all. Revision 1 joined on a comma the value could itself
 * contain, and nothing downstream could reverse it.
 */
export function contextIndexMetadataCells(value: ContextGraphMetadataValue): readonly ContextIndexMetadataCell[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ type: CONTEXT_INDEX_METADATA_TYPE.ARRAY_EMPTY, text: '', ordinal: 0 }];
    if (value.length > CONTEXT_INDEX_METADATA_MAX_ARRAY_LENGTH) refuse('count_limit', { metadataArray: value.length });
    return value.map((entry, ordinal) => ({
      type: CONTEXT_INDEX_METADATA_TYPE.ARRAY_ELEMENT,
      text: String(entry),
      ordinal,
    }));
  }
  if (value === null) return [{ type: CONTEXT_INDEX_METADATA_TYPE.NULL, text: 'null', ordinal: 0 }];
  if (typeof value === 'boolean') {
    return [{ type: CONTEXT_INDEX_METADATA_TYPE.BOOLEAN, text: value ? 'true' : 'false', ordinal: 0 }];
  }
  if (typeof value === 'number') {
    return [{ type: CONTEXT_INDEX_METADATA_TYPE.NUMBER, text: String(value), ordinal: 0 }];
  }
  return [{ type: CONTEXT_INDEX_METADATA_TYPE.STRING, text: value, ordinal: 0 }];
}

/**
 * The inverse, for scalar tags only — the two array tags are assembled by the
 * caller, which is the only place that can see a run of rows.
 *
 * Total by construction: every branch returns, and no input throws. A tag is
 * bounds-checked at open, so the only way to reach the fallback is a `STRING`
 * row, which is what the fallback returns.
 */
export function contextIndexMetadataValue(type: number, text: string): string | number | boolean | null {
  if (type === CONTEXT_INDEX_METADATA_TYPE.BOOLEAN) return text === 'true';
  if (type === CONTEXT_INDEX_METADATA_TYPE.NUMBER) return Number(text);
  if (type === CONTEXT_INDEX_METADATA_TYPE.NULL) return null;
  return text;
}

/**
 * Every profile bit set: revision 1 reserves the per-edge profile mask without
 * filling it, so it must never be read as an exclusion.
 */
export const CONTEXT_INDEX_PROFILE_MASK_RESERVED = 0xffff

/** Sentinel for an absent u32 reference. */
export const CONTEXT_INDEX_NO_VALUE = 0xffffffff;

export const CONTEXT_INDEX_NODE_FLAG = {
  GROUNDABLE: 1 << 0,
  INVALIDATED: 1 << 1,
  PROTECTED: 1 << 2,
  IS_EVIDENCE: 1 << 3,
  IS_TEST_OR_GATE: 1 << 4,
  HAS_PATH: 1 << 5,
  HAS_CONTENT_HASH: 1 << 6,
} as const;

const FRESHNESS_CODES: readonly ContextGraphFreshness[] = ['fresh', 'stale', 'unknown'];
const RISK_CODES: readonly ContextGraphRisk[] = ['low', 'medium', 'high', 'protected'];
const CONFIDENCE_CODES: readonly ContextGraphEdgeConfidence[] = ['exact', 'syntactic', 'manifest', 'observed', 'derived'];

export const NODE_KIND_CODE = new Map(CONTEXT_GRAPH_NODE_KINDS.map((kind, index) => [kind, index]));
export const EDGE_TYPE_CODE = new Map(CONTEXT_GRAPH_EDGE_TYPES.map((type, index) => [type, index]));
export const FRESHNESS_CODE = new Map(FRESHNESS_CODES.map((value, index) => [value, index]));
export const RISK_CODE = new Map(RISK_CODES.map((value, index) => [value, index]));
export const CONFIDENCE_CODE = new Map(CONFIDENCE_CODES.map((value, index) => [value, index]));

export const EVIDENCE_KINDS = new Set(['proof', 'source', 'wiki_claim']);
export const TEST_OR_GATE_KINDS = new Set(['test', 'gate']);

export const CONTEXT_INDEX_WRITER_ERRORS = {
  absolute_path: 'context_index_writer_absolute_path',
  lint_error: 'context_index_writer_lint_error',
  unknown_enum: 'context_index_writer_unknown_enum',
  dangling_edge: 'context_index_writer_dangling_edge',
  count_limit: 'context_index_writer_count_limit',
  duplicate_node: 'context_index_writer_duplicate_node',
  // The lexicon lanes are the one part of the file the writer builds from a
  // separate module's output, so their cross-table agreements are asserted at
  // the write site. Reaching the reader instead would surface as
  // `csr_not_monotonic` — a corruption code for a compiler bug, telling a user
  // to rebuild a file that would be rebuilt exactly as wrong.
  lexicon_invariant: 'context_index_writer_lexicon_invariant',
} as const;

export type ContextIndexWriterErrorCode = keyof typeof CONTEXT_INDEX_WRITER_ERRORS;

/** Carries a code and integers only, for the same reason format errors do. */
export class ContextIndexWriterError extends Error {
  readonly code: ContextIndexWriterErrorCode;
  readonly publicCode: string;
  readonly detail: Readonly<Record<string, number>>;

  constructor(code: ContextIndexWriterErrorCode, detail: Record<string, number> = {}) {
    super(code);
    this.name = 'ContextIndexWriterError';
    this.code = code;
    this.publicCode = CONTEXT_INDEX_WRITER_ERRORS[code];
    this.detail = Object.freeze({ ...detail });
  }
}

/** Shared across the split: a refusal is a throw, never a partial index. */
export function refuse(code: ContextIndexWriterErrorCode, detail?: Record<string, number>): never {
  throw new ContextIndexWriterError(code, detail);
}

/**
 * A path that escapes the workspace, or names the machine it was compiled on,
 * must never be interned. Checked here rather than at read time because by then
 * it is indistinguishable from a legitimate relative path.
 */
export function isWorkspaceRelativePosixPath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes('\\')) return false;
  if (value.split('/').includes('..')) return false;
  return true;
}

