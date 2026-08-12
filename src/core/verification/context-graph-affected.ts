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
 * The index is resolved through the query facade, never by reading the snapshot
 * store directly, so this module fails closed on exactly the states the facade
 * does. A missing, corrupt or stale graph never shrinks the answer: the baseline
 * is returned unchanged, the run is marked conservative, and the repair command
 * is surfaced.
 */
import {
  CONTEXT_GRAPH_CORRUPT_ERROR,
  CONTEXT_GRAPH_MISSING_ERROR,
  CONTEXT_GRAPH_REPAIR_COMMAND,
  CONTEXT_GRAPH_STALE_ERROR,
  type ContextGraphEdge,
  type ContextGraphNode,
  type ContextGraphStatusCode
} from '../triwiki/context-graph/contracts.js';
import { incomingEdges, outgoingEdges, type ContextGraphIndex } from '../triwiki/context-graph/graph-index.js';
import { contextGraphPathFromId } from '../triwiki/context-graph/ids.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../triwiki/context-graph/query-types.js';
import { loadContextGraphIndex, type ContextGraphLoadErrorCode } from '../triwiki/context-graph/query/index.js';
import { ALWAYS_ON_GATES, selectGates, type GateManifestEntry, type GateTier } from '../release/gate-manifest.js';

export const CONTEXT_GRAPH_AFFECTED_SCHEMA = 'sks.context-graph-affected-verification.v1' as const;

export const CONTEXT_GRAPH_AFFECTED_CAPS = {
  maxDepth: 2,
  maxNodesPerWalk: 2048,
  maxEdgesPerWalk: 32768,
  maxTests: 128,
  maxAddedGates: 64
} as const;

/** Reverse relations that mean "this would have to be re-verified". */
const IMPACT_EDGE_TYPES: ReadonlySet<string> = new Set([
  'imports', 'reexports', 'references', 'calls', 'tests', 'affected_by', 'verified_by', 'gated_by', 'depends_on', 'owns', 'routes_to'
]);
/** Same-file expansion applied to a changed file before the reverse walk. */
const SEED_EXPANSION_EDGE_TYPES: ReadonlySet<string> = new Set(['defines', 'contains']);

export type ContextGraphAffectedGateSource = 'changed_file_selector' | 'always_on' | 'context_graph';

