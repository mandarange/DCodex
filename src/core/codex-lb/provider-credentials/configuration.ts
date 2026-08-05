import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId } from '../bridge-contracts.js';
import {
  codexLbBaseUrlSecurityBlocker,
  codexLbEnvPath,
  codexLbMetadataPath,
  normalizeCodexLbBaseUrl
} from '../codex-lb-env.js';
import {
  openRouterSecretPaths,
  writeStoredOpenRouterKey,
  type OpenRouterSecretPaths
} from '../../providers/openrouter/openrouter-secret-store.js';
import { writePrivateTextAtomic } from '../../security/private-credential-file.js';
import {
  restorePrivateCredential,
  snapshotPrivateCredential
} from './private-snapshot.js';
import { resolveProviderCredential } from './resolution.js';
import {
  fingerprint,
  fingerprintFull,
  providerCode,
  providerCredentialStatus
} from './runtime.js';
import type { ProviderCredentialStatus } from './types.js';

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
    return configureOpenRouterCredential(input, apiKey, home);
  }
  return configureCodexLbCredential(input, apiKey, home);
}

type ConfigureProviderCredentialInput = Parameters<typeof configureProviderCredential>[0];
type ConfigureProviderCredentialResult = Awaited<ReturnType<typeof configureProviderCredential>>;

async function configureOpenRouterCredential(
  input: ConfigureProviderCredentialInput,
  apiKey: string,
  home: string
): Promise<ConfigureProviderCredentialResult> {
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
    await rollbackCredentialSnapshots(secretDir, snapshots);
    throw error;
  }
}

async function configureCodexLbCredential(
  input: ConfigureProviderCredentialInput,
  apiKey: string,
  home: string
): Promise<ConfigureProviderCredentialResult> {
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
    gateway_auth_transport: 'authorization-bearer',
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
    await rollbackCredentialSnapshots(codexHome, snapshots);
    throw error;
  }
}

async function rollbackCredentialSnapshots(
  boundary: string,
  snapshots: Awaited<ReturnType<typeof snapshotPrivateCredential>>[]
): Promise<void> {
  const rollbackErrors: string[] = [];
  for (const snapshot of snapshots.reverse()) {
    try {
      await restorePrivateCredential(boundary, snapshot);
    } catch {
      rollbackErrors.push(`credential_configuration_rollback_failed:${snapshot.file}`);
    }
  }
  if (rollbackErrors.length > 0) throw new Error(rollbackErrors[0]);
}

function shellSingleQuote(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
