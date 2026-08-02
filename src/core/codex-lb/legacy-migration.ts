import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_MODEL_CATALOG_MARKER,
  upsertCodexLbCompatDesktopConfig,
  upsertCodexLbNativeDesktopConfig
} from '../../cli/install-helpers-codex-lb-config.js';
import { codexAuthChatgptBackupPath } from '../../cli/install-helpers-codex-lb-shared.js';
import { ensureTrailingNewline, safeWriteCodexConfigToml } from '../codex-runtime/codex-desktop-config-policy.js';
import { messageOf as errorMessage } from '../errors/message.js';
import { ensureDir, readText } from '../fsx.js';
import {
  assertDesktopAuthUnchangedBySks,
  assertDesktopOAuthSemanticIdentity,
  captureCodexAuthSnapshot,
  codexAuthApiKeyMatches
} from './desktop-auth-invariant.js';
import {
  DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
  parseCodexLbGatewayAuthTransport,
  type CodexLbGatewayAuthTransport
} from './desktop-mode.js';
import {
  backupCodexLbMigrationFile,
  codexLbMigrationReceiptDir,
  createCodexLbMigrationReceiptId,
  finalizeCodexLbMigrationReceiptFiles,
  rollbackCodexLbMigrationReceipt,
  writeCodexLbMigrationReceipt,
  type CodexLbMigrationFileBackup,
  type CodexLbMigrationReceipt
} from './migration-receipt.js';

const LEGACY_OPENAI_ROUTING_MARKER = '# sks-codex-lb-managed-openai-base-url';

export interface LegacyCodexLbDesktopDetection {
  schema: 'sks.codex-lb-legacy-desktop-detection.v1';
  legacy_destructive_mode: boolean;
  auth_mode: string;
  auth_path: string;
  config_path: string;
  oauth_backup_path: string;
  oauth_backup_valid: boolean;
  oauth_backup_sha256: string | null;
  oauth_backup_owner_safe: boolean;
  oauth_backup_mode_safe: boolean;
  oauth_backup_identity_present: boolean;
  gateway_key_binding_checked: boolean;
  gateway_key_matches: boolean | null;
  provider_selected: boolean;
  provider_base_url: string | null;
  managed_openai_base_url: string | null;
  managed_remote_routing: boolean;
  recovery_evidence: boolean;
  prior_receipt_present: boolean;
  blockers: string[];
}

export type MigrateLegacyCodexLbDesktopTargetMode =
  | 'desktop-native-bridge'
  | 'desktop-dual-auth-compat';

export interface MigrateLegacyCodexLbDesktopOptions {
  home?: string;
  configPath?: string;
  authPath?: string;
  oauthBackupPath?: string;
  receiptDir?: string;
  bridgeBaseUrl: string;
  remoteBaseUrl?: string;
  bridgeStatePath?: string;
  bridgeSettingsPath?: string;
  bridgeLaunchAgentPath?: string;
  gatewayApiKey?: string;
  gatewayAuthTransport?: CodexLbGatewayAuthTransport;
  /** Defaults to desktop-native-bridge. Use compat when the local Node bridge cannot reach the gateway (for example Cloudflare 1010). */
  targetMode?: MigrateLegacyCodexLbDesktopTargetMode;
  capabilitySummary?: Record<string, string>;
  quitApp?: () => Promise<{ ok?: boolean; status?: string; skipped?: boolean } & Record<string, unknown>>;
  startBridge?: () => Promise<{ ok?: boolean; status?: string } & Record<string, unknown>>;
  stopBridge?: () => Promise<{ ok?: boolean; status?: string } & Record<string, unknown>>;
  restartApp?: () => Promise<{ ok?: boolean; status?: string } & Record<string, unknown>>;
  verifyCapabilities?: () => Promise<{
    ok: boolean;
    summary?: Record<string, string>;
    blockers?: string[];
  }>;
}

