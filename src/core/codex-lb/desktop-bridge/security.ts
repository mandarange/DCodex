import dns from 'node:dns/promises';
import net from 'node:net';
import type { BridgeProviderId, BridgeRoutingPolicy, ProviderSessionPin } from '../bridge-contracts.js';
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
  const resolver = config.resolveRequestRoute || resolveBridgeRequestRoute;
  const route = resolver(request, config.routePolicy, config.providerSessionPins);
  const policy = config.routePolicy;
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
  if (provider.source_catalog_generation !== null && !provider.source_catalog_generation.trim()) {
    throw new DesktopBridgeError('bridge_provider_source_catalog_generation_invalid');
  }
  if (!provider.allowed_origins.map(normalizeAllowedOrigin).includes(provider.remote.origin)) {
    throw new DesktopBridgeError('bridge_provider_origin_forbidden');
  }
  return route;
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
    if (provider.source_catalog_generation !== null
      && (typeof provider.source_catalog_generation !== 'string' || !provider.source_catalog_generation.trim())) {
      throw new DesktopBridgeError('bridge_provider_source_catalog_generation_invalid');
    }
    if (id === 'openrouter' && provider.auth_transport !== 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
    if (id === 'codex-lb' && provider.auth_transport === 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
    validateRemoteUrl(provider.base_url);
  }
  const policy = config.routePolicy;
  if (policy.schema !== 'sks.bridge-routing-policy.v1' || policy.fallback !== 'none' || !policy.catalog_generation || !policy.policy_generation) {
    throw new DesktopBridgeError('bridge_route_policy_invalid');
  }
  for (const [model, route] of Object.entries(policy.model_routes)) {
    if (canonicalModel(model) !== model || !ids.includes(route.provider_id) || canonicalModel(route.upstream_model) !== route.upstream_model) {
      throw new DesktopBridgeError('bridge_route_policy_invalid');
    }
  }
  const pinIds = new Set<string>();
  for (const pin of config.providerSessionPins) {
    if (!pin.thread_id || pinIds.has(pin.thread_id) || !ids.includes(pin.provider_id)
      || !pin.public_model || !pin.upstream_model || !pin.catalog_generation || !pin.route_policy_generation) {
      throw new DesktopBridgeError('bridge_session_pin_invalid');
    }
    pinIds.add(pin.thread_id);
  }
}

export function validateDesktopBridgeConfig(config: DesktopBridgeConfig): void {
  assertLoopbackListenHost(config.listenHost);
  if (!Number.isInteger(config.listenPort) || config.listenPort < MIN_HIGH_PORT || config.listenPort > MAX_PORT) throw new DesktopBridgeError('bridge_listen_port_not_high');
  if (!config.allowedPathPrefixes.length) throw new DesktopBridgeError('bridge_path_allowlist_empty');
  if (!Number.isFinite(config.connectTimeoutMs) || config.connectTimeoutMs < 100 || config.connectTimeoutMs > 120_000) throw new DesktopBridgeError('bridge_connect_timeout_invalid');
  if (!Number.isFinite(config.idleTimeoutMs) || config.idleTimeoutMs < 1_000 || config.idleTimeoutMs > 86_400_000) throw new DesktopBridgeError('bridge_idle_timeout_invalid');
  for (const origin of config.allowedOrigins) normalizeAllowedOrigin(origin);
  if (!config.providerRegistry) throw new DesktopBridgeError('bridge_provider_registry_missing');
  if (!config.routePolicy) throw new DesktopBridgeError('bridge_route_policy_invalid');
  if (!Array.isArray(config.providerSessionPins)) throw new DesktopBridgeError('bridge_session_pin_invalid');
  if (typeof config.resolveProviderCredential !== 'function') throw new DesktopBridgeError('bridge_provider_credential_resolver_missing');
  assertRegistryAndPolicy(config, config.providerRegistry);
  if (!Object.values(config.providerRegistry.providers).some((provider) => provider.enabled)) {
    throw new DesktopBridgeError('bridge_provider_registry_no_enabled_provider');
  }
}

export async function prepareDesktopBridgeConfig(config: DesktopBridgeConfig, lookup: DesktopBridgeLookup = defaultLookup): Promise<PreparedDesktopBridgeConfig> {
  validateDesktopBridgeConfig(config);
  const entries = await Promise.all((Object.keys(config.providerRegistry.providers) as BridgeProviderId[]).map(async (id) => {
    const provider = config.providerRegistry.providers[id];
    if (!provider) throw new DesktopBridgeError('bridge_provider_registry_invalid');
    const prepared = await prepareProvider({ ...provider, remote: {} as DesktopBridgeRemoteTarget }, lookup);
    return [id, prepared] as const;
  }));
  const providers = Object.fromEntries(entries) as Record<BridgeProviderId, PreparedDesktopBridgeProvider>;
  return { ...config, providers };
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
