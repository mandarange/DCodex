/**
 * Whole-object materialization — the only place the reader builds one.
 *
 * Everything here allocates, which is why none of it is on the ranking path.
 * §6 of the ADR reaches these functions for *selected* nodes only; the hot path
 * uses the scalar accessors instead. That split is the reason there is no
 * `getNode()` anywhere in the contract: an innocuous-looking whole-node getter
 * would be called in a loop, and the object graph would be back.
 */
import {
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_NODE_KINDS,
  type ContextGraphEdgeConfidence,
  type ContextGraphEdgeType,
  type ContextGraphFreshness,
  type ContextGraphNodeKind,
  type ContextGraphRisk,
} from '../contracts.js';
import { dequantizeTrust } from './format.js';
import {
  CONTEXT_INDEX_EDGE_ROW_BYTES,
  CONTEXT_INDEX_METADATA_ROW_BYTES,
  CONTEXT_INDEX_NO_VALUE,
  CONTEXT_INDEX_PROVENANCE_ROW_BYTES,
  CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES,
} from './writer.js';
import {
  CONFIDENCE_CODES,
  EDGE_CONFIDENCE_AT,
  EDGE_FLAGS_AT,
  EDGE_PROFILE_MASK_AT,
  EDGE_PROVENANCE_AT,
  EDGE_TARGET_AT,
  EDGE_TYPE_AT,
  FRESHNESS_CODES,
  METADATA_KEY_AT,
  METADATA_NODE_AT,
  METADATA_VALUE_AT,
  NODE_COLUMN_AT,
  NODE_CONTENT_HASH_AT,
  NODE_FLAGS_AT,
  NODE_FRESHNESS_AT,
  NODE_GROUP_AT,
  NODE_ID_AT,
  NODE_KIND_AT,
  NODE_LABEL_AT,
  NODE_LINE_AT,
  NODE_PATH_AT,
  NODE_RISK_AT,
  NODE_TOKEN_COST_AT,
  NODE_TRUST_AT,
  PROVENANCE_EXTRACTOR_AT,
  PROVENANCE_HASH_AT,
  PROVENANCE_LINE_AT,
  PROVENANCE_PATH_AT,
  RISK_CODES,
  SOURCE_HASH_HASH_AT,
  SOURCE_HASH_PATH_AT,
  stringAt,
  type ContextIndexGeometry,
} from './reader-layout.js';
import type {
  ContextGraphEdgeView,
  ContextGraphNodeView,
  ContextIndexSourceHash,
  ProvenanceView,
} from './reader-types.js';

export function hydrateNodeAt(geometry: ContextIndexGeometry, node: number, at: number): ContextGraphNodeView {
  const view = geometry.view;
  const pathId = view.getUint32(at + NODE_PATH_AT, true);
  const line = view.getUint32(at + NODE_LINE_AT, true);
  const column = view.getUint32(at + NODE_COLUMN_AT, true);
  const contentHashId = view.getUint32(at + NODE_CONTENT_HASH_AT, true);
  return {
    node,
    id: stringAt(geometry, view.getUint32(at + NODE_ID_AT, true)),
    kind: CONTEXT_GRAPH_NODE_KINDS[view.getUint8(at + NODE_KIND_AT)] as ContextGraphNodeKind,
    label: stringAt(geometry, view.getUint32(at + NODE_LABEL_AT, true)),
    ...(pathId === CONTEXT_INDEX_NO_VALUE ? {} : { path: stringAt(geometry, pathId) }),
    ...(line === CONTEXT_INDEX_NO_VALUE ? {} : { line }),
    ...(column === CONTEXT_INDEX_NO_VALUE ? {} : { column }),
    ...(contentHashId === CONTEXT_INDEX_NO_VALUE ? {} : { contentHash: stringAt(geometry, contentHashId) }),
    trust: dequantizeTrust(view.getUint16(at + NODE_TRUST_AT, true)),
    freshness: FRESHNESS_CODES[view.getUint8(at + NODE_FRESHNESS_AT)] as ContextGraphFreshness,
    risk: RISK_CODES[view.getUint8(at + NODE_RISK_AT)] as ContextGraphRisk,
    tokenCost: view.getUint32(at + NODE_TOKEN_COST_AT, true),
    flags: view.getUint8(at + NODE_FLAGS_AT),
    group: view.getUint32(at + NODE_GROUP_AT, true),
    metadata: metadataOf(geometry, node),
  };
}

