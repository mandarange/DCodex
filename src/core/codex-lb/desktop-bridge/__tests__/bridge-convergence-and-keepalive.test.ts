import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { startDesktopBridge, stopDesktopBridge, desktopBridgeClientPath, type DesktopBridgeConfig, type DesktopBridgeHandle } from '../index.js';
import { PACKAGE_VERSION } from '../../../version.js';
import { runDesktopBridgeRestageStage } from '../../../update/update-migration-state/desktop-bridge-restage.js';
import { safeEndUpgradeSocket } from '../websocket-forward.js';
import { TRANSIENT_UPSTREAM_REPLAY_LIMIT } from '../http-forward.js';

const CLIENT_CAPABILITY = Buffer.alloc(32, 0x47).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');
const PUBLIC_MODEL = 'public-model';

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as AddressInfo).port;
}
async function close(server: net.Server): Promise<void> { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
function accept(key: string): string { return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); }
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function bridgeConfig(port: number, upstreamPort: number, idleTimeoutMs: number): DesktopBridgeConfig {
  const baseUrl = `http://127.0.0.1:${upstreamPort}/backend-api/codex`;
  return {
    listenHost: '127.0.0.1', listenPort: port,
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1', generation: 'registry-generation', created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': {
          provider_id: 'codex-lb', enabled: true, base_url: baseUrl, allowed_origins: [new URL(baseUrl).origin], auth_transport: 'x-codex-lb-api-key',
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
      model_routes: { [PUBLIC_MODEL]: { provider_id: 'codex-lb', upstream_model: PUBLIC_MODEL } },
      catalog_generation: 'catalog-generation', policy_generation: 'policy-generation', changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId, value: 'unused-diagnostic-secret', source: 'test',
      fingerprint: providerId === 'codex-lb' ? 'credential-fingerprint' : 'unused-openrouter-fingerprint', generation: expectedGeneration,
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: ['/backend-api/codex/'], allowedOrigins: ['app://codex'], connectTimeoutMs: 500, idleTimeoutMs,
  };
}

/** One masked text frame, client to server, payload under 126 bytes. */
function maskedFrame(payload: Buffer): Buffer {
  const mask = randomBytes(4); const encoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) encoded[index] = (payload[index] || 0) ^ (mask[index % 4] || 0);
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, encoded]);
}

/**
 * The bridge must not execute a quiet WebSocket.
 *
 * Codex holds one Responses socket per session and legitimately sends nothing on
 * it for as long as the user reads or thinks. The old idle timer destroyed the
 * upstream after `idleTimeoutMs` of silence, so every quiet session died on a
 * healthy machine and the client flashed its reconnect banner — the bug users
 * reported as "다시 연결중" appearing for no reason. Liveness on an established
 * tunnel belongs to TCP keepalive, which reaps dead peers without killing
 * healthy-but-quiet ones.
 *
 * The fixture upstream echoes any masked client frame back unmasked. The assert
 * that matters is the SECOND round trip: it happens after a silence longer than
 * `idleTimeoutMs`, so under the old behaviour the upstream socket is already
 * destroyed and the frame can never come back.
 */
