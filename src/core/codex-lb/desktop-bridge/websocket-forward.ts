import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { BRIDGE_OFFICIAL_ROUTE_ID } from '../bridge-contracts.js';
import { buildOfficialPassthroughWebSocketHeaders, buildProviderWebSocketHeaders } from './header-policy.js';
import { createDesktopBridgeRejectionLogger } from './rejection-log.js';
import { rewriteLocationHeader } from './location-rewrite.js';
import { desktopBridgeOfficialPassthroughEnabled, resolveAndBindDesktopBridgeRouteContext, resolveCodexSessionIdentity, resolveDesktopBridgeTarget, safeBridgeErrorCode, singleBridgeHeader, canonicalSessionId } from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import {
  DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL,
  DesktopBridgeError,
  type DesktopBridgeResolvedCredential,
  type DesktopBridgeRouteContext,
  type DesktopBridgeWebSocketProbeOptions,
  type PreparedDesktopBridgeConfig,
  type PreparedDesktopBridgeProvider,
} from './types.js';
import type { WebSocketProbeResult } from '../bridge-contracts.js';

const MAX_HEAD = 64 * 1024;
const REDACTED_RESPONSE_HEADERS = new Set(['authorization', 'cookie', 'proxy-authenticate', 'proxy-authorization', 'set-cookie', 'x-api-key', 'x-codex-lb-api-key']);
const WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function serializeHeaders(headers: OutgoingHttpHeaders): string[] {
  return Object.entries(headers).flatMap(([name, value]) => value === undefined ? [] : Array.isArray(value) ? value.map((v) => `${name}: ${v}`) : [`${name}: ${value}`]);
}

function expectedAccept(key: string): string { return createHash('sha1').update(`${key}${WS_MAGIC}`).digest('base64'); }

function parseResponseHead(head: Buffer): { status: number; headers: Map<string, string> } {
  const lines = head.toString('latin1').split('\r\n');
  const match = lines.shift()?.match(/^HTTP\/1\.[01] (\d{3})(?: |$)/);
  if (!match) throw new DesktopBridgeError('desktop_bridge_websocket_upgrade_no_response');
  const headers = new Map<string, string>();
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon <= 0 || /^[ \t]/.test(line)) throw new DesktopBridgeError('desktop_bridge_websocket_upgrade_no_response');
    const name = line.slice(0, colon).toLowerCase();
    if (headers.has(name)) headers.set(name, `${headers.get(name)}, ${line.slice(colon + 1).trim()}`);
    else headers.set(name, line.slice(colon + 1).trim());
  }
  return { status: Number(match[1]), headers };
}

function validateUpgrade(head: Buffer, key: string, requestedProtocol: string | null): { status: number; protocol: string | null } {
  const parsed = parseResponseHead(head);
  if (parsed.status !== 101) throw new DesktopBridgeError('desktop_bridge_websocket_upgrade_failed');
  if (parsed.headers.get('sec-websocket-accept') !== expectedAccept(key)) throw new DesktopBridgeError('desktop_bridge_websocket_accept_invalid');
  const protocol = parsed.headers.get('sec-websocket-protocol') || null;
  if (requestedProtocol && protocol !== requestedProtocol) throw new DesktopBridgeError('desktop_bridge_websocket_protocol_mismatch');
  return { status: parsed.status, protocol };
}

function rewriteUpgradeResponseHead(head: Buffer, providerBaseUrl: string, localOrigin: string): Buffer {
  const lines = head.toString('latin1').split('\r\n'); const status = lines.shift();
  if (!status) throw new DesktopBridgeError('bridge_websocket_response_invalid');
  const output = [status];
  for (const line of lines) {
    if (!line) continue;
    const colon = line.indexOf(':'); if (colon <= 0) throw new DesktopBridgeError('bridge_websocket_response_invalid');
    const name = line.slice(0, colon).toLowerCase(); const value = line.slice(colon + 1).trim();
    if (REDACTED_RESPONSE_HEADERS.has(name) || name.startsWith('access-control-')) continue;
    output.push(name === 'location' ? `${line.slice(0, colon)}: ${rewriteLocationHeader(value, providerBaseUrl, localOrigin)}` : line);
  }
  return Buffer.from(`${output.join('\r\n')}\r\n\r\n`, 'latin1');
}

