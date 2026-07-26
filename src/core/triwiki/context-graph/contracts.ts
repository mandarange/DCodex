/**
 * TriWiki Context Graph contract (`sks.context-graph.v1`).
 *
 * `v1` is a machine schema revision, not a product version recommendation.
 * The graph is a generated cache: every node and edge must be able to point
 * back at repository truth through provenance, and nothing here may carry
 * secrets, absolute paths, raw prompts, or raw tool output.
 */

export const CONTEXT_GRAPH_SCHEMA = 'sks.context-graph.v1' as const;
export const CONTEXT_GRAPH_FRAGMENT_SCHEMA = 'sks.context-graph-fragment.v1' as const;
export const CONTEXT_GRAPH_META_SCHEMA = 'sks.context-graph-meta.v1' as const;
export const CONTEXT_GRAPH_SCHEMA_REVISION = '1.0.0' as const;

/** Explicit, non-silent statuses. `search context` must surface these instead of falling back to lexical search. */
export const CONTEXT_GRAPH_MISSING_ERROR = 'context_graph_missing' as const;
export const CONTEXT_GRAPH_STALE_ERROR = 'context_graph_stale' as const;
export const CONTEXT_GRAPH_CORRUPT_ERROR = 'context_graph_corrupt' as const;
export const CONTEXT_GRAPH_REPAIR_COMMAND = 'sks wiki refresh --code' as const;

export const CONTEXT_GRAPH_NODE_KINDS = [
  'file',
  'symbol',
  'module',
  'command',
  'route',
  'pipeline',
  'test',
  'gate',
  'schema',
  'config',
  'wiki_claim',
  'source',
  'proof',
  'risk_domain'
] as const;

export type ContextGraphNodeKind = (typeof CONTEXT_GRAPH_NODE_KINDS)[number];

export const CONTEXT_GRAPH_EDGE_TYPES = [
  'contains',
  'defines',
  'imports',
  'reexports',
  'references',
  'calls',
  'depends_on',
  'routes_to',
  'owns',
  'tests',
  'verified_by',
  'gated_by',
  'affected_by',
  'cites',
  'derived_from',
  'supports',
  'contradicts',
  'supersedes',
  'invalidates',
  'cochanged_with',
  'conflicts_with'
] as const;

export type ContextGraphEdgeType = (typeof CONTEXT_GRAPH_EDGE_TYPES)[number];

/** How the relation was observed. `derived` may only be merged when exact/manifest evidence backs it. */
export type ContextGraphEdgeConfidence = 'exact' | 'syntactic' | 'manifest' | 'observed' | 'derived';

export type ContextGraphFreshness = 'fresh' | 'stale' | 'unknown';

export type ContextGraphRisk = 'low' | 'medium' | 'high' | 'protected';

export type ContextGraphMetadataValue = string | number | boolean | null | string[];

export type ContextGraphMetadata = Record<string, ContextGraphMetadataValue>;

export interface ContextGraphLocator {
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
}

export interface ContextGraphNode {
  id: string;
  kind: ContextGraphNodeKind;
  label: string;
  path?: string;
  locator?: ContextGraphLocator;
  contentHash?: string;
  /** 0..1 */
  trust: number;
  freshness: ContextGraphFreshness;
  risk: ContextGraphRisk;
  tokenCost: number;
  metadata: ContextGraphMetadata;
}

export interface ContextGraphProvenance {
  /** workspace-relative POSIX path; an edge without one is never written to a snapshot */
  path: string;
  line?: number;
  hash: string;
  extractor: string;
}

export interface ContextGraphEdge {
  id: string;
  from: string;
  to: string;
  type: ContextGraphEdgeType;
  confidence: ContextGraphEdgeConfidence;
  provenance: ContextGraphProvenance;
  observedAt: string;
}

export type ContextGraphSkipReason =
  | 'binary'
  | 'oversized'
  | 'unsupported_language'
  | 'symlink_escape'
  | 'unreadable'
  | 'generated'
  | 'cap_reached'
  | 'excluded';

export interface ContextGraphSkip {
  path: string;
  reason: ContextGraphSkipReason;
  detail?: string;
}

