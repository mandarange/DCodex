/**
 * Mission orchestration for Architecture Map baseline / after-review artifacts.
 */
import { sha256 } from './fsx.js';
import {
  ARCHITECTURE_BASELINE_SCHEMA,
  ARCHITECTURE_MAP_MANIFEST_SCHEMA,
  ARCHITECTURE_REVIEW_SCHEMA,
  type ArchitectureBaselineV1,
  type ArchitectureCapsuleV1,
  type ArchitectureDeltaV1,
  type ArchitectureInputBundleV1,
  type ArchitectureMapProfile,
  type ArchitectureReviewV1,
  type ArchitectureScope
} from './triwiki/context-graph/architecture/contracts.js';
import { buildArchitectureBaseline, verifyArchitectureBaselineSeal } from './triwiki/context-graph/architecture/baseline.js';
import { renderArchitectureCapsule } from './triwiki/context-graph/architecture/capsule.js';
import { buildArchitectureDelta, buildArchitectureReview } from './triwiki/context-graph/architecture/delta.js';
import { buildArchitectureInputBundle, policyContentHash } from './triwiki/context-graph/architecture/input-bundle.js';
import type { ArchitectureMapPolicy } from './triwiki/context-graph/architecture/policy.js';
import { loadArchitectureMapPolicy } from './triwiki/context-graph/architecture/policy.js';
import { buildArchitectureScope } from './triwiki/context-graph/architecture/slice.js';
import {
  validateArchitectureBaseline,
  validateArchitectureInputBundle,
  validateArchitectureMapManifest,
  validateArchitectureReview
} from './triwiki/context-graph/architecture/validation.js';
import type { ContextGraphSnapshot } from './triwiki/context-graph/contracts.js';
import {
  buildArchitectureMapManifest,
  buildArchitectureMapViews,
  type ArchitectureMapManifestV1
} from './triwiki/context-graph/projections/mermaid/index.js';

export const ARCHITECTURE_MAP_BASELINE_ARTIFACT = 'architecture-map-baseline.json';
export const ARCHITECTURE_MAP_REVIEW_ARTIFACT = 'architecture-map-review.json';
export const ARCHITECTURE_CAPSULE_ARTIFACT = 'architecture-capsule.txt';
export const ARCHITECTURE_MAP_MANIFEST_ARTIFACT = 'architecture-map-manifest.json';

export const ARCHITECTURE_MAP_REVIEW_SCHEMA = ARCHITECTURE_REVIEW_SCHEMA;
export const ARCHITECTURE_MAP_BASELINE_SCHEMA = ARCHITECTURE_BASELINE_SCHEMA;
export const ARCHITECTURE_MAP_MANIFEST_SCHEMA_ID = ARCHITECTURE_MAP_MANIFEST_SCHEMA;

export interface SealArchitectureMapBaselineInput {
  readonly missionId: string;
  readonly routeId: string;
  readonly rootId?: string;
  readonly snapshot: ContextGraphSnapshot;
  readonly policy?: ArchitectureMapPolicy;
  readonly policyRoot?: string;
  readonly profile?: ArchitectureMapProfile;
  readonly seedNodeIds?: readonly string[];
  readonly seedPaths?: readonly string[];
  readonly capturedAt: string;
  readonly taskProfile?: string;
}

export interface SealArchitectureMapBaselineResult {
  readonly baseline: ArchitectureBaselineV1;
  readonly bundle: ArchitectureInputBundleV1;
  readonly manifest: ArchitectureMapManifestV1;
  readonly capsule: ArchitectureCapsuleV1;
  readonly policy: ArchitectureMapPolicy;
}

export function resolveArchitectureMapPolicy(input: {
  policy?: ArchitectureMapPolicy;
  policyRoot?: string;
}): ArchitectureMapPolicy {
  if (input.policy) return input.policy;
  if (input.policyRoot) return loadArchitectureMapPolicy(input.policyRoot);
  throw new Error('architecture_map_policy_required');
}

/**
 * Seal mission architecture-map-baseline.json before mutation.
 */
export function sealBaseline(input: SealArchitectureMapBaselineInput): SealArchitectureMapBaselineResult {
  const policy = resolveArchitectureMapPolicy(input);
  const rootId = input.rootId ?? 'workspace';
  const profile = input.profile ?? 'global';
  const bundle = buildArchitectureInputBundle({
    rootId,
    graph: input.snapshot,
    policy,
    profile
  });
  const views = buildArchitectureMapViews(input.snapshot, policy, {
    rootId,
    missionId: input.missionId
  });
  const viewHashes = Object.freeze(
    Object.fromEntries(views.views.map((view) => [view.viewId, view.projection.contentHash]))
  );
  const scope: ArchitectureScope = buildArchitectureScope({
    profile,
    ...(input.seedNodeIds ? { seedNodeIds: input.seedNodeIds } : {}),
    ...(input.seedPaths ? { seedPaths: input.seedPaths } : {})
  });
  const baseline = buildArchitectureBaseline({
    missionId: input.missionId,
    routeId: input.routeId,
    taskProfile: input.taskProfile ?? profile,
    capturedAt: input.capturedAt,
    bundle,
    policy,
    scope,
    viewHashes,
    findings: views.findings,
    metrics: views.metrics
  });
  const capsule = renderArchitectureCapsule({
    profile,
    missionId: input.missionId,
    routeId: input.routeId,
    baseline,
    metrics: views.metrics,
    findings: views.findings,
    ...(input.seedPaths ? { seedPaths: input.seedPaths } : {}),
    mapArtifact: ARCHITECTURE_MAP_MANIFEST_ARTIFACT
  });
  return Object.freeze({
    baseline,
    bundle,
    manifest: views.manifest,
    capsule,
    policy
  });
}

