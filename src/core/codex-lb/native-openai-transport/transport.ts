import type { ProviderMode } from '../../architecture-hardening/contracts/contracts.js';

export const NATIVE_OPENAI_PROVIDER_ID = 'openai' as const;
export const FORBIDDEN_INBOUND_CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-codex-lb-api-key',
  'openai-organization',
  'cookie',
  'set-cookie'
]);

export interface NativeOpenAiTransportContract {
  readonly schema: 'sks.native-openai-transport.v1';
  readonly native_provider_id: typeof NATIVE_OPENAI_PROVIDER_ID;
  readonly mode: Exclude<ProviderMode, 'chatgpt-oauth'>;
  readonly credential_class: 'codex-lb-api-key' | 'openrouter-api-key';
  readonly listen_origin: string;
  readonly http_passthrough: true;
  readonly websocket_passthrough: boolean;
}

export function createNativeOpenAiTransportContract(input: {
  nativeProviderId: string;
  mode: Exclude<ProviderMode, 'chatgpt-oauth'>;
  listenOrigin: string;
}): NativeOpenAiTransportContract {
  if (input.nativeProviderId !== NATIVE_OPENAI_PROVIDER_ID) throw new Error('native_transport_external_provider_forbidden');
  const origin = assertLoopbackHttpOrigin(input.listenOrigin);
  return {
    schema: 'sks.native-openai-transport.v1',
    native_provider_id: NATIVE_OPENAI_PROVIDER_ID,
    mode: input.mode,
    credential_class: input.mode === 'codex-lb' ? 'codex-lb-api-key' : 'openrouter-api-key',
    listen_origin: origin,
    http_passthrough: true,
    websocket_passthrough: input.mode === 'codex-lb'
  };
}

export function buildProviderUpstreamHeaders(
  contract: NativeOpenAiTransportContract,
  inbound: Readonly<Record<string, string | readonly string[] | undefined>>,
  upstreamCredential: string
): Record<string, string | readonly string[]> {
  const credential = String(upstreamCredential || '').trim();
  if (!credential) throw new Error('native_transport_upstream_credential_missing');
  const headers: Record<string, string | readonly string[]> = {};
  for (const [rawName, value] of Object.entries(inbound)) {
    const name = rawName.toLowerCase();
    if (value === undefined || FORBIDDEN_INBOUND_CREDENTIAL_HEADERS.has(name)) continue;
    if (/[^a-z0-9!#$%&'*+.^_`|~-]/.test(name)) throw new Error('native_transport_header_name_invalid');
    headers[name] = value;
  }
  if (contract.mode === 'codex-lb') headers['x-codex-lb-api-key'] = credential;
  else headers.authorization = `Bearer ${credential}`;
  return headers;
}

export function assertNativeFeaturePassthrough(
  contract: NativeOpenAiTransportContract,
  input: { protocol: 'http' | 'websocket'; path: string }
): void {
  if (!input.path.startsWith('/') || /[\r\n\0]/.test(input.path)) throw new Error('native_transport_path_invalid');
  if (input.protocol === 'websocket' && !contract.websocket_passthrough) {
    throw new Error('native_transport_websocket_unsupported_for_mode');
  }
}

export function preserveNativeMetadata<T extends Readonly<Record<string, unknown>>>(metadata: T): T {
  return structuredClone(metadata);
}

function assertLoopbackHttpOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('native_transport_loopback_invalid');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(host) || parsed.username || parsed.password) {
    throw new Error('native_transport_loopback_required');
  }
  return parsed.origin;
}
