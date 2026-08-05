import { fileURLToPath } from 'node:url';
import type { Readable, Writable } from 'node:stream';
import { McpServer, fromJsonSchema, type CallToolResult } from '@modelcontextprotocol/server';
import {
  StdioServerTransport,
  serveStdio,
  type StdioServerHandle
} from '@modelcontextprotocol/server/stdio';
import { buildAgentManifest, type AgentManifestEntry } from './agent-manifest.js';
import { AGENT_MODE_ENV_PASSTHROUGH } from './agent-mode.js';
import { exists, runProcess } from '../fsx.js';
import {
  commandContract,
  outputCapFor,
  timeoutFor,
  validateJsonSchema,
  type CommandContractV3
} from '../safety/command-contract/index.js';
import {
  MCP_PROTOCOL_VERSION,
  modernMcpRequest,
  modernServerInfo
} from '../mcp/modern-protocol.js';

export interface RunMcpServerOptions {
  exposeExec?: boolean;
  input?: Readable;
  output?: Writable;
  maxConcurrentTools?: number;
  maxQueuedTools?: number;
  onError?: (error: Error) => void;
}

const MCP_SERVER_NAME = 'sks-mcp-server';
const MCP_SERVER_VERSION = '1.0.0';
const MCP_SERVER_INFO = { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION };
const MAX_MCP_MESSAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_TOOLS = 4;
const DEFAULT_MAX_QUEUED_TOOLS = 64;

function exposedTools(manifest: AgentManifestEntry[], exposeExec: boolean): AgentManifestEntry[] {
  return manifest.filter((tool) =>
    tool.remote_allowed === true
    && tool.risk !== 'R3'
    && (exposeExec || tool.risk === 'R0')
  );
}

async function resolveSksEntrypoint(): Promise<string> {
  // Prefer the packaged sibling. Source-driven tests/dev runs resolve the built
  // dist entrypoint, then the TypeScript entrypoint when the current runtime can
  // execute it (Bun). Every candidate is derived from import.meta.url so cwd cannot
  // redirect the command to an untrusted path.
  const packedBin = fileURLToPath(new URL('../../bin/sks.js', import.meta.url));
  const sourceTreeDistBin = fileURLToPath(new URL('../../../dist/bin/sks.js', import.meta.url));
  const sourceBin = fileURLToPath(new URL('../../bin/sks.ts', import.meta.url));
  for (const candidate of [packedBin, sourceTreeDistBin, sourceBin]) {
    if (await exists(candidate)) return candidate;
  }
  throw new McpInvocationError('ENTRYPOINT_MISSING', 'Sneakoscope CLI entrypoint is unavailable');
}

export async function invokeSksTool(
  contract: CommandContractV3,
  input: unknown,
  run: typeof runProcess = runProcess
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null; timed_out: boolean; truncated: boolean; argv: string[] }> {
  const validation = validateJsonSchema(input, contract.input_schema);
  if (!validation.ok) {
    const detail = validation.issues.map((entry) => `${entry.path}:${entry.code}`).join(', ');
    throw new McpInvocationError('INVALID_ARGUMENTS', `Invalid arguments for ${contract.name}: ${detail}`);
  }
  if (!contract.remote_allowed || contract.risk === 'R3') {
    throw new McpInvocationError('REMOTE_DENIED', `Remote invocation is denied for ${contract.name}`);
  }
  const entrypoint = await resolveSksEntrypoint();
  const commandArgs = contract.argv_builder(validation.value);
  if (commandArgs[0] !== contract.name) {
    throw new McpInvocationError('INVALID_ARGV', `argv builder for ${contract.name} changed the command name`);
  }
  const passthroughEnv: Record<string, string> = {};
  for (const name of AGENT_MODE_ENV_PASSTHROUGH) passthroughEnv[name] = '1';
  const result = await run(process.execPath, [entrypoint, ...commandArgs], {
    env: { ...passthroughEnv, SKS_AGENT_MODE: '1' },
    timeoutMs: timeoutFor(contract.latency),
    maxOutputBytes: outputCapFor(contract.latency)
  });
  return {
    ok: result.code === 0 && !result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    timed_out: result.timedOut,
    truncated: result.truncated,
    argv: commandArgs
  };
}

export class McpInvocationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'McpInvocationError';
  }
}

function mcpToolErrorResult(message: string, code = 'EXECUTION_FAILED'): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
    structuredContent: { schema: 'sks.mcp-error.v1', ok: false, code, message }
  };
}

class BoundedToolExecutor {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly maxConcurrent: number,
    private readonly maxQueued: number
  ) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError('maxConcurrentTools must be a positive integer');
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new RangeError('maxQueuedTools must be a non-negative integer');
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    if (this.waiting.length >= this.maxQueued) {
      throw new McpInvocationError('SERVER_BUSY', 'MCP tool execution queue is full');
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }
}