/** The model this thread is already pinned to, if any. */
function websocketPinnedModel(threadId: string | null, config: PreparedDesktopBridgeConfig): string | null {
  if (!threadId) return null;
  let canonical: string;
  try { canonical = canonicalSessionId(threadId); } catch { return null; }
  const pin = config.providerSessionPins.find((entry) => entry.thread_id === canonical);
  return pin?.public_model || null;
}

export async function prepareDesktopBridgeWebSocketRequest(req: IncomingMessage, config: PreparedDesktopBridgeConfig): Promise<{
  route: DesktopBridgeRouteContext; credential: DesktopBridgeResolvedCredential | null; provider: PreparedDesktopBridgeProvider | null;
}> {
  const sessionIdentity = resolveCodexSessionIdentity(req.headers);
  // A WebSocket upgrade carries no request body and no `x-sks-model` (that
  // header is SKS's own, and only its probes ever send it), while the HTTP path
  // reads the model from the JSON body. The model was therefore always empty
  // here, `model_routes['']` never resolved, and EVERY Codex Responses
  // WebSocket failed — invisibly, because HTTP fallback then served the turn.
  //
  // The thread's session pin already records the provider and model bound to
  // this thread, which is exactly the routing decision the upgrade lacks.
  const pinnedModel = websocketPinnedModel(sessionIdentity.thread_id, config);
  const publicModel = singleBridgeHeader(req.headers, 'x-sks-model') || pinnedModel || '';
  if (!publicModel && !(desktopBridgeOfficialPassthroughEnabled(config) && config.officialRemote)) {
    // Nothing has bound this thread yet, so the bridge genuinely cannot route
    // the upgrade. That is a permanent property of this request, not a flaky
    // upstream, and saying so is what lets the client fall back to HTTP at once
    // instead of burning its reconnect budget. With official passthrough
    // configured this case no longer exists: an unpinned upgrade rides through
    // to the official upstream with the client's own identity.
    throw new DesktopBridgeError('bridge_websocket_route_unresolvable');
  }
  const route = await resolveAndBindDesktopBridgeRouteContext({
    public_model: publicModel,
    session_id: sessionIdentity.thread_id,
    pathname: new URL(req.url || '/', 'http://bridge.invalid').pathname,
    transport: 'websocket', headers: req.headers,
  }, config);
  if (route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID) return { route, provider: null, credential: null };
  const provider = config.providers[route.provider_id];
  if (!provider) throw new DesktopBridgeError('bridge_provider_route_unavailable');
  const credential = await config.resolveProviderCredential(route.provider_id, provider.credential_generation);
  if (credential.provider_id !== route.provider_id || credential.generation !== provider.credential_generation
    || (provider.credential_fingerprint && credential.fingerprint !== provider.credential_fingerprint)) {
    throw new DesktopBridgeError('bridge_provider_credential_generation_mismatch');
  }
  return { route, provider, credential };
}

const logWebSocketRejection = createDesktopBridgeRejectionLogger();

/**
 * Report why the upgrade failed, rather than calling everything an unavailable
 * upstream.
 *
 * Every failure here — a route that could not be resolved, a credential
 * generation mismatch, a session identity problem — was reported to Codex as
 * `bridge_websocket_upstream_unavailable`, so the one code the user ever saw
 * named the one cause that was usually not responsible. This path also wrote
 * nothing to the bridge log, so there was no record to check afterwards either.
 */
/**
 * Codes describing a permanent property of the request rather than a transient
 * upstream condition. A client that retries these is guaranteed to fail again,
 * so they are answered `501 Not Implemented` — the bridge will never serve a
 * WebSocket for this request — instead of `502 Bad Gateway`, which invites the
 * caller to keep trying. Codex spends its whole reconnect budget on a retryable
 * answer before falling back to HTTP, which is the `Reconnecting 1/5 … 5/5`
 * banner users saw at the start of every conversation.
 */
