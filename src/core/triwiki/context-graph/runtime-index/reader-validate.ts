/**
 * Whole-file validation, run once at open.
 *
 * That ordering is the entire safety argument for the reader: every offset the
 * hot path indexes with was proved in range before the first lookup, which is
 * what lets `outgoing()` read a row without a bounds check per edge. Deferring
 * any of it would mean the query path either pays for a check per read or
 * trusts a number nobody checked.
 *
 * The bounds arithmetic itself is not re-derived here. `format.ts` owns it, and
 * this module calls its entry points so a rule can only be changed in one
 * place; what lives here is the set of cross-table agreements the format layer
 * cannot express, because they relate one section's contents to another's.
 */
import {
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_NODE_KINDS,
} from '../contracts.js';
import {
  CONTEXT_INDEX_SECTION,
  ContextIndexFormatError,
  validateCsrOffsets,
  validateReferenceRange,
  validateStringTable,
  type ContextIndexHeader,
  type SectionDescriptor,
} from './format.js';
import {
  CONTEXT_INDEX_EDGE_ROW_BYTES,
  CONTEXT_INDEX_METADATA_ROW_BYTES,
  CONTEXT_INDEX_NODE_ROW_BYTES,
  CONTEXT_INDEX_NO_VALUE,
  CONTEXT_INDEX_PROVENANCE_ROW_BYTES,
  CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES,
  CONTEXT_INDEX_TERM_ROW_BYTES,
} from './writer.js';
import {
  CONFIDENCE_CODES,
  EDGE_CONFIDENCE_AT,
  EDGE_PROVENANCE_AT,
  EDGE_TARGET_AT,
  EDGE_TYPE_AT,
  FRESHNESS_CODES,
  METADATA_KEY_AT,
  METADATA_NODE_AT,
  METADATA_VALUE_AT,
  NODE_CONTENT_HASH_AT,
  NODE_FRESHNESS_AT,
  NODE_GROUP_AT,
  NODE_ID_AT,
  NODE_KIND_AT,
  NODE_LABEL_AT,
  NODE_PATH_AT,
  NODE_RISK_AT,
  PROVENANCE_EXTRACTOR_AT,
  PROVENANCE_HASH_AT,
  PROVENANCE_PATH_AT,
  RISK_CODES,
  SOURCE_HASH_HASH_AT,
  SOURCE_HASH_PATH_AT,
  TERM_ID_AT,
  TERM_POSTING_COUNT_AT,
  TERM_POSTING_START_AT,
  sectionOf,
} from './reader-layout.js';

/**
 * Rejects the whole file when the header and the sections disagree about a
 * count. A header claiming more rows than the table holds is the ADR's
 * "declared count exceeds file", so it reports as truncated.
 */
function requireCount(actual: number, expected: number, kind: number): void {
  if (actual !== expected) throw new ContextIndexFormatError('count_limit_exceeded', { kind, actual, expected });
}

