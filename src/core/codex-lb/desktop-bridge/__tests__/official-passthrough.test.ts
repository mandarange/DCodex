import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { startDesktopBridge, stopDesktopBridge, desktopBridgeClientPath, type DesktopBridgeConfig, type DesktopBridgeHandle } from '../index.js';

const CLIENT_CAPABILITY = Buffer.alloc(32, 0x51).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');
const PROVIDER_MODEL = 'public-model';
const OFFICIAL_MODEL = 'gpt-5.6-sol';
const CLIENT_OAUTH = 'Bearer client-chatgpt-oauth-token';

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as AddressInfo).port;
}
async function close(server: net.Server): Promise<void> { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
function accept(key: string): string { return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const holder = net.createServer(); const port = await listen(holder); await close(holder); return port;
}

function bridgeConfig(port: number, providerPort: number, officialPort: number | null, opts: { officialModelRoute?: boolean } = {}): DesktopBridgeConfig {
  const providerBaseUrl = `http://127.0.0.1:${providerPort}/backend-api/codex`;
  return {
    listenHost: '127.0.0.1', listenPort: port,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1', generation: 'registry-generation', created_at: '2026-08-23T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: providerBaseUrl, allowed_origins: [new URL(providerBaseUrl).origin], auth_transport: 'x-codex-lb-api-key',
          credential_state: 'ready', credential_fingerprint: 'credential-fingerprint', credential_generation: 'credential-generation', source_catalog_generation: 'catalog-generation',
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1', allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null, credential_generation: 'openrouter-credential-generation', source_catalog_generation: null,
        },
      },
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: {
        [PROVIDER_MODEL]: { provider_id: 'codex-lb', upstream_model: PROVIDER_MODEL },
        ...(opts.officialModelRoute ? { [OFFICIAL_MODEL]: { provider_id: 'openai', upstream_model: OFFICIAL_MODEL } } : {}),
      },
      catalog_generation: 'catalog-generation', policy_generation: 'policy-generation', changed_at: '2026-08-23T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId, value: 'provider-secret-key', source: 'test',
      fingerprint: providerId === 'codex-lb' ? 'credential-fingerprint' : 'unused-openrouter-fingerprint', generation: expectedGeneration,
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: ['/backend-api/codex/'], allowedOrigins: ['app://codex'], connectTimeoutMs: 500, idleTimeoutMs: 5_000,
    officialPassthrough: officialPort === null ? null : { baseUrl: `http://127.0.0.1:${officialPort}/backend-api/codex` },
  };
}

function postJson(bridgePort: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const request = http.request({
      host: '127.0.0.1', port: bridgePort, method: 'POST',
      path: desktopBridgeClientPath(CLIENT_CAPABILITY, path),
      headers: {
        'content-type': 'application/json', 'content-length': String(payload.length),
        origin: 'app://codex', authorization: CLIENT_OAUTH, 'chatgpt-account-id': 'acct-operator', ...headers,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

interface SeenRequest { path: string; authorization: string | undefined; accountId: string | undefined; codexLbKey: string | undefined; body: string }

function recordingUpstream(handler?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean): { server: http.Server; seen: SeenRequest[] } {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({
        path: String(req.url), authorization: req.headers.authorization,
        accountId: req.headers['chatgpt-account-id'] as string | undefined,
        codexLbKey: req.headers['x-codex-lb-api-key'] as string | undefined,
        body: body.toString('utf8'),
      });
      if (handler && handler(req, res, body)) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ served_by: 'upstream', path: req.url }));
    });
  });
  return { server, seen };
}

