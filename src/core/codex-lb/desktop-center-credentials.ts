import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { exists, runProcess } from '../fsx.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  isLexicallyConfined,
  publicPathError
} from '../managed-path-safety.js';
import {
  CODEX_LB_LEGACY_KEYCHAIN_SERVICE,
  CODEX_LB_SECURE_KEYCHAIN_SERVICE,
  codexLbBaseUrlSecurityBlocker,
  codexLbEnvPath,
  codexLbMetadataPath,
  loadCodexLbEnv,
  normalizeCodexLbBaseUrl,
  parseShellEnvValue,
  type CodexLbEnvLoadResult
} from './codex-lb-env.js';
import type { CodexLbDesktopMode } from './desktop-mode.js';
import {
  PrivateCredentialFileError,
  createPrivateTextExclusive,
  hardenPrivateCredentialFileMode,
  readPrivateCredentialFile,
  writePrivateTextAtomic,
  type PrivateCredentialFileSnapshot
} from '../security/private-credential-file.js';

/**
 * Center → official SKS store → live Desktop credential path.
 *
 * The official Center store is the only credential source. Secrets are never
 * copied into launchctl/global GUI state. Modes that require that transport
 * fail closed and direct the caller to the local bridge.
 */

export const CODEX_LB_STALE_ENV_TWINS = ['codex-lb.env', 'sks.env'] as const;
export const CODEX_LB_STALE_KEYCHAIN_SERVICES = [CODEX_LB_LEGACY_KEYCHAIN_SERVICE] as const;
export const CODEX_LB_OFFICIAL_KEYCHAIN_SERVICE = CODEX_LB_SECURE_KEYCHAIN_SERVICE;
export const CODEX_LB_STALE_TWIN_PROVENANCE_MARKER = '# sks-codex-lb-managed-credential-twin' as const;
export const CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA = 'sks.codex-lb-keychain-migration.v2' as const;
export const CODEX_LB_KEYCHAIN_MIGRATION_STAMP_SCHEMA = 'sks.codex-lb-keychain-migration-stamp.v1' as const;

function credentialToolEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  delete sanitized.CODEX_LB_API_KEY;
  delete sanitized.OPENROUTER_API_KEY;
  return sanitized;
}

export type CodexLbKeychainMigrationReceipt = {
  schema: typeof CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA;
  verified: true;
  legacy_service: typeof CODEX_LB_LEGACY_KEYCHAIN_SERVICE;
  legacy_account: string;
  replacement_store: 'owner_only_env_file';
  replacement_store_path: string;
  replacement_store_sha256: string;
  metadata_path: string;
  metadata_sha256: string;
  api_key_sha256: string;
};

export type CodexLbLegacyKeychainMigrationResult = {
  schema: 'sks.codex-lb-legacy-keychain-reconciliation.v1';
  ok: boolean;
  status: string;
  mode: 'inspect' | 'repair';
  env_key_valid: boolean;
  keychain_item_present: boolean | null;
  prompt_risk: 'none' | 'one_time_on_repair';
  attempted: boolean;
  stamp_path: string;
  stamp_outcome: string | null;
  keychain_deleted: boolean;
  keychain_cleared: string[];
  blockers: string[];
};

export type CodexLbLegacyKeychainMigrationOptions = {
  home?: string;
  baseUrl?: string;
  envPath?: string;
  metadataPath?: string;
  account?: string;
  platform?: NodeJS.Platform;
  securityBin?: string;
  runProcessImpl?: typeof runProcess;
  expectedApiKeySha256?: string;
  env?: NodeJS.ProcessEnv;
  processEnv?: NodeJS.ProcessEnv;
  force?: boolean;
  forceRetry?: boolean;
  retryAttempt?: boolean;
  testHooks?: {
    beforeStampPublish?: (tempPath: string) => void | Promise<void>;
    beforeStampOutcomeWrite?: (outcome: string) => void | Promise<void>;
  };
};

type CodexLbLegacyKeychainMigrationStamp = {
  schema: typeof CODEX_LB_KEYCHAIN_MIGRATION_STAMP_SCHEMA;
  attempted: true;
  attempted_at: string;
  updated_at: string;
  outcome: string;
  legacy_service: typeof CODEX_LB_LEGACY_KEYCHAIN_SERVICE;
  legacy_account: string;
};

export type DesktopCenterCredentialSyncResult = {
  schema: 'sks.codex-lb-desktop-center-credentials.v1';
  ok: boolean;
  status: string;
  mode: CodexLbDesktopMode | string;
  api_key_fingerprint: string | null;
  base_url_present: boolean;
  launch_env: {
    api_key: 'set' | 'unset' | 'skipped' | 'failed';
    base_url: 'set' | 'unset' | 'skipped' | 'failed';
  };
  stale_twins_removed: string[];
  stale_twins_quarantined: string[];
  stale_keychain_cleared: string[];
  blockers: string[];
  operator_actions: string[];
};

export type DesktopCenterCredentialInspectionResult = {
  schema: 'sks.codex-lb-desktop-center-credential-inspection.v1';
  ok: boolean;
  status: string;
  mode: CodexLbDesktopMode | string;
  expected_api_key_sha256: string | null;
  launch_api_key_sha256: string | null;
  launch_api_key_present: boolean;
  blockers: string[];
  operator_actions: string[];
};

function codexLbCredentialStorageActions(home: string): string[] {
  return [
    `Store the key in ${codexLbEnvPath(home)} (owner-only mode 0600).`,
    'Run: sks codex-lb setup --host <domain> --api-key-stdin --yes',
    'Alternatively, provide CODEX_LB_API_KEY in the launching environment.'
  ];
}

export async function loadOfficialCodexLbCredentials(opts: {
  home?: string;
  envPath?: string;
  metadataPath?: string;
  loadCodexLbEnvImpl?: typeof loadCodexLbEnv;
} = {}): Promise<CodexLbEnvLoadResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const load = opts.loadCodexLbEnvImpl || loadCodexLbEnv;
  // Ignore ambient process.env so a stale shell export cannot shadow Center.
  return load({
    home,
    processEnv: {},
    envPath: opts.envPath || codexLbEnvPath(home),
    ...(opts.metadataPath ? { metadataPath: opts.metadataPath } : {})
  });
}

export function codexLbLegacyKeychainMigrationStampPath(
  home: unknown = process.env.HOME || os.homedir()
): string {
  return path.join(String(home || os.homedir()), '.codex', 'sks-codex-lb-keychain-migration.json');
}

