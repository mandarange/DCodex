import dns from 'node:dns/promises';
import net from 'node:net';
import type { BridgeProviderId, BridgeRoutingPolicy, ProviderSessionPin } from '../bridge-contracts.js';
import { assertProviderModeModel } from '../../codex-app/provider-mode.js';
import { assertSessionRequest, resumeSessionPin, sessionPinHash } from '../../codex-app/session-policy/session-pinning.js';
import type { SessionPin } from '../../architecture-hardening/contracts/contracts.js';
import { decideChildSelection } from '../../codex-app/child-policy/child-policy.js';
import type {
  DesktopBridgeConfig,
  DesktopBridgeProviderRegistrySnapshot,
  DesktopBridgeRemoteTarget,
  DesktopBridgeRouteContext,
  DesktopBridgeRouteRequest,
  PreparedDesktopBridgeConfig,
  PreparedDesktopBridgeProvider,
} from './types.js';
import { DesktopBridgeError } from './types.js';

const MIN_HIGH_PORT = 49_152;
const MAX_PORT = 65_535;

const FORBIDDEN_REMOTE_ADDRESSES = new net.BlockList();
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('0.0.0.0', 8, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('10.0.0.0', 8, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('100.64.0.0', 10, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('172.16.0.0', 12, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('::', 128, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('::1', 128, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('ff00::', 8, 'ipv6');

export type DesktopBridgeLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

export function assertLoopbackPeer(address: string | undefined): void {
  const normalized = String(address || '').replace(/^::ffff:/i, '');
  if (!net.isIP(normalized)) throw new DesktopBridgeError('bridge_peer_not_ip');
  if (normalized !== '127.0.0.1' && normalized !== '::1') throw new DesktopBridgeError('bridge_non_loopback_peer');
}

export function assertLoopbackListenHost(host: unknown): asserts host is DesktopBridgeConfig['listenHost'] {
  if (host !== '127.0.0.1' && host !== '::1') throw new DesktopBridgeError('bridge_listen_host_not_loopback');
}

export function assertAllowedPath(pathname: string, prefixes: readonly string[]): void {
  if (!pathname.startsWith('/') || pathname.includes('\\') || /%(?:2f|5c)/i.test(pathname)) {
    throw new DesktopBridgeError('bridge_path_invalid');
  }
  const allowed = prefixes.some((prefix) => prefix.endsWith('/')
    ? pathname.startsWith(prefix)
    : pathname === prefix || pathname.startsWith(`${prefix}/`));
  if (!allowed) throw new DesktopBridgeError('bridge_path_not_allowed');
}

function headerValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v) => v.trim()).filter(Boolean);
}

export function singleBridgeHeader(headers: NodeJS.Dict<string | string[]>, name: string): string | null {
  const values = headerValues(headers[name.toLowerCase()]);
  if (values.length > 1) throw new DesktopBridgeError('bridge_policy_header_ambiguous');
  return values[0] || null;
}

function comparableOrigin(value: string, referer: boolean): string {
  if (value === 'null') return value;
  try {
    const parsed = new URL(value);
    if (!referer && ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash)) throw new Error();
    return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new DesktopBridgeError('bridge_origin_invalid');
  }
}

export function normalizeAllowedOrigin(value: string): string {
  return comparableOrigin(String(value || '').trim(), false);
}

export function assertAllowedOrigin(headers: NodeJS.Dict<string | string[]>, allowedOrigins: readonly string[]): void {
  const origins = headerValues(headers.origin);
  const referers = headerValues(headers.referer);
  if (origins.length > 1 || referers.length > 1) throw new DesktopBridgeError('bridge_origin_forbidden');
  const allowed = new Set(allowedOrigins.map(normalizeAllowedOrigin));
  for (const value of origins) if (!allowed.has(comparableOrigin(value, false))) throw new DesktopBridgeError('bridge_origin_forbidden');
  for (const value of referers) if (!allowed.has(comparableOrigin(value, true))) throw new DesktopBridgeError('bridge_origin_forbidden');
}

export function assertWebSocketUpgrade(headers: NodeJS.Dict<string | string[]>, method: string | undefined): void {
  const connection = headerValues(headers.connection).join(',').toLowerCase().split(',').map((v) => v.trim());
  if (method !== 'GET' || !connection.includes('upgrade') || headerValues(headers.upgrade)[0]?.toLowerCase() !== 'websocket'
    || headerValues(headers['sec-websocket-key']).length !== 1 || headerValues(headers['sec-websocket-version']).length !== 1) {
    throw new DesktopBridgeError('bridge_websocket_upgrade_invalid');
  }
}

function canonicalModel(value: unknown): string {
  const model = typeof value === 'string' ? value.trim() : '';
  if (!model || model.length > 512 || /[\r\n\0]/.test(model)) throw new DesktopBridgeError('catalog_model_route_missing');
  return model;
}

export function resolveBridgeRequestRoute(
  request: DesktopBridgeRouteRequest,
  policy: BridgeRoutingPolicy,
  pins: readonly ProviderSessionPin[],
): DesktopBridgeRouteContext {
  const publicModel = canonicalModel(request.public_model);
  const pin = request.session_id ? pins.find((entry) => entry.thread_id === request.session_id) || null : null;
  if (request.session_id && !pin) throw new DesktopBridgeError('session_pin_route_unavailable');
  if (pin) {
    if (pin.public_model !== publicModel
      || pin.catalog_generation !== policy.catalog_generation
      || pin.route_policy_generation !== policy.policy_generation) {
      throw new DesktopBridgeError('session_pin_route_unavailable');
    }
    const current = policy.model_routes[publicModel];
    if (!current || current.provider_id !== pin.provider_id || current.upstream_model !== pin.upstream_model) {
      throw new DesktopBridgeError('session_pin_route_unavailable');
    }
    return {
      provider_id: pin.provider_id,
      public_model: publicModel,
      upstream_model: pin.upstream_model,
      catalog_generation: pin.catalog_generation,
      route_policy_generation: pin.route_policy_generation,
      session_pin: pin,
    };
  }
  const route = policy.model_routes[publicModel];
  if (!route) throw new DesktopBridgeError('catalog_model_route_missing');
  return {
    provider_id: route.provider_id,
    public_model: publicModel,
    upstream_model: route.upstream_model,
    catalog_generation: policy.catalog_generation,
    route_policy_generation: policy.policy_generation,
    session_pin: null,
  };
}

export function assertDesktopBridgeRouteContext(
  request: DesktopBridgeRouteRequest,
  config: PreparedDesktopBridgeConfig,
): DesktopBridgeRouteContext {
  const policy = config.routePolicy;
  if (!policy) throw new DesktopBridgeError('catalog_model_route_missing');
  const resolver = config.resolveRequestRoute || resolveBridgeRequestRoute;
  const route = resolver(request, policy, config.providerSessionPins || []);
  const expected = policy.model_routes[route.public_model];
  if (!expected || expected.provider_id !== route.provider_id || expected.upstream_model !== route.upstream_model) {
    throw new DesktopBridgeError('catalog_model_route_missing');
  }
  if (route.catalog_generation !== policy.catalog_generation || route.route_policy_generation !== policy.policy_generation) {
    throw new DesktopBridgeError('session_pin_route_unavailable');
  }
  const provider = config.providers[route.provider_id];
  if (!provider || !provider.enabled) throw new DesktopBridgeError('bridge_provider_route_unavailable');
  if (provider.credential_state !== 'ready') throw new DesktopBridgeError(`${route.provider_id.replace('-', '_')}_credential_unavailable`);
  if (provider.catalog_generation !== null && provider.catalog_generation !== route.catalog_generation) {
    throw new DesktopBridgeError('bridge_catalog_generation_mismatch');
  }
  if (!provider.allowed_origins.map(normalizeAllowedOrigin).includes(provider.remote.origin)) {
    throw new DesktopBridgeError('bridge_provider_origin_forbidden');
  }
  return route;
}

/** Compatibility choke point retained for old call sites; active requests use assertDesktopBridgeRouteContext. */
export function assertDesktopBridgeRequestPolicy(input: { headers: NodeJS.Dict<string | string[]>; config: DesktopBridgeConfig; model?: unknown }): void {
  const { config } = input;
  if (!config.providerMode) return;
  const requestedMode = singleBridgeHeader(input.headers, 'x-sks-provider-mode');
  if (requestedMode && requestedMode !== config.providerMode) throw new DesktopBridgeError('bridge_provider_route_cross_mode_forbidden');
  if (input.model !== undefined) {
    try { assertProviderModeModel(config.providerMode, input.model, config.allowedModels || []); }
    catch (error) { throw new DesktopBridgeError(`bridge_${(error as Error).message}`); }
  }
  const sessionId = singleBridgeHeader(input.headers, 'x-sks-session-id');
  if (!sessionId) { if (config.requireSessionPin) throw new DesktopBridgeError('bridge_session_pin_required'); return; }
  const pin = (config.sessionPins || []).find((entry): entry is SessionPin => 'session_id' in entry && entry.session_id === sessionId);
  if (!pin) throw new DesktopBridgeError('bridge_session_pin_unknown');
  if (config.providerPolicy) {
    const resume = resumeSessionPin(pin, config.providerPolicy);
    if (!resume.ok) throw new DesktopBridgeError(`bridge_${resume.blocker || 'session_pin_blocked'}`);
  }
  const childFlag = singleBridgeHeader(input.headers, 'x-sks-child-request');
  const childHash = singleBridgeHeader(input.headers, 'x-sks-child-policy-hash') || config.providerPolicy?.child_policy_hash || '';
  try { assertSessionRequest(pin, { mode: config.providerMode, model: childFlag === '1' ? pin.model : String(input.model || pin.model), childPolicyHash: childHash }); }
  catch (error) { throw new DesktopBridgeError(`bridge_${(error as Error).message}`); }
  if (childFlag !== '1') return;
  if (!config.childPolicy) throw new DesktopBridgeError('bridge_child_policy_missing');
  if (singleBridgeHeader(input.headers, 'x-sks-parent-snapshot-hash') !== sessionPinHash(pin)) throw new DesktopBridgeError('bridge_child_parent_snapshot_mismatch');
  const child = decideChildSelection({ session: pin, policy: config.childPolicy, requestedModel: singleBridgeHeader(input.headers, 'x-sks-child-model') || pin.model });
  if (!child.ok) throw new DesktopBridgeError(`bridge_${child.blockers[0] || 'child_policy_blocked'}`);
}

function stripIpv6Brackets(hostname: string): string { return hostname.replace(/^\[/, '').replace(/\]$/, ''); }
function isLoopbackAddress(address: string): boolean {
  const value = address.replace(/^::ffff:/i, '');
  return value === '::1' || (net.isIP(value) === 4 && Number(value.split('.')[0]) === 127);
}
function isExplicitLoopbackHostname(hostname: string): boolean {
  const value = stripIpv6Brackets(hostname).replace(/\.$/, '').toLowerCase();
  return value === 'localhost' || isLoopbackAddress(value);
}

function validateRemoteUrl(raw: string): URL {
  let remote: URL;
  try { remote = new URL(raw); } catch { throw new DesktopBridgeError('bridge_remote_url_invalid'); }
  if (remote.username || remote.password) throw new DesktopBridgeError('bridge_remote_userinfo_forbidden');
  if (remote.hash || remote.search) throw new DesktopBridgeError('bridge_remote_base_url_query_forbidden');
  if (remote.protocol !== 'https:' && !(remote.protocol === 'http:' && isExplicitLoopbackHostname(remote.hostname))) {
    throw new DesktopBridgeError('bridge_remote_transport_forbidden');
  }
  return remote;
}

const defaultLookup: DesktopBridgeLookup = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => {
    if (row.family !== 4 && row.family !== 6) throw new DesktopBridgeError('bridge_remote_dns_invalid');
    return { address: row.address, family: row.family };
  });
};

