import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';
import type { BridgeProviderId } from '../bridge-contracts.js';
import { rewriteLocationHeader } from './location-rewrite.js';
import type {
  DesktopBridgeProviderAuthTransport,
  DesktopBridgeResolvedCredential,
} from './types.js';
import { DesktopBridgeError } from './types.js';

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const INTERNAL_PREFIX = 'x-sks-';
const REQUEST_HEADER_ALLOWLIST = new Set([
  'accept', 'accept-encoding', 'cache-control', 'content-encoding', 'content-length', 'content-type',
]);
// Non-credential Codex session metadata the ChatGPT backend requires on
// /backend-api/codex/responses; dropping these makes the codex-lb gateway's
// upstream call fail for real Codex CLI traffic. Codex sends both hyphen and
// underscore spellings across versions.
const CODEX_LOCAL_HEADERS = new Set([
  'thread-id', 'thread_id', 'session-id', 'session_id', 'x-client-request-id',
  'x-codex-installation-id', 'x-codex-turn-metadata', 'x-codex-window-id',
  'originator', 'openai-beta',
]);
const NEVER_FORWARD_FROM_CLIENT = new Set([
  'authorization', 'cookie', 'forwarded', 'proxy-authorization', 'x-api-key', 'x-codex-lb-api-key',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-proto', 'x-real-ip',
]);
const NEVER_FORWARD_TO_CLIENT = new Set([
  'authorization', 'cookie', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-codex-lb-api-key',
]);
const OPENROUTER_CLIENT_HEADERS = new Set(['http-referer', 'x-title']);
const WEBSOCKET_HEADER_ALLOWLIST = new Set([
  'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions',
]);

function connectionTokens(inbound: IncomingHttpHeaders): Set<string> {
  const values = Array.isArray(inbound.connection) ? inbound.connection : inbound.connection ? [inbound.connection] : [];
  return new Set(values.flatMap((v) => v.split(',')).map((v) => v.trim().toLowerCase()).filter(Boolean));
}

function injectCredential(
  result: OutgoingHttpHeaders,
  providerId: BridgeProviderId,
  transport: DesktopBridgeProviderAuthTransport,
  credential: DesktopBridgeResolvedCredential,
): void {
  if (credential.provider_id !== providerId || !credential.value || /[\r\n\0]/.test(credential.value)) {
    throw new DesktopBridgeError('bridge_provider_credential_invalid');
  }
  if (providerId === 'openrouter' && transport !== 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
  if (providerId === 'codex-lb' && transport === 'openrouter-bearer') throw new DesktopBridgeError('bridge_provider_auth_transport_mismatch');
  if (transport === 'x-codex-lb-api-key') result['x-codex-lb-api-key'] = credential.value;
  else result.authorization = `Bearer ${credential.value}`;
}

export function buildProviderUpstreamHeaders(
  inbound: IncomingHttpHeaders,
  context: {
    providerId: BridgeProviderId;
    authTransport: DesktopBridgeProviderAuthTransport;
    credential: DesktopBridgeResolvedCredential;
  },
  upstreamHost: string,
): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    const providerAllowed = (context.providerId === 'openrouter' && OPENROUTER_CLIENT_HEADERS.has(name))
      || (context.providerId === 'codex-lb' && CODEX_LOCAL_HEADERS.has(name));
    if (!REQUEST_HEADER_ALLOWLIST.has(name) && !providerAllowed) continue;
    result[name] = rawValue;
  }
  result.host = upstreamHost;
  injectCredential(result, context.providerId, context.authTransport, context.credential);
  return result;
}

export function buildProviderWebSocketHeaders(
  inbound: IncomingHttpHeaders,
  context: Parameters<typeof buildProviderUpstreamHeaders>[1],
  upstreamHost: string,
): OutgoingHttpHeaders {
  const result = buildProviderUpstreamHeaders(inbound, context, upstreamHost);
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (WEBSOCKET_HEADER_ALLOWLIST.has(name)) result[name] = rawValue;
  }
  result.connection = 'Upgrade';
  result.upgrade = 'websocket';
  return result;
}

export function rewriteResponseHeaders(inbound: IncomingHttpHeaders, providerBaseUrl: string, localOrigin: string): OutgoingHttpHeaders {
  const result: OutgoingHttpHeaders = {};
  const dynamic = connectionTokens(inbound);
  for (const [rawName, rawValue] of Object.entries(inbound)) {
    if (rawValue === undefined) continue;
    const name = rawName.toLowerCase();
    if (HOP_BY_HOP.has(name) || dynamic.has(name) || NEVER_FORWARD_TO_CLIENT.has(name) || name.startsWith('access-control-')) continue;
    if (name === 'location') {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      if (values.length !== 1 || !values[0]) throw new DesktopBridgeError('bridge_location_header_invalid');
      result.location = rewriteLocationHeader(values[0], providerBaseUrl, localOrigin);
    } else result[name] = rawValue;
  }
  return result;
}

export function isRedactedHeaderName(name: string): boolean {
  const normalized = name.toLowerCase();
  return NEVER_FORWARD_FROM_CLIENT.has(normalized)
    || NEVER_FORWARD_TO_CLIENT.has(normalized)
    || CODEX_LOCAL_HEADERS.has(normalized)
    || normalized.startsWith(INTERNAL_PREFIX);
}

export function redactHeaderValue(name: string, value: unknown): string {
  return isRedactedHeaderName(name) ? '[REDACTED]' : String(value ?? '');
}
