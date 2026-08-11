import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
  DESKTOP_BRIDGE_MANAGED_MARKER,
  DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER,
  upsertDesktopBridgeManagedConfig
} from '../../cli/install-helpers-codex-lb-config.js';
import { safeWriteCodexConfigToml } from '../codex-runtime/codex-desktop-config-policy.js';
import { messageOf as errorMessage } from '../errors/message.js';
import { readText } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';
import { captureCodexAuthSnapshot } from './desktop-auth-invariant.js';
import {
  parseHistoricalProviderConfig,
  prepareHistoricalConfigForDesktopBridgeWriter
} from './desktop-bridge-migration/historical-config.js';
import { hasTopLevelMarker } from './desktop-bridge-migration/historical-toml.js';
import {
  normalizedMetadataUpdates,
  sha256,
  validateMetadataUpdates,
  writeBufferAtomic
} from './desktop-bridge-migration/metadata.js';
import {
  authSemanticIdentityPreserved,
  buildDesktopBridgeMigrationReceipt
} from './desktop-bridge-migration/receipt.js';
import type {
  DesktopBridgeMigrationOptions,
  DesktopBridgeMigrationResult
} from './desktop-bridge-migration/types.js';
import {
  backupDesktopBridgeMigrationFile,
  createDesktopBridgeUnificationReceiptId,
  desktopBridgeMigrationTransactionLockPath,
  desktopBridgeUnificationReceiptDir,
  fileSha256OrMissing,
  finalizeDesktopBridgeMigrationReceiptFiles,
  rollbackDesktopBridgeUnificationReceipt,
  writeDesktopBridgeUnificationReceipt,
  type DesktopBridgeMigrationFileBackup,
  type DesktopBridgeRollbackMetadataFile,
  type DesktopBridgeRollbackMetadataKind
} from './migration-receipt.js';

export { inspectHistoricalDesktopBridgeIntent } from './desktop-bridge-migration/historical-config.js';
export type {
  DesktopBridgeMigrationMetadataUpdate,
  DesktopBridgeMigrationOptions,
  DesktopBridgeMigrationResult,
  HistoricalDesktopBridgeIntent,
  HistoricalDesktopBridgeProviderIntent,
  HistoricalProviderAuthTransport
} from './desktop-bridge-migration/types.js';

/**
 * Convert SKS-owned historical routing metadata into the only current runtime:
 * Desktop Bridge. Historical strings are decoded privately by migration
 * helpers and never become a selectable mode or active runtime dependency.
 */
export async function migrateDesktopBridgeConfig(
  input: DesktopBridgeMigrationOptions
): Promise<DesktopBridgeMigrationResult> {
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  return withFileLock({
    lockPath: desktopBridgeMigrationTransactionLockPath(home),
    timeoutMs: 30_000,
    staleMs: 120_000
  }, () => migrateDesktopBridgeConfigUnlocked(input));
}