export function validateContextIndexPayloads(
  bytes: Uint8Array,
  header: ContextIndexHeader,
  byKind: ReadonlyMap<number, SectionDescriptor>,
): void {
  const strings = sectionOf(byKind, CONTEXT_INDEX_SECTION.STRING_TABLE);
  const nodes = sectionOf(byKind, CONTEXT_INDEX_SECTION.NODE_TABLE);
  const metadata = sectionOf(byKind, CONTEXT_INDEX_SECTION.NODE_METADATA);
  const edges = sectionOf(byKind, CONTEXT_INDEX_SECTION.EDGE_TABLE);
  const outOffsets = sectionOf(byKind, CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS);
  const outEdges = sectionOf(byKind, CONTEXT_INDEX_SECTION.OUT_CSR_EDGES);
  const inOffsets = sectionOf(byKind, CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS);
  const inEdges = sectionOf(byKind, CONTEXT_INDEX_SECTION.IN_CSR_EDGES);
  const provenance = sectionOf(byKind, CONTEXT_INDEX_SECTION.PROVENANCE_TABLE);
  const groups = sectionOf(byKind, CONTEXT_INDEX_SECTION.GROUP_TABLE);
  const cycles = sectionOf(byKind, CONTEXT_INDEX_SECTION.CYCLE_TABLE);
  const sourceHashes = sectionOf(byKind, CONTEXT_INDEX_SECTION.SOURCE_HASH_TABLE);

  requireCount(nodes.count, header.nodeCount, CONTEXT_INDEX_SECTION.NODE_TABLE);
  requireCount(edges.count, header.edgeCount, CONTEXT_INDEX_SECTION.EDGE_TABLE);
  requireCount(provenance.count, header.provenanceCount, CONTEXT_INDEX_SECTION.PROVENANCE_TABLE);
  requireCount(groups.count, header.nodeCount, CONTEXT_INDEX_SECTION.GROUP_TABLE);
  requireCount(outEdges.count, header.edgeCount, CONTEXT_INDEX_SECTION.OUT_CSR_EDGES);
  requireCount(inEdges.count, header.edgeCount, CONTEXT_INDEX_SECTION.IN_CSR_EDGES);
  requireCount(
    sectionOf(byKind, CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE).count,
    header.termCount,
    CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE,
  );

  validateStringTable(bytes, strings);
  validateCsrOffsets(bytes, outOffsets, outEdges, header.nodeCount);
  validateCsrOffsets(bytes, inOffsets, inEdges, header.nodeCount);

  const stringCount = strings.count;
  validateReferenceRange(bytes, nodes, CONTEXT_INDEX_NODE_ROW_BYTES, NODE_LABEL_AT, stringCount);
  validateReferenceRange(bytes, nodes, CONTEXT_INDEX_NODE_ROW_BYTES, NODE_ID_AT, stringCount);
  validateReferenceRange(bytes, nodes, CONTEXT_INDEX_NODE_ROW_BYTES, NODE_GROUP_AT, Math.max(header.nodeCount, 1));
  validateReferenceRange(bytes, metadata, CONTEXT_INDEX_METADATA_ROW_BYTES, METADATA_NODE_AT, header.nodeCount);
  validateReferenceRange(bytes, metadata, CONTEXT_INDEX_METADATA_ROW_BYTES, METADATA_KEY_AT, stringCount);
  validateReferenceRange(bytes, metadata, CONTEXT_INDEX_METADATA_ROW_BYTES, METADATA_VALUE_AT, stringCount);
  validateReferenceRange(bytes, edges, CONTEXT_INDEX_EDGE_ROW_BYTES, EDGE_TARGET_AT, header.nodeCount);
  validateReferenceRange(bytes, edges, CONTEXT_INDEX_EDGE_ROW_BYTES, EDGE_PROVENANCE_AT, provenance.count);
  validateReferenceRange(bytes, outEdges, 4, 0, header.edgeCount);
  validateReferenceRange(bytes, inEdges, 4, 0, header.edgeCount);
  validateReferenceRange(bytes, provenance, CONTEXT_INDEX_PROVENANCE_ROW_BYTES, PROVENANCE_PATH_AT, stringCount);
  validateReferenceRange(bytes, provenance, CONTEXT_INDEX_PROVENANCE_ROW_BYTES, PROVENANCE_HASH_AT, stringCount);
  validateReferenceRange(bytes, provenance, CONTEXT_INDEX_PROVENANCE_ROW_BYTES, PROVENANCE_EXTRACTOR_AT, stringCount);
  validateReferenceRange(bytes, groups, 4, 0, Math.max(header.nodeCount, 1));
  validateReferenceRange(bytes, cycles, 4, 0, header.nodeCount);
  validateReferenceRange(bytes, sourceHashes, CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES, SOURCE_HASH_PATH_AT, stringCount);
  validateReferenceRange(bytes, sourceHashes, CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES, SOURCE_HASH_HASH_AT, stringCount);

  for (const [table, postings] of [
    [CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE, CONTEXT_INDEX_SECTION.EXACT_POSTINGS],
    [CONTEXT_INDEX_SECTION.BASENAME_TABLE, CONTEXT_INDEX_SECTION.BASENAME_POSTINGS],
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, CONTEXT_INDEX_SECTION.LEXICON_POSTINGS],
    [CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE, CONTEXT_INDEX_SECTION.COARSE_POSTINGS],
  ] as const) {
    validateTermTable(bytes, sectionOf(byKind, table), sectionOf(byKind, postings), stringCount, header.nodeCount);
  }

  validateEnums(bytes, header, nodes, edges, groups, stringCount);
}

/**
 * A posting run must lie inside its postings section. An unchecked run is the
 * shape that turns one corrupt term row into a read past the section.
 */
