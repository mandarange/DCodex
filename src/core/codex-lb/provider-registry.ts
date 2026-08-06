import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BridgeProviderId } from './bridge-contracts.js';
import {
  providerCredentialStatus,
  resolveAllProviderCredentials,
  type ProviderCredentialStatus,
  type ResolveProviderCredentialOptions,
  type ResolvedProviderCredential
} from './provider-credentials.js';
import { codexLbBaseUrlSecurityBlocker } from './codex-lb-env.js';
import { writeJsonAtomic } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';

export const BRIDGE_PROVIDER_REGISTRY_SCHEMA = 'sks.bridge-provider-registry.v1' as const;
export const BRIDGE_PROVIDER_REGISTRY_FILENAME = 'sks-bridge-provider-registry.json' as const;
export const OPENROUTER_ALLOWED_ORIGIN = 'https://openrouter.ai' as const;

export type BridgeProviderAuthTransport =
  | 'authorization-bearer'
  | 'x-codex-lb-api-key'
  | 'openrouter-bearer';

export interface StoredBridgeProviderProfile {
  readonly enabled: boolean;
  readonly endpoint_url: string | null;
  readonly allowed_origins: readonly string[];
  readonly auth_transport: BridgeProviderAuthTransport;
}

export interface StoredBridgeProviderRegistry {
  readonly schema: typeof BRIDGE_PROVIDER_REGISTRY_SCHEMA;
  readonly profiles: Record<BridgeProviderId, StoredBridgeProviderProfile>;
}

