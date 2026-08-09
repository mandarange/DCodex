/**
 * Architecture Map domain contracts (WO §7 / §14).
 * Facts stay in ContextGraphSnapshot; this package analyzes and projects them.
 */
import type { ContextGraphEdge, ContextGraphNode, ContextGraphSnapshot } from '../contracts.js';

export const ARCHITECTURE_INPUT_BUNDLE_SCHEMA = 'sks.architecture-input-bundle.v1' as const;
export const ARCHITECTURE_BASELINE_SCHEMA = 'sks.architecture-baseline.v1' as const;
export const ARCHITECTURE_REVIEW_SCHEMA = 'sks.architecture-review.v1' as const;
export const ARCHITECTURE_MAP_MANIFEST_SCHEMA = 'sks.architecture-map-manifest.v1' as const;
export const ARCHITECTURE_MAP_POLICY_SCHEMA = 'sks.architecture-map-policy.v1' as const;
export const MERMAID_PROJECTION_SCHEMA = 'sks.mermaid-projection.v1' as const;

export const ARCHITECTURE_ANALYZER_VERSION = 'architecture-map-analyzer.v1' as const;
export const ARCHITECTURE_SERIALIZER_VERSION = 'mermaid-serializer.v1' as const;

export const ARCHITECTURE_MAP_DIR_REL = '.sneakoscope/wiki/architecture-map' as const;
export const ARCHITECTURE_MAP_POLICY_FILE = 'config/architecture-map-policy.v1.json' as const;

/** All Architecture Map Mermaid view ids (WO §12), including mission-only views. */
export const ARCHITECTURE_MAP_VIEW_IDS = Object.freeze([
  'project-topology',
  'module-dependency',
  'public-surface',
  'ssot-provenance',
  'runtime-control',
  'verification-coverage',
  'risk-domains',
  'change-impact',
  'architecture-delta',
  'ownership-workstream'
] as const);

/** Global atlas views only (WO §4.1) — excludes mission-only helpers. */
export const GLOBAL_ARCHITECTURE_MAP_VIEW_IDS = Object.freeze([
  'project-topology',
  'module-dependency',
  'public-surface',
  'ssot-provenance',
  'runtime-control',
  'verification-coverage',
  'risk-domains'
] as const);

export type ArchitectureMapViewId = (typeof ARCHITECTURE_MAP_VIEW_IDS)[number];
export type GlobalArchitectureMapViewId = (typeof GLOBAL_ARCHITECTURE_MAP_VIEW_IDS)[number];

export type ArchitectureSourceKind =
  | 'context_graph'
  | 'topology_overlay'
  | 'ssot_inventory'
  | 'voxel_context'
  | 'worktree_fingerprint';

export type ArchitectureMapProfile =
  | 'global'
  | 'planning'
  | 'implementation'
  | 'review'
  | 'protected';

/** Profile budget shape used by Mermaid reduce (mirrors policy profiles). */
export interface ArchitectureProfileBudget {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxLabelChars: number;
  readonly tokenBudget: number;
}

export type ArchitectureFindingSeverity = 'blocking' | 'warning' | 'info';

export type ArchitectureFindingCode =
  | 'baseline_missing'
  | 'baseline_late'
  | 'baseline_stale'
  | 'baseline_tampered'
  | 'graph_stale'
  | 'map_parity_failure'
  | 'unaccounted_changed_file'
  | 'new_cycle'
  | 'cycle_expansion'
  | 'forbidden_dependency'
  | 'layer_skip'
  | 'ssot_collision'
  | 'authority_bypass'
  | 'protected_verification_gap'
  | 'fan_out_regression'
  | 'fan_in_unverified'
  | 'passthrough_chain'
  | 'redundant_parallel_path'
  | 'duplicate_facade'
  | 'orphan_entrypoint'
  | 'unowned_high_risk'
  | 'test_distance_increase'
  | 'architecture_depth_increase'
  | 'cross_workstream_write_overlap'
  | 'unknown_dynamic_relation'
  | 'insufficient_graph';

