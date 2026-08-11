import type {
  BridgeCatalogModel,
  BridgeProviderId,
  BridgeRouteIndex,
  CatalogSyncState,
  CombinedCatalogSyncStatus
} from '../bridge-contracts.js';

export const COMBINED_BRIDGE_CATALOG_SCHEMA = 'sks.bridge-combined-catalog.v1' as const;
export const COMBINED_BRIDGE_CATALOG_FILENAME = 'sks-bridge-catalog.json' as const;
export const BRIDGE_ROUTE_INDEX_FILENAME = 'sks-bridge-route-index.json' as const;
export const BRIDGE_ACTIVE_GENERATION_SCHEMA = 'sks.bridge-active-generation.v1' as const;
export const BRIDGE_ACTIVE_GENERATION_FILENAME = 'sks-bridge-active-generation.json' as const;

/**
 * How long a synced provider catalog counts as fresh.
 *
 * Nothing refreshes this catalog in the background: the running bridge never
 * reads `expires_at`, and only an explicit `catalog.sync` rewrites it. The
 * previous unnamed `15 * 60_000` therefore described no refresh cycle at all —
 * it made every install report `<provider>_catalog_stale` a quarter of an hour
 * after its last sync and never recover, so `sks doctor --fix` synced the
 * catalog, verified it was fresh, went green, and the next run showed the
 * identical blocker. That is the treadmill users hit when a `--fix` "never
 * fixes" the bridge. A model catalog changes on the order of weeks, so freshness
 * must at least outlive a working session; an expired one still raises its
 * blocker and `retry_catalog_sync`.
 */
export const COMBINED_BRIDGE_CATALOG_TTL_MS = 12 * 60 * 60 * 1000;

export interface BridgeActiveGenerationPointer {
  readonly schema: typeof BRIDGE_ACTIVE_GENERATION_SCHEMA;
  readonly catalog_generation: string;
  readonly route_index_generation: string;
  readonly observation_generation?: string;
  readonly bundle_directory: string;
  readonly catalog_filename: string;
  readonly route_index_filename: string;
}

export interface ProviderCatalogBuildInput {
  readonly provider_id: BridgeProviderId;
  readonly state: CatalogSyncState['state'];
  readonly generation: string | null;
  readonly models: unknown;
  readonly checked_at?: string | null;
  readonly expires_at?: string | null;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface CombinedBridgeCatalogArtifact {
  readonly schema: typeof COMBINED_BRIDGE_CATALOG_SCHEMA;
  readonly generation: string;
  readonly created_at: string;
  readonly digest: string;
  readonly models: readonly BridgeCatalogModel[];
  readonly provider_statuses: Record<BridgeProviderId, CatalogSyncState>;
}

export interface CombinedCatalogBuildResult {
  readonly schema: 'sks.bridge-combined-catalog-build.v1';
  readonly ok: boolean;
  readonly catalog: CombinedBridgeCatalogArtifact;
  readonly route_index: BridgeRouteIndex;
  readonly status: CombinedCatalogSyncStatus;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface CombinedCatalogStagingResult {
  readonly schema: 'sks.bridge-combined-catalog-staging.v1';
  readonly staged: boolean;
  readonly generation: string | null;
  readonly previous_generation: string | null;
  readonly catalog_path: string | null;
  readonly route_index_path: string | null;
  readonly pointer_path: string;
  /** Secret-free bytes to commit as the single active-generation switch. */
  readonly pointer_text: string | null;
  readonly blockers: readonly string[];
}

export interface ActiveCombinedBridgeCatalogRead {
  readonly ok: boolean;
  readonly catalog: CombinedBridgeCatalogArtifact;
  readonly route_index: BridgeRouteIndex;
  readonly catalog_path: string | null;
  readonly route_index_path: string | null;
  readonly pointer_path: string;
  readonly blockers: readonly string[];
}

export interface GenerationBundleLayout {
  readonly ok: boolean;
  readonly parentDirectory: string;
  readonly generationsRoot: string;
  readonly bundleDirectory: string;
  readonly catalogFilename: string;
  readonly routeIndexFilename: string;
  readonly catalogPath: string;
  readonly routeIndexPath: string;
  readonly pointerPath: string;
  readonly blockers: string[];
}
