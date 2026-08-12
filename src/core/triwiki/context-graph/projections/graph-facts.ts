/**
 * The facts a projection reads off the compact index (CG2-13).
 *
 * Every projection in this package used to reach into `ContextGraphIndex` — a
 * parsed JSON snapshot with `nodesById`, `nodesByLabel` and a materialized
 * adjacency map. None of those exist on the compact reader, and re-deriving them
 * per projection would rebuild the object graph CRK2 deletes. So the three things
 * the projections actually needed are collected here, once, over the facade's own
 * surfaces:
 *
 * - **kind enumeration**, as an integer scan rather than a node array;
 * - **one-hop typed neighbours**, through `walkContextGraph`, because a
 *   projection asking "what does this file define" is asking about graph shape
 *   and not about relevance — the retrieval kernel structurally cannot answer it;
 * - **metadata coercion**, because the writer interns every metadata value
 *   through `String(value)`.
 *
 * ## Metadata values arrive as strings, and that is a live defect
 *
 * `ContextGraphNodeView.metadata` is `Record<string, string>`. A boolean `true`
 * written by an extractor arrives as `'true'`, and a number as its decimal text.
 * So `metadata.exported === true` is silently false against a v2 index and
 * `typeof metadata.lines === 'number'` never holds. `contextNodeFlag` (the
 * facade's helper) is the only sanctioned way to read a flag; `contextNodeCount`
 * is its numeric counterpart, and both exist because the failure is invisible —
 * the predicate does not throw, it just stops matching.
 *
 * ## One hop is a walk, not a query
 *
 * `contextOneHopNeighbours` deduplicates by target, which `outgoingEdges` did
 * not: two edges of different types between the same pair now count once, and
 * the type reported is the first one the walk crossed. That changes a
 * profile-weighted *score* — never which nodes are reachable — and it is written
 * down here rather than discovered later from a moved ranking.
 *
 * ## What each projection lost, and what it kept
 *
 * Recorded here once so the six files can state their own contracts instead of
 * re-explaining the format:
 *
 * - **`anchors.ts`** lost `code:<module-label>` resolution. Format revision 1 has
 *   no label table — the exact table holds canonical node ids, the basename table
 *   holds whole workspace-relative paths — so a bare label reaches neither and the
 *   anchor is reported unresolved. Guessing it through BM25F would attach one
 *   module's provenance to another module's claim, which ADR §4 forbids: a text
 *   match is not a relation. This returns when the lexicon is wired into the
 *   writer, and nothing fakes it in the meantime.
 * - **`module-view.ts` and `node-summary.ts`** kept their metadata predicates only
 *   by reading through `contextNodeFlag` / `contextNodeCount`. `exported` is the
 *   predicate at stake in both; compared against `true` it is always false, and
 *   every module would report an empty export surface with nothing raised.
 * - **`code-pack.ts`** kept both of its modes but on different surfaces: the query
 *   mode on the retrieval kernel, the corpus mode on `walkContextGraph`. Asking
 *   the kernel for "every module" would return a bounded top-K and silently shrink
 *   the corpus pack.
 * - **`attention.ts` and `code-pack-workspace.ts`** kept their three public failure
 *   codes through `projectionFailureCode`, so every consumer branching on
 *   `context_graph_missing` still works against the ADR §5 vocabulary.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_EDGE_TYPES,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_NODE_KINDS,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphEdgeType,
  type ContextGraphNodeKind
} from '../contracts.js';
import type { ContextGraphProvenanceRef } from '../query-types.js';
import {
  contextWalkProvenance,
  contextWalkRoot,
  walkContextGraph,
  type ContextGraphNodeView,
  type ContextIndexReader,
  type ContextWalkCaps,
  type ContextWalkHit,
  type HydrationCursor
} from '../query/index.js';

/**
 * Bounds for a projection's one-hop reads.
 *
 * Depth is 1 by construction: everything in this package describes a node from
 * its immediate neighbourhood, and a projection that wanted depth 2 would be
 * asking a different question. The edge bound is what keeps a hub node from
 * making the cost of describing one file depend on the shape of the graph.
 */
export const PROJECTION_ONE_HOP_CAPS: ContextWalkCaps = Object.freeze({
  maxDepth: 1,
  maxNodes: 512,
  maxEdges: 8192
});

/** Kind -> its integer code, which is the position in the frozen kind list. */
const KIND_CODE: ReadonlyMap<ContextGraphNodeKind, number> = new Map(
  CONTEXT_GRAPH_NODE_KINDS.map((kind, code) => [kind, code])
);

/**
 * Node indices of one kind, in index order.
 *
 * An integer scan over `nodeKind` rather than a materialized list: the reader
 * offers no "all nodes of kind X" and building one would allocate an array sized
 * by the graph, which is the cost CRK2 exists to remove. One byte is read per
 * node and nothing is hydrated.
 */
export function contextNodesOfKind(reader: ContextIndexReader, kind: ContextGraphNodeKind): number[] {
  const code = KIND_CODE.get(kind);
  const out: number[] = [];
  if (code === undefined) return out;
  for (let node = 0; node < reader.nodeCount; node += 1) {
    if (reader.nodeKind(node) === code) out.push(node);
  }
  return out;
}