test('an established websocket outlives idleTimeoutMs of silence', async () => {
  const upstream = http.createServer();
  const upstreamSockets = new Set<net.Socket>();
  upstream.on('upgrade', (req, socket: net.Socket) => {
    upstreamSockets.add(socket); socket.once('close', () => upstreamSockets.delete(socket));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers['sec-websocket-key']))}\r\n\r\n`);
    socket.on('data', (frame: Buffer) => {
      if (frame.length < 6) return;
      const length = frame[1]! & 0x7f; const mask = frame.subarray(2, 6); const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) payload[index] = (frame[6 + index] || 0) ^ (mask[index % 4] || 0);
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]));
    });
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  const idleTimeoutMs = 1_000;
  let bridge: DesktopBridgeHandle | null = null;
  const client = new net.Socket();
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, idleTimeoutMs), { writeState: false });
    await new Promise<void>((resolve, reject) => { client.once('error', reject); client.connect(bridgePort, '127.0.0.1', resolve); });
    const key = randomBytes(16).toString('base64');
    client.write([
      `GET ${desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses')} HTTP/1.1`,
      `Host: 127.0.0.1:${bridgePort}`,
      'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`, 'Origin: app://codex', `x-sks-model: ${PUBLIC_MODEL}`,
      '', '',
    ].join('\r\n'));

    const chunks: Buffer[] = [];
    let closed = false;
    client.on('data', (chunk) => chunks.push(chunk));
    client.once('close', () => { closed = true; });
    const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (!predicate() && Date.now() < deadline) await sleep(20);
      return predicate();
    };
    assert.ok(await waitFor(() => Buffer.concat(chunks).includes('101'), 2_000), 'the upgrade must complete');

    chunks.length = 0;
    client.write(maskedFrame(Buffer.from('first')));
    assert.ok(await waitFor(() => Buffer.concat(chunks).includes('first'), 2_000), 'the first round trip proves the tunnel');

    // The silence the old code executed the session for.
    await sleep(idleTimeoutMs + 600);
    assert.equal(closed, false, 'a quiet websocket must not be torn down by the bridge');

    chunks.length = 0;
    client.write(maskedFrame(Buffer.from('second')));
    assert.ok(await waitFor(() => Buffer.concat(chunks).includes('second'), 2_000), 'the tunnel must still carry frames after the silence');
  } finally {
    client.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

/**
 * Self-convergence: the server notices the package on disk moved past the code
 * it is running, and calls back exactly once — after two consecutive reads of
 * the same mismatched version, never on one read (npm writes package.json
 * mid-install) and never for an unreadable file (a broken install must not
 * become a restart loop).
 */
test('version skew fires once, only after two consecutive identical mismatches', async () => {
  const upstream = http.createServer((_req, res) => res.end());
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  // null and the current version reset the streak; a changed value restarts it.
  const reads = [null, '9.9.9', PACKAGE_VERSION, '9.9.9', '10.0.0', '10.0.0', '10.0.0'];
  let readIndex = 0;
  const skews: string[] = [];
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 1_000), {
      writeState: false,
      versionSkew: {
        readInstalledVersion: async () => reads[Math.min(readIndex++, reads.length - 1)] ?? null,
        onSkew: (installed) => { skews.push(installed); },
        intervalMs: 1_000,
      },
    });
    const deadline = Date.now() + 12_000;
    while (skews.length === 0 && Date.now() < deadline) await sleep(50);
    assert.deepEqual(skews, ['10.0.0'], 'only the version seen twice in a row may fire');
    // Give the (cleared) timer room to prove it does not fire again.
    await sleep(1_500);
    assert.equal(skews.length, 1, 'the skew callback fires exactly once');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('a bridge running the installed version never sees a skew', async () => {
  const upstream = http.createServer((_req, res) => res.end());
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  const skews: string[] = [];
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 1_000), {
      writeState: false,
      versionSkew: {
        readInstalledVersion: async () => PACKAGE_VERSION,
        onSkew: (installed) => { skews.push(installed); },
        intervalMs: 1_000,
      },
    });
    await sleep(2_600);
    assert.deepEqual(skews, []);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

/**
 * The restage stage must refuse to touch launchd from inside a test runner.
 * `launchctl kickstart` addresses the real gui domain no matter where HOME
 * points, so the only safe behaviour under `node --test` is a named skip — this
 * test runs under exactly that condition, so it witnesses the guard directly.
 */
test('the desktop-bridge restage stage skips itself under a test runner', async () => {
  // Invoked directly rather than through runUpdateMigrationStages: the full
  // stage list includes stages that write the Codex home (profile-config
  // migration), which under the canonical runner is the isolated home its
  // breach guard watches -- running them here tripped
  // canonical_test_home_isolation_breach. Stage-list membership is covered by
  // the current-surface update e2e gate, which redirects HOME wholesale; this
  // test owns exactly one claim, the NODE_TEST_CONTEXT guard.
  const restage = await runDesktopBridgeRestageStage();
  assert.equal(restage.ok, true);
  if (process.platform === 'darwin') {
    assert.deepEqual(restage.actions, ['desktop_bridge_restage_skipped_under_tests']);
  }
});

/**
 * The redaction keeps the upstream's error *identifiers* while still killing
 * its free text. Wholesale replacement erased both, so a gateway saying
 * "response not found" and one saying "rate limited" reached the user as the
 * identical sentence — this bridge's own redaction manufactured the
 * undiagnosable report. `code`/`type` are machine-shaped and carry no request
 * content; the message, which can echo request content, still dies at the
 * bridge.
 */
test('an upstream error keeps its identifiers and loses its text', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'response_not_found', message: 'secret request echo: sk-live-abcdef' } }));
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const body = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const request = http.request({
        host: '127.0.0.1', port: bridgePort, method: 'POST',
        path: desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses'),
        headers: { 'content-type': 'application/json', 'x-sks-model': PUBLIC_MODEL },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      request.once('error', reject);
      request.end(JSON.stringify({ model: PUBLIC_MODEL, input: 'ping' }));
    });
    assert.equal(body.status, 404, 'the status passes through untouched');
    const parsed = JSON.parse(body.text);
    assert.equal(parsed.error.upstream_code, 'response_not_found', 'the identifier survives');
    assert.equal(parsed.error.upstream_type, 'invalid_request_error');
    assert.equal(body.text.includes('sk-live'), false, 'the free text does not');
    assert.equal(body.text.includes('secret'), false);
    assert.equal(parsed.error.message, 'bridge_upstream_request_failed');
    assert.equal(body.text.includes('Upstream request failed'), false);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

/**
 * The gateway's self-described transient ("type": "upstream_error", no code)
 * mislabelled as 404 used to become one 503 that Codex compact treats as
 * fatal (`unexpected status 503 Service Unavailable: Upstream request failed`).
 * The bridge now absorbs those transients internally. A genuine not-found —
 * a different type, or any specific code — still passes through as 404.
 */