export interface MigrateLegacyCodexLbDesktopResult {
  schema: 'sks.codex-lb-legacy-migration.v1';
  ok: boolean;
  status: 'migrated' | 'not_legacy' | 'oauth_login_required' | 'restart_required' | 'failed';
  mode: MigrateLegacyCodexLbDesktopTargetMode;
  identity_plane: 'chatgpt_oauth' | 'unavailable';
  routing_plane: 'desktop_native_bridge' | 'desktop_dual_auth_compat' | 'unchanged';
  gateway_auth_transport: CodexLbGatewayAuthTransport;
  oauth_preserved: boolean;
  auth_path: string;
  config_path: string;
  receipt_path: string | null;
  receipt?: CodexLbMigrationReceipt;
  detection: LegacyCodexLbDesktopDetection;
  bridge?: Record<string, unknown>;
  bridge_stop?: Record<string, unknown>;
  quit_app?: Record<string, unknown>;
  rollback_quit_app?: Record<string, unknown>;
  restart_app?: Record<string, unknown>;
  capability_summary?: Record<string, string>;
  blockers: string[];
  rollback?: Awaited<ReturnType<typeof rollbackCodexLbMigrationReceipt>>;
  error?: string;
}

export async function detectLegacyCodexLbDesktopState(input: {
  home?: string;
  configPath?: string;
  authPath?: string;
  oauthBackupPath?: string;
  receiptDir?: string;
  remoteBaseUrl?: string;
  expectedGatewayApiKey?: string;
} = {}): Promise<LegacyCodexLbDesktopDetection> {
  const home = input.home || process.env.HOME || os.homedir();
  const configPath = input.configPath || path.join(home, '.codex', 'config.toml');
  const authPath = input.authPath || path.join(home, '.codex', 'auth.json');
  const oauthBackupPath = input.oauthBackupPath || codexAuthChatgptBackupPath(home);
  const receiptDir = input.receiptDir || codexLbMigrationReceiptDir(home);
  const [config, auth, backup, priorReceiptPresent, backupFile, gatewayKeyMatches] = await Promise.all([
    readText(configPath, ''),
    captureCodexAuthSnapshot({ home, authPath }),
    captureCodexAuthSnapshot({ home, authPath: oauthBackupPath }),
    hasPriorReceipt(receiptDir),
    inspectOAuthBackupFile(oauthBackupPath),
    input.expectedGatewayApiKey
      ? codexAuthApiKeyMatches({
          home,
          authPath,
          expectedApiKey: input.expectedGatewayApiKey
        })
      : Promise.resolve(null)
  ]);
  const providerSelected = topLevelTomlString(config, 'model_provider') === 'codex-lb';
  const providerBaseUrl = tomlTableString(config, 'model_providers.codex-lb', 'base_url') || null;
  const legacyOpenAiRoutingMarkerPresent = hasAnyTopLevelMarker(config, [
    LEGACY_OPENAI_ROUTING_MARKER
  ]);
  const managedOpenAiBaseUrl = hasAnyTopLevelMarker(config, [
    LEGACY_OPENAI_ROUTING_MARKER,
    CODEX_LB_DESKTOP_BRIDGE_MARKER
  ])
    ? topLevelTomlString(config, 'openai_base_url') || null
    : null;
  const expectedRemote = normalizeUrl(input.remoteBaseUrl || providerBaseUrl || '');
  const gatewayKeyBindingChecked = Boolean(input.expectedGatewayApiKey);
  const managedRemoteRouting = Boolean(
    managedOpenAiBaseUrl
    && expectedRemote
    && normalizeUrl(managedOpenAiBaseUrl) === expectedRemote
    && !isLoopbackUrl(managedOpenAiBaseUrl)
  );
  const catalogPath = topLevelTomlString(config, 'model_catalog_json');
  const cliProviderContract = Boolean(
    providerBaseUrl
    && expectedRemote
    && normalizeUrl(providerBaseUrl) === expectedRemote
    && !isLoopbackUrl(providerBaseUrl)
    && tomlTableString(config, 'model_providers.codex-lb', 'env_key') === 'CODEX_LB_API_KEY'
    && tomlTableBoolean(config, 'model_providers.codex-lb', 'requires_openai_auth') === false
  );
  // Includes restore orphans where model_provider=codex-lb remains selected with the
  // CLI provider contract, but openai_base_url was stripped (marker may still linger).
  // The older path only matched unselected orphans; selected+stripped left status saying
  // migrate while migrate returned not_legacy.
  const orphanedManagedRemoteRouting = Boolean(
    !topLevelTomlString(config, 'openai_base_url')
    && cliProviderContract
    && gatewayKeyMatches === true
    && (
      legacyOpenAiRoutingMarkerPresent
      || Boolean(catalogPath && isSksOwnedLegacyCatalogPath(catalogPath, home))
      || backup.mode === 'chatgpt_oauth'
      || backup.mode === 'mixed'
    )
  );
  const oauthBackupIdentityPresent = backup.semantic_fingerprint !== null;
  const oauthBackupValid = (
    (backup.mode === 'chatgpt_oauth' || backup.mode === 'mixed')
    && backupFile.owner_safe
    && backupFile.mode_safe
    && oauthBackupIdentityPresent
  );
  const recoveryEvidence = oauthBackupValid || priorReceiptPresent;
  const legacyDestructiveMode = auth.mode === 'openai_api_key'
    && gatewayKeyMatches === true
    && ((providerSelected && managedRemoteRouting) || orphanedManagedRemoteRouting);
  const blockers: string[] = [];
  if (auth.mode !== 'openai_api_key') blockers.push('legacy_auth_not_api_key_only');
  if (!gatewayKeyBindingChecked) blockers.push('legacy_gateway_key_binding_unavailable');
  else if (gatewayKeyMatches !== true) blockers.push('legacy_gateway_key_mismatch');
  if (!providerSelected && !orphanedManagedRemoteRouting) blockers.push('legacy_codex_lb_provider_not_selected');
  if (!managedRemoteRouting && !orphanedManagedRemoteRouting) {
    blockers.push('legacy_managed_remote_openai_routing_missing');
  }
  if (!recoveryEvidence) blockers.push('legacy_oauth_recovery_evidence_missing');
  return {
    schema: 'sks.codex-lb-legacy-desktop-detection.v1',
    legacy_destructive_mode: legacyDestructiveMode,
    auth_mode: auth.mode,
    auth_path: authPath,
    config_path: configPath,
    oauth_backup_path: oauthBackupPath,
    oauth_backup_valid: oauthBackupValid,
    oauth_backup_sha256: backup.sha256,
    oauth_backup_owner_safe: backupFile.owner_safe,
    oauth_backup_mode_safe: backupFile.mode_safe,
    oauth_backup_identity_present: oauthBackupIdentityPresent,
    gateway_key_binding_checked: gatewayKeyBindingChecked,
    gateway_key_matches: gatewayKeyMatches,
    provider_selected: providerSelected,
    provider_base_url: providerBaseUrl,
    managed_openai_base_url: managedOpenAiBaseUrl,
    managed_remote_routing: managedRemoteRouting,
    recovery_evidence: recoveryEvidence,
    prior_receipt_present: priorReceiptPresent,
    blockers
  };
}

