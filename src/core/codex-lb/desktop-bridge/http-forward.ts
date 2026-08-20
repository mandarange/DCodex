import http, { type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { buildProviderUpstreamHeaders, rewriteResponseHeaders } from './header-policy.js';
import { createDesktopBridgeRejectionLogger } from './rejection-log.js';
import { resolveAndBindDesktopBridgeRouteContext, resolveCodexSessionIdentity, resolveDesktopBridgeTarget, safeBridgeErrorCode, singleBridgeHeader } from './security.js';
import { desktopBridgeListenOrigin } from './state.js';
import { DesktopBridgeError, type DesktopBridgeResolvedCredential, type DesktopBridgeRouteContext, type PreparedDesktopBridgeConfig } from './types.js';

const MAX_UPSTREAM_ERROR_BODY_BYTES = 1024 * 1024;

export interface PreparedDesktopBridgeRequest {
  body: Buffer | null;
  route: DesktopBridgeRouteContext;
  credential: DesktopBridgeResolvedCredential;
  /** True when the bridge decoded a compressed request body and now owns a
   *  plain-JSON body, so content-encoding must not be forwarded upstream. */
  contentEncodingStripped?: boolean;
}

// Codex CLI 0.147 compresses Responses POST bodies (content-encoding: zstd).
// The bridge must decode before it can rewrite the routed model; the upstream
// then receives plain JSON with the encoding header removed.
function decodeBridgeRequestBody(body: Buffer, encoding: string, maximum: number): Buffer {
  const options = { maxOutputLength: maximum };
  try {
    switch (encoding) {
      case 'gzip':
      case 'x-gzip':
        return zlib.gunzipSync(body, options);
      case 'deflate':
        try { return zlib.inflateSync(body, options); }
        catch { return zlib.inflateRawSync(body, options); }
      case 'br':
        return zlib.brotliDecompressSync(body, options);
      case 'zstd': {
        const zstd = (zlib as unknown as { zstdDecompressSync?: (b: Buffer, o?: object) => Buffer }).zstdDecompressSync;
        if (!zstd) throw new DesktopBridgeError('bridge_request_encoding_unsupported');
        return zstd(body, options);
      }
      default:
        throw new DesktopBridgeError('bridge_request_encoding_unsupported');
    }
  } catch (error) {
    if (error instanceof DesktopBridgeError) throw error;
    throw new DesktopBridgeError('bridge_responses_body_invalid_json');
  }
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
  let contentEncodingStripped = false;
  if (bodyCarriesModel(req.url)) {
    const maximum = config.maxRequestBodyBytes ?? 16 * 1024 * 1024;
    body = await readBoundedBody(req, maximum);
    const encoding = String(req.headers['content-encoding'] || '').trim().toLowerCase();
    let decoded = body;
    if (encoding && encoding !== 'identity') {
      decoded = decodeBridgeRequestBody(body, encoding, maximum);
      contentEncodingStripped = true;
    }
    try {
      const parsed: unknown = JSON.parse(decoded.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed as Record<string, unknown>;
    } catch { throw new DesktopBridgeError('bridge_responses_body_invalid_json'); }
    if (contentEncodingStripped) body = decoded;
  }
  const headerModel = singleBridgeHeader(req.headers, 'x-sks-model');
  const model = typeof payload?.model === 'string' ? payload.model : headerModel;
  const sessionIdentity = resolveCodexSessionIdentity(req.headers, payload);
  const route = await resolveAndBindDesktopBridgeRouteContext({
    public_model: String(model || ''), session_id: sessionIdentity.thread_id,
    pathname, transport: 'http', headers: req.headers,
  }, config);
  if (payload && payload.model !== route.upstream_model) {
    payload.model = route.upstream_model;
    body = Buffer.from(JSON.stringify(payload));
  }
  const credential = await resolveCredential(config, route);
  return { body, route, credential, contentEncodingStripped };
}

function connectTimeout(request: ClientRequest, config: PreparedDesktopBridgeConfig): void {
  request.once('socket', (socket: Socket) => {
    if (!socket.connecting) return;
    const timer = setTimeout(() => request.destroy(new DesktopBridgeError('bridge_upstream_connect_timeout')), config.connectTimeoutMs);
    timer.unref();
    socket.once('connect', () => clearTimeout(timer)); socket.once('secureConnect', () => clearTimeout(timer)); socket.once('close', () => clearTimeout(timer));
  });
}

const logHttpRejection = createDesktopBridgeRejectionLogger();

/**
 * A Node socket failure (ECONNREFUSED, ETIMEDOUT, EPIPE …) is not a
 * DesktopBridgeError, so `safeBridgeErrorCode` collapses it to the catch-all
 * `bridge_upstream_unavailable`. That code names a symptom, not a cause, and
 * this writer logged nothing at all — the third error path in this module to
 * report a failure the operator then had no way to explain. The originating
 * error's own code is recorded alongside it; those identifiers are fixed
 * strings and carry no request data.
 */
function underlyingErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : null;
}

function writeHttpBridgeError(res: ServerResponse, error: unknown, req?: IncomingMessage): void {
  const code = safeBridgeErrorCode(error);
  const cause = code === 'bridge_upstream_unavailable' ? underlyingErrorCode(error) : null;
  logHttpRejection({
    code: cause ? `${code}:${cause}` : code,
    transport: 'http',
    ...(req?.method === undefined ? {} : { method: req.method }),
    ...(req?.url === undefined ? {} : { url: req.url }),
  });
  if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
  res.writeHead(code.startsWith('catalog_') || code.startsWith('session_') || code.includes('route_') ? 409 : 502, {
    'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close',
  });
  res.end(JSON.stringify({ error: { type: 'sks_bridge_error', code, message: code } }));
}

/** An upstream error identifier: bounded, machine-shaped, nothing else survives. */
function safeUpstreamErrorId(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(text) ? text : null;
}

const TRANSIENT_UPSTREAM_STATUSES = new Set([500, 502, 503, 524]);
const TRANSIENT_UPSTREAM_IDENTIFIERS = new Set(['upstream_error', 'upstream_request_timeout']);
/** First try plus this many fresh-connection replays. Codex compact treats any leftover 503 as fatal. */
export const TRANSIENT_UPSTREAM_REPLAY_LIMIT = 3;
const TRANSIENT_UPSTREAM_REPLAY_BACKOFF_MS = [200, 400, 800] as const;

function isTransientUpstreamIdentifier(value: string | null): boolean {
  return Boolean(value && TRANSIENT_UPSTREAM_IDENTIFIERS.has(value));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Live bridge logs on 9.0.5 recorded 41k `404:upstream_error` rows and zero
 * `translated_503` rows: the first translation keyed `type` and "no code",
 * while the gateway puts `upstream_error` in `code`. 9.0.6 checks either slot
 * for 404 only. The same self-described transient also arrives as 502/503/524
 * (and as an empty/HTML body with no identifiers), plus
 * `503:upstream_request_timeout`. Codex compact does not honor Retry-After —
 * `unexpected status 503 Service Unavailable: Upstream request failed` kills
 * the remote compact task — so the bridge must absorb these internally.
 */
function isTransientUpstreamFailure(
  statusCode: number,
  upstreamType: string | null,
  upstreamCode: string | null,
): boolean {
  if (statusCode === 429) return false;
  if (statusCode === 404) {
    return isTransientUpstreamIdentifier(upstreamType) || isTransientUpstreamIdentifier(upstreamCode);
  }
  return TRANSIENT_UPSTREAM_STATUSES.has(statusCode);
}

function redactedUpstreamClientMessage(statusCode: number, transient: boolean): string {
  if (statusCode === 429) return 'rate_limited';
  if (transient) return 'temporary_upstream_failure';
  return 'bridge_upstream_request_failed';
}

async function readRedactedUpstreamError(response: IncomingMessage): Promise<{ upstreamCode: string | null; upstreamType: string | null }> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const raw of response) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > MAX_UPSTREAM_ERROR_BODY_BYTES) {
      response.destroy();
      break;
    }
    chunks.push(chunk);
  }
  // The free-text message is redacted — an upstream error body can echo request
  // content — but wholesale replacement went further than that and erased the
  // *identifiers* too. Every failure then reached the user as the same sentence
  // ("Upstream request failed"), so a gateway saying "response not found" and
  // one saying "rate limited" were indistinguishable, and this bridge's own
  // redaction manufactured the undiagnosable report. Identifier-shaped `type`
  // and `code` carry no request content; they are extracted, everything else
  // still dies here.
  let upstreamCode: string | null = null;
  let upstreamType: string | null = null;
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { error?: { type?: unknown; code?: unknown }; detail?: unknown };
    upstreamCode = safeUpstreamErrorId(parsed?.error?.code) ?? safeUpstreamErrorId(parsed?.detail);
    upstreamType = safeUpstreamErrorId(parsed?.error?.type);
  } catch {
    // Not JSON, or truncated: nothing recoverable without risking content.
  }
  return { upstreamCode, upstreamType };
}

