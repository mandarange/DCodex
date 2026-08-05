import crypto from 'node:crypto';
import type { BridgeProviderId, CredentialState } from '../bridge-contracts.js';
import type {
  ProviderCredentialStatus,
  ProviderCredentialValidationMetadata,
  ResolvedProviderCredential
} from './types.js';

export function runtimeCredential(input: {
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

export function fingerprintFull(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function fingerprint(secret: string): string {
  return fingerprintFull(secret).slice(0, 16);
}

export function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

export function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
