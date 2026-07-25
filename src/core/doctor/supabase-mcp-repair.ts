import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { nowIso, writeJsonAtomic } from '../fsx.js';
import { isUnmanagedProjectCodexConfig, writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { mcpServerBlock, mcpServerExplicitlyDisabled, readProjectCodexConfig, replaceOrAppendMcpServerBlock, tomlTableRange } from '../mcp/mcp-config-preservation.js';
import { messageOf } from '../errors/message.js';

export interface SupabaseMcpRepairReport {
  schema: 'sks.doctor-supabase-mcp-repair.v1';
  generated_at: string;
  ok: boolean;
  apply: boolean;
  configured: boolean;
  disabled: boolean;
  disabled_preserved: boolean;
  token_env_present: boolean;
  unsafe_write_access: boolean;
  read_only_migrated: boolean;
  stdio_url_transport_collision: boolean;
  transport_collision_resolved: boolean;
  write_scope_requires_confirmation: boolean;
  ready_blocking: boolean;
  manual_required: boolean;
  next_action: string | null;
  blockers: string[];
  warnings: string[];
  raw_secret_values_recorded: false;
  report_write_failed?: boolean;
}

export async function repairSupabaseMcp(input: { root: string; apply?: boolean; reportPath?: string | null }): Promise<SupabaseMcpRepairReport> {
  const root = path.resolve(input.root);
  const config = await readProjectCodexConfig(root);
  const disabled = mcpServerExplicitlyDisabled(config.text, 'supabase') || mcpServerExplicitlyDisabled(config.text, 'supabase_sauron');
  const block = mcpServerBlock(config.text, 'supabase') || '';
  const configured = Boolean(block);
  const tokenEnvPresent = Boolean(process.env.SUPABASE_ACCESS_TOKEN);
  if (input.apply && isUnmanagedProjectCodexConfig(root, config.path, config.text)) {
    const report: SupabaseMcpRepairReport = {
      schema: 'sks.doctor-supabase-mcp-repair.v1',
      generated_at: nowIso(),
      ok: false,
      apply: true,
      configured,
      disabled,
      disabled_preserved: disabled,
      token_env_present: tokenEnvPresent,
      unsafe_write_access: false,
      read_only_migrated: false,
      stdio_url_transport_collision: false,
      transport_collision_resolved: false,
      write_scope_requires_confirmation: false,
      ready_blocking: true,
      manual_required: true,
      next_action: 'Project .codex/config.toml has no SKS-managed marker; doctor --fix preserved it without mutation.',
      blockers: ['user_owned_file_without_sks_marker'],
      warnings: ['unmanaged_project_config_preserved'],
      raw_secret_values_recorded: false
    };
    if (input.reportPath !== null) {
      const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-supabase-mcp-repair.json');
      try {
        await writeJsonAtomic(reportPath, report);
      } catch (err: unknown) {
        return { ...report, report_write_failed: true };
      }
    }
    return report;
  }
  const readOnlyBefore = /read[_-]?only\s*=\s*true|access_mode\s*=\s*"read-only"|--read-only/.test(block);
  const unsafeWriteAccessBefore = configured && !disabled && !readOnlyBefore && /write|service_role|SUPABASE_ACCESS_TOKEN/.test(block);
  // Codex merges the global (~/.codex) and project (.codex) config per key. When
  // the project defines a stdio supabase server (command=...) while the global
  // one uses a streamable-http url, the merged table has both `command` and
  // `url`, and Codex refuses to load with "url is not supported for stdio",
  // blocking every chat/task in that project. Detect and disable the project's
  // stdio block so it inherits the safe global read-only url form.
  const globalConfig = await readGlobalCodexConfigText();
  const distinctConfigs = path.resolve(globalConfig.path) !== path.resolve(config.path);
  const projectTransport = blockTransport(block);
  const globalTransport = distinctConfigs ? blockTransport(mcpServerBlock(globalConfig.text, 'supabase')) : null;
  const stdioUrlTransportCollision = configured && !disabled && projectTransport === 'stdio' && globalTransport === 'url';
  let afterText = config.text;
  let readOnlyMigrated = false;
  let transportCollisionResolved = false;
  if (stdioUrlTransportCollision && input.apply) {
    const range = tomlTableRange(config.text, 'mcp_servers.supabase', true);
    if (range) {
      const commented = commentOutStdioSupabaseBlock(config.text.slice(range.start, range.end));
      afterText = `${config.text.slice(0, range.start)}${commented}${config.text.slice(range.end)}`;
      transportCollisionResolved = afterText !== config.text;
      if (transportCollisionResolved) await writeCodexConfigGuarded({
        root,
        configPath: config.path,
        before: config.text,
        cause: 'supabase-mcp-transport-collision',
        mutate: () => afterText
      });
    }
  } else if (configured && !disabled && !readOnlyBefore && input.apply) {
    afterText = replaceOrAppendMcpServerBlock(config.text, 'supabase', setReadOnly(block));
    readOnlyMigrated = afterText !== config.text;
    if (readOnlyMigrated) await writeCodexConfigGuarded({
      root,
      configPath: config.path,
      before: config.text,
      cause: 'supabase-mcp-repair',
      mutate: () => afterText
    });
  }
  // A resolved collision comments the whole stdio block out, so the project no
  // longer contributes an active supabase server at all.
  const effectivelyConfigured = configured && !transportCollisionResolved;
  const afterBlock = transportCollisionResolved ? '' : readOnlyMigrated ? mcpServerBlock(afterText, 'supabase') || '' : block;
  const readOnlyAfter = /read[_-]?only\s*=\s*true|access_mode\s*=\s*"read-only"|--read-only/.test(afterBlock);
  const unsafeWriteAccess = effectivelyConfigured && !disabled && !readOnlyAfter && /write|service_role|SUPABASE_ACCESS_TOKEN/.test(afterBlock);
  const transportCollisionUnresolved = stdioUrlTransportCollision && !transportCollisionResolved;
  const writeScopeRequiresConfirmation = effectivelyConfigured && !disabled && (unsafeWriteAccessBefore || !readOnlyAfter);
  const readyBlocking = unsafeWriteAccess || transportCollisionUnresolved;
  const manualRequired = effectivelyConfigured && !disabled && (!tokenEnvPresent || writeScopeRequiresConfirmation);
  let report: SupabaseMcpRepairReport = {
    schema: 'sks.doctor-supabase-mcp-repair.v1',
    generated_at: nowIso(),
    ok: (!configured || disabled || !unsafeWriteAccess) && !transportCollisionUnresolved,
    apply: input.apply === true,
    configured,
    disabled,
    disabled_preserved: disabled,
    token_env_present: tokenEnvPresent,
    unsafe_write_access: unsafeWriteAccess,
    read_only_migrated: readOnlyMigrated,
    stdio_url_transport_collision: stdioUrlTransportCollision,
    transport_collision_resolved: transportCollisionResolved,
    write_scope_requires_confirmation: writeScopeRequiresConfirmation,
    ready_blocking: readyBlocking,
    manual_required: manualRequired,
    next_action: transportCollisionUnresolved
      ? 'Project Supabase MCP uses stdio while the global config uses a streamable-http url; Codex rejects the merged config with "url is not supported for stdio". Run `sks doctor --fix` to disable the project stdio block so it inherits the safe global read-only url.'
      : manualRequired
        ? tokenEnvPresent
          ? 'Set persistent Supabase MCP to read-only. Write-scoped Supabase MCP is allowed only through a mission-local MAD-SKS SQL-plane runtime profile.'
          : 'Set SUPABASE_ACCESS_TOKEN only when an explicit MAD-SKS SQL-plane run needs Supabase MCP auth; otherwise keep persistent Supabase MCP disabled/read-only.'
        : null,
    blockers: [
      ...(unsafeWriteAccess ? ['supabase_mcp_write_access_not_safe_by_default'] : []),
      ...(transportCollisionUnresolved ? ['supabase_mcp_stdio_url_transport_collision'] : [])
    ],
    warnings: [
      ...(effectivelyConfigured && !tokenEnvPresent ? ['supabase_access_token_unset_write_features_manual_required'] : []),
      ...(readOnlyMigrated ? ['supabase_mcp_migrated_to_read_only'] : []),
      ...(transportCollisionResolved ? ['supabase_mcp_stdio_block_disabled_for_url_collision'] : [])
    ],
    raw_secret_values_recorded: false
  };
  if (input.reportPath !== null) {
    const reportPath = input.reportPath || path.join(root, '.sneakoscope', 'reports', 'doctor-supabase-mcp-repair.json');
    try {
      await writeJsonAtomic(reportPath, report);
    } catch (err: unknown) {
      report = { ...report, report_write_failed: true };
      process.stderr.write(`SKS doctor warning: failed to write Supabase MCP repair report ${reportPath}: ${messageOf(err)}\n`);
    }
  }
  return report;
}

function setReadOnly(block: string): string {
  const lines = String(block || '').replace(/\s*$/, '').split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*read[_-]?only\s*=/.test(line));
  if (index >= 0) lines[index] = 'read_only = true';
  else lines.push('read_only = true');
  return `${lines.join('\n')}\n`;
}