function buildMcpServer(exposeExec: boolean, executor: BoundedToolExecutor): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {} },
    instructions: 'Use tools/list to discover safe Sneakoscope commands before calling tools/call.'
  });
  const manifest = buildAgentManifest();
  for (const entry of exposedTools(manifest.tools, exposeExec)) {
    const contract = commandContract(entry.name);
    if (!contract) {
      throw new McpInvocationError('CONTRACT_MISSING', `Missing command contract: ${entry.name}`);
    }
    server.registerTool(entry.name, {
      title: entry.name,
      description: entry.description,
      inputSchema: fromJsonSchema(contract.input_schema),
      annotations: {
        readOnlyHint: entry.read_only,
        destructiveHint: entry.risk === 'R2' || entry.risk === 'R3',
        title: entry.name
      }
    }, async (input): Promise<CallToolResult> => {
      try {
        return await executor.run(async () => {
          const result = await invokeSksTool(contract, input);
          if (!result.ok) {
            const code = result.timed_out ? 'TIMEOUT' : result.truncated ? 'OUTPUT_LIMIT' : 'EXECUTION_FAILED';
            return mcpToolErrorResult(
              result.stderr || result.stdout || `sks ${entry.name} exited with code ${result.code}`,
              code
            );
          }
          return {
            content: [{ type: 'text', text: result.stdout }],
            isError: false
          };
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const code = error instanceof McpInvocationError ? error.code : 'EXECUTION_FAILED';
        return mcpToolErrorResult(`Failed to run sks ${entry.name}: ${message}`, code);
      }
    });
  }
  return server;
}

export async function runMcpServer(opts: RunMcpServerOptions = {}): Promise<StdioServerHandle> {
  const exposeExec = opts.exposeExec === true;
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const executor = new BoundedToolExecutor(
    opts.maxConcurrentTools ?? DEFAULT_MAX_CONCURRENT_TOOLS,
    opts.maxQueuedTools ?? DEFAULT_MAX_QUEUED_TOOLS
  );
  const transport = new StdioServerTransport(input, output, {
    maxBufferSize: MAX_MCP_MESSAGE_BYTES
  });
  return serveStdio(() => buildMcpServer(exposeExec, executor), {
    legacy: 'reject',
    transport,
    ...(opts.onError ? { onerror: opts.onError } : {})
  });
}

/** Round-trips server/discover -> tools/list over in-memory streams and returns, instead of
 * staying resident on real stdio — this is what `sks mcp-server --probe` runs, so a
 * fixture/CI check can prove the server actually works without hanging on a real client. */
export async function probeMcpServer(opts: { exposeExec?: boolean; timeoutMs?: number } = {}): Promise<{ ok: boolean; server_name: string | null; protocol_version: string | null; tool_count: number }> {
  const { PassThrough } = await import('node:stream');
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const responses: any[] = [];
  let buffer = '';
  serverToClient.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        try { responses.push(JSON.parse(line)); } catch { /* not a complete JSON line yet */ }
      }
    }
  });
  const send = (message: Record<string, unknown>) => clientToServer.write(`${JSON.stringify(message)}\n`);
  const waitForId = async (id: number, timeoutMs: number): Promise<any> => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`mcp_probe_timed_out_waiting_for_response_id_${id}`);
  };
  const handle = await runMcpServer({ exposeExec: opts.exposeExec === true, input: clientToServer, output: serverToClient });
  try {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const clientInfo = { name: 'sks-mcp-probe', version: '1.0.0' };
    send(modernMcpRequest(1, 'server/discover', {}, { clientInfo }));
    const discoverResponse = await waitForId(1, timeoutMs);
    send(modernMcpRequest(2, 'tools/list', {}, { clientInfo }));
    const listResponse = await waitForId(2, timeoutMs);
    const serverInfo = modernServerInfo(discoverResponse?.result);
    return {
      ok: discoverResponse?.result?.resultType === 'complete'
        && listResponse?.result?.resultType === 'complete'
        && Array.isArray(listResponse?.result?.tools),
      server_name: serverInfo?.name || null,
      protocol_version: Array.isArray(discoverResponse?.result?.supportedVersions)
        && discoverResponse.result.supportedVersions.includes(MCP_PROTOCOL_VERSION)
        ? MCP_PROTOCOL_VERSION
        : null,
      tool_count: Array.isArray(listResponse?.result?.tools) ? listResponse.result.tools.length : 0
    };
  } finally {
    clientToServer.end();
    await handle.close();
    serverToClient.end();
  }
}