export async function migrateLegacyCodexLbDesktop(
  input: MigrateLegacyCodexLbDesktopOptions
): Promise<MigrateLegacyCodexLbDesktopResult> {
  const home = input.home || process.env.HOME || os.homedir();
  const configPath = input.configPath || path.join(home, '.codex', 'config.toml');
  const authPath = input.authPath || path.join(home, '.codex', 'auth.json');
  const oauthBackupPath = input.oauthBackupPath || codexAuthChatgptBackupPath(home);
  const receiptDir = input.receiptDir || codexLbMigrationReceiptDir(home);
  const gatewayAuthTransport = parseCodexLbGatewayAuthTransport(
    input.gatewayAuthTransport || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT
  );
  const targetMode: MigrateLegacyCodexLbDesktopTargetMode = input.targetMode === 'desktop-dual-auth-compat'
    ? 'desktop-dual-auth-compat'
    : 'desktop-native-bridge';
  if (desktopCompatMigrationUnavailable(targetMode)) {
    return {
      schema: 'sks.codex-lb-legacy-migration.v1',
      ok: false,
      status: 'failed',
      mode: targetMode,
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      gateway_auth_transport: gatewayAuthTransport,
      oauth_preserved: false,
      auth_path: authPath,
      config_path: configPath,
      receipt_path: null,
      detection: await detectLegacyCodexLbDesktopState({
        home,
        configPath,
        authPath,
        oauthBackupPath,
        receiptDir,
        ...(input.remoteBaseUrl ? { remoteBaseUrl: input.remoteBaseUrl } : {}),
        ...(input.gatewayApiKey ? { expectedGatewayApiKey: input.gatewayApiKey } : {})
      }),
      blockers: ['desktop_dual_auth_compat_requires_global_secret_environment'],
      error: 'desktop_dual_auth_compat_requires_global_secret_environment'
    };
  }
  const detection = await detectLegacyCodexLbDesktopState({
    home,
    configPath,
    authPath,
    oauthBackupPath,
    receiptDir,
    ...(input.remoteBaseUrl ? { remoteBaseUrl: input.remoteBaseUrl } : {}),
    ...(input.gatewayApiKey ? { expectedGatewayApiKey: input.gatewayApiKey } : {})
  });
  const baseResult = {
    schema: 'sks.codex-lb-legacy-migration.v1' as const,
    mode: targetMode,
    gateway_auth_transport: gatewayAuthTransport,
    auth_path: authPath,
    config_path: configPath,
    detection
  };
  if (!detection.legacy_destructive_mode) {
    return {
      ...baseResult,
      ok: false,
      status: 'not_legacy',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      blockers: detection.blockers
    };
  }
  if (!detection.oauth_backup_valid) {
    return {
      ...baseResult,
      ok: false,
      status: 'oauth_login_required',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      blockers: ['valid_chatgpt_oauth_backup_required', 'run_codex_login']
    };
  }
  const remoteBaseUrl = normalizeUrl(input.remoteBaseUrl || detection.provider_base_url || '');
  if (!remoteBaseUrl) {
    return {
      ...baseResult,
      ok: false,
      status: 'failed',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      blockers: ['missing_remote_base_url'],
      error: 'missing_remote_base_url'
    };
  }
  if (!input.restartApp) {
    return {
      ...baseResult,
      ok: false,
      status: 'restart_required',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      blockers: ['codex_app_restart_required', 'rerun_with_restart_app']
    };
  }
  if (!input.quitApp) {
    return {
      ...baseResult,
      ok: false,
      status: 'restart_required',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      blockers: ['codex_app_quit_required', 'rerun_with_restart_app']
    };
  }

  const quitApp = await input.quitApp();
  if (quitApp.ok !== true || quitApp.skipped === true) {
    return {
      ...baseResult,
      ok: false,
      status: 'failed',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      quit_app: quitApp,
      blockers: ['codex_app_quiescence_required'],
      error: `codex_app_quit_failed:${quitApp.status || 'failed'}`
    };
  }
  const quiescedDetection = await detectLegacyCodexLbDesktopState({
    home,
    configPath,
    authPath,
    oauthBackupPath,
    receiptDir,
    ...(input.remoteBaseUrl ? { remoteBaseUrl: input.remoteBaseUrl } : {}),
    ...(input.gatewayApiKey ? { expectedGatewayApiKey: input.gatewayApiKey } : {})
  });
  const stateStableAfterQuit = quiescedDetection.legacy_destructive_mode
    && quiescedDetection.gateway_key_matches === true
    && quiescedDetection.oauth_backup_valid
    && quiescedDetection.oauth_backup_sha256 === detection.oauth_backup_sha256
    && quiescedDetection.provider_base_url === detection.provider_base_url
    && quiescedDetection.managed_openai_base_url === detection.managed_openai_base_url;
  if (!stateStableAfterQuit) {
    return {
      ...baseResult,
      detection: quiescedDetection,
      ok: false,
      status: 'failed',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      quit_app: quitApp,
      blockers: ['legacy_state_changed_during_quiescence', ...quiescedDetection.blockers],
      error: 'legacy_state_changed_during_quiescence'
    };
  }

  const receiptId = createCodexLbMigrationReceiptId();
  const backupDir = path.join(receiptDir, receiptId, 'files');
  const currentConfig = await readText(configPath, '');
  const catalogPath = topLevelTomlString(currentConfig, 'model_catalog_json');
  const paths = [
    { path: configPath, owned: false },
    { path: authPath, owned: false },
    ...(catalogPath ? [{ path: catalogPath, owned: isSksOwnedLegacyCatalogPath(catalogPath, home) }] : []),
    ...(input.bridgeSettingsPath ? [{ path: input.bridgeSettingsPath, owned: true }] : []),
    ...(input.bridgeLaunchAgentPath ? [{ path: input.bridgeLaunchAgentPath, owned: true }] : []),
    ...(input.bridgeStatePath ? [{ path: input.bridgeStatePath, owned: true }] : [])
  ];
  const backups: CodexLbMigrationFileBackup[] = [];
  let bridgeAttempted = false;
  let restartAttempted = false;
  try {
    for (const file of uniquePaths(paths)) {
      backups.push(await backupCodexLbMigrationFile(file.path, backupDir, file.owned));
    }
    if (
      !input.gatewayApiKey
      || !await codexAuthApiKeyMatches({
        home,
        authPath,
        expectedApiKey: input.gatewayApiKey
      })
    ) {
      throw new Error('legacy_gateway_key_changed_before_auth_restore');
    }
    const oauthBytes = await fsp.readFile(oauthBackupPath);
    if (sha256(oauthBytes) !== quiescedDetection.oauth_backup_sha256) {
      throw new Error('oauth_backup_changed_before_restore');
    }
    await writeBufferAtomic(authPath, oauthBytes);
    const oauthBaseline = await captureCodexAuthSnapshot({ home, authPath });
    if (oauthBaseline.mode !== 'chatgpt_oauth' && oauthBaseline.mode !== 'mixed') {
      throw new Error('restored_oauth_backup_invalid');
    }
    assertDesktopOAuthSemanticIdentity(
      await captureCodexAuthSnapshot({ home, authPath: oauthBackupPath }),
      oauthBaseline
    );

    let configForMigration = currentConfig;
    configForMigration = removeTopLevelTomlKey(configForMigration, 'model_provider');
    configForMigration = removeTopLevelTomlKey(configForMigration, 'openai_base_url');
    configForMigration = removeTopLevelMarker(configForMigration, LEGACY_OPENAI_ROUTING_MARKER);
    if (catalogPath && isSksOwnedLegacyCatalogPath(catalogPath, home)) {
      configForMigration = removeTopLevelTomlKey(configForMigration, 'model_catalog_json');
      configForMigration = removeTopLevelMarker(configForMigration, CODEX_LB_MODEL_CATALOG_MARKER);
    }
    const nextConfig = targetMode === 'desktop-dual-auth-compat'
      ? upsertCodexLbCompatDesktopConfig(configForMigration, { remoteBaseUrl })
      : upsertCodexLbNativeDesktopConfig(configForMigration, {
          bridgeBaseUrl: input.bridgeBaseUrl,
          remoteBaseUrl
        });
    const configWrite = await safeWriteCodexConfigToml(
      configPath,
      currentConfig,
      nextConfig,
      'codex-lb-legacy-desktop-migration',
      { verifyUnchangedBeforeWrite: true }
    );
    if (!configWrite.ok) throw new Error(`legacy_config_write_failed:${configWrite.status}`);
    const afterConfigBeforeRestart = await captureCodexAuthSnapshot({ home, authPath });
    await assertDesktopAuthUnchangedBySks(oauthBaseline, afterConfigBeforeRestart);

    let bridge: Record<string, unknown> | undefined;
    if (targetMode === 'desktop-native-bridge') {
      bridgeAttempted = Boolean(input.startBridge);
      bridge = input.startBridge ? await input.startBridge() : undefined;
      if (bridge?.ok === false) throw new Error(`desktop_bridge_start_failed:${bridge.status || 'failed'}`);
    } else if (input.stopBridge) {
      bridge = await input.stopBridge();
      if (bridge?.ok === false) throw new Error(`desktop_bridge_stop_failed:${bridge.status || 'failed'}`);
    }
    const beforeRestart = await captureCodexAuthSnapshot({ home, authPath });
    await assertDesktopAuthUnchangedBySks(oauthBaseline, beforeRestart);
    restartAttempted = true;
    const restartApp = await input.restartApp();
    if (restartApp.ok !== true) throw new Error(`codex_app_restart_failed:${restartApp.status || 'failed'}`);
    const afterRestart = await captureCodexAuthSnapshot({ home, authPath });
    assertDesktopOAuthSemanticIdentity(oauthBaseline, afterRestart);
    const capability = input.verifyCapabilities ? await input.verifyCapabilities() : undefined;
    if (capability && !capability.ok) {
      throw new Error(`desktop_capability_verification_failed:${(capability.blockers || []).join(',') || 'failed'}`);
    }
    const routingPlane = targetMode === 'desktop-dual-auth-compat'
      ? 'desktop_dual_auth_compat'
      : 'desktop_native_bridge';
    const capabilitySummary = {
      ...(input.capabilitySummary || {}),
      ...(capability?.summary || {}),
      gateway_auth_transport: gatewayAuthTransport,
      identity_plane: 'chatgpt_oauth',
      routing_plane: routingPlane,
      oauth_backup_sha256: quiescedDetection.oauth_backup_sha256 || 'unavailable'
    };
    const receipt: CodexLbMigrationReceipt = {
      schema: 'sks.codex-lb-migration-receipt.v1',
      id: receiptId,
      created_at: new Date().toISOString(),
      from_mode: 'legacy-destructive-api-key-auth',
      to_mode: targetMode,
      files: await finalizeCodexLbMigrationReceiptFiles(backups),
      bridge_state_path: input.bridgeStatePath || null,
      oauth_preserved: true,
      capability_summary: capabilitySummary
    };
    const receiptPath = await writeCodexLbMigrationReceipt(receipt, { receiptDir });
    return {
      ...baseResult,
      detection: quiescedDetection,
      ok: true,
      status: 'migrated',
      identity_plane: 'chatgpt_oauth',
      routing_plane: routingPlane,
      oauth_preserved: true,
      receipt_path: receiptPath,
      receipt,
      ...(bridge ? { bridge } : {}),
      quit_app: quitApp,
      restart_app: restartApp,
      capability_summary: capabilitySummary,
      blockers: []
    };
  } catch (error: unknown) {
    const rollbackQuit = restartAttempted
      ? await input.quitApp().catch((quitError: unknown) => ({
          ok: false,
          status: 'failed',
          skipped: false,
          error: errorMessage(quitError)
        }))
      : undefined;
    if (rollbackQuit && (rollbackQuit.ok !== true || rollbackQuit.skipped === true)) {
      return {
        ...baseResult,
        detection: quiescedDetection,
        ok: false,
        status: 'failed',
        identity_plane: 'chatgpt_oauth',
        routing_plane: 'desktop_native_bridge',
        oauth_preserved: true,
        receipt_path: null,
        quit_app: quitApp,
        rollback_quit_app: rollbackQuit,
        blockers: [
          'legacy_migration_failed',
          'legacy_migration_rollback_quiescence_failed'
        ],
        error: errorMessage(error)
      };
    }
    const bridgeStop = bridgeAttempted && input.stopBridge
      ? await input.stopBridge().catch((stopError: unknown) => ({
          ok: false,
          status: 'failed',
          error: errorMessage(stopError)
        }))
      : undefined;
    if (
      bridgeAttempted
      && (
        !bridgeStop
        || bridgeStop.ok !== true
        || (bridgeStop as Record<string, unknown>).running === true
      )
    ) {
      return {
        ...baseResult,
        detection: quiescedDetection,
        ok: false,
        status: 'failed',
        identity_plane: 'chatgpt_oauth',
        routing_plane: 'desktop_native_bridge',
        oauth_preserved: true,
        receipt_path: null,
        ...(bridgeStop ? { bridge_stop: bridgeStop } : {}),
        quit_app: quitApp,
        ...(rollbackQuit ? { rollback_quit_app: rollbackQuit } : {}),
        blockers: [
          'legacy_migration_failed',
          'legacy_migration_bridge_stop_unverified',
          'legacy_migration_manual_recovery_required'
        ],
        error: errorMessage(error)
      };
    }
    const provisionalReceipt: CodexLbMigrationReceipt = {
      schema: 'sks.codex-lb-migration-receipt.v1',
      id: receiptId,
      created_at: new Date().toISOString(),
      from_mode: 'legacy-destructive-api-key-auth',
      to_mode: 'desktop-native-bridge',
      files: await finalizeCodexLbMigrationReceiptFiles(backups),
      bridge_state_path: input.bridgeStatePath || null,
      oauth_preserved: false,
      capability_summary: {}
    };
    const rollback = await rollbackCodexLbMigrationReceipt({ receipt: provisionalReceipt });
    return {
      ...baseResult,
      detection: quiescedDetection,
      ok: false,
      status: 'failed',
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      oauth_preserved: false,
      receipt_path: null,
      ...(bridgeStop ? { bridge_stop: bridgeStop } : {}),
      quit_app: quitApp,
      ...(rollbackQuit ? { rollback_quit_app: rollbackQuit } : {}),
      blockers: [
        'legacy_migration_failed',
        ...(bridgeStop?.ok === false ? ['legacy_migration_bridge_stop_failed'] : []),
        ...(rollback.ok ? [] : ['legacy_migration_rollback_failed'])
      ],
      rollback,
      error: errorMessage(error)
    };
  }
}

