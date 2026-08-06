import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import test from 'node:test';
import { desktopBridgeClientPath, probeDesktopBridgeWebSocket, startDesktopBridge, stopDesktopBridge, type DesktopBridgeConfig, type DesktopBridgeHandle } from '../index.js';

const CLIENT_CAPABILITY = Buffer.alloc(32, 0x46).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as AddressInfo).port;
}
async function close(server: net.Server): Promise<void> { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
function accept(key: string): string { return createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64'); }
function probe(port: number, extra: object = {}) { return probeDesktopBridgeWebSocket({ url: `ws://127.0.0.1:${port}${desktopBridgeClientPath(CLIENT_CAPABILITY, '/probe')}`, protocol: 'sks.desktop-bridge.probe.v2', maxRetries: 0, stageTimeoutMs: 250, totalTimeoutMs: 1_000, ...extra }); }

test('R14 TCP failure reports exactly one terminal root cause', async () => {
  const holder = net.createServer(); const port = await listen(holder); await close(holder);
  const result = await probe(port); assert.deepEqual(result.blockers, ['desktop_bridge_tcp_connect_failed']); assert.equal(result.terminal_stage, 'tcp_connect');
});

test('R16-R18 upgrade status, accept, and protocol failures are mutually exclusive', async (t) => {
  for (const fixture of [
    { name: 'status', root: 'desktop_bridge_websocket_upgrade_failed', response: () => 'HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n' },
    { name: 'accept', root: 'desktop_bridge_websocket_accept_invalid', response: () => 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: invalid\r\nSec-WebSocket-Protocol: sks.desktop-bridge.probe.v2\r\n\r\n' },
    { name: 'protocol', root: 'desktop_bridge_websocket_protocol_mismatch', response: (key: string) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: wrong.v1\r\n\r\n` },
  ]) {
    await t.test(fixture.name, async () => {
      const server = http.createServer(); server.on('upgrade', (req, socket) => socket.end(fixture.response(String(req.headers['sec-websocket-key'] || ''))));
      const port = await listen(server); try { const result = await probe(port); assert.deepEqual(result.blockers, [fixture.root]); assert.equal(result.blockers.includes('desktop_bridge_websocket_transport_failed'), false); } finally { await close(server); }
    });
  }
});

test('R19 successful upgrade followed by no frame reports frame receive only', async () => {
  const upgradedSockets = new Set<Duplex>();
  const server = http.createServer(); server.on('upgrade', (req, socket) => { upgradedSockets.add(socket); socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers['sec-websocket-key']))}\r\nSec-WebSocket-Protocol: sks.desktop-bridge.probe.v2\r\n\r\n`); });
  const port = await listen(server); try { const result = await probe(port); assert.equal(result.upgrade_verified, true); assert.deepEqual(result.blockers, ['desktop_bridge_websocket_frame_receive_failed']); } finally { for (const socket of upgradedSockets) socket.destroy(); await close(server); }
});

function bridgeConfig(port: number, upstreamPort: number): DesktopBridgeConfig {
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
      model_routes: { 'public-model': { provider_id: 'codex-lb', upstream_model: 'public-model' } },
      catalog_generation: 'catalog-generation', policy_generation: 'policy-generation', changed_at: '2026-08-05T00:00:00.000Z',
    },
    providerSessionPins: [],
    resolveProviderCredential: async (providerId, expectedGeneration) => ({
      provider_id: providerId, value: 'unused-diagnostic-secret', source: 'test',
      fingerprint: providerId === 'codex-lb' ? 'credential-fingerprint' : 'unused-openrouter-fingerprint', generation: expectedGeneration,
    }),
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    allowedPathPrefixes: ['/backend-api/codex/'], allowedOrigins: ['app://codex'], connectTimeoutMs: 500, idleTimeoutMs: 2_000,
  };
}

test('R20 diagnostic protocol proves upgrade, protocol, frame round trip, and clean close independently', async () => {
  const upstream = http.createServer((_req, res) => res.end()); const upstreamPort = await listen(upstream);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder); let bridge: DesktopBridgeHandle | null = null;
  try {
    bridge = await startDesktopBridge(bridgeConfig(bridgePort, upstreamPort), { writeState: false });
    const diagnosticUrl = `ws://127.0.0.1:${bridgePort}${desktopBridgeClientPath(CLIENT_CAPABILITY, '/__sks/diagnostics/websocket')}`;
    const result = await probeDesktopBridgeWebSocket({ url: diagnosticUrl, origin: 'app://codex', maxRetries: 0, stageTimeoutMs: 1_000 });
    assert.equal(result.state, 'verified'); assert.equal(result.upgrade_verified, true); assert.equal(result.protocol_verified, true); assert.equal(result.frame_round_trip_verified, true); assert.equal(result.clean_close_verified, true); assert.deepEqual(result.blockers, []);
    const handshake = await probeDesktopBridgeWebSocket({ url: diagnosticUrl, origin: 'app://codex', handshakeOnly: true, maxRetries: 0 });
    assert.equal(handshake.state, 'degraded'); assert.equal(handshake.terminal_stage, 'websocket_protocol'); assert.equal(handshake.upgrade_verified, true); assert.equal(handshake.frame_round_trip_verified, false); assert.deepEqual(handshake.warnings, ['websocket_handshake_only_frame_not_attempted']);
    const shallowHandshake = await probeDesktopBridgeWebSocket({ url: diagnosticUrl, origin: 'app://codex', handshakeOnly: true, requestedLevel: 'shallow', maxRetries: 0 });
    assert.equal(shallowHandshake.state, 'not_attempted'); assert.equal(shallowHandshake.frame_round_trip_verified, false);
  } finally { if (bridge) await stopDesktopBridge(bridge); await close(upstream); }
});

