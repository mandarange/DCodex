import crypto from 'node:crypto';
import type { BridgeProviderId, CredentialState } from './bridge-contracts.js';
import {
  loadCodexLbEnv,
  removeStoredCodexLbCredential,
  type CodexLbEnvLoadResult
} from './codex-lb-env.js';
import {
  openRouterSecretPaths,
  removeStoredOpenRouterKey,
  resolveOpenRouterApiKey,
  type OpenRouterSecretPaths
} from '../providers/openrouter/openrouter-secret-store.js';
import type { OpenRouterKeyResolution } from '../providers/openrouter/openrouter-types.js';

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

function fingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
