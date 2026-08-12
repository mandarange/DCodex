/**
 * Graph-widened affected verification.
 *
 * The exact changed-file selector in `release/gate-manifest.ts` is the floor, and
 * it stays the floor: this module may only ADD gates to what `selectGates`
 * already chose. Returning fewer gates than the exact selector is a defect, not a
 * speed-up, so the union is built structurally and the shortfall is still
 * re-checked and reported through `dropped_baseline_gates` (always empty) and
 * `missingContextGraphBaselineGates`.
 *
 * What the graph adds is reach the glob-based selector cannot see: a gate whose
 * manifest inputs cover a file that merely *imports* a changed file, and the test
 * suites that exercise the changed symbols. Each addition carries the hop chain
 * and the provenance record that produced it.
 *
 * The index is resolved through the CRK2 query facade — `openWorkspaceContextIndex`
 * plus `walkContextGraph` — never by reading a JSON snapshot, so this module fails
 * closed on exactly the states the facade does. A missing, corrupt or stale graph
 * never shrinks the answer: the baseline is returned unchanged, the run is marked
 * conservative, and the repair command is surfaced.
 *
 * ## Why the walk surface and not the retrieval kernel
 *
 * `runContextKernel` fuses lanes and *selects* a bounded top-K by relevance. This
 * question has no notion of relevance: every node the impact relations reach has
 * to be considered, or a suite that would have caught the break is silently not
 * recommended. `query/walk.ts` exists for exactly that shape and is what this
 * uses.
 *
 * ## Three places where shrinking would be invisible, and what stops it
 *
 * - **Seed resolution is uncapped.** `resolveContextSeeds` drops a key matching
 *   more nodes than its cap, which is right for the Naruto advisory's *label*
 *   seeds — a name matching 500 nodes is not honest evidence of scope. A changed
 *   file path is not a guess, so this module reads `reader.basename` directly and
 *   takes every posting. A cap here would drop tests and read as a speed-up.
 * - **The metadata predicates widened rather than narrowed.** `contextNodeFlag`
 *   accepts `true`, `'true'` and `'1'`; the JSON-era predicates were `=== true`
 *   and matched only the first. Extractors author the flag both ways, so this
 *   recognises a superset of the nodes the previous reader did — never a subset.
 * - **The seed expansion is a walk with its own budget.** The JSON-era expansion
 *   was unbounded, so an exhausted budget here would be a new way to lose seeds.
 *   It is charged to `impact_closure_truncated`, which marks the run conservative
 *   rather than letting a shorter answer pass as a complete one.
 * - **The two output caps report themselves and truncate in a stated order.**
 *   `maxTests` and `maxAddedGates` used to stop with a bare `continue`, so a
 *   shortened list arrived indistinguishable from a complete one — measured on the
 *   real graph, 275 reachable suites became 128 with an empty `conservative_reasons`.
 *   They now charge `recommended_tests_truncated` / `added_gates_truncated`, and the
 *   set they keep is chosen by `nearestFirst` rather than by adjacency order.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphEdgeType,
  type ContextGraphStatusCode
} from '../triwiki/context-graph/contracts.js';
import { contextGraphPathFromId } from '../triwiki/context-graph/ids.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../triwiki/context-graph/query-types.js';
import {
  HydrationCursor,
  contextNodeFlag,
  contextWalkProvenance,
  contextWalkRoot,
  isMissingWorkspaceContextIndex,
  openWorkspaceContextIndex,
  walkContextGraph,
  workspaceContextFailureOf,
  type ContextGraphNodeView,
  type ContextIndexReader,
  type ContextWalkHit,
  type WorkspaceContextFailure
} from '../triwiki/context-graph/query/index.js';
import { ALWAYS_ON_GATES, selectGates, type GateManifestEntry, type GateTier } from '../release/gate-manifest.js';

export const CONTEXT_GRAPH_AFFECTED_SCHEMA = 'sks.context-graph-affected-verification.v1' as const;

export const CONTEXT_GRAPH_AFFECTED_CAPS = {
  maxDepth: 2,
  maxNodesPerWalk: 2048,
  maxEdgesPerWalk: 32768,
  /**
   * Suites returned. This one **bites on real diffs** — 275 reachable, 128 kept
   * on the graph of `11265c98` — so it is reported through
   * `recommended_tests_truncated` and the kept set is chosen by `nearestFirst`.
   */
  maxTests: 128,
  /**
   * Gates the graph may add. Wider than the runnable release manifest (33 ids),
   * so nothing has been observed to reach it; it is still reported through
   * `added_gates_truncated`, because "no diff has hit it yet" is a fact about
   * today's manifest and not a property of this module.
   */
  maxAddedGates: 64,
  /** Distinct unrunnable gate names listed before the rest are counted instead. */
  maxGateWarnings: 16,
  /**
   * Provenance rows kept per hit. A hop chain crosses at most
   * `maxDepth + 1` edges — the expansion hop plus the reverse hops — so this
   * bound is slack by construction and exists only so the walk helper is not
   * handed an unbounded limit.
   *
   * That argument covers the edge arm of `contextWalkProvenance`. Its zero-hop
   * fallback reads `reader.provenance` instead, which the construction says
   * nothing about — measured over the real index, every one of 28,660 nodes
   * carries at most **one** source record, so the fallback is slack by a factor
   * of 16 and this cap has no reachable way to shorten an answer.
   */
  maxProvenancePerHit: 16
} as const;

