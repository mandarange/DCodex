import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import {
  DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
  desktopBridgeClientPath,
  ensureDesktopBridgeRemoteTarget,
  isUnreachableUpstreamError,
  prepareDesktopBridgeConfig,
  refreshDesktopBridgeRemoteTarget,
  resolveDesktopBridgeRemoteTarget,
  selectAvailableDesktopBridgePort,
  startPreparedDesktopBridge,
  stopDesktopBridge,
  DesktopBridgeError,
  type DesktopBridgeConfig,
  type DesktopBridgeHandle,
  type DesktopBridgeLookup,
} from '../index.js';

const PUBLIC_MODEL = 'public-model';
const CLIENT_CAPABILITY = Buffer.alloc(32, 0x43).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');

async function listen(server: net.Server, host = '127.0.0.1'): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

/**
 * `localhost` is the one hostname that is NOT an IP literal (so runtime
 * re-resolution applies) while every loopback answer passes the rebinding
 * guard — the only way to exercise a real dead-pin → refresh → replay cycle
 * against real sockets without touching the network.
 */
function bridgeConfig(listenPort: number, upstreamPort: number): DesktopBridgeConfig {
  const baseUrl = `http://localhost:${upstreamPort}/backend-api/codex`;
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
          allowed_origins: [new URL(baseUrl).origin], auth_transport: 'x-codex-lb-api-key',
          credential_state: 'ready', credential_fingerprint: 'credential-fingerprint',
          credential_generation: 'credential-generation', source_catalog_generation: 'catalog-generation',
        },
        openrouter: {
          provider_id: 'openrouter', enabled: false, base_url: 'https://openrouter.ai/api/v1',
          allowed_origins: ['https://openrouter.ai'], auth_transport: 'openrouter-bearer',
          credential_state: 'not_configured', credential_fingerprint: null,
          credential_generation: 'openrouter-credential-generation', source_catalog_generation: null,
        },
      },
    },
    routePolicy: {
      schema: 'sks.bridge-routing-policy.v1', default_provider_id: 'codex-lb', fallback: 'none',
      model_routes: { [PUBLIC_MODEL]: { provider_id: 'codex-lb', upstream_model: PUBLIC_MODEL } },
      catalog_generation: 'catalog-generation', policy_generation: 'policy-generation',
      changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId,
      value: 'lb-key-secret',
      source: 'test',
      fingerprint: providerId === 'codex-lb' ? 'credential-fingerprint' : 'unused',
      generation: expectedGeneration,
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: DESKTOP_BRIDGE_ALLOWED_PATH_PREFIXES,
    allowedOrigins: ['app://codex'],
    connectTimeoutMs: 2_000,
    idleTimeoutMs: 10_000,
  };
}

async function responsesRequest(bridgePort: number): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify({ model: PUBLIC_MODEL, input: 'ping' }));
    const req = http.request({
      host: '127.0.0.1', port: bridgePort,
      path: desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses'),
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': body.length, origin: 'app://codex' },
    }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks) }));
    });
    req.once('error', reject);
    req.end(body);
  });
}

test('unreachable-class socket errors are recognized; stale-pool and bridge errors are not', () => {
  for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'ENETDOWN', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'ECONNREFUSED', 'ETIMEDOUT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    assert.equal(isUnreachableUpstreamError(Object.assign(new Error(code), { code })), true, code);
  }
  for (const code of ['ECONNRESET', 'EPIPE', 'ECONNABORTED']) {
    assert.equal(isUnreachableUpstreamError(Object.assign(new Error(code), { code })), false, code);
  }
  assert.equal(isUnreachableUpstreamError(new DesktopBridgeError('bridge_upstream_connect_timeout')), true);
  assert.equal(isUnreachableUpstreamError(new DesktopBridgeError('bridge_upstream_idle_timeout')), false);
  assert.equal(isUnreachableUpstreamError(null), false);
});

test('avoidAddress steers re-resolution away from a dead pin when the answer set allows it', async () => {
  const lookup: DesktopBridgeLookup = async () => [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];
  const first = await resolveDesktopBridgeRemoteTarget('http://localhost:8443/backend-api/codex', lookup);
  assert.equal(first.address, '::1');
  const steered = await resolveDesktopBridgeRemoteTarget('http://localhost:8443/backend-api/codex', lookup, { avoidAddress: '::1' });
  assert.equal(steered.address, '127.0.0.1');
  assert.equal(steered.family, 4);
  // A single-answer set cannot avoid anything: the only address stays selected.
  const only: DesktopBridgeLookup = async () => [{ address: '::1', family: 6 }];
  const stuck = await resolveDesktopBridgeRemoteTarget('http://localhost:8443/backend-api/codex', only, { avoidAddress: '::1' });
  assert.equal(stuck.address, '::1');
});

