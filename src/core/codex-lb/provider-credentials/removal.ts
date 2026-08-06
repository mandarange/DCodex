import type { BridgeProviderId } from '../bridge-contracts.js';
import { removeStoredCodexLbCredential } from '../codex-lb-env.js';
import {
  removeStoredOpenRouterKey,
  type OpenRouterSecretPaths
} from '../../providers/openrouter/openrouter-secret-store.js';
import { withProviderCredentialLock } from './locks.js';

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
  return withProviderCredentialLock(input.home, input.provider_id, async () => {
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
  });
}
