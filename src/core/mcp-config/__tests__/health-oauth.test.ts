import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { buildCodexMcpAddArgs, type CodexCliMutationOperation, type CodexMcpCliPort } from '../codex-cli-adapter.js';
import { testMcpConnection } from '../health-check.js';
import { loginMcpServer, logoutMcpServer } from '../oauth.js';
import {
  MCP_CLIENT_CAPABILITIES_META_KEY,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_META_KEY,
  MCP_SERVER_INFO_META_KEY
} from '../../mcp/modern-protocol.js';

class AuthCli implements CodexMcpCliPort {
  calls: Array<{ action: string; name: string; scopes?: readonly string[] }> = [];
  async list() { return { available: true, ok: true, rows: [], public_error: null }; }
  async transform(before: string, _operation: CodexCliMutationOperation) {
    return { available: true, ok: true, used: true, text: before, unsupported_reason: null, public_error: null };
  }
  async login(_ref: unknown, name: string, scopes?: readonly string[]) {
    this.calls.push({ action: 'login', name, ...(scopes ? { scopes } : {}) });
    return { available: true, ok: true, public_error: null };
  }
  async logout(_ref: unknown, name: string) {
    this.calls.push({ action: 'logout', name });
    return { available: true, ok: true, public_error: null };
  }
}

async function fixture(t: test.TestContext) {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-mcp-health-'));
  const configPath = path.join(home, '.codex', 'config.toml');
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  t.after(async () => fsp.rm(home, { recursive: true, force: true }));
  return { home, configPath };
}

test('stdio health uses modern discovery first and safely falls back for an initialization-era server', async (t) => {
  const s = await fixture(t);
  const server = path.join(s.home, 'fixture-server.mjs');
  await fsp.writeFile(server, [
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'server/discover') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, error:{ code:-32601, message:'Method not found' } }));",
    "  if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:'2024-11-05', instructions:'safe' } }));",
    "  if (msg.method === 'tools/list') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:{ tools:[{name:'one'},{name:'two'}] } }));",
    "});"
  ].join('\n'), { mode: 0o600 });
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.local_health]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(server)}]`,
    'env_vars = ["MCP_HEALTH_SECRET"]',
    'startup_timeout_sec = 3',
    'tool_timeout_sec = 3',
    ''
  ].join('\n'), { mode: 0o600 });
  const before = process.env.MCP_HEALTH_SECRET;
  process.env.MCP_HEALTH_SECRET = 'must-never-appear';
  t.after(() => {
    if (before === undefined) delete process.env.MCP_HEALTH_SECRET;
    else process.env.MCP_HEALTH_SECRET = before;
  });

  const health = await testMcpConnection('local_health', 'global', { home: s.home });
  assert.equal(health.status, 'healthy');
  assert.equal(health.protocol_version, '2024-11-05');
  assert.equal(health.tool_count, 2);
  assert.deepEqual(health.tool_names, ['one', 'two']);
  assert.equal(health.instructions_present, true);
  assert.doesNotMatch(JSON.stringify(health), /must-never-appear/);
});

test('stdio handshake timeout terminates the spawned process tree', { timeout: 12_000 }, async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process-group cleanup assertion required');
  const s = await fixture(t);
  const server = path.join(s.home, 'hanging-server.mjs');
  const pidFile = path.join(s.home, 'hanging-pids.json');
  await fsp.writeFile(server, [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));",
    "setInterval(() => {}, 1000);"
  ].join('\n'), { mode: 0o600 });
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.hanging]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(server)}, ${JSON.stringify(pidFile)}]`,
    'startup_timeout_sec = 1',
    ''
  ].join('\n'), { mode: 0o600 });

  const health = await testMcpConnection('hanging', 'global', { home: s.home });
  assert.equal(health.status, 'timeout');
  const pids = JSON.parse(await fsp.readFile(pidFile, 'utf8')) as { parent: number; child: number };
  t.after(() => {
    for (const pid of [pids.parent, pids.child]) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
  await Promise.all([pids.parent, pids.child].map((pid) => waitForProcessExit(pid, 5_000)));
  assert.equal(processExists(pids.parent), false);
  assert.equal(processExists(pids.child), false);
});

test('stdio startup failure returns a bounded public code', async (t) => {
  const s = await fixture(t);
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.missing]',
    `command = ${JSON.stringify(path.join(s.home, 'missing-mcp-executable'))}`,
    'startup_timeout_sec = 1',
    ''
  ].join('\n'), { mode: 0o600 });

  const health = await testMcpConnection('missing', 'global', { home: s.home });
  assert.equal(health.status, 'startup_failed');
  assert.equal(health.public_error, 'mcp_process_error');
  assert.doesNotMatch(JSON.stringify(health), /missing-mcp-executable/);
});

