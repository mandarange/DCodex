import { MCP_APPROVAL_MODES, type McpApprovalMode, type McpServerMutationInput } from './types.js';
import { isSensitiveMcpArgumentName, looksLikeMcpSecretValue } from './redaction.js';
import { isRecord } from '../json/records.js';

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/;

export class McpSecretPolicyError extends Error {
  constructor(readonly blockers: string[]) {
    super(blockers.join(','));
    this.name = 'McpSecretPolicyError';
  }
}

export function normalizeMcpMutationInput(value: unknown): McpServerMutationInput {
  if (!isRecord(value)) throw new McpSecretPolicyError(['mcp_payload_required']);
  if ('env' in value) throw new McpSecretPolicyError(['mcp_raw_secret_storage_forbidden']);
  const blockers: string[] = [];
  const name = boundedString(value.name, 64);
  if (!name || !SERVER_NAME.test(name)) blockers.push('invalid_mcp_server_name');
  const rawTransport = String(value.transport || '').trim().toLowerCase();
  const transport = rawTransport === 'stdio' ? 'stdio' : rawTransport === 'streamable-http' || rawTransport === 'url' ? 'streamable-http' : null;
  if (!transport) blockers.push('invalid_mcp_transport');

  const input: Mutable<McpServerMutationInput> = { name: name || '', transport: transport || 'stdio' };
  if (value.enabled !== undefined) input.enabled = value.enabled === true;
  if (transport === 'stdio') normalizeStdio(value, input, blockers);
  if (transport === 'streamable-http') normalizeHttp(value, input, blockers);
  addOptionalNumber(value, input, 'startup_timeout_sec', 1, 30, blockers);
  addOptionalNumber(value, input, 'tool_timeout_sec', 1, 3600, blockers);
  addOptionalStringArray(value, input, 'enabled_tools', TOOL_NAME, 256, blockers);
  addOptionalStringArray(value, input, 'disabled_tools', TOOL_NAME, 256, blockers);
  if (value.default_tools_approval_mode !== undefined) {
    const mode = normalizeApprovalMode(value.default_tools_approval_mode);
    if (!mode) blockers.push(value.default_tools_approval_mode === 'deny' ? 'obsolete_mcp_approval_mode_deny' : 'invalid_mcp_approval_mode');
    else input.default_tools_approval_mode = mode;
  }
  if (value.tool_approval_modes !== undefined) {
    if (!isRecord(value.tool_approval_modes)) blockers.push('invalid_mcp_tool_approval_modes');
    else {
      const modes: Record<string, McpApprovalMode> = {};
      for (const [tool, rawMode] of Object.entries(value.tool_approval_modes)) {
        const mode = normalizeApprovalMode(rawMode);
        if (!TOOL_NAME.test(tool) || !mode) blockers.push('invalid_mcp_tool_approval_modes');
        else modes[tool] = mode;
      }
      if (Object.keys(modes).length > 256) blockers.push('too_many_mcp_tool_approval_modes');
      if (Object.keys(modes).length) input.tool_approval_modes = modes;
    }
  }
  if (value.required !== undefined) input.required = value.required === true;
  if (blockers.length) throw new McpSecretPolicyError([...new Set(blockers)]);
  return input;
}

export function normalizeMcpServerName(value: unknown): string | null {
  const name = boundedString(value, 64);
  return name && SERVER_NAME.test(name) ? name : null;
}

export function isOfficialMcpServerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value);
}

export function normalizeApprovalMode(value: unknown): McpApprovalMode | null {
  const text = String(value || '').trim();
  return (MCP_APPROVAL_MODES as readonly string[]).includes(text) ? text as McpApprovalMode : null;
}

