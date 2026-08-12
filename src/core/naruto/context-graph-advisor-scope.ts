/**
 * Graph mechanics for the Naruto scope advisory: bounded walks, exact seed
 * resolution, and the two closures a slice gets.
 *
 * Split out of `context-graph-advisor.ts` by role — this file knows how to read
 * the graph, that file knows what the advice means. Nothing here mutates
 * anything, spawns a process, or reads a file: every function takes a reader the
 * caller already opened, through the query facade.
 *
 * The two closures are deliberately different directions:
 *  - the *write closure* walks dependency edges downward from the paths a slice
 *    would write, which is what makes two slices collide;
 *  - the *impact closure* walks the same relations in reverse to find the tests
 *    and gates that would have to re-run.
 * A test file is a dependent, never a dependency, so it can never enter a write
 * closure and a shared suite is never reported as a write conflict.
 *
 * ## Two things the compact index changed, both reported rather than papered over
 *
 * **Label seeds no longer resolve.** Format revision 1 interns an exact table of
 * canonical node ids and a basename table of workspace-relative paths, and has no
 * label index at all. So a slice that declared only a symbol name now resolves to
 * nothing and is reported through `unresolved_seeds`, which makes the advisory
 * *conservative* — the slice is unproven rather than falsely disjoint. Guessing
 * the label through BM25F would have kept the old behaviour and violated ADR §4:
 * a text match is not a relation, and an advisory that guessed its own write
 * scope would be confidently wrong about which slices can run in parallel.
 *
 * **Metadata booleans arrive as strings.** The writer stores every metadata value
 * through `String(value)`, so `isTest: true` becomes `'true'`. `contextNodeFlag`
 * normalizes it; without that, `isTestNode` loses its metadata arm entirely and
 * test files start reading as write-scope conflicts.
 */
import { contextGraphPathFromId } from '../triwiki/context-graph/ids.js';
import { isWorkspaceRelativePosixPath } from '../triwiki/context-graph/paths.js';
import type { ContextGraphExplanationStep, ContextGraphProvenanceRef } from '../triwiki/context-graph/query-types.js';
import {
  contextNodeFlag,
  contextWalkProvenance,
  contextWalkRoot,
  resolveContextSeeds,
  walkContextGraph,
  HydrationCursor,
  type ContextGraphNodeView,
  type ContextIndexReader,
  type ContextWalkHit,
  type ContextWalkResult
} from '../triwiki/context-graph/query/index.js';
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
const DEPENDENCY_EDGE_TYPES = new Set(['imports', 'reexports', 'depends_on', 'references', 'calls', 'routes_to'] as const);
/** Upward: what has to be re-verified because it depends on a written file. */
const IMPACT_EDGE_TYPES = new Set([
  'imports', 'reexports', 'references', 'calls', 'tests', 'affected_by', 'verified_by', 'gated_by', 'depends_on', 'owns', 'routes_to'
] as const);
/** Same-file expansion applied to a seed before the reverse walk, so symbol-level tests stay reachable. */
const SEED_EXPANSION_EDGE_TYPES = new Set(['defines', 'contains'] as const);

const WRITE_CAPS = {
  maxDepth: NARUTO_ADVISOR_CAPS.maxDepth,
  maxNodes: NARUTO_ADVISOR_CAPS.maxNodesPerWalk,
  maxEdges: NARUTO_ADVISOR_CAPS.maxEdgesPerWalk
} as const;

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

export type WalkHit = ContextWalkHit;

export interface SliceState {
  readonly scope: NarutoContextGraphScope;
  readonly closure: Map<string, ContextWalkHit>;
  readonly writeSet: Set<string>;
  readonly recommendations: NarutoContextGraphRecommendation[];
}

function nodePathOf(node: ContextGraphNodeView): string | null {
  return node.path ?? contextGraphPathFromId(node.id);
}

function isTestNode(node: ContextGraphNodeView): boolean {
  return node.kind === 'test' || contextNodeFlag(node, 'isTest');
}

/**
 * The metadata arms are unreachable today, and that is a fact about the compiler
 * rather than a gap here: `extractors/topology/gates.ts` derives
 * `requiredForPublish`/`alwaysOnRelease` from the same manifest sets
 * `isProtectedGate` checks, in the same `addNode` call that sets `risk`, so each
 * flag implies `risk === 'protected'` and short-circuits first (verified over the
 * real manifest: 45 ids, zero counterexamples). Recorded because it has already
 * been mistaken for a coverage gap — no fixture can produce a metadata-only
 * protected gate. Kept because that invariant lives in another file and nothing
 * enforces it across the distance. `nonRecursive` gets no arm: it would be born dead.
 */
function isProtectedGateNode(node: ContextGraphNodeView): boolean {
  return node.risk === 'protected' || contextNodeFlag(node, 'requiredForPublish') || contextNodeFlag(node, 'alwaysOnRelease');
}