/** Reverse relations that mean "this would have to be re-verified". */
const IMPACT_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set([
  'imports', 'reexports', 'references', 'calls', 'tests', 'affected_by', 'verified_by', 'gated_by', 'depends_on', 'owns', 'routes_to'
]);
/** Same-file expansion applied to a changed file before the reverse walk. */
const SEED_EXPANSION_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(['defines', 'contains']);

export type ContextGraphAffectedGateSource = 'changed_file_selector' | 'always_on' | 'context_graph';

export interface ContextGraphAffectedRequest {
  readonly root: string;
  readonly changedFiles: readonly string[];
  /** The gate universe the runner can actually execute. */
  readonly gates: readonly GateManifestEntry[];
  readonly publish?: boolean;
  /** Gate ids an upstream exact selector already committed to; they always survive. */
  readonly baselineGateIds?: readonly string[];
  /** An index the caller already opened. Supplying it makes the whole call pure and I/O-free. */
  readonly reader?: ContextIndexReader;
  /** Freshness verdict from the caller's preflight; computing it here would spawn git. */
  readonly graphStatus?: ContextGraphStatusCode;
  readonly maxDepth?: number;
}

export interface ContextGraphAffectedGate {
  readonly gate_id: string;
  readonly tier: GateTier | null;
  readonly source: ContextGraphAffectedGateSource;
  readonly protected: boolean;
  /** Hop chain; a reverse graph hop is prefixed with `<-`. */
  readonly reason_path: string[];
  readonly explanation: ContextGraphExplanationStep[];
  readonly provenance: ContextGraphProvenanceRef[];
}

export interface ContextGraphAffectedTest {
  readonly path: string;
  readonly reason_path: string[];
  readonly explanation: ContextGraphExplanationStep[];
  readonly provenance: ContextGraphProvenanceRef[];
}

export interface ContextGraphAffectedResult {
  readonly schema: typeof CONTEXT_GRAPH_AFFECTED_SCHEMA;
  readonly ok: boolean;
  readonly graph_status: ContextGraphStatusCode;
  readonly graph_used: boolean;
  readonly snapshot_hash: string;
  readonly error_code: typeof CONTEXT_GRAPH_MISSING_ERROR | typeof CONTEXT_GRAPH_STALE_ERROR | typeof CONTEXT_GRAPH_CORRUPT_ERROR | null;
  readonly repair_command: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
  readonly conservative: boolean;
  readonly conservative_reasons: string[];
  readonly changed_files: string[];
  readonly unresolved_changed_files: string[];
  /** What the exact changed-file selector chose. The result is always a superset of this. */
  readonly baseline_gates: string[];
  readonly gates: string[];
  readonly added_gates: string[];
  readonly gate_details: ContextGraphAffectedGate[];
  readonly protected_gates: string[];
  readonly skipped_gates: Array<{ gate_id: string; reason: string }>;
  readonly recommended_tests: ContextGraphAffectedTest[];
  /** Baseline gates missing from `gates`. Always empty; a non-empty value is a defect. */
  readonly dropped_baseline_gates: string[];
  readonly warnings: string[];
  readonly errors: string[];
  readonly process_spawns: 0;
}

