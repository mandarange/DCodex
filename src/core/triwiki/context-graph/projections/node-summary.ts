/**
 * Node -> pack-entry projection primitives.
 *
 * Every sentence a projected entry carries is assembled from facts that already
 * exist in the index: the node's own fields, its metadata, and the labels of
 * nodes reachable over one graph edge. Nothing here invents a description, and
 * nothing here reads the repository — grounding is the provenance hydration
 * already attached, and freshness is decided from real source hashes by the
 * caller that owns the file I/O.
 *
 * The inputs are now compact-index views (CG2-13): a `ContextGraphNodeView` from
 * the reader instead of a `ContextGraphNode` off a parsed snapshot, and a bounded
 * typed walk instead of a materialized adjacency map. Every metadata read goes
 * through `contextNodeFlag` / `contextNodeText` / `contextNodeCount` — `exported`,
 * `lines`, `fanIn` and `fileCount` all arrive as strings, and comparing them to a
 * boolean or a number fails silently. See `graph-facts.ts`.
 */
import type { ContextGraphEdgeType, ContextGraphFreshness } from '../contracts.js';
import { CONTEXT_GRAPH_MISSING_SOURCE_HASH } from '../compiler/freshness.js';
import { contextNodeFlag, type ContextGraphNodeView, type ContextIndexReader, type HydrationCursor } from '../query/index.js';
import { contextNodeCount, contextNodeText, contextOneHopNeighbours } from './graph-facts.js';

/** Relation types whose targets read as "what this node offers". */
const EXPORT_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(['defines', 'reexports']);
/** Relation types whose targets read as "what this node needs". */
const DEPENDENCY_EDGE_TYPES: ReadonlySet<ContextGraphEdgeType> = new Set(['imports', 'depends_on', 'routes_to']);

const MAX_LISTED = 5;

