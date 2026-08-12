/**
 * The allocation-free traversal surface: posting slices and the edge cursor.
 *
 * This is the file the card exists for. The v1 traversal built one object per
 * edge and one array per node, which on the measured graph is 70,832 objects
 * per full walk; here a walk allocates one cursor per *visited node* and
 * nothing per edge. Everything a cursor exposes is a scalar it overwrites in
 * place, so keeping an edge means copying the integers you want — a caller that
 * stores the cursor and reads it later gets the next edge, which is the
 * contract, not a bug.
 */
import { CONTEXT_INDEX_EDGE_ROW_BYTES } from './writer.js';
import {
  EDGE_CONFIDENCE_AT,
  EDGE_FLAGS_AT,
  EDGE_PROFILE_MASK_AT,
  EDGE_PROVENANCE_AT,
  EDGE_TARGET_AT,
  EDGE_TYPE_AT,
  type ContextIndexGeometry,
} from './reader-layout.js';
import type { EdgeCursor, PostingSlice, ScoredPostingSlice } from './reader-types.js';

export class BufferPostingSlice implements PostingSlice {
  constructor(
    private readonly view: DataView,
    private readonly base: number,
    readonly length: number,
  ) {}

  node(index: number): number {
    if (index < 0 || index >= this.length) throw new RangeError('posting index out of range');
    return this.view.getUint32(this.base + index * 4, true);
  }
}

export class ArrayScoredPostingSlice implements ScoredPostingSlice {
  constructor(
    private readonly nodes: Uint32Array,
    private readonly scores: Int32Array,
    readonly matchedTerms: number,
    readonly truncated: boolean,
  ) {}

  get length(): number {
    return this.nodes.length;
  }

  node(index: number): number {
    if (index < 0 || index >= this.nodes.length) throw new RangeError('posting index out of range');
    return this.nodes[index] as number;
  }

  score(index: number): number {
    if (index < 0 || index >= this.scores.length) throw new RangeError('posting index out of range');
    return this.scores[index] as number;
  }
}

/** Shared, so a miss costs nothing. Misses are the common case for a broad query. */
export const EMPTY_POSTINGS: PostingSlice = Object.freeze({
  length: 0,
  node(): number {
    throw new RangeError('posting index out of range');
  },
});

export const EMPTY_SCORED_POSTINGS: ScoredPostingSlice = Object.freeze({
  length: 0,
  matchedTerms: 0,
  truncated: false,
  node(): number {
    throw new RangeError('posting index out of range');
  },
  score(): number {
    throw new RangeError('posting index out of range');
  },
});

/**
 * The fields are mutable on the class and readonly on the interface: the cursor
 * owns them, the caller may only read them.
 */
class BufferEdgeCursor implements EdgeCursor {
  edge = -1;
  target = -1;
  type = -1;
  confidence = -1;
  flags = 0;
  provenance = -1;
  visited = 0;

  private position: number;

  constructor(
    readonly source: number,
    private readonly view: DataView,
    private readonly csrEdgeBase: number,
    private readonly edgeBase: number,
    private readonly end: number,
    private readonly mask: number,
    /** Non-null for an incoming cursor: the edge row stores only its target. */
    private readonly edgeSource: Uint32Array | null,
    start: number,
  ) {
    this.position = start;
  }

  next(): boolean {
    while (this.position < this.end) {
      const slot = this.position;
      this.position += 1;
      this.visited += 1;
      const edge = this.view.getUint32(this.csrEdgeBase + slot * 4, true);
      const at = this.edgeBase + edge * CONTEXT_INDEX_EDGE_ROW_BYTES;
      if ((this.view.getUint16(at + EDGE_PROFILE_MASK_AT, true) & this.mask) === 0) continue;
      this.edge = edge;
      this.target = this.edgeSource === null
        ? this.view.getUint32(at + EDGE_TARGET_AT, true)
        : (this.edgeSource[edge] as number);
      this.type = this.view.getUint8(at + EDGE_TYPE_AT);
      this.confidence = this.view.getUint8(at + EDGE_CONFIDENCE_AT);
      this.flags = this.view.getUint16(at + EDGE_FLAGS_AT, true);
      this.provenance = this.view.getUint32(at + EDGE_PROVENANCE_AT, true);
      return true;
    }
    this.edge = -1;
    this.target = -1;
    this.type = -1;
    this.confidence = -1;
    return false;
  }
}

export function openOutgoingCursor(geometry: ContextIndexGeometry, node: number, profileMask: number): EdgeCursor {
  const start = geometry.view.getUint32(geometry.outOffsetBase + node * 4, true);
  const end = geometry.view.getUint32(geometry.outOffsetBase + (node + 1) * 4, true);
  return new BufferEdgeCursor(
    node,
    geometry.view,
    geometry.outEdgeBase,
    geometry.edgeBase,
    end,
    profileMask,
    null,
    start,
  );
}

export function openIncomingCursor(
  geometry: ContextIndexGeometry,
  edgeSource: Uint32Array,
  node: number,
  profileMask: number,
): EdgeCursor {
  const start = geometry.view.getUint32(geometry.inOffsetBase + node * 4, true);
  const end = geometry.view.getUint32(geometry.inOffsetBase + (node + 1) * 4, true);
  return new BufferEdgeCursor(
    node,
    geometry.view,
    geometry.inEdgeBase,
    geometry.edgeBase,
    end,
    profileMask,
    edgeSource,
    start,
  );
}

/**
 * `from` is not stored per edge — the CSR bucket is the source — so an incoming
 * cursor needs the inverse. Four bytes per edge, built once on demand, is the
 * smallest structure that answers it; the alternative is an O(E) scan per
 * incoming node.
 */
export function buildEdgeSourceIndex(geometry: ContextIndexGeometry): Uint32Array {
  const built = new Uint32Array(geometry.edgeCount);
  for (let node = 0; node < geometry.nodeCount; node += 1) {
    const start = geometry.view.getUint32(geometry.outOffsetBase + node * 4, true);
    const end = geometry.view.getUint32(geometry.outOffsetBase + (node + 1) * 4, true);
    for (let slot = start; slot < end; slot += 1) {
      built[geometry.view.getUint32(geometry.outEdgeBase + slot * 4, true)] = node;
    }
  }
  return built;
}
