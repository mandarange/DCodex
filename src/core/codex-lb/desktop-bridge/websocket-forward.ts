import net from 'node:net';
import tls from 'node:tls';
import type { IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import type { Duplex } from 'node:stream';
import { buildWebSocketHeaders } from './header-policy.js';
import { rewriteLocationHeader } from './location-rewrite.js';
import { resolveDesktopBridgeTarget } from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import { DesktopBridgeError, type PreparedDesktopBridgeConfig } from './types.js';

const MAX_UPGRADE_RESPONSE_HEAD_BYTES = 64 * 1024;
const REDACTED_UPGRADE_RESPONSE_HEADERS = new Set([
  'authorization',
  'cookie',
  'proxy-authenticate',
  'proxy-authorization',
  'set-cookie',
  'x-codex-lb-api-key',
]);

function serializeHeaders(headers: OutgoingHttpHeaders): string[] {
  return Object.entries(headers).flatMap(([name, value]) => {
    if (value === undefined) return [];
    if (Array.isArray(value)) return value.map((entry) => `${name}: ${String(entry)}`);
    return [`${name}: ${String(value)}`];
  });
}

function rewriteUpgradeResponseHead(
  head: Buffer,
  config: PreparedDesktopBridgeConfig,
): Buffer {
  const text = head.toString('latin1');
  const lines = text.split('\r\n');
  const statusLine = lines.shift();
  if (!statusLine || !/^HTTP\/1\.[01] \d{3}(?: |$)/.test(statusLine)) {
    throw new DesktopBridgeError('bridge_websocket_response_invalid');
  }
  const output = [statusLine];
  for (const line of lines) {
    if (!line) continue;
    if (/^[ \t]/.test(line)) throw new DesktopBridgeError('bridge_websocket_response_invalid');
    const colon = line.indexOf(':');
    if (colon <= 0) throw new DesktopBridgeError('bridge_websocket_response_invalid');
    const rawName = line.slice(0, colon);
    const name = rawName.toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (REDACTED_UPGRADE_RESPONSE_HEADERS.has(name) || name.startsWith('access-control-')) continue;
    if (name === 'location') {
      output.push(`${rawName}: ${rewriteLocationHeader(value, config.remoteBaseUrl, desktopBridgeListenOrigin(config))}`);
      continue;
    }
    output.push(line);
  }
  return Buffer.from(`${output.join('\r\n')}\r\n\r\n`, 'latin1');
}

function writeUpgradeFailure(clientSocket: Duplex): void {
  if (clientSocket.destroyed) return;
  clientSocket.end(
    'HTTP/1.1 502 Bad Gateway\r\n'
    + 'Content-Type: application/json\r\n'
    + 'Cache-Control: no-store\r\n'
    + 'Connection: close\r\n'
    + '\r\n'
    + '{"error":{"type":"sks_bridge_error","code":"bridge_websocket_upstream_unavailable"}}',
  );
}

export function forwardWebSocket(
  req: IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  config: PreparedDesktopBridgeConfig,
): void {
  const target = resolveDesktopBridgeTarget(req.url, config.remote);
  const upstream = config.remote.secure
    ? tls.connect({
        host: config.remote.address,
        port: config.remote.port,
        ...(config.remote.tlsServername ? { servername: config.remote.tlsServername } : {}),
      })
    : net.connect({
        host: config.remote.address,
        port: config.remote.port,
        family: config.remote.family,
      });

  let connected = false;
  let responseHead = Buffer.alloc(0);
  const connectTimer = setTimeout(() => {
    upstream.destroy(new DesktopBridgeError('bridge_upstream_connect_timeout'));
  }, config.connectTimeoutMs);
  connectTimer.unref();

  const fail = (): void => {
    clearTimeout(connectTimer);
    if (!connected) writeUpgradeFailure(clientSocket);
    else clientSocket.destroy();
  };

  const onConnected = (): void => {
    connected = true;
    clearTimeout(connectTimer);
    upstream.setNoDelay(true);
    upstream.setTimeout(config.idleTimeoutMs, () => {
      upstream.destroy(new DesktopBridgeError('bridge_upstream_idle_timeout'));
    });
    if (clientSocket instanceof net.Socket) {
      clientSocket.setNoDelay(true);
      clientSocket.setTimeout(config.idleTimeoutMs, () => clientSocket.destroy());
    }

    const headers = buildWebSocketHeaders(req.headers, config, target.host);
    const requestHead = [
      `${req.method || 'GET'} ${target.pathname}${target.search} HTTP/1.1`,
      ...serializeHeaders(headers),
      '',
      '',
    ].join('\r\n');
    upstream.write(requestHead);
    if (head.length) upstream.write(head);
    clientSocket.pipe(upstream);

    const onHandshakeData = (chunk: Buffer): void => {
      responseHead = Buffer.concat([responseHead, chunk]);
      if (responseHead.length > MAX_UPGRADE_RESPONSE_HEAD_BYTES) {
        upstream.destroy(new DesktopBridgeError('bridge_websocket_response_headers_too_large'));
        return;
      }
      const boundary = responseHead.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      upstream.off('data', onHandshakeData);
      const rawHead = responseHead.subarray(0, boundary);
      const remaining = responseHead.subarray(boundary + 4);
      try {
        clientSocket.write(rewriteUpgradeResponseHead(rawHead, config));
        if (remaining.length) clientSocket.write(remaining);
      } catch (error) {
        upstream.destroy(error instanceof Error ? error : undefined);
        return;
      }
      upstream.pipe(clientSocket);
      responseHead = Buffer.alloc(0);
    };
    upstream.on('data', onHandshakeData);
  };

  if (config.remote.secure) upstream.once('secureConnect', onConnected);
  else upstream.once('connect', onConnected);
  upstream.once('error', fail);
  upstream.once('close', () => {
    clearTimeout(connectTimer);
    if (!clientSocket.destroyed) clientSocket.end();
  });
  clientSocket.once('error', () => upstream.destroy());
  clientSocket.once('close', () => upstream.destroy());
}
