/**
 * Where everything is in the file, and how a string is read back out.
 *
 * Row layouts are the writer's, not this file's. Every offset below is a
 * decoding of `writer.ts`, and the enum orders are duplicated from it only
 * because it does not export them — the enum round-trip test is what keeps the
 * two from drifting.
 *
 * The geometry is resolved once, at open, into plain numbers. Every later read
 * is `base + row * stride`, which is what lets the hot path index without
 * re-deriving an offset or re-checking a bound that open already proved.
 */
import type { ContextGraphEdgeConfidence, ContextGraphFreshness, ContextGraphRisk } from '../contracts.js';
import {
  CONTEXT_INDEX_SECTION,
  ContextIndexFormatError,
  type ContextIndexHeader,
  type SectionDescriptor,
} from './format.js';

/** Node row, 40 bytes. */
export const NODE_KIND_AT = 0;
export const NODE_FRESHNESS_AT = 1;
export const NODE_RISK_AT = 2;
export const NODE_FLAGS_AT = 3;
export const NODE_TRUST_AT = 4;
export const NODE_TOKEN_COST_AT = 8;
export const NODE_LABEL_AT = 12;
export const NODE_PATH_AT = 16;
export const NODE_LINE_AT = 20;
export const NODE_COLUMN_AT = 24;
export const NODE_CONTENT_HASH_AT = 28;
export const NODE_GROUP_AT = 32;
export const NODE_ID_AT = 36;

/** Edge row, 16 bytes. `from` is absent by design: the CSR bucket is the source. */
export const EDGE_TARGET_AT = 0;
export const EDGE_TYPE_AT = 4;
export const EDGE_CONFIDENCE_AT = 5;
export const EDGE_FLAGS_AT = 6;
export const EDGE_PROVENANCE_AT = 8;
export const EDGE_PROFILE_MASK_AT = 12;

/**
 * Metadata row, 16 bytes, sorted by `(node, key, ordinal)`.
 *
 * The one row whose offsets are *not* re-derived here. Every other layout above
 * is a decoding of the writer that the round-trip test guards, and that is
 * adequate when a skew produces obvious garbage. This row's `type` column
 * decides how its `value` column is interpreted, so a skew would produce a
 * plausible value of the wrong type — the exact failure format revision 2 was
 * cut to remove — which is why the writer's contract is the single declaration
 * and this module only re-exports it.
 */
export {
  CONTEXT_INDEX_METADATA_NODE_AT as METADATA_NODE_AT,
  CONTEXT_INDEX_METADATA_KEY_AT as METADATA_KEY_AT,
  CONTEXT_INDEX_METADATA_VALUE_AT as METADATA_VALUE_AT,
  CONTEXT_INDEX_METADATA_TYPE_AT as METADATA_TYPE_AT,
  CONTEXT_INDEX_METADATA_ORDINAL_AT as METADATA_ORDINAL_AT,
} from './writer-contract.js';

/** Provenance row, 16 bytes. */
export const PROVENANCE_PATH_AT = 0;
export const PROVENANCE_LINE_AT = 4;
export const PROVENANCE_HASH_AT = 8;
export const PROVENANCE_EXTRACTOR_AT = 12;

/** Term row, 12 bytes, sorted ascending by term id. */
export const TERM_ID_AT = 0;
export const TERM_POSTING_START_AT = 4;
export const TERM_POSTING_COUNT_AT = 8;

/** Source-hash row, 8 bytes. */
export const SOURCE_HASH_PATH_AT = 0;
export const SOURCE_HASH_HASH_AT = 4;

/** Duplicated from the writer's private tables; the enum round-trip test guards the copy. */
export const FRESHNESS_CODES: readonly ContextGraphFreshness[] = ['fresh', 'stale', 'unknown'];
export const RISK_CODES: readonly ContextGraphRisk[] = ['low', 'medium', 'high', 'protected'];
export const CONFIDENCE_CODES: readonly ContextGraphEdgeConfidence[] =
  ['exact', 'syntactic', 'manifest', 'observed', 'derived'];

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] as number;
    out += (HEX[byte >> 4] as string) + (HEX[byte & 0x0f] as string);
  }
  return out;
}

/** A dictionary lane: an ascending term table and the postings it addresses. */
export interface ContextIndexLane {
  readonly terms: SectionDescriptor;
  readonly postings: SectionDescriptor;
}