export const ARCHITECTURE_FINDING_CODES: readonly ArchitectureFindingCode[] = Object.freeze([
  'baseline_missing',
  'baseline_late',
  'baseline_stale',
  'baseline_tampered',
  'graph_stale',
  'map_parity_failure',
  'unaccounted_changed_file',
  'new_cycle',
  'cycle_expansion',
  'forbidden_dependency',
  'layer_skip',
  'ssot_collision',
  'authority_bypass',
  'protected_verification_gap',
  'fan_out_regression',
  'fan_in_unverified',
  'passthrough_chain',
  'redundant_parallel_path',
  'duplicate_facade',
  'orphan_entrypoint',
  'unowned_high_risk',
  'test_distance_increase',
  'architecture_depth_increase',
  'cross_workstream_write_overlap',
  'unknown_dynamic_relation',
  'insufficient_graph'
]);

export interface ArchitectureExtractionIssue {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
}

export interface TopologyOverlay {
  readonly nodes: ReadonlyArray<ContextGraphNode>;
  readonly edges: ReadonlyArray<ContextGraphEdge>;
  readonly sourceManifestHashes: Readonly<Record<string, string>>;
  readonly extractionErrors: ReadonlyArray<ArchitectureExtractionIssue>;
}

export interface VoxelArchitectureContext {
  readonly provider: string;
  readonly version: string;
  readonly seedNodeIds: readonly string[];
  readonly seedPaths: readonly string[];
  readonly riskDomains: readonly string[];
  readonly profile: ArchitectureMapProfile;
  readonly workstreamHints: readonly string[];
  readonly tokenBudgetHint: number | null;
  readonly protectedAreaIds: readonly string[];
}

export interface WorktreePathFingerprint {
  readonly path: string;
  readonly kind: 'file' | 'symlink' | 'missing';
  readonly sha256: string | null;
  readonly size: number | null;
  readonly executable: boolean | null;
}

export interface WorktreeFingerprint {
  readonly rootId: string;
  readonly head: string | null;
  /** Alias used by baseline seal (`repositoryHead`). */
  readonly repositoryHead: string | null;
  readonly paths: readonly WorktreePathFingerprint[];
  readonly fingerprintHash: string;
  /** Alias used by baseline seal (`worktreeFingerprintHash` source). */
  readonly hash: string;
  readonly dirtyPaths: readonly string[];
}

export interface ArchitectureInputBundleV1 {
  readonly schema: typeof ARCHITECTURE_INPUT_BUNDLE_SCHEMA;
  readonly rootId: string;
  readonly graph: ContextGraphSnapshot;
  readonly graphHash: string;
  readonly topology: Readonly<TopologyOverlay>;
  readonly topologyHash: string;
  readonly ssotInventory: ReadonlyArray<{ readonly id: string }>;
  readonly ssotInventoryHash: string;
  readonly voxelContext: Readonly<VoxelArchitectureContext>;
  readonly voxelContextHash: string;
  readonly worktree: Readonly<WorktreeFingerprint>;
  readonly policyHash: string;
  readonly analyzerVersion: string;
  readonly serializerVersion: string;
  readonly generatedAt: string;
  readonly canonicalHash: string;
}

export interface ArchitectureFinding {
  readonly id: string;
  readonly code: ArchitectureFindingCode;
  readonly severity: ArchitectureFindingSeverity;
  readonly subjectIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly ruleId: string;
  readonly message: string;
  readonly disposition?: 'open' | 'accepted_exception';
}

export interface ArchitectureMetricsV1 {
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly moduleCount: number;
  readonly publicSurfaceCount: number;
  readonly sccCount: number;
  readonly cyclicNodeCount: number;
  readonly largestSccSize: number;
  readonly maxFanIn: number;
  readonly maxFanOut: number;
  readonly p95FanIn: number;
  readonly p95FanOut: number;
  readonly layerViolationCount: number;
  readonly ssotCollisionCount: number;
  readonly authorityBypassCount: number;
  readonly protectedVerificationGapCount: number;
  readonly passthroughChainCount: number;
  readonly duplicateFacadeCount: number;
  readonly orphanEntrypointCount: number;
  readonly averageArchitectureDepth: number | null;
  readonly maxArchitectureDepth: number | null;
  readonly changedPathAccounting: number | null;
  readonly projectionAccounting: number | null;
  readonly eligibleExtractionSuccess: number | null;
  readonly unknownDynamicRelationCount: number;
}

export interface ArchitectureScope {
  readonly profile: ArchitectureMapProfile;
  readonly seedNodeIds: readonly string[];
  readonly seedPaths: readonly string[];
  readonly selectionRuleVersion: string;
}

