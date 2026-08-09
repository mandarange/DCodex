/**
 * Architecture map manifest builder from projected view results + hashes.
 */
import {
  ARCHITECTURE_ANALYZER_VERSION,
  ARCHITECTURE_MAP_MANIFEST_SCHEMA,
  ARCHITECTURE_SERIALIZER_VERSION,
  byCodePoint,
  type ArchitectureMapViewId
} from '../../architecture/contracts.js';
import { hashCanonical } from '../../architecture/fingerprint.js';
import type { MermaidProjectionV1, ProjectionAccounting } from './contracts.js';

export interface ArchitectureMapManifestViewRow {
  readonly viewId: ArchitectureMapViewId;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface ArchitectureMapManifestV1 {
  readonly schema: typeof ARCHITECTURE_MAP_MANIFEST_SCHEMA;
  readonly missionId: string | null;
  readonly graphHash: string;
  readonly topologyHash: string;
  readonly policyHash: string;
  readonly inputBundleHash: string;
  readonly analyzerVersion: string;
  readonly serializerVersion: string;
  readonly views: readonly ArchitectureMapManifestViewRow[];
  readonly projectionAccounting: Readonly<Record<string, ProjectionAccounting>>;
  readonly sourceBinding: Readonly<Record<string, string>>;
  readonly canonicalHash: string;
}

export interface ManifestViewResult {
  readonly viewId: ArchitectureMapViewId;
  readonly projection: MermaidProjectionV1;
  readonly text?: string;
}

/**
 * Build architecture-map-manifest.json from already-built view results + hashes.
 */
export function buildArchitectureMapManifest(input: {
  views: readonly ManifestViewResult[];
  graphHash: string;
  policyHash: string;
  topologyHash?: string;
  inputBundleHash?: string;
  analyzerVersion?: string;
  serializerVersion?: string;
  missionId?: string | null;
}): ArchitectureMapManifestV1 {
  const sorted = [...input.views].sort((left, right) => byCodePoint(left.viewId, right.viewId));
  const viewRows = Object.freeze(
    sorted.map((entry) =>
      Object.freeze({
        viewId: entry.viewId,
        contentHash: entry.projection.contentHash,
        byteLength: entry.projection.byteLength
      })
    )
  );
  const projectionAccounting = Object.freeze(
    Object.fromEntries(sorted.map((entry) => [entry.viewId, entry.projection.accounting]))
  );
  const topologyHash = input.topologyHash ?? '';
  const inputBundleHash = input.inputBundleHash ?? '';
  const analyzerVersion = input.analyzerVersion ?? ARCHITECTURE_ANALYZER_VERSION;
  const serializerVersion = input.serializerVersion ?? ARCHITECTURE_SERIALIZER_VERSION;
  const sourceBinding = Object.freeze({
    graphHash: input.graphHash,
    topologyHash,
    policyHash: input.policyHash
  });
  const payload = {
    schema: ARCHITECTURE_MAP_MANIFEST_SCHEMA,
    missionId: input.missionId ?? null,
    graphHash: input.graphHash,
    topologyHash,
    policyHash: input.policyHash,
    inputBundleHash,
    analyzerVersion,
    serializerVersion,
    views: viewRows,
    projectionAccounting,
    sourceBinding
  };
  return Object.freeze({
    ...payload,
    canonicalHash: hashCanonical(payload)
  });
}