export interface ContextIndexGeometry {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly stringCount: number;
  readonly stringIndexBase: number;
  readonly stringBlobBase: number;
  readonly nodeBase: number;
  readonly metadataBase: number;
  readonly metadataCount: number;
  readonly edgeBase: number;
  readonly outOffsetBase: number;
  readonly outEdgeBase: number;
  readonly inOffsetBase: number;
  readonly inEdgeBase: number;
  readonly provenanceBase: number;
  readonly provenanceCount: number;
  readonly sourceHashBase: number;
  readonly sourceHashCount: number;
  readonly exact: ContextIndexLane;
  readonly basename: ContextIndexLane;
  readonly lexicon: ContextIndexLane;
  readonly coarse: ContextIndexLane;
}

/**
 * `validateSectionLayout` already proved completeness; this is the type
 * narrowing, and a second guard against a caller reaching in with a subset.
 */
export function sectionOf(byKind: ReadonlyMap<number, SectionDescriptor>, kind: number): SectionDescriptor {
  const descriptor = byKind.get(kind);
  if (!descriptor) throw new ContextIndexFormatError('section_missing', { kind });
  return descriptor;
}

function laneOf(
  byKind: ReadonlyMap<number, SectionDescriptor>,
  terms: number,
  postings: number,
): ContextIndexLane {
  return { terms: sectionOf(byKind, terms), postings: sectionOf(byKind, postings) };
}

export function readContextIndexGeometry(
  bytes: Uint8Array,
  header: ContextIndexHeader,
  byKind: ReadonlyMap<number, SectionDescriptor>,
): ContextIndexGeometry {
  const strings = sectionOf(byKind, CONTEXT_INDEX_SECTION.STRING_TABLE);
  const metadata = sectionOf(byKind, CONTEXT_INDEX_SECTION.NODE_METADATA);
  const provenance = sectionOf(byKind, CONTEXT_INDEX_SECTION.PROVENANCE_TABLE);
  const sourceHash = sectionOf(byKind, CONTEXT_INDEX_SECTION.SOURCE_HASH_TABLE);
  const stringIndexBase = Number(strings.offset);
  return {
    bytes,
    // Built from byteOffset/byteLength rather than the raw ArrayBuffer: a
    // `Buffer` from `fs.readFile` can be a window into a shared pool, and a
    // view over the whole pool would read another file's bytes.
    view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    nodeCount: header.nodeCount,
    edgeCount: header.edgeCount,
    stringCount: strings.count,
    stringIndexBase,
    stringBlobBase: stringIndexBase + strings.count * 4,
    nodeBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.NODE_TABLE).offset),
    metadataBase: Number(metadata.offset),
    metadataCount: metadata.count,
    edgeBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.EDGE_TABLE).offset),
    outOffsetBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS).offset),
    outEdgeBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.OUT_CSR_EDGES).offset),
    inOffsetBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS).offset),
    inEdgeBase: Number(sectionOf(byKind, CONTEXT_INDEX_SECTION.IN_CSR_EDGES).offset),
    provenanceBase: Number(provenance.offset),
    provenanceCount: provenance.count,
    sourceHashBase: Number(sourceHash.offset),
    sourceHashCount: sourceHash.count,
    exact: laneOf(byKind, CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE, CONTEXT_INDEX_SECTION.EXACT_POSTINGS),
    basename: laneOf(byKind, CONTEXT_INDEX_SECTION.BASENAME_TABLE, CONTEXT_INDEX_SECTION.BASENAME_POSTINGS),
    lexicon: laneOf(byKind, CONTEXT_INDEX_SECTION.LEXICON_TABLE, CONTEXT_INDEX_SECTION.LEXICON_POSTINGS),
    coarse: laneOf(byKind, CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE, CONTEXT_INDEX_SECTION.COARSE_POSTINGS),
  };
}

/**
 * The string table is `count` u32 end-offsets followed by one UTF-8 blob, so a
 * string's start is the previous entry's end. Decodability was proved at open,
 * which is what lets this hand out a slice without a try/catch per lookup.
 */
export function stringAt(geometry: ContextIndexGeometry, id: number): string {
  const end = geometry.view.getUint32(geometry.stringIndexBase + id * 4, true);
  const start = id === 0 ? 0 : geometry.view.getUint32(geometry.stringIndexBase + (id - 1) * 4, true);
  return utf8Decoder.decode(geometry.bytes.subarray(geometry.stringBlobBase + start, geometry.stringBlobBase + end));
}

/**
 * Binary search over the interned table.
 *
 * The writer sorts with JS `<` on the decoded strings, so the probe has to
 * decode and compare the same way. Comparing raw UTF-8 bytes would order
 * astral characters differently and silently lose those terms.
 */
export function stringIdOf(geometry: ContextIndexGeometry, value: string): number {
  let low = 0;
  let high = geometry.stringCount - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const probe = stringAt(geometry, mid);
    if (probe === value) return mid;
    if (probe < value) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}
