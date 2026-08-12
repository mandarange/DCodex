/**
 * Selected-only hydration (CG2-10, ADR §7, work order §8.4/§8.5).
 *
 * The v1 engine explained every ranked candidate and then threw most of the work
 * away at selection. This module turns *only* the selected set into views, after
 * selection, and that ordering is the whole card: labels, paths, reason paths,
 * explanation steps and provenance are products of selection, never inputs to it.
 *
 * ## `hydrated` does not mean what it meant in v1
 *
 * In v1, `hydrated` asserted a per-node `stat` at query time: some provenance
 * record named a file that existed on disk *right now*. In CRK2 it asserts
 * something else entirely — that the node came from an index the query preflight
 * proved fresh, whose source hashes were verified when it was compiled, and whose
 * writer stamped the node `GROUNDABLE`. No syscall is involved. `grounding`
 * carries which of the two claims a view is making, so a consumer can tell them
 * apart instead of guessing from a boolean whose meaning moved underneath it.
 *
 * The old claim is still available, but only where it belongs: `validate` and
 * explicit strict diagnostics call `verifyHydrationOnDisk` (`hydrate-verify.ts`),
 * which deduplicates by unique provenance path and probes them through a bounded
 * `Promise.all`. That module is deliberately *not* re-exported from here — this
 * file must not carry a filesystem import into the query path, and the cheapest
 * way to guarantee that is for the query path never to link it.
 *
 * ## Floors this file has to hold
 *
 * - `provenanceCoverage = 1.0`, as an equality. It holds by construction: a node
 *   that cannot be grounded is dropped and counted, never shipped ungrounded.
 * - Hydrated candidates ≤ selected candidates. Nothing outside the selection is
 *   admitted; the chain interiors an explanation has to name are hydrated through
 *   the same memo and counted separately (`HydrationCursor`).
 * - §1.4: workspace-relative POSIX paths only. A path that fails the check is
 *   refused and tallied rather than forwarded, because an absolute path in the
 *   index is a compiler bug and forwarding it makes it a leak in every consumer.
 */
import { isWorkspaceRelativePosixPath } from '../paths.js';
import { CONTEXT_INDEX_PROFILE_MASK_ALL } from '../runtime-index/reader.js';
import { CONTEXT_INDEX_NODE_FLAG } from '../runtime-index/writer.js';
import type { ContextIndexReader, ProvenanceView } from '../runtime-index/reader.js';
import type { ContextGraphFreshness, ContextGraphNodeKind, ContextGraphRisk } from '../contracts.js';
import type {
  ContextGraphExplanationStep,
  ContextGraphProvenanceRef,
  ContextGraphSeedConfidence,
} from '../query-types.js';
import { CONTEXT_GRAPH_RANKING_CONFIG, type ContextGraphRankingConfig } from './ranking-config.js';
import {
  CANDIDATE_FLAG,
  addOmission,
  hasFlag,
  type KernelOmissions,
  type LaneContribution,
  type RetrievalLane,
  type SelectedCandidate,
} from './kernel-types.js';
import {
  HydrationCursor,
  explainHydrationChain,
  resolveHydrationChain,
} from './hydrate-chain.js';

export const CONTEXT_HYDRATION_SCHEMA = 'sks.context-hydration.v1' as const;

/**
 * What a view's `hydrated` flag is a claim about. The enum exists because the
 * boolean alone is now ambiguous across versions, and a silently redefined field
 * is worse than a renamed one: every existing reader keeps believing the old
 * meaning and nothing tells it otherwise.
 */
export type HydrationGrounding =
  /** Fresh index + compile-verified source hash + `GROUNDABLE`. No syscall. §7. */
  | 'fresh_index'
  /** A provenance path was found on disk by the validate path. §8.5. */
  | 'filesystem_verified'
  /** Neither claim holds. Never a downgrade of the other two — an absence. */
  | 'unverified';

export interface HydratedNode {
  readonly node: number;
  readonly nodeId: string;
  readonly kind: ContextGraphNodeKind;
  readonly label: string;
  readonly path?: string;
  readonly line?: number;
  readonly score: bigint;
  readonly trust: number;
  readonly freshness: ContextGraphFreshness;
  readonly risk: ContextGraphRisk;
  readonly tokenCost: number;
  readonly depth: number;
  readonly group: number;
  readonly seed: boolean;
  readonly seedConfidence: ContextGraphSeedConfidence;
  readonly lane: RetrievalLane;
  readonly contributions: readonly LaneContribution[];
  readonly reasonPath: readonly string[];
  readonly explanation: readonly ContextGraphExplanationStep[];
  readonly provenance: readonly ContextGraphProvenanceRef[];
  /** §7 semantics, not v1's. Read `grounding` to know which claim this is. */
  readonly hydrated: boolean;
  readonly grounding: HydrationGrounding;
}

