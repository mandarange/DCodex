import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { withFileLock } from '../locks/file-lock.js';
import { createMcpBackup, finalizeMcpBackup } from './backup.js';
import { CodexMcpCliAdapter, type CodexMcpCliPort, type CodexCliMutationOperation } from './codex-cli-adapter.js';
import { isRecord, privateInlineEnvironment, rawStringArray, readMcpConfigDocument } from './config-reader.js';
import { removeMcpServerText as removeServerText, renderMcpServerBlock, replaceOrAppendMcpServer, setMcpServerEnabledText as setEnabledText } from './guarded-patch.js';
import { listMcpInventory, type McpInventoryOptions } from './inventory.js';
import { redactMcpError, redactMcpErrorWithSecrets } from './redaction.js';
import { isOfficialMcpServerName, McpSecretPolicyError, normalizeApprovalMode, normalizeMcpMutationInput, normalizeMcpServerName } from './secret-policy.js';
import { McpScopeError, resolveMcpScope, type ResolvedMcpScope } from './scope.js';
import { MCP_MUTATION_SCHEMA, type McpMutationResultV2, type McpServerMutationInput, type McpWritableScope } from './types.js';
import { messageOf } from '../errors/message.js';

export interface McpMutationOptions extends McpInventoryOptions {
  readonly cli?: CodexMcpCliPort;
}

export async function addMcpServer(input: unknown, scope: McpWritableScope, options: McpMutationOptions = {}): Promise<McpMutationResultV2> {
  let normalized: McpServerMutationInput;
  try { normalized = normalizeMcpMutationInput(input); } catch (error) { return inputFailure('add', null, scope, error); }
  if (!isOfficialMcpServerName(normalized.name)) return failure('add', normalized.name, scope, ['invalid_mcp_server_name_for_codex_cli']);
  return runMutation('add', normalized.name, scope, options, { input: normalized });
}

export async function editMcpServer(
  nameInput: unknown,
  patch: unknown,
  scope: McpWritableScope,
  options: McpMutationOptions = {}
): Promise<McpMutationResultV2> {
  const name = normalizeMcpServerName(nameInput);
  if (!name) return failure('edit', null, scope, ['invalid_mcp_server_name']);
  if (!isRecord(patch)) return failure('edit', name, scope, ['mcp_edit_patch_required']);
  if ('env' in patch) return failure('edit', name, scope, ['mcp_raw_secret_storage_forbidden']);
  return runMutation('edit', name, scope, options, { patch });
}

export async function duplicateMcpServer(
  sourceInput: unknown,
  newNameInput: unknown,
  scope: McpWritableScope,
  options: McpMutationOptions = {}
): Promise<McpMutationResultV2> {
  const sourceName = normalizeMcpServerName(sourceInput);
  const newName = normalizeMcpServerName(newNameInput);
  if (!sourceName || !newName || !isOfficialMcpServerName(newName)) return failure('duplicate', newName, scope, ['invalid_mcp_server_name']);
  return runMutation('duplicate', newName, scope, options, { sourceName });
}

export async function setMcpServerEnabled(
  nameInput: unknown,
  enabled: boolean,
  scope: McpWritableScope,
  options: McpMutationOptions = {}
): Promise<McpMutationResultV2> {
  const name = normalizeMcpServerName(nameInput);
  if (!name) return failure(enabled ? 'enable' : 'disable', null, scope, ['invalid_mcp_server_name']);
  return runMutation(enabled ? 'enable' : 'disable', name, scope, options, { enabled });
}

export async function removeMcpServer(
  nameInput: unknown,
  scope: McpWritableScope,
  options: McpMutationOptions = {}
): Promise<McpMutationResultV2> {
  const name = normalizeMcpServerName(nameInput);
  if (!name) return failure('remove', null, scope, ['invalid_mcp_server_name']);
  return runMutation('remove', name, scope, options, {});
}

type MutationAction = Exclude<McpMutationResultV2['action'], 'restore'>;
type MutationRequest = { readonly input?: McpServerMutationInput; readonly patch?: Record<string, unknown>; readonly sourceName?: string; readonly enabled?: boolean };
type LegacySecretDecision =
  | { readonly ok: true; readonly action: 'leave_unchanged'; readonly envNames: string[] }
  | { readonly ok: true; readonly action: 'move_to_secure_reference'; readonly envNames: string[] }
  | { readonly ok: false; readonly blockers: string[] };