async function prepareProvider(provider: PreparedDesktopBridgeProvider, lookup: DesktopBridgeLookup): Promise<PreparedDesktopBridgeProvider> {
  const remote = validateRemoteUrl(provider.base_url);
  const hostname = stripIpv6Brackets(remote.hostname);
  if (!provider.allowed_origins.map(normalizeAllowedOrigin).includes(remote.origin)) throw new DesktopBridgeError('bridge_provider_origin_forbidden');
  if (!provider.enabled) {
    return {
      ...provider,
      base_url: remote.toString().replace(/\/$/, ''),
      remote: {
        baseUrl: remote.toString().replace(/\/$/, ''), origin: remote.origin, hostname,
        port: Number(remote.port || (remote.protocol === 'https:' ? 443 : 80)), secure: remote.protocol === 'https:',
        address: '0.0.0.0', family: 4, ...(net.isIP(hostname) ? {} : { tlsServername: hostname }),
      },
    };
  }
  const family = net.isIP(hostname);
  let addresses: readonly { address: string; family: 4 | 6 }[];
  try { addresses = family ? [{ address: hostname, family: family as 4 | 6 }] : await lookup(hostname); }
  catch (error) { throw new DesktopBridgeError('bridge_remote_dns_failed', { cause: error }); }
  if (!addresses.length || addresses.some((row) => net.isIP(row.address) !== row.family)) throw new DesktopBridgeError('bridge_remote_dns_invalid');
  const loopback = isExplicitLoopbackHostname(hostname);
  if (loopback && addresses.some((row) => !isLoopbackAddress(row.address))) throw new DesktopBridgeError('bridge_remote_dns_rebinding_blocked');
  if (!loopback && addresses.some((row) => FORBIDDEN_REMOTE_ADDRESSES.check(row.address, row.family === 4 ? 'ipv4' : 'ipv6'))) {
    throw new DesktopBridgeError('bridge_remote_dns_private_address');
  }
  const selected = addresses[0];
  if (!selected) throw new DesktopBridgeError('bridge_remote_dns_empty');
  const target: DesktopBridgeRemoteTarget = {
    baseUrl: remote.toString().replace(/\/$/, ''), origin: remote.origin, hostname,
    port: Number(remote.port || (remote.protocol === 'https:' ? 443 : 80)), secure: remote.protocol === 'https:',
    address: selected.address, family: selected.family, ...(family ? {} : { tlsServername: hostname }),
  };
  return { ...provider, base_url: target.baseUrl, remote: target };
}

