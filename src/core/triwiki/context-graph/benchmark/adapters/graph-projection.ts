/**
 * Projects one Context Graph query answer onto the benchmark's answer shape.
 *
 * Everything here is read out of the compiled snapshot: node kinds, edge types
 * and seed confidences. Nothing is inferred from prose, from a filename
 * convention, or from the question text — if the graph does not carry a
 * relation, the corresponding field comes back empty and the benchmark scores
 * that absence honestly.
 *
 * Cost is bounded by the selection, not by the graph: the walk is
 * `selected nodes x incident edges` with a hard edge-scan ceiling, so this stays
 * flat as the snapshot grows.
 */
import type { ContextGraphNode } from '../../contracts.js';
import { type ContextGraphIndex } from '../../graph-index.js';
import { contextGraphPathFromId } from '../../ids.js';
import { isWorkspaceRelativePosixPath } from '../../paths.js';
import type { ContextGraphQueryResult, ContextGraphSelectedNode } from '../../query-types.js';
import { isExactContextGraphSeedConfidence, isInvalidatedContextGraphNode } from '../../query/index.js';
import { isSupportedCodePath } from '../../extractors/code/inventory.js';
import type { ContextGraphBenchmarkConflict } from '../types.js';

/** Ceiling on incident edges inspected while projecting one answer. */
export const PROJECTION_EDGE_SCAN_CAP = 8000;

/**
 * Write-scope conflicts are read as `owns` fan-in: a path-bearing node that two
 * or more distinct owners claim is a file two parallel slices both intend to
 * write. `owns` and the node label are frozen contract vocabulary, so this needs
 * no side-channel metadata convention — and it stays empty, rather than
 * guessing, until an extractor emits those edges.
 */
export const WRITE_SCOPE_EDGE_TYPE = 'owns';

export interface ContextGraphAnswerProjection {
  readonly matchedPaths: string[];
  readonly matchedNodeIds: string[];
  readonly selectedGateIds: string[];
  readonly selectedTestPaths: string[];
  readonly writeScopeConflicts: ContextGraphBenchmarkConflict[];
  readonly staleIncluded: string[];
  readonly invalidatedIncluded: string[];
  readonly exactSeedsPreserved: string[];
  readonly unsupportedLanguageExactClaims: string[];
  /** Incident edges inspected; compared against `PROJECTION_EDGE_SCAN_CAP` by the caller. */
  readonly scannedEdges: number;
  readonly edgeScanTruncated: boolean;
}

function pathOfNodeId(nodeId: string, declared: string | undefined): string | null {
  const candidate = declared ?? contextGraphPathFromId(nodeId);
  if (!candidate || !isWorkspaceRelativePosixPath(candidate)) return null;
  return candidate;
}

function pathOfNode(node: ContextGraphNode): string | null {
  return pathOfNodeId(node.id, node.path);
}

function pathOfSelected(selected: ContextGraphSelectedNode): string | null {
  return pathOfNodeId(selected.nodeId, selected.path);
}

function pushUnique(into: string[], value: string | null | undefined): void {
  if (!value) return;
  if (!into.includes(value)) into.push(value);
}

class EdgeWalk {
  scanned = 0;

  truncated = false;

  constructor(private readonly index: ContextGraphIndex, private readonly cap: number) {}

  /** Neighbour node ids of `nodeId` in both directions, honouring the scan ceiling. */
  neighbours(nodeId: string): { id: string; type: string; incoming: boolean }[] {
    const out: { id: string; type: string; incoming: boolean }[] = [];
    for (const edgeId of this.index.outgoing.get(nodeId) ?? []) {
      if (this.charge()) return out;
      const edge = this.index.edgesById.get(edgeId);
      if (edge) out.push({ id: edge.to, type: edge.type, incoming: false });
    }
    for (const edgeId of this.index.incoming.get(nodeId) ?? []) {
      if (this.charge()) return out;
      const edge = this.index.edgesById.get(edgeId);
      if (edge) out.push({ id: edge.from, type: edge.type, incoming: true });
    }
    return out;
  }

  private charge(): boolean {
    if (this.scanned >= this.cap) {
      this.truncated = true;
      return true;
    }
    this.scanned += 1;
    return false;
  }
}

