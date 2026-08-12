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
  maxTests: 128,
  maxAddedGates: 64,
  /**
   * Provenance rows kept per hit. A hop chain crosses at most
   * `maxDepth + 1` edges — the expansion hop plus the reverse hops — so this
   * bound is slack by construction and exists only so the walk helper is not
   * handed an unbounded limit.
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
  graph: { details: ContextGraphAffectedGate[]; tests: ContextGraphAffectedTest[]; unresolved: string[]; truncated: boolean; warnings: string[] }
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
    return assemble(request, status, reader.snapshotHash, changedFiles, { details: [], tests: [], unresolved: [], truncated: false, warnings: [] });
  }

  const cursor = new HydrationCursor(reader);
  const maxDepth = Math.max(0, request.maxDepth ?? CONTEXT_GRAPH_AFFECTED_CAPS.maxDepth);
  const walk = walkImpactClosure(reader, cursor, changedFiles, maxDepth);
  const details: ContextGraphAffectedGate[] = [];
  const tests: ContextGraphAffectedTest[] = [];
  const warnings: string[] = [];
  const universe = new Set(request.gates.map((entry) => entry.id));

  for (const hit of walk.hits) {
    const node = cursor.node(hit.node);
    if (!node) continue;
    if (node.kind === 'gate') {
      if (details.length >= CONTEXT_GRAPH_AFFECTED_CAPS.maxAddedGates) continue;
      if (!universe.has(node.label)) {
        if (warnings.length < 16) warnings.push(`context graph names gate ${node.label}, which is not in the runnable gate manifest`);
        continue;
      }
      const entry = request.gates.find((row) => row.id === node.label);
      details.push({
        gate_id: node.label,
        tier: entry?.tier ?? null,
        source: 'context_graph',
        protected: isProtectedGateNode(node) || (entry ? entry.required_for_publish || entry.always_on_release : false),
        reason_path: [...hit.reasonPath],
        explanation: [...hit.explanation],
        provenance: contextWalkProvenance(reader, cursor, hit, CONTEXT_GRAPH_AFFECTED_CAPS.maxProvenancePerHit)
      });
      continue;
    }
    if (!isTestNode(node) || tests.length >= CONTEXT_GRAPH_AFFECTED_CAPS.maxTests) continue;
    const testPath = nodePathOf(node);
    if (!testPath || changedFiles.includes(testPath) || tests.some((row) => row.path === testPath)) continue;
    tests.push({
      path: testPath,
      reason_path: [...hit.reasonPath],
      explanation: [...hit.explanation],
      provenance: contextWalkProvenance(reader, cursor, hit, CONTEXT_GRAPH_AFFECTED_CAPS.maxProvenancePerHit)
    });
  }

  details.sort((a, b) => (a.gate_id < b.gate_id ? -1 : a.gate_id > b.gate_id ? 1 : 0));
  tests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return assemble(request, 'fresh', reader.snapshotHash, changedFiles, {
    details,
    tests,
    unresolved: walk.unresolved,
    truncated: walk.truncated,
    warnings
  });
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
  const empty = { details: [], tests: [], unresolved: [], truncated: false, warnings: [] };
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