const LEGACY_SECRET_ACTION = 'legacy_inline_secret_action';
const REVIEWED_LEGACY_ENV_KEYS = 'reviewed_legacy_env_keys';
const SAFE_TRANSFORM_UNSUPPORTED_REASONS = new Set([
  'codex_cli_not_found',
  'codex_cli_server_name_unsupported',
  'codex_cli_mutation_unsupported'
]);

async function runMutation(
  action: MutationAction,
  name: string,
  scope: McpWritableScope,
  options: McpMutationOptions,
  request: MutationRequest
): Promise<McpMutationResultV2> {
  let ref: ResolvedMcpScope;
  let sensitiveInlineValues: string[] = [];
  try {
    ref = await resolveMcpScope(scope, options);
    if (scope === 'project' && options.confirmProjectMutation !== true) throw new McpScopeError('mcp_project_mutation_confirmation_required');
  } catch (error) {
    return failure(action, name, scope, [error instanceof McpScopeError ? error.code : 'mcp_scope_invalid'], redactMcpError(error));
  }
  const cli = options.cli ?? new CodexMcpCliAdapter({ ...(options.codexPath ? { codexPath: options.codexPath } : {}) });
  try {
    return await withFileLock({ lockPath: `${ref.configPath}.sks-mcp.lock`, timeoutMs: 10_000, staleMs: 60_000 }, async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const document = await readMcpConfigDocument(ref);
        sensitiveInlineValues = mergeSensitiveValues(sensitiveInlineValues, inlineEnvironmentStringValues(document.rawServers));
        const prepared = prepareMutation(action, name, document.rawServers, request);
        if (!prepared.ok) return failure(action, name, scope, prepared.blockers, null, attempt);
        const generated = await generateNextText(
          cli,
          document.text,
          action,
          name,
          prepared.input,
          prepared.legacyEnv,
          request.enabled,
          sensitiveInlineValues
        );
        if (!generated.ok || generated.text === null) {
          return failure(action, name, scope, generated.blockers, generated.publicError, attempt, generated.cliUsed, generated.fallbackUsed);
        }
        const backup = await createMcpBackup(ref, document.text, action, name);
        const write = await writeCodexConfigGuarded({
          root: ref.root,
          configPath: ref.configPath,
          before: document.text,
          cause: `mcp-config-${action}`,
          backupTag: `mcp-config-${action}`,
          ownershipVerified: true,
          verifyUnchangedBeforeWrite: true,
          expectedBeforeExists: document.exists,
          preserveFastUiKeys: false,
          preserveTextFormatting: true,
          mutate: () => generated.text as string
        });
        if (!write.ok && write.status === 'concurrent_change_detected' && attempt < 3) continue;
        if (!write.ok) return failure(action, name, scope, [`mcp_config_write_${write.status}`], null, attempt, generated.cliUsed, generated.fallbackUsed);
        let finalized;
        try {
          finalized = await finalizeMcpBackup(backup, generated.text);
        } catch (error) {
          return postWriteReceiptFailure(action, name, scope, write.changed, backup.metadata.id, attempt, generated, error, sensitiveInlineValues);
        }
        const inventory = await listMcpInventory(scope, { ...options, cli: safeInventoryCli(cli) });
        return {
          schema: MCP_MUTATION_SCHEMA,
          ok: true,
          action,
          name,
          scope,
          changed: write.changed,
          official_cli_used: generated.cliUsed,
          fallback_used: generated.fallbackUsed,
          backup_id: finalized.id,
          restart_required: write.changed,
          servers: inventory.servers,
          blockers: [],
          warnings: [...new Set(['changes_apply_to_new_codex_sessions', ...generated.warnings])],
          attempts: attempt,
          public_error: null
        };
      }
      return failure(action, name, scope, ['mcp_config_busy'], null, 3);
    });
  } catch (error) {
    const blocker = messageOf(error).startsWith('file_lock_timeout:') ? 'mcp_config_busy' : 'mcp_mutation_failed';
    return failure(action, name, scope, [blocker], safeMutationPublicError(error, sensitiveInlineValues, blocker));
  }
}

