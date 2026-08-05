import { createHash } from 'node:crypto';
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
import { ensureDir, readText } from '../fsx.js';
import { escapeRegExp } from '../text/regex.js';
import type { BridgeProviderId } from './bridge-contracts.js';
import { captureCodexAuthSnapshot } from './desktop-auth-invariant.js';
import {
  backupDesktopBridgeMigrationFile,
  createDesktopBridgeUnificationReceiptId,
  desktopBridgeUnificationReceiptDir,
  fileSha256OrMissing,
  finalizeDesktopBridgeMigrationReceiptFiles,
  rollbackDesktopBridgeUnificationReceipt,
  writeDesktopBridgeUnificationReceipt,
  type DesktopBridgeMigrationFileBackup,
  type DesktopBridgeRollbackMetadataFile,
  type DesktopBridgeRollbackMetadataKind,
  type StoredDesktopBridgeUnificationReceipt
} from './migration-receipt.js';

const HISTORICAL_PROVIDER_MODE_MARKER = '# sks-managed-provider-mode:';
const HISTORICAL_DESKTOP_BRIDGE_MARKER = '# sks-codex-lb-managed-desktop-bridge';
const HISTORICAL_DESKTOP_COMPAT_MARKER = '# sks-codex-lb-managed-desktop-compat';
const HISTORICAL_PROVIDER_SELECTION_MARKER = '# sks-codex-lb-managed-provider-selection';
const HISTORICAL_OAUTH_SELECTION_MARKER = '# sks-codex-lb-managed-oauth-selection';
const HISTORICAL_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';
const HISTORICAL_MODEL_CATALOG_MARKER = '# sks-codex-lb-managed-model-catalog';
const CANONICAL_OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1';

type HistoricalProviderMode = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';
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

interface HistoricalProviderConfigState {
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

/**
 * Inspect secret-free provider intent before catalog construction. This parser
 * is deliberately pure: callers supply config text and no filesystem state is
 * read or written. Only historical SKS markers and known provider tables are
 * interpreted; ambiguous user-owned selections fail closed.
 */
export function inspectHistoricalDesktopBridgeIntent(
  configText: string
): HistoricalDesktopBridgeIntent {
  const source = String(configText || '');
  const topLevel = source.split(/\n\s*\[/)[0] || '';
  const markerValues = topLevel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER))
    .map((line) => line.slice(HISTORICAL_PROVIDER_MODE_MARKER.length).trim());
  const providerMode = markerValues.length === 1 && isHistoricalProviderMode(markerValues[0])
    ? markerValues[0]
    : null;
  const selectedProvider = topLevelTomlString(source, 'model_provider') || null;
  const nativeBridge = hasTopLevelMarker(source, HISTORICAL_DESKTOP_BRIDGE_MARKER);
  const compatBridge = hasTopLevelMarker(source, HISTORICAL_DESKTOP_COMPAT_MARKER);
  const managedCodexLbSelection = hasTopLevelMarker(source, HISTORICAL_PROVIDER_SELECTION_MARKER);
  const managedOAuthSelection = hasTopLevelMarker(source, HISTORICAL_OAUTH_SELECTION_MARKER);
  const codexLbPresent = hasTomlTable(source, 'model_providers.codex-lb');
  const openRouterPresent = hasTomlTable(source, 'model_providers.openrouter');
  const combinedRouterPresent = hasTomlTable(source, 'model_providers.sks-router');
  const blockers: string[] = [];

  if (markerValues.length > 1) blockers.push('historical_provider_marker_conflict');
  else if (markerValues.length === 1 && !providerMode) blockers.push('historical_provider_marker_invalid');
  if (nativeBridge && compatBridge) blockers.push('historical_desktop_marker_conflict');
  if (nativeBridge && selectedProvider !== 'openai') {
    blockers.push('historical_native_bridge_selection_mismatch');
  }
  if (compatBridge && selectedProvider !== 'codex-lb') {
    blockers.push('historical_compat_bridge_selection_mismatch');
  }
  if (managedCodexLbSelection && selectedProvider !== 'codex-lb') {
    blockers.push('historical_codex_lb_selection_marker_mismatch');
  }
  if (managedOAuthSelection && selectedProvider !== 'openai') {
    blockers.push('historical_oauth_selection_marker_mismatch');
  }

