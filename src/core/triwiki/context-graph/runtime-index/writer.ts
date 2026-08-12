/**
 * Compiles a `ContextGraphSnapshot` into the SKSCG2 binary layout.
 *
 * The writer's contract is determinism: the same snapshot must produce
 * byte-identical output, on any machine, in any process. That is what makes the
 * index content-addressable, which is in turn what lets a generation be named
 * by its own hash and swapped in by an atomic rename. Anything that leaks
 * ambient order into the bytes — a `Map` iterated in insertion order, a
 * `Date.now()`, a locale-sensitive sort — breaks that chain silently, so every
 * table is built from an explicit sort over stable identifiers.
 *
 * The writer is also the last place that can refuse. A snapshot carrying an
 * absolute path or a lint error must not reach the index, because once it is
 * interned into the string table the reader has no way to tell it apart from
 * legitimate workspace content.
 *
 * The implementation is split to stay inside this repo's new-file budget; this
 * file is the only import path callers should use.
 */
import { CONTEXT_INDEX_LIMITS, CONTEXT_INDEX_SECTION, quantizeTrust } from './format.js';
import {
  CONFIDENCE_CODE,
  CONTEXT_INDEX_EDGE_ROW_BYTES,
  CONTEXT_INDEX_NODE_ROW_BYTES,
  CONTEXT_INDEX_NO_VALUE,
  EDGE_TYPE_CODE,
  FRESHNESS_CODE,
  NODE_KIND_CODE,
  RISK_CODE,
  isWorkspaceRelativePosixPath,
  refuse,
} from './writer-contract.js';
import {
  StringInterner,
  csrOffsets,
  hexToBytes,
  nodeFlags,
  pairTable,
  provenanceTable,
  termTable,
  tripleTable,
  u32Section,
} from './writer-tables.js';
import { assemble } from './writer-assemble.js';
import type { ContextIndexWriteInput, ContextIndexWriteResult, ProvenanceRow } from './writer-types.js';
import type { ContextIndexSectionKind } from './format.js';

export * from './writer-contract.js';
export * from './writer-types.js';
export { StringInterner } from './writer-tables.js';