test('refresh mutates the shared target in place, dedupes concurrent callers, and keeps the pin on failure', async () => {
  let calls = 0;
  let answers: readonly { address: string; family: 4 | 6 }[] = [{ address: '::1', family: 6 }];
  const lookup: DesktopBridgeLookup = async () => { calls += 1; return answers; };
  const remote = await resolveDesktopBridgeRemoteTarget('http://localhost:9000/backend-api/codex', lookup);
  assert.equal(remote.address, '::1');
  assert.equal(calls, 1);

  answers = [{ address: '127.0.0.1', family: 4 }];
  const [a, b, c] = await Promise.all([
    refreshDesktopBridgeRemoteTarget(remote, lookup),
    refreshDesktopBridgeRemoteTarget(remote, lookup),
    refreshDesktopBridgeRemoteTarget(remote, lookup),
  ]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(calls, 2, 'concurrent refreshes share one lookup');
  assert.equal(remote.address, '127.0.0.1');
  assert.equal(remote.family, 4);

  // Within the cooldown a repeat refresh is a no-op — a burst of failing
  // requests must not stampede the resolver.
  assert.equal(await refreshDesktopBridgeRemoteTarget(remote, lookup), false);
  assert.equal(calls, 2);

  // An IP-literal hostname has nothing to re-resolve.
  const literal = await resolveDesktopBridgeRemoteTarget('http://127.0.0.1:9000/backend-api/codex', lookup);
  assert.equal(await refreshDesktopBridgeRemoteTarget(literal, lookup), false);
});

test('a failing or newly-forbidden resolution never disturbs the existing pin', async () => {
  const good: DesktopBridgeLookup = async () => [{ address: '::1', family: 6 }];
  const remoteA = await resolveDesktopBridgeRemoteTarget('http://localhost:9100/backend-api/codex', good);
  const failing: DesktopBridgeLookup = async () => { throw new Error('EAI_AGAIN'); };
  assert.equal(await refreshDesktopBridgeRemoteTarget(remoteA, failing), false);
  assert.equal(remoteA.address, '::1');

  // A rebinding answer (non-loopback for a loopback hostname) fails validation
  // inside the refresh and must leave the pin untouched.
  const remoteB = await resolveDesktopBridgeRemoteTarget('http://localhost:9101/backend-api/codex', good);
  const rebinding: DesktopBridgeLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  assert.equal(await refreshDesktopBridgeRemoteTarget(remoteB, rebinding), false);
  assert.equal(remoteB.address, '::1');
});

test('a dead pinned address self-heals: the bridge re-resolves and replays without a restart', async () => {
  let upstreamRequests = 0;
  const upstream = http.createServer((req, res) => {
    upstreamRequests += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  // The upstream listens ONLY on 127.0.0.1; the bridge starts pinned to ::1,
  // where nothing listens — exactly a network-change-stale pin.
  const upstreamPort = await listen(upstream, '127.0.0.1');
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let answers: readonly { address: string; family: 4 | 6 }[] = [{ address: '::1', family: 6 }];
  const lookup: DesktopBridgeLookup = async () => answers;
  const prepared = await prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), lookup);
  assert.equal(prepared.providers['codex-lb'].remote.address, '::1');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startPreparedDesktopBridge(prepared, { writeState: false });
    // The network "changes": DNS now answers with the reachable address.
    answers = [{ address: '127.0.0.1', family: 4 }];
    const result = await responsesRequest(bridgePort);
    assert.equal(result.status, 200, result.body.toString());
    assert.equal(upstreamRequests, 1);
    // The heal is durable: the shared remote now pins the live address.
    assert.equal(prepared.providers['codex-lb'].remote.address, '127.0.0.1');
    assert.equal(prepared.providers['codex-lb'].remote.family, 4);
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

test('when re-resolution still answers only the dead address, the request fails as upstream unavailable', async () => {
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  // Nothing listens on ::1 at this port; DNS keeps answering only ::1.
  const upstream = http.createServer((req, res) => { req.resume(); res.end('{}'); });
  const upstreamPort = await listen(upstream, '127.0.0.1');
  await close(upstream);
  const lookup: DesktopBridgeLookup = async () => [{ address: '::1', family: 6 }];
  const prepared = await prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), lookup);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startPreparedDesktopBridge(prepared, { writeState: false });
    const result = await responsesRequest(bridgePort);
    assert.equal(result.status, 502);
    assert.equal(JSON.parse(result.body.toString()).error.code, 'bridge_upstream_unavailable');
    assert.equal(prepared.providers['codex-lb'].remote.address, '::1');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
  }
});