/** Codes and integers only (§1.4): a dropped node is named by its index. */
export interface HydrationOmission {
  readonly node: number;
  readonly reason: 'broken_chain' | 'no_provenance';
}

export interface HydrationOptions {
  /**
   * The preflight's verdict on the index these candidates came from.
   *
   * Required, and never re-derived here. Freshness is a property of pointer and
   * meta agreeing on a snapshot fingerprint, established once before the query;
   * a hydration pass that formed its own opinion would be a second freshness
   * check that can disagree with the one the query actually ran under.
   */
  readonly indexFresh: boolean;
  readonly config?: ContextGraphRankingConfig;
}

export interface HydrationResult {
  readonly schema: typeof CONTEXT_HYDRATION_SCHEMA;
  readonly nodes: readonly HydratedNode[];
  /** Equality, not an average: the floor is 1.0 and holds by construction. */
  readonly provenanceCoverage: number;
  readonly explanationPathCount: number;
  readonly omissions: KernelOmissions;
  readonly omitted: readonly HydrationOmission[];
  /** `hydrateNode` calls, including the chain interiors an explanation names. */
  readonly hydratedNodes: number;
  readonly hydratedEdges: number;
  /** Provenance records refused for not being workspace-relative POSIX paths. */
  readonly refusedPaths: number;
}

interface Tally {
  refused: number;
}

/**
 * Turn the kernel's selected set into views. Synchronous and syscall-free: the
 * absence of a filesystem import in this module is what makes "provenance stat 0
 * on a default query" a structural property rather than a promise.
 */
export function hydrateSelectedCandidates(
  reader: ContextIndexReader,
  selected: readonly SelectedCandidate[],
  options: HydrationOptions,
): HydrationResult {
  const limit = Math.max(1, (options.config ?? CONTEXT_GRAPH_RANKING_CONFIG).maxProvenancePerNode);
  const cursor = new HydrationCursor(reader);
  const nodes: HydratedNode[] = [];
  const omitted: HydrationOmission[] = [];
  const omissions: KernelOmissions = {};
  const tally: Tally = { refused: 0 };
  let explanationPathCount = 0;

  for (const entry of selected) {
    const chain = resolveHydrationChain(cursor, entry);
    const explanation = chain === null ? null : explainHydrationChain(cursor, chain);
    const view = explanation === null ? null : cursor.node(entry.candidate.node);
    if (explanation === null || view === null) {
      omitted.push(Object.freeze({ node: entry.candidate.node, reason: 'broken_chain' as const }));
      // The shared omission set has no code for a broken chain, and this module
      // does not own that contract. `no_provenance` is the honest mapping: a node
      // whose path through the graph cannot be verified is a node nothing in the
      // snapshot attests to. The precise reason stays on `omitted`.
      addOmission(omissions, 'no_provenance', 1);
      continue;
    }

    const provenance = provenanceFor(reader, cursor, entry, limit, tally);
    if (provenance.length === 0) {
      omitted.push(Object.freeze({ node: entry.candidate.node, reason: 'no_provenance' as const }));
      addOmission(omissions, 'no_provenance', 1);
      continue;
    }

    const groundable = (view.flags & CONTEXT_INDEX_NODE_FLAG.GROUNDABLE) !== 0;
    const hydrated = options.indexFresh && groundable;
    const path = view.path !== undefined && isWorkspaceRelativePosixPath(view.path) ? view.path : undefined;
    if (view.path !== undefined && path === undefined) tally.refused += 1;
    nodes.push(Object.freeze({
      node: entry.candidate.node,
      nodeId: view.id,
      kind: view.kind,
      label: view.label,
      ...(path === undefined ? {} : { path }),
      ...(view.line === undefined ? {} : { line: view.line }),
      score: entry.candidate.score,
      trust: view.trust,
      freshness: view.freshness,
      risk: view.risk,
      tokenCost: entry.tokenCost,
      depth: entry.candidate.depth,
      group: entry.group,
      seed: hasFlag(entry.candidate.flags, CANDIDATE_FLAG.SEED),
      seedConfidence: entry.confidence,
      lane: entry.lane,
      contributions: entry.contributions,
      reasonPath: Object.freeze(explanation.reasonPath),
      explanation: Object.freeze(explanation.steps),
      provenance: Object.freeze(provenance),
      hydrated,
      grounding: hydrated ? 'fresh_index' : 'unverified',
    }));
    if (explanation.steps.length > 0) explanationPathCount += 1;
  }

  return Object.freeze({
    schema: CONTEXT_HYDRATION_SCHEMA,
    nodes: Object.freeze(nodes),
    provenanceCoverage: contextHydrationCoverage(nodes),
    explanationPathCount,
    omissions: Object.freeze(omissions),
    omitted: Object.freeze(omitted),
    hydratedNodes: cursor.hydratedNodes,
    hydratedEdges: cursor.hydratedEdges,
    refusedPaths: tally.refused,
  });
}

