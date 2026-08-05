import type { BridgeProviderId, CredentialState } from '../bridge-contracts.js';
import type { CodexLbEnvLoadResult } from '../codex-lb-env.js';
import type { OpenRouterSecretPaths } from '../../providers/openrouter/openrouter-secret-store.js';
import type { OpenRouterKeyResolution } from '../../providers/openrouter/openrouter-types.js';

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