export async function inspectCodexLbLegacyKeychainMigration(
  opts: CodexLbLegacyKeychainMigrationOptions = {}
): Promise<CodexLbLegacyKeychainMigrationResult> {
  return reconcileCodexLbLegacyKeychainMigration('inspect', opts);
}

export async function repairCodexLbLegacyKeychainMigration(
  opts: CodexLbLegacyKeychainMigrationOptions = {}
): Promise<CodexLbLegacyKeychainMigrationResult> {
  return reconcileCodexLbLegacyKeychainMigration('repair', opts);
}

async function reconcileCodexLbLegacyKeychainMigration(
  mode: 'inspect' | 'repair',
  opts: CodexLbLegacyKeychainMigrationOptions
): Promise<CodexLbLegacyKeychainMigrationResult> {
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const codexHome = path.join(home, '.codex');
  const envPath = path.resolve(opts.envPath || codexLbEnvPath(home));
  const metadataPath = path.resolve(opts.metadataPath || codexLbMetadataPath(home));
  const stampPath = codexLbLegacyKeychainMigrationStampPath(home);
  const account = String(opts.account || opts.env?.USER || opts.processEnv?.USER || process.env.USER || 'sks').trim();
  const result = (fields: Partial<CodexLbLegacyKeychainMigrationResult>): CodexLbLegacyKeychainMigrationResult => ({
    schema: 'sks.codex-lb-legacy-keychain-reconciliation.v1',
    ok: false,
    status: 'blocked',
    mode,
    env_key_valid: false,
    keychain_item_present: null,
    prompt_risk: 'none',
    attempted: false,
    stamp_path: stampPath,
    stamp_outcome: null,
    keychain_deleted: false,
    keychain_cleared: [],
    blockers: [],
    ...fields
  });
  if ((opts.platform || process.platform) !== 'darwin') {
    return result({ ok: true, status: 'not_macos' });
  }
  if (!isLexicallyConfined(codexHome, envPath) || !isLexicallyConfined(codexHome, metadataPath)) {
    return result({
      status: 'credential_path_outside_codex_home',
      blockers: ['codex_lb_credential_path_outside_codex_home']
    });
  }

  let loaded = await loadOfficialCodexLbCredentials({ home, envPath, metadataPath });
  if (mode === 'repair' && loaded.blockers?.includes('codex_lb_env_file_mode_not_0600')) {
    try {
      await hardenPrivateCredentialFileMode(codexHome, envPath, 'codex_lb_env_file');
      loaded = await loadOfficialCodexLbCredentials({ home, envPath, metadataPath });
    } catch (error: unknown) {
      return result({
        status: 'env_file_mode_repair_failed',
        blockers: [publicPathError(error, envPath)]
      });
    }
  }
  const envKeyValid = loaded.api_key.usable && loaded.api_key.source === 'env-file';
  const unsafeEnvBlockers = (loaded.blockers || []).filter((blocker) => blocker.startsWith('codex_lb_env_file_'));
  if (unsafeEnvBlockers.length > 0) {
    return result({
      status: 'env_file_unsafe',
      env_key_valid: false,
      blockers: unsafeEnvBlockers
    });
  }

  const stampRead = await readCodexLbLegacyKeychainMigrationStamp(codexHome, stampPath);
  if (stampRead.blocker) {
    return result({
      status: 'migration_stamp_invalid',
      env_key_valid: envKeyValid,
      blockers: [stampRead.blocker]
    });
  }
  const retryAttempt = mode === 'repair'
    && (opts.forceRetry === true || opts.retryAttempt === true || opts.force === true);
  const completedTransfer = stampRead.stamp?.outcome === 'migrated';
  if (stampRead.stamp && !retryAttempt && (!envKeyValid || completedTransfer)) {
    return result({
      ok: stampRead.stamp.outcome === 'migrated',
      status: 'already_attempted',
      env_key_valid: envKeyValid,
      attempted: true,
      stamp_outcome: stampRead.stamp.outcome,
      blockers: stampRead.stamp.outcome === 'migrated'
        ? []
        : [`legacy_keychain_migration_already_attempted:${stampRead.stamp.outcome}`]
    });
  }

  const security = opts.securityBin || (await exists('/usr/bin/security') ? '/usr/bin/security' : null);
  if (!security) {
    return result({
      status: 'security_unavailable',
      env_key_valid: envKeyValid,
      blockers: ['legacy_keychain_security_unavailable']
    });
  }
  const run = opts.runProcessImpl || runProcess;
  const toolEnv = credentialToolEnvironment(opts.env || opts.processEnv || process.env);

  if (mode === 'repair' && envKeyValid) {
    const replacement = await verifyCodexLbLegacyKeychainReplacementStore({
      home,
      envPath,
      metadataPath,
      account,
      ...(opts.expectedApiKeySha256 ? { expectedApiKeySha256: opts.expectedApiKeySha256 } : {})
    });
    if (!replacement.ok || !replacement.receipt) {
      return result({
        status: 'replacement_store_unverified',
        env_key_valid: true,
        blockers: replacement.blockers.length
          ? replacement.blockers
          : ['legacy_keychain_replacement_store_unverified']
      });
    }
    const cleanup = await purgeStaleCodexLbCredentialTwins({
      home,
      account,
      platform: 'darwin',
      securityBin: security,
      runProcessImpl: run,
      env: toolEnv,
      skipStaleEnvTwins: true,
      legacyKeychainMigrationReceipt: replacement.receipt
    });
    const keychainDeleted = cleanup.keychain_cleared.includes(CODEX_LB_LEGACY_KEYCHAIN_SERVICE);
    return result({
      ok: cleanup.blockers.length === 0,
      status: cleanup.blockers.length > 0
        ? 'legacy_keychain_cleanup_failed'
        : keychainDeleted ? 'legacy_keychain_removed' : 'legacy_keychain_absent',
      env_key_valid: true,
      keychain_deleted: keychainDeleted,
      keychain_cleared: cleanup.keychain_cleared,
      blockers: cleanup.blockers
    });
  }

  const attributeProbe = await run(security, [
    'find-generic-password',
    '-a',
    account,
    '-s',
    CODEX_LB_LEGACY_KEYCHAIN_SERVICE
  ], {
    timeoutMs: 5000,
    maxOutputBytes: 8192,
    env: toolEnv,
    envMode: 'replace'
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const keychainItemPresent = attributeProbe.code === 0;
  if (!keychainItemPresent && !keychainItemMissing(attributeProbe)) {
    return result({
      status: 'legacy_keychain_probe_failed',
      env_key_valid: envKeyValid,
      blockers: ['legacy_keychain_attribute_probe_failed']
    });
  }
  if (!keychainItemPresent) {
    return result({
      ok: true,
      status: 'legacy_keychain_absent',
      env_key_valid: envKeyValid,
      keychain_item_present: false
    });
  }
  if (mode === 'inspect') {
    return result({
      ok: true,
      status: envKeyValid ? 'legacy_keychain_cleanup_available' : 'legacy_keychain_migration_available',
      env_key_valid: envKeyValid,
      keychain_item_present: true,
      prompt_risk: envKeyValid ? 'none' : 'one_time_on_repair'
    });
  }
  const migrationBaseUrl = normalizeCodexLbBaseUrl(opts.baseUrl || loaded.base_url || '');
  const migrationBaseUrlBlocker = migrationBaseUrl ? codexLbBaseUrlSecurityBlocker(migrationBaseUrl) : null;
  if (!migrationBaseUrl || migrationBaseUrlBlocker) {
    return result({
      status: 'base_url_missing',
      env_key_valid: false,
      keychain_item_present: true,
      prompt_risk: 'one_time_on_repair',
      blockers: [migrationBaseUrlBlocker || 'codex_lb_base_url_missing_for_keychain_migration']
    });
  }

  const attemptedAt = new Date().toISOString();
  const pendingStamp: CodexLbLegacyKeychainMigrationStamp = {
    schema: CODEX_LB_KEYCHAIN_MIGRATION_STAMP_SCHEMA,
    attempted: true,
    attempted_at: attemptedAt,
    updated_at: attemptedAt,
    outcome: 'pending',
    legacy_service: CODEX_LB_LEGACY_KEYCHAIN_SERVICE,
    legacy_account: account
  };
  try {
    const claimed = retryAttempt
      ? await writeCodexLbLegacyKeychainMigrationStamp(codexHome, stampPath, pendingStamp).then(() => true)
      : await createPrivateTextExclusive(
          codexHome,
          stampPath,
          `${JSON.stringify(pendingStamp, null, 2)}\n`,
          'legacy_keychain_migration_stamp',
          opts.testHooks?.beforeStampPublish
            ? { beforePublish: opts.testHooks.beforeStampPublish }
            : {}
        );
    if (!claimed) {
      return result({
        status: 'already_attempted',
        env_key_valid: false,
        keychain_item_present: true,
        attempted: true,
        stamp_outcome: 'pending',
        blockers: ['legacy_keychain_migration_already_attempted:pending']
      });
    }
  } catch (error: unknown) {
    return result({
      status: 'migration_stamp_write_failed',
      env_key_valid: false,
      keychain_item_present: true,
      blockers: [publicPathError(error, stampPath)]
    });
  }

  const secretRead = await run(security, [
    'find-generic-password',
    '-w',
    '-a',
    account,
    '-s',
    CODEX_LB_LEGACY_KEYCHAIN_SERVICE
  ], {
    timeoutMs: 30_000,
    maxOutputBytes: 65_536,
    env: toolEnv,
    envMode: 'replace'
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const apiKey = secretRead.code === 0 ? String(secretRead.stdout || '').trim() : '';
  if (!apiKey) {
    const outcome = secretRead.code === 0 ? 'keychain_value_empty' : 'keychain_read_failed_or_cancelled';
    const outcomePersisted = await persistCodexLbLegacyKeychainMigrationOutcome(
      codexHome, stampPath, pendingStamp, outcome, opts
    );
    if (!outcomePersisted) {
      return result({
        status: 'migration_stamp_outcome_write_failed',
        env_key_valid: false,
        keychain_item_present: true,
        attempted: true,
        stamp_outcome: 'pending',
        blockers: ['migration_stamp_outcome_write_failed']
      });
    }
    return result({
      status: outcome,
      env_key_valid: false,
      keychain_item_present: true,
      attempted: true,
      stamp_outcome: outcome,
      blockers: [`legacy_keychain_migration_${outcome}`]
    });
  }

  const apiKeySha256 = sha256Bytes(Buffer.from(apiKey));
  const envText = [
    `export CODEX_LB_BASE_URL=${shellSingleQuote(migrationBaseUrl)}`,
    `export CODEX_LB_API_KEY=${shellSingleQuote(apiKey)}`,
    ''
  ].join('\n');
  const metadataText = `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: migrationBaseUrl,
    updated_at: new Date().toISOString(),
    source: 'legacy_keychain_migration',
    api_key: {
      redacted: true,
      sha256: apiKeySha256,
      preview: previewCredential(apiKey)
    }
  }, null, 2)}\n`;
  try {
    await writePrivateTextAtomic(codexHome, envPath, envText, 'codex_lb_env_file');
    await writePrivateTextAtomic(codexHome, metadataPath, metadataText, 'codex_lb_metadata');
  } catch (error: unknown) {
    const outcome = 'credential_write_failed';
    const outcomePersisted = await persistCodexLbLegacyKeychainMigrationOutcome(
      codexHome, stampPath, pendingStamp, outcome, opts
    );
    if (!outcomePersisted) {
      return result({
        status: 'migration_stamp_outcome_write_failed',
        env_key_valid: false,
        keychain_item_present: true,
        attempted: true,
        stamp_outcome: 'pending',
        blockers: ['migration_stamp_outcome_write_failed', publicPathError(error, envPath)]
      });
    }
    return result({
      status: outcome,
      env_key_valid: false,
      keychain_item_present: true,
      attempted: true,
      stamp_outcome: outcome,
      blockers: [publicPathError(error, envPath)]
    });
  }

  const replacement = await verifyCodexLbLegacyKeychainReplacementStore({
    home,
    envPath,
    metadataPath,
    account,
    expectedApiKeySha256: apiKeySha256
  });
  const cleanup = replacement.receipt
    ? await purgeStaleCodexLbCredentialTwins({
        home,
        account,
        platform: 'darwin',
        securityBin: security,
        runProcessImpl: run,
        env: toolEnv,
        skipStaleEnvTwins: true,
        legacyKeychainMigrationReceipt: replacement.receipt
      })
    : { keychain_cleared: [] as string[], blockers: replacement.blockers };
  const keychainDeleted = cleanup.keychain_cleared.includes(CODEX_LB_LEGACY_KEYCHAIN_SERVICE);
  const outcome = replacement.ok && cleanup.blockers.length === 0
    ? 'migrated'
    : keychainDeleted ? 'post_write_verification_failed' : 'keychain_delete_failed';
  const outcomePersisted = await persistCodexLbLegacyKeychainMigrationOutcome(
    codexHome, stampPath, pendingStamp, outcome, opts
  );
  if (!outcomePersisted) {
    return result({
      status: 'migration_stamp_outcome_write_failed',
      env_key_valid: replacement.ok,
      keychain_item_present: true,
      attempted: true,
      stamp_outcome: 'pending',
      keychain_deleted: keychainDeleted,
      keychain_cleared: cleanup.keychain_cleared,
      blockers: ['migration_stamp_outcome_write_failed']
    });
  }
  return result({
    ok: outcome === 'migrated',
    status: outcome,
    env_key_valid: replacement.ok,
    keychain_item_present: true,
    attempted: true,
    stamp_outcome: outcome,
    keychain_deleted: keychainDeleted,
    keychain_cleared: cleanup.keychain_cleared,
    blockers: outcome === 'migrated'
      ? []
      : [...new Set([...replacement.blockers, ...cleanup.blockers])]
  });
}

async function readCodexLbLegacyKeychainMigrationStamp(
  codexHome: string,
  stampPath: string
): Promise<{ stamp: CodexLbLegacyKeychainMigrationStamp | null; blocker: string | null }> {
  let snapshot;
  try {
    snapshot = await readPrivateCredentialFile(codexHome, stampPath, 'legacy_keychain_migration_stamp');
  } catch (error: unknown) {
    if (error instanceof PrivateCredentialFileError && error.code === 'missing') {
      return { stamp: null, blocker: null };
    }
    return { stamp: null, blocker: publicPathError(error, stampPath) };
  }
  try {
    const value = JSON.parse(snapshot.bytes.toString('utf8')) as CodexLbLegacyKeychainMigrationStamp;
    if (value.schema !== CODEX_LB_KEYCHAIN_MIGRATION_STAMP_SCHEMA
      || value.attempted !== true
      || !value.outcome
      || value.legacy_service !== CODEX_LB_LEGACY_KEYCHAIN_SERVICE) {
      return { stamp: null, blocker: 'legacy_keychain_migration_stamp_invalid' };
    }
    return { stamp: value, blocker: null };
  } catch {
    return { stamp: null, blocker: 'legacy_keychain_migration_stamp_invalid' };
  }
}

async function writeCodexLbLegacyKeychainMigrationStamp(
  codexHome: string,
  stampPath: string,
  stamp: CodexLbLegacyKeychainMigrationStamp
): Promise<void> {
  await writePrivateTextAtomic(codexHome, stampPath, `${JSON.stringify(stamp, null, 2)}\n`, 'legacy_keychain_migration_stamp');
}

async function updateCodexLbLegacyKeychainMigrationStamp(
  codexHome: string,
  stampPath: string,
  stamp: CodexLbLegacyKeychainMigrationStamp,
  outcome: string
): Promise<void> {
  await writeCodexLbLegacyKeychainMigrationStamp(codexHome, stampPath, {
    ...stamp,
    updated_at: new Date().toISOString(),
    outcome
  });
}

async function persistCodexLbLegacyKeychainMigrationOutcome(
  codexHome: string,
  stampPath: string,
  stamp: CodexLbLegacyKeychainMigrationStamp,
  outcome: string,
  opts: CodexLbLegacyKeychainMigrationOptions
): Promise<boolean> {
  try {
    await opts.testHooks?.beforeStampOutcomeWrite?.(outcome);
    await updateCodexLbLegacyKeychainMigrationStamp(codexHome, stampPath, stamp, outcome);
    return true;
  } catch {
    return false;
  }
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function previewCredential(value: string): string {
  return value.length <= 8 ? '***' : `${value.slice(0, 4)}...${value.slice(-4)}`;
}


export async function verifyCodexLbLegacyKeychainReplacementStore(opts: {
  home?: string;
  envPath?: string;
  metadataPath?: string;
  account?: string;
  expectedApiKeySha256?: string;
} = {}): Promise<{
  ok: boolean;
  receipt: CodexLbKeychainMigrationReceipt | null;
  blockers: string[];
}> {
  const home = path.resolve(opts.home || process.env.HOME || os.homedir());
  const codexHome = path.join(home, '.codex');
  const envPath = path.resolve(opts.envPath || codexLbEnvPath(home));
  const metadataPath = path.resolve(opts.metadataPath || codexLbMetadataPath(home));
  const account = String(opts.account || process.env.USER || 'sks').trim();
  const blockers: string[] = [];
  if (!account) blockers.push('legacy_keychain_account_missing');
  if (!isLexicallyConfined(codexHome, envPath)) blockers.push('replacement_store_outside_codex_home');
  if (!isLexicallyConfined(codexHome, metadataPath)) blockers.push('replacement_metadata_outside_codex_home');
  if (blockers.length > 0) return { ok: false, receipt: null, blockers };

  let envSnapshot: PrivateCredentialFileSnapshot;
  let metadataSnapshot: PrivateCredentialFileSnapshot;
  try {
    [envSnapshot, metadataSnapshot] = await Promise.all([
      readPrivateCredentialFile(codexHome, envPath, 'replacement_store'),
      readPrivateCredentialFile(codexHome, metadataPath, 'replacement_metadata')
    ]);
  } catch (error: unknown) {
    return {
      ok: false,
      receipt: null,
      blockers: [publicPathError(error, envPath)]
    };
  }

  const envText = envSnapshot.bytes.toString('utf8');
  const apiKey = parseShellEnvValue(envText, 'CODEX_LB_API_KEY');
  const baseUrl = normalizeCodexLbBaseUrl(parseShellEnvValue(envText, 'CODEX_LB_BASE_URL'));
  const apiKeySha256 = apiKey ? sha256Bytes(Buffer.from(apiKey)) : '';
  let metadata: any = null;
  try {
    metadata = JSON.parse(metadataSnapshot.bytes.toString('utf8'));
  } catch {
    blockers.push('replacement_metadata_json_invalid');
  }
  const metadataBaseUrl = normalizeCodexLbBaseUrl(metadata?.base_url || '');
  const metadataApiKeySha256 = String(metadata?.api_key?.sha256 || '').trim().toLowerCase();
  if (!apiKey) blockers.push('replacement_store_api_key_missing');
  if (!baseUrl) blockers.push('replacement_store_base_url_missing');
  if (metadata?.schema !== 'sks.codex-lb-metadata.v1') blockers.push('replacement_metadata_schema_invalid');
  if (!/^[a-f0-9]{64}$/.test(metadataApiKeySha256)) blockers.push('replacement_metadata_api_key_sha256_invalid');
  if (apiKeySha256 && metadataApiKeySha256 !== apiKeySha256) blockers.push('replacement_store_metadata_key_mismatch');
  if (baseUrl && metadataBaseUrl !== baseUrl) blockers.push('replacement_store_metadata_base_url_mismatch');
  const expectedApiKeySha256 = String(opts.expectedApiKeySha256 || '').trim().toLowerCase();
  if (expectedApiKeySha256 && expectedApiKeySha256 !== apiKeySha256) {
    blockers.push('replacement_store_expected_key_mismatch');
  }
  if (blockers.length > 0) return { ok: false, receipt: null, blockers: [...new Set(blockers)] };

  return {
    ok: true,
    receipt: {
      schema: CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA,
      verified: true,
      legacy_service: CODEX_LB_LEGACY_KEYCHAIN_SERVICE,
      legacy_account: account,
      replacement_store: 'owner_only_env_file',
      replacement_store_path: envPath,
      replacement_store_sha256: envSnapshot.sha256,
      metadata_path: metadataPath,
      metadata_sha256: metadataSnapshot.sha256,
      api_key_sha256: apiKeySha256
    },
    blockers: []
  };
}

export async function purgeStaleCodexLbCredentialTwins(opts: {
  home?: string;
  account?: string;
  securityBin?: string;
  runProcessImpl?: typeof runProcess;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  legacyKeychainMigrationReceipt?: CodexLbKeychainMigrationReceipt;
  skipStaleEnvTwins?: boolean;
  skipLegacyKeychainCleanup?: boolean;
  beforeTwinRename?: (input: { name: string; target: string; quarantinePath: string }) => void | Promise<void>;
  afterTwinRename?: (input: { name: string; target: string; quarantinePath: string }) => void | Promise<void>;
} = {}): Promise<{ removed: string[]; quarantined: string[]; keychain_cleared: string[]; blockers: string[] }> {
  const home = opts.home || process.env.HOME || os.homedir();
  const codexHome = path.join(home, '.codex');
  const removed: string[] = [];
  const quarantined: string[] = [];
  const blockers: string[] = [];
  const quarantineDir = path.join(codexHome, 'sks', 'quarantine', 'codex-lb-credentials');
  if (!opts.skipStaleEnvTwins) {
    for (const name of CODEX_LB_STALE_ENV_TWINS) {
      const target = path.join(codexHome, name);
      try {
        const snapshot = await captureStaleTwin(target);
        if (!snapshot) continue;
        if (snapshot.kind !== 'regular') {
          blockers.push(`stale_twin_not_regular_file:${name}`);
          continue;
        }
        const text = snapshot.bytes.toString('utf8');
        if (!text.split(/\r?\n/).some((line) => line.trim() === CODEX_LB_STALE_TWIN_PROVENANCE_MARKER)) {
          blockers.push(`stale_twin_unprovenanced:${name}`);
          continue;
        }
        await ensurePrivateQuarantineDirectory(codexHome, quarantineDir);
        const quarantinePath = path.join(
          quarantineDir,
          `${Date.now().toString(36)}-${process.pid}-${randomBytes(8).toString('hex')}-${name}`
        );
        await opts.beforeTwinRename?.({ name, target, quarantinePath });
        await fsp.rename(target, quarantinePath);
        await opts.afterTwinRename?.({ name, target, quarantinePath });
        const claimed = await captureStaleTwin(quarantinePath);
        if (!staleTwinSnapshotsEqual(snapshot, claimed)) {
          const restored = await restoreStaleTwinClaimIfAbsent(quarantinePath, target, claimed);
          if (!restored) quarantined.push(quarantinePath);
          blockers.push(`stale_twin_concurrent_change:${name}`);
          continue;
        }
        if (!await hardenStaleTwinClaim(quarantinePath, snapshot)) {
          const restored = await restoreStaleTwinClaimIfAbsent(quarantinePath, target, claimed);
          if (!restored) quarantined.push(quarantinePath);
          blockers.push(`stale_twin_quarantine_hardening_failed:${name}`);
          continue;
        }
        removed.push(target);
        quarantined.push(quarantinePath);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
          blockers.push(`stale_twin_remove_failed:${name}`);
        }
      }
    }
  }

  const keychainCleared: string[] = [];
  if ((opts.platform || process.platform) === 'darwin' && !opts.skipLegacyKeychainCleanup) {
    const receiptValidation = await validateLegacyKeychainMigrationReceipt({
      home,
      account: opts.account || process.env.USER || 'sks',
      ...(opts.legacyKeychainMigrationReceipt
        ? { receipt: opts.legacyKeychainMigrationReceipt }
        : {})
    });
    const legacyDeletionProven = receiptValidation.ok;
    const security = opts.securityBin
      || (await exists('/usr/bin/security') ? '/usr/bin/security' : null);
    const account = opts.account || process.env.USER || 'sks';
    const run = opts.runProcessImpl || runProcess;
    const toolEnv = credentialToolEnvironment(opts.env || process.env);
    if (security) {
      for (const service of CODEX_LB_STALE_KEYCHAIN_SERVICES) {
        const command = legacyDeletionProven ? 'delete-generic-password' : 'find-generic-password';
        const result = await run(security, [
          command,
          '-a',
          account,
          '-s',
          service
        ], {
          timeoutMs: 5000,
          maxOutputBytes: 8192,
          env: toolEnv,
          envMode: 'replace'
        }).catch((error: unknown) => ({
          code: 1,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error)
        }));
        // errSecItemNotFound is success for purge.
        if (result.code === 0) {
          if (!legacyDeletionProven) {
            blockers.push(...receiptValidation.blockers);
            blockers.push(`legacy_keychain_migration_required:${service}`);
            continue;
          }
          const verification = await run(security, [
            'find-generic-password',
            '-a',
            account,
            '-s',
            service
          ], {
            timeoutMs: 5000,
            maxOutputBytes: 8192,
            env: toolEnv,
            envMode: 'replace'
          }).catch((error: unknown) => ({
            code: 1,
            stdout: '',
            stderr: error instanceof Error ? error.message : String(error)
          }));
          if (keychainItemMissing(verification)) keychainCleared.push(service);
          else blockers.push(`stale_keychain_cleanup_verification_failed:${service}`);
        } else if (/could not be found|errSecItemNotFound|-25300/i.test(String(result.stderr || result.stdout || ''))) {
          // Already absent.
        } else {
          blockers.push(`stale_keychain_cleanup_failed:${service}`);
        }
      }
    } else {
      blockers.push('stale_keychain_cleanup_unavailable');
    }
  }

  return { removed, quarantined, keychain_cleared: keychainCleared, blockers };
}

async function validateLegacyKeychainMigrationReceipt(input: {
  home: string;
  account: string;
  receipt?: CodexLbKeychainMigrationReceipt;
}): Promise<{ ok: boolean; blockers: string[] }> {
  const receipt = input.receipt;
  if (!receipt) return { ok: false, blockers: [] };
  const structural = receipt.schema === CODEX_LB_KEYCHAIN_MIGRATION_RECEIPT_SCHEMA
    && receipt.verified === true
    && receipt.legacy_service === CODEX_LB_LEGACY_KEYCHAIN_SERVICE
    && receipt.legacy_account === input.account
    && receipt.replacement_store === 'owner_only_env_file'
    && /^[a-f0-9]{64}$/.test(receipt.replacement_store_sha256)
    && /^[a-f0-9]{64}$/.test(receipt.metadata_sha256)
    && /^[a-f0-9]{64}$/.test(receipt.api_key_sha256);
  if (!structural) return { ok: false, blockers: ['legacy_keychain_migration_receipt_invalid'] };
  const verified = await verifyCodexLbLegacyKeychainReplacementStore({
    home: input.home,
    envPath: receipt.replacement_store_path,
    metadataPath: receipt.metadata_path,
    account: input.account,
    expectedApiKeySha256: receipt.api_key_sha256
  });
  if (!verified.ok || !verified.receipt) {
    return {
      ok: false,
      blockers: ['legacy_keychain_migration_receipt_stale', ...verified.blockers]
    };
  }
  const current = verified.receipt;
  const unchanged = current.replacement_store_sha256 === receipt.replacement_store_sha256
    && current.metadata_sha256 === receipt.metadata_sha256
    && current.api_key_sha256 === receipt.api_key_sha256;
  return unchanged
    ? { ok: true, blockers: [] }
    : { ok: false, blockers: ['legacy_keychain_migration_receipt_stale'] };
}

function keychainItemMissing(result: { code: number | null; stdout?: string; stderr?: string }): boolean {
  return result.code !== 0
    && /could not be found|errSecItemNotFound|-25300/i.test(String(result.stderr || result.stdout || ''));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

type StaleTwinSnapshot =
  | { kind: 'regular'; bytes: Buffer; mode: number; dev: number; ino: number }
  | { kind: 'symlink' | 'non_regular'; bytes: Buffer; mode: number; dev: number; ino: number };

async function captureStaleTwin(file: string): Promise<StaleTwinSnapshot | null> {
  const pathStat = await fsp.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!pathStat) return null;
  if (pathStat.isSymbolicLink()) {
    return {
      kind: 'symlink',
      bytes: Buffer.alloc(0),
      mode: pathStat.mode & 0o777,
      dev: pathStat.dev,
      ino: pathStat.ino
    };
  }
  if (!pathStat.isFile()) {
    return {
      kind: 'non_regular',
      bytes: Buffer.alloc(0),
      mode: pathStat.mode & 0o777,
      dev: pathStat.dev,
      ino: pathStat.ino
    };
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        kind: 'non_regular',
        bytes: Buffer.alloc(0),
        mode: stat.mode & 0o777,
        dev: stat.dev,
        ino: stat.ino
      };
    }
    return {
      kind: 'regular',
      bytes: await handle.readFile(),
      mode: stat.mode & 0o777,
      dev: stat.dev,
      ino: stat.ino
    };
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null;
    if ((error as NodeJS.ErrnoException | null)?.code === 'ELOOP') {
      const stat = await fsp.lstat(file);
      return {
        kind: 'symlink',
        bytes: Buffer.alloc(0),
        mode: stat.mode & 0o777,
        dev: stat.dev,
        ino: stat.ino
      };
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function ensurePrivateQuarantineDirectory(boundary: string, directory: string): Promise<void> {
  await ensureConfinedDirectory(boundary, directory);
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isDirectory()) throw new Error('stale_twin_quarantine_not_directory');
    await handle.chmod(0o700);
    const hardened = await handle.stat();
    const pathStat = await fsp.lstat(directory);
    if (!hardened.isDirectory()
      || (hardened.mode & 0o777) !== 0o700
      || !pathStat.isDirectory()
      || pathStat.isSymbolicLink()
      || pathStat.dev !== hardened.dev
      || pathStat.ino !== hardened.ino) {
      throw new Error('stale_twin_quarantine_directory_verification_failed');
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function staleTwinSnapshotsEqual(
  expected: StaleTwinSnapshot | null,
  observed: StaleTwinSnapshot | null
): boolean {
  return expected?.kind === 'regular'
    && observed?.kind === 'regular'
    && expected.dev === observed.dev
    && expected.ino === observed.ino
    && expected.mode === observed.mode
    && expected.bytes.equals(observed.bytes);
}

async function hardenStaleTwinClaim(file: string, expected: StaleTwinSnapshot): Promise<boolean> {
  if (expected.kind !== 'regular') return false;
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    const bytes = await handle.readFile();
    if (!before.isFile()
      || before.dev !== expected.dev
      || before.ino !== expected.ino
      || !bytes.equals(expected.bytes)) return false;
    await handle.chmod(0o600);
    const hardened = await handle.stat();
    const pathStat = await fsp.lstat(file);
    return hardened.isFile()
      && (hardened.mode & 0o777) === 0o600
      && pathStat.isFile()
      && !pathStat.isSymbolicLink()
      && pathStat.dev === hardened.dev
      && pathStat.ino === hardened.ino;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function restoreStaleTwinClaimIfAbsent(
  quarantinePath: string,
  target: string,
  claimed: StaleTwinSnapshot | null
): Promise<boolean> {
  if (!claimed || await fsp.lstat(target).then(() => true, () => false)) return false;
  try {
    if (claimed.kind === 'regular') {
      await fsp.link(quarantinePath, target);
    } else if (claimed.kind === 'symlink') {
      await fsp.symlink(await fsp.readlink(quarantinePath), target);
    } else {
      return false;
    }
    await fsp.unlink(quarantinePath);
    return true;
  } catch {
    return false;
  }
}

export async function inspectDesktopCenterLaunchCredentials(opts: {
  mode: CodexLbDesktopMode | string;
  home?: string;
  loadedEnv?: CodexLbEnvLoadResult;
  launchctlBin?: string;
  force?: boolean;
  platform?: NodeJS.Platform;
  loadCodexLbEnvImpl?: typeof loadCodexLbEnv;
  runProcessImpl?: typeof runProcess;
} = { mode: 'disabled' }): Promise<DesktopCenterCredentialInspectionResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const mode = String(opts.mode || 'disabled');
  const platform = opts.platform || process.platform;
  const actions = codexLbCredentialStorageActions(home);
  if (platform !== 'darwin' && !opts.force) {
    return {
      schema: 'sks.codex-lb-desktop-center-credential-inspection.v1',
      ok: true,
      status: 'not_macos',
      mode,
      expected_api_key_sha256: null,
      launch_api_key_sha256: null,
      launch_api_key_present: false,
      blockers: [],
      operator_actions: []
    };
  }
  const launchctl = opts.launchctlBin
    || (await exists('/bin/launchctl') ? '/bin/launchctl' : null);
  if (!launchctl) {
    return {
      schema: 'sks.codex-lb-desktop-center-credential-inspection.v1',
      ok: false,
      status: 'launchctl_missing',
      mode,
      expected_api_key_sha256: null,
      launch_api_key_sha256: null,
      launch_api_key_present: false,
      blockers: ['launchctl_missing'],
      operator_actions: []
    };
  }
  const loaded = opts.loadedEnv || await loadOfficialCodexLbCredentials({
    home,
    ...(opts.loadCodexLbEnvImpl ? { loadCodexLbEnvImpl: opts.loadCodexLbEnvImpl } : {})
  });
  const run = opts.runProcessImpl || runProcess;
  const observed = await run(launchctl, ['getenv', 'CODEX_LB_API_KEY'], {
    timeoutMs: 5000,
    maxOutputBytes: 8192,
    env: credentialToolEnvironment(),
    envMode: 'replace'
  }).catch(() => ({ code: 1, stdout: '', stderr: '' }));
  const launchKey = observed.code === 0 ? String(observed.stdout || '').trim() : '';
  const expectedKey = mode === 'cli-provider' ? String(loaded.secret_api_key || '').trim() : '';
  const launchHash = launchKey ? sha256Bytes(Buffer.from(launchKey)) : null;
  const expectedHash = expectedKey ? sha256Bytes(Buffer.from(expectedKey)) : null;
  const blockers: string[] = [];
  if (mode === 'cli-provider' && !expectedKey) blockers.push('codex_lb_launchd_canonical_key_unavailable');
  if (mode === 'cli-provider' && expectedHash && launchHash !== expectedHash) {
    blockers.push('codex_lb_launchd_key_mismatch');
  }
  if (mode !== 'cli-provider' && launchKey) blockers.push('codex_lb_launchd_key_present_while_unselected');
  return {
    schema: 'sks.codex-lb-desktop-center-credential-inspection.v1',
    ok: blockers.length === 0,
    status: blockers.length === 0 ? 'launchd_selection_state_matched' : 'launchd_selection_state_mismatch',
    mode,
    expected_api_key_sha256: expectedHash,
    launch_api_key_sha256: launchHash,
    launch_api_key_present: Boolean(launchKey),
    blockers,
    operator_actions: blockers.includes('codex_lb_launchd_canonical_key_unavailable') ? actions : []
  };
}

export async function syncDesktopCenterLaunchCredentials(opts: {
  mode: CodexLbDesktopMode | string;
  home?: string;
  loadedEnv?: CodexLbEnvLoadResult;
  launchctlBin?: string;
  securityBin?: string;
  force?: boolean;
  skipPurge?: boolean;
  deferLegacyKeychainCleanup?: boolean;
  platform?: NodeJS.Platform;
  loadCodexLbEnvImpl?: typeof loadCodexLbEnv;
  runProcessImpl?: typeof runProcess;
} = { mode: 'disabled' }): Promise<DesktopCenterCredentialSyncResult> {
  const home = opts.home || process.env.HOME || os.homedir();
  const mode = String(opts.mode || 'disabled');
  const platform = opts.platform || process.platform;
  const purge = opts.skipPurge
    ? { removed: [] as string[], quarantined: [] as string[], keychain_cleared: [] as string[], blockers: [] as string[] }
    : await purgeStaleCodexLbCredentialTwins({
        home,
        platform,
        ...(opts.securityBin ? { securityBin: opts.securityBin } : {}),
        ...(opts.runProcessImpl ? { runProcessImpl: opts.runProcessImpl } : {}),
        skipLegacyKeychainCleanup: opts.deferLegacyKeychainCleanup === true
      });
  const loaded = opts.loadedEnv || await loadOfficialCodexLbCredentials({
    home,
    ...(opts.loadCodexLbEnvImpl ? { loadCodexLbEnvImpl: opts.loadCodexLbEnvImpl } : {})
  });
  const fingerprint = loaded.api_key.fingerprint;
  const basePresent = Boolean(loaded.base_url);

  if (platform !== 'darwin' && !opts.force) {
    const ok = purge.blockers.length === 0;
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok,
      status: ok ? 'not_macos' : 'stale_credential_cleanup_blocked',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: basePresent,
      launch_env: { api_key: 'skipped', base_url: 'skipped' },
      stale_twins_removed: purge.removed,
      stale_twins_quarantined: purge.quarantined,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: purge.blockers,
      operator_actions: []
    };
  }

  const launchctl = opts.launchctlBin
    || (await exists('/bin/launchctl') ? '/bin/launchctl' : null);
  if (!launchctl) {
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok: false,
      status: 'launchctl_missing',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: basePresent,
      launch_env: { api_key: 'failed', base_url: 'failed' },
      stale_twins_removed: purge.removed,
      stale_twins_quarantined: purge.quarantined,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: ['launchctl_missing', ...purge.blockers],
      operator_actions: []
    };
  }

  const run = opts.runProcessImpl || runProcess;
  const setEnv = async (key: string, value: string) => {
    const result = await run(launchctl, ['setenv', key, value], {
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      env: credentialToolEnvironment(),
      envMode: 'replace'
    });
    return result.code === 0;
  };
  const unsetEnv = async (key: string) => {
    const result = await run(launchctl, ['unsetenv', key], {
      timeoutMs: 5000,
      maxOutputBytes: 8192,
      env: credentialToolEnvironment(),
      envMode: 'replace'
    });
    return result.code === 0;
  };

  if (mode === 'desktop-dual-auth-compat') {
    const keyOk = await unsetEnv('CODEX_LB_API_KEY');
    const baseOk = await unsetEnv('CODEX_LB_BASE_URL');
    const openRouterOk = await unsetEnv('OPENROUTER_API_KEY');
    if (!loaded.secret_api_key || !loaded.base_url) {
      return {
        schema: 'sks.codex-lb-desktop-center-credentials.v1',
        ok: false,
        status: 'center_credentials_unavailable',
        mode,
        api_key_fingerprint: fingerprint,
        base_url_present: basePresent,
        launch_env: {
          api_key: keyOk ? 'unset' : 'failed',
          base_url: baseOk ? 'unset' : 'failed'
        },
        stale_twins_removed: purge.removed,
        stale_twins_quarantined: purge.quarantined,
        stale_keychain_cleared: purge.keychain_cleared,
        blockers: [
          ...(loaded.missing.length ? loaded.missing.map((item) => `codex_lb_missing:${item}`) : ['codex_lb_not_configured']),
          ...(keyOk ? [] : ['launchctl_unsetenv_CODEX_LB_API_KEY_failed']),
          ...(baseOk ? [] : ['launchctl_unsetenv_CODEX_LB_BASE_URL_failed']),
          ...(openRouterOk ? [] : ['launchctl_unsetenv_OPENROUTER_API_KEY_failed']),
          ...purge.blockers
        ],
        operator_actions: codexLbCredentialStorageActions(home)
      };
    }
    return {
      schema: 'sks.codex-lb-desktop-center-credentials.v1',
      ok: false,
      status: keyOk && baseOk && openRouterOk
        ? 'desktop_dual_auth_compat_unavailable'
        : 'desktop_secret_launch_env_cleanup_failed',
      mode,
      api_key_fingerprint: fingerprint,
      base_url_present: true,
      launch_env: {
        api_key: keyOk ? 'unset' : 'failed',
        base_url: baseOk ? 'unset' : 'failed'
      },
      stale_twins_removed: purge.removed,
      stale_twins_quarantined: purge.quarantined,
      stale_keychain_cleared: purge.keychain_cleared,
      blockers: [
        'desktop_dual_auth_compat_requires_global_secret_environment',
        ...(keyOk ? [] : ['launchctl_unsetenv_CODEX_LB_API_KEY_failed']),
        ...(baseOk ? [] : ['launchctl_unsetenv_CODEX_LB_BASE_URL_failed']),
        ...(openRouterOk ? [] : ['launchctl_unsetenv_OPENROUTER_API_KEY_failed']),
        ...purge.blockers
      ],
      operator_actions: []
    };
  }

  // The selected CLI provider is the only mode allowed to publish the
  // canonical key to the GUI launch namespace. Bridge/disabled modes must
  // remove it so a previous selection cannot silently remain authoritative.
  const cliProviderSelected = mode === 'cli-provider';
  const apiKeyStatus: 'set' | 'unset' | 'failed' = cliProviderSelected
    ? loaded.secret_api_key
      ? await setEnv('CODEX_LB_API_KEY', loaded.secret_api_key) ? 'set' : 'failed'
      : await unsetEnv('CODEX_LB_API_KEY') ? 'unset' : 'failed'
    : await unsetEnv('CODEX_LB_API_KEY') ? 'unset' : 'failed';
  const openRouterUnset = await unsetEnv('OPENROUTER_API_KEY');
  let baseStatus: 'set' | 'unset' | 'skipped' | 'failed' = 'skipped';
  if (loaded.base_url && (mode === 'desktop-native-bridge' || mode === 'cli-provider')) {
    baseStatus = await setEnv('CODEX_LB_BASE_URL', loaded.base_url) ? 'set' : 'failed';
  } else if (mode === 'disabled') {
    baseStatus = await unsetEnv('CODEX_LB_BASE_URL') ? 'unset' : 'failed';
  }
  const credentialsAvailable = !cliProviderSelected || Boolean(loaded.secret_api_key && loaded.base_url);
  const ok = credentialsAvailable
    && apiKeyStatus !== 'failed'
    && openRouterUnset
    && baseStatus !== 'failed'
    && purge.blockers.length === 0;
  return {
    schema: 'sks.codex-lb-desktop-center-credentials.v1',
    ok,
    status: ok
      ? cliProviderSelected ? 'cli_provider_launch_credentials_set' : 'desktop_secret_launch_env_cleared'
      : cliProviderSelected && !credentialsAvailable
        ? 'center_credentials_unavailable'
        : 'desktop_launch_env_cleanup_failed',
    mode,
    api_key_fingerprint: fingerprint,
    base_url_present: basePresent,
    launch_env: {
      api_key: apiKeyStatus,
      base_url: baseStatus
    },
    stale_twins_removed: purge.removed,
    stale_twins_quarantined: purge.quarantined,
    stale_keychain_cleared: purge.keychain_cleared,
    blockers: [
      ...(!credentialsAvailable
        ? (loaded.missing.length
            ? loaded.missing.map((item) => `codex_lb_missing:${item}`)
            : ['codex_lb_not_configured'])
        : []),
      ...(apiKeyStatus === 'failed'
        ? [cliProviderSelected
            ? 'launchctl_setenv_CODEX_LB_API_KEY_failed'
            : 'launchctl_unsetenv_CODEX_LB_API_KEY_failed']
        : []),
      ...(openRouterUnset ? [] : ['launchctl_unsetenv_OPENROUTER_API_KEY_failed']),
      ...(baseStatus === 'failed' ? ['launchctl_base_url_sync_failed'] : []),
      ...purge.blockers
    ],
    operator_actions: credentialsAvailable ? [] : codexLbCredentialStorageActions(home)
  };
}
