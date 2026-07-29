import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { DesktopBridgeConfig } from './types.js';
import { rewriteLocationHeader } from './location-rewrite.js';
import { DesktopBridgeError } from './types.js';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const NEVER_FORWARD_FROM_CLIENT = new Set([
  'authorization',
  'cookie',
  'forwarded',
  'proxy-authorization',
  'x-codex-lb-api-key',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);

const NEVER_FORWARD_TO_CLIENT = new Set([
  'authorization',
  'cookie',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'x-codex-lb-api-key',
]);

function connectionTokens(inbound: IncomingHttpHeaders): Set<string> {
  const raw = inbound.connection;
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return new Set(values.flatMap((value) => value.split(',')).map((value) => value.trim().toLowerCase()).filter(Boolean));
}

function injectGatewayCredential(
  result: OutgoingHttpHeaders,
  gatewayKey: string,
  transport: DesktopBridgeConfig['gatewayAuthTransport'],
): void {
  if (transport === 'x-codex-lb-api-key') {
    result['x-codex-lb-api-key'] = gatewayKey;
    return;
  }
  result.authorization = `Bearer ${gatewayKey}`;
}

export function buildUpstreamHeaders(
  inbound: IncomingHttpHeaders,
  config: Pick<DesktopBridgeConfig, 'gatewayKey' | 'gatewayAuthTransport'>,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const dynamicHopByHop = connectionTokens(inbound);
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || dynamicHopByHop.has(name)) continue;
    if (NEVER_FORWARD_FROM_CLIENT.has(name) || name === 'host') continue;
    result[name] = rawValue;
  }
  result.host = upstreamHost;
  injectGatewayCredential(result, config.gatewayKey, config.gatewayAuthTransport);
  return result;
}

export function buildWebSocketHeaders(
  inbound: IncomingHttpHeaders,
  config: Pick<DesktopBridgeConfig, 'gatewayKey' | 'gatewayAuthTransport'>,
  upstreamHost: string,
): OutgoingHttpHeaders {
  const result = buildUpstreamHeaders(inbound, config, upstreamHost);
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (name === 'connection' || name === 'upgrade' || name.startsWith('sec-websocket-')) {
      result[name] = rawValue;
    }
  }
  result.connection = 'Upgrade';
  result.upgrade = 'websocket';
  return result;
}

export function rewriteResponseHeaders(
  inbound: IncomingHttpHeaders,
  config: DesktopBridgeConfig,
  localOrigin: string,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const dynamicHopByHop = connectionTokens(inbound);
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || dynamicHopByHop.has(name) || NEVER_FORWARD_TO_CLIENT.has(name)) continue;
    if (name.startsWith('access-control-')) continue;
    if (name === 'location') {
      if (Array.isArray(rawValue) && rawValue.length !== 1) {
        throw new DesktopBridgeError('bridge_location_header_invalid');
      }
      const location = Array.isArray(rawValue) ? rawValue[0] : rawValue;
      if (!location) throw new DesktopBridgeError('bridge_location_header_invalid');
      result.location = rewriteLocationHeader(location, config.remoteBaseUrl, localOrigin);
      continue;
    }
    result[name] = rawValue;
  }
  return result;
}

export function isRedactedHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return NEVER_FORWARD_FROM_CLIENT.has(normalized)
    || NEVER_FORWARD_TO_CLIENT.has(normalized)
    || normalized === 'set-cookie';
}
