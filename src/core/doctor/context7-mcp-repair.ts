import path from 'node:path';
import { ensureDir, nowIso, writeJsonAtomic } from '../fsx.js';
import { isUnmanagedProjectCodexConfig, writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { CONTEXT7_REMOTE_MCP_URL, mcpServerBlock, mcpServerExplicitlyDisabled, readProjectCodexConfig, replaceOrAppendMcpServerBlock } from '../mcp/mcp-config-preservation.js';
import { guardedWriteFile, guardContextForRoute } from '../safety/mutation-guard.js';
import { createRequestedScopeContract } from '../safety/requested-scope-contract.js';
import { messageOf } from '../errors/message.js';

export interface Context7McpRepairReport {
  schema: 'sks.doctor-context7-mcp-repair.v1';
  generated_at: string;
  ok: boolean;
  apply: boolean;
  config_path: string;
  before_transport: 'missing' | 'stdio' | 'remote' | 'disabled' | 'unknown';
  after_transport: 'missing' | 'stdio' | 'remote' | 'disabled' | 'unknown';
  disabled_preserved: boolean;
  remote_probe_status: 'skipped' | 'ok' | 'failed';
  repaired: boolean;
  manual_required: boolean;
  blockers: string[];
  warnings: string[];
  report_write_failed?: boolean;
}

export async function repairContext7Mcp(input: { root: string; apply?: boolean; reportPath?: string | null }): Promise<Context7McpRepairReport> {
  const root = path.resolve(input.root);
  const config = await readProjectCodexConfig(root);
  const beforeTransport = classifyContext7Transport(config.text);
  if (input.apply && isUnmanagedProjectCodexConfig(root, config.path, config.text)) {
    const report: Context7McpRepairReport = {
      schema: 'sks.doctor-context7-mcp-repair.v1',
      generated_at: nowIso(),
      ok: false,
      apply: true,
      config_path: config.path,
      before_transport: beforeTransport,
      after_transport: beforeTransport,
      disabled_preserved: beforeTransport === 'disabled',
      remote_probe_status: 'skipped',
      repaired: false,
      manual_required: true,
      blockers: ['user_owned_file_without_sks_marker'],
      warnings: ['unmanaged_project_config_preserved']
    };
    if (input.reportPath !== null) {
      const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-context7-mcp-repair.json');
      try {
        await writeJsonAtomic(reportPath, report);
      } catch (err: unknown) {
        return { ...report, report_write_failed: true };
      }
    }
    return report;
  }
  const disabledPreserved = beforeTransport === 'disabled';
  let afterText = config.text;
  let repaired = false;
  let backupWriteFailed = false;
  if (beforeTransport === 'stdio') {
    afterText = replaceOrAppendMcpServerBlock(config.text, 'context7', [
      '[mcp_servers.context7]',
      `url = "${CONTEXT7_REMOTE_MCP_URL}"`,
      ''
    ].join('\n'));
    repaired = afterText !== config.text;
  }
  if (input.apply && repaired) {
    await ensureDir(path.dirname(config.path));
    const backupPath = `${config.path}.context7-mcp-repair-${Date.now().toString(36)}.bak`;
    const contract = createRequestedScopeContract({
      route: '$Naruto',
      userRequest: 'Write a scoped project backup before doctor Context7 MCP repair.',
      projectRoot: root
    });
    try {
      await guardedWriteFile(guardContextForRoute(root, contract, 'doctor Context7 MCP repair backup'), backupPath, config.text);
    } catch (err: unknown) {
      backupWriteFailed = true;
      process.stderr.write(`SKS doctor warning: failed to write Context7 MCP repair backup ${backupPath}: ${messageOf(err)}\n`);
    }
    await writeCodexConfigGuarded({
      root,
      configPath: config.path,
      before: config.text,
      cause: 'context7-mcp-repair',
      mutate: () => afterText
    });
  }
  const after = input.apply && repaired ? await readProjectCodexConfig(root) : { text: afterText };
  const afterTransport = classifyContext7Transport(after.text);
  const remoteProbeStatus = afterTransport === 'remote' && process.env.SKS_CONTEXT7_REMOTE_PROBE === '1'
    ? await probeRemoteContext7()
    : 'skipped';
  let report: Context7McpRepairReport = {
    schema: 'sks.doctor-context7-mcp-repair.v1',
    generated_at: nowIso(),
    ok: afterTransport === 'remote' || afterTransport === 'disabled' || beforeTransport === 'missing',
    apply: input.apply === true,
    config_path: config.path,
    before_transport: beforeTransport,
    after_transport: afterTransport,
    disabled_preserved: disabledPreserved && afterTransport === 'disabled',
    remote_probe_status: remoteProbeStatus,
    repaired: input.apply === true && repaired,
    manual_required: false,
    blockers: afterTransport === 'stdio' ? ['context7_mcp_still_stdio'] : [],
    warnings: [
      ...(beforeTransport === 'missing' ? ['context7_mcp_not_configured'] : []),
      ...(backupWriteFailed ? ['context7_mcp_backup_write_failed'] : [])
    ]
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-context7-mcp-repair.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write Context7 MCP repair report ${reportPath}: ${messageOf(err)}\n`);
    }
  }
  return report;
}

async function probeRemoteContext7(): Promise<Context7McpRepairReport['remote_probe_status']> {
  try {
    const response = await fetch(CONTEXT7_REMOTE_MCP_URL, { method: 'HEAD' });
    return response.status < 500 ? 'ok' : 'failed';
  } catch {
    return 'failed';
  }
}

export function classifyContext7Transport(text: string): Context7McpRepairReport['before_transport'] {
  if (mcpServerExplicitlyDisabled(text, 'context7')) return 'disabled';
  const block = mcpServerBlock(text, 'context7');
  if (!block) return 'missing';
  if (/^\s*url\s*=/m.test(block)) return 'remote';
  if (/^\s*command\s*=|stdio|npx|context7/i.test(block)) return 'stdio';
  return 'unknown';
}
