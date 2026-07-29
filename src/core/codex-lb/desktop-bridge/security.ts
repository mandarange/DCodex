import dns from 'node:dns/promises';
import net from 'node:net';
import type { DesktopBridgeConfig, DesktopBridgeRemoteTarget, PreparedDesktopBridgeConfig } from './types.js';
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
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('192.0.0.0', 24, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('192.0.2.0', 24, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('192.168.0.0', 16, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('198.18.0.0', 15, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('198.51.100.0', 24, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('203.0.113.0', 24, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('224.0.0.0', 4, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('240.0.0.0', 4, 'ipv4');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('::', 128, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('::1', 128, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('fc00::', 7, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('ff00::', 8, 'ipv6');
FORBIDDEN_REMOTE_ADDRESSES.addSubnet('2001:db8::', 32, 'ipv6');

export function assertLoopbackPeer(address: string | undefined): void {
  const normalized = String(address || '').replace(/^::ffff:/i, '');
  if (!net.isIP(normalized)) throw new DesktopBridgeError('bridge_peer_not_ip');
  if (normalized !== '127.0.0.1' && normalized !== '::1') {
    throw new DesktopBridgeError('bridge_non_loopback_peer');
  }
}

export function assertLoopbackListenHost(host: unknown): asserts host is DesktopBridgeConfig['listenHost'] {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new DesktopBridgeError('bridge_listen_host_not_loopback');
  }
}

export function assertAllowedPath(pathname: string, prefixes: readonly string[]): void {
  if (!pathname.startsWith('/') || pathname.includes('\\') || /%(?:2f|5c)/i.test(pathname)) {
    throw new DesktopBridgeError('bridge_path_invalid');
  }
  const allowed = prefixes.some((prefix) => {
    if (!prefix.startsWith('/')) return false;
    if (prefix.endsWith('/')) return pathname.startsWith(prefix);
    return pathname === prefix || pathname.startsWith(`${prefix}/`);
  });
  if (!allowed) throw new DesktopBridgeError('bridge_path_not_allowed');
}

function headerValues(value: string | string[] | undefined): string[] {
  return (Array.isArray(value) ? value : value === undefined ? [] : [value])
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function comparableOrigin(value: string, referer: boolean): string {
  if (value === 'null') return 'null';
  try {
    const parsed = new URL(value);
    if (referer) {
      return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
    }
    if ((parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
      throw new Error('origin_has_path');
    }
    return parsed.origin !== 'null' ? parsed.origin : `${parsed.protocol}//${parsed.host}`;
  } catch {
    throw new DesktopBridgeError('bridge_origin_invalid');
  }
}

export function normalizeAllowedOrigin(value: string): string {
  return comparableOrigin(String(value || '').trim(), false);
}

export function assertAllowedOrigin(
  headers: NodeJS.Dict<string | string[]>,
  allowedOrigins: readonly string[],
): void {
  const origins = headerValues(headers.origin);
  const referers = headerValues(headers.referer);
  if (origins.length === 0 && referers.length === 0) return;
  if (origins.length > 1 || referers.length > 1) throw new DesktopBridgeError('bridge_origin_forbidden');

  const allowed = new Set(allowedOrigins.map(normalizeAllowedOrigin));
  for (const origin of origins) {
    if (!allowed.has(comparableOrigin(origin, false))) throw new DesktopBridgeError('bridge_origin_forbidden');
  }
  for (const referer of referers) {
    if (!allowed.has(comparableOrigin(referer, true))) throw new DesktopBridgeError('bridge_origin_forbidden');
  }
}

export function assertWebSocketUpgrade(headers: NodeJS.Dict<string | string[]>, method: string | undefined): void {
  const connection = headerValues(headers.connection).join(',').toLowerCase().split(',').map((part) => part.trim());
  const upgrade = headerValues(headers.upgrade);
  const key = headerValues(headers['sec-websocket-key']);
  const version = headerValues(headers['sec-websocket-version']);
  if (
    method !== 'GET'
    || !connection.includes('upgrade')
    || upgrade.length !== 1
    || upgrade[0]?.toLowerCase() !== 'websocket'
    || key.length !== 1
    || version.length !== 1
  ) {
    throw new DesktopBridgeError('bridge_websocket_upgrade_invalid');
  }
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.replace(/^\[/, '').replace(/\]$/, '');
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.replace(/^::ffff:/i, '');
  if (normalized === '::1') return true;
  if (net.isIP(normalized) !== 4) return false;
  return Number(normalized.split('.')[0]) === 127;
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).replace(/\.$/, '').toLowerCase();
  return normalized === 'localhost' || isLoopbackAddress(normalized);
}

function isForbiddenRemoteAddress(address: string, family: 4 | 6): boolean {
  const dottedMapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1];
  const hexMapped = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  const mapped = dottedMapped || (hexMapped
    ? [
        Number.parseInt(hexMapped[1] || '0', 16) >> 8,
        Number.parseInt(hexMapped[1] || '0', 16) & 0xff,
        Number.parseInt(hexMapped[2] || '0', 16) >> 8,
        Number.parseInt(hexMapped[2] || '0', 16) & 0xff,
      ].join('.')
    : undefined);
  if (mapped) return FORBIDDEN_REMOTE_ADDRESSES.check(mapped, 'ipv4');
  return FORBIDDEN_REMOTE_ADDRESSES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export function validateDesktopBridgeConfig(config: DesktopBridgeConfig): URL {
  assertLoopbackListenHost(config.listenHost);
  if (!Number.isInteger(config.listenPort) || config.listenPort < MIN_HIGH_PORT || config.listenPort > MAX_PORT) {
    throw new DesktopBridgeError('bridge_listen_port_not_high');
  }
  if (!config.gatewayKey || /[\r\n\0]/.test(config.gatewayKey)) {
    throw new DesktopBridgeError('bridge_gateway_key_invalid');
  }
  if (config.gatewayAuthTransport !== 'x-codex-lb-api-key' && config.gatewayAuthTransport !== 'authorization-bearer-compat') {
    throw new DesktopBridgeError('bridge_gateway_auth_transport_invalid');
  }
  if (!Array.isArray(config.allowedPathPrefixes) || config.allowedPathPrefixes.length === 0) {
    throw new DesktopBridgeError('bridge_path_allowlist_empty');
  }
  if (!Number.isFinite(config.connectTimeoutMs) || config.connectTimeoutMs < 100 || config.connectTimeoutMs > 120_000) {
    throw new DesktopBridgeError('bridge_connect_timeout_invalid');
  }
  if (!Number.isFinite(config.idleTimeoutMs) || config.idleTimeoutMs < 1_000 || config.idleTimeoutMs > 86_400_000) {
    throw new DesktopBridgeError('bridge_idle_timeout_invalid');
  }
  for (const prefix of config.allowedPathPrefixes) {
    if (!prefix.startsWith('/') || prefix.includes('?') || prefix.includes('#') || prefix.includes('\\')) {
      throw new DesktopBridgeError('bridge_path_allowlist_invalid');
    }
  }
  for (const origin of config.allowedOrigins) normalizeAllowedOrigin(origin);

  let remote: URL;
  try {
    remote = new URL(config.remoteBaseUrl);
  } catch {
    throw new DesktopBridgeError('bridge_remote_url_invalid');
  }
  if (remote.username || remote.password) throw new DesktopBridgeError('bridge_remote_userinfo_forbidden');
  if (remote.hash || remote.search) throw new DesktopBridgeError('bridge_remote_base_url_query_forbidden');
  if (remote.protocol !== 'https:' && !(remote.protocol === 'http:' && isExplicitLoopbackHostname(remote.hostname))) {
    throw new DesktopBridgeError('bridge_remote_transport_forbidden');
  }
  return remote;
}

export type DesktopBridgeLookup = (
  hostname: string,
) => Promise<readonly { address: string; family: 4 | 6 }[]>;

const defaultLookup: DesktopBridgeLookup = async (hostname) => {
  const rows = await dns.lookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => {
    if (row.family !== 4 && row.family !== 6) throw new DesktopBridgeError('bridge_remote_dns_invalid');
    return { address: row.address, family: row.family };
  });
};

export async function prepareDesktopBridgeConfig(
  config: DesktopBridgeConfig,
  lookup: DesktopBridgeLookup = defaultLookup,
): Promise<PreparedDesktopBridgeConfig> {
  const remote = validateDesktopBridgeConfig(config);
  const hostname = stripIpv6Brackets(remote.hostname);
  const literalFamily = net.isIP(hostname);
  let addresses: readonly { address: string; family: 4 | 6 }[];
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await lookup(hostname);
  } catch (error) {
    throw new DesktopBridgeError('bridge_remote_dns_failed', { cause: error });
  }
  if (addresses.length === 0) throw new DesktopBridgeError('bridge_remote_dns_empty');
  if (addresses.some((row) => net.isIP(row.address) !== row.family)) {
    throw new DesktopBridgeError('bridge_remote_dns_invalid');
  }

  const explicitLoopback = isExplicitLoopbackHostname(hostname);
  if (explicitLoopback) {
    if (addresses.some((row) => !isLoopbackAddress(row.address))) {
      throw new DesktopBridgeError('bridge_remote_dns_rebinding_blocked');
    }
  } else if (addresses.some((row) => isForbiddenRemoteAddress(row.address, row.family))) {
    throw new DesktopBridgeError('bridge_remote_dns_private_address');
  }

  const selected = addresses[0];
  if (!selected) throw new DesktopBridgeError('bridge_remote_dns_empty');
  const port = Number(remote.port || (remote.protocol === 'https:' ? 443 : 80));
  const remoteTarget: DesktopBridgeRemoteTarget = {
    baseUrl: remote.toString().replace(/\/$/, ''),
    origin: remote.origin,
    hostname,
    port,
    secure: remote.protocol === 'https:',
    address: selected.address,
    family: selected.family,
    ...(literalFamily ? {} : { tlsServername: hostname }),
  };
  return { ...config, remoteBaseUrl: remoteTarget.baseUrl, remote: remoteTarget };
}

export function validatePreparedDesktopBridgeConfig(config: PreparedDesktopBridgeConfig): void {
  const remoteUrl = validateDesktopBridgeConfig(config);
  const expectedHostname = stripIpv6Brackets(remoteUrl.hostname);
  const expectedPort = Number(remoteUrl.port || (remoteUrl.protocol === 'https:' ? 443 : 80));
  if (
    config.remote.origin !== remoteUrl.origin
    || config.remote.hostname !== expectedHostname
    || config.remote.port !== expectedPort
    || config.remote.secure !== (remoteUrl.protocol === 'https:')
    || net.isIP(config.remote.address) !== config.remote.family
  ) {
    throw new DesktopBridgeError('bridge_prepared_config_invalid');
  }
  if (isExplicitLoopbackHostname(expectedHostname)) {
    if (!isLoopbackAddress(config.remote.address)) {
      throw new DesktopBridgeError('bridge_remote_dns_rebinding_blocked');
    }
  } else if (isForbiddenRemoteAddress(config.remote.address, config.remote.family)) {
    throw new DesktopBridgeError('bridge_remote_dns_private_address');
  }
}

export function resolveDesktopBridgeTarget(rawRequestUrl: string | undefined, remote: DesktopBridgeRemoteTarget): URL {
  const raw = String(rawRequestUrl || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//') || /[\r\n\0]/.test(raw)) {
    throw new DesktopBridgeError('bridge_request_target_invalid');
  }
  let inbound: URL;
  try {
    inbound = new URL(raw, 'http://bridge.invalid');
  } catch {
    throw new DesktopBridgeError('bridge_request_target_invalid');
  }
  return new URL(`${inbound.pathname}${inbound.search}`, remote.origin);
}

export function safeBridgeErrorCode(error: unknown): string {
  if (error instanceof DesktopBridgeError) return error.code;
  if (error instanceof Error && /^bridge_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'bridge_upstream_unavailable';
}
