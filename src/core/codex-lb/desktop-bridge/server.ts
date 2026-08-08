import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import http, { type Server, type ServerResponse } from 'node:http';
import net, { type Server as NetServer, type Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { forwardHttp, prepareDesktopBridgeRequest } from './http-forward.js';
import {
  assertAllowedOrigin,
  assertAllowedPath,
  assertLoopbackPeer,
  assertLoopbackListenHost,
  assertWebSocketUpgrade,
  prepareDesktopBridgeConfig,
  safeBridgeErrorCode,
  validatePreparedDesktopBridgeConfig,
} from './security.js';
import {
  createDesktopBridgePublicState,
  desktopBridgeListenOrigin,
  desktopBridgeStatePath,
  refreshDesktopBridgeState,
  removeDesktopBridgeStateIfOwned,
  writeDesktopBridgeState,
} from './state.js';
import type {
  DesktopBridgeConfig,
  DesktopBridgeHandle,
  DesktopBridgeStartOptions,
  PreparedDesktopBridgeConfig,
} from './types.js';
import { DesktopBridgeError } from './types.js';
import {
  DESKTOP_BRIDGE_CLIENT_PATH_PREFIX,
  DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH,
  DESKTOP_BRIDGE_DIAGNOSTIC_PATH,
  DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL
} from './types.js';
import { forwardWebSocket } from './websocket-forward.js';

function authenticateDesktopBridgeClient(
  req: IncomingMessage,
  input: PreparedDesktopBridgeConfig,
): { pathname: string; clientBasePath: string } {
  const raw = String(req.url || '/');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith('//') || /[\r\n\0]/.test(raw)) {
    throw new DesktopBridgeError('bridge_request_target_invalid');
  }
  let parsed: URL;
  try { parsed = new URL(raw, 'http://bridge.invalid'); }
  catch { throw new DesktopBridgeError('bridge_request_target_invalid'); }
  const tokenPrefix = `${DESKTOP_BRIDGE_CLIENT_PATH_PREFIX}/`;
  if (!parsed.pathname.startsWith(tokenPrefix)) throw new DesktopBridgeError('bridge_client_capability_required');
  const remainder = parsed.pathname.slice(tokenPrefix.length);
  const separator = remainder.indexOf('/');
  const capability = separator > 0 ? remainder.slice(0, separator) : '';
  const canonicalPathname = separator > 0 ? remainder.slice(separator) : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability) || !canonicalPathname.startsWith('/')) {
    throw new DesktopBridgeError('bridge_client_capability_invalid');
  }
  const actual = createHash('sha256').update(capability).digest();
  const expected = Buffer.from(input.clientCapabilitySha256, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new DesktopBridgeError('bridge_client_capability_invalid');
  }
  req.url = `${canonicalPathname}${parsed.search}`;
  return {
    pathname: canonicalPathname,
    clientBasePath: `${DESKTOP_BRIDGE_CLIENT_PATH_PREFIX}/${capability}`,
  };
}

function handleDiagnosticWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  const protocols = String(req.headers['sec-websocket-protocol'] || '').split(',').map((value) => value.trim());
  if (!protocols.includes(DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL)) throw new DesktopBridgeError('bridge_websocket_protocol_mismatch');
  const key = String(req.headers['sec-websocket-key'] || '');
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n'
    + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
    + `Sec-WebSocket-Accept: ${accept}\r\n`
    + `Sec-WebSocket-Protocol: ${DESKTOP_BRIDGE_DIAGNOSTIC_PROTOCOL}\r\n\r\n`,
  );
  let buffered = head;
  const consume = (chunk?: Buffer): void => {
    if (chunk) buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 6) {
      const opcode = buffered[0]! & 0x0f;
      const masked = (buffered[1]! & 0x80) !== 0;
      const length = buffered[1]! & 0x7f;
      if (!masked || length > 125) { socket.destroy(); return; }
      if (buffered.length < 6 + length) return;
      const mask = buffered.subarray(2, 6); const raw = buffered.subarray(6, 6 + length); const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) payload[index] = (raw[index] || 0) ^ (mask[index % 4] || 0);
      buffered = buffered.subarray(6 + length);
      if (opcode === 1 || opcode === 2) socket.write(Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]));
      else if (opcode === 8) { socket.end(Buffer.concat([Buffer.from([0x88, payload.length]), payload])); return; }
    }
  };
  socket.on('data', consume); consume();
}