/** Metadata rows are sorted by node, so the run is found by search, not by scan. */
function metadataOf(geometry: ContextIndexGeometry, node: number): Readonly<Record<string, string>> {
  const metadata: Record<string, string> = {};
  let low = 0;
  let high = geometry.metadataCount - 1;
  let first = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const probe = geometry.view.getUint32(
      geometry.metadataBase + mid * CONTEXT_INDEX_METADATA_ROW_BYTES + METADATA_NODE_AT,
      true,
    );
    if (probe >= node) {
      if (probe === node) first = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (first < 0) return metadata;
  for (let row = first; row < geometry.metadataCount; row += 1) {
    const at = geometry.metadataBase + row * CONTEXT_INDEX_METADATA_ROW_BYTES;
    if (geometry.view.getUint32(at + METADATA_NODE_AT, true) !== node) break;
    metadata[stringAt(geometry, geometry.view.getUint32(at + METADATA_KEY_AT, true))] =
      stringAt(geometry, geometry.view.getUint32(at + METADATA_VALUE_AT, true));
  }
  return metadata;
}

export function hydrateEdgeAt(geometry: ContextIndexGeometry, edge: number): ContextGraphEdgeView {
  const view = geometry.view;
  const at = geometry.edgeBase + edge * CONTEXT_INDEX_EDGE_ROW_BYTES;
  return {
    edge,
    target: view.getUint32(at + EDGE_TARGET_AT, true),
    type: CONTEXT_GRAPH_EDGE_TYPES[view.getUint8(at + EDGE_TYPE_AT)] as ContextGraphEdgeType,
    confidence: CONFIDENCE_CODES[view.getUint8(at + EDGE_CONFIDENCE_AT)] as ContextGraphEdgeConfidence,
    flags: view.getUint16(at + EDGE_FLAGS_AT, true),
    profileMask: view.getUint16(at + EDGE_PROFILE_MASK_AT, true),
    provenance: provenanceAt(geometry, view.getUint32(at + EDGE_PROVENANCE_AT, true)),
  };
}

function provenanceAt(geometry: ContextIndexGeometry, row: number): ProvenanceView {
  const view = geometry.view;
  const at = geometry.provenanceBase + row * CONTEXT_INDEX_PROVENANCE_ROW_BYTES;
  const line = view.getUint32(at + PROVENANCE_LINE_AT, true);
  return {
    path: stringAt(geometry, view.getUint32(at + PROVENANCE_PATH_AT, true)),
    ...(line === CONTEXT_INDEX_NO_VALUE ? {} : { line }),
    hash: stringAt(geometry, view.getUint32(at + PROVENANCE_HASH_AT, true)),
    extractor: stringAt(geometry, view.getUint32(at + PROVENANCE_EXTRACTOR_AT, true)),
  };
}

/**
 * The node's own source record first, then the edges that reached it.
 *
 * The node record matters for the `provenanceCoverage = 1.0` floor: a node
 * selected as a seed has no parent edge, and without its own path/hash pair it
 * would be reported as unattested when it is in fact grounded.
 *
 * `requireEdge` is passed in rather than re-implemented so that an out-of-range
 * parent edge fails the same way here as it does everywhere else.
 */
export function provenanceOf(
  geometry: ContextIndexGeometry,
  nodeRowAt: number,
  parentEdges: readonly number[],
  requireEdge: (edge: number) => void,
): readonly ProvenanceView[] {
  const view = geometry.view;
  const views: ProvenanceView[] = [];
  const pathId = view.getUint32(nodeRowAt + NODE_PATH_AT, true);
  const contentHashId = view.getUint32(nodeRowAt + NODE_CONTENT_HASH_AT, true);
  if (pathId !== CONTEXT_INDEX_NO_VALUE && contentHashId !== CONTEXT_INDEX_NO_VALUE) {
    const line = view.getUint32(nodeRowAt + NODE_LINE_AT, true);
    views.push({
      path: stringAt(geometry, pathId),
      ...(line === CONTEXT_INDEX_NO_VALUE ? {} : { line }),
      hash: stringAt(geometry, contentHashId),
    });
  }
  const seen = new Set<number>();
  for (const edge of parentEdges) {
    requireEdge(edge);
    const row = view.getUint32(geometry.edgeBase + edge * CONTEXT_INDEX_EDGE_ROW_BYTES + EDGE_PROVENANCE_AT, true);
    if (seen.has(row)) continue;
    seen.add(row);
    views.push(provenanceAt(geometry, row));
  }
  return views;
}

/** Compile-time source hashes, for the strict `hydrated` claim in §7. */
export function sourceHashesOf(geometry: ContextIndexGeometry): readonly ContextIndexSourceHash[] {
  const pairs: ContextIndexSourceHash[] = [];
  for (let row = 0; row < geometry.sourceHashCount; row += 1) {
    const at = geometry.sourceHashBase + row * CONTEXT_INDEX_SOURCE_HASH_ROW_BYTES;
    pairs.push({
      path: stringAt(geometry, geometry.view.getUint32(at + SOURCE_HASH_PATH_AT, true)),
      hash: stringAt(geometry, geometry.view.getUint32(at + SOURCE_HASH_HASH_AT, true)),
    });
  }
  return pairs;
}
