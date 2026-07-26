import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { nowIso } from '../fsx.js';
import { isRecord, privateEnvironment, rawServer, rawStringArray, readMcpConfigDocument } from './config-reader.js';
import { listMcpInventory, type McpInventoryOptions } from './inventory.js';
import { redactMcpError } from './redaction.js';
import { normalizeMcpServerName } from './secret-policy.js';
import { resolveMcpScope } from './scope.js';
import { MCP_HEALTH_SCHEMA, type McpHealthResultV1, type McpScope, type McpWritableScope } from './types.js';
import { PACKAGE_VERSION } from '../version.js';

const PROTOCOL_VERSION = '2024-11-05';
const OUTPUT_CAP = 64 * 1024;
let activeHealthChecks = 0;
const healthQueue: Array<() => void> = [];

interface HealthDependencies {
  readonly spawnProcess?: (command: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly checkedAt?: () => string;
}

export interface McpHealthOptions extends McpInventoryOptions {
  readonly dependencies?: HealthDependencies;
}

export async function testMcpConnection(nameInput: unknown, scope: McpScope, options: McpHealthOptions = {}): Promise<McpHealthResultV1> {
  return withHealthSlot(() => testMcpConnectionInternal(nameInput, scope, options));
}

async function testMcpConnectionInternal(nameInput: unknown, scope: McpScope, options: McpHealthOptions): Promise<McpHealthResultV1> {
  const name = normalizeMcpServerName(nameInput);
  if (!name) return result(String(nameInput || ''), scope, 'unknown', null, null, null, null, 'invalid_mcp_server_name', options);
  if (scope === 'effective') {
    const effective = await listMcpInventory('effective', options);
    const server = effective.servers.find((entry) => entry.name === name);
    if (!server) return result(name, scope, 'unknown', null, null, null, null, 'mcp_server_not_found', options);
    if (server.scope === 'plugin') return result(name, scope, 'unknown', null, null, null, null, 'plugin_health_requires_host_adapter', options);
    return testMcpConnectionInternal(name, server.scope, options);
  }

  try {
    const ref = await resolveMcpScope(scope, options);
    const document = await readMcpConfigDocument(ref);
    const raw = rawServer(document, name);
    if (!raw) return result(name, scope, 'unknown', null, null, null, null, 'mcp_server_not_found', options);
    if (raw.enabled === false || raw.disabled === true) return result(name, scope, 'disabled', null, null, null, 0, null, options);
    const started = (options.dependencies?.now ?? Date.now)();
    const measured = typeof raw.url === 'string'
      ? await probeHttp(name, scope, raw, options)
      : await probeStdio(name, scope, raw, options);
    const ended = (options.dependencies?.now ?? Date.now)();
    return { ...measured, latency_ms: Math.max(0, ended - started) };
  } catch (error) {
    return result(name, scope, 'unknown', null, null, null, null, redactMcpError(error), options);
  }
}

async function withHealthSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeHealthChecks >= 2) await new Promise<void>((resolve) => healthQueue.push(resolve));
  activeHealthChecks += 1;
  try {
    return await run();
  } finally {
    activeHealthChecks -= 1;
    healthQueue.shift()?.();
  }
}