function rejectionStatus(code: string): number {
  if (code === 'bridge_path_not_allowed') return 404;
  if (code === 'bridge_request_capacity_exhausted') return 503;
  if (code === 'bridge_session_pin_persist_failed' || code.startsWith('bridge_upstream_')) return 502;
  if (code.includes('origin') || code.includes('peer') || code.includes('loopback') || code.includes('capability')) return 403;
  return 400;
}

function rejectionStatusText(status: number): string {
  if (status === 404) return 'Not Found';
  if (status === 403) return 'Forbidden';
  if (status === 502) return 'Bad Gateway';
  if (status === 503) return 'Service Unavailable';
  return 'Bad Request';
}

function writeBridgeRejection(res: ServerResponse, error: unknown): void {
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  const code = safeBridgeErrorCode(error);
  res.writeHead(rejectionStatus(code), {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(JSON.stringify({ error: { type: 'sks_bridge_rejection', code, message: code } }));
}

function writeUpgradeRejection(socket: Duplex, error: unknown): void {
  // A late async failure (for example an upstream websocket handshake error)
  // can race the peer closing or a partially-written upgrade response; writing
  // then raises ERR_STREAM_WRITE_AFTER_END as an unhandled 'error' event and
  // kills the whole bridge process for every client.
  socket.on('error', () => undefined);
  if (socket.destroyed || (socket as { writableEnded?: boolean }).writableEnded) return;
  const code = safeBridgeErrorCode(error);
  const status = rejectionStatus(code);
  try {
    socket.end(
      `HTTP/1.1 ${status} ${rejectionStatusText(status)}\r\n`
      + 'Content-Type: application/json\r\n'
      + 'Cache-Control: no-store\r\n'
      + 'Connection: close\r\n'
      + '\r\n'
      + JSON.stringify({ error: { type: 'sks_bridge_rejection', code, message: code } }),
    );
  } catch {
    socket.destroy();
  }
}

function writeDiagnosticHealth(
  req: IncomingMessage,
  res: ServerResponse,
  input: PreparedDesktopBridgeConfig
): void {
  if (req.method !== 'GET') throw new DesktopBridgeError('bridge_diagnostic_method_not_allowed');
  const payload = {
    schema: 'sks.desktop-bridge-health.v1',
    runtime: 'desktop-bridge',
    state: 'ready',
    provider_registry_generation: input.providerRegistry?.generation || null,
    route_policy_generation: input.routePolicy?.policy_generation || null,
    catalog_generation: input.routePolicy?.catalog_generation || null,
    secret_fields_redacted: true
  };
  res.writeHead(200, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close'
  });
  res.end(JSON.stringify(payload));
}

async function listenExact(server: NetServer, host: DesktopBridgeConfig['listenHost'], port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE') reject(new DesktopBridgeError('bridge_port_conflict', { cause: error }));
      else reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host, port, exclusive: true });
  });
}

async function closeServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function selectAvailableDesktopBridgePort(
  host: DesktopBridgeConfig['listenHost'],
  attempts = 64,
): Promise<number> {
  assertLoopbackListenHost(host);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = randomInt(49_152, 65_536);
    const probe = net.createServer();
    try {
      await listenExact(probe, host, port);
      await closeServer(probe, new Set());
      return port;
    } catch (error) {
      await closeServer(probe, new Set()).catch(() => undefined);
      if (error instanceof DesktopBridgeError && error.code === 'bridge_port_conflict') continue;
      throw error;
    }
  }
  throw new DesktopBridgeError('bridge_no_available_high_port');
}

export const preflightDesktopBridge = prepareDesktopBridgeConfig;

