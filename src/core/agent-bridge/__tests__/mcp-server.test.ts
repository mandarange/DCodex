import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { Client, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { invokeSksTool, runMcpServer } from '../mcp-server.js';
import { buildAgentManifest } from '../agent-manifest.js';
import {
  hostCapabilityCodexConfigArgs,
  inspectHostCapabilityRuntime,
  requestHostCapabilities
} from '../host-capability-runtime.js';
import { commandContract, validateJsonSchema } from '../../safety/command-contract/index.js';
import { runProcess } from '../../fsx.js';
import { resolveOfficialCodexPackageRuntime } from '../../codex-runtime/resolve-codex-runtime.js';
import { hostCapabilityProjectCodexConfigArgs } from '../../subagents/official-subagent-runner.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_INFO_META_KEY,
  modernMcpRequest
} from '../../mcp/modern-protocol.js';

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string; data?: any };
}

class InMemoryMcpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private buffer = '';

  constructor(
    private readonly input: PassThrough,
    private readonly output: PassThrough
  ) {}

  async start(): Promise<void> {
    this.output.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (;;) {
        const newline = this.buffer.indexOf('\n');
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.onmessage?.(JSON.parse(line) as JSONRPCMessage);
      }
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.input.write(`${JSON.stringify(message)}\n`);
  }

  async close(): Promise<void> {
    this.input.end();
  }
}

function makeHarness() {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const responses: JsonRpcResponse[] = [];
  let buffer = '';
  serverToClient.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) responses.push(JSON.parse(line));
    }
  });
  return { clientToServer, serverToClient, responses };
}

function send(stream: PassThrough, message: Record<string, unknown>): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function mcpRequest(id: number, method: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return modernMcpRequest(id, method, params, {
    clientInfo: { name: 'sks-mcp-test-client', version: '0.0.1' }
  });
}

function nativeHostCapabilityDependencies(toolNames: string[]) {
  return {
    inventory: async () => ({
      schema: 'sks.mcp-inventory.v2',
      ok: true,
      scope: 'project',
      source: 'fixture_inventory',
      servers: [{
        name: 'acas-tools',
        enabled: true,
        enabled_tools: [...toolNames],
        disabled_tools: []
      }],
      server_count: 1,
      enabled_count: 1,
      failed_count: 0,
      blockers: [],
      warnings: []
    }) as any,
    health: async () => ({
      schema: 'sks.mcp-health.v1',
      ok: true,
      name: 'acas-tools',
      scope: 'project',
      status: 'healthy',
      tool_names: [...toolNames]
    }) as any
  };
}

