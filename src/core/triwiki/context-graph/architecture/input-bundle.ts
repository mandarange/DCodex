/**
 * Immutable architecture input bundle — one analysis unit.
 */
import type { ContextGraphSnapshot } from '../contracts.js';
import { canonicalSsotAuthorityInventory } from '../../../safety/ssot-authority-inventory.js';
import {
  ARCHITECTURE_ANALYZER_VERSION,
  ARCHITECTURE_INPUT_BUNDLE_SCHEMA,
  ARCHITECTURE_SERIALIZER_VERSION,
  type ArchitectureInputBundleV1,
  type ArchitectureMapProfile,
  type WorktreeFingerprint
} from './contracts.js';
import { emptyWorktreeFingerprint, hashCanonical, hashWithoutKeys } from './fingerprint.js';
import type { ArchitectureMapPolicy } from './policy.js';
import {
  buildTopologyOverlayFromSnapshot,
  emptyTopologyOverlay,
  topologyOverlayHash
} from './topology-overlay.js';
import { emptyVoxelContext, voxelContextHash } from './voxel-context.js';

export interface BuildArchitectureInputBundleOptions {
  readonly rootId: string;
  readonly graph: ContextGraphSnapshot;
  readonly policy: ArchitectureMapPolicy;
  readonly policyHash?: string;
  readonly worktree?: WorktreeFingerprint;
  readonly profile?: ArchitectureMapProfile;
  readonly generatedAt?: string;
  readonly topologyMode?: 'from-snapshot' | 'empty';
}

export function policyContentHash(policy: ArchitectureMapPolicy): string {
  return hashCanonical(policy);
}

export function buildArchitectureInputBundle(
  options: BuildArchitectureInputBundleOptions
): ArchitectureInputBundleV1 {
  const topology =
    options.topologyMode === 'empty'
      ? emptyTopologyOverlay()
      : buildTopologyOverlayFromSnapshot(options.graph);
  const ssotInventory = canonicalSsotAuthorityInventory().map((domain) =>
    Object.freeze({ id: domain.id })
  );
  const voxelContext = emptyVoxelContext(options.profile ?? 'global');
  const worktree = options.worktree ?? emptyWorktreeFingerprint(options.rootId);
  const policyHash = options.policyHash ?? policyContentHash(options.policy);
  const generatedAt = options.generatedAt ?? '1970-01-01T00:00:00.000Z';

  const partial = {
    schema: ARCHITECTURE_INPUT_BUNDLE_SCHEMA,
    rootId: options.rootId,
    graph: options.graph,
    graphHash: options.graph.snapshotHash,
    topology,
    topologyHash: topologyOverlayHash(topology),
    ssotInventory: Object.freeze(ssotInventory),
    ssotInventoryHash: hashCanonical(ssotInventory),
    voxelContext,
    voxelContextHash: voxelContextHash(voxelContext),
    worktree,
    policyHash,
    analyzerVersion: ARCHITECTURE_ANALYZER_VERSION,
    serializerVersion: ARCHITECTURE_SERIALIZER_VERSION,
    generatedAt
  };
  const canonicalHash = hashWithoutKeys(
    {
      schema: partial.schema,
      rootId: partial.rootId,
      graphHash: partial.graphHash,
      topologyHash: partial.topologyHash,
      ssotInventoryHash: partial.ssotInventoryHash,
      voxelContextHash: partial.voxelContextHash,
      worktree: partial.worktree.fingerprintHash,
      policyHash: partial.policyHash,
      analyzerVersion: partial.analyzerVersion,
      serializerVersion: partial.serializerVersion
    },
    []
  );
  const bundle: ArchitectureInputBundleV1 = Object.freeze({
    ...partial,
    canonicalHash
  });
  return bundle;
}

export function architectureInputBundleHash(bundle: ArchitectureInputBundleV1): string {
  return hashWithoutKeys(
    {
      schema: bundle.schema,
      rootId: bundle.rootId,
      graphHash: bundle.graphHash,
      topologyHash: bundle.topologyHash,
      ssotInventoryHash: bundle.ssotInventoryHash,
      voxelContextHash: bundle.voxelContextHash,
      worktree: bundle.worktree.fingerprintHash,
      policyHash: bundle.policyHash,
      analyzerVersion: bundle.analyzerVersion,
      serializerVersion: bundle.serializerVersion
    },
    []
  );
}