const ERROR_BY_STATUS = {
  fresh: null,
  missing: CONTEXT_GRAPH_MISSING_ERROR,
  stale: CONTEXT_GRAPH_STALE_ERROR,
  corrupt: CONTEXT_GRAPH_CORRUPT_ERROR
} as const;

/** Baseline ids the caller would lose. The selector is a floor, so this must always be empty. */
export function missingContextGraphBaselineGates(baseline: readonly string[], selected: readonly string[]): string[] {
  const chosen = new Set(selected);
  return [...new Set(baseline.filter((id) => !chosen.has(id)))].sort();
}

function relativePath(value: string): string | null {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return normalized && isWorkspaceRelativePosixPath(normalized) ? normalized : null;
}

function nodePathOf(node: ContextGraphNodeView): string | null {
  return node.path ?? contextGraphPathFromId(node.id);
}

function isTestNode(node: ContextGraphNodeView): boolean {
  return node.kind === 'test' || contextNodeFlag(node, 'isTest');
}

/**
 * The two metadata arms are **unreachable in production, and that is a fact
 * about the compiler rather than a gap here.**
 * `extractors/topology/gates.ts` sets `requiredForPublish`/`alwaysOnRelease` in
 * the same `addNode` call that sets `risk: gateRisk(...)`, and
 * `REQUIRED_FOR_PUBLISH.has(id)` is one of `gateRisk`'s disjuncts — so each flag
 * implies `risk === 'protected'`, the first arm short-circuits, and no gate the
 * real extractor emits can be protected by metadata alone. The
 * `context-graph-v2:quality` gate measures exactly that over the real manifest
 * and would fail if it stopped holding.
 *
 * A fixture *can* construct the state by declaring the flag with a non-protected
 * `risk`, and the suite does, which verifies the predicate rather than the
 * reachability — they are separate claims and only the first is testable here.
 * The arms are kept because the invariant lives in another file and nothing
 * enforces it across the distance, and read through `contextNodeFlag` because a
 * narrower spelling would move the silent-false failure rather than remove it.
 */
function isProtectedGateNode(node: ContextGraphNodeView): boolean {
  return node.risk === 'protected' || contextNodeFlag(node, 'requiredForPublish') || contextNodeFlag(node, 'alwaysOnRelease');
}

interface AffectedCandidate<T> {
  /** Identity of the answer row: a gate id or a workspace-relative suite path. */
  readonly key: string;
  /** Impact hops between the change and this candidate. */
  readonly depth: number;
  /** Canonical node id, so the order is total even when one key has two nodes. */
  readonly nodeId: string;
  readonly value: T;
}

/**
 * Deduplicate, order, and take the first `limit` — nearest first.
 *
 * The walk returns everything it reached in **adjacency order**, which is a fact
 * about how the index stores its CSR buckets and about nothing else. Taking the
 * first N of that made the kept set a property of the file layout: the v1 engine's
 * sorted-edge-id order and the v2 bucket order kept different subsets of the same
 * 275 reachable suites (48 shared of 128, union 176) with the same count and the
 * same completeness. Nothing meaningful decided which 128 a release ran.
 *
 * The key is `(depth, key, nodeId)`:
 *
 * - **depth** first because it is the strength of the evidence. A suite one hop
 *   from the change is named by a `tests` edge on the changed file itself; a suite
 *   two hops away is implicated through an intermediary. When only N of M fit,
 *   dropping the *furthest* loses the weakest claim rather than an arbitrary slice.
 *   It is also the one ordering key the layout cannot move: the walk is breadth
 *   first with first-visit-wins, so a node's depth is its shortest hop count and is
 *   identical whichever bucket order reached it.
 * - **key** — the gate id or the workspace path — because it is what the caller
 *   consumes, and it is stable across machines, engines and index revisions.
 * - **nodeId** last so the order is *total*. One path can carry two nodes (a
 *   `kind: 'test'` node and an `isTest`-flagged file node), and without this the
 *   surviving row's hop chain and provenance would still be decided by arrival
 *   order even though the surviving path was not.
 *
 * `distinct` is the count *before* the limit, so the caller can report truncation
 * exactly rather than inferring it from `kept.length === limit` — which is also
 * true of an answer that happens to be complete at exactly the cap.
 */
