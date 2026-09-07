import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import WebSocket, { WebSocketServer, type RawData } from 'ws';
import { BRIDGE_OFFICIAL_ROUTE_ID } from '../bridge-contracts.js';
import { buildOfficialPassthroughWebSocketHeaders, buildProviderWebSocketHeaders } from './header-policy.js';
import { createDesktopBridgeRejectionLogger } from './rejection-log.js';
import { assertDesktopBridgeRouteContext, ensureDesktopBridgeRemoteTarget, isUnreachableUpstreamError, refreshDesktopBridgeRemoteTarget, resolveAndBindDesktopBridgeRouteContext, resolveCodexSessionIdentity, resolveDesktopBridgeTarget, safeBridgeErrorCode } from './security.js';
import { DesktopBridgeError, type DesktopBridgeRouteContext, type PreparedDesktopBridgeConfig } from './types.js';

const MAX_PENDING_MESSAGES = 256;
const CLOSE_GRACE_MS = 1_000;
/**
 * Codex prewarms a Responses WebSocket at startup and keeps it idle until the
 * first turn, which may be minutes or hours later. An accepted socket that has
 * not sent a create holds no upstream connection, so the only bound it needs
 * is an hour-scale leak guard matched to upstream connection lifetimes; a
 * request-scale timeout here would tear down every prewarmed connection.
 */
const INITIAL_CREATE_TIMEOUT_MS = 60 * 60_000;
const logRejection = createDesktopBridgeRejectionLogger();

export function isResponsesWebSocketRequest(req: IncomingMessage): boolean {
  const pathname = new URL(req.url || '/', 'http://bridge.invalid').pathname;
  return ['/backend-api/codex/responses', '/api/v1/responses', '/v1/responses'].includes(pathname);
}