  const knownSelections = new Set(['openai', 'codex-lb', 'openrouter', 'sks-router']);
  if (selectedProvider && !knownSelections.has(selectedProvider)) {
    blockers.push('historical_user_owned_provider_selection_conflict');
  } else if (
    selectedProvider === 'codex-lb'
    && !compatBridge
    && !managedCodexLbSelection
    && providerMode !== 'codex-lb'
  ) {
    blockers.push('historical_user_owned_provider_selection_conflict');
  } else if (selectedProvider === 'openrouter' && !openRouterPresent) {
    blockers.push('historical_openrouter_selection_table_missing');
  } else if (selectedProvider === 'sks-router' && !combinedRouterPresent) {
    blockers.push('historical_combined_router_table_missing');
  }

  if (
    providerMode === 'chatgpt-oauth'
    && selectedProvider !== null
    && selectedProvider !== 'openai'
  ) blockers.push('historical_provider_mode_selection_mismatch');
  if (
    providerMode === 'codex-lb'
    && selectedProvider !== null
    && selectedProvider !== 'openai'
    && selectedProvider !== 'codex-lb'
  ) blockers.push('historical_provider_mode_selection_mismatch');
  if (
    providerMode === 'openrouter'
    && selectedProvider !== null
    && selectedProvider !== 'openai'
    && selectedProvider !== 'openrouter'
  ) blockers.push('historical_provider_mode_selection_mismatch');

  const rawCodexLbEndpoint = tomlTableString(source, 'model_providers.codex-lb', 'base_url');
  const codexLbEndpoint = codexLbPresent
    ? secretFreeProviderEndpoint(rawCodexLbEndpoint)
    : null;
  if (codexLbPresent && !codexLbEndpoint) blockers.push('historical_codex_lb_endpoint_invalid');
  const rawOpenRouterEndpoint = tomlTableString(source, 'model_providers.openrouter', 'base_url');
  const openRouterEndpoint = rawOpenRouterEndpoint === CANONICAL_OPENROUTER_ENDPOINT
    ? CANONICAL_OPENROUTER_ENDPOINT
    : null;
  if (openRouterPresent && !openRouterEndpoint) {
    blockers.push('historical_openrouter_endpoint_not_canonical');
  }

  if ((nativeBridge || compatBridge || managedCodexLbSelection || providerMode === 'codex-lb') && !codexLbPresent) {
    blockers.push('historical_codex_lb_table_missing');
  }
  if ((selectedProvider === 'openrouter' || providerMode === 'openrouter') && !openRouterPresent) {
    blockers.push('historical_openrouter_table_missing');
  }

  const codexLbTransport = codexLbPresent
    ? compatBridge
      || tomlTableBoolean(source, 'model_providers.codex-lb', 'requires_openai_auth') === true
      || tomlTableContainsCustomHeader(source, 'model_providers.codex-lb')
        ? 'x-codex-lb-api-key' as const
        : 'authorization-bearer' as const
    : null;
  let defaultProvider: BridgeProviderId | null = null;
  if (providerMode === 'codex-lb' || nativeBridge || compatBridge || selectedProvider === 'codex-lb') {
    defaultProvider = 'codex-lb';
  } else if (providerMode === 'openrouter' || selectedProvider === 'openrouter') {
    defaultProvider = 'openrouter';
  }

  const uniqueBlockers = [...new Set(blockers)];
  const usable = uniqueBlockers.length === 0;
  return {
    schema: 'sks.desktop-bridge-historical-intent.v1',
    blockers: uniqueBlockers,
    providers: {
      'codex-lb': {
        present: codexLbPresent,
        enabled: usable && codexLbPresent,
        endpoint_url: codexLbEndpoint,
        auth_transport: codexLbTransport
      },
      openrouter: {
        present: openRouterPresent,
        enabled: usable && openRouterPresent,
        endpoint_url: openRouterEndpoint,
        auth_transport: openRouterPresent ? 'openrouter-bearer' : null
      }
    },
    default_provider_id: usable ? defaultProvider : null
  };
}

/**
 * Convert SKS-owned historical routing metadata into the only current runtime:
 * Desktop Bridge. Historical strings are parsed here only; they never become a
 * selectable mode or an active runtime dependency.
 */
