import dns from 'node:dns/promises';
import net from 'node:net';
import type { BridgeProviderId, BridgeRoutingPolicy, ProviderSessionPin } from '../bridge-contracts.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
} from '../route-index.js';
import type {
  DesktopBridgeConfig,
  DesktopBridgeProviderRegistrySnapshot,
  DesktopBridgeRemoteTarget,
  DesktopBridgeRouteContext,
  DesktopBridgeRouteRequest,
  PreparedDesktopBridgeConfig,
  PreparedDesktopBridgeProvider,
} from './types.js';
import { DESKTOP_BRIDGE_CLIENT_PATH_PREFIX, DesktopBridgeError } from './types.js';

const MIN_HIGH_PORT = 49_152;
const MAX_PORT = 65_535;
const MAX_SESSION_PINS = 10_000;
const sessionPinMutationQueues = new WeakMap<PreparedDesktopBridgeConfig, Promise<void>>();

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

export function desktopBridgeClientPath(capability: string, canonicalPath: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) throw new DesktopBridgeError('bridge_client_capability_invalid');
  if (!canonicalPath.startsWith('/') || canonicalPath.includes('\\') || /[\r\n\0]/.test(canonicalPath)) {
    throw new DesktopBridgeError('bridge_request_target_invalid');
  }
  return `${DESKTOP_BRIDGE_CLIENT_PATH_PREFIX}/${capability}${canonicalPath}`;
}

function headerValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).map((v) => v.trim()).filter(Boolean);
}

export function singleBridgeHeader(headers: NodeJS.Dict<string | string[]>, name: string): string | null {
  const values = headerValues(headers[name.toLowerCase()]);
  if (values.length > 1) throw new DesktopBridgeError('bridge_policy_header_ambiguous');
  return values[0] || null;
}

export interface CodexSessionIdentity {
  thread_id: string | null;
  session_id: string | null;
}

function codexMetadataObject(value: unknown, source: 'header' | 'body'): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  let parsed = value;
  if (source === 'header') {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 16 * 1024) {
      throw new DesktopBridgeError('bridge_codex_turn_metadata_invalid');
    }
    try { parsed = JSON.parse(value); }
    catch { throw new DesktopBridgeError('bridge_codex_turn_metadata_invalid'); }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DesktopBridgeError(source === 'header'
      ? 'bridge_codex_turn_metadata_invalid'
      : 'bridge_codex_client_metadata_invalid');
  }
  return parsed as Record<string, unknown>;
}

function oneCodexIdentity(values: unknown[], kind: 'thread' | 'session'): string | null {
  const canonical = values
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(canonicalSessionId);
  if (new Set(canonical).size > 1) throw new DesktopBridgeError('bridge_codex_session_identity_conflict');
  return canonical[0] || null;
}