export interface ContextGraphAffectedRequest {
  readonly root: string;
  readonly changedFiles: readonly string[];
  /** The gate universe the runner can actually execute. */
  readonly gates: readonly GateManifestEntry[];
  readonly publish?: boolean;
  /** Gate ids an upstream exact selector already committed to; they always survive. */
  readonly baselineGateIds?: readonly string[];
  /** Pre-built index. Supplying it makes the whole call pure and I/O-free. */
  readonly index?: ContextGraphIndex;
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

interface ImpactHit {
  readonly nodeId: string;
  readonly depth: number;
  readonly reasonPath: string[];
  readonly explanation: ContextGraphExplanationStep[];
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

function nodePathOf(node: ContextGraphNode): string | null {
  return node.path ?? contextGraphPathFromId(node.id);
}

function isTestNode(node: ContextGraphNode): boolean {
  return node.kind === 'test' || node.metadata.isTest === true;
}

function isProtectedGateNode(node: ContextGraphNode): boolean {
  return node.risk === 'protected' || node.metadata.requiredForPublish === true || node.metadata.alwaysOnRelease === true;
}

function impactStep(edge: ContextGraphEdge): ContextGraphExplanationStep {
  return { edgeId: edge.id, type: edge.type, from: edge.from, to: edge.to, confidence: edge.confidence, path: edge.provenance.path };
}

function impactProvenance(index: ContextGraphIndex, hit: ImpactHit): ContextGraphProvenanceRef[] {
  const out: ContextGraphProvenanceRef[] = [];
  const seen = new Set<string>();
  for (const step of hit.explanation) {
    const edge = index.edgesById.get(step.edgeId);
    if (!edge) continue;
    const key = `${edge.provenance.path}#${edge.provenance.line ?? 0}#${edge.provenance.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = edge.provenance.line;
    out.push({ path: edge.provenance.path, ...(line === undefined ? {} : { line }), hash: edge.provenance.hash });
  }
  return out;
}

/**
 * Reverse breadth-first walk from the changed files. Bounded by node, edge and
 * depth caps so a hot path stays `O(seeds * fanout)` rather than `O(nodes)`.
 */
function walkImpactClosure(index: ContextGraphIndex, changedFiles: readonly string[], maxDepth: number): { hits: ImpactHit[]; truncated: boolean; unresolved: string[] } {
  const seen = new Map<string, ImpactHit>();
  const queue: ImpactHit[] = [];
  const unresolved: string[] = [];
  const enqueue = (hit: ImpactHit): void => {
    if (seen.has(hit.nodeId) || !index.nodesById.has(hit.nodeId)) return;
    seen.set(hit.nodeId, hit);
    queue.push(hit);
  };
  for (const file of changedFiles) {
    const ids = index.nodesByPath.get(file) ?? [];
    if (!ids.length) {
      unresolved.push(file);
      continue;
    }
    for (const id of ids) enqueue({ nodeId: id, depth: 0, reasonPath: [id], explanation: [] });
    // Symbols declared by the changed file are what a suite actually exercises.
    for (const id of ids) {
      for (const edge of outgoingEdges(index, id)) {
        if (!SEED_EXPANSION_EDGE_TYPES.has(edge.type)) continue;
        enqueue({ nodeId: edge.to, depth: 0, reasonPath: [id, edge.type, edge.to], explanation: [impactStep(edge)] });
      }
    }
  }
  let edgesVisited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current || current.depth >= maxDepth) continue;
    for (const edge of incomingEdges(index, current.nodeId)) {
      edgesVisited += 1;
      if (edgesVisited > CONTEXT_GRAPH_AFFECTED_CAPS.maxEdgesPerWalk) return { hits: [...seen.values()], truncated: true, unresolved };
      if (!IMPACT_EDGE_TYPES.has(edge.type) || seen.has(edge.from)) continue;
      if (seen.size >= CONTEXT_GRAPH_AFFECTED_CAPS.maxNodesPerWalk) return { hits: [...seen.values()], truncated: true, unresolved };
      enqueue({
        nodeId: edge.from,
        depth: current.depth + 1,
        reasonPath: [...current.reasonPath, `<-${edge.type}`, edge.from],
        explanation: [...current.explanation, impactStep(edge)]
      });
    }
  }
  return { hits: [...seen.values()], truncated: false, unresolved };
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

/** Answer against an index the caller already holds. Pure: no file system access, no process spawn. */
export function contextGraphAffectedVerificationFromIndex(index: ContextGraphIndex, request: ContextGraphAffectedRequest): ContextGraphAffectedResult {
  const changedFiles = [...new Set(request.changedFiles.map(relativePath).filter((value): value is string => value !== null))].sort();
  const status = request.graphStatus ?? 'fresh';
  if (status !== 'fresh') {
    return assemble(request, status, index.snapshot.snapshotHash, changedFiles, { details: [], tests: [], unresolved: [], truncated: false, warnings: [] });
  }

  const maxDepth = Math.max(0, request.maxDepth ?? CONTEXT_GRAPH_AFFECTED_CAPS.maxDepth);
  const walk = walkImpactClosure(index, changedFiles, maxDepth);
  const details: ContextGraphAffectedGate[] = [];
  const tests: ContextGraphAffectedTest[] = [];
  const warnings: string[] = [];
  const universe = new Set(request.gates.map((entry) => entry.id));

  for (const hit of walk.hits) {
    const node = index.nodesById.get(hit.nodeId);
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
        provenance: impactProvenance(index, hit)
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
      provenance: impactProvenance(index, hit)
    });
  }

  details.sort((a, b) => (a.gate_id < b.gate_id ? -1 : a.gate_id > b.gate_id ? 1 : 0));
  tests.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return assemble(request, 'fresh', index.snapshot.snapshotHash, changedFiles, {
    details,
    tests,
    unresolved: walk.unresolved,
    truncated: walk.truncated,
    warnings
  });
}

/** Inverted from `ERROR_BY_STATUS` rather than restated, so the round trip cannot drift. */
function statusOfLoadError(code: ContextGraphLoadErrorCode | null): ContextGraphStatusCode {
  return (Object.keys(ERROR_BY_STATUS) as ContextGraphStatusCode[]).find((status) => ERROR_BY_STATUS[status] === code) ?? 'corrupt';
}

/**
 * Resolve the workspace index through the query facade and answer. An index that
 * is absent, stale or unreadable still returns the exact selector's gates — never
 * fewer — carrying the same public code the facade refused with.
 */
export async function contextGraphAffectedVerification(request: ContextGraphAffectedRequest): Promise<ContextGraphAffectedResult> {
  if (request.index) return contextGraphAffectedVerificationFromIndex(request.index, request);
  const changedFiles = [...new Set(request.changedFiles.map(relativePath).filter((value): value is string => value !== null))].sort();
  const verdict = request.graphStatus === undefined ? {} : { status: { status: request.graphStatus } };
  const load = await loadContextGraphIndex(request.root, verdict);
  if (load.ok && load.index) return contextGraphAffectedVerificationFromIndex(load.index, request);
  // `load.warnings` is dropped on purpose: its only reachable value here is
  // "freshness was not verified", which `assemble` already reports as a reason.
  return assemble(request, statusOfLoadError(load.errorCode), load.snapshotHash, changedFiles, { details: [], tests: [], unresolved: [], truncated: false, warnings: [] });
}