async function readGlobalCodexConfigText(): Promise<{ path: string; text: string }> {
  const home = process.env.CODEX_HOME || path.join(process.env.HOME || os.homedir(), '.codex');
  const file = path.join(home, 'config.toml');
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return { path: file, text };
}

function blockTransport(block: string | null): 'stdio' | 'url' | null {
  if (!block) return null;
  if (/^\s*command\s*=/m.test(block)) return 'stdio';
  if (/^\s*url\s*=/m.test(block)) return 'url';
  return null;
}

/** Comment every line of a supabase MCP block (header + child .env table) so
 * Codex stops loading it as a stdio server, while keeping the original text —
 * including the access token — recoverable in place. */
function commentOutStdioSupabaseBlock(block: string): string {
  const note = '# [sks doctor] Supabase MCP stdio block disabled: it collided with the global read-only URL Supabase entry (Codex: "url is not supported for stdio"). Re-add a read-only URL form (url = "https://mcp.supabase.com/mcp?project_ref=<ref>&read_only=true&features=database,docs") if this project needs its own Supabase MCP.\n';
  const commented = String(block || '')
    .replace(/\s+$/, '')
    .split(/\r?\n/)
    .map((line) => (line.length ? `# ${line}` : '#'))
    .join('\n');
  return `${note}${commented}\n`;
}
