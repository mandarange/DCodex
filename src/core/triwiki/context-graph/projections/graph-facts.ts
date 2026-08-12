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
 * the type reported is the lowest edge-type code between that pair. That changes
 * a profile-weighted *score* — never which nodes are reachable — and it is
 * written down here rather than discovered later from a moved ranking.
 *
 * ## A one-hop answer says whether it is complete
 *
 * The walk reports `truncated` when a cap stopped it, and this file used to drop
 * that on the floor: a hub past `maxNodes` returned a subset that read exactly
 * like a complete neighbourhood. It is now carried on `ProjectionOneHop`.
 *
 * Measured on the real graph (28,660 nodes / 77,347 edges) the caps have never
 * been reachable through this function, which only ever walks `out`: the widest
 * node is `module:src/scripts` at 471 distinct out-neighbours against an
 * effective bound of 511, and the widest edge scan is the same 471 rows against
 * 8,192. So the flag is a guarantee, not a repair — but 471 of 511 is 8% of
 * headroom, and the thing that closes it is a directory growing.
 *
 * Which consumers act on it is decided by whether a short list makes a stated
 * fact *false* or merely makes an answer *smaller*, and only the first kind is
 * worth a branch:
 *
 * - **`module-view.ts` reads it.** The module headline states a file count, and
 *   a truncated `contains` walk would state the truncated one as the module's
 *   size. The compiler already records the real count on the node — all 119
 *   modules carry `fileCount` — so the recorded fact wins whenever the walk is
 *   short. That sentence is hashed into `index_digest` and shipped as
 *   `sks.code-pack.v1` entry text.
 * - **`projection-candidate.ts` and the score arm of `module-view.ts` do not.**
 *   A short list lowers a profile-weighted score and shortens a citation list.
 *   Nothing downstream states how many relations were counted, and
 *   `ProjectionCandidate` has no field a caller reads to learn it — adding one
 *   would be a channel nobody reads. Widest reachable: 248 out-neighbours.
 * - **`node-summary.ts` does not, and that is a recorded limit.** `listOf`
 *   renders "and N more", which a truncated walk would understate. Reaching it
 *   needs 512 `defines`/`reexports` off one node where the real graph's widest is
 *   154, and being honest about it means threading completeness through
 *   `NodeSummaryExtras` for both the direct and the module-aggregated arms — for
 *   a state no repository has produced. If that headroom closes, the phrasing
 *   becomes "and at least N more" and the flag threads through `extras`.
 *
 * `truncated` is a flag and not a count on purpose: the caps are enforced
 * *inside* `walkContextGraph`, so the distinct total is never reached and any
 * number reported here would be invented.
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
import { compareContextGraphIds } from '../ids.js';
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

export interface ProjectionOneHop {
  /** Deduplicated by target, ascending canonical node id. */
  readonly neighbours: ProjectionNeighbour[];
  /**
   * A node or edge cap stopped the walk, so more neighbours exist than are
   * listed. How many more is not knowable — see the file header.
   */
  readonly truncated: boolean;
}

/**
 * Depth-1 hits, ordered by canonical node id.
 *
 * The walk returns what it reached in *adjacency order*, and every projection in
 * this package used to take that as its answer. Adjacency order happens to be
 * ascending node id today, because `runtime-index/writer.ts` assigns node indices
 * in id order and sorts each CSR bucket by target index — a fact about that
 * comparator, not about these projections. Reversing the snapshot's node and edge
 * arrays and re-encoding produces byte-identical bucket order and, measured over
 * the real graph, identical output at every consumer (244 nodes with 40+
 * neighbours, 119 module candidates, 119 anchors: 0 differences). So this sort is
 * a **no-op today and is here to stay one**: a writer that re-sorted buckets for
 * locality would otherwise move 102 module anchors' `source_hash` and the
 * citations of 119 module entries, with nothing failing.
 *
 * One key is enough, unlike the `(depth, key, nodeId)` rule the affected-gate
 * selector needs. Depth is constant — every hit here is filtered to depth 1 — and
 * the walk deduplicates by node index, so there is exactly one row per target and
 * the canonical node id is already unique. A second key would order nothing.
 */
function depthOneHitsById(hits: Iterable<ContextWalkHit>): ContextWalkHit[] {
  const ordered: ContextWalkHit[] = [];
  for (const hit of hits) if (hit.depth === 1) ordered.push(hit);
  return ordered.sort((left, right) => compareContextGraphIds(left.nodeId, right.nodeId));
}

/**
 * The nodes one typed hop out of `node`, hydrated, with whether that is all of
 * them.
 *
 * Deduplicated by target and ordered by canonical node id. The completeness flag
 * is the walk's own, no longer discarded; the file header records which consumers
 * act on it and why the others do not.
 */
export function contextOneHopNeighbours(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: number,
  nodeId: string,
  edgeTypes: ReadonlySet<ContextGraphEdgeType>,
  caps: ContextWalkCaps = PROJECTION_ONE_HOP_CAPS
): ProjectionOneHop {
  const walk = walkContextGraph(reader, cursor, {
    roots: [contextWalkRoot(node, nodeId)],
    direction: 'out',
    edgeTypes,
    caps
  });
  const neighbours: ProjectionNeighbour[] = [];
  for (const hit of depthOneHitsById(walk.hits.values())) {
    const step = hit.explanation[hit.explanation.length - 1];
    const view = cursor.node(hit.node);
    if (step === undefined || view === null) continue;
    neighbours.push({ view, type: step.type });
  }
  return { neighbours, truncated: walk.truncated };
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
 *
 * *Which* incident edge grounds the node is decided by canonical node id, for the
 * reason `depthOneHitsById` gives. This is not a cosmetic tie-break: the first
 * returned row's `hash` becomes an anchor's `source_hash` and `claim_hash`, and
 * the fallback is not rare on the shapes that use it — 162 of the real graph's
 * 28,660 nodes have no source record of their own (119 modules, 16 gates, a risk
 * domain, and 26 files that ground nowhere), and 119 of those choose between two
 * or more grounded neighbours.
 *
 * A truncated walk is deliberately not reported. It can only shrink the candidate
 * set, and a shrunken set yields either the same first grounded hit or none —
 * fewer provenance rows, never a fabricated one, and an anchor with none scores
 * trust 0 rather than claiming a hash it did not earn. The failure direction is
 * conservative, so there is nothing for a caller to repair. Measured: exactly one
 * node reaches the cap here (`risk:proof-subject/gate`, 512 in-edges) and it
 * grounds anyway.
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
    for (const hit of depthOneHitsById(walk.hits.values())) {
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
 * The counterpart to `contextNodeFlag`. Format revision 1 interned `42` as
 * `'42'`, so every predicate spelled `typeof metadata.lines === 'number'` went
 * silently false and the projected sentence lost a fact it had; revision 2's row
 * tag restores the number. The text arm stays for the same reason the flag's
 * does — a metadata value may legitimately be authored as text — and the
 * empty-string guard stays because `Number('')` is `0`, which would report a
 * file of zero lines as a measured fact rather than as a missing one.
 */
export function contextNodeCount(view: ContextGraphNodeView, key: string): number | null {
  const raw = view.metadata[key];
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
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
