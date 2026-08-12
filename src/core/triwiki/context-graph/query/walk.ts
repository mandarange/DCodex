/**
 * Bounded typed closure walks over the compact index (CG2-13).
 *
 * This is the facade's *second* surface, and it exists because two production
 * consumers ask the graph a question the retrieval kernel structurally cannot
 * answer. The Naruto scope advisory needs "what does this file stand on" and
 * "what has to be re-verified if it changes"; the affected-gate selector needs
 * the same reverse closure. Those are typed reachability questions with a fixed
 * edge-type set and no notion of relevance — forcing them through
 * `runContextKernel`, which fuses lanes and *selects* a bounded top-K, would
 * change which gates a release runs. Silently selecting fewer gates looks like a
 * speed-up until something ships broken.
 *
 * So the boundary is drawn precisely:
 *
 * - **This is not a second retrieval engine.** No scoring, no ranking, no
 *   candidate selection, no fusion. A walk returns everything it reached inside
 *   its caps, in insertion order, and says whether a cap stopped it. If anything
 *   here ever needs to decide that one reachable node matters more than another,
 *   that belongs in the kernel and this design is wrong.
 * - **Seeds are resolved exactly or reported.** A token that is not a real
 *   workspace path or a real canonical node id is returned as unresolved, never
 *   guessed at through BM25F. A text match is not a relation (ADR §4), and an
 *   advisory that guessed its own scope would be confidently wrong about which
 *   slices can run in parallel.
 * - **Caps are the caller's.** The affected selector and the advisory have
 *   different budgets, and a shared constant would silently re-tune one of them.
 */
import { CONTEXT_GRAPH_EDGE_TYPES, type ContextGraphEdgeType } from '../contracts.js';
import { contextGraphEdgeId } from '../ids.js';
import { CONTEXT_INDEX_PROFILE_MASK_ALL } from '../runtime-index/reader.js';
import type { ContextGraphNodeView, ContextIndexReader } from '../runtime-index/reader.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../query-types.js';
import { HydrationCursor } from './hydrate-chain.js';

/**
 * Marks a hop the walk crossed against the edge's own direction.
 *
 * The prefix form rather than a boolean because `reason_path` is a published
 * string array on the advisory's output, and its readers already parse this.
 */
export const REVERSE_HOP_PREFIX = '<-';

const EDGE_TYPE_CODES: ReadonlyMap<ContextGraphEdgeType, number> =
  new Map(CONTEXT_GRAPH_EDGE_TYPES.map((type, code) => [type, code]));

export interface ContextWalkCaps {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxEdges: number;
}

export interface ContextWalkHit {
  readonly node: number;
  readonly nodeId: string;
  readonly depth: number;
  /** `[nodeId, relation, nodeId, …]`; a reverse hop reads `<-relation`. */
  readonly reasonPath: readonly string[];
  readonly explanation: readonly ContextGraphExplanationStep[];
  /** Edge rows on the path to this hit, root first. Feeds provenance. */
  readonly edges: readonly number[];
}

export interface ContextWalkResult {
  /** Keyed by node index, in the order the walk reached them. */
  readonly hits: ReadonlyMap<number, ContextWalkHit>;
  /** True when a node or edge cap stopped the walk before it was exhausted. */
  readonly truncated: boolean;
  readonly visitedEdges: number;
}

export interface ContextWalkRequest {
  readonly roots: readonly ContextWalkHit[];
  readonly direction: 'out' | 'in';
  readonly edgeTypes: ReadonlySet<ContextGraphEdgeType>;
  readonly caps: ContextWalkCaps;
}

/**
 * A node's metadata value read as a boolean.
 *
 * Format revision 1 stored every metadata value through `String(value)`, so a
 * snapshot's real boolean `true` arrived as the *string* `'true'` and every
 * predicate spelled `metadata.isTest === true` went silently false — dropping
 * test recommendations and demoting protected gates with no error anywhere.
 * Revision 2's metadata row tag fixed that at the format, and `true` now arrives
 * as `true`.
 *
 * The string arms stay, and are not vestigial: extractors author this flag both
 * ways. `topology/gates.ts` writes a real boolean, `crk2-fuzz-index.ts` and
 * several fixtures write `'true'`, and both are legal `ContextGraphMetadataValue`s
 * that mean the same thing to a caller. Narrowing this to `=== true` the day the
 * format was fixed would have moved the silent-false failure from one set of
 * nodes to another, which is why the helper reads *both* rather than being
 * retired.
 */
export function contextNodeFlag(view: ContextGraphNodeView, key: string): boolean {
  const value = view.metadata[key];
  return value === true || value === 'true' || value === '1';
}

/** A walk root at depth 0, with no hop behind it. */
export function contextWalkRoot(node: number, nodeId: string): ContextWalkHit {
  return { node, nodeId, depth: 0, reasonPath: [nodeId], explanation: [], edges: [] };
}

export interface ContextSeedResolution {
  /** Node indices, deduplicated, in the order their key was offered. */
  readonly nodes: readonly number[];
  /** Keys that matched nothing. Reported, never guessed at. */
  readonly unresolved: readonly string[];
}

/**
 * Resolve seed keys to node indices.
 *
 * `paths` go to the basename table, which format revision 1 keys by the whole
 * workspace-relative path; `ids` go to the exact table, which holds canonical
 * node ids. Revision 1 has **no label table**, so a bare symbol name resolves
 * only when it happens to be a canonical id — see the note in
 * `naruto/context-graph-advisor-scope.ts` about what that changed.
 */
