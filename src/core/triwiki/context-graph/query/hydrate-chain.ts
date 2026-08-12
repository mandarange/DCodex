/**
 * Parent-chain reconstruction for the selected set (CG2-10, §8.4).
 *
 * The kernel hands out a node integer, a parent pointer and an edge chain. Two
 * things have to happen before that becomes an explanation, and both are
 * awkward enough that doing them wrong is the default:
 *
 * - **An edge row stores only its target.** The source lives in the outgoing CSR
 *   bucket, which the reader exposes only through an incoming cursor. So a hop's
 *   direction cannot be read off the edge; it is *derived* by asking which of the
 *   edge's two endpoints the walk was standing on.
 * - **An edge row stores no id string.** `ContextGraphExplanationStep.edgeId` is
 *   re-derived through `contextGraphEdgeId`, which the ADR fixes as a pure digest
 *   of `(type, from, to)`. That reproduces the snapshot's own id exactly — it is
 *   a re-derivation, not a parallel id space.
 *
 * Everything here runs *after* selection, over at most `maxSelected` chains of at
 * most `maxDepth` hops. Nothing in this file is reachable from ranking.
 */
import { contextGraphEdgeId } from '../ids.js';
import { CONTEXT_INDEX_PROFILE_MASK_ALL } from '../runtime-index/reader.js';
import type {
  ContextGraphEdgeView,
  ContextGraphNodeView,
  ContextIndexReader,
} from '../runtime-index/reader.js';
import type { ContextGraphExplanationStep } from '../query-types.js';
import type { SelectedCandidate } from './kernel-types.js';

const NO_NODE = -1;

/**
 * Every whole-object read hydration performs, memoized and counted.
 *
 * The counters are public because "only the selected set was materialized" is
 * the card's floor, and a floor a caller cannot read is a claim rather than a
 * measurement. The memo is what keeps a shared ancestor from being hydrated once
 * per chain that passes through it.
 */
export class HydrationCursor {
  hydratedNodes = 0;
  hydratedEdges = 0;

  private readonly nodeViews = new Map<number, ContextGraphNodeView>();
  private readonly edgeViews = new Map<number, ContextGraphEdgeView>();
  private readonly sources = new Map<number, number>();
  /** Targets whose incoming bucket has been read. One scan per node, ever. */
  private readonly scanned = new Set<number>();

  constructor(private readonly reader: ContextIndexReader) {}

  /**
   * Range is checked here rather than caught from the reader: an integer that
   * came out of a candidate table is data, and a `RangeError` raised on data
   * would be indistinguishable from a genuine caller bug two frames up.
   */
  node(index: number): ContextGraphNodeView | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.reader.nodeCount) return null;
    const cached = this.nodeViews.get(index);
    if (cached !== undefined) return cached;
    const view = this.reader.hydrateNode(index);
    this.hydratedNodes += 1;
    this.nodeViews.set(index, view);
    return view;
  }

  edge(index: number): ContextGraphEdgeView | null {
    if (!Number.isInteger(index) || index < 0 || index >= this.reader.edgeCount) return null;
    const cached = this.edgeViews.get(index);
    if (cached !== undefined) return cached;
    const view = this.reader.hydrateEdge(index);
    this.hydratedEdges += 1;
    this.edgeViews.set(index, view);
    return view;
  }

  /**
   * The source of an edge, read back off its target's incoming bucket.
   *
   * The whole bucket is memoized on the first ask. A hub node reached by several
   * selected candidates is the common case, and rescanning its in-edges once per
   * hop is how a walk bounded by `maxSelected * maxDepth` becomes one bounded by
   * the graph's degree distribution instead.
   *
   * The mask is deliberately `ALL`: a chain's direction is a fact about the
   * index, and resolving it through the query's profile mask would make the same
   * receipt explainable under one profile and broken under another.
   */
  sourceOf(edge: number, target: number): number {
    const known = this.sources.get(edge);
    if (known !== undefined) return known;
    if (this.scanned.has(target)) return NO_NODE;
    this.scanned.add(target);
    const cursor = this.reader.incoming(target, CONTEXT_INDEX_PROFILE_MASK_ALL);
    while (cursor.next()) {
      if (!this.sources.has(cursor.edge)) this.sources.set(cursor.edge, cursor.target);
    }
    return this.sources.get(edge) ?? NO_NODE;
  }
}