export interface BridgeProviderRegistryProfile {
  readonly provider_id: BridgeProviderId;
  readonly enabled: boolean;
  readonly profile_generation: string;
  readonly credential: ProviderCredentialStatus;
  readonly endpoint: {
    readonly configured: boolean;
    readonly url: string | null;
    readonly origin: string | null;
    readonly origin_redacted: string | null;
    readonly allowed_origins: readonly string[];
    readonly auth_transport: BridgeProviderAuthTransport;
    readonly blockers: readonly string[];
  };
  readonly state: 'ready' | 'configured_unverified' | 'disabled' | 'blocked' | 'not_configured';
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface BridgeProviderRegistry {
  readonly schema: typeof BRIDGE_PROVIDER_REGISTRY_SCHEMA;
  readonly generation: string;
  readonly profiles: Record<BridgeProviderId, BridgeProviderRegistryProfile>;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
}

export interface StoredBridgeProviderProfileOverride {
  readonly present: boolean;
  readonly enabled: boolean;
  readonly endpoint_url: string | null;
  readonly auth_transport: BridgeProviderAuthTransport | null;
}

export function bridgeProviderRegistryPath(home: string = process.env.HOME || os.homedir()): string {
  return path.join(path.resolve(home), '.codex', 'sks', BRIDGE_PROVIDER_REGISTRY_FILENAME);
}

export async function resolveBridgeProviderRegistry(options: {
  readonly home?: string;
  readonly registryPath?: string;
  readonly credentials?: Record<BridgeProviderId, ResolvedProviderCredential>;
  readonly credentialOptions?: {
    readonly codexLb?: ResolveProviderCredentialOptions;
    readonly openrouter?: ResolveProviderCredentialOptions;
  };
  readonly storedRegistry?: StoredBridgeProviderRegistry;
} = {}): Promise<BridgeProviderRegistry> {
  const credentials = options.credentials || await resolveAllProviderCredentials(options.credentialOptions || {});
  const file = options.registryPath || bridgeProviderRegistryPath(options.home);
  const read = options.storedRegistry
    ? { registry: options.storedRegistry, blockers: [] }
    : await readStoredBridgeProviderRegistry(file);
  const stored = read.registry || defaultStoredRegistry(credentials);
  const profiles = {
    'codex-lb': resolveProfile('codex-lb', stored.profiles['codex-lb'], credentials['codex-lb']),
    openrouter: resolveProfile('openrouter', stored.profiles.openrouter, credentials.openrouter)
  } satisfies Record<BridgeProviderId, BridgeProviderRegistryProfile>;
  return {
    schema: BRIDGE_PROVIDER_REGISTRY_SCHEMA,
    generation: digest({
      profiles: Object.fromEntries(Object.entries(profiles).map(([provider, profile]) => [provider, {
        enabled: profile.enabled,
        profile_generation: profile.profile_generation
      }]))
    }),
    profiles,
    blockers: unique([
      ...read.blockers,
      ...profiles['codex-lb'].blockers,
      ...profiles.openrouter.blockers
    ]),
    warnings: unique([
      ...profiles['codex-lb'].warnings,
      ...profiles.openrouter.warnings
    ])
  };
}

export async function loadStoredBridgeProviderRegistry(options: {
  readonly home?: string;
  readonly registryPath?: string;
} = {}): Promise<{
  readonly path: string;
  readonly registry: StoredBridgeProviderRegistry | null;
  readonly blockers: readonly string[];
}> {
  const file = options.registryPath || bridgeProviderRegistryPath(options.home);
  const read = await readStoredBridgeProviderRegistry(file);
  return { path: file, registry: read.registry, blockers: read.blockers };
}

/** Build secret-free registry bytes without writing them. */
export function buildStoredBridgeProviderRegistry(input: {
  readonly credentials: Record<BridgeProviderId, ResolvedProviderCredential>;
  readonly overrides?: Partial<Record<BridgeProviderId, StoredBridgeProviderProfileOverride>>;
}): StoredBridgeProviderRegistry {
  const base = defaultStoredRegistry(input.credentials);
  const profiles = { ...base.profiles };
  for (const providerId of ['codex-lb', 'openrouter'] as const) {
    const override = input.overrides?.[providerId];
    if (!override?.present) continue;
    const endpoint = normalizeEndpoint(override.endpoint_url || base.profiles[providerId].endpoint_url || '');
    const origin = endpointOrigin(endpoint);
    const authTransport = override.auth_transport || defaultAuthTransport(providerId);
    const blocker = providerEndpointSecurityBlocker(providerId, endpoint, origin ? [origin] : []);
    if (blocker) throw new Error(blocker);
    profiles[providerId] = {
      enabled: override.enabled,
      endpoint_url: endpoint,
      allowed_origins: origin ? [origin] : [],
      auth_transport: authTransport
    };
  }
  return { schema: BRIDGE_PROVIDER_REGISTRY_SCHEMA, profiles };
}

export function serializeStoredBridgeProviderRegistry(registry: StoredBridgeProviderRegistry): string {
  if (!isStoredRegistry(registry)) throw new Error('provider_registry_schema_invalid');
  return `${JSON.stringify(registry, null, 2)}\n`;
}

export async function setBridgeProviderEnabled(input: {
  readonly provider_id: BridgeProviderId;
  readonly enabled: boolean;
  readonly home?: string;
  readonly registryPath?: string;
  readonly credentials?: Record<BridgeProviderId, ResolvedProviderCredential>;
  readonly credentialOptions?: {
    readonly codexLb?: ResolveProviderCredentialOptions;
    readonly openrouter?: ResolveProviderCredentialOptions;
  };
}): Promise<BridgeProviderRegistry> {
  const credentials = input.credentials || await resolveAllProviderCredentials(input.credentialOptions || {});
  const file = input.registryPath || bridgeProviderRegistryPath(input.home);
  return withFileLock(registryLockOptions(file), async () => {
    const read = await readStoredBridgeProviderRegistry(file);
    if (read.blockers.length > 0) throw new Error(read.blockers[0]);
    const current = read.registry || defaultStoredRegistry(credentials);
    const next: StoredBridgeProviderRegistry = {
      schema: BRIDGE_PROVIDER_REGISTRY_SCHEMA,
      profiles: {
        ...current.profiles,
        [input.provider_id]: {
          ...current.profiles[input.provider_id],
          enabled: input.enabled
        }
      }
    };
    await writeJsonAtomic(file, next, { mode: 0o600 });
    return resolveBridgeProviderRegistry({
      ...(input.home ? { home: input.home } : {}),
      registryPath: file,
      credentials
    });
  });
}

export async function configureBridgeProviderProfile(input: {
  readonly provider_id: BridgeProviderId;
  readonly endpoint_url: string;
  readonly allowed_origins?: readonly string[];
  readonly auth_transport?: BridgeProviderAuthTransport;
  readonly enabled?: boolean;
  readonly home?: string;
  readonly registryPath?: string;
  readonly credentials?: Record<BridgeProviderId, ResolvedProviderCredential>;
}): Promise<BridgeProviderRegistry> {
  const credentials = input.credentials || await resolveAllProviderCredentials();
  const endpoint = normalizeEndpoint(input.endpoint_url);
  const origin = endpointOrigin(endpoint) || '';
  const blocker = providerEndpointSecurityBlocker(input.provider_id, endpoint, input.allowed_origins || [origin]);
  if (blocker) throw new Error(blocker);
  const file = input.registryPath || bridgeProviderRegistryPath(input.home);
  return withFileLock(registryLockOptions(file), async () => {
    const read = await readStoredBridgeProviderRegistry(file);
    if (read.blockers.length > 0) throw new Error(read.blockers[0]);
    const current = read.registry || defaultStoredRegistry(credentials);
    const nextProfile: StoredBridgeProviderProfile = {
      enabled: input.enabled ?? current.profiles[input.provider_id].enabled,
      endpoint_url: endpoint,
      allowed_origins: normalizeOrigins(input.allowed_origins || [origin]),
      auth_transport: input.auth_transport || defaultAuthTransport(input.provider_id)
    };
    const next: StoredBridgeProviderRegistry = {
      schema: BRIDGE_PROVIDER_REGISTRY_SCHEMA,
      profiles: { ...current.profiles, [input.provider_id]: nextProfile }
    };
    await writeJsonAtomic(file, next, { mode: 0o600 });
    return resolveBridgeProviderRegistry({
      ...(input.home ? { home: input.home } : {}),
      registryPath: file,
      credentials
    });
  });
}

function registryLockOptions(file: string) {
  return { lockPath: `${path.resolve(file)}.lock`, timeoutMs: 10_000, staleMs: 60_000 };
}

export function providerEndpointSecurityBlocker(
  providerId: BridgeProviderId,
  endpointUrl: string | null,
  allowedOrigins: readonly string[]
): string | null {
  if (!endpointUrl) return `${providerCode(providerId)}_endpoint_missing`;
  try {
    const url = new URL(endpointUrl);
    if (url.username || url.password || url.search || url.hash) return 'provider_endpoint_components_forbidden';
    const normalizedAllowed = normalizeOrigins(allowedOrigins);
    if (!normalizedAllowed.includes(url.origin)) return 'provider_endpoint_origin_not_allowlisted';
    if (providerId === 'openrouter') {
      if (url.protocol !== 'https:' || url.origin !== OPENROUTER_ALLOWED_ORIGIN) {
        return 'openrouter_endpoint_origin_not_allowlisted';
      }
      return null;
    }
    return codexLbBaseUrlSecurityBlocker(endpointUrl);
  } catch {
    return 'provider_endpoint_invalid';
  }
}

async function readStoredBridgeProviderRegistry(file: string): Promise<{
  registry: StoredBridgeProviderRegistry | null;
  blockers: string[];
}> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return { registry: null, blockers: [] };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return { registry: null, blockers: ['provider_registry_not_regular_file'] };
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) {
    return { registry: null, blockers: ['provider_registry_owner_mismatch'] };
  }
  if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
    return { registry: null, blockers: ['provider_registry_mode_insecure'] };
  }
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<StoredBridgeProviderRegistry>;
    if (!isStoredRegistry(value)) return { registry: null, blockers: ['provider_registry_schema_invalid'] };
    return { registry: value, blockers: [] };
  } catch {
    return { registry: null, blockers: ['provider_registry_json_invalid'] };
  }
}