export interface ArchitectureBaselineV1 {
  readonly schema: typeof ARCHITECTURE_BASELINE_SCHEMA;
  readonly missionId: string;
  readonly routeId: string;
  readonly taskProfile: string;
  readonly required: true;
  readonly capturedAt: string;
  readonly capturedBeforeMutation: true;
  readonly repositoryHead: string | null;
  readonly worktreeFingerprintHash: string;
  readonly preexistingDirtyPaths: readonly string[];
  readonly graphHash: string;
  readonly topologyHash: string;
  readonly ssotInventoryHash: string;
  readonly voxelContextHash: string;
  readonly policyHash: string;
  readonly analyzerVersion: string;
  readonly serializerVersion: string;
  readonly scope: ArchitectureScope;
  readonly metrics: ArchitectureMetricsV1;
  readonly findings: readonly ArchitectureFinding[];
  readonly viewHashes: Readonly<Record<string, string>>;
  readonly canonicalPayloadHash: string;
  readonly seal: string;
}

export interface ChangedPathRecord {
  readonly path: string;
  readonly change: 'added' | 'removed' | 'content' | 'type' | 'mode';
}

export interface ArchitectureMetricDelta {
  readonly sccCountDelta: number;
  readonly cyclicNodeCountDelta: number;
  readonly layerViolationCountDelta: number;
  readonly ssotCollisionCountDelta: number;
  readonly protectedVerificationGapCountDelta: number;
}

export interface ArchitectureDeltaV1 {
  readonly schema: 'sks.architecture-delta.v1';
  readonly missionId: string;
  readonly baselineSeal: string;
  readonly addedNodeIds: readonly string[];
  readonly removedNodeIds: readonly string[];
  readonly addedEdgeIds: readonly string[];
  readonly removedEdgeIds: readonly string[];
  readonly newFindings: readonly ArchitectureFinding[];
  readonly resolvedFindings: readonly ArchitectureFinding[];
  readonly metricDelta: ArchitectureMetricDelta;
}

export interface ArchitectureCapsuleV1 {
  readonly schema: 'sks.architecture-capsule.v1';
  readonly text: string;
  readonly byteLength: number;
  readonly profile: ArchitectureMapProfile;
  readonly contentHash: string;
}

export interface AppliedArchitectureException {
  readonly findingId: string;
  readonly exceptionId: string;
  readonly owner: string;
  readonly reason: string;
}

export interface ProjectionAccountingSummary {
  readonly selectedNodeCount: number;
  readonly emittedNodeCount: number;
  readonly omittedNodeCount: number;
  readonly selectedEdgeCount: number;
  readonly emittedEdgeCount: number;
  readonly omittedEdgeCount: number;
  readonly accountingRatio: number;
}

export interface ArchitectureReviewVerification {
  readonly baselineValid: boolean;
  readonly baselineTimely: boolean;
  readonly baselineFresh: boolean;
  readonly sealValid: boolean;
  readonly changedPathAccounting: number;
  readonly projectionAccounting: number;
  readonly blockers: readonly string[];
}

export interface ArchitectureReviewV1 {
  readonly schema: typeof ARCHITECTURE_REVIEW_SCHEMA;
  readonly missionId: string;
  readonly baselineSeal: string;
  readonly baselineHash: string;
  readonly afterInputHash: string;
  readonly changedPaths: readonly ChangedPathRecord[];
  readonly accountedChangedPaths: readonly string[];
  readonly unaccountedChangedPaths: readonly string[];
  readonly beforeMetrics: ArchitectureMetricsV1;
  readonly afterMetrics: ArchitectureMetricsV1;
  readonly metricDelta: ArchitectureMetricDelta;
  readonly newFindings: readonly ArchitectureFinding[];
  readonly resolvedFindings: readonly ArchitectureFinding[];
  readonly persistentFindings: readonly ArchitectureFinding[];
  readonly acceptedExceptions: readonly string[];
  readonly projectionAccounting: Readonly<Record<string, unknown>> | ProjectionAccountingSummary;
  readonly verification: ArchitectureReviewVerification;
  readonly verdict: 'pass' | 'block';
  readonly blockingFindingIds: readonly string[];
  readonly canonicalPayloadHash: string;
  readonly generatedAt: string;
}

/** Code-point order — never localeCompare. */
export function byCodePoint(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

export function sortStrings(values: readonly string[]): string[] {
  return [...values].sort(byCodePoint);
}
