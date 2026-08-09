/**
 * Architecture Map Mermaid projection package.
 */
import {
  GLOBAL_ARCHITECTURE_MAP_VIEW_IDS,
  type ArchitectureFinding,
  type ArchitectureMapViewId,
  type ArchitectureMetricsV1,
  type GlobalArchitectureMapViewId
} from '../../architecture/contracts.js';
import { analyzeArchitectureFindings } from '../../architecture/findings.js';
import { buildArchitectureInputBundle, policyContentHash } from '../../architecture/input-bundle.js';
import { computeArchitectureMetrics } from '../../architecture/metrics.js';
import type { ArchitectureMapPolicy } from '../../architecture/policy.js';
import { mergeGraphWithTopology } from '../../architecture/topology-overlay.js';
import type { ContextGraphSnapshot } from '../../contracts.js';
import type { MermaidProjectionV1 } from './contracts.js';
import { buildArchitectureMapManifest, type ArchitectureMapManifestV1 } from './manifest.js';
import { buildModuleDependencyView } from './module-dependency.js';
import { buildProjectTopologyView } from './project-topology.js';
import { buildPublicSurfaceView } from './public-surface.js';
import { buildRiskDomainsView } from './risk-domains.js';
import { buildRuntimeControlView } from './runtime-control.js';
import { buildSsotProvenanceView } from './ssot-provenance.js';
import { buildVerificationCoverageView } from './verification-coverage.js';
import { viewSpecFor } from './view-specs.js';

export * from './contracts.js';
export * from './ast.js';
export * from './ids.js';
export * from './escape.js';
export * from './serializer.js';
export * from './selection-ledger.js';
export * from './reduce.js';
export * from './view-specs.js';
export * from './view-builder.js';
export * from './view-builder-common.js';
export * from './project-topology.js';
export * from './module-dependency.js';
export * from './public-surface.js';
export * from './ssot-provenance.js';
export * from './runtime-control.js';
export * from './verification-coverage.js';
export * from './risk-domains.js';
export * from './change-impact.js';
export * from './architecture-delta.js';
export * from './ownership-workstream.js';
export * from './manifest.js';

export interface ArchitectureMapViewArtifact {
  readonly viewId: GlobalArchitectureMapViewId;
  readonly filename: string;
  readonly text: string;
  readonly projection: MermaidProjectionV1;
}

export interface ArchitectureMapViewsResult {
  readonly views: readonly ArchitectureMapViewArtifact[];
  readonly manifest: ArchitectureMapManifestV1;
  readonly metrics: ArchitectureMetricsV1;
  readonly findings: readonly ArchitectureFinding[];
}

type GlobalBuilder = (input: {
  snapshot: ContextGraphSnapshot;
  policy: ArchitectureMapPolicy;
}) => MermaidProjectionV1 & { readonly text: string };

const GLOBAL_BUILDERS: Record<GlobalArchitectureMapViewId, GlobalBuilder> = {
  'project-topology': buildProjectTopologyView,
  'module-dependency': buildModuleDependencyView,
  'public-surface': buildPublicSurfaceView,
  'ssot-provenance': buildSsotProvenanceView,
  'runtime-control': buildRuntimeControlView,
  'verification-coverage': buildVerificationCoverageView,
  'risk-domains': buildRiskDomainsView
};

function asProjection(built: MermaidProjectionV1 & { readonly text: string }): MermaidProjectionV1 {
  return Object.freeze({
    schema: built.schema,
    viewId: built.viewId,
    direction: built.direction,
    title: built.title,
    source: built.source,
    accounting: built.accounting,
    contentHash: built.contentHash,
    byteLength: built.byteLength
  });
}

/**
 * Build the 7 global Architecture Map Mermaid views + manifest, metrics, findings.
 */
export function buildArchitectureMapViews(
  snapshot: ContextGraphSnapshot,
  policy: ArchitectureMapPolicy,
  options: {
    rootId?: string;
    missionId?: string | null;
  } = {}
): ArchitectureMapViewsResult {
  const rootId = options.rootId ?? 'workspace';
  const bundle = buildArchitectureInputBundle({
    rootId,
    graph: snapshot,
    policy,
    topologyMode: 'from-snapshot'
  });
  const merged = mergeGraphWithTopology(bundle.graph, bundle.topology);
  const workingSnapshot: ContextGraphSnapshot = {
    ...snapshot,
    nodes: [...merged.nodes],
    edges: [...merged.edges],
    nodeCount: merged.nodes.length,
    edgeCount: merged.edges.length
  };

  const views: ArchitectureMapViewArtifact[] = [];
  for (const viewId of GLOBAL_ARCHITECTURE_MAP_VIEW_IDS) {
    const built = GLOBAL_BUILDERS[viewId]({ snapshot: workingSnapshot, policy });
    const spec = viewSpecFor(viewId as ArchitectureMapViewId);
    views.push(
      Object.freeze({
        viewId,
        filename: spec.filename,
        text: built.text,
        projection: asProjection(built)
      })
    );
  }

  const manifest = buildArchitectureMapManifest({
    views: views.map((view) => ({
      viewId: view.viewId,
      projection: view.projection,
      text: view.text
    })),
    graphHash: bundle.graphHash,
    policyHash: bundle.policyHash.length ? bundle.policyHash : policyContentHash(policy),
    topologyHash: bundle.topologyHash,
    inputBundleHash: bundle.canonicalHash,
    analyzerVersion: bundle.analyzerVersion,
    serializerVersion: bundle.serializerVersion,
    missionId: options.missionId ?? null
  });

  const findings = analyzeArchitectureFindings({ bundle, policy });
  const metrics = computeArchitectureMetrics({
    graph: workingSnapshot,
    topology: bundle.topology,
    layerViolationCount: findings.filter((finding) => finding.code === 'forbidden_dependency').length,
    ssotCollisionCount: findings.filter((finding) => finding.code === 'ssot_collision').length,
    authorityBypassCount: findings.filter((finding) => finding.code === 'authority_bypass').length,
    protectedVerificationGapCount: findings.filter(
      (finding) => finding.code === 'protected_verification_gap'
    ).length
  });

  return Object.freeze({
    views: Object.freeze(views),
    manifest,
    metrics,
    findings
  });
}