export interface HydrationHop {
  readonly edge: number;
  readonly source: number;
  readonly target: number;
  /** True when the walk crossed the edge against its direction. */
  readonly reverse: boolean;
  readonly view: ContextGraphEdgeView;
}

export interface HydrationChain {
  /** Every node on the path, root first, terminating at the selected node. */
  readonly nodes: readonly number[];
  readonly hops: readonly HydrationHop[];
}

/**
 * Rebuild the path from the chain root to a selected node, or return `null`.
 *
 * `null` means the receipt describes a path the index does not contain, and the
 * caller must drop the candidate and record an omission. Three things produce
 * it, and each one is a broken chain rather than a corrupt file: an edge index
 * outside the edge table, an edge that is not incident to the node the walk was
 * standing on, and a terminal parent that disagrees with the candidate table's
 * own pointer.
 *
 * That last check is the reason the walk resolves both endpoints instead of
 * trusting `parentNode`: the table's pointer and the index's topology are two
 * independent records of the same hop, and a chain nothing cross-checks is a
 * chain that can be confidently wrong.
 */
export function resolveHydrationChain(
  cursor: HydrationCursor,
  entry: SelectedCandidate,
): HydrationChain | null {
  const hops: HydrationHop[] = [];
  const nodes: number[] = [entry.candidate.node];
  let child = entry.candidate.node;

  for (let at = entry.parentEdges.length - 1; at >= 0; at -= 1) {
    const edge = entry.parentEdges[at] as number;
    const view = cursor.edge(edge);
    if (view === null) return null;
    const source = cursor.sourceOf(edge, view.target);
    if (source === NO_NODE) return null;
    const parent = view.target === child ? source : source === child ? view.target : NO_NODE;
    if (parent === NO_NODE || parent === child) return null;
    hops.push({ edge, source, target: view.target, reverse: view.target !== child, view });
    nodes.push(parent);
    child = parent;
  }

  if (hops.length > 0 && nodes[1] !== entry.candidate.parentNode) return null;
  hops.reverse();
  nodes.reverse();
  return { nodes, hops };
}

export interface HydrationExplanation {
  /** `[nodeId, relation, nodeId, …]`; a reverse hop reads `type:reverse`. */
  readonly reasonPath: readonly string[];
  readonly steps: readonly ContextGraphExplanationStep[];
}

/**
 * Name the chain's hops.
 *
 * A step's `from`/`to` are the edge's own endpoints, never the walk's — a
 * rendered path that swapped them would claim `b imports a` because the query
 * happened to arrive from `b`. The direction the walk took is carried by the
 * `:reverse` suffix on the relation instead, which is the one place it belongs.
 *
 * The chain's interior nodes are materialized here, and that is the single
 * exception to "selected nodes only": an explanation whose hops cannot be named
 * is not an explanation. They are memoized and counted separately from the
 * candidates, so the cost stays visible rather than folded into the floor.
 */
export function explainHydrationChain(
  cursor: HydrationCursor,
  chain: HydrationChain,
): HydrationExplanation | null {
  const ids: string[] = [];
  for (const node of chain.nodes) {
    const view = cursor.node(node);
    if (view === null) return null;
    ids.push(view.id);
  }

  const reasonPath: string[] = [ids[0] as string];
  const steps: ContextGraphExplanationStep[] = [];
  for (let at = 0; at < chain.hops.length; at += 1) {
    const hop = chain.hops[at] as HydrationHop;
    const from = cursor.node(hop.source);
    const to = cursor.node(hop.target);
    if (from === null || to === null) return null;
    steps.push({
      edgeId: contextGraphEdgeId({ type: hop.view.type, from: from.id, to: to.id }),
      type: hop.view.type,
      from: from.id,
      to: to.id,
      confidence: hop.view.confidence,
      path: hop.view.provenance.path,
    });
    reasonPath.push(hop.reverse ? `${hop.view.type}:reverse` : hop.view.type);
    reasonPath.push(ids[at + 1] as string);
  }
  return { reasonPath, steps };
}
