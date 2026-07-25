import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runProcess, which, type RunProcessResult } from '../fsx.js';
import type { McpCliInventoryRow } from './config-reader.js';
import type { ResolvedMcpScope } from './scope.js';
import type { McpServerMutationInput } from './types.js';
import { isRecord } from '../json/records.js';

export interface CodexCliListResult {
  readonly available: boolean;
  readonly ok: boolean;
  readonly rows: McpCliInventoryRow[];
  readonly public_error: string | null;
}

export interface CodexCliTransformResult {
  readonly available: boolean;
  readonly ok: boolean;
  readonly used: boolean;
  readonly text: string | null;
  readonly unsupported_reason: string | null;
  readonly public_error: string | null;
}

export interface CodexCliAuthResult {
  readonly available: boolean;
  readonly ok: boolean;
  readonly public_error: string | null;
}

export interface CodexCliMutationOperation {
  readonly action: 'add' | 'edit' | 'duplicate' | 'remove';
  readonly name: string;
  readonly server?: McpServerMutationInput;
}

export interface CodexMcpCliPort {
  list(ref: ResolvedMcpScope): Promise<CodexCliListResult>;
  transform(before: string, operation: CodexCliMutationOperation): Promise<CodexCliTransformResult>;
  login(ref: ResolvedMcpScope, name: string, scopes?: readonly string[]): Promise<CodexCliAuthResult>;
  logout(ref: ResolvedMcpScope, name: string): Promise<CodexCliAuthResult>;
}

interface AdapterDependencies {
  readonly findExecutable?: (command: string) => Promise<string | null>;
  readonly run?: (command: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }) => Promise<RunProcessResult>;
}

type CodexTransformPublicError =
  | 'codex_mcp_edit_remove_failed'
  | 'codex_mcp_mutation_failed'
  | 'codex_mcp_cli_transform_failed';

export class CodexMcpCliAdapter implements CodexMcpCliPort {
  private readonly configuredPath: string | undefined;
  private readonly findExecutable: NonNullable<AdapterDependencies['findExecutable']>;
  private readonly run: NonNullable<AdapterDependencies['run']>;

  constructor(options: { readonly codexPath?: string; readonly dependencies?: AdapterDependencies } = {}) {
    this.configuredPath = options.codexPath;
    this.findExecutable = options.dependencies?.findExecutable ?? which;
    this.run = options.dependencies?.run ?? defaultRun;
  }

  async list(ref: ResolvedMcpScope): Promise<CodexCliListResult> {
    try {
      const executable = await this.executable();
      if (!executable) return { available: false, ok: false, rows: [], public_error: 'codex_cli_not_found' };
      const result = await this.run(executable, ['mcp', 'list', '--json'], {
        cwd: ref.root,
        env: scopedEnvironment(ref.codexHome),
        timeoutMs: 10_000,
        maxOutputBytes: 1024 * 1024
      });
      if (result.code !== 0 || result.timedOut) {
        return { available: true, ok: false, rows: [], public_error: 'codex_mcp_list_failed' };
      }
      const parsed = JSON.parse(result.stdout) as unknown;
      const rows = Array.isArray(parsed) ? parsed.map(parseListRow).filter((row): row is McpCliInventoryRow => row !== null) : [];
      return { available: true, ok: true, rows, public_error: null };
    } catch {
      return { available: true, ok: false, rows: [], public_error: 'codex_mcp_list_failed' };
    }
  }

