/**
 * Lazy reader over the SKSCG2 binary index — the entry point for the whole
 * reader lane.
 *
 * The reader exists to delete two costs that dominated the v1 query path: the
 * `JSON.parse` of a 55 MB snapshot, and the object graph rebuilt from it on
 * every process. So nothing here builds a node map, an adjacency map, or an
 * edge array. A section is a byte range; a row is an offset; a traversal is a
 * cursor that carries four integers and mutates them in place. The only arrays
 * the reader ever allocates are the ones it hands back as results, sized by the
 * answer rather than by the graph.
 *
 * There is no fallback. A missing, stale, or corrupt index raises a frozen
 * error code with a repair command; it never degrades to a slower path, because
 * a fallback would make the performance floor unobservable and the correctness
 * floor unprovable.
 *
 * The lane is split by concern, and this file is the only one importers outside
 * the lane need:
 *
 * - `reader-types.ts`    the frozen §5.5 contract
 * - `reader-errors.ts`   the frozen §5 failure table
 * - `reader-layout.ts`   where the rows are, and how a string is decoded
 * - `reader-validate.ts` the once-at-open proof that every offset is in range
 * - `reader-cursor.ts`   posting slices and the allocation-free edge cursor
 * - `reader-lookup.ts`   term dictionary lookup and posting merge
 * - `reader-hydrate.ts`  whole-object materialization, selected nodes only
 *
 * The class below owns exactly two things the modules cannot: the bounds checks
 * that turn a caller's integer into a valid row, and the lazily built edge
 * source index.
 */
import { readContextIndexHeader, readSectionTable, validateSectionLayout } from './format.js';
import { CONTEXT_INDEX_NODE_ROW_BYTES } from './writer.js';
import { ContextIndexReaderError } from './reader-errors.js';
import {
  buildEdgeSourceIndex,
  openIncomingCursor,
  openOutgoingCursor,
} from './reader-cursor.js';
import { hydrateEdgeAt, hydrateNodeAt, provenanceOf, sourceHashesOf } from './reader-hydrate.js';
import {
  NODE_FLAGS_AT,
  NODE_FRESHNESS_AT,
  NODE_GROUP_AT,
  NODE_KIND_AT,
  NODE_RISK_AT,
  NODE_TOKEN_COST_AT,
  NODE_TRUST_AT,
  readContextIndexGeometry,
  toHex,
  type ContextIndexGeometry,
} from './reader-layout.js';
import { basenamePostings, exactPostings, mergePostings } from './reader-lookup.js';
import { validateContextIndexPayloads } from './reader-validate.js';
import type {
  CompactNodeScoreFields,
  ContextGraphEdgeView,
  ContextGraphNodeView,
  ContextIndexQueryBounds,
  ContextIndexReader,
  ContextIndexSourceHash,
  EdgeCursor,
  OpenContextIndexOptions,
  PostingSlice,
  ProvenanceView,
  ScoredPostingSlice,
} from './reader-types.js';

export {
  CONTEXT_INDEX_ERROR_REPAIR,
  ContextIndexReaderError,
  contextIndexFailureOf,
  type ContextIndexErrorCode,
  type ContextIndexFailure,
} from './reader-errors.js';
export {
  CONTEXT_INDEX_FIELD_MASK_ALL,
  CONTEXT_INDEX_PROFILE_MASK_ALL,
  type CompactNodeScoreFields,
  type ContextGraphEdgeView,
  type ContextGraphNodeView,
  type ContextIndexQueryBounds,
  type ContextIndexReader,
  type ContextIndexSourceHash,
  type EdgeCursor,
  type OpenContextIndexOptions,
  type PostingSlice,
  type ProvenanceView,
  type ScoredPostingSlice,
} from './reader-types.js';

class BinaryContextIndexReader implements ContextIndexReader {
  readonly snapshotHash: string;
  readonly configHash: string;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly termCount: number;
  readonly stringCount: number;
  readonly byteLength: number;

  private readonly geometry: ContextIndexGeometry;

  /** Built on the first incoming traversal only: pure-outgoing workloads never pay for it. */
  private edgeSource: Uint32Array | null = null;

  constructor(geometry: ContextIndexGeometry, snapshotHash: string, configHash: string, termCount: number) {
    this.geometry = geometry;
    this.snapshotHash = snapshotHash;
    this.configHash = configHash;
    this.termCount = termCount;
    this.nodeCount = geometry.nodeCount;
    this.edgeCount = geometry.edgeCount;
    this.stringCount = geometry.stringCount;
    this.byteLength = geometry.bytes.byteLength;
  }

  // -- lookup -------------------------------------------------------------

  exact(term: string, fieldMask?: number): PostingSlice {
    return exactPostings(this.geometry, term, fieldMask);
  }

  basename(term: string): PostingSlice {
    return basenamePostings(this.geometry, term);
  }

  lexical(termIds: readonly number[], plan: ContextIndexQueryBounds): ScoredPostingSlice {
    return mergePostings(this.geometry, this.geometry.lexicon, termIds, plan);
  }

  coarse(termIds: readonly number[], plan: ContextIndexQueryBounds): ScoredPostingSlice {
    return mergePostings(this.geometry, this.geometry.coarse, termIds, plan);
  }

  // -- traversal ----------------------------------------------------------

  outgoing(node: number, profileMask: number): EdgeCursor {
    this.requireNode(node);
    return openOutgoingCursor(this.geometry, node, profileMask);
  }

