import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId } from '../bridge-contracts.js';
import { writeJsonAtomic } from '../../fsx.js';
import { providerCode, unique } from './runtime.js';
import {
  resolveAllProviderCredentials,
  resolveProviderCredential
} from './resolution.js';
import type {
  ProviderCredentialValidationMetadata,
  ProviderCredentialValidationRecord,
  ProviderCredentialValidationStore,
  ResolveProviderCredentialOptions,
  ResolvedProviderCredential
} from './types.js';

export function providerCredentialValidationPath(
  home: string = process.env.HOME || os.homedir()
): string {
  return path.join(path.resolve(home), '.codex', 'sks', 'sks-bridge-provider-validation.json');
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
