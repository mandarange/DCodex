import type { BridgeProviderId } from '../bridge-contracts.js';
import { loadCodexLbEnv } from '../codex-lb-env.js';
import {
  openRouterSecretPaths,
  resolveOpenRouterApiKey
} from '../../providers/openrouter/openrouter-secret-store.js';
import { fingerprint, runtimeCredential, unique } from './runtime.js';
import type {
  ResolveProviderCredentialOptions,
  ResolvedProviderCredential
} from './types.js';

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

function normalizeOpenRouterCredentialBlockers(values: readonly string[]): string[] {
  return unique(values.map((value) => value === 'glm_missing_openrouter_key'
    ? 'openrouter_credential_missing'
    : value));
}