async function migrateDesktopBridgeConfigUnlocked(
  input: DesktopBridgeMigrationOptions
): Promise<DesktopBridgeMigrationResult> {
  const home = input.home || process.env.HOME || os.homedir();
  const configPath = input.configPath || path.join(home, '.codex', 'config.toml');
  const authPath = input.authPath || path.join(home, '.codex', 'auth.json');
  const receiptDir = input.receiptDir || desktopBridgeUnificationReceiptDir(home);
  const combinedCatalogPath = input.combinedCatalogPath
    || path.join(home, '.codex', 'sks', 'sks-bridge-catalog.json');
  const currentConfig = await readText(configPath, '');
  const authBefore = await captureCodexAuthSnapshot({ home, authPath });
  const historicalState = parseHistoricalProviderConfig(currentConfig);
  const baseResult = {
    schema: 'sks.desktop-bridge-unification-migration.v1' as const,
    config_path: configPath,
    auth_path: authPath,
    migrated_profiles: historicalState.migrated_profiles,
    historical_gateway_auth_transport: historicalState.gateway_auth_transport,
    credentials_deleted: false as const
  };
  if (historicalState.blockers.length > 0) {
    return {
      ...baseResult,
      ok: false,
      status: 'blocked',
      managed_runtime: null,
      receipt_path: null,
      auth_semantic_identity_preserved: true,
      blockers: historicalState.blockers
    };
  }

  let nextConfig: string;
  try {
    validateConfigTarget(home, configPath);
    const migrationInputConfig = prepareHistoricalConfigForDesktopBridgeWriter(
      currentConfig,
      historicalState
    );
    nextConfig = upsertDesktopBridgeManagedConfig(migrationInputConfig, {
      bridgeBaseUrl: input.bridgeBaseUrl,
      combinedCatalogPath
    });
    validateMetadataUpdates(input.metadataUpdates || [], { home, configPath, authPath });
  } catch (error: unknown) {
    const message = errorMessage(error);
    return {
      ...baseResult,
      ok: false,
      status: 'blocked',
      managed_runtime: null,
      receipt_path: null,
      auth_semantic_identity_preserved: true,
      blockers: [message.startsWith('historical_user_owned_config_conflict')
        ? 'historical_user_owned_config_conflict'
        : message],
      error: message
    };
  }

  const metadataUpdates = normalizedMetadataUpdates(input.metadataUpdates || []);
  const metadataAlreadyCurrent = await Promise.all(metadataUpdates.map(async (update) => {
    const currentSha = await fileSha256OrMissing(update.path);
    return currentSha !== null && currentSha === sha256(update.text);
  }));
  const hasUnifiedMarkers = [
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ].every((marker) => hasTopLevelMarker(currentConfig, marker));
  if (nextConfig === currentConfig && hasUnifiedMarkers && metadataAlreadyCurrent.every(Boolean)) {
    const authAfter = await captureCodexAuthSnapshot({ home, authPath });
    const authPreserved = authSemanticIdentityPreserved(authBefore, authAfter);
    const configSha = sha256(currentConfig);
    const configUnchanged = await fileSha256OrMissing(configPath) === configSha;
    const authBytesUnchanged = authBefore.sha256 === authAfter.sha256;
    if (!authPreserved || !configUnchanged || !authBytesUnchanged) {
      return {
        ...baseResult,
        ok: false,
        status: 'blocked',
        managed_runtime: null,
        receipt_path: null,
        auth_semantic_identity_preserved: authPreserved,
        blockers: [
          ...(!configUnchanged ? ['desktop_bridge_config_changed_during_noop'] : []),
          ...(!authPreserved ? ['desktop_oauth_identity_changed'] : []),
          ...(authPreserved && !authBytesUnchanged ? ['desktop_auth_changed_during_noop'] : [])
        ]
      };
    }
    return {
      ...baseResult,
      ok: true,
      status: 'already_migrated',
      managed_runtime: 'desktop-bridge',
      receipt_path: null,
      auth_semantic_identity_preserved: true,
      blockers: []
    };
  }

  const now = input.now || new Date();
  const receiptId = createDesktopBridgeUnificationReceiptId(now);
  const backupDir = path.join(receiptDir, receiptId, 'files');
  const backupInputs: Array<{ kind: DesktopBridgeRollbackMetadataKind; path: string; owned: boolean }> = [
    { kind: 'config', path: configPath, owned: false },
    ...metadataUpdates.map((update) => ({ kind: update.kind, path: update.path, owned: true }))
  ];
  const backups: Array<DesktopBridgeMigrationFileBackup & { kind: DesktopBridgeRollbackMetadataKind }> = [];
  const mutatedPaths = new Set<string>();
  try {
    for (const entry of backupInputs) {
      backups.push({
        kind: entry.kind,
        ...await backupDesktopBridgeMigrationFile(entry.path, backupDir, entry.owned)
      });
    }
    const configWrite = await safeWriteCodexConfigToml(
      configPath,
      currentConfig,
      nextConfig,
      'desktop-bridge-unification-migration',
      { verifyUnchangedBeforeWrite: true }
    );
    if (!configWrite.ok) throw new Error(`desktop_bridge_config_write_failed:${configWrite.status}`);
    if (configWrite.status === 'written') mutatedPaths.add(path.resolve(configPath));
    if (await fileSha256OrMissing(configPath) !== sha256(nextConfig)) {
      throw new Error('desktop_bridge_config_readback_failed');
    }
    for (const update of metadataUpdates) {
      const backup = backups.find((entry) => path.resolve(entry.path) === path.resolve(update.path));
      if (!backup) throw new Error(`desktop_bridge_metadata_backup_missing:${update.path}`);
      if (await fileSha256OrMissing(update.path) !== backup.before_sha256) {
        throw new Error(`desktop_bridge_metadata_changed_during_migration:${update.path}`);
      }
      if (sha256(update.text) !== backup.before_sha256) {
        mutatedPaths.add(path.resolve(update.path));
        await writeBufferAtomic(update.path, Buffer.from(update.text));
        if (await fileSha256OrMissing(update.path) !== sha256(update.text)) {
          throw new Error(`desktop_bridge_metadata_readback_failed:${update.kind}`);
        }
      }
    }

    const authAfter = await captureCodexAuthSnapshot({ home, authPath });
    if (!authSemanticIdentityPreserved(authBefore, authAfter)) {
      throw new Error('desktop_oauth_identity_changed');
    }
    const finalized = await finalizeDesktopBridgeMigrationReceiptFiles(backups);
    const rollbackFiles: DesktopBridgeRollbackMetadataFile[] = finalized.map((file, index) => ({
      ...file,
      kind: backups[index]!.kind
    }));
    const receipt = buildDesktopBridgeMigrationReceipt({
      receiptId,
      createdAt: now.toISOString(),
      configBeforeSha: sha256(currentConfig),
      configAfterSha: sha256(nextConfig),
      authBeforeSha: authBefore.sha256 || 'missing',
      authAfterSha: authAfter.sha256 || 'missing',
      historicalState,
      newCatalogGeneration: input.newCatalogGeneration || null,
      rollbackFiles
    });
    const receiptPath = await writeDesktopBridgeUnificationReceipt(receipt, { receiptDir });
    return {
      ...baseResult,
      ok: true,
      status: 'migrated',
      managed_runtime: 'desktop-bridge',
      receipt_path: receiptPath,
      receipt,
      auth_semantic_identity_preserved: true,
      blockers: []
    };
  } catch (error: unknown) {
    const rollbackFiles: DesktopBridgeRollbackMetadataFile[] = backups
      .filter((file) => mutatedPaths.has(path.resolve(file.path)))
      .map((file) => ({
        ...file,
        after_sha256: path.resolve(file.path) === path.resolve(configPath)
          ? sha256(nextConfig)
          : sha256(metadataUpdates.find((update) => path.resolve(update.path) === path.resolve(file.path))?.text || ''),
        kind: file.kind
      }));
    const authAfter = await captureCodexAuthSnapshot({ home, authPath });
    const provisional = buildDesktopBridgeMigrationReceipt({
      receiptId,
      createdAt: now.toISOString(),
      configBeforeSha: sha256(currentConfig),
      configAfterSha: await fileSha256OrMissing(configPath) || 'missing',
      authBeforeSha: authBefore.sha256 || 'missing',
      authAfterSha: authAfter.sha256 || 'missing',
      historicalState,
      newCatalogGeneration: input.newCatalogGeneration || null,
      rollbackFiles,
      blockers: ['desktop_bridge_unification_migration_failed'],
      authSemanticIdentityPreserved: authSemanticIdentityPreserved(authBefore, authAfter)
    });
    const rollback = rollbackFiles.length > 0
      ? await rollbackDesktopBridgeUnificationReceipt({ receipt: provisional, transactionLockHeld: true })
      : undefined;
    return {
      ...baseResult,
      ok: false,
      status: 'failed',
      managed_runtime: null,
      receipt_path: null,
      auth_semantic_identity_preserved: provisional.auth_semantic_identity_preserved,
      blockers: [
        // The cause used to live only in `error`, which nothing surfaced, so
        // every failure of this migration reached the operator as the same two
        // opaque codes and the advertised remedy (`retry_catalog_sync`) gave no
        // hint whether retrying could possibly help.
        migrationFailureBlocker(error),
        ...(rollback && !rollback.ok ? ['desktop_bridge_unification_rollback_failed'] : [])
      ],
      ...(rollback ? { rollback } : {}),
      error: errorMessage(error)
    };
  }
}

/**
 * `desktop_bridge_unification_migration_failed`, qualified by what actually
 * went wrong.
 *
 * Only a fixed-shape identifier is appended — a Node/`DesktopBridgeError` code
 * such as `ENOENT` or `EACCES`, or a lowercase `snake_case` message that is
 * already an error code. Free-form text is never appended: this blocker is
 * rendered to the operator and written to reports, and an arbitrary message can
 * carry a path or a value that does not belong there.
 */
export function migrationFailureBlocker(error: unknown): string {
  const base = 'desktop_bridge_unification_migration_failed';
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code)) return `${base}:${code}`;
  const message = errorMessage(error).trim();
  return /^[a-z0-9_]{1,64}$/.test(message) ? `${base}:${message}` : base;
}

function validateConfigTarget(home: string, configPath: string): void {
  const canonicalPath = path.join(path.resolve(home), '.codex', 'config.toml');
  if (!path.isAbsolute(configPath) || path.resolve(configPath) !== canonicalPath) {
    throw new Error('desktop_bridge_config_path_not_canonical');
  }
}
