import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId, CredentialState } from './bridge-contracts.js';
import {
  codexLbBaseUrlSecurityBlocker,
  codexLbEnvPath,
  codexLbMetadataPath,
  loadCodexLbEnv,
  normalizeCodexLbBaseUrl,
  removeStoredCodexLbCredential,
  type CodexLbEnvLoadResult
} from './codex-lb-env.js';
import {
  openRouterSecretPaths,
  removeStoredOpenRouterKey,
  resolveOpenRouterApiKey,
  writeStoredOpenRouterKey,
  type OpenRouterSecretPaths
} from '../providers/openrouter/openrouter-secret-store.js';
import type { OpenRouterKeyResolution } from '../providers/openrouter/openrouter-types.js';
import {
  PrivateCredentialFileError,
  readPrivateCredentialFile,
  writePrivateTextAtomic
} from '../security/private-credential-file.js';
import { writeJsonAtomic } from '../fsx.js';

export interface ProviderCredentialValidationMetadata {
  readonly state: Exclude<CredentialState, 'not_configured' | 'validating'>;
  readonly checked_at: string | null;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
}

export interface ProviderCredentialStatus {
  readonly schema: 'sks.provider-credential-status.v1';
  readonly provider_id: BridgeProviderId;
  readonly state: CredentialState;
  readonly source: string | null;
  readonly fingerprint: string | null;
  readonly checked_at: string | null;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

/**
 * Runtime-only credential. `secret` is deliberately non-enumerable so status,
 * catalog, route-index, and receipt serialization cannot include it.
 */
export interface ResolvedProviderCredential extends ProviderCredentialStatus {
  readonly secret: string | null;
  readonly endpoint_url: string | null;
}

export interface ResolveProviderCredentialOptions {
  readonly home?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly codexLbEnvPath?: string;
  readonly codexLbMetadataPath?: string;
  readonly openRouterPaths?: OpenRouterSecretPaths;
  readonly validation?: ProviderCredentialValidationMetadata | null;
  readonly loadCodexLbEnvImpl?: (options: Record<string, unknown>) => Promise<CodexLbEnvLoadResult>;
  readonly resolveOpenRouterApiKeyImpl?: (input: {
    env?: NodeJS.ProcessEnv;
    paths?: OpenRouterSecretPaths;
  }) => Promise<OpenRouterKeyResolution>;
}

export interface ProviderCredentialValidationRecord {
  readonly credential_fingerprint: string;
  readonly endpoint_url: string;
  readonly state: Extract<CredentialState, 'ready' | 'rejected' | 'unavailable' | 'stale'>;
  readonly checked_at: string;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface ProviderCredentialValidationStore {
  readonly schema: 'sks.provider-credential-validation-store.v1';
  readonly providers: Partial<Record<BridgeProviderId, ProviderCredentialValidationRecord>>;
}

export function providerCredentialValidationPath(
  home: string = process.env.HOME || os.homedir()
): string {
  return path.join(path.resolve(home), '.codex', 'sks', 'sks-bridge-provider-validation.json');
}

export async function resolveProviderCredential(
  providerId: BridgeProviderId,
  options: ResolveProviderCredentialOptions = {}
): Promise<ResolvedProviderCredential> {
  if (providerId === 'codex-lb') {
    const loaded = await (options.loadCodexLbEnvImpl || loadCodexLbEnv)({
      ...(options.home ? { home: options.home } : {}),
      processEnv: options.processEnv || process.env,
      ...(options.codexLbEnvPath ? { envPath: options.codexLbEnvPath } : {}),
      ...(options.codexLbMetadataPath ? { metadataPath: options.codexLbMetadataPath } : {})
    });
    const secret = loaded.secret_api_key;
    const present = loaded.api_key.present;
    return runtimeCredential({
      provider_id: providerId,
      secret,
      endpoint_url: loaded.base_url,
      source: loaded.api_key.source || null,
      fingerprint: loaded.api_key.fingerprint,
      fallback_state: !present
        ? 'not_configured'
        : loaded.api_key.usable
          ? 'configured_unverified'
          : 'unavailable',
      blockers: unique(loaded.blockers || loaded.credential_binding.blockers),
      warnings: unique(loaded.guidance || []),
      ...(options.validation === undefined ? {} : { validation: options.validation })
    });
  }

  const env = options.processEnv || process.env;
  const resolved = await (options.resolveOpenRouterApiKeyImpl || resolveOpenRouterApiKey)({
    env,
    paths: options.openRouterPaths || openRouterSecretPaths(env)
  });
  const secret = resolved.key;
  return runtimeCredential({
    provider_id: providerId,
    secret,
    endpoint_url: 'https://openrouter.ai/api/v1',
    source: resolved.source,
    fingerprint: secret ? fingerprint(secret) : null,
    fallback_state: secret ? 'configured_unverified' : 'not_configured',
    blockers: secret ? [] : normalizeOpenRouterCredentialBlockers(resolved.blockers),
    warnings: unique(resolved.warnings),
    ...(options.validation === undefined ? {} : { validation: options.validation })
  });
}

export async function resolveAllProviderCredentials(options: {
  readonly codexLb?: ResolveProviderCredentialOptions;
  readonly openrouter?: ResolveProviderCredentialOptions;
} = {}): Promise<Record<BridgeProviderId, ResolvedProviderCredential>> {
  const [codexLb, openrouter] = await Promise.all([
    resolveProviderCredential('codex-lb', options.codexLb || {}),
    resolveProviderCredential('openrouter', options.openrouter || {})
  ]);
  return { 'codex-lb': codexLb, openrouter };
}

/**
 * Resolve both credentials and apply only validation evidence bound to the
 * current credential fingerprint and endpoint. A rotated key can therefore
 * never inherit a previous key's ready state.
 */
export async function resolveAllProviderCredentialsWithValidation(options: {
  readonly home?: string;
  readonly validationPath?: string;
  readonly codexLb?: ResolveProviderCredentialOptions;
  readonly openrouter?: ResolveProviderCredentialOptions;
} = {}): Promise<Record<BridgeProviderId, ResolvedProviderCredential>> {
  const home = options.home || process.env.HOME || os.homedir();
  const raw = await resolveAllProviderCredentials({
    codexLb: { home, ...(options.codexLb || {}) },
    openrouter: { home, ...(options.openrouter || {}) }
  });
  const store = await readProviderCredentialValidationStore(
    options.validationPath || providerCredentialValidationPath(home)
  );
  const validationFor = (providerId: BridgeProviderId): ProviderCredentialValidationMetadata | null => {
    const credential = raw[providerId];
    const record = store.providers[providerId];
    if (!record
      || !credential.fingerprint
      || record.credential_fingerprint !== credential.fingerprint
      || record.endpoint_url !== String(credential.endpoint_url || '')) {
      return null;
    }
    return {
      state: record.state,
      checked_at: record.checked_at,
      blockers: record.blockers,
      warnings: record.warnings
    };
  };
  const [codexLb, openrouter] = await Promise.all([
    resolveProviderCredential('codex-lb', {
      home,
      ...(options.codexLb || {}),
      validation: validationFor('codex-lb')
    }),
    resolveProviderCredential('openrouter', {
      home,
      ...(options.openrouter || {}),
      validation: validationFor('openrouter')
    })
  ]);
  return { 'codex-lb': codexLb, openrouter };
}

export async function recordProviderCredentialValidation(input: {
  readonly provider_id: BridgeProviderId;
  readonly credential: ResolvedProviderCredential;
  readonly state: ProviderCredentialValidationRecord['state'];
  readonly checked_at?: string;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
  readonly home?: string;
  readonly validationPath?: string;
}): Promise<ProviderCredentialValidationStore> {
  if (!input.credential.fingerprint || !input.credential.endpoint_url) {
    throw new Error(`${providerCode(input.provider_id)}_credential_validation_binding_missing`);
  }
  const home = input.home || process.env.HOME || os.homedir();
  const file = input.validationPath || providerCredentialValidationPath(home);
  const current = await readProviderCredentialValidationStore(file);
  const next: ProviderCredentialValidationStore = {
    schema: 'sks.provider-credential-validation-store.v1',
    providers: {
      ...current.providers,
      [input.provider_id]: {
        credential_fingerprint: input.credential.fingerprint,
        endpoint_url: input.credential.endpoint_url,
        state: input.state,
        checked_at: input.checked_at || new Date().toISOString(),
        blockers: unique(input.blockers || []),
        warnings: unique(input.warnings || [])
      }
    }
  };
  await writeJsonAtomic(file, next, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return next;
}

export async function readProviderCredentialValidationStore(
  file: string
): Promise<ProviderCredentialValidationStore> {
  const empty: ProviderCredentialValidationStore = {
    schema: 'sks.provider-credential-validation-store.v1',
    providers: {}
  };
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return empty;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile()
    || stat.isSymbolicLink()
    || (expectedUid !== null && stat.uid !== expectedUid)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) {
    throw new Error('provider_credential_validation_store_insecure');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    throw new Error('provider_credential_validation_store_invalid');
  }
  if (!isValidationStore(parsed)) throw new Error('provider_credential_validation_store_invalid');
  return parsed;
}

/** Persist one provider secret without selecting a runtime provider or editing Codex auth.json. */
export async function configureProviderCredential(input: {
  readonly provider_id: BridgeProviderId;
  readonly api_key: string;
  readonly host?: string;
  readonly home?: string;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly codexLbEnvPath?: string;
  readonly codexLbMetadataPath?: string;
  readonly openRouterPaths?: OpenRouterSecretPaths;
}): Promise<{
  readonly schema: 'sks.provider-credential-configuration.v1';
  readonly provider_id: BridgeProviderId;
  readonly configured: boolean;
  readonly credential: ProviderCredentialStatus;
  readonly blockers: readonly string[];
}> {
  const apiKey = String(input.api_key || '').trim();
  if (!apiKey) throw new Error(`${providerCode(input.provider_id)}_credential_empty`);
  const home = path.resolve(input.home || process.env.HOME || os.homedir());
  if (input.provider_id === 'openrouter') {
    const env = { ...(input.processEnv || process.env), HOME: home };
    const paths = input.openRouterPaths || openRouterSecretPaths(env);
    const secretDir = path.resolve(paths.secretDir);
    const keyPath = path.resolve(paths.keyPath);
    const metadataPath = path.resolve(paths.metadataPath);
    if (keyPath === secretDir
      || metadataPath === secretDir
      || !keyPath.startsWith(`${secretDir}${path.sep}`)
      || !metadataPath.startsWith(`${secretDir}${path.sep}`)) {
      throw new Error('openrouter_credential_path_outside_secret_store');
    }
    await fs.mkdir(secretDir, { recursive: true, mode: 0o700 });
    await fs.chmod(secretDir, 0o700);
    const snapshots = await Promise.all([
      snapshotPrivateCredential(secretDir, keyPath, 'openrouter_api_key'),
      snapshotPrivateCredential(secretDir, metadataPath, 'openrouter_api_key_metadata')
    ]);
    try {
      await writeStoredOpenRouterKey(apiKey, { paths });
      // Verify the just-written store rather than an ambient environment key;
      // runtime resolution may still intentionally prefer env later.
      const verificationEnv = { ...env, OPENROUTER_API_KEY: '', SKS_OPENROUTER_API_KEY: '' };
      const credential = await resolveProviderCredential('openrouter', {
        home,
        processEnv: verificationEnv,
        openRouterPaths: paths
      });
      if (!credential.secret || credential.fingerprint !== fingerprint(apiKey)) {
        throw new Error('openrouter_credential_write_verification_failed');
      }
      return {
        schema: 'sks.provider-credential-configuration.v1',
        provider_id: input.provider_id,
        configured: true,
        credential: providerCredentialStatus(credential),
        blockers: []
      };
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const snapshot of snapshots.reverse()) {
        try {
          await restorePrivateCredential(secretDir, snapshot);
        } catch {
          rollbackErrors.push(`credential_configuration_rollback_failed:${snapshot.file}`);
        }
      }
      if (rollbackErrors.length > 0) throw new Error(rollbackErrors[0]);
      throw error;
    }
  }