function nearestFirst<T>(candidates: Array<AffectedCandidate<T>>, limit: number): { kept: T[]; distinct: number } {
  const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => a.depth - b.depth || compare(a.key, b.key) || compare(a.nodeId, b.nodeId));
  const kept: T[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    if (kept.length < limit) kept.push(candidate.value);
  }
  return { kept, distinct: seen.size };
}

/**
 * Every node at a changed path, with no per-key cap.
 *
 * Deliberately not `resolveContextSeeds`: its `maxPerKey` drops an over-matching
 * key, which is right for a guessed label and wrong for a changed file. Dropping
 * a seed here removes the suites that hang off it and the run merely gets faster.
 */
function affectedRoots(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  changedFiles: readonly string[]
): { roots: ContextWalkHit[]; unresolved: string[] } {
  const roots: ContextWalkHit[] = [];
  const seen = new Set<number>();
  const unresolved: string[] = [];
  for (const file of changedFiles) {
    const postings = reader.basename(file);
    if (postings.length === 0) {
      unresolved.push(file);
      continue;
    }
    for (let at = 0; at < postings.length; at += 1) {
      const node = postings.node(at);
      if (seen.has(node)) continue;
      seen.add(node);
      const view = cursor.node(node);
      if (view !== null) roots.push(contextWalkRoot(node, view.id));
    }
  }
  return { roots, unresolved };
}

/**
 * Seeds plus the symbols they declare, all at depth 0.
 *
 * The expansion hop stays in the reason path but is not charged against the
 * reverse walk's depth: a file and a symbol it defines are one location, and
 * spending a hop crossing between them would halve the reach of the impact
 * closure for every symbol-level suite.
 */
function expandAffectedRoots(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  roots: readonly ContextWalkHit[]
): { roots: ContextWalkHit[]; truncated: boolean } {
  const expanded = walkContextGraph(reader, cursor, {
    roots,
    direction: 'out',
    edgeTypes: SEED_EXPANSION_EDGE_TYPES,
    caps: {
      maxDepth: 1,
      maxNodes: CONTEXT_GRAPH_AFFECTED_CAPS.maxNodesPerWalk,
      maxEdges: CONTEXT_GRAPH_AFFECTED_CAPS.maxEdgesPerWalk
    }
  });
  const out: ContextWalkHit[] = [];
  for (const hit of expanded.hits.values()) out.push(hit.depth === 0 ? hit : { ...hit, depth: 0 });
  return { roots: out, truncated: expanded.truncated };
}

/**
 * Reverse breadth-first walk from the changed files. Bounded by node, edge and
 * depth caps so a hot path stays `O(seeds * fanout)` rather than `O(nodes)`.
 */
function walkImpactClosure(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  changedFiles: readonly string[],
  maxDepth: number
): { hits: ContextWalkHit[]; truncated: boolean; unresolved: string[] } {
  const seeds = affectedRoots(reader, cursor, changedFiles);
  const expanded = expandAffectedRoots(reader, cursor, seeds.roots);
  const impact = walkContextGraph(reader, cursor, {
    roots: expanded.roots,
    direction: 'in',
    edgeTypes: IMPACT_EDGE_TYPES,
    caps: {
      maxDepth,
      maxNodes: CONTEXT_GRAPH_AFFECTED_CAPS.maxNodesPerWalk,
      maxEdges: CONTEXT_GRAPH_AFFECTED_CAPS.maxEdgesPerWalk
    }
  });
  return {
    hits: [...impact.hits.values()],
    truncated: expanded.truncated || impact.truncated,
    unresolved: seeds.unresolved
  };
}

