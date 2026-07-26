/**
 * Canonical serialization for a compiled Context Graph snapshot.
 *
 * Compiling the same repository state twice has to produce byte-identical JSON,
 * so every object is rebuilt here with an explicit key order and every collection
 * is sorted by id. `observedAt` is a wall-clock field: it is still written to the
 * artifact, but it is excluded from the hash input so a recompile that only moved
 * the clock keeps the same `snapshotHash`.
 *
 * Ordering uses the single shared `compareContextGraphIds` comparator, which is
 * codepoint order. That is deliberate: `localeCompare` depends on the host's ICU
 * collation, so two machines could sort the same ids differently and produce two
 * different snapshot hashes for identical input — exactly the determinism the
 * hash exists to guarantee. Extractors, the compiler, and the structural lint all
 * share this one comparator.
 */
import { sha256 } from '../../../fsx.js';
import {
  CONTEXT_GRAPH_SCHEMA,
  CONTEXT_GRAPH_SCHEMA_REVISION,
  type ContextGraphCycle,
  type ContextGraphEdge,
  type ContextGraphExtractorStat,
  type ContextGraphLocator,
  type ContextGraphMetadata,
  type ContextGraphNode,
  type ContextGraphSnapshot
} from '../contracts.js';
import { compareContextGraphIds, shortDigest } from '../ids.js';

function orderedMetadata(metadata: ContextGraphMetadata | undefined): ContextGraphMetadata {
  const out: ContextGraphMetadata = {};
  if (!metadata) return out;
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}

function orderedLocator(locator: ContextGraphLocator): ContextGraphLocator {
  return {
    ...(locator.line === undefined ? {} : { line: locator.line }),
    ...(locator.column === undefined ? {} : { column: locator.column }),
    ...(locator.endLine === undefined ? {} : { endLine: locator.endLine }),
    ...(locator.endColumn === undefined ? {} : { endColumn: locator.endColumn })
  };
}

/** Rebuild a node with a fixed key order so the serialized bytes never depend on construction order. */
export function orderedNode(node: ContextGraphNode): ContextGraphNode {
  return {
    id: node.id,
    kind: node.kind,
    label: node.label,
    ...(node.path === undefined ? {} : { path: node.path }),
    ...(node.locator === undefined ? {} : { locator: orderedLocator(node.locator) }),
    ...(node.contentHash === undefined ? {} : { contentHash: node.contentHash }),
    trust: node.trust,
    freshness: node.freshness,
    risk: node.risk,
    tokenCost: node.tokenCost,
    metadata: orderedMetadata(node.metadata)
  };
}

/** Rebuild an edge with a fixed key order; `includeObservedAt: false` produces the hash input. */
export function orderedEdge(edge: ContextGraphEdge, includeObservedAt = true): ContextGraphEdge {
  const provenance = edge.provenance;
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    type: edge.type,
    confidence: edge.confidence,
    provenance: {
      path: provenance.path,
      ...(provenance.line === undefined ? {} : { line: provenance.line }),
      hash: provenance.hash,
      extractor: provenance.extractor
    },
    observedAt: includeObservedAt ? edge.observedAt : ''
  };
}

export function sortContextGraphNodes(nodes: readonly ContextGraphNode[]): ContextGraphNode[] {
  return [...nodes].sort((left, right) => compareContextGraphIds(left.id, right.id));
}

export function sortContextGraphEdges(edges: readonly ContextGraphEdge[]): ContextGraphEdge[] {
  return [...edges].sort((left, right) => compareContextGraphIds(left.id, right.id));
}

export function contextGraphCycleId(nodes: readonly string[]): string {
  return `cycle:${shortDigest([...nodes].sort(compareContextGraphIds).join('\n'))}`;
}

export function sortContextGraphCycles(cycles: readonly ContextGraphCycle[]): ContextGraphCycle[] {
  return cycles
    .map((cycle) => ({ id: cycle.id, nodes: [...cycle.nodes].sort(compareContextGraphIds) }))
    .sort((left, right) => compareContextGraphIds(left.id, right.id));
}

export function sortExtractorStats(stats: readonly ContextGraphExtractorStat[]): ContextGraphExtractorStat[] {
  return [...stats]
    .map((stat) => ({
      id: stat.id,
      revision: stat.revision,
      nodeCount: stat.nodeCount,
      edgeCount: stat.edgeCount,
      issueCount: stat.issueCount,
      skippedCount: stat.skippedCount
    }))
    .sort((left, right) => compareContextGraphIds(left.id, right.id));
}

export interface ContextGraphSnapshotDraft {
  nodes: readonly ContextGraphNode[];
  edges: readonly ContextGraphEdge[];
  cycles: readonly ContextGraphCycle[];
  extractors: readonly ContextGraphExtractorStat[];
}

/** Deterministic, clock-independent hash input. */
export function canonicalContextGraphHashInput(draft: ContextGraphSnapshotDraft): string {
  return JSON.stringify({
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    nodes: sortContextGraphNodes(draft.nodes).map(orderedNode),
    edges: sortContextGraphEdges(draft.edges).map((edge) => orderedEdge(edge, false)),
    cycles: sortContextGraphCycles(draft.cycles),
    extractors: sortExtractorStats(draft.extractors)
  });
}

export function computeContextGraphSnapshotHash(draft: ContextGraphSnapshotDraft): string {
  return sha256(canonicalContextGraphHashInput(draft));
}

/** Assemble the final, ordered, hashed snapshot object handed to the store. */
export function buildContextGraphSnapshot(draft: ContextGraphSnapshotDraft): ContextGraphSnapshot {
  const nodes = sortContextGraphNodes(draft.nodes).map(orderedNode);
  const edges = sortContextGraphEdges(draft.edges).map((edge) => orderedEdge(edge));
  const cycles = sortContextGraphCycles(draft.cycles);
  const extractors = sortExtractorStats(draft.extractors);
  const snapshotHash = computeContextGraphSnapshotHash({ nodes, edges, cycles, extractors });
  return {
    schema: CONTEXT_GRAPH_SCHEMA,
    schemaRevision: CONTEXT_GRAPH_SCHEMA_REVISION,
    snapshotHash,
    nodes,
    edges,
    cycles,
    extractors,
    nodeCount: nodes.length,
    edgeCount: edges.length
  };
}

/** Exact bytes the store writes; kept here so lint can diff a re-serialization against the file. */
export function serializeContextGraphSnapshot(snapshot: ContextGraphSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