export const CONTEXT_GRAPH_LINT_ERROR_CODES = [
  'duplicate_node_conflict',
  'dangling_edge',
  'edge_without_provenance',
  'absolute_or_escaping_path',
  'symlink_escape',
  'secret_like_value',
  'unsupported_node_kind',
  'unsupported_edge_type',
  'non_deterministic_serialization',
  'protected_gate_without_source_relation',
  'manifest_dag_cycle',
  'hash_mismatch',
  'snapshot_meta_mismatch',
  'freshness_claim_mismatch',
  'invalid_node_field',
  'invalid_edge_field'
] as const;

export const CONTEXT_GRAPH_LINT_WARNING_CODES = [
  'orphan_wiki_claim',
  'single_source_low_trust_synthesis',
  'unknown_freshness',
  'high_fan_in_without_verification',
  'unreachable_in_profile',
  'extractor_skipped_input'
] as const;

export type ContextGraphLintErrorCode = (typeof CONTEXT_GRAPH_LINT_ERROR_CODES)[number];
export type ContextGraphLintWarningCode = (typeof CONTEXT_GRAPH_LINT_WARNING_CODES)[number];
export type ContextGraphLintCode = ContextGraphLintErrorCode | ContextGraphLintWarningCode;
export type ContextGraphLintSeverity = 'error' | 'warning';

export interface ContextGraphLintIssue {
  code: ContextGraphLintCode;
  severity: ContextGraphLintSeverity;
  message: string;
  nodeId?: string;
  edgeId?: string;
  path?: string;
  extractor?: string;
}

export interface ContextGraphFragment {
  schema: typeof CONTEXT_GRAPH_FRAGMENT_SCHEMA;
  extractor: string;
  extractorRevision: string;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  issues: ContextGraphLintIssue[];
  skipped: ContextGraphSkip[];
  /** workspace-relative POSIX path -> sha256 of the bytes the fragment was derived from */
  inputHashes: Record<string, string>;
}

export interface ContextGraphExtractionLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxNodes: number;
  maxEdges: number;
  timeoutMs: number;
}

export interface ContextGraphExtractionInput {
  root: string;
  /** `null` means a full extraction; otherwise only these workspace-relative paths plus their reverse closure */
  changedPaths: readonly string[] | null;
  limits: ContextGraphExtractionLimits;
  /** ISO timestamp used for `observedAt`; injected so extraction stays deterministic under test */
  observedAt: string;
}

export interface ContextGraphExtractor {
  readonly id: string;
  readonly revision: string;
  extract(input: ContextGraphExtractionInput): Promise<ContextGraphFragment>;
}

export interface ContextGraphCycle {
  id: string;
  nodes: string[];
}

export interface ContextGraphExtractorStat {
  id: string;
  revision: string;
  nodeCount: number;
  edgeCount: number;
  issueCount: number;
  skippedCount: number;
}

export interface ContextGraphSnapshot {
  schema: typeof CONTEXT_GRAPH_SCHEMA;
  schemaRevision: string;
  snapshotHash: string;
  nodes: ContextGraphNode[];
  edges: ContextGraphEdge[];
  cycles: ContextGraphCycle[];
  extractors: ContextGraphExtractorStat[];
  nodeCount: number;
  edgeCount: number;
}

export type ContextGraphGitState = 'clean' | 'dirty' | 'unknown';

export type ContextGraphStatusCode = 'fresh' | 'stale' | 'missing' | 'corrupt';

export const CONTEXT_GRAPH_STALE_REASONS = [
  'head_changed',
  'dirty_fingerprint_changed',
  'schema_revision_changed',
  'tsconfig_changed',
  'command_manifest_changed',
  'gate_manifest_changed',
  'proof_index_changed',
  'wiki_context_changed',
  'git_state_unknown',
  'source_hash_mismatch',
  'meta_mismatch',
  'cache_key_changed'
] as const;

export type ContextGraphStaleReason = (typeof CONTEXT_GRAPH_STALE_REASONS)[number];

export interface ContextGraphCacheKeyParts {
  workspaceIdentity: string;
  head: string | null;
  gitState: ContextGraphGitState;
  trackedDirtyFingerprint: string;
  untrackedFingerprint: string;
  schemaRevision: string;
  tsconfigHash: string;
  commandManifestHash: string;
  gateManifestHash: string;
  proofIndexHash: string;
  wikiContextHash: string;
}

export interface ContextGraphMeta {
  schema: typeof CONTEXT_GRAPH_META_SCHEMA;
  schemaRevision: string;
  snapshotHash: string;
  previousSnapshotHash: string | null;
  generatedAt: string;
  cacheKey: string;
  cacheKeyParts: ContextGraphCacheKeyParts;
  /** workspace-relative POSIX path -> sha256, used for freshness comparison without a rebuild */
  inputHashes: Record<string, string>;
  nodeCount: number;
  edgeCount: number;
  lint: { ok: boolean; errors: number; warnings: number };
  skipped: ContextGraphSkip[];
  durationMs: number;
}

