import fsp from 'node:fs/promises';
import { parseCodexConfigToml } from '../codex/codex-config-toml.js';
import { errorCodeOf } from '../errors/message.js';
import { publicMcpCommand, redactMcpError, redactMcpUrl, sanitizeMcpArgs } from './redaction.js';
import { normalizeApprovalMode } from './secret-policy.js';
import {
  MCP_DEFAULT_STARTUP_TIMEOUT_SEC,
  MCP_DEFAULT_TOOL_TIMEOUT_SEC,
  MCP_SERVER_CONFIG_SCHEMA,
  type McpApprovalMode,
  type McpServerConfigV2
} from './types.js';
import type { ResolvedMcpScope } from './scope.js';
import { isRecord } from '../json/records.js';

export { isRecord };

export interface McpConfigDocument {
  readonly ref: ResolvedMcpScope;
  readonly exists: boolean;
  readonly text: string;
  readonly parsed: Record<string, unknown>;
  readonly rawServers: Readonly<Record<string, Record<string, unknown>>>;
}

export interface McpCliInventoryRow {
  readonly name: string;
  readonly enabled?: boolean;
  readonly disabled_reason?: string | null;
  readonly auth_status?: string | null;
  readonly startup_timeout_sec?: number | null;
  readonly tool_timeout_sec?: number | null;
}

export class McpConfigReadError extends Error {
  constructor(readonly code: string, cause?: unknown) {
    super(code);
    this.name = 'McpConfigReadError';
    if (cause !== undefined) this.cause = cause;
  }
}

export async function readMcpConfigDocument(ref: ResolvedMcpScope): Promise<McpConfigDocument> {
  const stat = await fsp.lstat(ref.configPath).catch((error: unknown) => errorCodeOf(error) === 'ENOENT' ? null : Promise.reject(error));
  if (!stat) return { ref, exists: false, text: '', parsed: {}, rawServers: {} };
  if (stat.isSymbolicLink()) throw new McpConfigReadError('mcp_config_symlink_refused');
  if (!stat.isFile()) throw new McpConfigReadError('mcp_config_not_regular_file');
  let text: string;
  try {
    text = await fsp.readFile(ref.configPath, 'utf8');
  } catch (error) {
    throw new McpConfigReadError('mcp_config_read_failed', error);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseCodexConfigToml(text) as Record<string, unknown>;
  } catch (error) {
    throw new McpConfigReadError('mcp_config_toml_parse_failed', redactMcpError(error));
  }
  const servers = isRecord(parsed.mcp_servers) ? parsed.mcp_servers : {};
  const rawServers: Record<string, Record<string, unknown>> = {};
  for (const [name, value] of Object.entries(servers)) {
    if (isRecord(value)) rawServers[name] = value;
  }
  return { ref, exists: true, text, parsed, rawServers };
}

export function publicServersFromDocument(
  document: McpConfigDocument,
  cliRows: readonly McpCliInventoryRow[] = []
): McpServerConfigV2[] {
  const cliByName = new Map(cliRows.map((row) => [row.name, row]));
  return Object.entries(document.rawServers)
    .map(([name, value]) => publicServerFromRaw(name, value, document.ref, cliByName.get(name)))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function publicServerFromRaw(
  name: string,
  value: Readonly<Record<string, unknown>>,
  ref: ResolvedMcpScope,
  cli?: McpCliInventoryRow
): McpServerConfigV2 {
  const rawUrl = typeof value.url === 'string' ? value.url : null;
  const rawCommand = typeof value.command === 'string' ? value.command : null;
  const transport = rawUrl ? 'streamable-http' : rawCommand ? 'stdio' : 'stdio';
  const inlineEnv = isRecord(value.env) ? value.env : {};
  const envVars = stringArray(value.env_vars).filter(isEnvName);
  const args = stringArray(value.args);
  const rawApproval = normalizeApprovalMode(value.default_tools_approval_mode ?? value.approval_mode);
  const toolApprovalModes = parseToolApprovalModes(value.tools);
  const authStatus = String(cli?.auth_status || '').toLowerCase();
  const oauthSupported = transport === 'streamable-http'
    ? authStatus === 'unsupported' ? false : null
    : false;
  const authenticated = /oauth.*(?:ok|authenticated)|authenticated/.test(authStatus)
    ? true
    : /oauth.*(?:required|expired|missing)/.test(authStatus)
      ? false
      : null;
  return {
    schema: MCP_SERVER_CONFIG_SCHEMA,
    name,
    scope: ref.scope,
    enabled: cli?.enabled ?? (value.enabled !== false && value.disabled !== true),
    transport,
    ...(rawCommand ? { command: publicMcpCommand(rawCommand) } : {}),
    ...(args.length ? { args: sanitizeMcpArgs(args) } : {}),
    ...(envVars.length ? { env_vars: [...new Set(envVars)].sort() } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(value.experimental_environment === 'remote' ? { experimental_environment: 'remote' as const } : {}),
    ...(rawUrl ? { url: redactMcpUrl(rawUrl) } : {}),
    ...(isEnvName(value.bearer_token_env_var) ? { bearer_token_env_var: value.bearer_token_env_var } : {}),
    oauth: { supported: oauthSupported, authenticated },
    startup_timeout_sec: positiveNumber(cli?.startup_timeout_sec ?? value.startup_timeout_sec) ?? MCP_DEFAULT_STARTUP_TIMEOUT_SEC,
    tool_timeout_sec: positiveNumber(cli?.tool_timeout_sec ?? value.tool_timeout_sec) ?? MCP_DEFAULT_TOOL_TIMEOUT_SEC,
    ...(stringArray(value.enabled_tools).length ? { enabled_tools: stringArray(value.enabled_tools) } : {}),
    ...(stringArray(value.disabled_tools).length ? { disabled_tools: stringArray(value.disabled_tools) } : {}),
    ...(rawApproval ? { default_tools_approval_mode: rawApproval } : {}),
    ...(Object.keys(toolApprovalModes).length ? { tool_approval_modes: toolApprovalModes } : {}),
    ...(typeof value.required === 'boolean' ? { required: value.required } : {}),
    source_path: ref.configPath,
    managed_by: value.managed_by === 'sks' ? 'sks' : 'user',
    legacy_inline_secret_present: Object.keys(inlineEnv).length > 0,
    legacy_env_keys: Object.keys(inlineEnv).filter(isEnvName).sort()
  };
}

export function rawServer(document: McpConfigDocument, name: string): Record<string, unknown> | null {
  return document.rawServers[name] ? { ...document.rawServers[name] } : null;
}

export function privateEnvironment(value: Readonly<Record<string, unknown>>): Record<string, string> {
  const result = privateInlineEnvironment(value);
  for (const key of stringArray(value.env_vars).filter(isEnvName)) {
    if (process.env[key] !== undefined) result[key] = String(process.env[key]);
  }
  return result;
}

export function privateInlineEnvironment(value: Readonly<Record<string, unknown>>): Record<string, string> {
  const inline = isRecord(value.env) ? value.env : {};
  const result: Record<string, string> = {};
  for (const [key, raw] of Object.entries(inline)) {
    if (isEnvName(key) && typeof raw === 'string') result[key] = raw;
  }
  return result;
}

export function rawStringArray(value: unknown): string[] {
  return stringArray(value);
}

function parseToolApprovalModes(value: unknown): Record<string, McpApprovalMode> {
  if (!isRecord(value)) return {};
  const result: Record<string, McpApprovalMode> = {};
  for (const [tool, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const mode = normalizeApprovalMode(raw.approval_mode);
    if (mode) result[tool] = mode;
  }
  return result;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function isEnvName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}