export async function startPreparedDesktopBridge(
  input: PreparedDesktopBridgeConfig,
  options: DesktopBridgeStartOptions = {},
): Promise<DesktopBridgeHandle> {
  validatePreparedDesktopBridgeConfig(input);
  const sockets = new Set<Socket>();
  const maxConcurrentRequests = input.maxConcurrentRequests ?? 64;
  let activeRequests = 0;
  const server = http.createServer((req, res) => {
    void (async () => {
      let admitted = false;
      try {
        if (activeRequests >= maxConcurrentRequests) throw new DesktopBridgeError('bridge_request_capacity_exhausted');
        activeRequests += 1;
        admitted = true;
        assertLoopbackPeer(req.socket.remoteAddress);
        const authenticated = authenticateDesktopBridgeClient(req, input);
        assertAllowedOrigin(req.headers, input.allowedOrigins);
        if (authenticated.pathname === DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH) {
          writeDiagnosticHealth(req, res, input);
          return;
        }
        assertAllowedPath(authenticated.pathname, input.allowedPathPrefixes);
        const prepared = await prepareDesktopBridgeRequest(req, input);
        await forwardHttp(
          req,
          res,
          input,
          prepared,
          `${desktopBridgeListenOrigin(input)}${authenticated.clientBasePath}`,
        );
      } catch (error) {
        req.pause();
        res.once('finish', () => {
          if (!req.complete) req.destroy();
        });
        writeBridgeRejection(res, error);
      } finally {
        if (admitted) activeRequests -= 1;
      }
    })();
  });
  server.maxConnections = input.maxConnections ?? 128;
  server.requestTimeout = input.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.max(5_000, input.connectTimeoutMs);
  server.keepAliveTimeout = Math.min(input.idleTimeoutMs, 60_000);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('upgrade', (req, socket, head) => {
    try {
      assertLoopbackPeer(req.socket.remoteAddress);
      const authenticated = authenticateDesktopBridgeClient(req, input);
      assertAllowedOrigin(req.headers, input.allowedOrigins);
      assertWebSocketUpgrade(req.headers, req.method);
      if (authenticated.pathname === DESKTOP_BRIDGE_DIAGNOSTIC_PATH) {
        handleDiagnosticWebSocket(req, socket, head);
        return;
      }
      assertAllowedPath(authenticated.pathname, input.allowedPathPrefixes);
      void forwardWebSocket(
        req,
        socket,
        head,
        input,
        `${desktopBridgeListenOrigin(input)}${authenticated.clientBasePath}`,
      ).catch((error) => writeUpgradeRejection(socket, error));
    } catch (error) {
      writeUpgradeRejection(socket, error);
    }
  });

  await listenExact(server, input.listenHost, input.listenPort);
  const state = createDesktopBridgePublicState(input, {
    ...(options.pid === undefined ? {} : { pid: options.pid }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const shouldWriteState = options.writeState !== false;
  const statePath = shouldWriteState ? (options.statePath || desktopBridgeStatePath()) : null;
  try {
    if (statePath) await writeDesktopBridgeState(statePath, state);
  } catch (error) {
    await closeServer(server, sockets);
    throw error;
  }

  const freshnessMs = input.stateFreshnessMs ?? 5 * 60_000;
  const heartbeat = statePath ? setInterval(() => {
    void refreshDesktopBridgeState(statePath, state, new Date(), freshnessMs).catch(() => undefined);
  }, Math.max(1_000, Math.floor(freshnessMs / 3))) : null;
  heartbeat?.unref();

  let stopped = false;
  const handle: DesktopBridgeHandle = {
    server,
    state,
    statePath,
    sockets,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (heartbeat) clearInterval(heartbeat);
      await closeServer(server, sockets);
      if (statePath) await removeDesktopBridgeStateIfOwned(statePath, state);
    },
  };
  return handle;
}

export async function startDesktopBridge(
  input: DesktopBridgeConfig,
  options: DesktopBridgeStartOptions = {},
): Promise<DesktopBridgeHandle> {
  const prepared = await preflightDesktopBridge(input);
  return startPreparedDesktopBridge(prepared, options);
}

export async function stopDesktopBridge(handle: DesktopBridgeHandle): Promise<void> {
  await handle.stop();
}
