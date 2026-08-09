/**
 * Mission architecture-map-baseline.json seal (WO §14.2).
 */
import { sha256 } from '../../../fsx.js';
import {
  ARCHITECTURE_BASELINE_SCHEMA,
  type ArchitectureBaselineV1,
  type ArchitectureFinding,
  type ArchitectureInputBundleV1,
  type ArchitectureMetricsV1,
  type ArchitectureScope
} from './contracts.js';
import { hashCanonical } from './fingerprint.js';
import { analyzeArchitectureFindings } from './findings.js';
import { computeArchitectureMetrics, computeSccs, buildModuleDependencyGraph } from './metrics.js';
import type { ArchitectureMapPolicy } from './policy.js';
import { mergeGraphWithTopology } from './topology-overlay.js';

export function sealArchitectureBaseline(canonicalPayloadHash: string): string {
  return sha256(`${ARCHITECTURE_BASELINE_SCHEMA}\n${canonicalPayloadHash}`);
}

export function buildArchitectureBaseline(input: {
  missionId: string;
  routeId: string;
  taskProfile: string;
  capturedAt: string;
  bundle: ArchitectureInputBundleV1;
  policy: ArchitectureMapPolicy;
  scope: ArchitectureScope;
  viewHashes?: Readonly<Record<string, string>>;
  findings?: readonly ArchitectureFinding[];
  metrics?: ArchitectureMetricsV1;
}): ArchitectureBaselineV1 {
  const merged = mergeGraphWithTopology(input.bundle.graph, input.bundle.topology);
  const moduleGraph = buildModuleDependencyGraph(merged.nodes, merged.edges);
  const sccs = computeSccs(moduleGraph);
  const findings = input.findings ?? analyzeArchitectureFindings({
    bundle: input.bundle,
    policy: input.policy,
    baselineSccs: []
  });
  const metrics = input.metrics ?? computeArchitectureMetrics({
    graph: input.bundle.graph,
    topology: input.bundle.topology,
    layerViolationCount: findings.filter((finding) => finding.code === 'forbidden_dependency').length,
    ssotCollisionCount: findings.filter((finding) => finding.code === 'ssot_collision').length,
    authorityBypassCount: findings.filter((finding) => finding.code === 'authority_bypass').length,
    protectedVerificationGapCount: findings.filter((finding) => finding.code === 'protected_verification_gap').length
  });
  const viewHashes = Object.freeze({ ...(input.viewHashes ?? {}) });
  const payload = {
    schema: ARCHITECTURE_BASELINE_SCHEMA,
    missionId: input.missionId,
    routeId: input.routeId,
    taskProfile: input.taskProfile,
    required: true as const,
    capturedBeforeMutation: true as const,
    repositoryHead: input.bundle.worktree.repositoryHead,
    worktreeFingerprintHash: input.bundle.worktree.hash,
    preexistingDirtyPaths: input.bundle.worktree.dirtyPaths,
    graphHash: input.bundle.graphHash,
    topologyHash: input.bundle.topologyHash,
    ssotInventoryHash: input.bundle.ssotInventoryHash,
    voxelContextHash: input.bundle.voxelContextHash,
    policyHash: input.bundle.policyHash,
    analyzerVersion: input.bundle.analyzerVersion,
    serializerVersion: input.bundle.serializerVersion,
    scope: input.scope,
    metrics,
    findings,
    viewHashes,
    // capturedAt intentionally excluded from seal payload (WO: no timestamp in ID/seal inputs beyond explicit fields)
    sccKeys: sccs.map((members) => members.join('|'))
  };
  const canonicalPayloadHash = hashCanonical(payload);
  const seal = sealArchitectureBaseline(canonicalPayloadHash);
  return Object.freeze({
    schema: ARCHITECTURE_BASELINE_SCHEMA,
    missionId: input.missionId,
    routeId: input.routeId,
    taskProfile: input.taskProfile,
    required: true,
    capturedAt: input.capturedAt,
    capturedBeforeMutation: true,
    repositoryHead: input.bundle.worktree.repositoryHead,
    worktreeFingerprintHash: input.bundle.worktree.hash,
    preexistingDirtyPaths: Object.freeze([...input.bundle.worktree.dirtyPaths]),
    graphHash: input.bundle.graphHash,
    topologyHash: input.bundle.topologyHash,
    ssotInventoryHash: input.bundle.ssotInventoryHash,
    voxelContextHash: input.bundle.voxelContextHash,
    policyHash: input.bundle.policyHash,
    analyzerVersion: input.bundle.analyzerVersion,
    serializerVersion: input.bundle.serializerVersion,
    scope: input.scope,
    metrics,
    findings: Object.freeze([...findings]),
    viewHashes,
    canonicalPayloadHash,
    seal
  });
}

export function verifyArchitectureBaselineSeal(baseline: ArchitectureBaselineV1): boolean {
  return baseline.seal === sealArchitectureBaseline(baseline.canonicalPayloadHash);
}