export function encodeContextIndex(input: ContextIndexWriteInput): ContextIndexWriteResult {
  if (input.lintErrors && input.lintErrors.length > 0) {
    refuse('lint_error', { count: input.lintErrors.length });
  }
  const snapshot = input.snapshot;
  if (snapshot.nodes.length > CONTEXT_INDEX_LIMITS.maxNodeCount) {
    refuse('count_limit', { nodeCount: snapshot.nodes.length });
  }
  if (snapshot.edges.length > CONTEXT_INDEX_LIMITS.maxEdgeCount) {
    refuse('count_limit', { edgeCount: snapshot.edges.length });
  }

  // 1. Stable integer ids. Sorting by node id is what makes the mapping — and
  //    therefore every posting list and CSR row below — reproducible.
  const nodes = [...snapshot.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const nodeIndex = new Map<string, number>();
  nodes.forEach((node, position) => {
    if (nodeIndex.has(node.id)) refuse('duplicate_node', { at: position });
    nodeIndex.set(node.id, position);
  });

  const interner = new StringInterner();
  const protectedIds = new Set(input.protectedNodeIds ?? []);
  const invalidatedIds = new Set(input.invalidatedNodeIds ?? []);

  for (const node of nodes) {
    if (!NODE_KIND_CODE.has(node.kind)) refuse('unknown_enum', { node: nodeIndex.get(node.id) as number });
    if (!FRESHNESS_CODE.has(node.freshness) || !RISK_CODE.has(node.risk)) {
      refuse('unknown_enum', { node: nodeIndex.get(node.id) as number });
    }
    interner.add(node.id);
    interner.add(node.label);
    if (node.path !== undefined) {
      if (!isWorkspaceRelativePosixPath(node.path)) refuse('absolute_path', { node: nodeIndex.get(node.id) as number });
      interner.add(node.path);
    }
    if (node.contentHash !== undefined) interner.add(node.contentHash);
    for (const [key, value] of Object.entries(node.metadata ?? {})) {
      interner.add(key);
      interner.add(Array.isArray(value) ? value.join(',') : String(value));
    }
  }

  const edges = [...snapshot.edges];
  for (const edge of edges) {
    if (!EDGE_TYPE_CODE.has(edge.type)) refuse('unknown_enum', {});
    if (!CONFIDENCE_CODE.has(edge.confidence)) refuse('unknown_enum', {});
    if (!nodeIndex.has(edge.from) || !nodeIndex.has(edge.to)) refuse('dangling_edge', {});
    if (!isWorkspaceRelativePosixPath(edge.provenance.path)) refuse('absolute_path', {});
    interner.add(edge.provenance.path);
    interner.add(edge.provenance.hash);
    interner.add(edge.provenance.extractor);
  }
  interner.seal();

  // 2. Edges in CSR order, so the outgoing bucket is the table itself and
  //    `from` never has to be stored per row.
  const orderedEdges = edges
    .map((edge) => ({
      edge,
      from: nodeIndex.get(edge.from) as number,
      to: nodeIndex.get(edge.to) as number,
    }))
    .sort((a, b) => a.from - b.from
      || a.to - b.to
      || (EDGE_TYPE_CODE.get(a.edge.type) as number) - (EDGE_TYPE_CODE.get(b.edge.type) as number)
      || (a.edge.id < b.edge.id ? -1 : a.edge.id > b.edge.id ? 1 : 0));

  const provenanceRows: ProvenanceRow[] = [];
  const provenanceIndex = new Map<string, number>();
  const provenanceIdFor = (row: ProvenanceRow): number => {
    const key = `${row.pathId}:${row.line}:${row.hashId}:${row.extractorId}`;
    const found = provenanceIndex.get(key);
    if (found !== undefined) return found;
    const assigned = provenanceRows.length;
    provenanceRows.push(row);
    provenanceIndex.set(key, assigned);
    return assigned;
  };

  const edgeBytes = new Uint8Array(orderedEdges.length * CONTEXT_INDEX_EDGE_ROW_BYTES);
  const edgeView = new DataView(edgeBytes.buffer);
  orderedEdges.forEach((entry, position) => {
    const at = position * CONTEXT_INDEX_EDGE_ROW_BYTES;
    const provenance = provenanceIdFor({
      pathId: interner.idOf(entry.edge.provenance.path),
      line: entry.edge.provenance.line ?? CONTEXT_INDEX_NO_VALUE,
      hashId: interner.idOf(entry.edge.provenance.hash),
      extractorId: interner.idOf(entry.edge.provenance.extractor),
    });
    edgeView.setUint32(at, entry.to, true);
    edgeView.setUint8(at + 4, EDGE_TYPE_CODE.get(entry.edge.type) as number);
    edgeView.setUint8(at + 5, CONFIDENCE_CODE.get(entry.edge.confidence) as number);
    edgeView.setUint16(at + 6, 0, true);
    edgeView.setUint32(at + 8, provenance, true);
    edgeView.setUint16(at + 12, 0xffff, true);
    edgeView.setUint16(at + 14, 0, true);
  });

  const outOffsets = csrOffsets(orderedEdges.map((entry) => entry.from), nodes.length);
  const inOrder = orderedEdges
    .map((entry, position) => ({ to: entry.to, position }))
    .sort((a, b) => a.to - b.to || a.position - b.position);
  const inOffsets = csrOffsets(inOrder.map((entry) => entry.to), nodes.length);

  // 3. Node rows, now that provenance ids exist.
  const nodeBytes = new Uint8Array(nodes.length * CONTEXT_INDEX_NODE_ROW_BYTES);
  const nodeView = new DataView(nodeBytes.buffer);
  const metadataRows: Array<[number, number, number]> = [];
  nodes.forEach((node, position) => {
    const at = position * CONTEXT_INDEX_NODE_ROW_BYTES;
    nodeView.setUint8(at, NODE_KIND_CODE.get(node.kind) as number);
    nodeView.setUint8(at + 1, FRESHNESS_CODE.get(node.freshness) as number);
    nodeView.setUint8(at + 2, RISK_CODE.get(node.risk) as number);
    nodeView.setUint8(at + 3, nodeFlags(node, protectedIds, invalidatedIds));
    nodeView.setUint16(at + 4, quantizeTrust(node.trust), true);
    nodeView.setUint16(at + 6, 0, true);
    nodeView.setUint32(at + 8, Math.max(0, Math.min(0xffffffff, Math.round(node.tokenCost))), true);
    nodeView.setUint32(at + 12, interner.idOf(node.label), true);
    nodeView.setUint32(at + 16, interner.idOrSentinel(node.path), true);
    nodeView.setUint32(at + 20, node.locator?.line ?? CONTEXT_INDEX_NO_VALUE, true);
    nodeView.setUint32(at + 24, node.locator?.column ?? CONTEXT_INDEX_NO_VALUE, true);
    nodeView.setUint32(at + 28, interner.idOrSentinel(node.contentHash), true);
    nodeView.setUint32(at + 32, position, true);
    nodeView.setUint32(at + 36, interner.idOf(node.id), true);
    for (const [key, value] of Object.entries(node.metadata ?? {})) {
      metadataRows.push([
        position,
        interner.idOf(key),
        interner.idOf(Array.isArray(value) ? value.join(',') : String(value)),
      ]);
    }
  });
  metadataRows.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);

  // 4. Anchor lane tables. The lexical and coarse tables are declared empty
  //    here; CG2-04 fills them without moving this layout.
  const exact = termTable(nodes.map((node, position) => [interner.idOf(node.id), position] as const));
  const basename = termTable(nodes
    .filter((node) => node.path !== undefined)
    .map((node) => [interner.idOf(node.path as string), nodeIndex.get(node.id) as number] as const));

  const sourceHashRows = [...new Set(nodes
    .filter((node) => node.path !== undefined && node.contentHash !== undefined)
    .map((node) => `${interner.idOf(node.path as string)}:${interner.idOf(node.contentHash as string)}`))]
    .sort()
    .map((key) => key.split(':').map(Number) as [number, number]);

  const cycleRows = [...snapshot.cycles]
    .flatMap((cycle) => cycle.nodes.map((id) => nodeIndex.get(id)).filter((value): value is number => value !== undefined))
    .sort((a, b) => a - b);

  const payloads = new Map<ContextIndexSectionKind, { bytes: Uint8Array; count: number }>([
    [CONTEXT_INDEX_SECTION.STRING_TABLE, { bytes: interner.encode(), count: interner.size }],
    [CONTEXT_INDEX_SECTION.NODE_TABLE, { bytes: nodeBytes, count: nodes.length }],
    [CONTEXT_INDEX_SECTION.NODE_METADATA, { bytes: tripleTable(metadataRows), count: metadataRows.length }],
    [CONTEXT_INDEX_SECTION.EDGE_TABLE, { bytes: edgeBytes, count: orderedEdges.length }],
    [CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS, { bytes: u32Section(outOffsets), count: outOffsets.length }],
    [CONTEXT_INDEX_SECTION.OUT_CSR_EDGES, { bytes: u32Section(orderedEdges.map((_, position) => position)), count: orderedEdges.length }],
    [CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS, { bytes: u32Section(inOffsets), count: inOffsets.length }],
    [CONTEXT_INDEX_SECTION.IN_CSR_EDGES, { bytes: u32Section(inOrder.map((entry) => entry.position)), count: inOrder.length }],
    [CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE, { bytes: exact.table, count: exact.termCount }],
    [CONTEXT_INDEX_SECTION.EXACT_POSTINGS, { bytes: exact.postings, count: exact.postingCount }],
    [CONTEXT_INDEX_SECTION.BASENAME_TABLE, { bytes: basename.table, count: basename.termCount }],
    [CONTEXT_INDEX_SECTION.BASENAME_POSTINGS, { bytes: basename.postings, count: basename.postingCount }],
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, { bytes: new Uint8Array(0), count: 0 }],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, { bytes: new Uint8Array(0), count: 0 }],
    [CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE, { bytes: new Uint8Array(0), count: 0 }],
    [CONTEXT_INDEX_SECTION.COARSE_POSTINGS, { bytes: new Uint8Array(0), count: 0 }],
    [CONTEXT_INDEX_SECTION.PROVENANCE_TABLE, { bytes: provenanceTable(provenanceRows), count: provenanceRows.length }],
    [CONTEXT_INDEX_SECTION.GROUP_TABLE, { bytes: u32Section(nodes.map((_, position) => position)), count: nodes.length }],
    [CONTEXT_INDEX_SECTION.CYCLE_TABLE, { bytes: u32Section(cycleRows), count: cycleRows.length }],
    [CONTEXT_INDEX_SECTION.SOURCE_HASH_TABLE, { bytes: pairTable(sourceHashRows), count: sourceHashRows.length }],
  ]);

  return assemble(payloads, {
    schemaRevision: input.schemaRevision,
    snapshotHash: hexToBytes(snapshot.snapshotHash, 32),
    configHash: input.configHash,
    nodeCount: nodes.length,
    edgeCount: orderedEdges.length,
    termCount: exact.termCount,
    provenanceCount: provenanceRows.length,
    stringCount: interner.size,
  });
}
