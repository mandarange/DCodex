import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { isUnmanagedProjectCodexConfig, writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { mcpServerBlock, mcpServerExplicitlyDisabled, readProjectCodexConfig, tomlTableRange } from '../mcp/mcp-config-preservation.js';
import { messageOf } from '../errors/message.js';

export type McpTransport = 'stdio' | 'url' | null;

export type McpTransportCollisionStatus = 'no_collision' | 'collision_detected' | 'collision_resolved' | 'disabled';

export interface McpTransportCollisionServerEntry {
  server: string;
  status: McpTransportCollisionStatus;
  project_transport: McpTransport;
  global_transport: McpTransport;
}

export interface McpTransportCollisionRepairReport {
  schema: 'sks.mcp-transport-collision-repair.v1';
  generated_at: string;
  ok: boolean;
  apply: boolean;
  project_config_path: string;
  global_config_path: string;
  servers: McpTransportCollisionServerEntry[];
  blockers: string[];
  warnings: string[];
  raw_secret_values_recorded: false;
  report_write_failed?: boolean;
}

export async function detectAndRepairMcpTransportCollisions(input: { root: string; apply?: boolean; reportPath?: string | null }): Promise<McpTransportCollisionRepairReport> {
  const root = path.resolve(input.root);
  const apply = input.apply === true;
  const project = await readProjectCodexConfig(root);
  const global = await readGlobalCodexConfigText();
  const distinctConfigs = path.resolve(global.path) !== path.resolve(project.path);
  const serverNames = listMcpServerNames(project.text);
  const unmanagedProjectConfig = isUnmanagedProjectCodexConfig(root, project.path, project.text);

  let workingText = project.text;
  const servers: McpTransportCollisionServerEntry[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  for (const server of serverNames) {
    const disabled = mcpServerExplicitlyDisabled(workingText, server);
    if (disabled) {
      servers.push({ server, status: 'disabled', project_transport: null, global_transport: null });
      continue;
    }
    const projectBlock = mcpServerBlock(workingText, server);
    const projectTransport = blockTransport(projectBlock);
    const globalTransport = distinctConfigs ? blockTransport(mcpServerBlock(global.text, server)) : null;
    const collision = Boolean(projectTransport) && Boolean(globalTransport) && projectTransport !== globalTransport;
    if (!collision) {
      servers.push({ server, status: 'no_collision', project_transport: projectTransport, global_transport: globalTransport });
      continue;
    }
	    if (!apply) {
	      servers.push({ server, status: 'collision_detected', project_transport: projectTransport, global_transport: globalTransport });
	      blockers.push(`mcp_transport_collision:${server}`);
	      continue;
	    }
    if (unmanagedProjectConfig) {
      servers.push({ server, status: 'collision_detected', project_transport: projectTransport, global_transport: globalTransport });
      blockers.push('user_owned_file_without_sks_marker');
      warnings.push('unmanaged_project_config_preserved');
      continue;
    }
    const range = tomlTableRange(workingText, `mcp_servers.${server}`, true);
    if (!range) {
      servers.push({ server, status: 'collision_detected', project_transport: projectTransport, global_transport: globalTransport });
      blockers.push(`mcp_transport_collision:${server}`);
      continue;
    }
    const commented = commentOutMcpServerBlock(workingText.slice(range.start, range.end), server, projectTransport, globalTransport);
    const nextText = `${workingText.slice(0, range.start)}${commented}${workingText.slice(range.end)}`;
    const resolved = nextText !== workingText;
    if (!resolved) {
      servers.push({ server, status: 'collision_detected', project_transport: projectTransport, global_transport: globalTransport });
      blockers.push(`mcp_transport_collision:${server}`);
      continue;
    }
    const before = workingText;
    workingText = nextText;
	    const write = await writeCodexConfigGuarded({
	      root,
	      configPath: project.path,
	      before,
	      cause: `mcp-transport-collision-repair:${server}`,
	      mutate: () => workingText
	    });
    if (!write.ok) {
      workingText = before;
      servers.push({ server, status: 'collision_detected', project_transport: projectTransport, global_transport: globalTransport });
      blockers.push(...(write.status === 'blocked_unmanaged_project_config' ? ['user_owned_file_without_sks_marker'] : [`mcp_transport_collision_write_failed:${server}:${write.status}`]));
      warnings.push('unmanaged_project_config_preserved');
      continue;
    }
	    servers.push({ server, status: 'collision_resolved', project_transport: projectTransport, global_transport: globalTransport });
    warnings.push(`mcp_transport_collision_resolved:${server}`);
  }

  let report: McpTransportCollisionRepairReport = {
    schema: 'sks.mcp-transport-collision-repair.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    apply,
    project_config_path: project.path,
    global_config_path: global.path,
    servers,
    blockers,
    warnings,
    raw_secret_values_recorded: false
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-mcp-transport-collision-repair.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write MCP transport collision repair report ${reportPath}: ${messageOf(err)}\n`);
    }
  }
  return report;
}

/** Scans only the top-level project config text for `[mcp_servers.<name>]` headers (not nested child tables like `.env`). */
function listMcpServerNames(text: string): string[] {
  const source = String(text || '');
  const pattern = /^\s*\[mcp_servers\.([^.\]]+)\]\s*(?:#.*)?$/gm;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function blockTransport(block: string | null): McpTransport {
  if (!block) return null;
  if (/^\s*command\s*=/m.test(block)) return 'stdio';
  if (/^\s*url\s*=/m.test(block)) return 'url';
  return null;
}

async function readGlobalCodexConfigText(): Promise<{ path: string; text: string }> {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return { path: file, text };
}

/** Comments every line of the colliding project MCP block (header + child tables like .env) so Codex stops merging
 * two transports for the same server name, while keeping the original text — including secrets — recoverable in place. */
function commentOutMcpServerBlock(block: string, server: string, projectTransport: McpTransport, globalTransport: McpTransport): string {
  const note = `# [sks doctor] MCP server "${server}" project block disabled: project transport (${projectTransport}) collided with the global config's transport (${globalTransport}) for the same server name (Codex refuses the merged config, e.g. "url is not supported for stdio"). Re-add a block with a matching transport if this project needs its own "${server}" MCP server.\n`;
  const commented = String(block || '')
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((line) => (line.length ? `# ${line}` : '#'))
    .join('\n');
  return `${note}${commented}\n`;
}
