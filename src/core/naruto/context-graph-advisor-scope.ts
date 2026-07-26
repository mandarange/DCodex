/**
 * Graph mechanics for the Naruto scope advisory: bounded walks, exact seed
 * resolution, and the two closures a slice gets.
 *
 * Split out of `context-graph-advisor.ts` by role — this file knows how to read
 * the graph, that file knows what the advice means. Nothing here mutates
 * anything, spawns a process, or reads a file: every function takes an index the
 * caller already built.
 *
 * The two closures are deliberately different directions:
 *  - the *write closure* walks dependency edges downward from the paths a slice
 *    would write, which is what makes two slices collide;
 *  - the *impact closure* walks the same relations in reverse to find the tests
 *    and gates that would have to re-run.
 * A test file is a dependent, never a dependency, so it can never enter a write
 * closure and a shared suite is never reported as a write conflict.
 */
import type { ContextGraphEdge, ContextGraphNode } from '../triwiki/context-graph/contracts.js';
import { incomingEdges, outgoingEdges, type ContextGraphIndex } from '../triwiki/context-graph/graph-index.js';
import { contextGraphPathFromId } from '../triwiki/context-graph/ids.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../triwiki/context-graph/query-types.js';
import { normalizeNarutoPath } from './naruto-work-item.js';

export const NARUTO_ADVISOR_CAPS = {
  maxDepth: 2,
  maxNodesPerWalk: 512,
  maxEdgesPerWalk: 4096,
  maxSharedPathsPerPair: 12,
  maxRecommendationsPerSlice: 24,
  maxTaskTokens: 32,
  maxNodesPerLabel: 8
} as const;

/** Downward: what a written file stands on. Conflict detection uses only these. */
const DEPENDENCY_EDGE_TYPES: ReadonlySet<string> = new Set(['imports', 'reexports', 'depends_on', 'references', 'calls', 'routes_to']);
/** Upward: what has to be re-verified because it depends on a written file. */
const IMPACT_EDGE_TYPES: ReadonlySet<string> = new Set([
  'imports', 'reexports', 'references', 'calls', 'tests', 'affected_by', 'verified_by', 'gated_by', 'depends_on', 'owns', 'routes_to'
]);
/** Same-file expansion applied to a seed before the reverse walk, so symbol-level tests stay reachable. */
const SEED_EXPANSION_EDGE_TYPES: ReadonlySet<string> = new Set(['defines', 'contains']);

export interface NarutoAdvisorSliceInput {
  readonly id: string;
  readonly title?: string;
  readonly writePaths?: readonly string[];
  readonly readPaths?: readonly string[];
  readonly symbols?: readonly string[];
}

export interface NarutoContextGraphScope {
  readonly slice_id: string;
  readonly seed_node_ids: string[];
  readonly write_paths: string[];
  readonly write_closure: string[];
  readonly unresolved_seeds: string[];
  readonly truncated: boolean;
}

export interface NarutoContextGraphRecommendation {
  readonly slice_id: string;
  readonly kind: 'test' | 'gate';
  /** Test path or gate id. */
  readonly id: string;
  readonly path: string;
  readonly protected: boolean;
  readonly risk_domain: string | null;
  /** Hop chain; a reverse hop is prefixed with `<-`. */
  readonly reason_path: string[];
  readonly explanation: ContextGraphExplanationStep[];
  readonly provenance: ContextGraphProvenanceRef[];
}

export interface WalkHit {
  readonly nodeId: string;
  readonly depth: number;
  readonly reasonPath: string[];
  readonly explanation: ContextGraphExplanationStep[];
}

export interface SliceState {
  readonly scope: NarutoContextGraphScope;
  readonly closure: Map<string, WalkHit>;
  readonly writeSet: Set<string>;
  readonly recommendations: NarutoContextGraphRecommendation[];
}

interface WalkResult {
  readonly hits: Map<string, WalkHit>;
  readonly truncated: boolean;
}

function explanationStep(edge: ContextGraphEdge): ContextGraphExplanationStep {
  return { edgeId: edge.id, type: edge.type, from: edge.from, to: edge.to, confidence: edge.confidence, path: edge.provenance.path };
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

function riskDomainOf(node: ContextGraphNode): string | null {
  if (node.kind === 'risk_domain') return node.label || null;
  if (node.kind !== 'gate') return null;
  const declared = node.metadata.namespace;
  return (typeof declared === 'string' && declared ? declared : node.label.split(':')[0]) || null;
}

export function narutoAdvisorWorkspacePath(value: string): string | null {
  const normalized = normalizeNarutoPath(value);
  return normalized && isWorkspaceRelativePosixPath(normalized) ? normalized : null;
}

export function narutoAdvisorPathList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map(narutoAdvisorWorkspacePath).filter((value): value is string => value !== null))].sort();
}