test('stdio tool-list timeout is bounded independently from startup', { timeout: 8_000 }, async (t) => {
  const s = await fixture(t);
  const server = path.join(s.home, 'tool-timeout-server.mjs');
  await fsp.writeFile(server, [
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'server/discover') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, error:{ code:-32601, message:'Method not found' } }));",
    "  if (msg.method === 'initialize') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:'2024-11-05' } }));",
    "});",
    "setInterval(() => {}, 1000);"
  ].join('\n'), { mode: 0o600 });
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.tool_timeout]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(server)}]`,
    'startup_timeout_sec = 2',
    'tool_timeout_sec = 1',
    ''
  ].join('\n'), { mode: 0o600 });

  const health = await testMcpConnection('tool_timeout', 'global', { home: s.home });
  assert.equal(health.status, 'timeout');
  assert.equal(health.public_error, 'mcp_handshake_timeout');
});

test('stdio stdout protocol pollution fails closed without echoing polluted output', async (t) => {
  const s = await fixture(t);
  const server = path.join(s.home, 'polluted-server.mjs');
  await fsp.writeFile(server, [
    "import readline from 'node:readline';",
    "const rl = readline.createInterface({ input: process.stdin });",
    "rl.on('line', (line) => {",
    "  const msg = JSON.parse(line);",
    "  if (msg.method === 'server/discover') console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, error:{ code:-32601, message:'Method not found' } }));",
    "  if (msg.method === 'initialize') {",
    "    console.log('polluted stdout detail must stay private');",
    "    console.log(JSON.stringify({ jsonrpc:'2.0', id:msg.id, result:{ protocolVersion:'2024-11-05' } }));",
    "  }",
    "});"
  ].join('\n'), { mode: 0o600 });
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.polluted]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(server)}]`,
    'startup_timeout_sec = 2',
    ''
  ].join('\n'), { mode: 0o600 });

  const health = await testMcpConnection('polluted', 'global', { home: s.home });
  assert.equal(health.status, 'protocol_error');
  assert.equal(health.public_error, 'mcp_protocol_pollution');
  assert.doesNotMatch(JSON.stringify(health), /polluted stdout detail/);
});

test('streamable HTTP health uses the 2026-07-28 stateless request and header contract', async (t) => {
  const s = await fixture(t);
  const observed: Array<{ method: string; headers: http.IncomingHttpHeaders; meta: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    const parsed = JSON.parse(await readRequest(request)) as {
      id: number;
      method: string;
      params?: { _meta?: Record<string, unknown>; cursor?: string };
    };
    observed.push({ method: parsed.method, headers: request.headers, meta: parsed.params?._meta || {} });
    const serverMeta = {
      [MCP_SERVER_INFO_META_KEY]: { name: 'modern-health-fixture', version: '1.0.0' }
    };
    const value = parsed.method === 'server/discover'
      ? {
          resultType: 'complete',
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: {} },
          ttlMs: 1_000,
          cacheScope: 'private',
          _meta: serverMeta
        }
      : parsed.params?.cursor === 'page-2'
        ? {
          resultType: 'complete',
          tools: [{ name: 'modern-tool-2' }],
          ttlMs: 1_000,
          cacheScope: 'private',
          _meta: serverMeta
        }
        : {
          resultType: 'complete',
          tools: [{ name: 'modern-tool' }],
          nextCursor: 'page-2',
          ttlMs: 1_000,
          cacheScope: 'private',
          _meta: serverMeta
        };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: value }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.modern]',
    `url = "http://127.0.0.1:${address.port}/mcp"`,
    ''
  ].join('\n'), { mode: 0o600 });

  const health = await testMcpConnection('modern', 'global', { home: s.home });
  assert.equal(health.status, 'healthy');
  assert.equal(health.protocol_version, MCP_PROTOCOL_VERSION);
  assert.deepEqual(health.tool_names, ['modern-tool', 'modern-tool-2']);
  assert.deepEqual(observed.map((entry) => entry.method), ['server/discover', 'tools/list', 'tools/list']);
  for (const entry of observed) {
    assert.equal(entry.headers['mcp-protocol-version'], MCP_PROTOCOL_VERSION);
    assert.equal(entry.headers['mcp-method'], entry.method);
    assert.equal(entry.headers['mcp-session-id'], undefined);
    assert.equal(entry.meta[MCP_PROTOCOL_VERSION_META_KEY], MCP_PROTOCOL_VERSION);
    assert.deepEqual(entry.meta[MCP_CLIENT_CAPABILITIES_META_KEY], {});
  }
});

