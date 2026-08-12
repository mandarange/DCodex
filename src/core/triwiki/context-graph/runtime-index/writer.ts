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
  CONTEXT_INDEX_PROFILE_MASK_RESERVED,
  EDGE_TYPE_CODE,
  FRESHNESS_CODE,
  NODE_KIND_CODE,
  RISK_CODE,
  contextIndexMetadataCells,
  isWorkspaceRelativePosixPath,
  refuse,
} from './writer-contract.js';
import {
  StringInterner,
  csrOffsets,
  hexToBytes,
  metadataTable,
  nodeFlags,
  pairTable,
  provenanceTable,
  termTable,
  u32Section,
} from './writer-tables.js';
import { assemble } from './writer-assemble.js';
import {
  EMPTY_CONTEXT_INDEX_LANE,
  buildContextIndexLexical,
  encodeContextIndexLane,
  type ContextIndexLexicalBuild,
} from './writer-lexical.js';
import type { ContextIndexWriteInput, ContextIndexWriteResult, MetadataRow, ProvenanceRow } from './writer-types.js';
import type { ContextIndexSectionKind } from './format.js';

export * from './writer-contract.js';
export * from './writer-types.js';
export * from './writer-lexical.js';
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
    // A metadata value is interned as its own canonical text and nothing else,
    // which is what lets a fixture seed a lexicon term through a metadata value:
    // `{ lexeme: 'kernel' }` interns `kernel`, so `termId('kernel')` resolves.
    // The type is carried by the row's tag instead — see `writer-contract.ts`.
    for (const [key, value] of Object.entries(node.metadata ?? {})) {
      interner.add(key);
      for (const cell of contextIndexMetadataCells(value)) interner.add(cell.text);
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

  // The lexicon has to be built before the seal and encoded after it: a term id
  // *is* a string-table id (see `writer-lexical.ts`), so every term the builder
  // keeps must be interned alongside the ids, labels and paths above, and the
  // ids it will be encoded with do not exist until the table is sorted.
  const lexical: ContextIndexLexicalBuild | null =
    input.lexicon === undefined ? null : buildContextIndexLexical(nodes, input.lexicon);
  if (lexical !== null) {
    for (const term of lexical.terms) interner.add(term);
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
    // Reserved in revision 1, and deliberately not filled. Profile membership
    // is ranking configuration, and the kernel already excludes an edge with a
    // single integer test on its type — precomputing the same answer per edge
    // would buy nothing and would bake a tuning decision into the bytes, so
    // every profile bit is set and the field excludes nothing. A reader must
    // not treat it as authoritative until a later revision says otherwise.
    edgeView.setUint16(at + 12, CONTEXT_INDEX_PROFILE_MASK_RESERVED, true);
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
  const metadataRows: MetadataRow[] = [];
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
      const keyId = interner.idOf(key);
      for (const cell of contextIndexMetadataCells(value)) {
        metadataRows.push({
          node: position,
          key: keyId,
          value: interner.idOf(cell.text),
          type: cell.type,
          ordinal: cell.ordinal,
        });
      }
    }
  });
  // `(node, key, ordinal)` is unique by construction — `Object.entries` yields
  // each key once — so this is a total order and the last two terms are
  // unreachable. They are written anyway: a comparator that ties is a
  // comparator whose output depends on the engine's sort stability, and the
  // writer's determinism contract does not get to assume V8.
  metadataRows.sort((a, b) => a.node - b.node
    || a.key - b.key
    || a.ordinal - b.ordinal
    || a.type - b.type
    || a.value - b.value);

  // 4. Anchor lane tables, then the two dictionary lanes.
  //
  //    The anchor tables are keyed by whole interned values — a canonical node
  //    id, a whole workspace-relative path — which is why they alone can carry
  //    `exact` confidence. The dictionary lanes below are keyed by tokenized
  //    terms and are `text_candidate` at any score.
  const exact = termTable(nodes.map((node, position) => [interner.idOf(node.id), position] as const));
  const basename = termTable(nodes
    .filter((node) => node.path !== undefined)
    .map((node) => [interner.idOf(node.path as string), nodeIndex.get(node.id) as number] as const));

  const sourceHashRows = [...new Set(nodes
    .filter((node) => node.path !== undefined && node.contentHash !== undefined)
    .map((node) => `${interner.idOf(node.path as string)}:${interner.idOf(node.contentHash as string)}`))]
    .sort()
    .map((key) => key.split(':').map(Number) as [number, number]);

  const termIdOf = (term: string): number => interner.idOf(term);
  const lexiconLane = lexical === null
    ? EMPTY_CONTEXT_INDEX_LANE
    : encodeContextIndexLane(lexical.lexical, termIdOf, nodes.length);
  const coarseLane = lexical === null
    ? EMPTY_CONTEXT_INDEX_LANE
    : encodeContextIndexLane(lexical.coarse, termIdOf, nodes.length);

  const cycleRows = [...snapshot.cycles]
    .flatMap((cycle) => cycle.nodes.map((id) => nodeIndex.get(id)).filter((value): value is number => value !== undefined))
    .sort((a, b) => a - b);

  const payloads = new Map<ContextIndexSectionKind, { bytes: Uint8Array; count: number }>([
    [CONTEXT_INDEX_SECTION.STRING_TABLE, { bytes: interner.encode(), count: interner.size }],
    [CONTEXT_INDEX_SECTION.NODE_TABLE, { bytes: nodeBytes, count: nodes.length }],
    [CONTEXT_INDEX_SECTION.NODE_METADATA, { bytes: metadataTable(metadataRows), count: metadataRows.length }],
    [CONTEXT_INDEX_SECTION.EDGE_TABLE, { bytes: edgeBytes, count: orderedEdges.length }],
    [CONTEXT_INDEX_SECTION.OUT_CSR_OFFSETS, { bytes: u32Section(outOffsets), count: outOffsets.length }],
    [CONTEXT_INDEX_SECTION.OUT_CSR_EDGES, { bytes: u32Section(orderedEdges.map((_, position) => position)), count: orderedEdges.length }],
    [CONTEXT_INDEX_SECTION.IN_CSR_OFFSETS, { bytes: u32Section(inOffsets), count: inOffsets.length }],
    [CONTEXT_INDEX_SECTION.IN_CSR_EDGES, { bytes: u32Section(inOrder.map((entry) => entry.position)), count: inOrder.length }],
    [CONTEXT_INDEX_SECTION.EXACT_TERM_TABLE, { bytes: exact.table, count: exact.termCount }],
    [CONTEXT_INDEX_SECTION.EXACT_POSTINGS, { bytes: exact.postings, count: exact.postingCount }],
    [CONTEXT_INDEX_SECTION.BASENAME_TABLE, { bytes: basename.table, count: basename.termCount }],
    [CONTEXT_INDEX_SECTION.BASENAME_POSTINGS, { bytes: basename.postings, count: basename.postingCount }],
    [CONTEXT_INDEX_SECTION.LEXICON_TABLE, { bytes: lexiconLane.table, count: lexiconLane.termCount }],
    [CONTEXT_INDEX_SECTION.LEXICON_POSTINGS, { bytes: lexiconLane.postings, count: lexiconLane.postingCount }],
    [CONTEXT_INDEX_SECTION.COARSE_TERM_TABLE, { bytes: coarseLane.table, count: coarseLane.termCount }],
    [CONTEXT_INDEX_SECTION.COARSE_POSTINGS, { bytes: coarseLane.postings, count: coarseLane.postingCount }],
    [CONTEXT_INDEX_SECTION.PROVENANCE_TABLE, { bytes: provenanceTable(provenanceRows), count: provenanceRows.length }],
    [CONTEXT_INDEX_SECTION.GROUP_TABLE, { bytes: u32Section(nodes.map((_, position) => position)), count: nodes.length }],
    [CONTEXT_INDEX_SECTION.CYCLE_TABLE, { bytes: u32Section(cycleRows), count: cycleRows.length }],
    [CONTEXT_INDEX_SECTION.SOURCE_HASH_TABLE, { bytes: pairTable(sourceHashRows), count: sourceHashRows.length }],
  ]);

  // `header.termCount` stays the *exact* table's count: `reader-validate.ts`
  // checks the two against each other, and widening it to include dictionary
  // terms would make a healthy index fail that check.
  const assembled = assemble(payloads, {
    schemaRevision: input.schemaRevision,
    snapshotHash: hexToBytes(snapshot.snapshotHash, 32),
    configHash: input.configHash,
    nodeCount: nodes.length,
    edgeCount: orderedEdges.length,
    termCount: exact.termCount,
    provenanceCount: provenanceRows.length,
    stringCount: interner.size,
  });

  return {
    ...assembled,
    lexicon: lexical === null
      ? null
      : {
          termCount: lexiconLane.termCount,
          postingCount: lexiconLane.postingCount,
          coarseTermCount: coarseLane.termCount,
          coarsePostingCount: coarseLane.postingCount,
          omissions: lexical.omissions,
        },
  };
}