export interface ContextGraphStatus {
  schema: 'sks.context-graph-status.v1';
  status: ContextGraphStatusCode;
  snapshotHash: string | null;
  generatedAt: string | null;
  reasons: ContextGraphStaleReason[];
  repairCommand: typeof CONTEXT_GRAPH_REPAIR_COMMAND;
  errorCode:
    | typeof CONTEXT_GRAPH_MISSING_ERROR
    | typeof CONTEXT_GRAPH_STALE_ERROR
    | typeof CONTEXT_GRAPH_CORRUPT_ERROR
    | null;
  nodeCount: number;
  edgeCount: number;
}

export interface ContextGraphValidationResult {
  ok: boolean;
  issues: ContextGraphLintIssue[];
}

const NODE_KIND_SET: ReadonlySet<string> = new Set<string>(CONTEXT_GRAPH_NODE_KINDS);
const EDGE_TYPE_SET: ReadonlySet<string> = new Set<string>(CONTEXT_GRAPH_EDGE_TYPES);
const EDGE_CONFIDENCE_SET: ReadonlySet<string> = new Set(['exact', 'syntactic', 'manifest', 'observed', 'derived']);
const FRESHNESS_SET: ReadonlySet<string> = new Set(['fresh', 'stale', 'unknown']);
const RISK_SET: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'protected']);

export function isContextGraphNodeKind(value: unknown): value is ContextGraphNodeKind {
  return typeof value === 'string' && NODE_KIND_SET.has(value);
}

export function isContextGraphEdgeType(value: unknown): value is ContextGraphEdgeType {
  return typeof value === 'string' && EDGE_TYPE_SET.has(value);
}

export function lintError(code: ContextGraphLintErrorCode, message: string, extra: Partial<ContextGraphLintIssue> = {}): ContextGraphLintIssue {
  return { ...extra, code, severity: 'error', message };
}

export function lintWarning(code: ContextGraphLintWarningCode, message: string, extra: Partial<ContextGraphLintIssue> = {}): ContextGraphLintIssue {
  return { ...extra, code, severity: 'warning', message };
}