function prepareMutation(
  action: MutationAction,
  name: string,
  servers: Readonly<Record<string, Record<string, unknown>>>,
  request: MutationRequest
): { ok: true; input: McpServerMutationInput | null; legacyEnv: Record<string, string> } | { ok: false; blockers: string[] } {
  const existing = servers[name] || null;
  if (action === 'add' && existing) return { ok: false, blockers: ['mcp_server_already_exists'] };
  if (action !== 'add' && action !== 'duplicate' && !existing) return { ok: false, blockers: ['mcp_server_not_found'] };
  if (action === 'remove' || action === 'enable' || action === 'disable') return { ok: true, input: null, legacyEnv: {} };
  if (action === 'add') return { ok: true, input: request.input || null, legacyEnv: {} };
  const source = action === 'duplicate' ? servers[request.sourceName || ''] || null : existing;
  if (!source) return { ok: false, blockers: ['mcp_source_server_not_found'] };
  const legacyEnv = privateInlineEnvironment(source);
  if (action === 'duplicate' && isRecord(source.env) && Object.keys(source.env).length) {
    return { ok: false, blockers: ['mcp_duplicate_legacy_inline_secret_forbidden'] };
  }
  const legacyDecision = legacySecretDecision(source, request.patch, legacyEnv);
  if (!legacyDecision.ok) return legacyDecision;
  const base = mutationInputFromRaw(action === 'duplicate' ? name : name, source);
  const patch = action === 'edit' ? withoutLegacySecretControls(request.patch || {}) : {};
  const merged = action === 'edit' ? { ...base, ...patch, name } : { ...base, name };
  try {
    let input = normalizeMcpMutationInput(merged);
    if (legacyDecision.action === 'move_to_secure_reference') {
      input = normalizeMcpMutationInput({
        ...input,
        env_vars: [...new Set([...(input.env_vars || []), ...legacyDecision.envNames])].sort()
      });
    }
    return {
      ok: true,
      input,
      legacyEnv: legacyDecision.action === 'move_to_secure_reference' ? {} : legacyEnv
    };
  } catch (error) {
    return { ok: false, blockers: error instanceof McpSecretPolicyError ? error.blockers : ['mcp_mutation_input_invalid'] };
  }
}

function legacySecretDecision(
  source: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>> | undefined,
  legacyEnv: Readonly<Record<string, string>>
): LegacySecretDecision {
  const hasAction = patch ? Object.prototype.hasOwnProperty.call(patch, LEGACY_SECRET_ACTION) : false;
  const hasReview = patch ? Object.prototype.hasOwnProperty.call(patch, REVIEWED_LEGACY_ENV_KEYS) : false;
  if (!hasAction && !hasReview) return { ok: true, action: 'leave_unchanged', envNames: [] };

  const action = patch?.[LEGACY_SECRET_ACTION];
  if (action === 'leave_unchanged') {
    return hasReview
      ? { ok: false, blockers: ['mcp_legacy_secret_review_not_allowed_for_leave_unchanged'] }
      : { ok: true, action, envNames: [] };
  }
  if (action !== 'move_to_secure_reference') {
    return { ok: false, blockers: ['invalid_mcp_legacy_secret_action'] };
  }
  if (typeof source.url === 'string') {
    return { ok: false, blockers: ['mcp_legacy_secret_migration_requires_stdio'] };
  }

  const inline = isRecord(source.env) ? source.env : {};
  const inlineKeys = Object.keys(inline).sort();
  if (!inlineKeys.length) return { ok: false, blockers: ['mcp_legacy_inline_secret_not_found'] };
  const migratableKeys = Object.keys(legacyEnv).sort();
  if (inlineKeys.length !== migratableKeys.length || inlineKeys.some((key, index) => key !== migratableKeys[index])) {
    return { ok: false, blockers: ['mcp_legacy_secret_secure_reference_names_unavailable'] };
  }

  const reviewed = patch?.[REVIEWED_LEGACY_ENV_KEYS];
  if (!Array.isArray(reviewed) || reviewed.some((key) => typeof key !== 'string')) {
    return { ok: false, blockers: ['mcp_legacy_secret_review_required'] };
  }
  const reviewedNames = reviewed.map(String);
  const uniqueReviewed = [...new Set(reviewedNames)].sort();
  if (reviewedNames.length !== uniqueReviewed.length
    || uniqueReviewed.length !== migratableKeys.length
    || uniqueReviewed.some((key, index) => key !== migratableKeys[index])) {
    return { ok: false, blockers: ['mcp_legacy_secret_review_mismatch'] };
  }
  return { ok: true, action, envNames: migratableKeys };
}

function withoutLegacySecretControls(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sanitized = { ...patch };
  delete sanitized[LEGACY_SECRET_ACTION];
  delete sanitized[REVIEWED_LEGACY_ENV_KEYS];
  return sanitized;
}