  async transform(before: string, operation: CodexCliMutationOperation): Promise<CodexCliTransformResult> {
    let temp: string | null = null;
    try {
      const executable = await this.executable();
      if (!executable) return unavailableTransform('codex_cli_not_found');
      if (!isOfficialServerName(operation.name)) return unavailableTransform('codex_cli_server_name_unsupported');
      temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'sks-mcp-codex-cli-'));
      const codexHome = path.join(temp, '.codex');
      const configPath = path.join(codexHome, 'config.toml');
      await fsp.mkdir(codexHome, { recursive: true });
      if (before) await fsp.writeFile(configPath, before, { mode: 0o600 });
      const env = scopedEnvironment(codexHome, temp);
      if (operation.action === 'edit') {
        const removed = await this.run(executable, ['mcp', 'remove', operation.name], { cwd: temp, env, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
        if (removed.code !== 0 || removed.timedOut) return failedTransform('codex_mcp_edit_remove_failed');
      }
      const args = operation.action === 'remove'
        ? ['mcp', 'remove', operation.name]
        : buildCodexMcpAddArgs(operation.server);
      if (!args) return unavailableTransform('codex_cli_mutation_unsupported');
      const result = await this.run(executable, args, { cwd: temp, env, timeoutMs: 10_000, maxOutputBytes: 256 * 1024 });
      if (result.code !== 0 || result.timedOut) return failedTransform('codex_mcp_mutation_failed');
      const text = await fsp.readFile(configPath, 'utf8').catch(() => '');
      return { available: true, ok: true, used: true, text, unsupported_reason: null, public_error: null };
    } catch {
      return failedTransform('codex_mcp_cli_transform_failed');
    } finally {
      if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async login(ref: ResolvedMcpScope, name: string, scopes: readonly string[] = []): Promise<CodexCliAuthResult> {
    const args = ['mcp', 'login', name];
    if (scopes.length) args.push('--scopes', scopes.join(','));
    return this.auth(ref, args);
  }

  async logout(ref: ResolvedMcpScope, name: string): Promise<CodexCliAuthResult> {
    return this.auth(ref, ['mcp', 'logout', name]);
  }

  private async auth(ref: ResolvedMcpScope, args: string[]): Promise<CodexCliAuthResult> {
    try {
      const executable = await this.executable();
      if (!executable) return { available: false, ok: false, public_error: 'codex_cli_not_found' };
      const result = await this.run(executable, args, {
        cwd: ref.root,
        env: scopedEnvironment(ref.codexHome),
        timeoutMs: 5 * 60_000,
        maxOutputBytes: 256 * 1024
      });
      return {
        available: true,
        ok: result.code === 0 && !result.timedOut,
        public_error: result.code === 0 && !result.timedOut ? null : 'codex_mcp_auth_failed'
      };
    } catch {
      return { available: true, ok: false, public_error: 'codex_mcp_auth_failed' };
    }
  }

  private async executable(): Promise<string | null> {
    return this.configuredPath || await this.findExecutable('codex');
  }
}

export function buildCodexMcpAddArgs(input: McpServerMutationInput | undefined): string[] | null {
  if (!input || !isOfficialServerName(input.name)) return null;
  const args = ['mcp', 'add', input.name];
  if (input.transport === 'streamable-http') {
    if (!input.url) return null;
    args.push('--url', input.url);
    if (input.bearer_token_env_var) args.push('--bearer-token-env-var', input.bearer_token_env_var);
    if (input.oauth_client_id) args.push('--oauth-client-id', input.oauth_client_id);
    if (input.oauth_resource) args.push('--oauth-resource', input.oauth_resource);
    return args;
  }
  if (!input.command) return null;
  return [...args, '--', input.command, ...(input.args || [])];
}

export function isOfficialServerName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name);
}

function scopedEnvironment(codexHome: string, home = process.env.HOME || os.homedir()): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, CODEX_HOME: codexHome };
}

function parseListRow(value: unknown): McpCliInventoryRow | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return {
    name: value.name,
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(typeof value.disabled_reason === 'string' || value.disabled_reason === null ? { disabled_reason: value.disabled_reason } : {}),
    ...(typeof value.auth_status === 'string' || value.auth_status === null ? { auth_status: value.auth_status } : {}),
    ...(typeof value.startup_timeout_sec === 'number' || value.startup_timeout_sec === null ? { startup_timeout_sec: value.startup_timeout_sec } : {}),
    ...(typeof value.tool_timeout_sec === 'number' || value.tool_timeout_sec === null ? { tool_timeout_sec: value.tool_timeout_sec } : {})
  };
}

function unavailableTransform(reason: string): CodexCliTransformResult {
  return { available: reason !== 'codex_cli_not_found', ok: false, used: false, text: null, unsupported_reason: reason, public_error: null };
}

function failedTransform(publicError: CodexTransformPublicError): CodexCliTransformResult {
  return {
    available: true,
    ok: false,
    used: true,
    text: null,
    unsupported_reason: null,
    public_error: publicError
  };
}

async function defaultRun(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number }
): Promise<RunProcessResult> {
  return runProcess(command, [...args], options);
}