test('a TTL refresh keeps a still-listed pin stable and only follows DNS once the pin has disappeared', async () => {
  let answers: readonly { address: string; family: 4 | 6 }[] = [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];
  const lookup: DesktopBridgeLookup = async () => answers;
  const remote = await resolveDesktopBridgeRemoteTarget('http://localhost:9200/backend-api/codex', lookup);
  // The bridge had steered to IPv4 after an IPv6 failure; a periodic refresh
  // that sees both must NOT flap back to the answer set's first entry.
  remote.address = '127.0.0.1'; remote.family = 4;
  assert.equal(await refreshDesktopBridgeRemoteTarget(remote, lookup, 'stale'), false);
  assert.equal(remote.address, '127.0.0.1');
  // Once DNS stops listing the pinned address, the refresh follows DNS. A new
  // target is used because the previous refresh is inside its cooldown.
  const rotated = await resolveDesktopBridgeRemoteTarget('http://localhost:9201/backend-api/codex', lookup);
  rotated.address = '127.0.0.1'; rotated.family = 4;
  answers = [{ address: '::1', family: 6 }];
  assert.equal(await refreshDesktopBridgeRemoteTarget(rotated, lookup, 'stale'), true);
  assert.equal(rotated.address, '::1');
  // A fresh pin is inside its TTL: ensure() performs no lookup at all.
  let calls = 0;
  const counting: DesktopBridgeLookup = async () => { calls += 1; return [{ address: '127.0.0.1', family: 4 }]; };
  const fresh = await resolveDesktopBridgeRemoteTarget('http://localhost:9202/backend-api/codex', counting);
  await ensureDesktopBridgeRemoteTarget(fresh, counting);
  assert.equal(calls, 1);
  // Past the TTL it re-resolves exactly once.
  await ensureDesktopBridgeRemoteTarget(fresh, counting, 0);
  assert.equal(calls, 2);
});

test('DNS down at prepare defers the pin instead of failing preflight, and the pin resolves on first use', async () => {
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream, '127.0.0.1');
  let dnsUp = false;
  const lookup: DesktopBridgeLookup = async () => {
    if (!dnsUp) throw Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' });
    return [{ address: '127.0.0.1', family: 4 }];
  };
  const prepared = await prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), lookup);
  const remote = prepared.providers['codex-lb'].remote;
  assert.equal(remote.unresolved, true);
  assert.equal(remote.address, '0.0.0.0');
  // Still down: the deferred pin fails as the real cause, not as a dial to 0.0.0.0.
  await assert.rejects(ensureDesktopBridgeRemoteTarget(remote, lookup), /bridge_remote_dns_failed/);
  assert.equal(remote.unresolved, true);
  // An INVALID answer is still refused at prepare — deferral covers only
  // DNS being unavailable, never a rebinding or private-address answer.
  const rebinding: DesktopBridgeLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  await assert.rejects(prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), rebinding), /bridge_remote_dns_rebinding_blocked/);

  // Fresh deferred pin (the first one is inside its refresh cooldown).
  const served = await prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), lookup);
  assert.equal(served.providers['codex-lb'].remote.unresolved, true);
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startPreparedDesktopBridge(served, { writeState: false });
    dnsUp = true;
    const result = await responsesRequest(bridgePort);
    assert.equal(result.status, 200, result.body.toString());
    assert.equal(served.providers['codex-lb'].remote.unresolved, undefined);
    assert.equal(served.providers['codex-lb'].remote.address, '127.0.0.1');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});

function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
}

/** A minimal upstream that completes any WebSocket upgrade it receives. */
function upgradingUpstream(onUpgrade: () => void): net.Server {
  return net.createServer((socket) => {
    let head = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const boundary = head.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const key = /sec-websocket-key:\s*([^\r\n]+)/i.exec(head.subarray(0, boundary).toString())?.[1]?.trim() || '';
      onUpgrade();
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${websocketAccept(key)}\r\n\r\n`);
    });
    socket.on('error', () => undefined);
  });
}

async function upgradeThroughBridge(bridgePort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: bridgePort });
    let response = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('upgrade timed out')); }, 5_000);
    socket.once('connect', () => {
      socket.write([
        `GET ${desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses')} HTTP/1.1`,
        `Host: 127.0.0.1:${bridgePort}`,
        'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${Buffer.alloc(16, 0x51).toString('base64')}`,
        'Sec-WebSocket-Version: 13', 'Origin: app://codex', `x-sks-model: ${PUBLIC_MODEL}`,
        '', '',
      ].join('\r\n'));
    });
    socket.on('data', (chunk: Buffer) => {
      response += chunk.toString();
      if (response.includes('\r\n\r\n')) { clearTimeout(timer); socket.destroy(); resolve(response.split('\r\n')[0] || ''); }
    });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('a WebSocket upgrade on a dead pinned address re-resolves and reconnects once without a client retry', async () => {
  let upstreamUpgrades = 0;
  const upstream = upgradingUpstream(() => { upstreamUpgrades += 1; });
  const upstreamPort = await listen(upstream, '127.0.0.1');
  const bridgePort = await selectAvailableDesktopBridgePort('127.0.0.1');
  let answers: readonly { address: string; family: 4 | 6 }[] = [{ address: '::1', family: 6 }];
  const lookup: DesktopBridgeLookup = async () => answers;
  const prepared = await prepareDesktopBridgeConfig(bridgeConfig(bridgePort, upstreamPort), lookup);
  assert.equal(prepared.providers['codex-lb'].remote.address, '::1');
  let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startPreparedDesktopBridge(prepared, { writeState: false });
    answers = [{ address: '127.0.0.1', family: 4 }];
    const statusLine = await upgradeThroughBridge(bridgePort);
    assert.equal(statusLine, 'HTTP/1.1 101 Switching Protocols');
    assert.equal(upstreamUpgrades, 1);
    assert.equal(prepared.providers['codex-lb'].remote.address, '127.0.0.1');
  } finally {
    if (bridge) await stopDesktopBridge(bridge);
    await close(upstream);
  }
});