export function resolveContextSeeds(
  reader: ContextIndexReader,
  paths: readonly string[],
  ids: readonly string[],
  maxPerKey: number,
): ContextSeedResolution {
  const nodes: number[] = [];
  const seen = new Set<number>();
  const unresolved: string[] = [];

  const take = (key: string, postings: { length: number; node(index: number): number }): void => {
    // A key matching an implausible number of nodes is too generic to be honest
    // evidence of scope, which is the v1 `maxNodesPerLabel` rule kept intact.
    if (postings.length === 0 || postings.length > maxPerKey) {
      if (key && !unresolved.includes(key)) unresolved.push(key);
      return;
    }
    for (let at = 0; at < postings.length; at += 1) {
      const node = postings.node(at);
      if (seen.has(node)) continue;
      seen.add(node);
      nodes.push(node);
    }
  };

  for (const value of paths) take(value, reader.basename(value));
  for (const value of ids) take(value, reader.exact(value));
  return { nodes, unresolved };
}

/**
 * Breadth-first walk over the typed edges the caller named.
 *
 * Deterministic: the CSR buckets the cursor reads are written in a fixed order
 * by the compiler, so the same index and the same roots produce the same hits in
 * the same order on every machine.
 *
 * Edge budget is counted per row examined, including rows the type filter
 * rejects, because that is the work actually done — counting only admitted edges
 * would report a bound the walk can never hit on a hub node.
 */
export function walkContextGraph(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  request: ContextWalkRequest,
): ContextWalkResult {
  const allowed = new Set<number>();
  for (const type of request.edgeTypes) {
    const code = EDGE_TYPE_CODES.get(type);
    if (code !== undefined) allowed.add(code);
  }

  const hits = new Map<number, ContextWalkHit>();
  const queue: ContextWalkHit[] = [];
  for (const root of request.roots) {
    if (hits.has(root.node) || !isNode(reader, root.node)) continue;
    hits.set(root.node, root);
    queue.push(root);
  }

  let visitedEdges = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current || current.depth >= request.caps.maxDepth) continue;
    const edges = request.direction === 'out'
      ? reader.outgoing(current.node, CONTEXT_INDEX_PROFILE_MASK_ALL)
      : reader.incoming(current.node, CONTEXT_INDEX_PROFILE_MASK_ALL);

    while (edges.next()) {
      visitedEdges += 1;
      if (visitedEdges > request.caps.maxEdges) return { hits, truncated: true, visitedEdges };
      if (!allowed.has(edges.type)) continue;
      const next = edges.target;
      if (hits.has(next) || !isNode(reader, next)) continue;
      if (hits.size >= request.caps.maxNodes) return { hits, truncated: true, visitedEdges };

      const hit = extend(cursor, current, edges.edge, next, request.direction);
      if (hit === null) continue;
      hits.set(next, hit);
      queue.push(hit);
    }
  }
  return { hits, truncated: false, visitedEdges };
}

function isNode(reader: ContextIndexReader, node: number): boolean {
  return Number.isInteger(node) && node >= 0 && node < reader.nodeCount;
}

/**
 * One hop, named.
 *
 * A step's `from`/`to` are the *edge's* endpoints, never the walk's. A rendered
 * path that swapped them would claim `b imports a` because the walk happened to
 * arrive from `b`; the direction the walk took is carried by the reverse prefix
 * on the relation instead, which is the one place it belongs.
 *
 * Returns `null` when the hop cannot be named — an edge or node the index does
 * not contain. The caller drops the neighbour rather than emitting a hop it
 * cannot attest to.
 */
function extend(
  cursor: HydrationCursor,
  from: ContextWalkHit,
  edge: number,
  next: number,
  direction: 'out' | 'in',
): ContextWalkHit | null {
  const view = cursor.edge(edge);
  const target = cursor.node(next);
  if (view === null || target === null) return null;
  const reverse = direction === 'in';
  const sourceId = reverse ? target.id : from.nodeId;
  const targetId = reverse ? from.nodeId : target.id;

  return {
    node: next,
    nodeId: target.id,
    depth: from.depth + 1,
    reasonPath: [...from.reasonPath, reverse ? `${REVERSE_HOP_PREFIX}${view.type}` : view.type, target.id],
    explanation: [
      ...from.explanation,
      {
        edgeId: contextGraphEdgeId({ type: view.type, from: sourceId, to: targetId }),
        type: view.type,
        from: sourceId,
        to: targetId,
        confidence: view.confidence,
        path: view.provenance.path,
      },
    ],
    edges: [...from.edges, edge],
  };
}

/**
 * Repository truth behind a hop chain: the provenance of the edges it crossed,
 * deduplicated, falling back to the node's own source record for a zero-hop hit.
 *
 * Edges first and node second — the reverse of what `reader.provenance` returns —
 * because the question a reason path answers is "which committed bytes say this
 * relation exists", and the node's own content hash answers that only when there
 * is no relation to point at.
 */
export function contextWalkProvenance(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  hit: ContextWalkHit,
  limit: number,
): ContextGraphProvenanceRef[] {
  const out: ContextGraphProvenanceRef[] = [];
  const seen = new Set<string>();
  for (const edge of hit.edges) {
    const view = cursor.edge(edge);
    if (view === null) continue;
    const record = view.provenance;
    const key = `${record.path}#${record.line ?? 0}#${record.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: record.path, ...(record.line === undefined ? {} : { line: record.line }), hash: record.hash });
    if (out.length >= limit) return out;
  }
  if (out.length > 0) return out;

  for (const record of reader.provenance(hit.node, [])) {
    out.push({ path: record.path, ...(record.line === undefined ? {} : { line: record.line }), hash: record.hash });
    if (out.length >= limit) break;
  }
  return out;
}

export { HydrationCursor };