async function hasPriorReceipt(receiptDir: string): Promise<boolean> {
  try {
    return (await fsp.readdir(receiptDir)).some((entry) => entry.endsWith('.json'));
  } catch {
    return false;
  }
}

async function inspectOAuthBackupFile(filePath: string): Promise<{
  owner_safe: boolean;
  mode_safe: boolean;
}> {
  try {
    const stat = await fsp.lstat(filePath);
    const expectedUid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    return {
      owner_safe: stat.isFile() && !stat.isSymbolicLink() && stat.uid === expectedUid,
      mode_safe: (stat.mode & 0o777) === 0o600
    };
  } catch {
    return {
      owner_safe: false,
      mode_safe: false
    };
  }
}

function uniquePaths(paths: Array<{ path: string; owned: boolean }>): Array<{ path: string; owned: boolean }> {
  const seen = new Map<string, boolean>();
  for (const entry of paths) {
    const resolved = path.resolve(entry.path);
    seen.set(resolved, (seen.get(resolved) || false) || entry.owned);
  }
  return [...seen].map(([filePath, owned]) => ({ path: filePath, owned }));
}

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[1] || '';
}

function tomlTableString(text: string, table: string, key: string): string {
  const escapedTable = escapeRegExp(table);
  const block = String(text || '').match(new RegExp(`(?:^|\\n)\\[${escapedTable}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`))?.[1] || '';
  return block.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[1] || '';
}