  const baseUrl = normalizeCodexLbBaseUrl(input.host || '');
  const endpointBlocker = codexLbBaseUrlSecurityBlocker(baseUrl);
  if (!baseUrl || endpointBlocker) throw new Error(endpointBlocker || 'codex_lb_base_url_missing');
  const codexHome = path.join(home, '.codex');
  const envPath = path.resolve(input.codexLbEnvPath || codexLbEnvPath(home));
  const metadataPath = path.resolve(input.codexLbMetadataPath || codexLbMetadataPath(home));
  if (![envPath, metadataPath].every((file) => file.startsWith(`${codexHome}${path.sep}`))) {
    throw new Error('codex_lb_credential_path_outside_codex_home');
  }
  const snapshots = await Promise.all([
    snapshotPrivateCredential(codexHome, envPath, 'codex_lb_env_file'),
    snapshotPrivateCredential(codexHome, metadataPath, 'codex_lb_metadata_file')
  ]);
  const keyHash = fingerprintFull(apiKey);
  const envText = `export CODEX_LB_BASE_URL=${shellSingleQuote(baseUrl)}\nexport CODEX_LB_API_KEY=${shellSingleQuote(apiKey)}\n`;
  const metadataText = `${JSON.stringify({
    schema: 'sks.codex-lb-metadata.v1',
    base_url: baseUrl,
    updated_at: new Date().toISOString(),
    source: 'bridge-provider-configure',
    gateway_auth_transport: 'authorization-bearer-compat',
    api_key: { redacted: true, sha256: keyHash }
  }, null, 2)}\n`;
  try {
    await writePrivateTextAtomic(codexHome, metadataPath, metadataText, 'codex_lb_metadata_file');
    await writePrivateTextAtomic(codexHome, envPath, envText, 'codex_lb_env_file');
    const credential = await resolveProviderCredential('codex-lb', {
      home,
      processEnv: input.processEnv || {},
      codexLbEnvPath: envPath,
      codexLbMetadataPath: metadataPath
    });
    if (!credential.secret || credential.fingerprint !== keyHash.slice(0, 16)) {
      throw new Error('codex_lb_credential_write_verification_failed');
    }
    return {
      schema: 'sks.provider-credential-configuration.v1',
      provider_id: input.provider_id,
      configured: true,
      credential: providerCredentialStatus(credential),
      blockers: []
    };
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots.reverse()) {
      try {
        await restorePrivateCredential(codexHome, snapshot);
      } catch {
        rollbackErrors.push(`credential_configuration_rollback_failed:${snapshot.file}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(rollbackErrors[0]);
    }
    throw error;
  }
}

export function providerCredentialStatus(
  credential: ResolvedProviderCredential
): ProviderCredentialStatus {
  return {
    schema: 'sks.provider-credential-status.v1',
    provider_id: credential.provider_id,
    state: credential.state,
    source: credential.source,
    fingerprint: credential.fingerprint,
    checked_at: credential.checked_at,
    blockers: [...credential.blockers],
    warnings: [...credential.warnings]
  };
}

export async function removeProviderCredential(input: {
  readonly provider_id: BridgeProviderId;
  readonly confirmed: boolean;
  readonly home?: string;
  readonly codexLbEnvPath?: string;
  readonly codexLbMetadataPath?: string;
  readonly openRouterPaths?: OpenRouterSecretPaths;
}): Promise<{
  readonly schema: 'sks.provider-credential-removal.v1';
  readonly provider_id: BridgeProviderId;
  readonly removed: boolean;
  readonly removed_paths: readonly string[];
  readonly blockers: readonly string[];
}> {
  if (input.provider_id === 'codex-lb') {
    const result = await removeStoredCodexLbCredential({
      confirmed: input.confirmed,
      ...(input.home ? { home: input.home } : {}),
      ...(input.codexLbEnvPath ? { envPath: input.codexLbEnvPath } : {}),
      ...(input.codexLbMetadataPath ? { metadataPath: input.codexLbMetadataPath } : {})
    });
    return {
      schema: 'sks.provider-credential-removal.v1',
      provider_id: input.provider_id,
      removed: result.removed,
      removed_paths: result.removed_paths,
      blockers: result.blockers
    };
  }
  const result = await removeStoredOpenRouterKey({
    confirmed: input.confirmed,
    ...(input.openRouterPaths ? { paths: input.openRouterPaths } : {})
  });
  return {
    schema: 'sks.provider-credential-removal.v1',
    provider_id: input.provider_id,
    removed: result.removed,
    removed_paths: result.removed_paths,
    blockers: result.blockers
  };
}

function runtimeCredential(input: {
  provider_id: BridgeProviderId;
  secret: string | null;
  endpoint_url: string | null;
  source: string | null;
  fingerprint: string | null;
  fallback_state: CredentialState;
  blockers: readonly string[];
  warnings: readonly string[];
  validation?: ProviderCredentialValidationMetadata | null;
}): ResolvedProviderCredential {
  const validation = input.validation;
  const state = validation && input.secret
    ? validation.state
    : input.fallback_state;
  const value: Omit<ResolvedProviderCredential, 'secret'> = {
    schema: 'sks.provider-credential-status.v1',
    provider_id: input.provider_id,
    state,
    source: input.source,
    fingerprint: input.fingerprint,
    checked_at: validation?.checked_at || null,
    blockers: unique([
      ...input.blockers,
      ...(validation?.blockers || [])
    ]),
    warnings: unique([
      ...input.warnings,
      ...(validation?.warnings || [])
    ]),
    endpoint_url: input.endpoint_url
  };
  Object.defineProperty(value, 'secret', {
    value: input.secret,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return value as ResolvedProviderCredential;
}

function normalizeOpenRouterCredentialBlockers(values: readonly string[]): string[] {
  return unique(values.map((value) => value === 'glm_missing_openrouter_key'
    ? 'openrouter_credential_missing'
    : value));
}

type PrivateCredentialSnapshot = {
  readonly file: string;
  readonly label: string;
  readonly existed: boolean;
  readonly text: string;
};

async function snapshotPrivateCredential(
  boundary: string,
  file: string,
  label: string
): Promise<PrivateCredentialSnapshot> {
  try {
    const snapshot = await readPrivateCredentialFile(boundary, file, label, { maxBytes: 1024 * 1024 });
    return { file, label, existed: true, text: snapshot.bytes.toString('utf8') };
  } catch (error) {
    if (error instanceof PrivateCredentialFileError && error.code === 'missing') {
      return { file, label, existed: false, text: '' };
    }
    throw error;
  }
}

async function restorePrivateCredential(
  boundary: string,
  snapshot: PrivateCredentialSnapshot
): Promise<void> {
  if (snapshot.existed) {
    await writePrivateTextAtomic(boundary, snapshot.file, snapshot.text, snapshot.label);
    return;
  }
  const stat = await fs.lstat(snapshot.file).catch(() => null);
  if (!stat) return;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink() || (expectedUid !== null && stat.uid !== expectedUid)) {
    throw new Error(`${snapshot.label}_rollback_target_invalid`);
  }
  await fs.unlink(snapshot.file);
}

function isValidationStore(value: unknown): value is ProviderCredentialValidationStore {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.schema !== 'sks.provider-credential-validation-store.v1'
    || !row.providers
    || typeof row.providers !== 'object'
    || Array.isArray(row.providers)) return false;
  return Object.entries(row.providers as Record<string, unknown>).every(([providerId, entry]) => {
    if (providerId !== 'codex-lb' && providerId !== 'openrouter') return false;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    return typeof record.credential_fingerprint === 'string'
      && /^[a-f0-9]{16}$/.test(record.credential_fingerprint)
      && typeof record.endpoint_url === 'string'
      && ['ready', 'rejected', 'unavailable', 'stale'].includes(String(record.state || ''))
      && typeof record.checked_at === 'string'
      && Number.isFinite(Date.parse(record.checked_at))
      && Array.isArray(record.blockers)
      && record.blockers.every((item) => typeof item === 'string')
      && Array.isArray(record.warnings)
      && record.warnings.every((item) => typeof item === 'string');
  });
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function fingerprintFull(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function fingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