async function generateNextText(
  cli: CodexMcpCliPort,
  before: string,
  action: MutationAction,
  name: string,
  input: McpServerMutationInput | null,
  legacyEnv: Readonly<Record<string, string>>,
  enabled: boolean | undefined,
  sensitiveInlineValues: readonly string[]
): Promise<{ ok: boolean; text: string | null; cliUsed: boolean; fallbackUsed: boolean; warnings: string[]; blockers: string[]; publicError: string | null }> {
  if (action === 'enable' || action === 'disable') {
    const text = setEnabledText(before, name, enabled === true);
    return text === null
      ? generatedFailure(['mcp_server_table_not_found'])
      : { ok: true, text, cliUsed: false, fallbackUsed: true, warnings: ['guarded_targeted_patch_used'], blockers: [], publicError: null };
  }
  const operation: CodexCliMutationOperation = {
    action,
    name,
    ...(input ? { server: input } : {})
  };
  const transformed = await cli.transform(before, operation).catch(() => ({
    available: true, ok: false, used: true, text: null, unsupported_reason: null, public_error: 'codex_mcp_cli_transform_failed'
  }));
  const unsupportedReason = safeTransformUnsupportedReason(transformed.unsupported_reason, sensitiveInlineValues);
  if (transformed.ok && typeof transformed.text === 'string') {
    if (action === 'remove') return { ok: true, text: transformed.text, cliUsed: true, fallbackUsed: false, warnings: [], blockers: [], publicError: null };
    if (!input) return generatedFailure(['mcp_mutation_input_missing']);
    return {
      ok: true,
      text: replaceOrAppendMcpServer(transformed.text, name, renderMcpServerBlock(input, legacyEnv)),
      cliUsed: true,
      fallbackUsed: false,
      warnings: [], blockers: [], publicError: null
    };
  }
  if (transformed.used && !unsupportedReason) {
    return generatedFailure(['codex_mcp_cli_mutation_failed'], 'codex_mcp_cli_mutation_failed');
  }
  if (action === 'remove') {
    const text = removeServerText(before, name);
    return text === null ? generatedFailure(['mcp_server_table_not_found']) : fallbackGenerated(text, unsupportedReason);
  }
  if (!input) return generatedFailure(['mcp_mutation_input_missing']);
  return fallbackGenerated(replaceOrAppendMcpServer(before, name, renderMcpServerBlock(input, legacyEnv)), unsupportedReason);
}

function mutationInputFromRaw(name: string, value: Record<string, unknown>): Record<string, unknown> {
  const url = typeof value.url === 'string' ? value.url : null;
  const tools = isRecord(value.tools) ? value.tools : {};
  const toolModes: Record<string, string> = {};
  for (const [tool, raw] of Object.entries(tools)) {
    if (isRecord(raw) && normalizeApprovalMode(raw.approval_mode)) toolModes[tool] = String(raw.approval_mode);
  }
  return {
    name,
    transport: url ? 'streamable-http' : 'stdio',
    enabled: value.enabled !== false && value.disabled !== true,
    ...(url ? { url } : {}),
    ...(typeof value.command === 'string' ? { command: value.command } : {}),
    ...(rawStringArray(value.args).length ? { args: rawStringArray(value.args) } : {}),
    ...(rawStringArray(value.env_vars).length ? { env_vars: rawStringArray(value.env_vars) } : {}),
    ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}),
    ...(value.experimental_environment === 'remote' ? { experimental_environment: 'remote' } : {}),
    ...(typeof value.bearer_token_env_var === 'string' ? { bearer_token_env_var: value.bearer_token_env_var } : {}),
    ...(typeof value.oauth_client_id === 'string' ? { oauth_client_id: value.oauth_client_id } : {}),
    ...(typeof value.oauth_resource === 'string' ? { oauth_resource: value.oauth_resource } : {}),
    ...(typeof value.startup_timeout_sec === 'number' ? { startup_timeout_sec: value.startup_timeout_sec } : {}),
    ...(typeof value.tool_timeout_sec === 'number' ? { tool_timeout_sec: value.tool_timeout_sec } : {}),
    ...(rawStringArray(value.enabled_tools).length ? { enabled_tools: rawStringArray(value.enabled_tools) } : {}),
    ...(rawStringArray(value.disabled_tools).length ? { disabled_tools: rawStringArray(value.disabled_tools) } : {}),
    ...(normalizeApprovalMode(value.default_tools_approval_mode ?? value.approval_mode) ? { default_tools_approval_mode: value.default_tools_approval_mode ?? value.approval_mode } : {}),
    ...(Object.keys(toolModes).length ? { tool_approval_modes: toolModes } : {}),
    ...(typeof value.required === 'boolean' ? { required: value.required } : {})
  };
}