export function resolveCodexSessionIdentity(
  headers: NodeJS.Dict<string | string[]>,
  payload: Record<string, unknown> | null = null,
): CodexSessionIdentity {
  const turnMetadataValue = singleBridgeHeader(headers, 'x-codex-turn-metadata');
  const turnMetadata = turnMetadataValue === null ? null : codexMetadataObject(turnMetadataValue, 'header');
  const clientMetadataValue = payload?.client_metadata;
  const clientMetadata = clientMetadataValue === undefined ? null : codexMetadataObject(clientMetadataValue, 'body');
  const threadId = oneCodexIdentity([
    singleBridgeHeader(headers, 'thread-id'),
    turnMetadata?.thread_id,
    clientMetadata?.thread_id,
  ], 'thread');
  const sessionId = oneCodexIdentity([
    singleBridgeHeader(headers, 'session-id'),
    turnMetadata?.session_id,
    clientMetadata?.session_id,
  ], 'session');
  if (sessionId && !threadId) throw new DesktopBridgeError('bridge_codex_thread_id_missing');
  // `thread_id` and `session_id` are DIFFERENT identifiers and coincide only on a
  // root turn. A spawned agent runs in its own thread inside the parent's
  // session, so Codex sends the child's `thread_id` with the session's unchanged
  // `session_id`. Requiring equality therefore rejected EVERY subagent request
  // with `bridge_codex_session_identity_mismatch`, which is why no subagent
  // could run. Codex 0.147's turn metadata carries `parent_thread_id`,
  // `parent_turn_id`, `forked_from_thread_id` and `subagent_kind` precisely
  // because a thread is not its session; forked and resumed threads diverge the
  // same way, and a WebSocket upgrade carries no turn metadata to tell them
  // apart, so there is no shape of this equality that is safe to assert.
  //
  // Nothing downstream reads `session_id`: both callers key the route and the
  // provider pin on `thread_id`, which is correct — affinity belongs to the
  // thread, and giving each spawned thread its own pin is what lets subagents
  // run in parallel. Cross-source disagreement about the SAME field is still a
  // hard conflict (`oneCodexIdentity`), which is the check that has real value.
  return { thread_id: threadId, session_id: sessionId };
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

function canonicalPublicModel(value: unknown): string {
  const model = canonicalizeBridgeModelId(value);
  if (!model) throw new DesktopBridgeError('catalog_model_route_missing');
  return model;
}

export function resolveBridgeRequestRoute(
  request: DesktopBridgeRouteRequest,
  policy: BridgeRoutingPolicy,
  pins: readonly ProviderSessionPin[],
): DesktopBridgeRouteContext {
  const publicModel = canonicalPublicModel(request.public_model);
  const sessionId = request.session_id ? canonicalSessionId(request.session_id) : null;
  const pin = sessionId ? pins.find((entry) => entry.thread_id === sessionId) || null : null;
  if (pin && pin.public_model === publicModel) {
    // A pin exists to keep a thread on its provider, and that is the only thing
    // worth refusing over. Its generation stamps are bookkeeping: since
    // `policy_generation` digests the entire route map, any unrelated catalog
    // churn ages every live pin at once, and rejecting on that alone is what
    // surfaced as an intermittent `session_pin_route_unavailable` mid-session.
    const current = policy.model_routes[publicModel];
    if (!current || current.provider_id !== pin.provider_id || current.upstream_model !== pin.upstream_model) {
      throw new DesktopBridgeError('session_pin_route_unavailable');
    }
    const aged = pin.catalog_generation !== policy.catalog_generation
      || pin.route_policy_generation !== policy.policy_generation;
    return {
      provider_id: pin.provider_id,
      public_model: publicModel,
      upstream_model: pin.upstream_model,
      // Always the live generations: the context is re-checked against the
      // current policy downstream, so replaying the pin's own stamps here would
      // fail that check for the very drift this branch just forgave.
      catalog_generation: policy.catalog_generation,
      route_policy_generation: policy.policy_generation,
      session_pin: aged
        ? {
            ...pin,
            catalog_generation: policy.catalog_generation,
            route_policy_generation: policy.policy_generation,
          }
        : pin,
    };
  }
  const route = policy.model_routes[publicModel];
  if (!route) throw new DesktopBridgeError('catalog_model_route_missing');
  const nextPin = sessionId ? {
    thread_id: sessionId,
    provider_id: route.provider_id,
    public_model: publicModel,
    upstream_model: route.upstream_model,
    catalog_generation: policy.catalog_generation,
    route_policy_generation: policy.policy_generation,
    created_at: new Date().toISOString(),
  } satisfies ProviderSessionPin : null;
  return {
    provider_id: route.provider_id,
    public_model: publicModel,
    upstream_model: route.upstream_model,
    catalog_generation: policy.catalog_generation,
    route_policy_generation: policy.policy_generation,
    session_pin: nextPin,
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
  if (request.session_id) {
    const sessionId = canonicalSessionId(request.session_id);
    if (!route.session_pin
      || route.session_pin.thread_id !== sessionId
      || route.session_pin.provider_id !== route.provider_id
      || route.session_pin.public_model !== route.public_model
      || route.session_pin.upstream_model !== route.upstream_model
      || route.session_pin.catalog_generation !== route.catalog_generation
      || route.session_pin.route_policy_generation !== route.route_policy_generation) {
      throw new DesktopBridgeError('bridge_session_pin_invalid');
    }
  } else if (route.session_pin) {
    throw new DesktopBridgeError('bridge_session_pin_invalid');
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

export async function resolveAndBindDesktopBridgeRouteContext(
  request: DesktopBridgeRouteRequest,
  config: PreparedDesktopBridgeConfig,
): Promise<DesktopBridgeRouteContext> {
  return withSessionPinMutation(config, async () => {
    const route = assertDesktopBridgeRouteContext(request, config);
    const pin = route.session_pin;
    if (!pin) return route;
    const existing = config.providerSessionPins.find((entry) => entry.thread_id === pin.thread_id) || null;
    if (existing && sameSessionPin(existing, pin)) return route;
    const nextPins = [
      ...config.providerSessionPins.filter((entry) => entry.thread_id !== pin.thread_id),
      pin,
    ];
    const retainedPins = nextPins.length > MAX_SESSION_PINS
      ? nextPins
        .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at)
          || left.thread_id.localeCompare(right.thread_id))
        .slice(nextPins.length - MAX_SESSION_PINS)
      : nextPins;
    const persistedPins = retainedPins.sort((left, right) => left.thread_id.localeCompare(right.thread_id));
    if (config.persistProviderSessionPins) {
      await config.persistProviderSessionPins(persistedPins);
    }
    config.providerSessionPins = persistedPins;
    return route;
  });
}

async function withSessionPinMutation<T>(
  config: PreparedDesktopBridgeConfig,
  action: () => Promise<T>,
): Promise<T> {
  const previous = sessionPinMutationQueues.get(config) || Promise.resolve();
  const run = previous.catch(() => undefined).then(action);
  const tail = run.then(() => undefined, () => undefined);
  sessionPinMutationQueues.set(config, tail);
  try {
    return await run;
  } finally {
    if (sessionPinMutationQueues.get(config) === tail) sessionPinMutationQueues.delete(config);
  }
}

function sameSessionPin(left: ProviderSessionPin, right: ProviderSessionPin): boolean {
  return left.thread_id === right.thread_id
    && left.provider_id === right.provider_id
    && left.public_model === right.public_model
    && left.upstream_model === right.upstream_model
    && left.catalog_generation === right.catalog_generation
    && left.route_policy_generation === right.route_policy_generation;
}

export function canonicalSessionId(value: unknown): string {
  const sessionId = typeof value === 'string' ? value.trim() : '';
  if (!sessionId || sessionId.length > 256 || !/^[A-Za-z0-9._:/-]+$/.test(sessionId)) {
    throw new DesktopBridgeError('bridge_session_id_invalid');
  }
  return sessionId;
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

export async function resolveDesktopBridgeRemoteTarget(
  raw: string,
  lookup: DesktopBridgeLookup = defaultLookup,
): Promise<DesktopBridgeRemoteTarget> {
  const remote = validateRemoteUrl(raw);
  const hostname = stripIpv6Brackets(remote.hostname);
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
  return target;
}

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
  const target = await resolveDesktopBridgeRemoteTarget(provider.base_url, lookup);
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
    if (canonicalizeBridgeModelId(model) !== model
      || !ids.includes(route.provider_id)
      || normalizeBridgeUpstreamModelId(route.upstream_model) !== route.upstream_model) {
      throw new DesktopBridgeError('bridge_route_policy_invalid');
    }
  }
  const pinIds = new Set<string>();
  for (const pin of config.providerSessionPins) {
    const keys = Object.keys(pin as unknown as Record<string, unknown>);
    if (keys.some((key) => ![
      'thread_id', 'provider_id', 'public_model', 'upstream_model',
      'catalog_generation', 'route_policy_generation', 'created_at',
    ].includes(key))
      || canonicalSessionId(pin.thread_id) !== pin.thread_id
      || pinIds.has(pin.thread_id)
      || !ids.includes(pin.provider_id)
      || canonicalizeBridgeModelId(pin.public_model) !== pin.public_model
      || normalizeBridgeUpstreamModelId(pin.upstream_model) !== pin.upstream_model
      || !pin.catalog_generation
      || !pin.route_policy_generation
      || !Number.isFinite(Date.parse(pin.created_at))) {
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
  if (config.requestTimeoutMs !== undefined
    && (!Number.isFinite(config.requestTimeoutMs) || config.requestTimeoutMs < 1_000 || config.requestTimeoutMs > 120_000)) {
    throw new DesktopBridgeError('bridge_request_timeout_invalid');
  }
  if (config.maxConcurrentRequests !== undefined
    && (!Number.isInteger(config.maxConcurrentRequests) || config.maxConcurrentRequests < 1 || config.maxConcurrentRequests > 1_024)) {
    throw new DesktopBridgeError('bridge_concurrent_request_limit_invalid');
  }
  if (config.maxConnections !== undefined
    && (!Number.isInteger(config.maxConnections) || config.maxConnections < 1 || config.maxConnections > 2_048)) {
    throw new DesktopBridgeError('bridge_connection_limit_invalid');
  }
  for (const origin of config.allowedOrigins) normalizeAllowedOrigin(origin);
  if (!config.providerRegistry) throw new DesktopBridgeError('bridge_provider_registry_missing');
  if (!config.routePolicy) throw new DesktopBridgeError('bridge_route_policy_invalid');
  if (!Array.isArray(config.providerSessionPins)) throw new DesktopBridgeError('bridge_session_pin_invalid');
  if (!/^[a-f0-9]{64}$/.test(config.clientCapabilitySha256)) throw new DesktopBridgeError('bridge_client_capability_invalid');
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
  const base = new URL(remote.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const providerRelative = providerRelativePath(inbound.pathname);
  const pathname = providerRelative === null
    ? inbound.pathname
    : `${basePath}${providerRelative}` || '/';
  return new URL(`${pathname}${inbound.search}`, remote.origin);
}

function providerRelativePath(pathname: string): string | null {
  for (const prefix of ['/backend-api/codex', '/api/v1', '/v1']) {
    if (pathname === prefix) return '';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  }
  return null;
}

export function safeBridgeErrorCode(error: unknown): string {
  if (error instanceof DesktopBridgeError) return error.code;
  if (error instanceof Error && /^bridge_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'bridge_upstream_unavailable';
}
