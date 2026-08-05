import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import http, { type IncomingMessage, type Server } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  DesktopBridgeError,
  selectAvailableDesktopBridgePort,
  startDesktopBridge,
  stopDesktopBridge,
  type DesktopBridgeConfig,
  type DesktopBridgeProviderAuthTransport,
  type DesktopBridgeHandle,
} from '../index.js';

const PUBLIC_MODEL = 'public-model';
const CATALOG_GENERATION = 'catalog-generation';
const POLICY_GENERATION = 'policy-generation';
const CREDENTIAL_GENERATION = 'credential-generation';
const CREDENTIAL_FINGERPRINT = 'credential-fingerprint';
const CODEX_LB_SECRET = 'lb-key-blackbox-secret';

async function listen(server: Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function bridgeConfig(
  listenPort: number,
  upstreamPort: number,
  transport: DesktopBridgeProviderAuthTransport,
): DesktopBridgeConfig {
  const baseUrl = `http://127.0.0.1:${upstreamPort}/backend-api/codex`;
  return {
    listenHost: '127.0.0.1',
    listenPort,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1',
      generation: 'registry-generation',
      created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl,
          allowed_origins: [new URL(baseUrl).origin], auth_transport: transport,
          credential_state: 'ready', credential_fingerprint: CREDENTIAL_FINGERPRINT,
          credential_generation: CREDENTIAL_GENERATION, catalog_generation: CATALOG_GENERATION,
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'openrouter-credential-generation', catalog_generation: null,
        },
      },
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { [PUBLIC_MODEL]: { provider_id: 'codex-lb', upstream_model: PUBLIC_MODEL } },
      catalog_generation: CATALOG_GENERATION, policy_generation: POLICY_GENERATION,
      changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: providerId === 'codex-lb' ? CODEX_LB_SECRET : 'unused-openrouter-secret',
      source: 'test',
      fingerprint: providerId === 'codex-lb' ? CREDENTIAL_FINGERPRINT : 'unused-openrouter-fingerprint',
      generation: expectedGeneration,
    }),
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
  };
}

async function request(input: {
  port: number;
  path: string;
  method?: string;
  headers?: http.OutgoingHttpHeaders;
  chunks?: readonly Buffer[];
  onData?: (chunk: Buffer) => void;
}): Promise<{ status: number; headers: IncomingMessage['headers']; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: input.port,
      path: input.path,
      method: input.method || 'GET',
      headers: input.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        input.onData?.(chunk);
      });
      res.once('end', () => resolve({
        status: res.statusCode || 0,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.once('error', reject);
    for (const chunk of input.chunks || []) req.write(chunk);
    req.end();
  });
}

