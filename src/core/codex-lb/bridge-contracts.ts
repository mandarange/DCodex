/**
 * Sneakoscope 8.1.3 Desktop Bridge public contracts.
 *
 * This module deliberately contains schemas and types only. Runtime behavior is
 * implemented by the config, registry, transport, capability, and controller
 * owners after the schema-freeze checkpoint.
 */

export const MANAGED_ROUTING_RUNTIME = 'desktop-bridge' as const;
export const BRIDGE_PROVIDER_IDS = ['codex-lb', 'openrouter'] as const;

export type DesktopBridgeRuntimeState =
  | 'not_installed'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'blocked'
  | 'stopped'
  | 'stale';

export type DesktopBridgeUnmanagedReason =
  | 'uninstalled'
  | 'rollback_complete'
  | 'never_configured';

export type DesktopBridgeManagementStatus =
  | {
      managed: true;
      runtime: typeof MANAGED_ROUTING_RUNTIME;
      state: DesktopBridgeRuntimeState;
      reason: null;
    }
  | {
      managed: false;
      runtime: null;
      state: 'not_installed' | 'stopped';
      reason: DesktopBridgeUnmanagedReason;
    };

export type BridgeProviderId = (typeof BRIDGE_PROVIDER_IDS)[number];

export type CredentialState =
  | 'not_configured'
  | 'configured_unverified'
  | 'validating'
  | 'ready'
  | 'rejected'
  | 'unavailable'
  | 'stale';

export type CatalogSyncLifecycleState =
  | 'not_started'
  | 'syncing'
  | 'verified'
  | 'degraded'
  | 'failed'
  | 'stale';

export interface CatalogSyncState {
  schema: 'sks.catalog-sync-state.v2';
  provider_id: BridgeProviderId;
  state: CatalogSyncLifecycleState;
  source: 'gateway' | 'openrouter' | null;
  generation: string | null;
  digest: string | null;
  model_count: number | null;
  checked_at: string | null;
  expires_at: string | null;
  blockers: string[];
  warnings: string[];
  recovery_action: string | null;
}

export interface CombinedCatalogSyncStatus {
  schema: 'sks.combined-catalog-sync.v1';
  state: CatalogSyncLifecycleState;
  generation: string | null;
  digest: string | null;
  model_count: number | null;
  route_count: number | null;
  conflict_count: number;
  checked_at: string | null;
  providers: Record<BridgeProviderId, CatalogSyncState>;
  blockers: string[];
  warnings: string[];
  recovery_action: string | null;
}

export type CapabilityRequestedLevel = 'shallow' | 'transport' | 'deep';

export type CapabilityProbeState =
  | 'not_attempted'
  | 'running'
  | 'verified'
  | 'degraded'
  | 'blocked'
  | 'failed'
  | 'unsupported'
  | 'stale';

export type CapabilityProbeStage =
  | 'preflight'
  | 'process'
  | 'tcp_connect'
  | 'http_health'
  | 'websocket_upgrade'
  | 'websocket_protocol'
  | 'provider_auth'
  | 'catalog_sync'
  | 'model_route'
  | 'feature_request'
  | 'feature_response'
  | 'artifact_validation'
  | 'complete';

export type CapabilityScope =
  | 'bridge'
  | 'native-identity'
  | 'provider:codex-lb'
  | 'provider:openrouter'
  | 'catalog:combined';

export type CapabilityEvidenceSource =
  | 'config'
  | 'manifest'
  | 'transport'
  | 'desktop_ui'
  | 'deep_probe'
  | 'artifact';

export interface CapabilityProbeResultV3 {
  schema: 'sks.capability-probe.v3';
  capability: string;
  scope: CapabilityScope;
  requested_level: CapabilityRequestedLevel;
  stage: CapabilityProbeStage;
  state: CapabilityProbeState;
  checked_at: string;
  report_id: string;
  correlation_id: string;
  session_id: string;
  attempt_id: number;
  terminal: boolean;
  root_cause: string | null;
  blockers: string[];
  warnings: string[];
  retryable: boolean;
  recovery_action: string | null;
  source: CapabilityEvidenceSource;
  evidence: Record<string, unknown>;
}

/** Frozen facade consumed by status, CLI, and native UI. */
export interface ScopeCapabilitySummary {
  schema: 'sks.scope-capability-summary.v1';
  scope: CapabilityScope;
  state: CapabilityProbeState;
  checked_at: string;
  capabilities: Record<string, CapabilityProbeResultV3>;
  blockers: string[];
  warnings: string[];
}

export type ProviderCapabilitySummary = ScopeCapabilitySummary;

