import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import test from 'node:test';
import { buildProviderUpstreamHeaders, buildProviderWebSocketHeaders, redactHeaderValue } from '../header-policy.js';
import { desktopBridgeClientPath, startDesktopBridge, stopDesktopBridge, type DesktopBridgeConfig, type DesktopBridgeHandle } from '../index.js';

const CLIENT_CAPABILITY = Buffer.alloc(32, 0x45).toString('base64url');
const CLIENT_CAPABILITY_SHA256 = createHash('sha256').update(CLIENT_CAPABILITY).digest('hex');

const inbound = {
  authorization: 'Bearer chatgpt-oauth-secret', cookie: 'chatgpt=session', 'x-codex-lb-api-key': 'forged',
  connection: 'keep-alive, x-remove-me', 'x-remove-me': 'dynamic-hop', 'content-type': 'application/json',
  'thread-id': 'thread-1', 'session-id': 'thread-1', 'x-client-request-id': 'request-1',
  'x-codex-window-id': 'thread-1:0', 'x-codex-turn-metadata': JSON.stringify({
    installation_id: 'install-1', thread_id: 'thread-1', session_id: 'thread-1', sandbox: 'seatbelt',
  }),
  originator: 'codex_cli_rs', 'user-agent': 'codex_cli_rs/9.9.9',
  'http-referer': 'https://client.example', 'x-title': 'Desktop',
};

test('Codex-LB and OpenRouter policies strip OAuth/cookies and inject only the selected credential', async () => {
  const [lb, openrouter] = await Promise.all([
    Promise.resolve(buildProviderUpstreamHeaders(inbound, {
      providerId: 'codex-lb', authTransport: 'x-codex-lb-api-key',
      credential: { provider_id: 'codex-lb', value: 'lb-only-secret', source: 'fixture', fingerprint: 'lb', generation: 'lb-1' },
    }, 'lb.example')),
    Promise.resolve(buildProviderUpstreamHeaders(inbound, {
      providerId: 'openrouter', authTransport: 'openrouter-bearer',
      credential: { provider_id: 'openrouter', value: 'or-only-secret', source: 'fixture', fingerprint: 'or', generation: 'or-1' },
    }, 'openrouter.ai')),
  ]);
  assert.equal(lb.authorization, undefined); assert.equal(lb['x-codex-lb-api-key'], 'lb-only-secret');
  assert.equal(openrouter.authorization, 'Bearer or-only-secret'); assert.equal(openrouter['x-codex-lb-api-key'], undefined);
  for (const headers of [lb, openrouter]) {
    assert.equal(headers.cookie, undefined); assert.equal(headers['thread-id'], undefined); assert.equal(headers['session-id'], undefined);
    assert.equal(headers['x-codex-turn-metadata'], undefined); assert.equal(headers['x-client-request-id'], undefined);
    assert.equal(headers.originator, undefined); assert.equal(headers['user-agent'], undefined); assert.equal(headers['x-remove-me'], undefined);
    assert.doesNotMatch(JSON.stringify(headers), /chatgpt-oauth-secret|chatgpt=session|forged/);
  }
  assert.equal(lb['http-referer'], undefined); assert.equal(openrouter['http-referer'], 'https://client.example');
  assert.equal(openrouter['x-title'], 'Desktop');
});

test('provider identity and auth transport cannot be crossed', () => {
  assert.throws(() => buildProviderUpstreamHeaders({}, {
    providerId: 'openrouter', authTransport: 'x-codex-lb-api-key',
    credential: { provider_id: 'openrouter', value: 'secret', source: 'fixture', fingerprint: 'x', generation: '1' },
  }, 'openrouter.ai'), /bridge_provider_auth_transport_mismatch/);
  assert.throws(() => buildProviderWebSocketHeaders({}, {
    providerId: 'codex-lb', authTransport: 'authorization-bearer',
    credential: { provider_id: 'openrouter', value: 'secret', source: 'fixture', fingerprint: 'x', generation: '1' },
  }, 'lb.example'), /bridge_provider_credential_invalid/);
  assert.equal(redactHeaderValue('Authorization', 'Bearer secret'), '[REDACTED]');
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return (server.address() as AddressInfo).port;
}
async function close(server: net.Server): Promise<void> { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
async function post(port: number, model: string): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ model, input: 'hello' });
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: desktopBridgeClientPath(CLIENT_CAPABILITY, '/backend-api/codex/responses'), method: 'POST', headers: { authorization: 'Bearer desktop-oauth', cookie: 'desktop=session', 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.once('error', reject); req.end(body);
  });
}

