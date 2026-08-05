import { probeMcpServer, runMcpServer } from '../agent-bridge/mcp-server.js';
import { flag } from './command-utils.js';

export async function mcpServerCommand(args: readonly string[] = []): Promise<void> {
  const exposeExec = flag(args, '--expose-exec');
  if (flag(args, '--probe')) {
    const result = await probeMcpServer({ exposeExec });
    console.log(JSON.stringify({ schema: 'sks.mcp-server-probe.v1', ...result }, null, 2));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  await runMcpServer({
    exposeExec,
    onError: (error) => process.stderr.write(`[sks-mcp-server] ${error.message}\n`)
  });
}