function riskDomainOf(node: ContextGraphNodeView): string | null {
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

/** Repository truth behind a hop chain. A zero-hop hit falls back to the node's own content hash. */
export function narutoAdvisorProvenance(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  hit: ContextWalkHit
): ContextGraphProvenanceRef[] {
  return contextWalkProvenance(reader, cursor, hit, NARUTO_ADVISOR_CAPS.maxRecommendationsPerSlice);
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

function rootsOf(cursor: HydrationCursor, seeds: readonly number[]): ContextWalkHit[] {
  const roots: ContextWalkHit[] = [];
  for (const node of seeds) {
    const view = cursor.node(node);
    if (view !== null) roots.push(contextWalkRoot(node, view.id));
  }
  return roots;
}

/**
 * Seeds plus their same-file neighbours, all at depth 0.
 *
 * The expansion hop is kept in the reason path but not charged against the walk's
 * depth: a symbol and the file that defines it are one location, and spending a
 * hop to cross between them would halve the reach of the impact closure for
 * symbol-seeded slices only.
 */
function expandRoots(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  roots: readonly ContextWalkHit[]
): ContextWalkHit[] {
  const expanded = walkContextGraph(reader, cursor, {
    roots,
    direction: 'out',
    edgeTypes: SEED_EXPANSION_EDGE_TYPES,
    caps: { maxDepth: 1, maxNodes: NARUTO_ADVISOR_CAPS.maxNodesPerWalk, maxEdges: NARUTO_ADVISOR_CAPS.maxEdgesPerWalk }
  });
  const out: ContextWalkHit[] = [];
  for (const hit of expanded.hits.values()) out.push(hit.depth === 0 ? hit : { ...hit, depth: 0 });
  return out;
}

/** Write closure keyed by workspace path. Test files are excluded: they are dependents, never dependencies. */
function closurePaths(cursor: HydrationCursor, walk: ContextWalkResult): Map<string, ContextWalkHit> {
  const out = new Map<string, ContextWalkHit>();
  for (const hit of walk.hits.values()) {
    const node = cursor.node(hit.node);
    if (node === null || isTestNode(node)) continue;
    const nodePath = nodePathOf(node);
    if (nodePath && !out.has(nodePath)) out.set(nodePath, hit);
  }
  return out;
}

function recommendationsFrom(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  sliceId: string,
  writeSet: ReadonlySet<string>,
  impact: ContextWalkResult
): NarutoContextGraphRecommendation[] {
  const out: NarutoContextGraphRecommendation[] = [];
  for (const hit of impact.hits.values()) {
    const node = cursor.node(hit.node);
    if (node === null) continue;
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
      provenance: narutoAdvisorProvenance(reader, cursor, hit)
    });
    if (out.length >= NARUTO_ADVISOR_CAPS.maxRecommendationsPerSlice) break;
  }
  return out.sort((a, b) => (a.kind === b.kind ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.kind < b.kind ? -1 : 1));
}

/**
 * Resolve one slice into its seeds, its write closure, and the verifiers its
 * writes would invalidate. A slice that declares neither write paths nor symbols
 * falls back to exact matches from its own title and the task text; when nothing
 * resolves, the caller must treat the slice as unproven, not as empty.
 */
export function buildNarutoSliceState(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  slice: NarutoAdvisorSliceInput,
  taskTokens: readonly string[],
  maxDepth: number
): SliceState {
  const writePaths = narutoAdvisorPathList(slice.writePaths);
  const labels = [...(slice.symbols ?? [])];
  if (!writePaths.length && !labels.length) labels.push(...narutoAdvisorTaskTokens(slice.title ?? ''), ...taskTokens);

  const resolution = resolveContextSeeds(reader, writePaths, labels, NARUTO_ADVISOR_CAPS.maxNodesPerLabel);
  const roots = rootsOf(cursor, resolution.nodes);
  const caps = { ...WRITE_CAPS, maxDepth: Math.max(0, maxDepth) };

  const walk = walkContextGraph(reader, cursor, { roots, direction: 'out', edgeTypes: DEPENDENCY_EDGE_TYPES, caps });
  const impact = walkContextGraph(reader, cursor, {
    roots: expandRoots(reader, cursor, roots),
    direction: 'in',
    edgeTypes: IMPACT_EDGE_TYPES,
    caps
  });

  const closure = closurePaths(cursor, walk);
  const writeSet = new Set(writePaths);
  return {
    scope: {
      slice_id: slice.id,
      seed_node_ids: roots.map((root) => root.nodeId).sort(),
      write_paths: writePaths,
      write_closure: [...closure.keys()].sort(),
      unresolved_seeds: [...new Set(resolution.unresolved)].sort(),
      truncated: walk.truncated || impact.truncated
    },
    closure,
    writeSet,
    recommendations: recommendationsFrom(reader, cursor, slice.id, writeSet, impact)
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