function tomlTableBoolean(text: string, table: string, key: string): boolean | null {
  const escapedTable = escapeRegExp(table);
  const block = String(text || '').match(new RegExp(`(?:^|\\n)\\[${escapedTable}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`))?.[1] || '';
  const value = block.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*(true|false)\\s*(?:#.*)?(?=\\n|$)`))?.[1];
  return value === 'true' ? true : value === 'false' ? false : null;
}

function hasAnyTopLevelMarker(text: string, markers: string[]): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((line) => markers.includes(line.trim()));
}

function removeTopLevelTomlKey(text: string, key: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
  return ensureTrailingNewline(lines.filter((line, index) => index >= end || !keyPattern.test(line)).join('\n'));
}

function removeTopLevelMarker(text: string, marker: string): string {
  const lines = String(text || '').split('\n');
  const firstTable = lines.findIndex((line) => /^\s*\[.+\]\s*$/.test(line));
  const end = firstTable === -1 ? lines.length : firstTable;
  return ensureTrailingNewline(lines.filter((line, index) => index >= end || line.trim() !== marker).join('\n'));
}

function isSksOwnedLegacyCatalogPath(catalogPath: string, home: string): boolean {
  return path.resolve(catalogPath) === path.resolve(home, '.codex', 'sks-codex-lb-tool-catalog.json');
}

function normalizeUrl(value: string): string {
  return String(value || '').trim().replace(/\/+$/, '');
}

function isLoopbackUrl(value: string): boolean {
  return /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(value);
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
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function desktopCompatMigrationUnavailable(mode: unknown): boolean {
  return mode === 'desktop-dual-auth-compat';
}