function selectorGate(entry: GateManifestEntry | undefined, gateId: string, source: ContextGraphAffectedGateSource): ContextGraphAffectedGate {
  return {
    gate_id: gateId,
    tier: entry?.tier ?? null,
    source,
    protected: entry ? entry.required_for_publish || entry.always_on_release : ALWAYS_ON_GATES.has(gateId),
    reason_path: [source, gateId],
    explanation: [],
    provenance: []
  };
}

function assemble(
  request: ContextGraphAffectedRequest,
  status: ContextGraphStatusCode,
  snapshotHash: string,
  changedFiles: string[],
  graph: {
    details: ContextGraphAffectedGate[];
    tests: ContextGraphAffectedTest[];
    unresolved: string[];
    /** The impact walk exhausted its node or edge budget. */
    truncated: boolean;
    /** More suites were reachable than `maxTests` returns. */
    testsTruncated: boolean;
    /** More runnable gates were reachable than `maxAddedGates` returns. */
    gatesTruncated: boolean;
    warnings: string[];
  }
): ContextGraphAffectedResult {
  const errorCode = ERROR_BY_STATUS[status];
  const universe = new Map(request.gates.map((entry) => [entry.id, entry] as const));
  const selection = selectGates([...request.gates], changedFiles, request.publish === true ? { publish: true } : {});

  const baseline: string[] = [];
  const details: ContextGraphAffectedGate[] = [];
  const record = (gateId: string, source: ContextGraphAffectedGateSource, gate?: ContextGraphAffectedGate): void => {
    if (details.some((row) => row.gate_id === gateId)) return;
    details.push(gate ?? selectorGate(universe.get(gateId), gateId, source));
  };
  for (const entry of selection.selected) {
    baseline.push(entry.id);
    record(entry.id, 'changed_file_selector');
  }
  for (const gateId of request.baselineGateIds ?? []) {
    if (baseline.includes(gateId)) continue;
    baseline.push(gateId);
    record(gateId, 'changed_file_selector');
  }
  // Safety net: an always-on gate is never allowed to fall out of an affected run.
  for (const entry of request.gates) {
    if (!ALWAYS_ON_GATES.has(entry.id) || baseline.includes(entry.id)) continue;
    baseline.push(entry.id);
    record(entry.id, 'always_on');
  }

  const graphAdded: string[] = [];
  for (const gate of graph.details) {
    if (baseline.includes(gate.gate_id) || graphAdded.includes(gate.gate_id)) continue;
    if (!universe.has(gate.gate_id)) continue;
    graphAdded.push(gate.gate_id);
    record(gate.gate_id, 'context_graph', gate);
  }

  const gates = [...new Set([...baseline, ...graphAdded])].sort();
  const baselineSorted = [...new Set(baseline)].sort();
  const dropped = missingContextGraphBaselineGates(baselineSorted, gates);
  const conservativeReasons: string[] = [];
  if (errorCode) conservativeReasons.push(errorCode);
  if (request.graphStatus === undefined && !errorCode) conservativeReasons.push('graph_freshness_not_verified');
  if (graph.unresolved.length) conservativeReasons.push('changed_file_not_in_graph');
  if (graph.truncated) conservativeReasons.push('impact_closure_truncated');
  // Kept distinct from `impact_closure_truncated` on purpose. That one means the
  // walk ran out of budget and the *closure* is short, which a bigger walk budget
  // or a repaired graph would fix; these two mean the closure is complete and the
  // *answer* was cut to fit `maxTests` / `maxAddedGates`. Collapsing them into one
  // reason would send a caller to rebuild an index that is fine.
  if (graph.testsTruncated) conservativeReasons.push('recommended_tests_truncated');
  if (graph.gatesTruncated) conservativeReasons.push('added_gates_truncated');

  const chosen = new Set(gates);
  return {
    schema: CONTEXT_GRAPH_AFFECTED_SCHEMA,
    ok: errorCode === null && dropped.length === 0,
    graph_status: status,
    graph_used: errorCode === null,
    snapshot_hash: snapshotHash,
    error_code: errorCode,
    repair_command: CONTEXT_GRAPH_REPAIR_COMMAND,
    conservative: conservativeReasons.length > 0,
    conservative_reasons: conservativeReasons,
    changed_files: changedFiles,
    unresolved_changed_files: [...new Set(graph.unresolved)].sort(),
    baseline_gates: baselineSorted,
    gates,
    added_gates: [...new Set(graphAdded)].sort(),
    gate_details: details.sort((a, b) => (a.gate_id < b.gate_id ? -1 : a.gate_id > b.gate_id ? 1 : 0)),
    protected_gates: details.filter((row) => row.protected).map((row) => row.gate_id).sort(),
    skipped_gates: selection.skipped
      .filter((row) => !chosen.has(row.id))
      .map((row) => ({ gate_id: row.id, reason: row.reason }))
      .sort((a, b) => (a.gate_id < b.gate_id ? -1 : a.gate_id > b.gate_id ? 1 : 0)),
    recommended_tests: graph.tests,
    dropped_baseline_gates: dropped,
    process_spawns: 0,
    warnings: graph.warnings,
    errors: errorCode
      ? [errorCode, `the stored context graph is ${status}; the exact changed-file selection was kept unchanged`, `Run \`${CONTEXT_GRAPH_REPAIR_COMMAND}\` to rebuild the context graph.`]
      : dropped.map((id) => `baseline gate ${id} was dropped from the affected selection`)
  };
}

