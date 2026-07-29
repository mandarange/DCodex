import { randomInt } from 'node:crypto';
import http, { type Server, type ServerResponse } from 'node:http';
import net, { type Server as NetServer, type Socket } from 'node:net';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { forwardHttp } from './http-forward.js';
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
  desktopBridgeStatePath,
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
import { forwardWebSocket } from './websocket-forward.js';

function pathnameFromRequest(req: IncomingMessage): string {
  try {
    return new URL(req.url || '/', 'http://bridge.invalid').pathname;
  } catch {
    throw new DesktopBridgeError('bridge_request_target_invalid');
  }
}

function rejectionStatus(code: string): number {
  if (code === 'bridge_path_not_allowed') return 404;
  if (code.includes('origin') || code.includes('peer') || code.includes('loopback')) return 403;
  return 400;
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
  if (socket.destroyed) return;
  const code = safeBridgeErrorCode(error);
  const status = rejectionStatus(code);
  socket.end(
    `HTTP/1.1 ${status} ${status === 404 ? 'Not Found' : status === 403 ? 'Forbidden' : 'Bad Request'}\r\n`
    + 'Content-Type: application/json\r\n'
    + 'Cache-Control: no-store\r\n'
    + 'Connection: close\r\n'
    + '\r\n'
    + JSON.stringify({ error: { type: 'sks_bridge_rejection', code, message: code } }),
  );
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
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        assertLoopbackPeer(req.socket.remoteAddress);
        assertAllowedOrigin(req.headers, input.allowedOrigins);
        assertAllowedPath(pathnameFromRequest(req), input.allowedPathPrefixes);
        await forwardHttp(req, res, input);
      } catch (error) {
        req.resume();
        writeBridgeRejection(res, error);
      }
    })();
  });
  server.requestTimeout = 0;
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
      assertAllowedOrigin(req.headers, input.allowedOrigins);
      assertAllowedPath(pathnameFromRequest(req), input.allowedPathPrefixes);
      assertWebSocketUpgrade(req.headers, req.method);
      forwardWebSocket(req, socket, head, input);
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

  let stopped = false;
  const handle: DesktopBridgeHandle = {
    server,
    state,
    statePath,
    sockets,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
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