const PERMANENT_UPGRADE_REFUSALS = new Set([
  'bridge_websocket_route_unresolvable',
  'catalog_model_route_missing',
  'bridge_provider_route_unavailable',
]);

/**
 * A late async failure can race the peer closing or a partially-written
 * upgrade response. Writing then raises ERR_STREAM_WRITE_AFTER_END as an
 * unhandled 'error' event and kills the whole bridge process.
 */
export function safeEndUpgradeSocket(socket: Duplex, payload: string): void {
  socket.on('error', () => undefined);
  if (socket.destroyed || (socket as { writableEnded?: boolean }).writableEnded) return;
  try {
    socket.end(payload);
  } catch {
    socket.destroy();
  }
}

function writeUpgradeFailure(client: Duplex, error: unknown, req?: IncomingMessage): void {
  const code = safeBridgeErrorCode(error) || 'bridge_websocket_upstream_unavailable';
  const permanent = PERMANENT_UPGRADE_REFUSALS.has(code);
  const status = permanent ? 501 : 502;
  const reason = permanent ? 'Not Implemented' : 'Bad Gateway';
  logWebSocketRejection({
    code,
    transport: 'websocket',
    ...(req?.method === undefined ? {} : { method: req.method }),
    ...(req?.url === undefined ? {} : { url: req.url }),
    status,
  });
  safeEndUpgradeSocket(
    client,
    `HTTP/1.1 ${status} ${reason}\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n`
      + JSON.stringify({ error: { type: 'sks_bridge_error', code, retryable: !permanent } }),
  );
}

export async function forwardWebSocket(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  config: PreparedDesktopBridgeConfig,
  authenticatedLocalBaseUrl = desktopBridgeListenOrigin(config),
): Promise<void> {
  let prepared;
  try { prepared = await prepareDesktopBridgeWebSocketRequest(req, config); }
  catch (error) {
    // Handled here in full: the refusal is written and logged. Rethrowing sent
    // the same error on to the server's own upgrade handler, which logged it a
    // second time under a different status — so one refusal produced two log
    // lines (501 then 400) and the second one misreported the outcome.
    writeUpgradeFailure(client, error, req);
    return;
  }
  const { provider, credential, route } = prepared;
  const official = route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID;
  const remote = official ? config.officialRemote : provider?.remote;
  if (!remote) {
    writeUpgradeFailure(client, new DesktopBridgeError(official ? 'bridge_official_passthrough_unavailable' : 'bridge_provider_route_unavailable'), req);
    return;
  }
  const upstreamBaseUrl = official ? remote.baseUrl : provider!.base_url;
  const target = resolveDesktopBridgeTarget(req.url, remote);
  const upstream = remote.secure
    ? tls.connect({ host: remote.address, port: remote.port, ...(remote.tlsServername ? { servername: remote.tlsServername } : {}) })
    : net.connect({ host: remote.address, port: remote.port, family: remote.family });
  const key = String(req.headers['sec-websocket-key'] || '');
  const requestedProtocol = String(req.headers['sec-websocket-protocol'] || '').split(',')[0]?.trim() || null;
  let connected = false; let response = Buffer.alloc(0);
  const timer = setTimeout(() => upstream.destroy(new DesktopBridgeError('bridge_upstream_connect_timeout')), config.connectTimeoutMs); timer.unref();
  const fail = (error?: unknown): void => { clearTimeout(timer); if (!connected) writeUpgradeFailure(client, error, req); else client.destroy(); };
  const onConnected = (): void => {
    connected = true; clearTimeout(timer); upstream.setNoDelay(true);
    // No idle destruction on an established WebSocket. A tunnel's liveness is
    // the endpoints' business: Codex keeps one Responses socket per session and
    // legitimately sends nothing for as long as the user is reading or thinking,
    // so an idle timer here guaranteed a teardown on every quiet session — the
    // client's momentary "reconnecting" flash at 예: idle_timeout_ms = 5 minutes,
    // on a machine where nothing was wrong. (An earlier fix attributed this
    // teardown instead of leaving it silent; the attribution revealed it should
    // not happen at all.) Dead peers are the one thing idle destruction actually
    // caught, and TCP keepalive reaps those without executing healthy-but-quiet
    // sessions: probes start after 30s of silence and a truly dead peer is torn
    // down by the OS in bounded time, which then propagates through the existing
    // close handlers on both legs.
    upstream.setKeepAlive(true, 30_000);
    const clientSocket = client as Partial<net.Socket>;
    if (typeof clientSocket.setKeepAlive === 'function') clientSocket.setKeepAlive(true, 30_000);
    const headers = official
      ? buildOfficialPassthroughWebSocketHeaders(req.headers, target.host)
      : buildProviderWebSocketHeaders(req.headers, { providerId: provider!.provider_id, authTransport: provider!.auth_transport, credential: credential! }, target.host);
    upstream.write([`${req.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`, ...serializeHeaders(headers), '', ''].join('\r\n'));
    if (head.length) upstream.write(head);
    const onData = (chunk: Buffer): void => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_HEAD) { upstream.destroy(new DesktopBridgeError('bridge_websocket_response_headers_too_large')); return; }
      const boundary = response.indexOf('\r\n\r\n'); if (boundary < 0) return;
      upstream.off('data', onData);
      const raw = response.subarray(0, boundary); const remaining = response.subarray(boundary + 4);
      try {
        validateUpgrade(raw, key, requestedProtocol);
        client.write(rewriteUpgradeResponseHead(raw, upstreamBaseUrl, authenticatedLocalBaseUrl));
        if (remaining.length) client.write(remaining);
      } catch (error) { upstream.destroy(error instanceof Error ? error : undefined); return; }
      client.pipe(upstream); upstream.pipe(client);
    };
    upstream.on('data', onData);
  };
  if (remote.secure) upstream.once('secureConnect', onConnected); else upstream.once('connect', onConnected);
  upstream.once('error', (error) => fail(error)); upstream.once('close', () => { clearTimeout(timer); if (!client.destroyed) client.end(); });
  client.once('error', () => upstream.destroy()); client.once('close', () => upstream.destroy());
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  if (payload.length > 125) throw new DesktopBridgeError('desktop_bridge_websocket_frame_send_failed');
  const mask = randomBytes(4); const encoded = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) encoded[i] = (payload[i] || 0) ^ (mask[i % 4] || 0);
  return Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | payload.length]), mask, encoded]);
}

function decodeServerFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) return null;
  const length = buffer[1]! & 0x7f; if ((buffer[1]! & 0x80) !== 0 || length === 126 || length === 127) throw new DesktopBridgeError('desktop_bridge_websocket_frame_invalid');
  if (buffer.length < 2 + length) return null;
  return { opcode: buffer[0]! & 0x0f, payload: buffer.subarray(2, 2 + length), consumed: 2 + length };
}

function probeResult(input: Partial<WebSocketProbeResult> & Pick<WebSocketProbeResult, 'state' | 'terminal_stage' | 'root_cause'>): WebSocketProbeResult {
  return {
    schema: 'sks.desktop-bridge-websocket-probe.v2', state: input.state, terminal_stage: input.terminal_stage,
    root_cause: input.root_cause, status_code: input.status_code ?? null, negotiated_protocol: input.negotiated_protocol ?? null,
    upgrade_verified: input.upgrade_verified === true, protocol_verified: input.protocol_verified === true,
    frame_round_trip_verified: input.frame_round_trip_verified === true, clean_close_verified: input.clean_close_verified === true,
    latency_ms: input.latency_ms ?? null, blockers: input.root_cause ? [input.root_cause] : [], warnings: input.warnings || [],
  };
}

async function probeOnce(options: Required<Omit<DesktopBridgeWebSocketProbeOptions, 'framePayload' | 'origin'>> & { framePayload: Buffer; origin: string | null }): Promise<WebSocketProbeResult> {
  const started = Date.now(); let url: URL;
  try { url = new URL(options.url); } catch { return probeResult({ state: 'blocked', terminal_stage: 'tcp_connect', root_cause: 'desktop_bridge_websocket_target_invalid' }); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return probeResult({ state: 'blocked', terminal_stage: 'tcp_connect', root_cause: 'desktop_bridge_websocket_target_invalid' });
  const key = randomBytes(16).toString('base64');
  return new Promise<WebSocketProbeResult>((resolve) => {
    let settled = false; let connected = false; let upgraded = false; let protocolVerified = false; let frameVerified = false; let buffer = Buffer.alloc(0);
    const socket = url.protocol === 'wss:' ? tls.connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname }) : net.connect({ host: url.hostname, port: Number(url.port || 80) });
    let stageTimer: NodeJS.Timeout;
    const timeoutResult = (): WebSocketProbeResult => probeResult({
      state: 'failed',
      terminal_stage: frameVerified ? 'clean_close' : upgraded ? 'frame_round_trip' : connected ? 'websocket_upgrade' : 'tcp_connect',
      root_cause: frameVerified ? 'desktop_bridge_websocket_close_failed' : upgraded ? 'desktop_bridge_websocket_frame_receive_failed' : connected ? 'desktop_bridge_websocket_upgrade_no_response' : 'desktop_bridge_tcp_connect_timeout',
      upgrade_verified: upgraded, protocol_verified: protocolVerified, frame_round_trip_verified: frameVerified,
    });
    const finish = (result: WebSocketProbeResult): void => { if (settled) return; settled = true; clearTimeout(stageTimer); socket.destroy(); resolve({ ...result, latency_ms: Date.now() - started }); };
    stageTimer = setTimeout(() => finish(timeoutResult()), Math.min(options.connectTimeoutMs, options.stageTimeoutMs));
    stageTimer.unref();
    socket.once('error', () => finish(probeResult({ state: 'failed', terminal_stage: upgraded ? 'frame_round_trip' : 'tcp_connect', root_cause: upgraded ? 'desktop_bridge_websocket_frame_receive_failed' : 'desktop_bridge_tcp_connect_failed', upgrade_verified: upgraded, protocol_verified: protocolVerified })));
    const onConnected = (): void => {
      connected = true;
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => finish(timeoutResult()), options.stageTimeoutMs);
      stageTimer.unref();
      const headers = [`GET ${url.pathname}${url.search} HTTP/1.1`, `Host: ${url.host}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13', `Sec-WebSocket-Key: ${key}`, `Sec-WebSocket-Protocol: ${options.protocol}`];
      if (options.origin) headers.push(`Origin: ${options.origin}`); socket.write(`${headers.join('\r\n')}\r\n\r\n`);
    };
    if (url.protocol === 'wss:') socket.once('secureConnect', onConnected); else socket.once('connect', onConnected);
    socket.once('close', () => {
      if (settled) return;
      finish(probeResult({
        state: 'failed', terminal_stage: frameVerified ? 'clean_close' : upgraded ? 'frame_round_trip' : connected ? 'websocket_upgrade' : 'tcp_connect',
        root_cause: frameVerified ? 'desktop_bridge_websocket_close_failed' : upgraded ? 'desktop_bridge_websocket_frame_receive_failed' : connected ? 'desktop_bridge_websocket_upgrade_no_response' : 'desktop_bridge_tcp_connect_failed',
        upgrade_verified: upgraded, protocol_verified: protocolVerified, frame_round_trip_verified: frameVerified,
      }));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        if (buffer.length > MAX_HEAD) return finish(probeResult({ state: 'failed', terminal_stage: 'websocket_upgrade', root_cause: 'desktop_bridge_websocket_upgrade_no_response' }));
        const boundary = buffer.indexOf('\r\n\r\n'); if (boundary < 0) return;
        try {
          const parsed = validateUpgrade(buffer.subarray(0, boundary), key, options.protocol); upgraded = true; protocolVerified = parsed.protocol === options.protocol; buffer = buffer.subarray(boundary + 4);
        } catch (error) {
          const code = error instanceof DesktopBridgeError ? error.code : 'desktop_bridge_websocket_upgrade_no_response';
          const stage = code.includes('protocol') ? 'websocket_protocol' : 'websocket_upgrade';
          return finish(probeResult({ state: 'failed', terminal_stage: stage, root_cause: code }));
        }
        if (options.handshakeOnly) return finish(probeResult({ state: options.requestedLevel === 'shallow' ? 'not_attempted' : 'degraded', terminal_stage: 'websocket_protocol', root_cause: null, status_code: 101, negotiated_protocol: options.protocol, upgrade_verified: true, protocol_verified: protocolVerified, frame_round_trip_verified: false, clean_close_verified: false, warnings: ['websocket_handshake_only_frame_not_attempted'] }));
        try { socket.write(encodeClientFrame(1, options.framePayload)); }
        catch { return finish(probeResult({ state: 'failed', terminal_stage: 'frame_round_trip', root_cause: 'desktop_bridge_websocket_frame_send_failed', status_code: 101, negotiated_protocol: options.protocol, upgrade_verified: true, protocol_verified: protocolVerified })); }
      }
      while (upgraded && !settled) {
        let frame;
        try { frame = decodeServerFrame(buffer); } catch { return finish(probeResult({ state: 'failed', terminal_stage: 'frame_round_trip', root_cause: 'desktop_bridge_websocket_frame_invalid', status_code: 101, negotiated_protocol: options.protocol, upgrade_verified: true, protocol_verified: protocolVerified })); }
        if (!frame) return; buffer = buffer.subarray(frame.consumed);
        if (frame.opcode === 1 || frame.opcode === 2) {
          if (!frame.payload.equals(options.framePayload)) return finish(probeResult({ state: 'failed', terminal_stage: 'frame_round_trip', root_cause: 'desktop_bridge_websocket_frame_invalid', status_code: 101, negotiated_protocol: options.protocol, upgrade_verified: true, protocol_verified: protocolVerified }));
          frameVerified = true; socket.write(encodeClientFrame(8, Buffer.from([0x03, 0xe8])));
        } else if (frame.opcode === 8 && frameVerified) {
          return finish(probeResult({ state: 'verified', terminal_stage: 'complete', root_cause: null, status_code: 101, negotiated_protocol: options.protocol, upgrade_verified: true, protocol_verified: protocolVerified, frame_round_trip_verified: true, clean_close_verified: true }));
        }
      }
    });
  });
}

export async function probeDesktopBridgeWebSocket(input: DesktopBridgeWebSocketProbeOptions): Promise<WebSocketProbeResult> {
  const maxRetries = Math.min(2, Math.max(0, input.maxRetries ?? 2));
  const total = Math.min(30_000, Math.max(500, input.totalTimeoutMs ?? 10_000));
  const started = Date.now(); const warnings: string[] = [];
  const options = {
    url: input.url, origin: input.origin || null, protocol: input.protocol || DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL,
    framePayload: Buffer.isBuffer(input.framePayload) ? input.framePayload : Buffer.from(input.framePayload || 'sks-desktop-bridge-probe'),
    handshakeOnly: input.handshakeOnly === true, requestedLevel: input.requestedLevel || 'transport', connectTimeoutMs: Math.max(100, input.connectTimeoutMs ?? 2_000),
    stageTimeoutMs: Math.max(100, input.stageTimeoutMs ?? 2_000), totalTimeoutMs: total, maxRetries, jitter: input.jitter || Math.random,
  };
  let result = probeResult({ state: 'failed', terminal_stage: 'tcp_connect', root_cause: 'desktop_bridge_tcp_connect_failed' });
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const remaining = total - (Date.now() - started);
    if (remaining <= 0) break;
    result = await probeOnce({
      ...options,
      connectTimeoutMs: Math.min(options.connectTimeoutMs, remaining),
      stageTimeoutMs: Math.min(options.stageTimeoutMs, remaining),
    });
    if (result.root_cause === null) return { ...result, warnings: [...warnings, ...result.warnings] };
    if (attempt < maxRetries) {
      warnings.push(`desktop_bridge_websocket_retry:${attempt + 1}:${result.root_cause || 'unknown'}`);
      const delay = Math.min(500, 50 * (2 ** attempt) + Math.floor(Math.max(0, Math.min(1, options.jitter())) * 25));
      if (Date.now() - started + delay >= total) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  return { ...result, blockers: result.root_cause ? [result.root_cause] : [], warnings: [...warnings, ...result.warnings] };
}
