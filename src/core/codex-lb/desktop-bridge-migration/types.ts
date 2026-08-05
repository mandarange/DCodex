import type { BridgeProviderId } from '../bridge-contracts.js';
import type {
  DesktopBridgeRollbackMetadataKind,
  StoredDesktopBridgeUnificationReceipt,
  rollbackDesktopBridgeUnificationReceipt
} from '../migration-receipt.js';

export type HistoricalProviderMode = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';
export type HistoricalProviderAuthTransport =
  | 'authorization-bearer'
  | 'x-codex-lb-api-key'
  | 'openrouter-bearer';

export interface HistoricalDesktopBridgeProviderIntent {
  present: boolean;
  enabled: boolean;
  endpoint_url: string | null;
  auth_transport: HistoricalProviderAuthTransport | null;
}

export interface HistoricalDesktopBridgeIntent {
  schema: 'sks.desktop-bridge-historical-intent.v1';
  blockers: string[];
  providers: Record<BridgeProviderId, HistoricalDesktopBridgeProviderIntent>;
  default_provider_id: BridgeProviderId | null;
}

export interface HistoricalProviderConfigState {
  desktop_mode: string | null;
  provider_mode: HistoricalProviderMode | null;
  model_provider: string | null;
  catalog_path: string | null;
  migrated_profiles: BridgeProviderId[];
  gateway_auth_transport: 'authorization-bearer' | 'x-codex-lb-api-key' | null;
  blockers: string[];
}

export interface DesktopBridgeMigrationMetadataUpdate {
  kind: Exclude<DesktopBridgeRollbackMetadataKind, 'config'>;
  path: string;
  text: string;
}

export interface DesktopBridgeMigrationOptions {
  home?: string;
  configPath?: string;
  authPath?: string;
  receiptDir?: string;
  bridgeBaseUrl: string;
  combinedCatalogPath?: string;
  newCatalogGeneration?: string | null;
  metadataUpdates?: DesktopBridgeMigrationMetadataUpdate[];
  now?: Date;
}

export interface DesktopBridgeMigrationResult {
  schema: 'sks.desktop-bridge-unification-migration.v1';
  ok: boolean;
  status: 'migrated' | 'already_migrated' | 'blocked' | 'failed';
  managed_runtime: 'desktop-bridge' | null;
  config_path: string;
  auth_path: string;
  receipt_path: string | null;
  receipt?: StoredDesktopBridgeUnificationReceipt;
  migrated_profiles: BridgeProviderId[];
  historical_gateway_auth_transport: 'authorization-bearer' | 'x-codex-lb-api-key' | null;
  credentials_deleted: false;
  auth_semantic_identity_preserved: boolean;
  blockers: string[];
  rollback?: Awaited<ReturnType<typeof rollbackDesktopBridgeUnificationReceipt>>;
  error?: string;
}
