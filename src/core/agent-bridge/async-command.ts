import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { buildAgentManifest } from './agent-manifest.js';
import { invokeSksTool } from './mcp-server.js';
import { commandContract } from '../safety/command-contract/index.js';
import { redactSecrets, redactString } from '../secret-redaction.js';
import { desktopBridgeStatusV3 } from '../codex-lb/desktop-controller-v3.js';
import { bridgeClientUrl } from '../codex-lb/desktop-controller-v3/shared.js';
import { runProcess } from '../fsx.js';
import { createResponsesTransport } from './responses-transport.js';

const USAGE = 'sks agent-bridge async --prompt "task" [--tools status,stats] [--json]';
const MAX_PROMPT_BYTES = 16 * 1024;

export function redactAsyncToolOutput(stdout: string): string {
  try { return JSON.stringify(redactSecrets(JSON.parse(stdout))); }
  catch { return redactString(stdout); }
}

export function parseAsyncCommandArgs(args: readonly string[]): { prompt: string; tools: string[] } {
  let prompt = '';
  let selected = 'status,stats';
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) throw new Error(`duplicate_option:${flag}`);
    seen.add(flag);
    if (flag === '--json') continue;
    if (!['--prompt', '--tools'].includes(flag) || !args[i + 1]) throw new Error(`invalid_async_option:${flag}`);
    const value = args[++i]!;
    if (flag === '--prompt') prompt = value.trim();
    else selected = value;
  }
  if (!prompt || Buffer.byteLength(prompt) > MAX_PROMPT_BYTES) throw new Error('async_prompt_required_or_too_large');
  const tools = selected.split(',').map(value => value.trim()).filter(Boolean);
  if (!tools.length || tools.length > 8 || new Set(tools).size !== tools.length) throw new Error('async_tools_invalid');
  const manifest = buildAgentManifest();
  for (const name of tools) {
    const entry = manifest.tools.find(tool => tool.name === name);
    const contract = commandContract(name);
    if (!entry?.read_only || !entry.remote_allowed || !contract?.read_only || contract.risk !== 'R0' || !contract.remote_allowed) {
      throw new Error(`async_tool_not_readonly:${name}`);
    }
  }
  return { prompt, tools };
}

export async function agentBridgeAsyncCommand(args: readonly string[]): Promise<unknown> {
  const json = args.includes('--json');
  if (args.includes('--help')) {
    const help = { schema: 'sks.async-tool-run.v1', ok: true, status: 'help', usage: USAGE, model: 'gpt-6-astra', provider: 'codex-lb', tools: 'Explicitly selected R0 remote-readable SKS command contracts only.' };
    console.log(json ? JSON.stringify(help, null, 2) : USAGE);
    return help;
  }
  try {
    const parsed = parseAsyncCommandArgs(args);
    const home = homedir();
    const status = await desktopBridgeStatusV3({ home });
    const model = 'codex-lb:gpt-6-astra';
    const route = status.routing.policy?.model_routes[model];
    // Aggregate readiness includes other providers; validate the selected route
    // here and let the authenticated Responses request establish live readiness.
    if (!status.service.running || !status.service.loopback_origin || route?.provider_id !== 'codex-lb' || route.upstream_model !== 'gpt-6-astra') {
      throw new Error('async_astra_bridge_route_unavailable');
    }
    const endpoint = await bridgeClientUrl(status.service.loopback_origin!, '/backend-api/codex/responses', { home });
    const threadId = randomUUID();
    const transport = createResponsesTransport({
      endpoint, upstreamModel: route.upstream_model,
      headers: { origin: 'app://codex', 'thread-id': threadId, 'session-id': threadId, 'x-sks-model': model },
    });
    // Import only for this explicit mode; ordinary Codex tasks keep their host runtime.
    const { runResponsesAsync } = await import('./responses-async-runner.js');
    const result = await runResponsesAsync({
      model,
      prompt: parsed.prompt,
      effort: 'low',
      tools: parsed.tools.map(name => {
        const contract = commandContract(name)!;
        return {
          name,
          description: contract.description,
          parameters: contract.input_schema,
          execute: async (input: unknown, context: { signal: AbortSignal }) => {
            if (context.signal.aborted) throw new Error('async_run_cancelled');
            const output = await invokeSksTool(contract, input, (command, argv, options) => runProcess(command, argv, {
              ...options, signal: context.signal, cwd: process.cwd(),
              timeoutMs: Math.min(options?.timeoutMs || 20_000, 20_000), maxOutputBytes: 64 * 1024
            }));
            if (context.signal.aborted) throw new Error('async_run_cancelled');
            if (!output.ok || output.truncated) throw new Error(output.timed_out ? 'async_tool_timeout' : 'async_tool_execution_failed');
            return redactAsyncToolOutput(output.stdout);
          }
        };
      }),
      request: transport.request,
    }).finally(() => transport.close());
    const output = { ...result, transport: transport.report };
    result.final_text = redactString(result.final_text);
    output.final_text = result.final_text;
    console.log(json || !result.ok ? JSON.stringify(output, null, 2) : result.final_text);
    if (!result.ok) process.exitCode = 1;
    return output;
  } catch (error) {
    const result = { schema: 'sks.async-tool-run.v1', ok: false, status: 'blocked', blocker: redactString(error instanceof Error ? error.message : String(error)), usage: USAGE };
    console.log(json ? JSON.stringify(result, null, 2) : result.blocker);
    process.exitCode = 1;
    return result;
  }
}