function validateTermTable(
  bytes: Uint8Array,
  table: SectionDescriptor,
  postings: SectionDescriptor,
  stringCount: number,
  nodeCount: number,
): void {
  validateReferenceRange(bytes, table, CONTEXT_INDEX_TERM_ROW_BYTES, TERM_ID_AT, stringCount);
  validateReferenceRange(bytes, postings, 4, 0, nodeCount);
  const view = new DataView(bytes.buffer, bytes.byteOffset + Number(table.offset), Number(table.length));
  let previousTermId = -1;
  for (let row = 0; row < table.count; row += 1) {
    const at = row * CONTEXT_INDEX_TERM_ROW_BYTES;
    const termId = view.getUint32(at + TERM_ID_AT, true);
    // Ascending order is what makes the binary search in `termRun` correct; an
    // unsorted table would silently return "term not found" for live terms.
    if (termId <= previousTermId) {
      throw new ContextIndexFormatError('csr_not_monotonic', { row, termId, previous: previousTermId });
    }
    previousTermId = termId;
    const start = view.getUint32(at + TERM_POSTING_START_AT, true);
    const count = view.getUint32(at + TERM_POSTING_COUNT_AT, true);
    if (start + count > postings.count) {
      throw new ContextIndexFormatError('reference_out_of_range', { row, start, count, available: postings.count });
    }
  }
}

/**
 * Enum bytes are decoded straight into a union type, so an out-of-range code
 * would produce a node whose `kind` is `undefined` while still typechecking as
 * a `ContextGraphNodeKind`. Rejecting here is what keeps that impossible.
 */
function validateEnums(
  bytes: Uint8Array,
  header: ContextIndexHeader,
  nodes: SectionDescriptor,
  edges: SectionDescriptor,
  groups: SectionDescriptor,
  stringCount: number,
): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nodeBase = Number(nodes.offset);
  const groupBase = Number(groups.offset);
  for (let node = 0; node < header.nodeCount; node += 1) {
    const at = nodeBase + node * CONTEXT_INDEX_NODE_ROW_BYTES;
    checkCode(view.getUint8(at + NODE_KIND_AT), CONTEXT_GRAPH_NODE_KINDS.length, node);
    checkCode(view.getUint8(at + NODE_FRESHNESS_AT), FRESHNESS_CODES.length, node);
    checkCode(view.getUint8(at + NODE_RISK_AT), RISK_CODES.length, node);
    checkOptionalReference(view.getUint32(at + NODE_PATH_AT, true), stringCount, node);
    checkOptionalReference(view.getUint32(at + NODE_CONTENT_HASH_AT, true), stringCount, node);
    // The group is written twice, in the node row and in the group table.
    // Redundant encodings of one fact are only useful if they are compared, and
    // the failure this catches is a half-applied write — one section updated,
    // the other not. So the detail carries both values: knowing *which* copy
    // disagrees is the difference between "the file is damaged" and "a writer
    // updated one of two encodings", and with the numbers-only rule these two
    // integers are the only way to say that.
    const rowGroup = view.getUint32(at + NODE_GROUP_AT, true);
    const tableGroup = view.getUint32(groupBase + node * 4, true);
    if (rowGroup !== tableGroup) {
      throw new ContextIndexFormatError('section_checksum_mismatch', {
        kind: CONTEXT_INDEX_SECTION.GROUP_TABLE,
        node,
        rowGroup,
        tableGroup,
      });
    }
  }
  const edgeBase = Number(edges.offset);
  for (let edge = 0; edge < header.edgeCount; edge += 1) {
    const at = edgeBase + edge * CONTEXT_INDEX_EDGE_ROW_BYTES;
    checkCode(view.getUint8(at + EDGE_TYPE_AT), CONTEXT_GRAPH_EDGE_TYPES.length, edge);
    checkCode(view.getUint8(at + EDGE_CONFIDENCE_AT), CONFIDENCE_CODES.length, edge);
  }
}

function checkCode(value: number, exclusiveMax: number, row: number): void {
  if (value >= exclusiveMax) {
    throw new ContextIndexFormatError('reference_out_of_range', { row, value, exclusiveMax });
  }
}

/**
 * Sentinel-bearing string references cannot go through `validateReferenceRange`,
 * which has no notion of "absent" and would reject every node without a path.
 * The bound itself is unchanged: a present reference must still address a live
 * string.
 */
function checkOptionalReference(value: number, stringCount: number, row: number): void {
  if (value === CONTEXT_INDEX_NO_VALUE) return;
  if (value >= stringCount) {
    throw new ContextIndexFormatError('reference_out_of_range', { row, value, exclusiveMax: stringCount });
  }
}