function rootHit(nodeId: string): WalkHit {
  return { nodeId, depth: 0, reasonPath: [nodeId], explanation: [] };
}

/** Bounded breadth-first walk. Deterministic: the adjacency it reads is already id-sorted. */
function walkGraph(index: ContextGraphIndex, roots: readonly WalkHit[], direction: 'out' | 'in', types: ReadonlySet<string>, maxDepth: number): WalkResult {
  const hits = new Map<string, WalkHit>();
  const queue: WalkHit[] = [];
  for (const root of roots) {
    if (hits.has(root.nodeId) || !index.nodesById.has(root.nodeId)) continue;
    hits.set(root.nodeId, root);
    queue.push(root);
  }
  let edgesVisited = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    if (!current || current.depth >= maxDepth) continue;
    for (const edge of direction === 'out' ? outgoingEdges(index, current.nodeId) : incomingEdges(index, current.nodeId)) {
      edgesVisited += 1;
      if (edgesVisited > NARUTO_ADVISOR_CAPS.maxEdgesPerWalk) return { hits, truncated: true };
      if (!types.has(edge.type)) continue;
      const next = direction === 'out' ? edge.to : edge.from;
      if (hits.has(next) || !index.nodesById.has(next)) continue;
      if (hits.size >= NARUTO_ADVISOR_CAPS.maxNodesPerWalk) return { hits, truncated: true };
      const hit: WalkHit = {
        nodeId: next,
        depth: current.depth + 1,
        reasonPath: [...current.reasonPath, direction === 'out' ? edge.type : `<-${edge.type}`, next],
        explanation: [...current.explanation, explanationStep(edge)]
      };
      hits.set(next, hit);
      queue.push(hit);
    }
  }
  return { hits, truncated: false };
}

/** Repository truth behind a hop chain. A zero-hop hit falls back to the node's own content hash. */
export function narutoAdvisorProvenance(index: ContextGraphIndex, hit: WalkHit): ContextGraphProvenanceRef[] {
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
  if (out.length) return out;
  const node = index.nodesById.get(hit.nodeId);
  const nodePath = node ? nodePathOf(node) : null;
  if (node?.contentHash && nodePath) out.push({ path: nodePath, hash: node.contentHash });
  return out;
}

/** Exact-only seed resolution: a token that is not a real path or label is reported, never guessed. */
function resolveSeedNodes(index: ContextGraphIndex, paths: readonly string[], labels: readonly string[], unresolved: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (id: string): void => {
    if (!seen.has(id) && index.nodesById.has(id)) {
      seen.add(id);
      out.push(id);
    }
  };
  const miss = (value: string): void => {
    if (value && !unresolved.includes(value)) unresolved.push(value);
  };
  for (const raw of paths) {
    const rel = narutoAdvisorWorkspacePath(raw);
    const ids = rel ? index.nodesByPath.get(rel) ?? [] : [];
    if (!ids.length) miss(raw);
    for (const id of ids) push(id);
  }
  for (const label of labels) {
    const ids = index.nodesByLabel.get(String(label ?? '').toLowerCase()) ?? [];
    // A label shared by many nodes is too generic to be honest evidence of scope.
    if (!ids.length || ids.length > NARUTO_ADVISOR_CAPS.maxNodesPerLabel) miss(String(label ?? ''));
    else for (const id of ids) push(id);
  }
  return out;
}

/** Identifier-ish and path-ish tokens of free text, so a task description can seed the walk from repository truth. */
export function narutoAdvisorTaskTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of String(text ?? '').split(/[^\w$./-]+/)) {
    const token = raw.replace(/^[./-]+/, '').replace(/[./-]+$/, '');
    if (token.length < 3 || tokens.includes(token)) continue;
    if (!/^[A-Za-z_$][\w$]*$/.test(token) && !/^[\w$./-]+\.[A-Za-z]\w*$/.test(token)) continue;
    tokens.push(token);
    if (tokens.length >= NARUTO_ADVISOR_CAPS.maxTaskTokens) break;
  }
  return tokens;
}