  incoming(node: number, profileMask: number): EdgeCursor {
    this.requireNode(node);
    if (this.edgeSource === null) this.edgeSource = buildEdgeSourceIndex(this.geometry);
    return openIncomingCursor(this.geometry, this.edgeSource, node, profileMask);
  }

  outDegree(node: number): number {
    this.requireNode(node);
    return this.geometry.view.getUint32(this.geometry.outOffsetBase + (node + 1) * 4, true)
      - this.geometry.view.getUint32(this.geometry.outOffsetBase + node * 4, true);
  }

  inDegree(node: number): number {
    this.requireNode(node);
    return this.geometry.view.getUint32(this.geometry.inOffsetBase + (node + 1) * 4, true)
      - this.geometry.view.getUint32(this.geometry.inOffsetBase + node * 4, true);
  }

  // -- node fields --------------------------------------------------------

  /**
   * A caller's integer is the one number open could not have validated, so it
   * is checked here. `RangeError` rather than an index error code: a node index
   * out of range is a bug in the caller, not a corrupt file, and reporting it
   * as corruption would send someone to rebuild a healthy index.
   */
  private requireNode(node: number): void {
    if (!Number.isInteger(node) || node < 0 || node >= this.nodeCount) {
      throw new RangeError('node index out of range');
    }
  }

  private requireEdge = (edge: number): void => {
    if (!Number.isInteger(edge) || edge < 0 || edge >= this.edgeCount) {
      throw new RangeError('edge index out of range');
    }
  };

  private nodeRow(node: number): number {
    this.requireNode(node);
    return this.geometry.nodeBase + node * CONTEXT_INDEX_NODE_ROW_BYTES;
  }

  nodeFlags(node: number): number {
    return this.geometry.view.getUint8(this.nodeRow(node) + NODE_FLAGS_AT);
  }

  nodeTokenCost(node: number): number {
    return this.geometry.view.getUint32(this.nodeRow(node) + NODE_TOKEN_COST_AT, true);
  }

  nodeGroup(node: number): number {
    return this.geometry.view.getUint32(this.nodeRow(node) + NODE_GROUP_AT, true);
  }

  nodeTrust(node: number): number {
    return this.geometry.view.getUint16(this.nodeRow(node) + NODE_TRUST_AT, true);
  }

  nodeKind(node: number): number {
    return this.geometry.view.getUint8(this.nodeRow(node) + NODE_KIND_AT);
  }

  /**
   * Allocates one small object. The hot ranking loop should prefer the scalar
   * accessors; this exists for the bounded set of candidates that survive to
   * scoring, where one object per candidate is affordable and readable.
   */
  nodeScoreFields(node: number): CompactNodeScoreFields {
    const at = this.nodeRow(node);
    const view = this.geometry.view;
    return Object.freeze({
      kind: view.getUint8(at + NODE_KIND_AT),
      freshness: view.getUint8(at + NODE_FRESHNESS_AT),
      risk: view.getUint8(at + NODE_RISK_AT),
      flags: view.getUint8(at + NODE_FLAGS_AT),
      trust: view.getUint16(at + NODE_TRUST_AT, true),
      tokenCost: view.getUint32(at + NODE_TOKEN_COST_AT, true),
      group: view.getUint32(at + NODE_GROUP_AT, true),
      outDegree: this.outDegree(node),
      inDegree: this.inDegree(node),
    });
  }

  // -- hydration ----------------------------------------------------------

  hydrateNode(node: number): ContextGraphNodeView {
    return hydrateNodeAt(this.geometry, node, this.nodeRow(node));
  }

  hydrateEdge(edge: number): ContextGraphEdgeView {
    this.requireEdge(edge);
    return hydrateEdgeAt(this.geometry, edge);
  }

  provenance(node: number, parentEdges: readonly number[]): readonly ProvenanceView[] {
    return provenanceOf(this.geometry, this.nodeRow(node), parentEdges, this.requireEdge);
  }

  sourceHashes(): readonly ContextIndexSourceHash[] {
    return sourceHashesOf(this.geometry);
  }
}

/**
 * Opens an index over an already-read buffer.
 *
 * Everything is validated before the first lookup: header, section layout and
 * checksums, string table, both CSR arrays, every cross-table reference, and
 * every enum byte. Only then are the pointer's claims checked against the
 * file's own header — a stale index is refused after it is proved intact, so
 * "stale" never gets reported for a file that is actually corrupt.
 */
export function openContextIndex(bytes: Uint8Array, options: OpenContextIndexOptions = {}): ContextIndexReader {
  const header = readContextIndexHeader(bytes);
  const byKind = validateSectionLayout(bytes, header, readSectionTable(bytes, header));
  validateContextIndexPayloads(bytes, header, byKind);

  const snapshotHash = toHex(header.snapshotHash);
  const configHash = toHex(header.configHash);
  if (options.expectedSnapshotHash !== undefined && options.expectedSnapshotHash !== snapshotHash) {
    throw new ContextIndexReaderError('context_index_stale');
  }
  if (options.expectedConfigHash !== undefined && options.expectedConfigHash !== configHash) {
    throw new ContextIndexReaderError('context_index_pointer_meta_divergent');
  }
  return new BinaryContextIndexReader(
    readContextIndexGeometry(bytes, header, byKind),
    snapshotHash,
    configHash,
    header.termCount,
  );
}