export interface BridgeProviderProfileStatus {
  schema: 'sks.bridge-provider-profile-status.v1';
  provider_id: BridgeProviderId;
  enabled: boolean;
  credential: {
    state: CredentialState;
    source: string | null;
    fingerprint: string | null;
    checked_at: string | null;
    blockers: string[];
    warnings: string[];
  };
  endpoint: {
    configured: boolean;
    origin_redacted: string | null;
    auth_transport:
      | 'authorization-bearer'
      | 'x-codex-lb-api-key'
      | 'openrouter-bearer'
      | null;
  };
  catalog: CatalogSyncState;
  capabilities: ProviderCapabilitySummary;
}

export interface BridgeRouteTarget {
  provider_id: BridgeProviderId;
  upstream_model: string;
}

export interface BridgeRoutingPolicy {
  schema: 'sks.bridge-routing-policy.v1';
  default_provider_id: BridgeProviderId | null;
  fallback: 'none';
  model_routes: Record<string, BridgeRouteTarget>;
  catalog_generation: string;
  policy_generation: string;
  changed_at: string;
}

export interface BridgeCatalogModel {
  public_id: string;
  provider_id: BridgeProviderId;
  upstream_model: string;
  display_name: string;
  supported_in_api: boolean;
  capabilities: string[];
  source_catalog_generation: string;
  route_key: string;
}

export interface BridgeRouteIndex {
  schema: 'sks.bridge-route-index.v1';
  generation: string;
  created_at: string;
  providers: Record<BridgeProviderId, {
    catalog_generation: string | null;
    credential_fingerprint: string | null;
    state: string;
  }>;
  routes: Record<string, BridgeRouteTarget>;
  conflicts: Array<{
    public_id: string;
    providers: BridgeProviderId[];
    blocker: 'catalog_model_route_ambiguous';
  }>;
}

export interface ProviderSessionPin {
  thread_id: string;
  provider_id: BridgeProviderId;
  public_model: string;
  upstream_model: string;
  catalog_generation: string;
  route_policy_generation: string;
  created_at: string;
}

export interface HttpProbeResult {
  schema: 'sks.desktop-bridge-http-probe.v1';
  state: 'verified' | 'blocked' | 'failed' | 'unsupported';
  terminal_stage: 'tcp_connect' | 'http_health' | 'complete';
  root_cause: string | null;
  status_code: number | null;
  latency_ms: number | null;
  blockers: string[];
  warnings: string[];
}

export interface WebSocketProbeResult {
  schema: 'sks.desktop-bridge-websocket-probe.v2';
  state: 'verified' | 'blocked' | 'failed' | 'unsupported';
  terminal_stage:
    | 'tcp_connect'
    | 'websocket_upgrade'
    | 'websocket_protocol'
    | 'frame_round_trip'
    | 'clean_close'
    | 'complete';
  root_cause: string | null;
  status_code: number | null;
  negotiated_protocol: string | null;
  upgrade_verified: boolean;
  protocol_verified: boolean;
  frame_round_trip_verified: boolean;
  clean_close_verified: boolean;
  latency_ms: number | null;
  blockers: string[];
  warnings: string[];
}

export interface DesktopCapabilityReportV3 {
  schema: 'sks.desktop-capabilities.v3';
  report_id: string;
  requested_level: CapabilityRequestedLevel;
  checked_at: string;
  execution: {
    ok: boolean;
    status: 'completed' | 'partial' | 'failed';
    blockers: string[];
  };
  bridge: ScopeCapabilitySummary;
  native_identity: ScopeCapabilitySummary;
  providers: Record<BridgeProviderId, ScopeCapabilitySummary>;
  combined_catalog: ScopeCapabilitySummary;
  summary: {
    bridge_ready: boolean;
    active_routes_ready: boolean;
    transport_level_satisfied: boolean;
    deep_level_satisfied: boolean;
    full_feature_verified: boolean;
    inactive_provider_failures: string[];
    blockers: string[];
    warnings: string[];
  };
  catalog_sync: CombinedCatalogSyncStatus;
}

export interface DesktopBridgeUnificationReceipt {
  schema: 'sks.desktop-bridge-unification-receipt.v1';
  receipt_id: string;
  created_at: string;
  baseline_version: '8.1.2';
  target_version: '8.1.3';
  config_before_sha256: string;
  config_after_sha256: string;
  auth_before_sha256: string;
  auth_after_sha256: string;
  auth_semantic_identity_preserved: boolean;
  legacy_state: {
    desktop_mode: string | null;
    provider_mode: string | null;
    model_provider: string | null;
    catalog_path: string | null;
  };
  migrated_profiles: BridgeProviderId[];
  credentials_deleted: false;
  new_runtime: typeof MANAGED_ROUTING_RUNTIME;
  new_catalog_generation: string | null;
  backup_paths: string[];
  rollback_supported: boolean;
  blockers: string[];
}