function defaultStoredRegistry(
  credentials: Record<BridgeProviderId, ResolvedProviderCredential>
): StoredBridgeProviderRegistry {
  const codexEndpoint = credentials['codex-lb'].endpoint_url;
  const openRouterEndpoint = credentials.openrouter.endpoint_url || 'https://openrouter.ai/api/v1';
  return {
    schema: BRIDGE_PROVIDER_REGISTRY_SCHEMA,
    profiles: {
      'codex-lb': defaultProfile('codex-lb', codexEndpoint, credentials['codex-lb'].state !== 'not_configured'),
      openrouter: defaultProfile('openrouter', openRouterEndpoint, credentials.openrouter.state !== 'not_configured')
    }
  };
}

function defaultProfile(
  providerId: BridgeProviderId,
  endpointUrl: string | null,
  enabled: boolean
): StoredBridgeProviderProfile {
  const endpoint = normalizeEndpoint(endpointUrl || '');
  const origin = endpointOrigin(endpoint);
  return {
    enabled,
    endpoint_url: endpoint,
    allowed_origins: origin ? [origin] : [],
    auth_transport: defaultAuthTransport(providerId)
  };
}

function resolveProfile(
  providerId: BridgeProviderId,
  stored: StoredBridgeProviderProfile,
  credential: ResolvedProviderCredential
): BridgeProviderRegistryProfile {
  const endpoint = normalizeEndpoint(stored.endpoint_url || credential.endpoint_url || '');
  const endpointBlocker = providerEndpointSecurityBlocker(providerId, endpoint, stored.allowed_origins);
  const credentialStatus = providerCredentialStatus(credential);
  const blockers = unique([
    ...(endpointBlocker ? [endpointBlocker] : []),
    ...credentialStatus.blockers
  ]);
  const state = !stored.enabled
    ? 'disabled'
    : blockers.length > 0 && credentialStatus.state !== 'not_configured'
      ? 'blocked'
      : credentialStatus.state === 'ready'
        ? 'ready'
        : credentialStatus.state === 'not_configured'
          ? 'not_configured'
          : 'configured_unverified';
  const origin = endpointOrigin(endpoint);
  const profileGeneration = digest({
    provider_id: providerId,
    enabled: stored.enabled,
    credential_fingerprint: credentialStatus.fingerprint,
    credential_state: credentialStatus.state,
    endpoint,
    allowed_origins: [...stored.allowed_origins].sort(),
    auth_transport: stored.auth_transport
  });
  const endpointStatus = {
    configured: Boolean(endpoint) && !endpointBlocker,
    origin,
    origin_redacted: origin,
    allowed_origins: [...stored.allowed_origins].sort(),
    auth_transport: stored.auth_transport,
    blockers: endpointBlocker ? [endpointBlocker] : []
  } as Omit<BridgeProviderRegistryProfile['endpoint'], 'url'>;
  Object.defineProperty(endpointStatus, 'url', {
    value: endpoint,
    enumerable: false,
    configurable: false,
    writable: false
  });
  return {
    provider_id: providerId,
    enabled: stored.enabled,
    profile_generation: profileGeneration,
    credential: credentialStatus,
    endpoint: endpointStatus as BridgeProviderRegistryProfile['endpoint'],
    state,
    blockers,
    warnings: [...credentialStatus.warnings]
  };
}