function buildRedactedUpstreamErrorBody(
  statusCode: number,
  upstreamCode: string | null,
  upstreamType: string | null,
  transient: boolean,
): Buffer {
  return Buffer.from(JSON.stringify({
    error: {
      type: 'upstream_error',
      code: 'bridge_upstream_request_failed',
      message: redactedUpstreamClientMessage(statusCode, transient),
      ...(upstreamType ? { upstream_type: upstreamType } : {}),
      ...(upstreamCode ? { upstream_code: upstreamCode } : {}),
    },
  }));
}

/**
 * Node's global agent keeps upstream sockets alive between requests, and a
 * laptop that loses Wi-Fi for a moment comes back with a pool full of sockets
 * the kernel on the other side has already forgotten. The next request picks
 * one, writes into it, and gets ECONNRESET — reported to the caller as
 * `bridge_upstream_unavailable`, a 502 that names the upstream for a fault that
 * is entirely local to this pool.
 *
 * Owning the agents makes that pool ours to bound and to discard.
 */
const upstreamAgents = new Map<string, http.Agent | https.Agent>();

function upstreamAgent(secure: boolean, key: string, idleTimeoutMs: number): http.Agent | https.Agent {
  const cacheKey = `${secure ? 'https' : 'http'}:${key}`;
  const existing = upstreamAgents.get(cacheKey);
  if (existing) return existing;
  const options = {
    keepAlive: true,
    // Below any sane upstream's own idle close, so a socket is retired from
    // this side before the far side can retire it underneath us.
    keepAliveMsecs: 15_000,
    timeout: idleTimeoutMs,
    maxSockets: 64,
    maxFreeSockets: 8,
  };
  const agent = secure ? new https.Agent(options) : new http.Agent(options);
  upstreamAgents.set(cacheKey, agent);
  return agent;
}