export function emptyContextGraphFragment(extractor: string, revision: string): ContextGraphFragment {
  return {
    schema: CONTEXT_GRAPH_FRAGMENT_SCHEMA,
    extractor,
    extractorRevision: revision,
    nodes: [],
    edges: [],
    issues: [],
    skipped: [],
    inputHashes: {}
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function validateNode(value: unknown, index: number, issues: ContextGraphLintIssue[]): string | null {
  const node = record(value);
  if (!node) {
    issues.push(lintError('invalid_node_field', `node[${index}] is not an object`));
    return null;
  }
  const id = typeof node.id === 'string' ? node.id : '';
  if (!id) {
    issues.push(lintError('invalid_node_field', `node[${index}] has no id`));
    return null;
  }
  if (!isContextGraphNodeKind(node.kind)) {
    issues.push(lintError('unsupported_node_kind', `node ${id} has unsupported kind`, { nodeId: id }));
  }
  if (typeof node.label !== 'string' || !node.label) {
    issues.push(lintError('invalid_node_field', `node ${id} has no label`, { nodeId: id }));
  }
  if (typeof node.trust !== 'number' || node.trust < 0 || node.trust > 1) {
    issues.push(lintError('invalid_node_field', `node ${id} trust must be 0..1`, { nodeId: id }));
  }
  if (!FRESHNESS_SET.has(String(node.freshness))) {
    issues.push(lintError('invalid_node_field', `node ${id} has invalid freshness`, { nodeId: id }));
  }
  if (!RISK_SET.has(String(node.risk))) {
    issues.push(lintError('invalid_node_field', `node ${id} has invalid risk`, { nodeId: id }));
  }
  if (typeof node.tokenCost !== 'number' || node.tokenCost < 0) {
    issues.push(lintError('invalid_node_field', `node ${id} tokenCost must be >= 0`, { nodeId: id }));
  }
  if (!record(node.metadata)) {
    issues.push(lintError('invalid_node_field', `node ${id} metadata must be an object`, { nodeId: id }));
  }
  return id;
}

function validateEdge(value: unknown, index: number, nodeIds: ReadonlySet<string>, issues: ContextGraphLintIssue[]): void {
  const edge = record(value);
  if (!edge) {
    issues.push(lintError('invalid_edge_field', `edge[${index}] is not an object`));
    return;
  }
  const id = typeof edge.id === 'string' ? edge.id : '';
  if (!id) {
    issues.push(lintError('invalid_edge_field', `edge[${index}] has no id`));
    return;
  }
  if (!isContextGraphEdgeType(edge.type)) {
    issues.push(lintError('unsupported_edge_type', `edge ${id} has unsupported type`, { edgeId: id }));
  }
  if (!EDGE_CONFIDENCE_SET.has(String(edge.confidence))) {
    issues.push(lintError('invalid_edge_field', `edge ${id} has invalid confidence`, { edgeId: id }));
  }
  const from = typeof edge.from === 'string' ? edge.from : '';
  const to = typeof edge.to === 'string' ? edge.to : '';
  if (!from || !nodeIds.has(from)) {
    issues.push(lintError('dangling_edge', `edge ${id} has no resolvable from node`, { edgeId: id }));
  }
  if (!to || !nodeIds.has(to)) {
    issues.push(lintError('dangling_edge', `edge ${id} has no resolvable to node`, { edgeId: id }));
  }
  const provenance = record(edge.provenance);
  if (!provenance || typeof provenance.path !== 'string' || !provenance.path || typeof provenance.hash !== 'string' || !provenance.hash) {
    issues.push(lintError('edge_without_provenance', `edge ${id} has no usable provenance`, { edgeId: id }));
  }
  if (typeof edge.observedAt !== 'string' || !edge.observedAt) {
    issues.push(lintError('invalid_edge_field', `edge ${id} has no observedAt`, { edgeId: id }));
  }
}

/**
 * Structural validation of a decoded snapshot. Path safety, secret redaction,
 * determinism, and freshness parity live in the lint package because they need
 * the workspace on disk; this stays pure so any worker can call it.
 */
export function validateContextGraphSnapshot(value: unknown): ContextGraphValidationResult {
  const issues: ContextGraphLintIssue[] = [];
  const snapshot = record(value);
  if (!snapshot) {
    issues.push(lintError('invalid_node_field', 'snapshot is not an object'));
    return { ok: false, issues };
  }
  if (snapshot.schema !== CONTEXT_GRAPH_SCHEMA) {
    issues.push(lintError('snapshot_meta_mismatch', `snapshot schema must be ${CONTEXT_GRAPH_SCHEMA}`));
  }
  if (typeof snapshot.snapshotHash !== 'string' || !snapshot.snapshotHash) {
    issues.push(lintError('hash_mismatch', 'snapshot has no snapshotHash'));
  }
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes : null;
  const edges = Array.isArray(snapshot.edges) ? snapshot.edges : null;
  if (!nodes || !edges) {
    issues.push(lintError('invalid_node_field', 'snapshot must carry nodes and edges arrays'));
    return { ok: false, issues };
  }
  const nodeIds = new Set<string>();
  let previousNodeId: string | null = null;
  for (const [index, raw] of nodes.entries()) {
    const id = validateNode(raw, index, issues);
    if (!id) continue;
    if (nodeIds.has(id)) issues.push(lintError('duplicate_node_conflict', `duplicate node id ${id}`, { nodeId: id }));
    nodeIds.add(id);
    if (previousNodeId !== null && previousNodeId.localeCompare(id) > 0) {
      issues.push(lintError('non_deterministic_serialization', `nodes are not sorted by id at ${id}`, { nodeId: id }));
    }
    previousNodeId = id;
  }
  let previousEdgeId: string | null = null;
  for (const [index, raw] of edges.entries()) {
    validateEdge(raw, index, nodeIds, issues);
    const edgeId = record(raw)?.id;
    if (typeof edgeId !== 'string') continue;
    if (previousEdgeId !== null && previousEdgeId.localeCompare(edgeId) > 0) {
      issues.push(lintError('non_deterministic_serialization', `edges are not sorted by id at ${edgeId}`, { edgeId }));
    }
    previousEdgeId = edgeId;
  }
  if (snapshot.nodeCount !== nodes.length || snapshot.edgeCount !== edges.length) {
    issues.push(lintError('snapshot_meta_mismatch', 'snapshot counts do not match the serialized arrays'));
  }
  return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
}