test('R47/R48 security: canonical Codex ingress translates provider paths and keeps concurrent credentials isolated', async () => {
  const seen = new Map<string, { headers: IncomingMessage['headers']; body: string; path: string }>();
  const upstream = (name: string) => http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (chunk: Buffer) => chunks.push(chunk)); req.once('end', () => {
      const body = Buffer.concat(chunks).toString();
      seen.set(name, { headers: req.headers, body, path: req.url || '' });
      if (body.includes('lb/error')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bearer sk-sensitive-upstream-key-12345678', api_key: 'sk-sensitive-upstream-key-12345678' }));
        return;
      }
      res.end('{"ok":true}');
    });
  });
  const lb = upstream('lb'); const openrouter = upstream('openrouter'); const lbPort = await listen(lb); const orPort = await listen(openrouter);
  const holder = net.createServer(); const bridgePort = await listen(holder); await close(holder); let bridge: DesktopBridgeHandle | null = null;
  const config: DesktopBridgeConfig = {
    providerRegistry: {
      schema: 'sks.desktop-bridge-provider-registry.v1', generation: 'registry-1', created_at: '2026-08-05T00:00:00.000Z',
      providers: {
        'codex-lb': { provider_id: 'codex-lb', enabled: true, base_url: `http://127.0.0.1:${lbPort}/backend-api/codex`, allowed_origins: [`http://127.0.0.1:${lbPort}`], auth_transport: 'x-codex-lb-api-key', credential_state: 'ready', credential_fingerprint: 'lb-fp', credential_generation: 'lb-g1', source_catalog_generation: 'lb-source-catalog-1' },
        openrouter: { provider_id: 'openrouter', enabled: true, base_url: `http://127.0.0.1:${orPort}/api/v1`, allowed_origins: [`http://127.0.0.1:${orPort}`], auth_transport: 'openrouter-bearer', credential_state: 'ready', credential_fingerprint: 'or-fp', credential_generation: 'or-g1', source_catalog_generation: 'or-source-catalog-1' },
      },
    },
    routePolicy: { schema: 'sks.bridge-routing-policy.v1', default_provider_id: null, fallback: 'none', model_routes: { public_lb: { provider_id: 'codex-lb', upstream_model: 'lb/upstream' }, public_or: { provider_id: 'openrouter', upstream_model: 'or/upstream' }, public_error: { provider_id: 'codex-lb', upstream_model: 'lb/error' } }, catalog_generation: 'combined-catalog-1', policy_generation: 'policy-1', changed_at: '2026-08-05T00:00:00.000Z' },
    providerSessionPins: [],
    resolveProviderCredential: async (id, expected) => {
      await new Promise((resolve) => setTimeout(resolve, id === 'codex-lb' ? 10 : 1));
      return id === 'codex-lb'
        ? { provider_id: id, value: 'lb-concurrent-secret', source: 'fixture', fingerprint: 'lb-fp', generation: expected }
        : { provider_id: id, value: 'or-concurrent-secret', source: 'fixture', fingerprint: 'or-fp', generation: expected };
    },
    clientCapabilitySha256: CLIENT_CAPABILITY_SHA256,
    listenHost: '127.0.0.1', listenPort: bridgePort, allowedPathPrefixes: ['/backend-api/codex/'], allowedOrigins: ['app://codex'], connectTimeoutMs: 1_000, idleTimeoutMs: 5_000,
  };
  try {
    bridge = await startDesktopBridge(config, { writeState: false }); await Promise.all([post(bridgePort, 'public_lb'), post(bridgePort, 'public_or')]);
    assert.equal(seen.get('lb')?.headers['x-codex-lb-api-key'], 'lb-concurrent-secret'); assert.equal(seen.get('lb')?.headers.authorization, undefined);
    assert.equal(seen.get('openrouter')?.headers.authorization, 'Bearer or-concurrent-secret'); assert.equal(seen.get('openrouter')?.headers['x-codex-lb-api-key'], undefined);
    assert.equal(seen.get('lb')?.path, '/backend-api/codex/responses');
    assert.equal(seen.get('openrouter')?.path, '/api/v1/responses');
    assert.equal(JSON.parse(seen.get('lb')?.body || '{}').model, 'lb/upstream'); assert.equal(JSON.parse(seen.get('openrouter')?.body || '{}').model, 'or/upstream');
    assert.doesNotMatch(JSON.stringify([...seen.values()]), /desktop-oauth|desktop=session/);
    const redacted = await post(bridgePort, 'public_error');
    assert.equal(redacted.status, 401);
    assert.deepEqual(JSON.parse(redacted.body), {
      error: {
        type: 'upstream_error',
        code: 'bridge_upstream_request_failed',
        message: 'Upstream request failed',
      },
    });
    assert.doesNotMatch(redacted.body, /sk-sensitive-upstream-key-12345678/);
  } finally { if (bridge) await stopDesktopBridge(bridge); await Promise.all([close(lb), close(openrouter)]); }
});
