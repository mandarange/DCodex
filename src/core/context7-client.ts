import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { PACKAGE_VERSION } from './version.js';
import { collectMcpListPages } from './mcp/modern-protocol.js';

const DEFAULT_CONTEXT7_COMMAND = 'npx';
const DEFAULT_CONTEXT7_ARGS = ['-y', '@upstash/context7-mcp@latest'];

export function defaultContext7ServerConfig() {
  const command = process.env.SKS_CONTEXT7_MCP_COMMAND || DEFAULT_CONTEXT7_COMMAND;
  const args = process.env.SKS_CONTEXT7_MCP_ARGS
    ? splitShellWords(process.env.SKS_CONTEXT7_MCP_ARGS)
    : DEFAULT_CONTEXT7_ARGS;
  return { command, args };
}

export async function context7Tools(opts: any = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    const connection = await client.connect();
    const tools = await client.listTools();
    return {
      ok: true,
      connection,
      tools,
      tool_names: tools.map((tool: any) => tool.name),
      server: client.serverInfo()
    };
  } finally {
    await client.close();
  }
}

export async function context7Resolve(libraryName: any, opts: any = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    await client.connect();
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

export async function context7Docs(libraryNameOrId: any, opts: any = {}) {
  const client = new LocalMcpClient(resolveContext7Config(opts), opts);
  try {
    await client.connect();
    const tools = await client.listTools();
    const toolNames = tools.map((tool: any) => tool.name);
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

export function extractContext7LibraryId(result: any) {
  const text = context7Text(result);
  const direct = text.match(/Context7-compatible library ID:\s*(\/[^\s]+)/i);
  if (direct?.[1]) return direct[1].trim();
  const selected = text.match(/(?:Selected|Library ID)\s*:?\s*(\/[A-Za-z0-9._~/-]+)/i);
  if (selected?.[1]) return selected[1].trim();
  const match = text.match(/\/[A-Za-z0-9._~/-]+/);
  return match?.[0] ? match[0].trim() : null;
}

export function context7Text(result: any) {
  const content = result?.content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item: any) => (item && item.type === 'text' ? String(item.text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

export function isContext7DocsTool(name: any) {
  return name === 'query-docs' || name === 'get-library-docs';
}

function pickDocsTool(toolNames: any) {
  if (toolNames.includes('query-docs')) return 'query-docs';
  if (toolNames.includes('get-library-docs')) return 'get-library-docs';
  return null;
}

function isContext7LibraryId(value: any) {
  return /^\/[A-Za-z0-9._~/-]+$/.test(String(value || '').trim());
}

function resolveContext7Config(opts: any) {
  if (opts.command) return { command: opts.command, args: opts.args || [] };
  return defaultContext7ServerConfig();
}

class LocalMcpClient {
  config: any;
  timeoutMs: number;
  client: Client | null;
  transport: StdioClientTransport | null;
  stderr: string;
  connectionResult: any;

  constructor(config: any, opts: any = {}) {
    this.config = config;
    this.timeoutMs = Number(opts.timeoutMs || process.env.SKS_CONTEXT7_TIMEOUT_MS || 30000);
    this.client = null;
    this.transport = null;
    this.stderr = '';
    this.connectionResult = null;
  }

  serverInfo() {
    return {
      command: this.config.command,
      args: this.config.args,
      stderr: this.stderr.trim(),
      info: this.client?.getServerVersion() || null,
      protocol_version: this.client?.getNegotiatedProtocolVersion() || null,
      protocol_era: this.client?.getProtocolEra() || null
    };
  }

  async connect() {
    if (this.connectionResult) return this.connectionResult;
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args || [],
      env: definedEnvironment(process.env),
      stderr: 'pipe',
      maxBufferSize: 10 * 1024 * 1024
    });
    transport.stderr?.on('data', (chunk: any) => {
      this.stderr += chunk.toString('utf8');
      if (this.stderr.length > 64 * 1024) this.stderr = this.stderr.slice(-64 * 1024);
    });
    const client = new Client(
      { name: 'sneakoscope-context7', version: PACKAGE_VERSION },
      {
        versionNegotiation: {
          mode: 'auto',
          probe: { timeoutMs: this.timeoutMs, maxRetries: 0 }
        },
        inputRequired: { autoFulfill: false }
      }
    );
    try {
      await client.connect(transport, { timeout: this.timeoutMs });
      this.client = client;
      this.transport = transport;
      this.connectionResult = {
        protocol_version: client.getNegotiatedProtocolVersion(),
        protocol_era: client.getProtocolEra(),
        server_info: client.getServerVersion() || null,
        capabilities: client.getServerCapabilities() || {}
      };
      return this.connectionResult;
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async listTools() {
    if (!this.client) throw new Error('Context7 MCP is not connected.');
    return collectMcpListPages<any>('tools', (params) => this.client!.listTools(params, {
      timeout: this.timeoutMs,
      cacheMode: 'refresh'
    }), { requireModernResult: false });
  }

  async callTool(name: any, args: any = {}) {
    if (!this.client) throw new Error('Context7 MCP is not connected.');
    return this.client.callTool({ name, arguments: args }, { timeout: this.timeoutMs });
  }

  async close() {
    const client = this.client;
    this.client = null;
    this.transport = null;
    this.connectionResult = null;
    await client?.close().catch(() => undefined);
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function splitShellWords(value: any) {
  return String(value || '')
    .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
    ?.map((part: any) => part.replace(/^["']|["']$/g, '')) || [];
}