test('streamable HTTP health negotiates modern first, falls back for a legacy server, and reports OAuth required', async (t) => {
  const s = await fixture(t);
  const sessionHeaders: string[] = [];
  const server = http.createServer(async (request, response) => {
    const body = await readRequest(request);
    if (request.url === '/auth') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'token-secret-must-not-leak' }));
      return;
    }
    const parsed = JSON.parse(body) as { method?: string; id?: number };
    if (parsed.method === 'server/discover') {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    if (parsed.method === 'initialize') {
      response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'session-1' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { protocolVersion: '2024-11-05' } }));
      return;
    }
    if (request.headers['mcp-session-id']) sessionHeaders.push(String(request.headers['mcp-session-id']));
    if (parsed.method === 'tools/list') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result: { tools: [{ name: 'one' }] } }));
      return;
    }
    response.writeHead(202); response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.http_health]', `url = "${base}/mcp"`, '',
    '[mcp_servers.http_auth]', `url = "${base}/auth"`, ''
  ].join('\n'), { mode: 0o600 });

  const healthy = await testMcpConnection('http_health', 'global', { home: s.home });
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.tool_count, 1);
  assert.deepEqual(healthy.tool_names, ['one']);
  assert.ok(sessionHeaders.includes('session-1'));
  const auth = await testMcpConnection('http_auth', 'global', { home: s.home });
  assert.equal(auth.status, 'oauth_required');
  assert.doesNotMatch(JSON.stringify(auth), /token-secret/);
});

test('health runner allows at most two concurrent handshakes', async (t) => {
  const s = await fixture(t);
  await fsp.writeFile(s.configPath, [
    '[mcp_servers.a]', 'url = "https://example.test/a"', '',
    '[mcp_servers.b]', 'url = "https://example.test/b"', '',
    '[mcp_servers.c]', 'url = "https://example.test/c"', ''
  ].join('\n'), { mode: 0o600 });
  let active = 0;
  let peak = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    const message = JSON.parse(String(init?.body || '{}')) as { method?: string; id?: number };
    const body = message.method === 'server/discover'
      ? { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }
      : message.method === 'initialize'
      ? { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05' } }
      : message.method === 'tools/list'
        ? { jsonrpc: '2.0', id: message.id, result: { tools: [] } }
        : null;
    return new Response(body ? JSON.stringify(body) : '', {
      status: message.method === 'server/discover' ? 400 : body ? 200 : 202,
      headers: { 'content-type': 'application/json' }
    });
  };
  const results = await Promise.all(['a', 'b', 'c'].map((name) => testMcpConnection(name, 'global', {
    home: s.home,
    dependencies: { fetchImpl }
  })));
  assert.ok(results.every((entry) => entry.status === 'healthy'));
  assert.equal(peak, 2);
});

test('OAuth login/logout use the exact scoped official CLI adapter', async (t) => {
  const s = await fixture(t);
  await fsp.writeFile(s.configPath, '[mcp_servers.remote]\nurl = "https://example.test/mcp"\n', { mode: 0o600 });
  const cli = new AuthCli();
  const login = await loginMcpServer('remote', 'global', { home: s.home, cli }, ['tools.read']);
  assert.equal(login.ok, true);
  assert.equal(login.authenticated, true);
  const logout = await logoutMcpServer('remote', 'global', { home: s.home, cli });
  assert.equal(logout.ok, true);
  assert.deepEqual(cli.calls, [
    { action: 'login', name: 'remote', scopes: ['tools.read'] },
    { action: 'logout', name: 'remote' }
  ]);
});

test('official Codex add argv uses URL/bearer/OAuth references and never raw env values', () => {
  assert.deepEqual(buildCodexMcpAddArgs({
    name: 'remote', transport: 'streamable-http', url: 'https://example.test/mcp',
    bearer_token_env_var: 'MCP_TOKEN', oauth_client_id: 'client', oauth_resource: 'resource'
  }), [
    'mcp', 'add', 'remote', '--url', 'https://example.test/mcp',
    '--bearer-token-env-var', 'MCP_TOKEN', '--oauth-client-id', 'client', '--oauth-resource', 'resource'
  ]);
  assert.deepEqual(buildCodexMcpAddArgs({ name: 'local', transport: 'stdio', command: 'node', args: ['server.js'], env_vars: ['MCP_TOKEN'] }), [
    'mcp', 'add', 'local', '--', 'node', 'server.js'
  ]);
  assert.equal(buildCodexMcpAddArgs({ name: 'dots.not.allowed', transport: 'stdio', command: 'node' }), null);
});

async function readRequest(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