test('HTTP/SSE streams without buffering, rewrites Location, and uses only the preferred gateway header', async () => {
  let upstreamEnded = false;
  let upstreamHeaders: IncomingMessage['headers'] = {};
  const upstream = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    assert.equal(req.url, '/backend-api/codex/responses?stream=1');
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      location: `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}/backend-api/codex/call-1?token=opaque`,
      'set-cookie': 'remote=session-secret',
      'x-codex-lb-api-key': 'response-secret',
    });
    res.write('data: first\n\n');
    setTimeout(() => {
      upstreamEnded = true;
      res.end('data: second\n\n');
    }, 80);
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 'x-codex-lb-api-key'), {
      writeState: false,
    });
    let firstArrivedBeforeEnd = false;
    const result = await request({
      port: bridgePort,
      path: '/backend-api/codex/responses?stream=1',
      method: 'POST',
      headers: {
        authorization: 'Bearer desktop-oauth-secret',
        cookie: 'desktop=session-secret',
        'x-codex-lb-api-key': 'client-forged-key',
        'x-sks-model': PUBLIC_MODEL,
        'content-type': 'application/json',
      },
      chunks: [Buffer.from('{"stream":true}')],
      onData: () => {
        if (!upstreamEnded) firstArrivedBeforeEnd = true;
      },
    });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString(), 'data: first\n\ndata: second\n\n');
    assert.equal(firstArrivedBeforeEnd, true);
    assert.equal(upstreamHeaders.authorization, undefined);
    assert.equal(upstreamHeaders.cookie, undefined);
    assert.equal(upstreamHeaders['x-codex-lb-api-key'], 'lb-key-blackbox-secret');
    assert.equal(result.headers['set-cookie'], undefined);
    assert.equal(result.headers['x-codex-lb-api-key'], undefined);
    assert.equal(
      result.headers.location,
      `ws://127.0.0.1:${bridgePort}/backend-api/codex/call-1?token=opaque`,
    );
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('multipart request bytes are unchanged and current Codex-LB bearer auth is explicit', async () => {
  const received = createHash('sha256');
  let receivedLength = 0;
  let upstreamHeaders: IncomingMessage['headers'] = {};
  const upstream = http.createServer((req, res) => {
    upstreamHeaders = req.headers;
    req.on('data', (chunk: Buffer) => {
      received.update(chunk);
      receivedLength += chunk.length;
    });
    req.once('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        authorization: 'Bearer reflected-lb-key',
      });
      res.end('{"ok":true}');
    });
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  const payload = Buffer.concat([
    Buffer.from('--boundary\r\nContent-Disposition: form-data; name="file"; filename="x.bin"\r\n\r\n'),
    Buffer.alloc(1024 * 1024, 0xa5),
    Buffer.from('\r\n--boundary--\r\n'),
  ]);
  const expected = createHash('sha256').update(payload).digest('hex');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 'authorization-bearer'), {
      writeState: false,
    });
    const result = await request({
      port: bridgePort,
      path: '/backend-api/files',
      method: 'POST',
      headers: {
        authorization: 'Bearer desktop-oauth-secret',
        cookie: 'desktop=session-secret',
        'x-codex-lb-api-key': 'client-forged-key',
        'x-sks-model': PUBLIC_MODEL,
        'content-type': 'multipart/form-data; boundary=boundary',
        'content-length': String(payload.length),
      },
      chunks: [payload.subarray(0, 333_333), payload.subarray(333_333)],
    });
    assert.equal(result.status, 200);
    assert.equal(receivedLength, payload.length);
    assert.equal(received.digest('hex'), expected);
    assert.equal(upstreamHeaders.authorization, 'Bearer lb-key-blackbox-secret');
    assert.equal(upstreamHeaders.cookie, undefined);
    assert.equal(upstreamHeaders['x-codex-lb-api-key'], undefined);
    assert.equal(result.headers.authorization, undefined);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('unauthorized path/origin and cross-origin Location fail closed without proxy leakage', async () => {
  let upstreamCalls = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamCalls += 1;
    res.writeHead(302, { location: 'https://attacker.example/steal' });
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 'x-codex-lb-api-key'), {
      writeState: false,
    });
    const pathRejected = await request({ port: bridgePort, path: '/backend-api/accounts' });
    assert.equal(pathRejected.status, 404);
    const originRejected = await request({
      port: bridgePort,
      path: '/backend-api/codex/responses',
      headers: { origin: 'https://attacker.example' },
    });
    assert.equal(originRejected.status, 403);
    assert.equal(upstreamCalls, 0);

    const redirectRejected = await request({
      port: bridgePort,
      path: '/backend-api/codex/responses',
      method: 'POST',
      headers: { 'x-sks-model': PUBLIC_MODEL, 'content-type': 'application/json' },
      chunks: [Buffer.from(JSON.stringify({ model: PUBLIC_MODEL }))],
    });
    assert.equal(redirectRejected.status, 502);
    assert.equal(redirectRejected.headers.location, undefined);
    assert.equal(redirectRejected.body.includes(Buffer.from('attacker.example')), false);
    assert.equal(upstreamCalls, 1);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('client disconnect destroys the upstream streaming socket', async () => {
  let resolveClosed: (() => void) | undefined;
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    res.socket?.once('close', () => resolveClosed?.());
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 'x-codex-lb-api-key'), {
      writeState: false,
    });
    await new Promise<void>((resolve, reject) => {
      const req = http.get({
        host: '127.0.0.1', port: bridgePort, path: '/backend-api/codex/stream',
        headers: { 'x-sks-model': PUBLIC_MODEL },
      }, (res) => {
        res.once('data', () => {
          req.destroy();
          res.destroy();
          resolve();
        });
      });
      req.once('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
    });
    await Promise.race([
      upstreamClosed,
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('upstream socket stayed open')), 2_000)),
    ]);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('raw WebSocket tunnel preserves subprotocol, binary bytes, close frame, and provider auth separation', async () => {
  const clientPayload = Buffer.from([1, 2, 3, 4]);
  const mask = Buffer.from([5, 6, 7, 8]);
  const maskedPayload = Buffer.from(clientPayload.map((value, index) => value ^ (mask[index % 4] || 0)));
  const maskedClientFrame = Buffer.concat([Buffer.from([0x82, 0x84]), mask, maskedPayload]);
  const serverBinaryFrame = Buffer.concat([Buffer.from([0x82, clientPayload.length]), clientPayload]);
  const serverCloseFrame = Buffer.from([0x88, 0x05, 0x03, 0xe8, 0x62, 0x79, 0x65]);
  let upgradeHeaders: IncomingMessage['headers'] = {};
  let receivedClientFrame = Buffer.alloc(0);

  const upstream = http.createServer();
  upstream.on('upgrade', (req, socket, head) => {
    upgradeHeaders = req.headers;
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n`
      + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
      + 'Set-Cookie: forbidden=secret\r\n'
      + '\r\n',
    );
    const consume = (chunk: Buffer): void => {
      receivedClientFrame = Buffer.concat([receivedClientFrame, chunk]);
      if (receivedClientFrame.length >= maskedClientFrame.length) {
        socket.write(serverBinaryFrame);
        socket.end(serverCloseFrame);
      }
    };
    if (head.length) consume(head);
    socket.on('data', consume);
  });
  const upstreamPort = await listen(upstream);
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let bridge: DesktopBridgeHandle | null = null;
  const clientHolder: { socket: Socket | null } = { socket: null };
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 'authorization-bearer'), {
      writeState: false,
    });
    const result = await new Promise<{ responseHead: string; frames: Buffer }>((resolve, reject) => {
      const client = net.connect({ host: '127.0.0.1', port: bridgePort });
      clientHolder.socket = client;
      const chunks: Buffer[] = [];
      let sentFrame = false;
      client.once('connect', () => {
        client.write(
          'GET /backend-api/codex/realtime/call-1?token=opaque HTTP/1.1\r\n'
          + `Host: 127.0.0.1:${bridgePort}\r\n`
          + 'Connection: Upgrade\r\n'
          + 'Upgrade: websocket\r\n'
          + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n'
          + 'Sec-WebSocket-Version: 13\r\n'
          + 'Sec-WebSocket-Protocol: codex.realtime.v1\r\n'
          + `X-SKS-Model: ${PUBLIC_MODEL}\r\n`
          + 'Authorization: Bearer desktop-oauth-secret\r\n'
          + 'Cookie: desktop=session-secret\r\n'
          + '\r\n',
        );
      });
      client.on('data', (chunk) => {
        chunks.push(chunk);
        const all = Buffer.concat(chunks);
        const boundary = all.indexOf('\r\n\r\n');
        if (boundary >= 0 && !sentFrame) {
          sentFrame = true;
          client.write(maskedClientFrame);
        }
        if (boundary >= 0 && all.length >= boundary + 4 + serverBinaryFrame.length + serverCloseFrame.length) {
          resolve({
            responseHead: all.subarray(0, boundary).toString('latin1'),
            frames: all.subarray(boundary + 4),
          });
          client.destroy();
        }
      });
      client.once('error', reject);
      client.once('close', () => {
        const all = Buffer.concat(chunks);
        const boundary = all.indexOf('\r\n\r\n');
        if (boundary < 0) reject(new Error('missing websocket response head'));
      });
    });
    assert.match(result.responseHead, /101 Switching Protocols/);
    assert.match(result.responseHead, /Sec-WebSocket-Protocol: codex\.realtime\.v1/i);
    assert.doesNotMatch(result.responseHead, /Set-Cookie/i);
    assert.deepEqual(result.frames, Buffer.concat([serverBinaryFrame, serverCloseFrame]));
    assert.deepEqual(receivedClientFrame.subarray(0, maskedClientFrame.length), maskedClientFrame);
    assert.equal(upgradeHeaders.authorization, `Bearer ${CODEX_LB_SECRET}`);
    assert.equal(upgradeHeaders.cookie, undefined);
    assert.equal(upgradeHeaders['x-codex-lb-api-key'], undefined);
    assert.equal(upgradeHeaders['sec-websocket-protocol'], 'codex.realtime.v1');
  } finally {
    clientHolder.socket?.destroy();
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('fixed bridge port collision fails closed without choosing a different port', async () => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-desktop-bridge-collision-'));
  const statePath = path.join(temp, 'bridge-state.json');
  const occupied = http.createServer((_req, res) => res.end('occupied'));
  const occupiedPort = await selectAvailableDesktopBridgePort('127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', reject);
    occupied.listen(occupiedPort, '127.0.0.1', () => resolve());
  });
  const upstream = http.createServer((_req, res) => res.end('upstream'));
  const upstreamPort = await listen(upstream);
  try {
    await assert.rejects(
      startDesktopBridge(
        bridgeConfig(occupiedPort, upstreamPort, 'x-codex-lb-api-key'),
        { statePath },
      ),
      (error: unknown) => error instanceof DesktopBridgeError && error.code === 'bridge_port_conflict',
    );
    await assert.rejects(fsp.access(statePath), { code: 'ENOENT' });
  } finally {
    await close(occupied);
    await close(upstream);
    await fsp.rm(temp, { recursive: true, force: true });
  }
});