async function probeStdio(
  name: string,
  scope: McpWritableScope,
  raw: Record<string, unknown>,
  options: McpHealthOptions
): Promise<McpHealthResultV1> {
  const command = typeof raw.command === 'string' ? raw.command : '';
  if (!command) return result(name, scope, 'startup_failed', null, null, null, null, 'mcp_stdio_command_missing', options);
  const args = rawStringArray(raw.args);
  const cwd = typeof raw.cwd === 'string' && path.isAbsolute(raw.cwd) ? raw.cwd : undefined;
  const env = { ...process.env, ...privateEnvironment(raw) };
  const spawnProcess = options.dependencies?.spawnProcess ?? defaultSpawn;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawnProcess(command, args, { ...(cwd ? { cwd } : {}), env });
  } catch (error) {
    return result(name, scope, 'startup_failed', null, null, null, null, redactMcpError(error), options);
  }
  const channel = new JsonLineChannel(child);
  try {
    channel.send(initializeRequest());
    const init = await channel.wait(1, timeoutMs(raw.startup_timeout_sec, 10));
    if (!isRecord(init) || !isRecord(init.result)) return result(name, scope, 'protocol_error', null, null, null, null, 'mcp_initialize_invalid', options);
    const protocol = typeof init.result.protocolVersion === 'string' ? init.result.protocolVersion : null;
    const instructions = typeof init.result.instructions === 'string';
    channel.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    channel.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tools = await channel.wait(2, timeoutMs(raw.tool_timeout_sec, 30));
    const list = isRecord(tools) && isRecord(tools.result) && Array.isArray(tools.result.tools) ? tools.result.tools : null;
    if (!list) return result(name, scope, 'protocol_error', protocol, null, instructions, null, 'mcp_tools_list_invalid', options);
    return result(name, scope, 'healthy', protocol, list.length, instructions, null, null, options, toolNames(list));
  } catch (error) {
    const message = redactMcpError(error);
    return result(
      name,
      scope,
      message.includes('timeout')
        ? 'timeout'
        : message.includes('output_cap') || message.includes('protocol')
          ? 'protocol_error'
          : 'startup_failed',
      null,
      null,
      null,
      null,
      message,
      options
    );
  } finally {
    channel.close();
  }
}

async function probeHttp(
  name: string,
  scope: McpWritableScope,
  raw: Record<string, unknown>,
  options: McpHealthOptions
): Promise<McpHealthResultV1> {
  const url = String(raw.url || '');
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
      return result(name, scope, 'protocol_error', null, null, null, null, 'mcp_http_url_unsafe', options);
    }
  } catch {
    return result(name, scope, 'protocol_error', null, null, null, null, 'mcp_http_url_invalid', options);
  }
  const fetchImpl = options.dependencies?.fetchImpl ?? fetch;
  const envName = typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : null;
  const bearer = envName ? process.env[envName] : undefined;
  try {
    const init = await postRpc(fetchImpl, url, initializeRequest(), timeoutMs(raw.startup_timeout_sec, 10), bearer);
    if (init.status === 401 || init.status === 403) return result(name, scope, 'oauth_required', null, null, null, null, null, options);
    if (!init.ok || !isRecord(init.json) || !isRecord(init.json.result)) {
      return result(name, scope, 'protocol_error', null, null, null, null, `mcp_http_initialize_${init.status}`, options);
    }
    const protocol = typeof init.json.result.protocolVersion === 'string' ? init.json.result.protocolVersion : null;
    const instructions = typeof init.json.result.instructions === 'string';
    await postRpc(fetchImpl, url, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, timeoutMs(raw.tool_timeout_sec, 30), bearer, init.sessionId);
    const tools = await postRpc(fetchImpl, url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, timeoutMs(raw.tool_timeout_sec, 30), bearer, init.sessionId);
    if (tools.status === 401 || tools.status === 403) return result(name, scope, 'oauth_required', protocol, null, instructions, null, null, options);
    const list = tools.ok && isRecord(tools.json) && isRecord(tools.json.result) && Array.isArray(tools.json.result.tools)
      ? tools.json.result.tools : null;
    if (!list) return result(name, scope, 'protocol_error', protocol, null, instructions, null, `mcp_http_tools_${tools.status}`, options);
    return result(name, scope, 'healthy', protocol, list.length, instructions, null, null, options, toolNames(list));
  } catch (error) {
    const message = redactMcpError(error);
    return result(name, scope, message.includes('AbortError') || message.includes('timeout') ? 'timeout' : 'startup_failed', null, null, null, null, message, options);
  }
}