/** Answer against an index the caller already opened. Pure: no file system access, no process spawn. */
export function contextGraphAffectedVerificationFromIndex(reader: ContextIndexReader, request: ContextGraphAffectedRequest): ContextGraphAffectedResult {
  const changedFiles = [...new Set(request.changedFiles.map(relativePath).filter((value): value is string => value !== null))].sort();
  const status = request.graphStatus ?? 'fresh';
  if (status !== 'fresh') {
    return assemble(request, status, reader.snapshotHash, changedFiles, {
      details: [], tests: [], unresolved: [], truncated: false, testsTruncated: false, gatesTruncated: false, warnings: []
    });
  }

  const cursor = new HydrationCursor(reader);
  const maxDepth = Math.max(0, request.maxDepth ?? CONTEXT_GRAPH_AFFECTED_CAPS.maxDepth);
  const walk = walkImpactClosure(reader, cursor, changedFiles, maxDepth);
  const gateCandidates: Array<AffectedCandidate<ContextGraphAffectedGate>> = [];
  const testCandidates: Array<AffectedCandidate<ContextGraphAffectedTest>> = [];
  const unnamedGates = new Set<string>();
  const universe = new Set(request.gates.map((entry) => entry.id));

  // Every reachable hit is turned into a candidate first, and the caps are applied
  // to the ordered set afterwards. Capping inside the walk is what made the answer
  // depend on adjacency order, and it also destroyed the count needed to say the
  // answer was short.
  for (const hit of walk.hits) {
    const node = cursor.node(hit.node);
    if (!node) continue;
    if (node.kind === 'gate') {
      if (!universe.has(node.label)) {
        unnamedGates.add(node.label);
        continue;
      }
      const entry = request.gates.find((row) => row.id === node.label);
      gateCandidates.push({
        key: node.label,
        depth: hit.depth,
        nodeId: hit.nodeId,
        value: {
          gate_id: node.label,
          tier: entry?.tier ?? null,
          source: 'context_graph',
          protected: isProtectedGateNode(node) || (entry ? entry.required_for_publish || entry.always_on_release : false),
          reason_path: [...hit.reasonPath],
          explanation: [...hit.explanation],
          provenance: contextWalkProvenance(reader, cursor, hit, CONTEXT_GRAPH_AFFECTED_CAPS.maxProvenancePerHit)
        }
      });
      continue;
    }
    if (!isTestNode(node)) continue;
    const testPath = nodePathOf(node);
    if (!testPath || changedFiles.includes(testPath)) continue;
    testCandidates.push({
      key: testPath,
      depth: hit.depth,
      nodeId: hit.nodeId,
      value: {
        path: testPath,
        reason_path: [...hit.reasonPath],
        explanation: [...hit.explanation],
        provenance: contextWalkProvenance(reader, cursor, hit, CONTEXT_GRAPH_AFFECTED_CAPS.maxProvenancePerHit)
      }
    });
  }

  const gateSelection = nearestFirst(gateCandidates, CONTEXT_GRAPH_AFFECTED_CAPS.maxAddedGates);
  const testSelection = nearestFirst(testCandidates, CONTEXT_GRAPH_AFFECTED_CAPS.maxTests);
  const details = gateSelection.kept.sort((a, b) => (a.gate_id < b.gate_id ? -1 : a.gate_id > b.gate_id ? 1 : 0));
  const tests = testSelection.kept.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return assemble(request, 'fresh', reader.snapshotHash, changedFiles, {
    details,
    tests,
    unresolved: walk.unresolved,
    truncated: walk.truncated,
    testsTruncated: testSelection.distinct > CONTEXT_GRAPH_AFFECTED_CAPS.maxTests,
    gatesTruncated: gateSelection.distinct > CONTEXT_GRAPH_AFFECTED_CAPS.maxAddedGates,
    warnings: unnamedGateWarnings(unnamedGates)
  });
}