test('official passthrough carries the client identity for unrouted models and unknown endpoints', async () => {
  const official = recordingUpstream();
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, officialPort), { writeState: false });

    // Unrouted model on the Responses surface: official, with the CLIENT's own
    // Authorization and account header, and no provider credential.
    const unrouted = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'hello' });
    assert.equal(unrouted.status, 200);
    assert.equal(official.seen.length, 1);
    assert.equal(official.seen[0]!.path, '/backend-api/codex/responses');
    assert.equal(official.seen[0]!.authorization, CLIENT_OAUTH);
    assert.equal(official.seen[0]!.accountId, 'acct-operator');
    assert.equal(official.seen[0]!.codexLbKey, undefined);
    assert.equal(JSON.parse(official.seen[0]!.body).model, OFFICIAL_MODEL);

    // Unknown official endpoint (no model anywhere): official verbatim — this
    // was the catalog_model_route_missing 400 the Desktop hit on alpha/search.
    const alpha = await postJson(bridgePort, '/backend-api/codex/alpha/search', { query: 'q' });
    assert.equal(alpha.status, 200);
    assert.equal(official.seen.length, 2);
    assert.equal(official.seen[1]!.path, '/backend-api/codex/alpha/search');
    assert.equal(official.seen[1]!.authorization, CLIENT_OAUTH);

    // Provider-routed model: unchanged contract — the client identity is
    // stripped and the provider credential injected. Identities never cross.
    const routed = await postJson(bridgePort, '/backend-api/codex/responses', { model: PROVIDER_MODEL, input: 'hello' });
    assert.equal(routed.status, 200);
    assert.equal(provider.seen.length, 1);
    assert.equal(provider.seen[0]!.authorization, undefined);
    assert.equal(provider.seen[0]!.accountId, undefined);
    assert.equal(provider.seen[0]!.codexLbKey, 'provider-secret-key');
    assert.equal(official.seen.length, 2);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('an explicit openai model route sends a known model through official passthrough', async () => {
  const official = recordingUpstream();
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, officialPort, { officialModelRoute: true }), { writeState: false });
    const result = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'hi' });
    assert.equal(result.status, 200);
    assert.equal(official.seen.length, 1);
    assert.equal(official.seen[0]!.authorization, CLIENT_OAUTH);
    assert.equal(provider.seen.length, 0);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('official error bodies stream back verbatim instead of being redacted', async () => {
  const official = recordingUpstream((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'token_expired', message: 'The access token expired' } }));
    return true;
  });
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, officialPort), { writeState: false });
    const result = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'hello' });
    assert.equal(result.status, 401);
    // Codex renders official auth/quota detail natively; the provider-side
    // redaction must not erase it on the operator's own identity path.
    assert.equal(JSON.parse(result.body).error.message, 'The access token expired');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('a transient official 503 is absorbed by a fresh-connection replay', async () => {
  let calls = 0;
  const official = recordingUpstream((_req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } }));
      return true;
    }
    return false;
  });
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, officialPort), { writeState: false });
    const result = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'compact' });
    assert.equal(result.status, 200);
    assert.equal(calls, 2);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('an unpinned websocket upgrade passes through to the official upstream with the client identity', async () => {
  const upgradeHeaders: Array<{ authorization: string | undefined; codexLbKey: string | undefined }> = [];
  const official = recordingUpstream();
  // Upgraded sockets keep http.Server.close() waiting forever; track and
  // destroy them so teardown terminates.
  const mockSockets = new Set<net.Socket>();
  official.server.on('upgrade', (req, socket: net.Socket) => {
    mockSockets.add(socket); socket.once('close', () => mockSockets.delete(socket));
    upgradeHeaders.push({
      authorization: req.headers.authorization,
      codexLbKey: req.headers['x-codex-lb-api-key'] as string | undefined,
    });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers['sec-websocket-key']))}\r\n\r\n`);
  });
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  const client = new net.Socket();
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, officialPort), { writeState: false });
    await new Promise<void>((resolve, reject) => { client.once('error', reject); client.connect(bridgePort, '127.0.0.1', resolve); });
    const key = randomBytes(16).toString('base64');
    client.write([
      `GET ${desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses')} HTTP/1.1`,
      `Host: 127.0.0.1:${bridgePort}`,
      'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`, 'Origin: app://codex', `Authorization: ${CLIENT_OAUTH}`,
      '', '',
    ].join('\r\n'));
    const chunks: Buffer[] = [];
    client.on('data', (chunk) => chunks.push(chunk));
    const deadline = Date.now() + 2_000;
    while (!Buffer.concat(chunks).includes('101') && Date.now() < deadline) await sleep(20);
    assert.ok(Buffer.concat(chunks).includes('101'), `the upgrade must reach 101, got: ${Buffer.concat(chunks).toString('utf8').slice(0, 120)}`);
    assert.equal(upgradeHeaders.length, 1);
    assert.equal(upgradeHeaders[0]!.authorization, CLIENT_OAUTH);
    assert.equal(upgradeHeaders[0]!.codexLbKey, undefined);
  } finally {
    client.destroy();
    for (const socket of mockSockets) socket.destroy();
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('a thread pinned to the gateway before the flip is absorbed into official passthrough', async () => {
  // The operator's machine carries hundreds of provider session pins from the
  // pre-flip era. After bare official ids move to `openai`, a pinned thread's
  // resolver throws session_pin_route_unavailable — which must resolve to
  // official passthrough, not a dead thread.
  const official = recordingUpstream();
  const provider = recordingUpstream();
  const officialPort = await listen(official.server);
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    const config = bridgeConfig(bridgePort, providerPort, officialPort, { officialModelRoute: true });
    config.providerSessionPins = [{
      thread_id: 'thread-legacy-1', provider_id: 'codex-lb', public_model: OFFICIAL_MODEL, upstream_model: OFFICIAL_MODEL,
      catalog_generation: 'catalog-generation', route_policy_generation: 'stale-policy-generation', created_at: '2026-08-01T00:00:00.000Z',
    }];
    bridge = await startDesktopBridge(config, { writeState: false });
    const result = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'hi' }, { 'thread-id': 'thread-legacy-1' });
    assert.equal(result.status, 200);
    assert.equal(official.seen.length, 1);
    assert.equal(official.seen[0]!.authorization, CLIENT_OAUTH);
    assert.equal(provider.seen.length, 0);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(official.server); await close(provider.server);
  }
});

test('without official passthrough the legacy fail-closed behavior is unchanged', async () => {
  const provider = recordingUpstream();
  const providerPort = await listen(provider.server);
  const bridgePort = await freePort();
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, providerPort, null), { writeState: false });
    const unrouted = await postJson(bridgePort, '/backend-api/codex/responses', { model: OFFICIAL_MODEL, input: 'x' });
    assert.equal(unrouted.status, 400);
    assert.match(unrouted.body, /catalog_model_route_missing/);
    const alpha = await postJson(bridgePort, '/backend-api/codex/alpha/search', { query: 'q' });
    assert.equal(alpha.status, 400);
    assert.equal(provider.seen.length, 0);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(provider.server);
  }
});