function expandRoots(index: ContextGraphIndex, seeds: readonly string[]): WalkHit[] {
  const roots: WalkHit[] = seeds.map(rootHit);
  const seen = new Set(seeds);
  for (const seed of seeds) {
    for (const edge of outgoingEdges(index, seed)) {
      if (!SEED_EXPANSION_EDGE_TYPES.has(edge.type) || seen.has(edge.to)) continue;
      seen.add(edge.to);
      roots.push({ nodeId: edge.to, depth: 0, reasonPath: [seed, edge.type, edge.to], explanation: [explanationStep(edge)] });
      if (roots.length >= NARUTO_ADVISOR_CAPS.maxNodesPerWalk) return roots;
    }
  }
  return roots;
}

/** Write closure keyed by workspace path. Test files are excluded: they are dependents, never dependencies. */
function closurePaths(index: ContextGraphIndex, walk: WalkResult): Map<string, WalkHit> {
  const out = new Map<string, WalkHit>();
  for (const hit of walk.hits.values()) {
    const node = index.nodesById.get(hit.nodeId);
    if (!node || isTestNode(node)) continue;
    const nodePath = nodePathOf(node);
    if (nodePath && !out.has(nodePath)) out.set(nodePath, hit);
  }
  return out;
}

function recommendationsFrom(index: ContextGraphIndex, sliceId: string, writeSet: ReadonlySet<string>, impact: WalkResult): NarutoContextGraphRecommendation[] {
  const out: NarutoContextGraphRecommendation[] = [];
  for (const hit of impact.hits.values()) {
    const node = index.nodesById.get(hit.nodeId);
    if (!node) continue;
    const isGate = node.kind === 'gate';
    if (!isGate && !isTestNode(node)) continue;
    const nodePath = nodePathOf(node);
    if (!nodePath || (!isGate && writeSet.has(nodePath))) continue;
    out.push({
      slice_id: sliceId,
      kind: isGate ? 'gate' : 'test',
      id: isGate ? node.label : nodePath,
      path: nodePath,
      protected: isGate ? isProtectedGateNode(node) : false,
      risk_domain: isGate ? riskDomainOf(node) : null,
      reason_path: [...hit.reasonPath],
      explanation: [...hit.explanation],
      provenance: narutoAdvisorProvenance(index, hit)
    });
    if (out.length >= NARUTO_ADVISOR_CAPS.maxRecommendationsPerSlice) break;
  }
  return out.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
}

/**
 * Resolve one slice into its seeds, its write closure, and the verifiers its
 * writes would invalidate. A slice that declares neither write paths nor symbols
 * falls back to exact label matches from its own title and the task text; when
 * nothing resolves, the caller must treat the slice as unproven, not as empty.
 */
export function buildNarutoSliceState(index: ContextGraphIndex, slice: NarutoAdvisorSliceInput, taskTokens: readonly string[], maxDepth: number): SliceState {
  const unresolved: string[] = [];
  const writePaths = narutoAdvisorPathList(slice.writePaths);
  const labels = [...(slice.symbols ?? [])];
  if (!writePaths.length && !labels.length) labels.push(...narutoAdvisorTaskTokens(slice.title ?? ''), ...taskTokens);
  const seeds = resolveSeedNodes(index, writePaths, labels, unresolved);
  const walk = walkGraph(index, seeds.map(rootHit), 'out', DEPENDENCY_EDGE_TYPES, maxDepth);
  const impact = walkGraph(index, expandRoots(index, seeds), 'in', IMPACT_EDGE_TYPES, maxDepth);
  const closure = closurePaths(index, walk);
  const writeSet = new Set(writePaths);
  return {
    scope: {
      slice_id: slice.id,
      seed_node_ids: [...seeds].sort(),
      write_paths: writePaths,
      write_closure: [...closure.keys()].sort(),
      unresolved_seeds: [...new Set(unresolved)].sort(),
      truncated: walk.truncated || impact.truncated
    },
    closure,
    writeSet,
    recommendations: recommendationsFrom(index, slice.id, writeSet, impact)
  };
}

/** Scope shape used when the graph cannot be consulted at all. */
export function emptyNarutoScope(sliceId: string, slice: NarutoAdvisorSliceInput | undefined): NarutoContextGraphScope {
  return {
    slice_id: sliceId,
    seed_node_ids: [],
    write_paths: narutoAdvisorPathList(slice?.writePaths),
    write_closure: [],
    unresolved_seeds: [],
    truncated: false
  };
}