/**
 * Gate names the graph carries that the runnable manifest does not.
 *
 * The list is capped, because 145 of the real graph's 178 gate nodes are outside
 * the 33-gate release universe and a diff that reaches many of them would bury the
 * report. A cap on a diagnostic is still a cap, so the overflow states its own size
 * in the last row rather than vanishing — the same rule the selection caps follow,
 * charged to `warnings` because a suppressed *warning* does not make the *selection*
 * incomplete and must not read as though it did.
 */
function unnamedGateWarnings(labels: ReadonlySet<string>): string[] {
  const named = [...labels].sort();
  const shown = named.slice(0, CONTEXT_GRAPH_AFFECTED_CAPS.maxGateWarnings);
  const warnings = shown.map((label) => `context graph names gate ${label}, which is not in the runnable gate manifest`);
  const suppressed = named.length - shown.length;
  if (suppressed > 0) warnings.push(`${suppressed} further gate names in the context graph are not in the runnable gate manifest and were not listed`);
  return warnings;
}

/**
 * Project a facade refusal onto this module's three-valued status.
 *
 * The store's vocabulary is wider than `ContextGraphStatusCode`, so the mapping
 * is stated rather than derived: "no index has been built" is `missing`, an index
 * describing another tree is `stale`, and every other index failure — corrupt
 * section, unsupported revision, divergent pointer — is `corrupt`. All three
 * return the exact selector's gates unchanged, so a misfiled code costs a
 * message, never a gate.
 */
function statusOfIndexFailure(error: unknown, failure: WorkspaceContextFailure): ContextGraphStatusCode {
  if (isMissingWorkspaceContextIndex(error)) return 'missing';
  return failure.code === 'context_index_stale' ? 'stale' : 'corrupt';
}

/**
 * Resolve the workspace index through the query facade and answer. An index that
 * is absent, stale or unreadable still returns the exact selector's gates — never
 * fewer — carrying this module's own public code for the state the facade refused
 * with.
 */
export async function contextGraphAffectedVerification(request: ContextGraphAffectedRequest): Promise<ContextGraphAffectedResult> {
  if (request.reader) return contextGraphAffectedVerificationFromIndex(request.reader, request);
  const changedFiles = [...new Set(request.changedFiles.map(relativePath).filter((value): value is string => value !== null))].sort();
  const empty = { details: [], tests: [], unresolved: [], truncated: false, testsTruncated: false, gatesTruncated: false, warnings: [] };
  // A caller that already knows the graph is unusable is answered without
  // opening it: the verdict is the caller's preflight, and re-deriving one here
  // would spawn git on a release path.
  if (request.graphStatus !== undefined && request.graphStatus !== 'fresh') {
    return assemble(request, request.graphStatus, '', changedFiles, empty);
  }
  try {
    const handle = await openWorkspaceContextIndex(request.root);
    return contextGraphAffectedVerificationFromIndex(handle.reader, request);
  } catch (error: unknown) {
    const failure = workspaceContextFailureOf(error);
    // Not an index failure: an unrelated bug reported as a corrupt graph would
    // send a user to rebuild an index that is fine.
    if (failure === null) throw error;
    return assemble(request, statusOfIndexFailure(error, failure), '', changedFiles, empty);
  }
}