/** How many nodes carry `kind`. Same scan, without the array. */
export function contextCountOfKind(reader: ContextIndexReader, kind: ContextGraphNodeKind): number {
  const code = KIND_CODE.get(kind);
  if (code === undefined) return 0;
  let count = 0;
  for (let node = 0; node < reader.nodeCount; node += 1) {
    if (reader.nodeKind(node) === code) count += 1;
  }
  return count;
}

export interface ProjectionNeighbour {
  readonly view: ContextGraphNodeView;
  /** The relation the walk crossed to reach it. */
  readonly type: ContextGraphEdgeType;
}

/**
 * The nodes one typed hop out of `node`, hydrated.
 *
 * Deduplicated by target, in the order the walk reached them — the CSR buckets
 * are written in a fixed order by the compiler, so the same index yields the same
 * neighbours in the same order on every machine.
 */
export function contextOneHopNeighbours(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: number,
  nodeId: string,
  edgeTypes: ReadonlySet<ContextGraphEdgeType>,
  caps: ContextWalkCaps = PROJECTION_ONE_HOP_CAPS
): ProjectionNeighbour[] {
  const walk = walkContextGraph(reader, cursor, {
    roots: [contextWalkRoot(node, nodeId)],
    direction: 'out',
    edgeTypes,
    caps
  });
  const out: ProjectionNeighbour[] = [];
  for (const hit of walk.hits.values()) {
    if (hit.depth !== 1) continue;
    const step = hit.explanation[hit.explanation.length - 1];
    const view = cursor.node(hit.node);
    if (step === undefined || view === null) continue;
    out.push({ view, type: step.type });
  }
  return out;
}

/**
 * Every relation. The v1 corpus score summed `profileEdgeWeight` over a node's
 * whole out-edge list, so narrowing this set would silently re-tune the ranking.
 */
export const PROJECTION_ALL_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(CONTEXT_GRAPH_EDGE_TYPES);

/**
 * Repository truth behind a node, with the incident-edge fallback v1's grounding
 * had.
 *
 * A module node addresses a directory, so it carries no source record of its own
 * and `reader.provenance` returns nothing for it. Its `contains` edges do carry
 * one, and reporting a module as ungrounded because of that would strip the
 * identity hashes off every module anchor — a silent downgrade of exactly the
 * thing the trust rule protects. Out-edges before in-edges, and the first
 * direction that yields anything wins, which is the v1 order.
 */
export function contextGroundedProvenance(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: ContextGraphNodeView,
  limit: number
): ContextGraphProvenanceRef[] {
  const root = contextWalkRoot(node.node, node.id);
  const own = contextWalkProvenance(reader, cursor, root, limit);
  if (own.length > 0) return own;
  for (const direction of ['out', 'in'] as const) {
    const walk = walkContextGraph(reader, cursor, {
      roots: [root],
      direction,
      edgeTypes: PROJECTION_ALL_EDGE_TYPES,
      caps: PROJECTION_ONE_HOP_CAPS
    });
    for (const hit of walk.hits.values()) {
      if (hit.depth !== 1) continue;
      const refs = contextWalkProvenance(reader, cursor, hit, limit);
      if (refs.length > 0) return refs;
    }
  }
  return [];
}

/** A metadata value read as text. Empty is absent: the writer interns `''` for nothing. */
export function contextNodeText(view: ContextGraphNodeView, key: string): string | null {
  const value = view.metadata[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * A metadata value read as a number.
 *
 * The counterpart to `contextNodeFlag`: the writer interns `42` as `'42'`, so
 * every v1 predicate spelled `typeof metadata.lines === 'number'` goes silently
 * false against a v2 index and the projected sentence loses a fact it had. The
 * empty-string guard is load-bearing — `Number('')` is `0`, which would report a
 * file of zero lines as a measured fact rather than as a missing one.
 */
export function contextNodeCount(view: ContextGraphNodeView, key: string): number | null {
  const raw = view.metadata[key];
  if (typeof raw !== 'string' || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** The public `context_graph_*` code a projection reports for an index failure. */
export type ProjectionFailureCode =
  | typeof CONTEXT_GRAPH_MISSING_ERROR
  | typeof CONTEXT_GRAPH_STALE_ERROR
  | typeof CONTEXT_GRAPH_CORRUPT_ERROR;

/**
 * Map a frozen ADR §5 index code onto the `context_graph_*` code these
 * projections have always reported.
 *
 * The three public codes are unchanged by the migration, so nothing downstream
 * has to learn a new vocabulary. The mapping is total and errs toward `corrupt`:
 * an unrecognized failure is not evidence that the index is merely absent, and
 * reporting "missing" for a damaged index would send a user to the wrong repair.
 */
export function projectionFailureCode(code: string): ProjectionFailureCode {
  if (code === 'context_index_missing') return CONTEXT_GRAPH_MISSING_ERROR;
  if (code === 'context_index_stale') return CONTEXT_GRAPH_STALE_ERROR;
  return CONTEXT_GRAPH_CORRUPT_ERROR;
}

/** Failure text in the shape consumers already parse: code, detail, repair command. */
export function projectionFailureErrors(code: string, repairCommand: string): string[] {
  return [
    projectionFailureCode(code),
    `the stored context index is unusable (${code})`,
    `Run \`${repairCommand}\` to rebuild the context graph.`
  ];
}