class JsonLineChannel {
  private buffer = '';
  private bytes = 0;
  private readonly responses = new Map<number, unknown>();
  private readonly waiters = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private closed = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer | string) => this.feed(chunk));
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.bytes += Buffer.byteLength(chunk);
      if (this.bytes > OUTPUT_CAP) this.failAll(new Error('mcp_output_cap_exceeded'));
    });
    child.once('error', () => this.failAll(new Error('mcp_process_error')));
    child.once('close', () => this.failAll(new Error('mcp_process_closed')));
  }

  send(value: unknown): void {
    if (this.closed || !this.child.stdin.writable) throw new Error('mcp_process_not_writable');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  wait(id: number, timeout: number): Promise<unknown> {
    if (this.responses.has(id)) {
      const value = this.responses.get(id);
      this.responses.delete(id);
      return Promise.resolve(value);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        reject(new Error('mcp_handshake_timeout'));
      }, timeout);
      timer.unref?.();
      this.waiters.set(id, { resolve, reject, timer });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error('mcp_probe_closed'));
    this.child.stdin.end();
    if (this.child.pid && process.platform !== 'win32') {
      try { process.kill(-this.child.pid, 'SIGTERM'); } catch { this.child.kill('SIGTERM'); }
    } else {
      this.child.kill('SIGTERM');
    }
  }

  private feed(chunk: Buffer | string): void {
    this.bytes += Buffer.byteLength(chunk);
    if (this.bytes > OUTPUT_CAP) { this.failAll(new Error('mcp_output_cap_exceeded')); return; }
    this.buffer += String(chunk);
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.failAll(new Error('mcp_protocol_pollution'));
        return;
      }
      if (!isRecord(parsed) || !Number.isInteger(parsed.id)) continue;
      const id = Number(parsed.id);
      const waiter = this.waiters.get(id);
      if (waiter) {
        clearTimeout(waiter.timer); this.waiters.delete(id); waiter.resolve(parsed);
      } else this.responses.set(id, parsed);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    this.waiters.clear();
  }
}

async function postRpc(
  fetchImpl: typeof fetch,
  url: string,
  message: unknown,
  timeout: number,
  bearer?: string,
  sessionId?: string | null
): Promise<{ ok: boolean; status: number; json: unknown; sessionId: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('mcp_http_timeout')), timeout);
  timer.unref?.();
  try {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json'
    };
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(message), signal: controller.signal });
    const text = await boundedResponseText(response);
    return {
      ok: response.ok,
      status: response.status,
      json: parseHttpPayload(text),
      sessionId: response.headers.get('mcp-session-id')
    };
  } finally {
    clearTimeout(timer);
  }
}

async function boundedResponseText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > OUTPUT_CAP) { await reader.cancel(); throw new Error('mcp_output_cap_exceeded'); }
    chunks.push(part.value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(merged);
}

function parseHttpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('data:')) {
    const data = trimmed.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).find(Boolean);
    return data ? JSON.parse(data) : null;
  }
  return JSON.parse(trimmed);
}

function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'sks-mcp-health', version: PACKAGE_VERSION } }
  };
}

function timeoutMs(value: unknown, fallback: number): number {
  const seconds = Number(value);
  return Math.round(Math.min(30, Math.max(1, Number.isFinite(seconds) ? seconds : fallback)) * 1000);
}

function result(
  server: string,
  scope: McpScope,
  status: McpHealthResultV1['status'],
  protocol: string | null,
  toolCount: number | null,
  instructions: boolean | null,
  latency: number | null,
  error: string | null,
  options: McpHealthOptions,
  toolNames: string[] | null = null
): McpHealthResultV1 {
  return {
    schema: MCP_HEALTH_SCHEMA, server, scope, status, protocol_version: protocol, tool_count: toolCount,
    tool_names: toolNames,
    instructions_present: instructions, latency_ms: latency,
    checked_at: options.dependencies?.checkedAt?.() ?? nowIso(),
    public_error: error, log_ref: null
  };
}

function toolNames(list: unknown[]): string[] {
  return [...new Set(list
    .map((entry) => isRecord(entry) && typeof entry.name === 'string' ? entry.name.trim() : '')
    .filter(Boolean))]
    .sort();
}

function defaultSpawn(command: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv }): ChildProcessWithoutNullStreams {
  return spawn(command, [...args], {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    shell: false
  });
}