function collectConflicts(
  index: ContextGraphIndex,
  node: ContextGraphNode,
  walk: EdgeWalk,
  into: Map<string, Set<string>>
): void {
  const target = pathOfNode(node);
  if (!target) return;
  const owners = new Set<string>();
  for (const neighbour of walk.neighbours(node.id)) {
    if (neighbour.type !== WRITE_SCOPE_EDGE_TYPE || !neighbour.incoming) continue;
    const owner = index.nodesById.get(neighbour.id);
    if (!owner || owner.kind === 'file') continue;
    owners.add(owner.label || owner.id);
  }
  if (owners.size < 2) return;
  const existing = into.get(target);
  if (existing) for (const owner of owners) existing.add(owner);
  else into.set(target, owners);
}

/**
 * Gates and tests are taken from the selection itself plus one hop, because a
 * changed file is `affected_by` its gate and `tests`-linked to its test rather
 * than being ranked alongside them. One hop is a relation the snapshot already
 * asserts with provenance; it is not a widened search.
 */
function collectGatesAndTests(
  index: ContextGraphIndex,
  node: ContextGraphNode,
  walk: EdgeWalk,
  gates: string[],
  tests: string[]
): void {
  if (node.kind === 'gate') pushUnique(gates, node.label || node.id);
  if (node.kind === 'test') pushUnique(tests, pathOfNode(node));
  for (const neighbour of walk.neighbours(node.id)) {
    const other = index.nodesById.get(neighbour.id);
    if (!other) continue;
    if (other.kind === 'gate') pushUnique(gates, other.label || other.id);
    else if (other.kind === 'test') pushUnique(tests, pathOfNode(other));
  }
}

export function projectContextGraphAnswer(
  index: ContextGraphIndex,
  result: ContextGraphQueryResult,
  edgeScanCap: number = PROJECTION_EDGE_SCAN_CAP
): ContextGraphAnswerProjection {
  const walk = new EdgeWalk(index, Math.max(0, Math.trunc(edgeScanCap)));
  const matchedPaths: string[] = [];
  const matchedNodeIds: string[] = [];
  const selectedGateIds: string[] = [];
  const selectedTestPaths: string[] = [];
  const staleIncluded: string[] = [];
  const invalidatedIncluded: string[] = [];
  const conflicts = new Map<string, Set<string>>();

  for (const selected of result.selected) {
    matchedNodeIds.push(selected.nodeId);
    pushUnique(matchedPaths, pathOfSelected(selected));
    const node = index.nodesById.get(selected.nodeId);
    if (!node) continue;
    if (node.freshness === 'stale') pushUnique(staleIncluded, pathOfNode(node) ?? node.id);
    if (isInvalidatedContextGraphNode(index, node)) pushUnique(invalidatedIncluded, pathOfNode(node) ?? node.id);
    collectGatesAndTests(index, node, walk, selectedGateIds, selectedTestPaths);
    collectConflicts(index, node, walk, conflicts);
  }

  const exactSeedsPreserved: string[] = [];
  const unsupportedLanguageExactClaims: string[] = [];
  for (const seed of result.seeds) {
    const seedPath = pathOfNodeId(seed.nodeId, seed.path);
    if (!seedPath) continue;
    if (
      (seed.confidence === 'exact_definition' || seed.confidence === 'exact_reference')
      && !isSupportedCodePath(seedPath)
    ) {
      pushUnique(unsupportedLanguageExactClaims, seedPath);
    }
    if (!isExactContextGraphSeedConfidence(seed.confidence)) continue;
    if (matchedPaths.includes(seedPath)) pushUnique(exactSeedsPreserved, seedPath);
  }

  const writeScopeConflicts: ContextGraphBenchmarkConflict[] = [...conflicts.entries()]
    .map(([conflictPath, owners]) => ({ path: conflictPath, slices: [...owners].sort() }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  return {
    matchedPaths,
    matchedNodeIds,
    selectedGateIds: selectedGateIds.sort(),
    selectedTestPaths: selectedTestPaths.sort(),
    writeScopeConflicts,
    staleIncluded,
    invalidatedIncluded,
    exactSeedsPreserved,
    unsupportedLanguageExactClaims,
    scannedEdges: walk.scanned,
    edgeScanTruncated: walk.truncated
  };
}