function bytes(data: RawData): Buffer {
  return Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

interface PendingMessage { data: Buffer; binary: boolean; create: Record<string, unknown> | null; originalBytes: number }

/** Accept locally, then choose the upstream from the first Responses create event. */
export function forwardResponsesWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, config: PreparedDesktopBridgeConfig): void {
  // Authentication, origin and path validation are performed by the server before dispatch.
  const upgradeIdentity = resolveCodexSessionIdentity(req.headers);
  const maxBytes = config.maxRequestBodyBytes ?? 16 * 1024 * 1024;
  const server = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: maxBytes });
  // This server owns no listening handle.
  try {
    server.handleUpgrade(req, socket, head, (client) => {
      bridge(client);
    });
  } finally { server.close(); }

  function bridge(client: WebSocket): void {
    let identity = upgradeIdentity;
    let upstream: WebSocket | null = null;
    let upstreamSocket: net.Socket | null = null;
    let bound: DesktopBridgeRouteContext | null = null;
    let boundBaseUrl: string | null = null;
    let boundCredentialGeneration: string | null = null;
    let boundCredentialFingerprint: string | null = null;
    let stopped = false;
    let processing = false;
    let pendingBytes = 0;
    const pending: PendingMessage[] = [];
    let closeTimer: NodeJS.Timeout | null = null;
    let handshakeTimer: NodeJS.Timeout | null = null;
    const initialTimer = setTimeout(closeUnbound, config.websocketInitialCreateTimeoutMs ?? INITIAL_CREATE_TIMEOUT_MS);
    initialTimer.unref();
    const localSocket = socket as Partial<net.Socket>;
    localSocket.setKeepAlive?.(true, 30_000);

    function stop(): void {
      if (stopped) return;
      stopped = true;
      clearTimeout(initialTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      pending.length = 0; pendingBytes = 0;
      // Bound closing handshakes, including peers that never acknowledge close.
      closeTimer = setTimeout(() => { client.terminate(); upstream?.terminate(); upstreamSocket?.destroy(); }, CLOSE_GRACE_MS);
      closeTimer.unref();
    }
    function fail(error: unknown): void {
      if (stopped) return;
      const code = safeBridgeErrorCode(error);
      logRejection({ code, transport: 'websocket', ...(req.method ? { method: req.method } : {}), ...(req.url ? { url: req.url } : {}) });
      stop();
      if (client.readyState === WebSocket.OPEN) {
        if (client.bufferedAmount < maxBytes) client.send(JSON.stringify({ type: 'error', error: { type: 'sks_bridge_error', code, message: code } }), () => undefined);
        client.close(1011, code.slice(0, 123));
      }
      upstream?.terminate();
      upstreamSocket?.destroy();
    }
    /** An unbound socket is released the way an idle upstream releases one: a normal close, no error event. */
    function closeUnbound(): void {
      if (stopped || bound) return;
      logRejection({ code: 'bridge_websocket_initial_create_timeout', transport: 'websocket', ...(req.method ? { method: req.method } : {}), ...(req.url ? { url: req.url } : {}) });
      stop();
      if (client.readyState === WebSocket.OPEN) client.close(1000, 'bridge_websocket_initial_create_timeout');
    }
    function relay(destination: WebSocket, data: Buffer, binary: boolean): void {
      if (destination.readyState !== WebSocket.OPEN) throw new DesktopBridgeError('bridge_websocket_upstream_unavailable');
      if (destination.bufferedAmount + data.length > maxBytes) throw new DesktopBridgeError('bridge_websocket_backpressure_exceeded');
      destination.send(data, { binary }, (error) => { if (error) fail(error); });
    }
    function routeRequest(model: string) {
      return { public_model: model, session_id: identity.thread_id, pathname: new URL(req.url || '/', 'http://bridge.invalid').pathname, transport: 'websocket' as const, headers: req.headers };
    }
    function assertBinding(route: DesktopBridgeRouteContext): void {
      if (!bound) return;
      const official = route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID;
      const provider = route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID ? null : config.providers[route.provider_id];
      const baseUrl = official ? config.officialRemote?.baseUrl : provider?.base_url;
      if (route.provider_id !== bound.provider_id || baseUrl !== boundBaseUrl
        || (provider && (provider.credential_generation !== boundCredentialGeneration || provider.credential_fingerprint !== boundCredentialFingerprint))) {
        throw new DesktopBridgeError('bridge_websocket_route_change_forbidden');
      }
    }
    async function resolveCreate(message: PendingMessage): Promise<void> {
      const model = message.create?.model;
      if (typeof model !== 'string' || !model.trim()) throw new DesktopBridgeError('bridge_websocket_model_required');
      const nextIdentity = resolveCodexSessionIdentity(req.headers, message.create);
      if (bound && ((nextIdentity.thread_id && nextIdentity.thread_id !== identity.thread_id)
        || (nextIdentity.session_id && nextIdentity.session_id !== identity.session_id))) {
        throw new DesktopBridgeError('bridge_codex_session_identity_conflict');
      }
      if (!bound) identity = nextIdentity;
      const request = routeRequest(model);
      // Do not persist a new session pin for a create we cannot forward on this socket.
      assertBinding(assertDesktopBridgeRouteContext(request, config));
      const route = await resolveAndBindDesktopBridgeRouteContext(request, config);
      if (stopped || client.readyState !== WebSocket.OPEN) return;
      assertBinding(route);
      if (!bound) {
        bound = route;
        await connect(route);
      }
      if (route.upstream_model !== model) message.data = Buffer.from(JSON.stringify({ ...message.create, model: route.upstream_model }));
    }
    async function connect(route: DesktopBridgeRouteContext): Promise<void> {
      const official = route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID;
      const provider = route.provider_id === BRIDGE_OFFICIAL_ROUTE_ID ? null : config.providers[route.provider_id];
      const remote = official ? config.officialRemote : provider?.remote;
      if (!remote) throw new DesktopBridgeError('bridge_websocket_upstream_unavailable');
      boundBaseUrl = official ? remote.baseUrl : provider!.base_url;
      boundCredentialGeneration = provider?.credential_generation ?? null;
      boundCredentialFingerprint = provider?.credential_fingerprint ?? null;
      const credential = provider ? await config.resolveProviderCredential(provider.provider_id, provider.credential_generation) : null;
      if (credential && (credential.provider_id !== provider!.provider_id || credential.generation !== boundCredentialGeneration
        || (boundCredentialFingerprint && credential.fingerprint !== boundCredentialFingerprint))) throw new DesktopBridgeError('bridge_provider_credential_generation_mismatch');
      await ensureDesktopBridgeRemoteTarget(remote, config.remoteLookup);
      if (stopped || client.readyState !== WebSocket.OPEN) return;
      const target = resolveDesktopBridgeTarget(req.url, remote);
      const outgoing = official ? buildOfficialPassthroughWebSocketHeaders(req.headers, target.host)
        : buildProviderWebSocketHeaders(req.headers, { providerId: provider!.provider_id, authTransport: provider!.auth_transport, credential: credential! }, target.host);
      // Each leg negotiates its own framing; never reuse the client's key or extensions.
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(outgoing)) {
        if (name.startsWith('sec-websocket-') || name === 'connection' || name === 'upgrade' || name === 'content-length') continue;
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
      }
      target.protocol = remote.secure ? 'wss:' : 'ws:';
      let connected = false;
      handshakeTimer = setTimeout(() => {
        if (!connected) void refreshDesktopBridgeRemoteTarget(remote, config.remoteLookup);
        fail(new DesktopBridgeError('bridge_websocket_upstream_handshake_timeout'));
      }, config.connectTimeoutMs);
      handshakeTimer.unref();
      // Dial the validated address directly. Host/SNI retain the original remote identity.
      upstream = new WebSocket(target, client.protocol ? [client.protocol] : [], {
        headers, perMessageDeflate: false, maxPayload: maxBytes,
        handshakeTimeout: config.connectTimeoutMs, followRedirects: false,
        createConnection: () => {
          const connection = remote.secure
            ? tls.connect({ host: remote.address, port: remote.port, ...(remote.tlsServername ? { servername: remote.tlsServername } : {}) })
            : net.connect({ host: remote.address, port: remote.port, family: remote.family });
          upstreamSocket = connection;
          connection.setKeepAlive(true, 30_000);
          connection.once(remote.secure ? 'secureConnect' : 'connect', () => { connected = true; });
          return connection;
        },
      });
      const peer = upstream;
      peer.on('error', (error) => {
        // Heal the validated pin for the client's next connection, without replaying any create.
        if (isUnreachableUpstreamError(error)) void refreshDesktopBridgeRemoteTarget(remote, config.remoteLookup);
        fail(new DesktopBridgeError('bridge_websocket_upstream_unavailable'));
      });
      peer.on('unexpected-response', (_request, response) => {
        response.destroy();
        fail(new DesktopBridgeError(`bridge_websocket_upgrade_failed_${response.statusCode || 502}`));
      });
      peer.on('message', (data, binary) => {
        if (stopped) return;
        try { relay(client, bytes(data), binary); } catch (error) { fail(error); }
      });
      peer.on('close', (code, reason) => {
        upstreamSocket?.destroy();
        stop();
        if (client.readyState === WebSocket.OPEN) {
          if (code === 1005) client.close();
          else client.close(code === 1006 ? 1011 : code, code === 1006 ? 'bridge_websocket_upstream_closed' : reason);
        }
        clearCloseTimer();
      });
      await new Promise<void>((resolve, reject) => {
        peer.once('open', resolve);
        peer.once('error', reject);
        peer.once('close', () => reject(new DesktopBridgeError('bridge_websocket_upstream_closed')));
      });
      if (handshakeTimer) clearTimeout(handshakeTimer);
      clearTimeout(initialTimer);
    }
    async function drain(): Promise<void> {
      if (processing || stopped) return;
      processing = true;
      try {
        if (!bound) {
          const firstCreate = pending.find((message) => message.create);
          if (!firstCreate) return;
          await resolveCreate(firstCreate);
          // Already validated and rewritten; avoid resolving the alias a second time.
          firstCreate.create = null;
        }
        while (!stopped && client.readyState === WebSocket.OPEN && pending.length) {
          const message = pending[0]!;
          if (message.create) await resolveCreate(message);
          if (stopped || client.readyState !== WebSocket.OPEN) return;
          relay(upstream!, message.data, message.binary);
          pending.shift();
          pendingBytes -= message.originalBytes;
        }
      } catch (error) { fail(error); }
      finally { processing = false; }
    }
    function clearCloseTimer(): void {
      if (client.readyState === WebSocket.CLOSED && (!upstream || upstream.readyState === WebSocket.CLOSED) && closeTimer) clearTimeout(closeTimer);
    }
    client.on('message', (data, binary) => {
      if (stopped) return;
      const payload = bytes(data);
      let create: Record<string, unknown> | null = null;
      try {
        const parsed: unknown = JSON.parse(payload.toString('utf8'));
        if (parsed && typeof parsed === 'object' && (parsed as Record<string, unknown>).type === 'response.create') create = parsed as Record<string, unknown>;
      } catch { /* Unknown native event payloads are forwarded unchanged after routing. */ }
      if (pending.length >= MAX_PENDING_MESSAGES || pendingBytes + payload.length > maxBytes) {
        fail(new DesktopBridgeError('bridge_websocket_pending_limit_exceeded')); return;
      }
      pending.push({ data: payload, binary, create, originalBytes: payload.length }); pendingBytes += payload.length;
      void drain();
    });
    client.on('error', () => { stop(); upstream?.terminate(); upstreamSocket?.destroy(); client.terminate(); });
    client.once('close', (code, reason) => {
      stop();
      if (upstream?.readyState === WebSocket.OPEN) {
        if (code === 1005) upstream.close();
        else upstream.close(code === 1006 ? 1011 : code, reason);
      } else if (upstream?.readyState === WebSocket.CONNECTING) { upstream.terminate(); upstreamSocket?.destroy(); }
      clearCloseTimer();
    });
  }
}