function isStoredRegistry(value: Partial<StoredBridgeProviderRegistry>): value is StoredBridgeProviderRegistry {
  if (value.schema !== BRIDGE_PROVIDER_REGISTRY_SCHEMA || !value.profiles) return false;
  return (['codex-lb', 'openrouter'] as const).every((providerId) => {
    const profile = value.profiles?.[providerId] as StoredBridgeProviderProfile | undefined;
    return Boolean(profile
      && typeof profile.enabled === 'boolean'
      && (profile.endpoint_url === null || typeof profile.endpoint_url === 'string')
      && Array.isArray(profile.allowed_origins)
      && profile.allowed_origins.every((origin) => typeof origin === 'string')
      && ['authorization-bearer', 'x-codex-lb-api-key', 'openrouter-bearer'].includes(profile.auth_transport));
  });
}

function defaultAuthTransport(providerId: BridgeProviderId): BridgeProviderAuthTransport {
  return providerId === 'openrouter' ? 'openrouter-bearer' : 'authorization-bearer';
}

function normalizeEndpoint(value: string): string | null {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return null;
  try {
    return new URL(text).toString().replace(/\/+$/, '');
  } catch {
    return text;
  }
}

function endpointOrigin(endpoint: string | null): string | null {
  if (!endpoint) return null;
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

function normalizeOrigins(values: readonly string[]): string[] {
  return unique(values.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return '';
    }
  })).sort();
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function unique(values: readonly unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}
