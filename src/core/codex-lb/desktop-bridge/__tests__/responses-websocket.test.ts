import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { desktopBridgeClientPath, startDesktopBridge, type DesktopBridgeConfig } from '../index.js';

const CAPABILITY = Buffer.alloc(32, 0x72).toString('base64url');
const MODEL = 'gpt-6-astra';
const OAUTH = 'Bearer client-oauth';
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}
async function freePort(): Promise<number> {
  const server = net.createServer(); const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
function upstream(t: TestContext, failure?: 'reject' | 'stall') {
  const server = http.createServer();
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<net.Socket>();
  const headers: IncomingHttpHeaders[] = [];
  const messages: Array<{ text: string; binary: boolean }> = [];
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    headers.push(req.headers);
    if (failure === 'reject') { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    if (failure === 'stall') {
      // Read through EOF while withholding the upgrade response, so the fixture
      // observes the bridge's abort instead of retaining a paused half-close.
      socket.resume(); socket.once('end', () => socket.end()); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.on('error', () => undefined);
      ws.on('message', (data, binary) => { messages.push({ text: data.toString(), binary }); ws.send(data, { binary }); });
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { server, headers, messages, sockets };
}
function config(port: number, lb: number, official: number): DesktopBridgeConfig {
  const baseUrl = `http://127.0.0.1:${lb}/backend-api/codex`;
  return {
    listenHost: '127.0.0.1', listenPort: port,
    providerRegistry: { schema: 'sks.desktop-bridge-provider-registry.v1', generation: 'registry', created_at: '2026-09-07T00:00:00.000Z', providers: {
      'codex-lb': { provider_id: 'codex-lb', enabled: true, base_url: baseUrl, allowed_origins: [new URL(baseUrl).origin], auth_transport: 'x-codex-lb-api-key', credential_state: 'ready', credential_fingerprint: 'fp', credential_generation: 'credential', source_catalog_generation: 'catalog' },
      openrouter: { provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1', allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer', credential_state: 'not_configured', credential_fingerprint: null, credential_generation: 'unused', source_catalog_generation: null },
    } },
    routePolicy: { schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none', model_routes: {
      [MODEL]: { provider_id: 'codex-lb', upstream_model: MODEL },
      [`codex-lb:${MODEL}`]: { provider_id: 'codex-lb', upstream_model: MODEL },
      'official-model': { provider_id: 'openai', upstream_model: 'official-model' },
    }, catalog_generation: 'catalog', policy_generation: 'policy', changed_at: '2026-09-07T00:00:00.000Z' },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, generation) => ({ provider_id: providerId, generation, value: 'lb-secret', source: 'test', fingerprint: 'fp' }),
    clientCapabilitySha256: createHash('sha256').update(CAPABILITY).digest('hex'),
    allowedPathPrefixes: ['/backend-api/codex/'], allowedOrigins: ['app://codex'], connectTimeoutMs: 200, idleTimeoutMs: 1_000,
    requestTimeoutMs: 1_000, officialPassthrough: { baseUrl: `http://127.0.0.1:${official}/backend-api/codex` },
  };
}
async function fixture(t: TestContext, customize?: (value: DesktopBridgeConfig) => void, failure?: 'reject' | 'stall') {
  const lb = upstream(t, failure); const official = upstream(t);
  const lbPort = await listen(lb.server); const officialPort = await listen(official.server);
  const port = await freePort(); const value = config(port, lbPort, officialPort); customize?.(value);
  const bridge = await startDesktopBridge(value, { writeState: false });
  t.after(() => bridge.stop());
  async function client(headers: Record<string, string> = {}, protocols: string[] = []) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${desktopBridgeClientPath(CAPABILITY, '/backend-api/codex/responses')}`, protocols, { headers: { origin: 'app://codex', authorization: OAUTH, 'chatgpt-account-id': 'account', cookie: 'session=private', ...headers } });
    ws.on('error', () => undefined); t.after(() => ws.terminate());
    await once(ws, 'open'); return ws;
  }
  return { lb, official, client, port, bridge };
}
async function exchange(ws: WebSocket, value: unknown): Promise<string> {
  const result = once(ws, 'message'); ws.send(typeof value === 'string' ? value : JSON.stringify(value));
  return String((await result)[0]);
}

test('model-less first upgrade waits for fragmented create; priority and Astra event bytes survive', { timeout: 6_000 }, async (t) => {
  const f = await fixture(t); const ws = await f.client({ 'thread-id': 'thread-astra', 'x-api-key': 'client-key' });
  assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0);
  const create = { type: 'response.create', model: MODEL, input: 'go', tools: [{ type: 'function', name: 'lookup', async: true }], reasoning: { effort: 'high' } };
  const encoded = JSON.stringify(create); const reply = once(ws, 'message');
  ws.send(encoded.slice(0, 19), { fin: false }); ws.send(encoded.slice(19), { fin: true });
  assert.equal(String((await reply)[0]), encoded);
  assert.equal(f.lb.headers.length, 1); assert.equal(f.official.headers.length, 0);
  assert.equal(f.lb.headers[0]!.authorization, undefined); assert.equal(f.lb.headers[0]!.cookie, undefined);
  assert.equal(f.lb.headers[0]!['chatgpt-account-id'], undefined); assert.equal(f.lb.headers[0]!['x-api-key'], undefined);
  assert.equal(f.lb.headers[0]!['x-codex-lb-api-key'], 'lb-secret');
  assert.equal(f.lb.headers[0]!['thread-id'], 'thread-astra');
  const steering = '{ "type": "configuration_update", "reasoning": {"effort":"low"}, "opaque": [1,2] }';
  assert.equal(await exchange(ws, steering), steering);
  const continuation = { type: 'response.create', model: `codex-lb:${MODEL}`, previous_response_id: 'resp_latest', input: [{ type: 'function_call_output', call_id: 'original', output: '{"value":1}' }, { role: 'user', content: 'continue' }], tools: [{ type: 'function', async: true, name: 'lookup' }] };
  assert.deepEqual(JSON.parse(await exchange(ws, continuation)), { ...continuation, model: MODEL });
  const binary = once(ws, 'message'); ws.send(Buffer.from([0, 1, 2]));
  const [payload, isBinary] = await binary; assert.deepEqual(payload, Buffer.from([0, 1, 2])); assert.equal(isBinary, true);
  await sleep(1_150);
  assert.equal(await exchange(ws, '{"type":"native.multiplex","response_id":"two","value":7}'), '{"type":"native.multiplex","response_id":"two","value":7}');
  assert.equal(f.lb.headers.length, 1, 'established quiet socket stays connected');
});

test('a prewarmed model-less socket outlives the request and idle timeouts until its first create', { timeout: 6_000 }, async (t) => {
  // Codex opens this socket at startup and sends nothing until the first turn.
  // The fixture's requestTimeoutMs and idleTimeoutMs are both 1 s; a request-
  // scale initial timer closed every prewarmed connection before it was used.
  const f = await fixture(t); const ws = await f.client({ 'thread-id': 'prewarm-thread' });
  await sleep(1_400);
  assert.equal(ws.readyState, WebSocket.OPEN, 'an idle unbound socket is held past requestTimeoutMs and idleTimeoutMs');
  assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0, 'nothing upstream is dialed before a model arrives');
  await exchange(ws, { type: 'response.create', model: MODEL });
  assert.equal(f.lb.headers.length, 1); assert.equal(f.official.headers.length, 0);
});

test('declared official route preserves OAuth and fails visibly before a provider switch or pin mutation', { timeout: 4_000 }, async (t) => {
  let writes = 0;
  const f = await fixture(t, (value) => { value.persistProviderSessionPins = async () => { writes += 1; }; });
  const ws = await f.client({ 'thread-id': 'official-thread', 'x-codex-lb-api-key': 'must-strip' });
  await exchange(ws, { type: 'response.create', model: 'official-model' });
  assert.equal(f.official.headers[0]!.authorization, OAUTH); assert.equal(f.official.headers[0]!['chatgpt-account-id'], 'account');
  assert.equal(f.official.headers[0]!['x-codex-lb-api-key'], undefined); assert.equal(writes, 0);
  const closed = once(ws, 'close'); const response = once(ws, 'message');
  ws.send(Buffer.from(JSON.stringify({ type: 'response.create', model: MODEL })));
  const error = JSON.parse(String((await response)[0]));
  assert.equal(error.error.code, 'bridge_websocket_route_change_forbidden');
  assert.equal((await closed)[0], 1011); assert.equal(f.lb.headers.length, 0); assert.equal(f.official.messages.length, 1); assert.equal(writes, 0);
});

test('persisted session pin keeps the bare model on LB despite a new official priority', { timeout: 4_000 }, async (t) => {
  const f = await fixture(t, (value) => {
    value.routePolicy.model_routes[MODEL] = { provider_id: 'openai', upstream_model: MODEL };
    value.providerSessionPins = [{ thread_id: 'pinned-thread', provider_id: 'codex-lb', public_model: MODEL, upstream_model: MODEL, catalog_generation: 'old', route_policy_generation: 'old', created_at: '2026-08-01T00:00:00.000Z' }];
  });
  const ws = await f.client({ 'thread-id': 'pinned-thread' });
  await exchange(ws, { type: 'response.create', model: MODEL });
  assert.equal(f.lb.messages.length, 1); assert.equal(f.official.headers.length, 0);
  const closed = once(ws, 'close');
  const result = JSON.parse(await exchange(ws, { type: 'response.create', model: 'official-model' }));
  assert.equal(result.error.code, 'bridge_websocket_route_change_forbidden'); await closed;
  assert.equal(f.official.headers.length, 0); assert.equal(f.lb.messages.length, 1);
});

test('initial wait, queue/payload caps, and upstream handshake failures close real sockets', { timeout: 10_000 }, async (t) => {
  for (const failure of ['reject', 'stall'] as const) await t.test(failure, async (child) => {
    const f = await fixture(child, undefined, failure); const ws = await f.client(); const closed = once(ws, 'close');
    const result = JSON.parse(await exchange(ws, { type: 'response.create', model: MODEL }));
    assert.match(result.error.code, /bridge_websocket_(upgrade_failed_401|upstream_handshake_timeout)/);
    assert.equal((await closed)[0], 1011); await sleep(50);
    assert.equal(f.lb.messages.length, 0); assert.equal(f.official.headers.length, 0); assert.equal(f.lb.sockets.size, 0);
  });
  await t.test('initial timeout releases an unbound socket with a normal close and frees connection capacity', async (child) => {
    const f = await fixture(child, (value) => { value.maxConnections = 1; value.websocketInitialCreateTimeoutMs = 1_000; });
    const ws = await f.client(); let messages = 0; ws.on('message', () => { messages += 1; });
    const [code, reason] = await once(ws, 'close');
    assert.equal(code, 1000); assert.equal(String(reason), 'bridge_websocket_initial_create_timeout'); assert.equal(messages, 0, 'no error event for a socket that never asked for anything');
    assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0);
    const next = await f.client(); await exchange(next, { type: 'response.create', model: MODEL }); assert.equal(f.lb.messages.length, 1);
  });
  await t.test('pending count bounded before model', async (child) => {
    const f = await fixture(child); const ws = await f.client(); const message = once(ws, 'message'); const closed = once(ws, 'close');
    for (let index = 0; index < 257; index += 1) ws.send('{}');
    assert.equal(JSON.parse(String((await message)[0])).error.code, 'bridge_websocket_pending_limit_exceeded'); await closed;
    assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0);
  });
  await t.test('payload bound applies across fragments', async (child) => {
    const f = await fixture(child, (value) => { value.maxRequestBodyBytes = 256; }); const ws = await f.client(); const closed = once(ws, 'close');
    ws.send('x'.repeat(200), { fin: false }); ws.send('x'.repeat(200), { fin: true });
    assert.equal((await closed)[0], 1009); assert.equal(f.lb.headers.length, 0);
  });
});

test('diagnostic subprotocol cannot bypass first-create routing on the Responses path', { timeout: 4_000 }, async (t) => {
  const f = await fixture(t); const ws = await f.client({}, ['sks.desktop-bridge.probe.v2']);
  assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0);
  await exchange(ws, { type: 'response.create', model: MODEL });
  assert.equal(f.lb.messages.length, 1); assert.equal(f.official.headers.length, 0);
});

test('create metadata binds body-only thread identity and rejects conflicting identity before forwarding', { timeout: 4_000 }, async (t) => {
  const pins: string[] = [];
  const f = await fixture(t, (value) => { value.persistProviderSessionPins = async (values) => { pins.push(...values.map((pin) => pin.thread_id)); }; });
  const ws = await f.client();
  await exchange(ws, { type: 'response.create', model: MODEL, client_metadata: { thread_id: 'body-thread' } });
  assert.deepEqual(pins, ['body-thread']);
  const closed = once(ws, 'close');
  const result = JSON.parse(await exchange(ws, { type: 'response.create', model: MODEL, client_metadata: { thread_id: 'other-thread' } }));
  assert.equal(result.error.code, 'bridge_codex_session_identity_conflict'); await closed;
  assert.equal(f.lb.messages.length, 1); assert.deepEqual(pins, ['body-thread']);
  const conflicting = await f.client({ 'thread-id': 'header-thread' }); const conflictClosed = once(conflicting, 'close');
  const error = JSON.parse(await exchange(conflicting, { type: 'response.create', model: MODEL, client_metadata: { thread_id: 'wrong-thread' } }));
  assert.equal(error.error.code, 'bridge_codex_session_identity_conflict'); await conflictClosed;
  assert.equal(f.lb.messages.length, 1); assert.deepEqual(pins, ['body-thread']);
});

test('disconnect while credentials resolve never opens an orphan upstream', { timeout: 4_000 }, async (t) => {
  let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, (value) => {
    const original = value.resolveProviderCredential;
    value.resolveProviderCredential = async (...args) => { entered(); await barrier; return original(...args); };
  });
  const ws = await f.client(); ws.send(JSON.stringify({ type: 'response.create', model: MODEL })); await started;
  const closed = once(ws, 'close'); ws.close(); await closed; release(); await sleep(50);
  assert.equal(f.lb.headers.length, 0); assert.equal(f.official.headers.length, 0);
});