/**
 * Fraction of hydrated nodes carrying at least one provenance record.
 *
 * It is 1.0 by construction — ungrounded candidates never reach the array — and
 * is computed rather than asserted so the invariant is measured on the shipped
 * data instead of trusted from the code that produced it.
 */
export function contextHydrationCoverage(nodes: readonly HydratedNode[]): number {
  if (nodes.length === 0) return 1;
  let grounded = 0;
  for (const node of nodes) if (node.provenance.length > 0) grounded += 1;
  return grounded / nodes.length;
}

/** Restamp one view against a filesystem verdict. Used only by the validate path. */
export function withHydrationGrounding(node: HydratedNode, verified: boolean): HydratedNode {
  return Object.freeze({
    ...node,
    hydrated: verified,
    grounding: (verified ? 'filesystem_verified' : 'unverified') as HydrationGrounding,
  });
}

/**
 * The node's own source record, then the provenance of the edges that reached
 * it — deduplicated and capped at `maxProvenancePerNode`.
 *
 * The reader already deduplicates by provenance *row*; the second dedupe here is
 * by `(path, line, hash)`, because two rows can carry the same triple and a
 * receipt that lists one fact twice spends the cap on nothing.
 */
function provenanceFor(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  entry: SelectedCandidate,
  limit: number,
  tally: Tally,
): ContextGraphProvenanceRef[] {
  const refs: ContextGraphProvenanceRef[] = [];
  const seen = new Set<string>();
  for (const view of reader.provenance(entry.candidate.node, entry.parentEdges)) {
    if (!pushRef(refs, seen, view, limit, tally)) break;
  }
  if (refs.length > 0) return refs;

  // A seed the anchor lane resolved by id has no parent edge, and a node whose
  // extractor recorded no bytes has no source record of its own. Reporting it as
  // unattested when the graph holds an incident edge that names a file would
  // break `provenanceCoverage = 1.0` against a node that is in fact grounded.
  const incident = firstIncidentProvenance(reader, cursor, entry.candidate.node, limit);
  if (incident !== null) pushRef(refs, seen, incident, limit, tally);
  return refs;
}

function pushRef(
  into: ContextGraphProvenanceRef[],
  seen: Set<string>,
  view: ProvenanceView,
  limit: number,
  tally: Tally,
): boolean {
  if (into.length >= limit) return false;
  if (!isWorkspaceRelativePosixPath(view.path)) {
    tally.refused += 1;
    return true;
  }
  const key = `${view.path} ${view.line ?? ''} ${view.hash}`;
  if (seen.has(key)) return true;
  seen.add(key);
  into.push(Object.freeze({
    path: view.path,
    ...(view.line === undefined ? {} : { line: view.line }),
    hash: view.hash,
  }));
  return into.length < limit;
}

/**
 * The first usable provenance on an incident edge, out-edges before in-edges.
 *
 * Bounded by `limit` rows per direction rather than by degree: this is a
 * last-resort grounding probe on a hub node, and an unbounded walk here would
 * make the cost of the fallback depend on the shape of the graph.
 */
function firstIncidentProvenance(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: number,
  limit: number,
): ProvenanceView | null {
  const cursors = [
    reader.outgoing(node, CONTEXT_INDEX_PROFILE_MASK_ALL),
    reader.incoming(node, CONTEXT_INDEX_PROFILE_MASK_ALL),
  ];
  for (const edges of cursors) {
    for (let step = 0; step < limit && edges.next(); step += 1) {
      const view = cursor.edge(edges.edge);
      if (view !== null && isWorkspaceRelativePosixPath(view.provenance.path)) return view.provenance;
    }
  }
  return null;
}

export {
  HydrationCursor,
  explainHydrationChain,
  resolveHydrationChain,
  type HydrationChain,
  type HydrationExplanation,
  type HydrationHop,
} from './hydrate-chain.js';