export interface BuildAfterArchitectureMapReviewInput {
  readonly missionId: string;
  readonly routeId?: string;
  readonly rootId?: string;
  readonly baseline: ArchitectureBaselineV1;
  readonly afterSnapshot: ContextGraphSnapshot;
  readonly policy?: ArchitectureMapPolicy;
  readonly policyRoot?: string;
  readonly generatedAt: string;
  readonly accountedChangedPaths?: readonly string[];
  readonly profile?: ArchitectureMapProfile;
}

export interface BuildAfterArchitectureMapReviewResult {
  readonly review: ArchitectureReviewV1;
  readonly delta: ArchitectureDeltaV1;
  readonly afterBundle: ArchitectureInputBundleV1;
  readonly manifest: ArchitectureMapManifestV1;
  readonly capsule: ArchitectureCapsuleV1;
  readonly policy: ArchitectureMapPolicy;
}

/**
 * Build architecture-map-review.json (+ delta/capsule/manifest) after mutation.
 */
export function buildAfterReview(
  input: BuildAfterArchitectureMapReviewInput
): BuildAfterArchitectureMapReviewResult {
  const policy = resolveArchitectureMapPolicy(input);
  const rootId = input.rootId ?? 'workspace';
  const profile = input.profile ?? input.baseline.scope.profile;
  const afterBundle = buildArchitectureInputBundle({
    rootId,
    graph: input.afterSnapshot,
    policy,
    profile,
    policyHash: policyContentHash(policy)
  });
  const views = buildArchitectureMapViews(input.afterSnapshot, policy, {
    rootId,
    missionId: input.missionId
  });
  const projectionAccounting = Object.freeze(
    Object.fromEntries(
      views.views.map((view) => [
        view.viewId,
        {
          selectedNodeCount: view.projection.accounting.selectedNodeIds.length,
          emittedNodeCount: view.projection.accounting.emittedNodeIds.length,
          omittedNodeCount: view.projection.accounting.omittedNodes.length,
          selectedEdgeCount: view.projection.accounting.selectedEdgeIds.length,
          emittedEdgeCount: view.projection.accounting.emittedEdgeIds.length,
          omittedEdgeCount: view.projection.accounting.omittedEdges.length,
          accountingRatio:
            view.projection.accounting.selectedNodeIds.length === 0
              ? 1
              : view.projection.accounting.emittedNodeIds.length /
                view.projection.accounting.selectedNodeIds.length
        }
      ])
    )
  );
  const review = buildArchitectureReview({
    missionId: input.missionId,
    baseline: input.baseline,
    afterBundle,
    policy,
    generatedAt: input.generatedAt,
    projectionAccounting,
    ...(input.accountedChangedPaths
      ? { accountedChangedPaths: input.accountedChangedPaths }
      : {})
  });
  const delta = buildArchitectureDelta({
    missionId: input.missionId,
    baseline: input.baseline,
    afterBundle,
    policy
  });
  const capsule = renderArchitectureCapsule({
    profile,
    missionId: input.missionId,
    ...(input.routeId ? { routeId: input.routeId } : {}),
    baseline: input.baseline,
    metrics: views.metrics,
    findings: views.findings,
    mapArtifact: 'architecture-map-delta.mmd'
  });
  return Object.freeze({
    review,
    delta,
    afterBundle,
    manifest: views.manifest,
    capsule,
    policy
  });
}

export function validateArchitectureMapBaselineArtifact(value: unknown) {
  return validateArchitectureBaseline(value);
}

export function validateArchitectureMapReviewArtifact(value: unknown) {
  return validateArchitectureReview(value);
}

export function validateArchitectureMapManifestArtifact(value: unknown) {
  return validateArchitectureMapManifest(value);
}

export function validateArchitectureMapInputBundleArtifact(value: unknown) {
  return validateArchitectureInputBundle(value);
}

export function bindArchitectureMapBaseline(input: {
  baseline: ArchitectureBaselineV1;
  missionId: string;
}): { ok: boolean; blockers: string[]; binding: Record<string, string> | null } {
  const validation = validateArchitectureBaseline(input.baseline);
  const blockers = [...validation.blockers];
  if (input.baseline.missionId !== input.missionId) blockers.push('mission_mismatch');
  if (!verifyArchitectureBaselineSeal(input.baseline)) blockers.push('seal_mismatch');
  if (blockers.length) return { ok: false, blockers, binding: null };
  return {
    ok: true,
    blockers: [],
    binding: {
      missionId: input.baseline.missionId,
      seal: input.baseline.seal,
      canonicalPayloadHash: input.baseline.canonicalPayloadHash,
      policyHash: input.baseline.policyHash,
      graphHash: input.baseline.graphHash,
      worktreeFingerprintHash: input.baseline.worktreeFingerprintHash
    }
  };
}

export function architectureMapReviewDigest(review: unknown): string {
  return sha256(JSON.stringify(review ?? null));
}

export function architectureMapBaselineDigest(baseline: unknown): string {
  return sha256(JSON.stringify(baseline ?? null));
}

/** Re-export for callers that only need the manifest builder. */
export { buildArchitectureMapManifest, buildArchitectureMapViews };