test('close failure after a verified frame has one clean-close terminal cause', async () => {
  const sockets = new Set<Duplex>(); const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(String(req.headers['sec-websocket-key']))}\r\nSec-WebSocket-Protocol: sks.desktop-bridge.probe.v2\r\n\r\n`);
    socket.once('data', (frame: Buffer) => {
      const length = frame[1]! & 0x7f; const mask = frame.subarray(2, 6); const payload = Buffer.alloc(length);
      for (let index = 0; index < length; index += 1) payload[index] = (frame[6 + index] || 0) ^ (mask[index % 4] || 0);
      socket.write(Buffer.concat([Buffer.from([0x81, length]), payload]), () => socket.destroy());
    });
  });
  const port = await listen(server);
  try {
    const result = await probe(port); assert.equal(result.frame_round_trip_verified, true); assert.equal(result.terminal_stage, 'clean_close'); assert.deepEqual(result.blockers, ['desktop_bridge_websocket_close_failed']);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});

test('retry success retains retry warning but no terminal blocker', async () => {
  let attempts = 0; const sockets = new Set<Duplex>(); const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
    attempts += 1;
    if (attempts === 1) { socket.end('HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const protocol = String(req.headers['sec-websocket-protocol']); const key = String(req.headers['sec-websocket-key']);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(key)}\r\nSec-WebSocket-Protocol: ${protocol}\r\n\r\n`);
  });
  const port = await listen(server); try {
    const result = await probeDesktopBridgeWebSocket({ url: `ws://127.0.0.1:${port}${desktopBridgeClientPath(CLIENT_CAPABILITY, '/probe')}`, handshakeOnly: true, maxRetries: 1, jitter: () => 0, stageTimeoutMs: 500, totalTimeoutMs: 2_000 });
    assert.equal(result.state, 'degraded'); assert.deepEqual(result.blockers, []); assert.match(result.warnings[0] || '', /^desktop_bridge_websocket_retry:1:/);
  } finally { for (const socket of sockets) socket.destroy(); await close(server); }
});