function assertRegistryAndPolicy(config: DesktopBridgeConfig, registry: DesktopBridgeProviderRegistrySnapshot): void {
  if (registry.schema !== 'sks.desktop-bridge-provider-registry.v1' || !registry.generation || !Number.isFinite(Date.parse(registry.created_at))) {
    throw new DesktopBridgeError('bridge_provider_registry_invalid');
  }
  const ids: BridgeProviderId[] = ['codex-lb', 'openrouter'];
  if (Object.keys(registry.providers).length !== ids.length) throw new DesktopBridgeError('bridge_provider_registry_invalid');
  for (const id of ids) {
    const provider = registry.providers[id];
    if (!provider || provider.provider_id !== id || !provider.credential_generation || !Array.isArray(provider.allowed_origins) || !provider.allowed_origins.length) {
      throw new DesktopBridgeError('bridge_provider_registry_invalid');
    }
    if (id === 'openrouter' && provider.auth_transport !== 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
    if (id === 'codex-lb' && provider.auth_transport === 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
    validateRemoteUrl(provider.base_url);
  }
  const policy = config.routePolicy;
  if (!policy) return;
  if (policy.schema !== 'sks.bridge-routing-policy.v1' || policy.fallback !== 'none' || !policy.catalog_generation || !policy.policy_generation) {
    throw new DesktopBridgeError('bridge_route_policy_invalid');
  }
  for (const [model, route] of Object.entries(policy.model_routes)) {
    if (canonicalModel(model) !== model || !ids.includes(route.provider_id) || canonicalModel(route.upstream_model) !== route.upstream_model) {
      throw new DesktopBridgeError('bridge_route_policy_invalid');
    }
  }
  const pinIds = new Set<string>();
  for (const pin of config.providerSessionPins || []) {
    if (!pin.thread_id || pinIds.has(pin.thread_id) || !ids.includes(pin.provider_id)
      || !pin.public_model || !pin.upstream_model || !pin.catalog_generation || !pin.route_policy_generation) {
      throw new DesktopBridgeError('bridge_session_pin_invalid');
    }
    pinIds.add(pin.thread_id);
  }
}

function legacyRegistry(config: DesktopBridgeConfig): DesktopBridgeProviderRegistrySnapshot | null {
  if (!config.remoteBaseUrl || !config.gatewayKey || !config.gatewayAuthTransport) return null;
  const codex = {
    provider_id: 'codex-lb' as const, enabled: true, base_url: config.remoteBaseUrl,
    allowed_origins: [new URL(config.remoteBaseUrl).origin],
    auth_transport: config.gatewayAuthTransport === 'x-codex-lb-api-key' ? 'x-codex-lb-api-key' as const : 'authorization-bearer' as const,
    credential_state: 'ready' as const, credential_fingerprint: 'legacy', credential_generation: 'legacy', catalog_generation: null,
  };
  const disabled = { provider_id: 'openrouter' as const, enabled: false, base_url: 'https://openrouter.ai/api/v1', allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer' as const, credential_state: 'not_configured' as const, credential_fingerprint: null, credential_generation: 'legacy', catalog_generation: null };
  return { schema: 'sks.desktop-bridge-provider-registry.v1', generation: 'legacy', created_at: new Date(0).toISOString(), providers: { 'codex-lb': codex, openrouter: disabled } };
}

export function validateDesktopBridgeConfig(config: DesktopBridgeConfig): URL {
  assertLoopbackListenHost(config.listenHost);
  if (!Number.isInteger(config.listenPort) || config.listenPort < MIN_HIGH_PORT || config.listenPort > MAX_PORT) throw new DesktopBridgeError('bridge_listen_port_not_high');
  if (!config.allowedPathPrefixes.length) throw new DesktopBridgeError('bridge_path_allowlist_empty');
  if (!Number.isFinite(config.connectTimeoutMs) || config.connectTimeoutMs < 100 || config.connectTimeoutMs > 120_000) throw new DesktopBridgeError('bridge_connect_timeout_invalid');
  if (!Number.isFinite(config.idleTimeoutMs) || config.idleTimeoutMs < 1_000 || config.idleTimeoutMs > 86_400_000) throw new DesktopBridgeError('bridge_idle_timeout_invalid');
  for (const origin of config.allowedOrigins) normalizeAllowedOrigin(origin);
  const registry = config.providerRegistry || legacyRegistry(config);
  if (!registry) throw new DesktopBridgeError('bridge_provider_registry_missing');
  assertRegistryAndPolicy(config, registry);
  const first = Object.values(registry.providers).find((provider) => provider.enabled);
  if (!first) throw new DesktopBridgeError('bridge_provider_registry_no_enabled_provider');
  return validateRemoteUrl(first.base_url);
}

export async function prepareDesktopBridgeConfig(config: DesktopBridgeConfig, lookup: DesktopBridgeLookup = defaultLookup): Promise<PreparedDesktopBridgeConfig> {
  validateDesktopBridgeConfig(config);
  const registry = config.providerRegistry || legacyRegistry(config);
  if (!registry) throw new DesktopBridgeError('bridge_provider_registry_missing');
  const entries = await Promise.all((Object.keys(registry.providers) as BridgeProviderId[]).map(async (id) => {
    const provider = registry.providers[id];
    if (!provider) throw new DesktopBridgeError('bridge_provider_registry_invalid');
    const prepared = await prepareProvider({ ...provider, remote: {} as DesktopBridgeRemoteTarget }, lookup);
    return [id, prepared] as const;
  }));
  const providers = Object.fromEntries(entries) as Record<BridgeProviderId, PreparedDesktopBridgeProvider>;
  const resolveProviderCredential = config.resolveProviderCredential || (async (providerId: BridgeProviderId) => {
    if (providerId !== 'codex-lb' || !config.gatewayKey) throw new DesktopBridgeError('bridge_provider_credential_resolver_missing');
    return { provider_id: providerId, value: config.gatewayKey, source: 'legacy-adapter', fingerprint: 'legacy', generation: 'legacy' };
  });
  const selected = (Object.keys(providers) as BridgeProviderId[]).map((id) => providers[id]).find((provider) => provider.enabled) || providers['codex-lb'];
  return { ...config, providerRegistry: registry, resolveProviderCredential, providers, remote: selected.remote };
}

export function validatePreparedDesktopBridgeConfig(config: PreparedDesktopBridgeConfig): void {
  validateDesktopBridgeConfig(config);
  for (const id of Object.keys(config.providers) as BridgeProviderId[]) {
    const provider = config.providers[id];
    if (!provider || provider.provider_id !== id || provider.remote.origin !== new URL(provider.base_url).origin) throw new DesktopBridgeError('bridge_prepared_config_invalid');
  }
}

export function resolveDesktopBridgeTarget(rawRequestUrl: string | undefined, remote: DesktopBridgeRemoteTarget): URL {
  const raw = String(rawRequestUrl || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//') || /[\r\n\0]/.test(raw)) throw new DesktopBridgeError('bridge_request_target_invalid');
  let inbound: URL;
  try { inbound = new URL(raw, 'http://bridge.invalid'); } catch { throw new DesktopBridgeError('bridge_request_target_invalid'); }
  return new URL(`${inbound.pathname}${inbound.search}`, remote.origin);
}

export function safeBridgeErrorCode(error: unknown): string {
  if (error instanceof DesktopBridgeError) return error.code;
  if (error instanceof Error && /^bridge_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'bridge_upstream_unavailable';
}
