import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { buildUpstreamHeaders, rewriteResponseHeaders } from './header-policy.js';
import {
  assertDesktopBridgeRequestPolicy,
  resolveDesktopBridgeTarget,
  safeBridgeErrorCode,
} from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import { DesktopBridgeError, type PreparedDesktopBridgeConfig } from './types.js';

const MAX_MODEL_VALIDATION_BODY_BYTES = 16 * 1024 * 1024;

function isResponsesPath(rawUrl: string | undefined): boolean {
  const pathname = new URL(String(rawUrl || '/'), 'http://bridge.invalid').pathname;
  return pathname === '/backend-api/codex/responses'
    || pathname === '/api/v1/responses'
    || pathname === '/v1/responses';
}

export async function prepareDesktopBridgeRequestBody(
  req: IncomingMessage,
  config: PreparedDesktopBridgeConfig,
): Promise<Buffer | null> {
  if (!config.providerMode || !isResponsesPath(req.url)) return null;
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > MAX_MODEL_VALIDATION_BODY_BYTES) {
    throw new DesktopBridgeError('bridge_request_body_too_large');
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_MODEL_VALIDATION_BODY_BYTES) throw new DesktopBridgeError('bridge_request_body_too_large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new DesktopBridgeError('bridge_responses_body_invalid_json');
  }
  const model = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).model
    : null;
  assertDesktopBridgeRequestPolicy({ headers: req.headers, config, model });
  return body;
}

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
  bufferedBody: Buffer | null = null,
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

      if (bufferedBody) {
        upstream.end(bufferedBody);
      } else {
        void pipeline(req, upstream).catch((error) => {
          if (!responseStarted) finish(error);
        });
      }
    });
  } catch (error) {
    writeHttpBridgeError(res, error);
  }
}