function inlineEnvironmentStringValues(
  servers: Readonly<Record<string, Record<string, unknown>>>
): string[] {
  const values: string[] = [];
  for (const server of Object.values(servers)) {
    if (!isRecord(server.env)) continue;
    for (const value of Object.values(server.env)) {
      if (typeof value === 'string' && value.length > 0) values.push(value);
    }
  }
  return [...new Set(values)];
}

function mergeSensitiveValues(left: readonly string[], right: readonly string[]): string[] {
  return [...new Set([...left, ...right].filter((value) => value.length > 0))];
}

function safeTransformUnsupportedReason(
  value: string | null,
  sensitiveInlineValues: readonly string[]
): string | null {
  if (value === null) return null;
  const redacted = redactMcpErrorWithSecrets(value, sensitiveInlineValues);
  return SAFE_TRANSFORM_UNSUPPORTED_REASONS.has(redacted)
    ? redacted
    : 'codex_cli_mutation_unsupported';
}

function safeMutationPublicError(
  error: unknown,
  sensitiveInlineValues: readonly string[],
  fallback: string
): string {
  const redacted = redactMcpErrorWithSecrets(error, sensitiveInlineValues);
  return /^(?:mcp|codex)_[a-z0-9_]+$/.test(redacted) ? redacted : fallback;
}

function safeInventoryCli(cli: CodexMcpCliPort): CodexMcpCliPort {
  return {
    async list(ref) {
      try {
        const result = await cli.list(ref);
        if (result.ok) return { ...result, public_error: null };
        return {
          available: result.available === true,
          ok: false,
          rows: [],
          public_error: result.available === false ? 'codex_cli_not_found' : 'codex_mcp_list_failed'
        };
      } catch {
        return { available: true, ok: false, rows: [], public_error: 'codex_mcp_list_failed' };
      }
    },
    transform: (before, operation) => cli.transform(before, operation),
    login: (ref, serverName, scopes) => cli.login(ref, serverName, scopes),
    logout: (ref, serverName) => cli.logout(ref, serverName)
  };
}

function inputFailure(action: MutationAction, name: string | null, scope: McpWritableScope, error: unknown): McpMutationResultV2 {
  return failure(action, name, scope, error instanceof McpSecretPolicyError ? error.blockers : ['mcp_mutation_input_invalid'], redactMcpError(error));
}

function failure(
  action: MutationAction,
  name: string | null,
  scope: McpWritableScope,
  blockers: string[],
  publicError: string | null = null,
  attempts = 0,
  cliUsed = false,
  fallbackUsed = false
): McpMutationResultV2 {
  return {
    schema: MCP_MUTATION_SCHEMA, ok: false, action, name, scope, changed: false,
    official_cli_used: cliUsed, fallback_used: fallbackUsed, backup_id: null, restart_required: false,
    servers: [], blockers, warnings: [], attempts, public_error: publicError
  };
}

function postWriteReceiptFailure(
  action: MutationAction,
  name: string,
  scope: McpWritableScope,
  changed: boolean,
  backupId: string,
  attempts: number,
  generated: Awaited<ReturnType<typeof generateNextText>>,
  error: unknown,
  sensitiveInlineValues: readonly string[]
): McpMutationResultV2 {
  return {
    schema: MCP_MUTATION_SCHEMA, ok: false, action, name, scope, changed,
    official_cli_used: generated.cliUsed, fallback_used: generated.fallbackUsed,
    backup_id: backupId, restart_required: changed, servers: [],
    blockers: ['mcp_backup_receipt_failed_after_write'], warnings: generated.warnings,
    attempts, public_error: safeMutationPublicError(error, sensitiveInlineValues, 'mcp_backup_receipt_failed_after_write')
  };
}

function fallbackGenerated(text: string, reason: string | null): Awaited<ReturnType<typeof generateNextText>> {
  return { ok: true, text, cliUsed: false, fallbackUsed: true, warnings: [reason || 'codex_cli_unavailable_guarded_patch_used'], blockers: [], publicError: null };
}

function generatedFailure(blockers: string[], publicError: string | null = null): Awaited<ReturnType<typeof generateNextText>> {
  return { ok: false, text: null, cliUsed: false, fallbackUsed: false, warnings: [], blockers, publicError };
}