export async function migrateDesktopBridgeConfig(
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
      blockers: [message.startsWith('legacy_user_owned_config_conflict')
        ? 'legacy_user_owned_config_conflict'
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
    for (const update of metadataUpdates) {
      const backup = backups.find((entry) => path.resolve(entry.path) === path.resolve(update.path));
      if (!backup) throw new Error(`desktop_bridge_metadata_backup_missing:${update.path}`);
      if (await fileSha256OrMissing(update.path) !== backup.before_sha256) {
        throw new Error(`desktop_bridge_metadata_changed_during_migration:${update.path}`);
      }
      if (sha256(update.text) !== backup.before_sha256) {
        mutatedPaths.add(path.resolve(update.path));
        await writeBufferAtomic(update.path, Buffer.from(update.text));
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
    const receipt = buildReceipt({
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
    const provisional = buildReceipt({
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
      ? await rollbackDesktopBridgeUnificationReceipt({ receipt: provisional })
      : undefined;
    return {
      ...baseResult,
      ok: false,
      status: 'failed',
      managed_runtime: null,
      receipt_path: null,
      auth_semantic_identity_preserved: provisional.auth_semantic_identity_preserved,
      blockers: [
        'desktop_bridge_unification_migration_failed',
        ...(rollback && !rollback.ok ? ['desktop_bridge_unification_rollback_failed'] : [])
      ],
      ...(rollback ? { rollback } : {}),
      error: errorMessage(error)
    };
  }
}

function validateConfigTarget(home: string, configPath: string): void {
  const canonicalPath = path.join(path.resolve(home), '.codex', 'config.toml');
  if (!path.isAbsolute(configPath) || path.resolve(configPath) !== canonicalPath) {
    throw new Error('desktop_bridge_config_path_not_canonical');
  }
}

/**
 * Decode validated historical top-level routing into an unselected config for
 * the current writer. Provider tables and all credentials remain byte-stable.
 */
function prepareHistoricalConfigForDesktopBridgeWriter(
  text: string,
  state: HistoricalProviderConfigState
): string {
  const source = String(text || '');
  if ([
    DESKTOP_BRIDGE_MANAGED_MARKER,
    DESKTOP_BRIDGE_MANAGED_BASE_URL_MARKER,
    DESKTOP_BRIDGE_MANAGED_MODEL_CATALOG_MARKER
  ].every((marker) => hasTopLevelMarker(source, marker))) return source;

  const historicalMarkers = [
    HISTORICAL_DESKTOP_BRIDGE_MARKER,
    HISTORICAL_DESKTOP_COMPAT_MARKER,
    HISTORICAL_PROVIDER_SELECTION_MARKER,
    HISTORICAL_OAUTH_SELECTION_MARKER,
    HISTORICAL_OPENAI_ROUTING_MARKER,
    HISTORICAL_MODEL_CATALOG_MARKER
  ];
  const hasHistoricalMarker = historicalMarkers.some((marker) => hasTopLevelMarker(source, marker));
  const hasHistoricalMode = topLevelLines(source)
    .some((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER));
  const codexLbSelectionOwned = state.model_provider === 'codex-lb'
    && (hasHistoricalMarker || state.provider_mode === 'codex-lb');
  const knownThirdPartySelection = state.model_provider === 'openrouter'
    || state.model_provider === 'sks-router';
  const historicalOpenAiSelection = state.model_provider === 'openai'
    && (hasHistoricalMarker || hasHistoricalMode);

  let next = source;
  if (codexLbSelectionOwned || knownThirdPartySelection || historicalOpenAiSelection) {
    next = removeTopLevelKey(next, 'model_provider');
  }
  if (
    hasTopLevelMarker(source, HISTORICAL_DESKTOP_BRIDGE_MARKER)
    || hasTopLevelMarker(source, HISTORICAL_OPENAI_ROUTING_MARKER)
  ) next = removeTopLevelKey(next, 'openai_base_url');

  const historicalCatalog = state.catalog_path || '';
  const historicalCatalogOwned = hasTopLevelMarker(source, HISTORICAL_MODEL_CATALOG_MARKER)
    || [
      'sks-codex-lb-tool-catalog.json',
      'sks-openrouter-catalog.json',
      'opencodex-catalog.json'
    ].includes(path.basename(historicalCatalog));
  if (historicalCatalogOwned) next = removeTopLevelKey(next, 'model_catalog_json');

  for (const marker of historicalMarkers) next = removeTopLevelExactLine(next, marker);
  next = removeTopLevelLinesWithPrefix(next, HISTORICAL_PROVIDER_MODE_MARKER);
  return next;
}

function topLevelLines(text: string): string[] {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).map((line) => line.trim());
}

function removeTopLevelKey(text: string, key: string): string {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return filterTopLevelLines(text, (line) => !pattern.test(line));
}

function removeTopLevelExactLine(text: string, target: string): string {
  return filterTopLevelLines(text, (line) => line.trim() !== target);
}

function removeTopLevelLinesWithPrefix(text: string, prefix: string): string {
  return filterTopLevelLines(text, (line) => !line.trim().startsWith(prefix));
}

function filterTopLevelLines(text: string, keep: (line: string) => boolean): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  return lines
    .filter((line, index) => index >= end || keep(line))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

function parseHistoricalProviderConfig(text: string): HistoricalProviderConfigState {
  const source = String(text || '');
  const topLevel = source.split(/\n\s*\[/)[0] || '';
  const markerValues = topLevel
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(HISTORICAL_PROVIDER_MODE_MARKER))
    .map((line) => line.slice(HISTORICAL_PROVIDER_MODE_MARKER.length).trim());
  const providerMode = markerValues.length === 1 && isHistoricalProviderMode(markerValues[0])
    ? markerValues[0]
    : null;
  const modelProvider = topLevelTomlString(source, 'model_provider') || null;
  const catalogPath = topLevelTomlString(source, 'model_catalog_json') || null;
  const markers = [
    HISTORICAL_DESKTOP_BRIDGE_MARKER,
    HISTORICAL_DESKTOP_COMPAT_MARKER,
    HISTORICAL_PROVIDER_SELECTION_MARKER,
    HISTORICAL_OAUTH_SELECTION_MARKER,
    HISTORICAL_OPENAI_ROUTING_MARKER,
    HISTORICAL_MODEL_CATALOG_MARKER
  ].filter((marker) => hasTopLevelMarker(source, marker));
  const migratedProfiles = new Set<BridgeProviderId>();
  if (
    providerMode === 'codex-lb'
    || modelProvider === 'codex-lb'
    || hasTomlTable(source, 'model_providers.codex-lb')
    || markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
  ) migratedProfiles.add('codex-lb');
  if (
    providerMode === 'openrouter'
    || modelProvider === 'openrouter'
    || hasTomlTable(source, 'model_providers.openrouter')
  ) migratedProfiles.add('openrouter');
  if (modelProvider === 'sks-router' || hasTomlTable(source, 'model_providers.sks-router')) {
    if (hasTomlTable(source, 'model_providers.codex-lb')) migratedProfiles.add('codex-lb');
    if (hasTomlTable(source, 'model_providers.openrouter')) migratedProfiles.add('openrouter');
  }
  const blockers: string[] = [];
  if (markerValues.length > 1) blockers.push('historical_provider_marker_conflict');
  else if (markerValues.length === 1 && !providerMode) blockers.push('historical_provider_marker_invalid');
  const desktopMode = markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
    ? 'desktop-dual-auth-compat'
    : markers.includes(HISTORICAL_DESKTOP_BRIDGE_MARKER)
      ? 'desktop-native-bridge'
      : modelProvider === 'codex-lb'
        ? 'cli-provider'
        : null;
  const gatewayAuthTransport = markers.includes(HISTORICAL_DESKTOP_COMPAT_MARKER)
    || tomlTableBoolean(source, 'model_providers.codex-lb', 'requires_openai_auth') === true
      ? 'x-codex-lb-api-key' as const
      : hasTomlTable(source, 'model_providers.codex-lb')
        ? 'authorization-bearer' as const
        : null;
  return {
    desktop_mode: desktopMode,
    provider_mode: providerMode,
    model_provider: modelProvider,
    catalog_path: catalogPath,
    migrated_profiles: [...migratedProfiles].sort() as BridgeProviderId[],
    gateway_auth_transport: gatewayAuthTransport,
    blockers
  };
}

function buildReceipt(input: {
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
    legacy_state: {
      desktop_mode: input.historicalState.desktop_mode,
      provider_mode: input.historicalState.provider_mode,
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

function isHistoricalProviderMode(value: unknown): value is HistoricalProviderMode {
  return value === 'chatgpt-oauth' || value === 'codex-lb' || value === 'openrouter';
}

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1] || '';
}

function hasTopLevelMarker(text: string, marker: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((line) => line.trim() === marker);
}

function hasTomlTable(text: string, table: string): boolean {
  return new RegExp(`(?:^|\\n)\\s*\\[${escapeRegExp(table)}\\]\\s*(?=\\n|$)`).test(text);
}

function tomlTableString(text: string, table: string, key: string): string | null {
  const block = tomlTableBlock(text, table);
  return block.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1] || null;
}

function tomlTableBoolean(text: string, table: string, key: string): boolean | null {
  const block = tomlTableBlock(text, table);
  const value = block.match(
    new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\n|$)`)
  )?.[1];
  return value === 'true' ? true : value === 'false' ? false : null;
}

function tomlTableContainsCustomHeader(text: string, table: string): boolean {
  return /(?:^|[\s"'{,])x-codex-lb-api-key(?:[\s"'}=,]|$)/i.test(tomlTableBlock(text, table));
}

function tomlTableBlock(text: string, table: string): string {
  return String(text || '').match(
    new RegExp(`(?:^|\\n)\\s*\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\s*\\[[^\\]]+\\]|\\s*$)`)
  )?.[1] || '';
}

function secretFreeProviderEndpoint(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
      || !parsed.hostname
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function authSemanticIdentityPreserved(
  before: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>,
  after: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>
): boolean {
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

function validateMetadataUpdates(
  updates: DesktopBridgeMigrationMetadataUpdate[],
  protectedPaths: { home: string; configPath: string; authPath: string }
): void {
  const seen = new Set<string>();
  for (const update of updates) {
    const filePath = path.resolve(String(update.path || ''));
    if (!update.path || !path.isAbsolute(update.path)) {
      throw new Error('desktop_bridge_metadata_path_invalid');
    }
    if (filePath === path.resolve(protectedPaths.configPath)) {
      throw new Error('desktop_bridge_metadata_config_path_forbidden');
    }
    if (filePath === path.resolve(protectedPaths.authPath) || metadataPathLooksSecret(filePath)) {
      throw new Error('desktop_bridge_metadata_secret_path_forbidden');
    }
    const expectedPath = canonicalMetadataPath(protectedPaths.home, update.kind);
    if (filePath !== expectedPath) {
      throw new Error(`desktop_bridge_metadata_path_not_canonical:${update.kind}`);
    }
    if (seen.has(filePath)) throw new Error('desktop_bridge_metadata_path_duplicate');
    seen.add(filePath);
    if (!['bridge_settings', 'catalog_binding', 'route_policy', 'launchd_state'].includes(update.kind)) {
      throw new Error('desktop_bridge_metadata_kind_invalid');
    }
    if (typeof update.text !== 'string') throw new Error('desktop_bridge_metadata_text_invalid');
  }
}

function canonicalMetadataPath(home: string, kind: DesktopBridgeMigrationMetadataUpdate['kind']): string {
  const resolvedHome = path.resolve(home);
  if (kind === 'bridge_settings') {
    return path.join(resolvedHome, '.codex', 'sks', 'codex-lb-desktop-bridge-settings.json');
  }
  if (kind === 'catalog_binding') {
    return path.join(resolvedHome, '.codex', 'sks', 'sks-bridge-active-generation.json');
  }
  if (kind === 'route_policy') {
    return path.join(resolvedHome, '.codex', 'sks', 'sks-bridge-route-policy.json');
  }
  return path.join(
    resolvedHome,
    'Library',
    'LaunchAgents',
    'com.sneakoscope.codex-lb-desktop-bridge.plist'
  );
}

function normalizedMetadataUpdates(
  updates: DesktopBridgeMigrationMetadataUpdate[]
): DesktopBridgeMigrationMetadataUpdate[] {
  return updates.map((update) => ({ ...update, path: path.resolve(update.path) }));
}

function metadataPathLooksSecret(filePath: string): boolean {
  const basename = path.basename(filePath).toLowerCase();
  const segments = filePath.toLowerCase().split(path.sep);
  return segments.includes('secrets')
    || ['auth.json', 'sks-codex-lb.env', 'openrouter-api-key', 'openrouter-api-key.json'].includes(basename)
    || /(?:credential|api-key|secret)/i.test(basename);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeBufferAtomic(filePath: string, bytes: Buffer): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await fsp.writeFile(tempPath, bytes, { mode: 0o600, flag: 'wx' });
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, 0o600);
  } catch (error: unknown) {
    await fsp.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}
