import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { buildProviderUpstreamHeaders, rewriteResponseHeaders } from './header-policy.js';
import { assertDesktopBridgeRouteContext, resolveDesktopBridgeTarget, safeBridgeErrorCode, singleBridgeHeader } from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import { DesktopBridgeError, type DesktopBridgeResolvedCredential, type DesktopBridgeRouteContext, type PreparedDesktopBridgeConfig } from './types.js';

export interface PreparedDesktopBridgeRequest {
  body: Buffer | null;
  route: DesktopBridgeRouteContext;
  credential: DesktopBridgeResolvedCredential;
}

function bodyCarriesModel(rawUrl: string | undefined): boolean {
  const pathname = new URL(String(rawUrl || '/'), 'http://bridge.invalid').pathname;
  return pathname === '/backend-api/codex/responses' || pathname === '/api/v1/responses' || pathname === '/v1/responses';
}

async function readBoundedBody(req: IncomingMessage, maximum: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > maximum) throw new DesktopBridgeError('bridge_request_body_too_large');
  const chunks: Buffer[] = []; let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw); total += chunk.length;
    if (total > maximum) throw new DesktopBridgeError('bridge_request_body_too_large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function resolveCredential(config: PreparedDesktopBridgeConfig, route: DesktopBridgeRouteContext): Promise<DesktopBridgeResolvedCredential> {
  const provider = config.providers[route.provider_id];
  if (!provider) throw new DesktopBridgeError('bridge_provider_route_unavailable');
  const credential = await config.resolveProviderCredential(route.provider_id, provider.credential_generation);
  if (credential.provider_id !== route.provider_id || credential.generation !== provider.credential_generation
    || (provider.credential_fingerprint && credential.fingerprint !== provider.credential_fingerprint)) {
    throw new DesktopBridgeError('bridge_provider_credential_generation_mismatch');
  }
  return credential;
}

export async function prepareDesktopBridgeRequest(req: IncomingMessage, config: PreparedDesktopBridgeConfig): Promise<PreparedDesktopBridgeRequest> {
  const pathname = new URL(String(req.url || '/'), 'http://bridge.invalid').pathname;
  let body: Buffer | null = null;
  let payload: Record<string, unknown> | null = null;
  if (bodyCarriesModel(req.url)) {
    body = await readBoundedBody(req, config.maxRequestBodyBytes ?? 16 * 1024 * 1024);
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { throw new DesktopBridgeError('bridge_responses_body_invalid_json'); }
  }
  const headerModel = singleBridgeHeader(req.headers, 'x-sks-model');
  const model = typeof payload?.model === 'string' ? payload.model : headerModel;
  const route = assertDesktopBridgeRouteContext({
    public_model: String(model || ''), session_id: singleBridgeHeader(req.headers, 'x-sks-session-id'),
    pathname, transport: 'http', headers: req.headers,
  }, config);
  if (payload && payload.model !== route.upstream_model) {
    payload.model = route.upstream_model;
    body = Buffer.from(JSON.stringify(payload));
  }
  const credential = await resolveCredential(config, route);
  return { body, route, credential };
}

function connectTimeout(request: ClientRequest, config: PreparedDesktopBridgeConfig): void {
  request.once('socket', (socket: Socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => request.destroy(new DesktopBridgeError('bridge_upstream_connect_timeout')), config.connectTimeoutMs);
    timer.unref();
    socket.once('connect', () => clearTimeout(timer)); socket.once('secureConnect', () => clearTimeout(timer)); socket.once('close', () => clearTimeout(timer));
  });
}

function writeHttpBridgeError(res: ServerResponse, error: unknown): void {
  const code = safeBridgeErrorCode(error);
  if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
  res.writeHead(code.startsWith('catalog_') || code.startsWith('session_') || code.includes('route_') ? 409 : 502, {
    'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
  });
  res.end(JSON.stringify({ error: { type: 'sks_bridge_error', code, message: code } }));
}

export async function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: PreparedDesktopBridgeConfig,
  prepared?: PreparedDesktopBridgeRequest,
): Promise<void> {
  try {
    const request = prepared || await prepareDesktopBridgeRequest(req, config);
    const provider = config.providers[request.route.provider_id];
    if (!provider) throw new DesktopBridgeError('bridge_provider_route_unavailable');
    const target = resolveDesktopBridgeTarget(req.url, provider.remote);
    const transport = provider.remote.secure ? https : http;
    const headers = buildProviderUpstreamHeaders(req.headers, {
      providerId: provider.provider_id, authTransport: provider.auth_transport, credential: request.credential,
    }, target.host);
    if (request.body) headers['content-length'] = String(request.body.length);
    else delete headers['content-length'];
    const localOrigin = desktopBridgeListenOrigin(config);
    await new Promise<void>((resolve, reject) => {
      let responseStarted = false; let settled = false;
      const finish = (error?: unknown): void => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      const upstream = transport.request({
        protocol: target.protocol, hostname: provider.remote.address, family: provider.remote.family,
        port: provider.remote.port, method: req.method, path: `${target.pathname}${target.search}`, headers,
        ...(provider.remote.tlsServername ? { servername: provider.remote.tlsServername } : {}),
      });
      connectTimeout(upstream, config);
      upstream.setTimeout(config.idleTimeoutMs, () => upstream.destroy(new DesktopBridgeError('bridge_upstream_idle_timeout')));
      const abort = (): void => { if (!res.writableEnded) upstream.destroy(new DesktopBridgeError('bridge_client_disconnected')); };
      req.once('aborted', abort); res.once('close', abort); upstream.once('error', finish);
      upstream.once('response', (response) => {
        responseStarted = true;
        try { res.writeHead(response.statusCode || 502, rewriteResponseHeaders(response.headers, provider.base_url, localOrigin)); }
        catch (error) { response.destroy(error instanceof Error ? error : undefined); finish(error); return; }
        void pipeline(response, res).then(() => finish(), finish);
      });
      if (request.body) upstream.end(request.body);
      else void pipeline(req, upstream).catch((error) => { if (!responseStarted) finish(error); });
    });
  } catch (error) { writeHttpBridgeError(res, error); }
}