/** Exposed for teardown; a stopped bridge should not hold sockets open. */
export function destroyDesktopBridgeUpstreamAgents(): void {
  for (const agent of upstreamAgents.values()) agent.destroy();
  upstreamAgents.clear();
}

const STALE_CONNECTION_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

/**
 * True only for a failure that a fresh connection would not have suffered.
 *
 * `reusedSocket` is the load-bearing half: on a socket this request opened
 * itself, ECONNRESET means the upstream really did reject the request, and
 * replaying it would double a failing call rather than repair a stale one.
 */
function isStalePooledSocketFailure(request: ClientRequest, error: unknown): boolean {
  if (error instanceof DesktopBridgeError) return false;
  if (request.reusedSocket !== true) return false;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && STALE_CONNECTION_ERROR_CODES.has(code);
}

class StalePooledSocketFailure extends Error {
  constructor(readonly reason: unknown) { super('bridge_upstream_socket_stale'); }
}

export async function forwardHttp(
  req: IncomingMessage,
  res: ServerResponse,
  config: PreparedDesktopBridgeConfig,
  prepared?: PreparedDesktopBridgeRequest,
  authenticatedLocalBaseUrl = desktopBridgeListenOrigin(config),
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
    if (request.contentEncodingStripped) delete headers['content-encoding'];
    const agent = upstreamAgent(
      provider.remote.secure,
      `${provider.remote.address}:${provider.remote.port}`,
      config.idleTimeoutMs,
    );

    // A streamed request body is consumed as it is forwarded, so only a
    // buffered one can be replayed. Every Responses call arrives buffered.
    const replayable = Buffer.isBuffer(request.body);
    const attempt = (useFreshConnection: boolean, canReplay: boolean): Promise<void> => new Promise<void>((resolve, reject) => {
      let responseStarted = false; let settled = false;
      const abort = (): void => { if (!res.writableEnded) upstream.destroy(new DesktopBridgeError('bridge_client_disconnected')); };
      const finish = (error?: unknown): void => {
        if (settled) return; settled = true;
        req.off('aborted', abort); res.off('close', abort);
        error ? reject(error) : resolve();
      };
      const upstream = transport.request({
        protocol: target.protocol, hostname: provider.remote.address, family: provider.remote.family,
        port: provider.remote.port, method: req.method, path: `${target.pathname}${target.search}`, headers,
        // `false` makes Node open a one-shot connection, so a replay can never
        // draw a second dead socket out of the same pool.
        agent: useFreshConnection ? false : agent,
        ...(provider.remote.tlsServername ? { servername: provider.remote.tlsServername } : {}),
      });
      connectTimeout(upstream, config);
      upstream.setTimeout(config.idleTimeoutMs, () => upstream.destroy(new DesktopBridgeError('bridge_upstream_idle_timeout')));
      req.once('aborted', abort); res.once('close', abort);
      upstream.once('error', (error) => {
        if (!responseStarted && replayable && !useFreshConnection && isStalePooledSocketFailure(upstream, error)) {
          finish(new StalePooledSocketFailure(error));
          return;
        }
        finish(error);
      });
      upstream.once('response', (response) => {
        const statusCode = response.statusCode || 502;
        if (statusCode >= 400) {
          // The status passes through to the client untouched, but until this
          // line the bridge kept no record of it — so a gateway 404 ("Upstream
          // request failed", cf-ray attached) reached the user as an opaque
          // error with nothing on this machine saying which model and provider
          // produced it. A user report with a cf-ray id was undiagnosable from
          // the bridge log. Status, model, provider and path only; the body may
          // carry upstream detail and is never logged.
          void readRedactedUpstreamError(response).then(({ upstreamCode, upstreamType }) => {
            // The gateway wraps its own upstream failures as `type`/`code`
            // `upstream_error` but often labels them 404 (or 502/503/524).
            // Codex treats 404 as permanent, so compact tasks die. Either
            // identifier slot counts; unidentified 502-class bodies are the
            // empty/HTML/Cloudflare case and get the same one replay.
            // A genuine not-found (`response_not_found`, `model_not_found`)
            // carries a different identifier and stays 404.
            const transientMislabel = isTransientUpstreamFailure(statusCode, upstreamType, upstreamCode);
            if (transientMislabel && replayable && canReplay) {
              // Codex compact treats any leftover 503 as fatal
              // (`unexpected status 503 … Upstream request failed`) and does
              // not honor Retry-After. Absorb the transient here and replay
              // the buffered Responses body on a fresh connection.
              responseStarted = true;
              finish(new StalePooledSocketFailure(new DesktopBridgeError(
                upstreamCode === 'upstream_request_timeout'
                  ? 'bridge_upstream_request_timeout'
                  : 'bridge_upstream_transient_mislabel',
              )));
              return;
            }
            const clientStatus = transientMislabel ? 503 : statusCode;
            const body = buildRedactedUpstreamErrorBody(statusCode, upstreamCode, upstreamType, transientMislabel);
            // Logged after the body parse so the record can carry the upstream's
            // own error code — the one fact a report holding only a status and a
            // cf-ray id cannot supply.
            logHttpRejection({
              code: transientMislabel
                ? `bridge_upstream_status_${statusCode}_translated_503`
                : upstreamCode ? `bridge_upstream_status_${statusCode}:${upstreamCode}` : `bridge_upstream_status_${statusCode}`,
              transport: 'http',
              ...(req.method === undefined ? {} : { method: req.method }),
              ...(req.url === undefined ? {} : { url: req.url }),
              status: clientStatus,
              provider_id: provider.provider_id,
              public_model: request.route.public_model,
            });
            responseStarted = true;
            const responseHeaders = rewriteResponseHeaders(response.headers, provider.base_url, authenticatedLocalBaseUrl);
            responseHeaders['content-length'] = String(body.length);
            delete responseHeaders['transfer-encoding'];
            if (transientMislabel) responseHeaders['retry-after'] = String(responseHeaders['retry-after'] || '10');
            if (statusCode === 429 && !responseHeaders['retry-after']) responseHeaders['retry-after'] = '10';
            res.writeHead(clientStatus, responseHeaders);
            res.end(body, () => finish());
          }).catch(finish);
          return;
        }
        responseStarted = true;
        try { res.writeHead(statusCode, rewriteResponseHeaders(response.headers, provider.base_url, authenticatedLocalBaseUrl)); }
        catch (error) { response.destroy(error instanceof Error ? error : undefined); finish(error); return; }
        void pipeline(response, res).then(() => finish(), finish);
      });
      if (request.body) upstream.end(request.body);
      else void pipeline(req, upstream).catch((error) => { if (!responseStarted) finish(error); });
    });

    let remainingReplays = replayable ? TRANSIENT_UPSTREAM_REPLAY_LIMIT : 0;
    let useFreshConnection = false;
    for (;;) {
      try {
        await attempt(useFreshConnection, remainingReplays > 0);
        return;
      } catch (error) {
        if (!(error instanceof StalePooledSocketFailure) || remainingReplays <= 0) throw error;
        remainingReplays -= 1;
        if (!useFreshConnection) {
          // One transition kills every idle socket to that host, not just this one.
          // `destroy` only reaps the free list, so streams in flight are untouched.
          agent.destroy();
          upstreamAgents.delete(`${provider.remote.secure ? 'https' : 'http'}:${provider.remote.address}:${provider.remote.port}`);
        }
        logHttpRejection({
          code: `bridge_upstream_socket_stale_replayed:${underlyingErrorCode(error.reason) || 'unknown'}`,
          transport: 'http',
          ...(req.method === undefined ? {} : { method: req.method }),
          ...(req.url === undefined ? {} : { url: req.url }),
        });
        useFreshConnection = true;
        const backoffIndex = TRANSIENT_UPSTREAM_REPLAY_LIMIT - remainingReplays - 1;
        const backoffMs = TRANSIENT_UPSTREAM_REPLAY_BACKOFF_MS[Math.max(0, backoffIndex)]
          ?? TRANSIENT_UPSTREAM_REPLAY_BACKOFF_MS[TRANSIENT_UPSTREAM_REPLAY_BACKOFF_MS.length - 1];
        if (backoffMs) await delay(backoffMs);
      }
    }
  } catch (error) { writeHttpBridgeError(res, error instanceof StalePooledSocketFailure ? error.reason : error, req); }
}