export interface NodeSummaryExtras {
  /** Pre-aggregated export labels (used for module nodes, whose exports are two hops away). */
  readonly exports?: readonly string[];
  readonly dependsOn?: readonly string[];
  readonly fileCount?: number;
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function listOf(values: readonly string[]): string {
  const unique = [...new Set(values.filter((value) => Boolean(value)))].sort();
  if (unique.length === 0) return '';
  const shown = unique.slice(0, MAX_LISTED);
  const rest = unique.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`;
}

/** One-hop label collection over a relation family; bounded by the walk's caps. */
function relatedLabels(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: ContextGraphNodeView,
  types: ReadonlySet<ContextGraphEdgeType>,
  exportedOnly: boolean
): string[] {
  const labels: string[] = [];
  for (const neighbour of contextOneHopNeighbours(reader, cursor, node.node, node.id, types)) {
    const target = neighbour.view;
    if (exportedOnly && target.kind === 'symbol' && !contextNodeFlag(target, 'exported')) continue;
    labels.push(target.label);
  }
  return labels;
}

function headline(node: ContextGraphNodeView, extras: NodeSummaryExtras): string {
  const where = node.path ? ` at ${node.path}` : '';
  const line = node.line !== undefined ? `:${node.line}` : '';
  switch (node.kind) {
    case 'file': {
      const language = contextNodeText(node, 'language') ?? 'source';
      const purpose = contextNodeText(node, 'purpose');
      const lines = contextNodeCount(node, 'lines');
      const fanIn = contextNodeCount(node, 'fanIn') ?? 0;
      const size = lines === null ? '' : `${lines} lines, `;
      return `${node.label} is a ${language} file${where} (${size}fan-in ${fanIn}, ${node.risk} risk).${purpose ? ` Source purpose: ${purpose}.` : ''}`;
    }
    case 'symbol': {
      const symbolKind = contextNodeText(node, 'symbolKind') ?? 'symbol';
      const exported = contextNodeFlag(node, 'exported') ? 'exported ' : 'internal ';
      return `${node.label} is an ${exported}${symbolKind}${where}${line}.`;
    }
    case 'module': {
      const dir = contextNodeText(node, 'dir') ?? node.path ?? node.label;
      const fileCount = extras.fileCount ?? contextNodeCount(node, 'fileCount') ?? 0;
      return `${node.label} is a module at ${dir} (${fileCount} file${fileCount === 1 ? '' : 's'}, ${node.risk} risk).`;
    }
    case 'test':
      return `${node.label} is a test${where}.`;
    case 'gate':
      return `${node.label} is a ${node.risk} gate${where}.`;
    case 'command':
      return `${node.label} is a CLI command declared${where}.`;
    default:
      return `${node.label} is a ${node.kind} node${where}${line}.`;
  }
}

/**
 * Deterministic entry text for one node. Two compiles of the same repository
 * state produce byte-identical output, which is what lets `index_digest` mean
 * "the projected content changed" rather than "the process ran again".
 */
export function describeContextGraphNode(
  reader: ContextIndexReader,
  cursor: HydrationCursor,
  node: ContextGraphNodeView,
  extras: NodeSummaryExtras = {}
): string {
  const exports = extras.exports ?? relatedLabels(reader, cursor, node, EXPORT_EDGE_TYPES, true);
  const dependsOn = extras.dependsOn ?? relatedLabels(reader, cursor, node, DEPENDENCY_EDGE_TYPES, false);
  const exportsPart = exports.length > 0 ? `Key exports: ${listOf(exports)}.` : 'It has no exported surface in the graph.';
  const dependsPart = dependsOn.length > 0 ? `Depends on: ${listOf(dependsOn)}.` : 'It has no recorded outbound dependency.';
  return compact(`${headline(node, extras)} ${exportsPart} ${dependsPart}`);
}

export function estimateEntryTokenCost(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Entry identity. Module entries keep the historical `code:<module-label>` form,
 * which is the same string the wrongness ledger keys modules by; every other kind
 * carries its full graph node id so the entry can be traced back to one node.
 */
export function codePackEntryId(node: ContextGraphNodeView, taken: ReadonlySet<string>): string {
  const preferred = node.kind === 'module' ? `code:${node.label}` : `code:${node.id}`;
  if (!taken.has(preferred)) return preferred;
  const fallback = `code:${node.id}`;
  return taken.has(fallback) ? `${fallback}#${node.kind}` : fallback;
}

/**
 * Freshness for a projected entry. `observedHashes` is the current sha256 of the
 * node's own source path, read by the caller; when available it decides the
 * verdict outright, otherwise the compiler's recorded verdict stands. A stale
 * snapshot can only downgrade — never upgrade a node already marked stale.
 */
export function projectedFreshness(
  node: ContextGraphNodeView,
  snapshotFreshness: 'fresh' | 'stale',
  observedHashes?: Readonly<Record<string, string>> | undefined
): ContextGraphFreshness {
  let verdict: ContextGraphFreshness = node.freshness;
  const observed = node.path === undefined ? undefined : observedHashes?.[node.path];
  if (observed !== undefined) {
    if (observed === CONTEXT_GRAPH_MISSING_SOURCE_HASH) verdict = 'stale';
    else if (node.contentHash) verdict = observed === node.contentHash ? 'fresh' : 'stale';
    else verdict = 'unknown';
  }
  if (snapshotFreshness === 'stale' && verdict === 'fresh') return 'stale';
  return verdict;
}

/**
 * Entry trust. It starts from the node's own trust — which the extractors set
 * from how the fact was observed — and is only ever reduced: by weak grounding
 * and by a source that no longer matches the bytes the fact was read from.
 */
export function projectedTrustScore(
  node: ContextGraphNodeView,
  provenanceCount: number,
  freshness: ContextGraphFreshness
): number {
  let score = Math.max(0, Math.min(1, node.trust));
  if (provenanceCount === 0) return 0;
  if (provenanceCount === 1) score -= 0.05;
  if (freshness === 'stale') score -= 0.3;
  else if (freshness === 'unknown') score -= 0.15;
  if (node.risk === 'high') score -= 0.1;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}
