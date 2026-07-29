import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { buildUpstreamHeaders, rewriteResponseHeaders } from './header-policy.js';
import { resolveDesktopBridgeTarget, safeBridgeErrorCode } from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import { DesktopBridgeError, type PreparedDesktopBridgeConfig } from './types.js';

function connectTimeout(request: ClientRequest, config: PreparedDesktopBridgeConfig): void {
  request.once('socket', (socket: Socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => {
      request.destroy(new DesktopBridgeError('bridge_upstream_connect_timeout'));
    }, config.connectTimeoutMs);
    timer.unref();
    const event = config.remote.secure ? 'secureConnect' : 'connect';
    socket.once(event, () => clearTimeout(timer));
    socket.once('close', () => clearTimeout(timer));
  });
}

function writeHttpBridgeError(res: ServerResponse, error: unknown): void {
  const code = safeBridgeErrorCode(error);
  if (res.headersSent) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  res.writeHead(502, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
  });
  res.end(JSON.stringify({
    error: {
      type: 'sks_bridge_error',
      code,
      message: code,
    },
  }));
}

export async function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: PreparedDesktopBridgeConfig,
): Promise<void> {
  const target = resolveDesktopBridgeTarget(req.url, config.remote);
  const transport = config.remote.secure ? https : http;
  const headers = buildUpstreamHeaders(req.headers, config, target.host);
  const localOrigin = desktopBridgeListenOrigin(config);

  try {
    await new Promise<void>((resolve, reject) => {
      let responseStarted = false;
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };

      const upstream = transport.request({
        protocol: target.protocol,
        hostname: config.remote.address,
        family: config.remote.family,
        port: config.remote.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
        ...(config.remote.tlsServername ? { servername: config.remote.tlsServername } : {}),
      });
      connectTimeout(upstream, config);
      upstream.setTimeout(config.idleTimeoutMs, () => {
        upstream.destroy(new DesktopBridgeError('bridge_upstream_idle_timeout'));
      });

      const abortUpstream = (): void => {
        if (!res.writableEnded) upstream.destroy(new DesktopBridgeError('bridge_client_disconnected'));
      };
      req.once('aborted', abortUpstream);
      res.once('close', abortUpstream);
      upstream.once('error', finish);
      upstream.once('response', (upstreamResponse) => {
        responseStarted = true;
        try {
          const responseHeaders = rewriteResponseHeaders(upstreamResponse.headers, config, localOrigin);
          res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        } catch (error) {
          upstreamResponse.destroy(error instanceof Error ? error : undefined);
          finish(error);
          return;
        }
        void pipeline(upstreamResponse, res).then(() => finish(), finish);
      });

      void pipeline(req, upstream).catch((error) => {
        if (!responseStarted) finish(error);
      });
    });
  } catch (error) {
    writeHttpBridgeError(res, error);
  }
}
