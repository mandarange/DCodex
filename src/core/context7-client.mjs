import { spawn } from 'node:child_process';

const DEFAULT_CONTEXT7_COMMAND = 'npx';
const DEFAULT_CONTEXT7_ARGS = ['-y', '@upstash/context7-mcp@latest'];
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

export function defaultContext7ServerConfig() {
  const command = process.env.SKS_CONTEXT7_MCP_COMMAND || DEFAULT_CONTEXT7_COMMAND;
  const args = process.env.SKS_CONTEXT7_MCP_ARGS
    ? splitShellWords(process.env.SKS_CONTEXT7_MCP_ARGS)
    : DEFAULT_CONTEXT7_ARGS;
  return { command, args };
}

export async function context7Tools(opts = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    const initialize = await client.initialize();
    const tools = await client.listTools();
    return {
      ok: true,
      initialize,
      tools,
      tool_names: tools.map((tool) => tool.name),
      server: client.serverInfo()
    };
  } finally {
    await client.close();
  }
}

export async function context7Resolve(libraryName, opts = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    await client.initialize();
    const result = await client.callTool('resolve-library-id', {
      libraryName,
      query: opts.query || libraryName
    });
    return {
      ok: !result.isError,
      tool: 'resolve-library-id',
      library_name: libraryName,
      library_id: extractContext7LibraryId(result),
      result,
      server: client.serverInfo()
    };
  } finally {
    await client.close();
  }
}

export async function context7Docs(libraryNameOrId, opts = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    await client.initialize();
    const tools = await client.listTools();
    const toolNames = tools.map((tool) => tool.name);
    const docsTool = pickDocsTool(toolNames);
    if (!docsTool) {
      return {
        ok: false,
        error: 'Context7 docs tool missing. Expected query-docs or get-library-docs.',
        tool_names: toolNames,
        server: client.serverInfo()
      };
    }

    const explicitLibraryId = isContext7LibraryId(libraryNameOrId);
    let resolve = null;
    let libraryId = explicitLibraryId ? libraryNameOrId : null;
    if (!libraryId) {
      resolve = await client.callTool('resolve-library-id', {
        libraryName: libraryNameOrId,
        query: opts.query || opts.topic || libraryNameOrId
      });
      libraryId = opts.libraryId || extractContext7LibraryId(resolve);
    }

    if (!libraryId) {
      return {
        ok: false,
        error: 'Context7 could not resolve a library ID.',
        resolve,
        tool_names: toolNames,
        server: client.serverInfo()
      };
    }

    const docsArgs = docsTool === 'query-docs'
      ? {
          libraryId,
          query: opts.query || opts.topic || libraryNameOrId,
          ...(opts.tokens ? { tokens: opts.tokens } : {})
        }
      : {
          context7CompatibleLibraryID: libraryId,
          topic: opts.topic || opts.query || libraryNameOrId,
          ...(opts.tokens ? { tokens: opts.tokens } : {})
        };
    const docs = await client.callTool(docsTool, docsArgs);
    return {
      ok: !docs.isError,
      library_name: explicitLibraryId ? null : libraryNameOrId,
      library_id: libraryId,
      resolve_tool: explicitLibraryId ? null : 'resolve-library-id',
      docs_tool: docsTool,
      resolve,
      docs,
      tool_names: toolNames,
      server: client.serverInfo()
    };
  } finally {
    await client.close();
  }
}

export function extractContext7LibraryId(result) {
  const text = context7Text(result);
  const direct = text.match(/Context7-compatible library ID:\s*(\/[^\s]+)/i);
  if (direct) return direct[1].trim();
  const selected = text.match(/(?:Selected|Library ID)\s*:?\s*(\/[A-Za-z0-9._~/-]+)/i);
  if (selected) return selected[1].trim();
  const any = text.match(/\/[A-Za-z0-9._~/-]+/);
  return any ? any[0].trim() : null;
}

export function context7Text(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item) => (item && item.type === 'text' ? String(item.text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

export function isContext7DocsTool(name) {
  return name === 'query-docs' || name === 'get-library-docs';
}

function pickDocsTool(toolNames) {
  if (toolNames.includes('query-docs')) return 'query-docs';
  if (toolNames.includes('get-library-docs')) return 'get-library-docs';
  return null;
}

function isContext7LibraryId(value) {
  return /^\/[A-Za-z0-9._~/-]+$/.test(String(value || '').trim());
}

function resolveContext7Config(opts) {
  if (opts.command) return { command: opts.command, args: opts.args || [] };
  return defaultContext7ServerConfig();
}

class LocalMcpClient {
  constructor(config, opts = {}) {
    this.config = config;
    this.timeoutMs = Number(opts.timeoutMs || process.env.SKS_CONTEXT7_TIMEOUT_MS || 30000);
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderr = '';
    this.initializeResult = null;
  }

  serverInfo() {
    return {
      command: this.config.command,
      args: this.config.args,
      stderr: this.stderr.trim(),
      info: this.initializeResult?.serverInfo || null
    };
  }

  async initialize() {
    this.start();
    const result = await this.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sneakoscope-context7', version: '1.0.0' }
    });
    this.initializeResult = result;
    this.notify('notifications/initialized', {});
    return result;
  }

  async listTools() {
    const result = await this.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    return result;
  }

  start() {
    if (this.child) return;
    this.child = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: process.env
    });
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-64 * 1024);
    });
    this.child.on('error', (err) => this.rejectAll(err));
    this.child.on('close', (code) => {
      this.rejectAll(new Error(`Context7 MCP exited before response (code ${code ?? 'signal'}). ${this.stderr.trim()}`.trim()));
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (!message.id || !this.pending.has(message.id)) continue;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    this.start();
    const id = this.nextId++;
    const message = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Context7 MCP request timed out: ${method}. ${this.stderr.trim()}`.trim()));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    this.start();
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  rejectAll(err) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }

  async close() {
    if (!this.child) return;
    const child = this.child;
    this.child = null;
    try { child.stdin.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}
  }
}

function splitShellWords(value) {
  return String(value || '')
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part) => part.replace(/^["']|["']$/g, '')) || [];
}
