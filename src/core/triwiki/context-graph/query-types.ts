/**
 * Query contract shared by the query engine and every consumer
 * (SearchProvider context, TriWiki projections, Naruto advisory, benchmark).
 */
import type {
  ContextGraphEdgeType,
  ContextGraphFreshness,
  ContextGraphNodeKind,
  ContextGraphRisk
} from './contracts.js';
import type { ContextGraphQueryProfileName } from './profiles.js';

export const CONTEXT_GRAPH_QUERY_SCHEMA = 'sks.context-graph-query.v1' as const;

/** Where a seed came from. Seed confidence is preserved end to end; a text hit never becomes an exact reference. */
export type ContextGraphSeedConfidence =
  | 'exact_definition'
  | 'exact_reference'
  | 'manifest'
  | 'syntactic_reference'
  | 'file_path'
  | 'text_candidate';

export type ContextGraphSeedOrigin = 'exact' | 'lexical' | 'provided';

export interface ContextGraphSeed {
  nodeId: string;
  confidence: ContextGraphSeedConfidence;
  origin: ContextGraphSeedOrigin;
  /** Optional caller-supplied priority; the resolver falls back to a confidence-derived score. */
  score?: number;
  path?: string;
  line?: number;
}

export interface ContextGraphQueryRequest {
  root: string;
  query: string;
  profile?: ContextGraphQueryProfileName;
  tokenBudget?: number;
  maxSelected?: number;
  risk?: 'normal' | 'high';
  /** Seeds acquired outside the graph (SearchProvider symbol/files/text). Their confidence is preserved. */
  seeds?: readonly ContextGraphSeed[];
  /** Restrict the answer to nodes reachable from these workspace-relative paths. */
  focusPaths?: readonly string[];
  timeoutMs?: number;
  /** Injected clock so query results stay deterministic under test. */
  now?: string;
}

export interface ContextGraphExplanationStep {
  edgeId: string;
  type: ContextGraphEdgeType;
  from: string;
  to: string;
  confidence: string;
  path: string;
}

export interface ContextGraphProvenanceRef {
  path: string;
  line?: number;
  hash: string;
}

export interface ContextGraphSelectedNode {
  nodeId: string;
  kind: ContextGraphNodeKind;
  label: string;
  path?: string;
  line?: number;
  score: number;
  trust: number;
  freshness: ContextGraphFreshness;
  risk: ContextGraphRisk;
  tokenCost: number;
  depth: number;
  seed: boolean;
  seedConfidence?: ContextGraphSeedConfidence;
  /** Human-readable hop chain, e.g. `["file:a.ts", "imports", "file:b.ts"]`. */
  reasonPath: string[];
  /** Machine-checkable hop chain; every edge must exist in the snapshot. */
  explanation: ContextGraphExplanationStep[];
  provenance: ContextGraphProvenanceRef[];
}

export type ContextGraphOmissionReason =
  | 'token_budget'
  | 'stale_node'
  | 'invalidated_proof'
  | 'redundant_sibling'
  | 'depth_limit'
  | 'visit_cap'
  | 'edge_cap'
  | 'timeout'
  | 'no_provenance'
  | 'max_selected';

export interface ContextGraphQueryResult {
  schema: typeof CONTEXT_GRAPH_QUERY_SCHEMA;
  ok: boolean;
  snapshotHash: string;
  snapshotFreshness: 'fresh' | 'stale';
  profile: ContextGraphQueryProfileName;
  seeds: ContextGraphSeed[];
  seedCount: number;
  visitedNodes: number;
  visitedEdges: number;
  selected: ContextGraphSelectedNode[];
  selectedNodes: number;
  explanationPathCount: number;
  /** Fraction of selected nodes carrying at least one provenance record; the floor is 1.00. */
  provenanceCoverage: number;
  staleExcluded: number;
  invalidatedExcluded: number;
  tokenCost: number;
  tokenBudget: number;
  truncated: boolean;
  timeout: boolean;
  omissionReasons: Partial<Record<ContextGraphOmissionReason, number>>;
  warnings: string[];
  errors: string[];
  durationMs: number;
  processSpawns: 0;
}

/** Additive metadata surfaced on `SearchResponse.context`. */
export interface ContextGraphSearchMeta {
  snapshotHash: string;
  snapshotFreshness: 'fresh' | 'stale';
  profile: ContextGraphQueryProfileName;
  seedCount: number;
  visitedNodes: number;
  selectedNodes: number;
  explanationPathCount: number;
  provenanceCoverage: number;
  staleExcluded: number;
  invalidatedExcluded: number;
  tokenCost: number;
  tokenBudget: number;
  omissionReasons: Record<string, number>;
}

export function emptyContextGraphQueryResult(
  snapshotHash: string,
  profile: ContextGraphQueryProfileName,
  errors: string[] = []
): ContextGraphQueryResult {
  return {
    schema: CONTEXT_GRAPH_QUERY_SCHEMA,
    ok: errors.length === 0,
    snapshotHash,
    snapshotFreshness: 'stale',
    profile,
    seeds: [],
    seedCount: 0,
    visitedNodes: 0,
    visitedEdges: 0,
    selected: [],
    selectedNodes: 0,
    explanationPathCount: 0,
    provenanceCoverage: 0,
    staleExcluded: 0,
    invalidatedExcluded: 0,
    tokenCost: 0,
    tokenBudget: 0,
    truncated: false,
    timeout: false,
    omissionReasons: {},
    warnings: [],
    errors,
    durationMs: 0,
    processSpawns: 0
  };
}
