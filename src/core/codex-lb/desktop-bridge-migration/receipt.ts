import type { captureCodexAuthSnapshot } from '../desktop-auth-invariant.js';
import type {
  DesktopBridgeRollbackMetadataFile,
  StoredDesktopBridgeUnificationReceipt
} from '../migration-receipt.js';
import type { HistoricalProviderConfigState } from './types.js';

type AuthSnapshot = Awaited<ReturnType<typeof captureCodexAuthSnapshot>>;

export function authSemanticIdentityPreserved(before: AuthSnapshot, after: AuthSnapshot): boolean {
  if (before.path !== after.path || before.exists !== after.exists) return false;
  const beforeIsOAuth = before.mode === 'chatgpt_oauth' || before.mode === 'mixed';
  const afterIsOAuth = after.mode === 'chatgpt_oauth' || after.mode === 'mixed';
  if (beforeIsOAuth || afterIsOAuth) {
    return beforeIsOAuth
      && afterIsOAuth
      && before.semantic_fingerprint !== null
      && before.semantic_fingerprint === after.semantic_fingerprint;
  }
  return before.sha256 === after.sha256;
}

export function buildDesktopBridgeMigrationReceipt(input: {
  receiptId: string;
  createdAt: string;
  configBeforeSha: string;
  configAfterSha: string;
  authBeforeSha: string;
  authAfterSha: string;
  historicalState: HistoricalProviderConfigState;
  newCatalogGeneration: string | null;
  rollbackFiles: DesktopBridgeRollbackMetadataFile[];
  blockers?: string[];
  authSemanticIdentityPreserved?: boolean;
}): StoredDesktopBridgeUnificationReceipt {
  const common = {
    schema: 'sks.desktop-bridge-unification-receipt.v1' as const,
    receipt_id: input.receiptId,
    created_at: input.createdAt,
    baseline_version: '8.1.2' as const,
    target_version: '8.1.3' as const,
    config_before_sha256: input.configBeforeSha,
    config_after_sha256: input.configAfterSha,
    auth_before_sha256: input.authBeforeSha,
    auth_after_sha256: input.authAfterSha,
    auth_semantic_identity_preserved: input.authSemanticIdentityPreserved ?? true,
    historical_state: {
      desktop_mode: input.historicalState.desktop_mode,
      historical_provider_selection: input.historicalState.provider_mode,
      model_provider: input.historicalState.model_provider,
      catalog_path: input.historicalState.catalog_path
    },
    migrated_profiles: input.historicalState.migrated_profiles,
    credentials_deleted: false as const,
    new_runtime: 'desktop-bridge' as const,
    new_catalog_generation: input.newCatalogGeneration,
    backup_paths: input.rollbackFiles
      .map((file) => file.backup_path)
      .filter((entry): entry is string => Boolean(entry)),
    blockers: input.blockers || [],
    rollback_metadata: {
      schema: 'sks.desktop-bridge-unification-rollback-metadata.v1' as const,
      files: input.rollbackFiles
    }
  };
  return {
    ...common,
    rollback_supported: true,
    migration_status: 'migrated'
  };
}