test('a gateway upstream_error 404 is replayed, then surfaced as 503 only after the budget is spent', async () => {
  // The gateway spells its transient in error.code (observed live:
  // bridge_upstream_status_404:upstream_error). An affinity miss often
  // lands on the right node on a later attempt, so the bridge replays the
  // buffered Responses body before Codex compact can see a 503.
  let calls = 0; let mode: 'heal' | 'always404' | 'real' = 'heal';
  const upstream = http.createServer((req, res) => {
    calls += 1;
    if (mode === 'real') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'response_not_found', message: 'no such response' } }));
      return;
    }
    if (mode === 'heal' && calls >= 2) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'upstream_error', message: 'Upstream request failed' } }));
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  const call = (): Promise<{ status: number; retryAfter: string | undefined }> => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: bridgePort, method: 'POST',
      path: desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses'),
      headers: { 'content-type': 'application/json', 'x-sks-model': PUBLIC_MODEL },
    }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode || 0, retryAfter: String(response.headers['retry-after'] || '') || undefined }));
    });
    request.once('error', reject);
    request.end(JSON.stringify({ model: PUBLIC_MODEL, input: 'ping' }));
  });
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const healed = await call();
    assert.equal(healed.status, 200, 'the replay heals the affinity miss invisibly');
    assert.equal(calls, 2, 'heals on the first replay');
    mode = 'always404'; calls = 0;
    const exhausted = await call();
    assert.equal(exhausted.status, 503, 'an unhealed transient surfaces only after the budget');
    assert.equal(exhausted.retryAfter, '10');
    assert.equal(calls, 1 + TRANSIENT_UPSTREAM_REPLAY_LIMIT, 'replays stay bounded');
    mode = 'real'; calls = 0;
    const real = await call();
    assert.equal(real.status, 404, 'a genuine not-found stays a 404');
    assert.equal(calls, 1, 'and is never replayed');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

function postResponses(bridgePort: number): Promise<{ status: number; retryAfter: string | undefined; text: string }> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: bridgePort, method: 'POST',
      path: desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses'),
      headers: { 'content-type': 'application/json', 'x-sks-model': PUBLIC_MODEL },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        retryAfter: String(response.headers['retry-after'] || '') || undefined,
        text: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(JSON.stringify({ model: PUBLIC_MODEL, input: 'ping' }));
  });
}

test('a gateway upstream_error 502 is replayed until it heals', async () => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls >= 2) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'upstream_error', message: 'Upstream request failed' } }));
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const healed = await postResponses(bridgePort);
    assert.equal(healed.status, 200);
    assert.equal(calls, 2);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('an unidentified 502 is replayed, then surfaced without the gateway sentence', async () => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    res.writeHead(502, { 'content-type': 'text/html' });
    res.end('<html>Bad Gateway</html>');
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const exhausted = await postResponses(bridgePort);
    assert.equal(exhausted.status, 503);
    assert.equal(exhausted.retryAfter, '10');
    assert.equal(calls, 1 + TRANSIENT_UPSTREAM_REPLAY_LIMIT);
    const parsed = JSON.parse(exhausted.text);
    assert.equal(parsed.error.message, 'temporary_upstream_failure');
    assert.equal(exhausted.text.includes('Upstream request failed'), false);
    assert.equal(exhausted.text.includes('Bad Gateway'), false);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('a compact-shaped 503 timeout heals on a later fresh replay', async () => {
  let calls = 0;
  const upstream = http.createServer((_req, res) => {
    calls += 1;
    if (calls >= 4) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(503, { 'content-type': 'application/json', 'cf-ray': 'a2e11c946b6b33ad-LAX' });
    res.end(JSON.stringify({
      error: { code: 'upstream_request_timeout', message: 'Upstream request failed' },
    }));
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const healed = await postResponses(bridgePort);
    assert.equal(healed.status, 200);
    assert.equal(calls, 4);
    assert.equal(healed.text.includes('Upstream request failed'), false);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('a 429 keeps status and becomes rate_limited with Retry-After', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'upstream_error', message: 'Upstream request failed' } }));
  });
  const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort, 2_000), { writeState: false });
    const limited = await postResponses(bridgePort);
    assert.equal(limited.status, 429);
    assert.equal(limited.retryAfter, '10');
    const parsed = JSON.parse(limited.text);
    assert.equal(parsed.error.message, 'rate_limited');
    assert.equal(parsed.error.upstream_code, 'upstream_error');
    assert.equal(limited.text.includes('Upstream request failed'), false);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('safeEndUpgradeSocket does not throw after the client already ended', () => {
  const socket = new PassThrough();
  socket.end();
  assert.equal(socket.writableEnded, true);
  assert.doesNotThrow(() => safeEndUpgradeSocket(socket, 'HTTP/1.1 501 Not Implemented\r\n\r\n'));
  socket.destroy();
  assert.doesNotThrow(() => safeEndUpgradeSocket(socket, 'HTTP/1.1 501 Not Implemented\r\n\r\n'));
});