function normalizeStdio(value: Record<string, unknown>, input: Mutable<McpServerMutationInput>, blockers: string[]): void {
  const command = boundedString(value.command, 1024);
  if (!command || /[\r\n\0]/.test(command)) blockers.push('invalid_mcp_command');
  else input.command = command;
  const args = stringArray(value.args, 100, 4096, blockers, 'invalid_mcp_argument');
  if (args.length) {
    if (containsLikelyInlineSecret(args)) blockers.push('mcp_inline_secret_argument_forbidden');
    input.args = args;
  }
  const envVars = stringArray(value.env_vars, 64, 128, blockers, 'invalid_mcp_env_var');
  if (envVars.some((entry) => !ENV_NAME.test(entry))) blockers.push('invalid_mcp_env_var');
  if (envVars.length) input.env_vars = [...new Set(envVars)].sort();
  const cwd = boundedString(value.cwd, 4096);
  if (value.cwd !== undefined && (!cwd || !cwd.startsWith('/'))) blockers.push('invalid_mcp_cwd');
  else if (cwd) input.cwd = cwd;
  if (value.experimental_environment !== undefined) {
    if (value.experimental_environment !== 'remote') blockers.push('invalid_mcp_experimental_environment');
    else input.experimental_environment = 'remote';
  }
}

function normalizeHttp(value: Record<string, unknown>, input: Mutable<McpServerMutationInput>, blockers: string[]): void {
  const rawUrl = boundedString(value.url, 4096);
  if (!rawUrl) {
    blockers.push('invalid_mcp_url');
  } else {
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || hasSensitiveQuery(url)) blockers.push('mcp_url_secret_forbidden');
      else input.url = url.toString();
    } catch {
      blockers.push('invalid_mcp_url');
    }
  }
  for (const key of ['bearer_token_env_var'] as const) {
    const envName = boundedString(value[key], 128);
    if (value[key] !== undefined && (!envName || !ENV_NAME.test(envName))) blockers.push('invalid_mcp_bearer_token_env_var');
    else if (envName) input[key] = envName;
  }
  const clientId = boundedString(value.oauth_client_id, 512);
  if (value.oauth_client_id !== undefined && !clientId) blockers.push('invalid_mcp_oauth_client_id');
  else if (clientId) input.oauth_client_id = clientId;
  const resource = boundedString(value.oauth_resource, 2048);
  if (value.oauth_resource !== undefined && !resource) blockers.push('invalid_mcp_oauth_resource');
  else if (resource) input.oauth_resource = resource;
}

function addOptionalNumber(
  source: Record<string, unknown>,
  target: Mutable<McpServerMutationInput>,
  key: 'startup_timeout_sec' | 'tool_timeout_sec',
  min: number,
  max: number,
  blockers: string[]
): void {
  if (source[key] === undefined) return;
  const value = Number(source[key]);
  if (!Number.isFinite(value) || value < min || value > max) blockers.push(`invalid_mcp_${key}`);
  else target[key] = value;
}

function addOptionalStringArray(
  source: Record<string, unknown>,
  target: Mutable<McpServerMutationInput>,
  key: 'enabled_tools' | 'disabled_tools',
  pattern: RegExp,
  maxCount: number,
  blockers: string[]
): void {
  if (source[key] === undefined) return;
  const values = stringArray(source[key], maxCount, 128, blockers, `invalid_mcp_${key}`);
  if (values.some((entry) => !pattern.test(entry))) blockers.push(`invalid_mcp_${key}`);
  target[key] = [...new Set(values)].sort();
}

function stringArray(value: unknown, maxCount: number, maxLength: number, blockers: string[], blocker: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxCount) {
    blockers.push(blocker);
    return [];
  }
  const out = value.map((entry) => boundedString(entry, maxLength));
  if (out.some((entry) => entry === null)) blockers.push(blocker);
  return out.filter((entry): entry is string => entry !== null);
}

function containsLikelyInlineSecret(args: readonly string[]): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index] || '';
    if (isSensitiveMcpArgumentName(value)) return true;
    if (looksLikeMcpSecretValue(value)) return true;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.+/.test(value)) return true;
  }
  return false;
}

function hasSensitiveQuery(url: URL): boolean {
  return [...url.searchParams.keys()].some((key) => /token|key|secret|password|authorization|bearer/i.test(key));
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && Buffer.byteLength(text) <= max && !/[\r\n\0]/.test(text) ? text : null;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