async function waitForResponseId(responses: JsonRpcResponse[], id: number, timeoutMs = 20_000): Promise<JsonRpcResponse> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const found = responses.find((r) => r.id === id);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for JSON-RPC response id ${id}`);
}

test('runMcpServer responds to server/discover with modern protocol/server info', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });

  send(clientToServer, mcpRequest(1, 'server/discover'));

  const response = await waitForResponseId(responses, 1);
  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.id, 1);
  assert.ok(response.result, 'server/discover response missing result');
  assert.equal(response.result.resultType, 'complete');
  assert.deepEqual(response.result.supportedVersions, [MCP_PROTOCOL_VERSION]);
  assert.equal(response.result._meta?.[MCP_SERVER_INFO_META_KEY]?.name, 'sks-mcp-server');
  assert.equal(typeof response.result._meta?.[MCP_SERVER_INFO_META_KEY]?.version, 'string');
  assert.ok(response.result.capabilities, 'server/discover response missing capabilities');
  assert.ok('tools' in response.result.capabilities, 'server/discover capabilities missing tools key');
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, 'private');
});

test('official MCP v2 client negotiates the 2026-07-28 era with runMcpServer', async () => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  await runMcpServer({ input: clientToServer, output: serverToClient });
  const client = new Client(
    { name: 'sks-sdk-negotiation-test', version: '0.0.1' },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000, maxRetries: 0 } } }
  );

  try {
    await client.connect(new InMemoryMcpTransport(clientToServer, serverToClient), { timeout: 2_000 });
    assert.equal(client.getProtocolEra(), 'modern');
    assert.equal(client.getNegotiatedProtocolVersion(), MCP_PROTOCOL_VERSION);
    assert.equal(client.getServerVersion()?.name, 'sks-mcp-server');
    assert.ok(client.getServerCapabilities()?.tools);

    const result = await client.listTools({}, { timeout: 2_000, cacheMode: 'refresh' });
    assert.ok(result.tools.some((tool) => tool.name === 'status'));
  } finally {
    await client.close();
  }
});

test('runMcpServer rejects legacy initialize because the SKS-owned server is modern-only', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });
  send(clientToServer, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'c', version: '0' } }
  });
  const response = await waitForResponseId(responses, 1);
  assert.equal(response.error?.code, -32022);
  assert.deepEqual(response.error?.data, {
    supported: [MCP_PROTOCOL_VERSION],
    requested: '2024-11-05'
  });
});

test('runMcpServer tools/list returns only read-only manifest tools by default', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });

  send(clientToServer, mcpRequest(1, 'server/discover'));
  await waitForResponseId(responses, 1);

  send(clientToServer, mcpRequest(2, 'tools/list'));
  const response = await waitForResponseId(responses, 2);

  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result, 'tools/list response missing result');
  assert.ok(Array.isArray(response.result.tools), 'tools/list result.tools must be an array');
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.ttlMs, 0);
  assert.equal(response.result.cacheScope, 'private');
  assert.ok(response.result.tools.length > 0, 'tools/list returned no tools');

  const manifest = buildAgentManifest();
  const readOnlyNames = new Set(manifest.tools.filter((t) => t.read_only).map((t) => t.name));
  const nonReadOnlyNames = new Set(manifest.tools.filter((t) => !t.read_only).map((t) => t.name));
  assert.ok(nonReadOnlyNames.size > 0, 'fixture assumption invalid: no non-read-only commands in manifest');

  const listedNames = response.result.tools.map((t: any) => t.name);
  for (const name of listedNames) {
    assert.ok(readOnlyNames.has(name), `tools/list exposed non-read-only tool ${name} without --expose-exec`);
    const descriptor = response.result.tools.find((entry: any) => entry.name === name);
    assert.equal(descriptor.inputSchema.type, 'object');
    assert.equal(descriptor.inputSchema.additionalProperties, false);
  }
  assert.ok(listedNames.includes('status'), 'tools/list missing expected read-only tool "status"');
  for (const name of nonReadOnlyNames) {
    assert.ok(!listedNames.includes(name), `tools/list must not expose non-read-only tool ${name} by default`);
  }
});

test('invokeSksTool validates input, applies argv, and uses latency bounds', async () => {
  const contract = commandContract('stop-gate');
  assert.ok(contract);
  let observedArgs: readonly string[] = [];
  let observedOptions: any = null;
  const result = await invokeSksTool(contract, { route: 'Naruto', json: true }, async (_command, args, options) => {
    observedArgs = args;
    observedOptions = options;
    return { code: 0, stdout: '{}', stderr: '', stdoutBytes: 2, stderrBytes: 0, truncated: false, timedOut: false };
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.argv, ['stop-gate', 'check', '--route', 'Naruto', '--json']);
  assert.ok(observedArgs.includes('stop-gate'));
  assert.equal(observedOptions.timeoutMs, 15_000);
  assert.equal(observedOptions.maxOutputBytes, 128 * 1024);
});

test('invokeSksTool rejects invalid arguments before spawning', async () => {
  const contract = commandContract('status');
  assert.ok(contract);
  let spawned = false;
  await assert.rejects(
    invokeSksTool(contract, { argv: ['--unsafe'] }, async () => {
      spawned = true;
      throw new Error('must not run');
    }),
    /INVALID_ARGUMENTS|Invalid arguments/
  );
  assert.equal(spawned, false);
});

test('Naruto unknown input is rejected before spawn even though execution is local-only', async () => {
  const contract = commandContract('naruto');
  assert.ok(contract);
  let spawned = false;
  await assert.rejects(
    invokeSksTool(contract, { action: 'run', task: 'x', model: 'unsupported' }, async () => {
      spawned = true;
      throw new Error('must not run');
    }),
    /Invalid arguments for naruto/
  );
  assert.equal(spawned, false);
});

test('Naruto machine contract carries the explicit project-trust opt-in', () => {
  const contract = commandContract('naruto');
  assert.ok(contract);
  const validated = validateJsonSchema({
    action: 'run',
    task: 'create an XLSX report',
    trusted_project: true,
    json: true
  }, contract.input_schema);
  assert.equal(validated.ok, true);
  if (validated.ok) {
    assert.deepEqual(contract.argv_builder(validated.value), [
      'naruto', 'run', 'create an XLSX report', '--trusted-project', '--json'
    ]);
  }
});

test('standalone project trust is invocation-only and no-trust preserves any global ACAS transport', () => {
  assert.deepEqual(hostCapabilityProjectCodexConfigArgs({
    canonicalRoot: '/tmp/project root',
    projectTrusted: true
  }), ['-c', 'projects={"/tmp/project root"={trust_level="trusted"}}']);
  assert.deepEqual(hostCapabilityProjectCodexConfigArgs({
    canonicalRoot: '/tmp/project root',
    projectTrusted: false
  }), ['-c', 'projects={"/tmp/project root"={trust_level="untrusted"}}']);
  assert.deepEqual(hostCapabilityProjectCodexConfigArgs({
    canonicalRoot: '/tmp/project root',
    projectTrusted: false,
    globalHostCapabilityConfigured: true
  }), [
    '-c', 'projects={"/tmp/project root"={trust_level="untrusted"}}',
    '-c', 'mcp_servers.acas-tools.enabled=false'
  ]);
});

test('native Codex accepts project trust, the narrow ACAS allowlist, and transport-preserving no-trust', { timeout: 20_000 }, async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-native-project-trust-'));
  const project = path.join(root, 'project');
  const home = path.join(root, 'home');
  const codexHome = path.join(home, '.codex');
  t.after(async () => fsp.rm(root, { recursive: true, force: true }));
  await Promise.all([
    fsp.mkdir(path.join(project, '.codex'), { recursive: true }),
    fsp.mkdir(codexHome, { recursive: true })
  ]);
  const gitInit = await runProcess('git', ['init', '--quiet'], {
    cwd: project,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024
  });
  assert.equal(gitInit.code, 0, gitInit.stderr);
  const projectMcpCommand = path.join(project, 'trusted-project-mcp-sentinel');
  await fsp.writeFile(path.join(project, '.codex', 'config.toml'), [
    '[mcp_servers."acas-tools"]',
    `command = ${JSON.stringify(projectMcpCommand)}`,
    'args = ["--version"]',
    'enabled = true',
    'enabled_tools = ["spreadsheet_create", "spreadsheet_inspect", "spreadsheet_update", "slack_send"]',
    ''
  ].join('\n'));
  const runtime = await resolveOfficialCodexPackageRuntime({ requestedBy: 'native-project-trust-test' });
  assert.equal(runtime.ok, true);
  assert.ok(runtime.identity);
  const canonicalRoot = await fsp.realpath(project);
  const baseEnv = {
    HOME: home,
    USER: process.env.USER || 'codex-test',
    LOGNAME: process.env.LOGNAME || process.env.USER || 'codex-test',
    PATH: process.env.PATH || '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR || os.tmpdir(),
    CODEX_HOME: codexHome
  };
  const trustedRuntime = await inspectHostCapabilityRuntime({
    root: project,
    request: requestHostCapabilities('Create and deliver an Excel workbook.'),
    projectTrusted: true,
    dependencies: nativeHostCapabilityDependencies([
      'spreadsheet_create',
      'spreadsheet_inspect',
      'spreadsheet_update',
      'slack_send'
    ])
  });
  assert.equal(trustedRuntime.ok, true);
  const trusted = await runProcess(runtime.identity!.realpath, [
    '-C', canonicalRoot,
    ...hostCapabilityProjectCodexConfigArgs({ canonicalRoot, projectTrusted: true }),
    ...hostCapabilityCodexConfigArgs(trustedRuntime),
    'mcp', 'get', 'acas-tools', '--json'
  ], {
    cwd: project,
    env: baseEnv,
    envMode: 'replace',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  assert.equal(trusted.code, 0, trusted.stderr);
  const trustedRow = JSON.parse(trusted.stdout);
  assert.equal(trustedRow.name, 'acas-tools');
  assert.equal(trustedRow.enabled, true);
  assert.equal(trustedRow.transport?.command, projectMcpCommand);
  assert.deepEqual(trustedRow.enabled_tools, [
    'spreadsheet_create',
    'spreadsheet_inspect',
    'spreadsheet_update'
  ]);
  assert.deepEqual(trustedRow.disabled_tools, ['slack_send']);

  const untrustedProjectOnly = await runProcess(runtime.identity!.realpath, [
    '-C', canonicalRoot,
    ...hostCapabilityProjectCodexConfigArgs({ canonicalRoot, projectTrusted: false }),
    'mcp', 'list', '--json'
  ], {
    cwd: project,
    env: baseEnv,
    envMode: 'replace',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  assert.equal(untrustedProjectOnly.code, 0, untrustedProjectOnly.stderr);
  assert.deepEqual(JSON.parse(untrustedProjectOnly.stdout), []);

  const globalUrl = 'https://acas.example.invalid/mcp';
  await fsp.writeFile(path.join(codexHome, 'config.toml'), [
    '[mcp_servers."acas-tools"]',
    `url = ${JSON.stringify(globalUrl)}`,
    'enabled = true',
    ''
  ].join('\n'));
  const untrustedGlobal = await runProcess(runtime.identity!.realpath, [
    '-C', canonicalRoot,
    ...hostCapabilityProjectCodexConfigArgs({
      canonicalRoot,
      projectTrusted: false,
      globalHostCapabilityConfigured: true
    }),
    'mcp', 'get', 'acas-tools', '--json'
  ], {
    cwd: project,
    env: baseEnv,
    envMode: 'replace',
    timeoutMs: 10_000,
    maxOutputBytes: 64 * 1024
  });
  assert.equal(untrustedGlobal.code, 0, untrustedGlobal.stderr);
  const untrustedGlobalRow = JSON.parse(untrustedGlobal.stdout);
  assert.equal(untrustedGlobalRow.name, 'acas-tools');
  assert.equal(untrustedGlobalRow.enabled, false);
  assert.equal(untrustedGlobalRow.transport?.url, globalUrl);
});

test('runMcpServer tools/call on a safe read-only tool spawns sks and returns its stdout', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });

  send(clientToServer, mcpRequest(1, 'server/discover'));
  await waitForResponseId(responses, 1);

  send(clientToServer, mcpRequest(2, 'tools/call', { name: 'status', arguments: {} }));
  const response = await waitForResponseId(responses, 2, 60_000);

  assert.equal(response.jsonrpc, '2.0');
  assert.ok(response.result, 'tools/call response missing result');
  assert.ok(Array.isArray(response.result.content), 'tools/call result.content must be an array');
  assert.ok(response.result.content.length > 0, 'tools/call returned no content blocks');
  assert.equal(response.result.content[0].type, 'text');
  assert.equal(typeof response.result.content[0].text, 'string');
  assert.equal(response.result.isError, false);
  assert.equal(response.result.resultType, 'complete');
});

test('runMcpServer tools/call rejects a tool name absent from the manifest with Invalid Params', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });

  send(clientToServer, mcpRequest(1, 'server/discover'));
  await waitForResponseId(responses, 1);

  const bogusName = 'definitely_not_a_real_sks_command_xyz';
  const manifest = buildAgentManifest();
  assert.ok(!manifest.tools.some((t) => t.name === bogusName), 'fixture assumption invalid: bogus tool name collides with a real command');

  send(clientToServer, mcpRequest(2, 'tools/call', { name: bogusName, arguments: {} }));
  const response = await waitForResponseId(responses, 2);

  assert.equal(response.jsonrpc, '2.0');
  assert.equal(response.error?.code, -32602);
  assert.match(response.error?.message || '', /Tool .* not found/);
});

test('runMcpServer tools/call rejects a non-read-only tool when --expose-exec is not set', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({ input: clientToServer, output: serverToClient });

  const manifest = buildAgentManifest();
  const nonReadOnly = manifest.tools.find((t) => !t.read_only);
  assert.ok(nonReadOnly, 'fixture assumption invalid: no non-read-only commands in manifest');

  send(clientToServer, mcpRequest(1, 'server/discover'));
  await waitForResponseId(responses, 1);

  send(clientToServer, mcpRequest(2, 'tools/call', { name: nonReadOnly!.name, arguments: {} }));
  const response = await waitForResponseId(responses, 2);

  assert.equal(response.error?.code, -32602);
  assert.match(response.error?.message || '', /Tool .* not found/);
});

test('runMcpServer bounds concurrent tool execution and rejects calls when its queue is full', async () => {
  const { clientToServer, serverToClient, responses } = makeHarness();
  await runMcpServer({
    input: clientToServer,
    output: serverToClient,
    maxConcurrentTools: 1,
    maxQueuedTools: 0
  });

  send(clientToServer, mcpRequest(1, 'server/discover'));
  await waitForResponseId(responses, 1);

  send(clientToServer, mcpRequest(2, 'tools/call', { name: 'status', arguments: {} }));
  send(clientToServer, mcpRequest(3, 'tools/call', { name: 'status', arguments: {} }));
  const first = await waitForResponseId(responses, 2, 60_000);
  const second = await waitForResponseId(responses, 3, 60_000);
  const results = [first.result, second.result];

  assert.equal(results.filter((result) => result?.isError === false).length, 1);
  const busy = results.find((result) => result?.structuredContent?.code === 'SERVER_BUSY');
  assert.ok(busy, 'one concurrent request should be rejected when no queue capacity is configured');
  assert.equal(busy.isError, true);
});
