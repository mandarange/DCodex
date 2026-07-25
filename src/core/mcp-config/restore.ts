import { writeCodexConfigGuarded } from '../codex/codex-config-guard.js';
import { withFileLock } from '../locks/file-lock.js';
import { createMcpBackup, finalizeMcpBackup, loadMcpBackup } from './backup.js';
import { CodexMcpCliAdapter } from './codex-cli-adapter.js';
import { readMcpConfigDocument } from './config-reader.js';
import { listMcpInventory } from './inventory.js';
import type { McpMutationOptions } from './mutation.js';
import { redactMcpError } from './redaction.js';
import { McpScopeError, resolveMcpScope } from './scope.js';
import { MCP_MUTATION_SCHEMA, type McpMutationResultV2, type McpWritableScope } from './types.js';
import { messageOf } from '../errors/message.js';

export async function restoreMcpBackup(
  backupId: string,
  scope: McpWritableScope,
  options: McpMutationOptions = {}
): Promise<McpMutationResultV2> {
  let ref;
  try {
    ref = await resolveMcpScope(scope, options);
    if (scope === 'project' && options.confirmProjectMutation !== true) throw new McpScopeError('mcp_project_mutation_confirmation_required');
  } catch (error) {
    return failure(scope, [error instanceof McpScopeError ? error.code : 'mcp_scope_invalid'], redactMcpError(error));
  }
  try {
    return await withFileLock({ lockPath: `${ref.configPath}.sks-mcp.lock`, timeoutMs: 10_000, staleMs: 60_000 }, async () => {
      const [document, backup] = await Promise.all([readMcpConfigDocument(ref), loadMcpBackup(ref, backupId)]);
      const rollback = await createMcpBackup(ref, document.text, 'restore', backup.metadata.server);
      const write = await writeCodexConfigGuarded({
        root: ref.root,
        configPath: ref.configPath,
        before: document.text,
        cause: 'mcp-config-restore',
        backupTag: 'mcp-config-restore',
        ownershipVerified: true,
        verifyUnchangedBeforeWrite: true,
        expectedBeforeExists: document.exists,
        preserveFastUiKeys: false,
        preserveTextFormatting: true,
        mutate: () => backup.text
      });
      if (!write.ok) return failure(scope, [`mcp_config_write_${write.status}`]);
      let finalized;
      try {
        finalized = await finalizeMcpBackup(rollback, backup.text);
      } catch (error) {
        return {
          schema: MCP_MUTATION_SCHEMA,
          ok: false,
          action: 'restore',
          name: backup.metadata.server,
          scope,
          changed: write.changed,
          official_cli_used: false,
          fallback_used: true,
          backup_id: rollback.metadata.id,
          restart_required: write.changed,
          servers: [],
          blockers: ['mcp_backup_receipt_failed_after_write'],
          warnings: ['guarded_restore_used'],
          attempts: 1,
          public_error: redactMcpError(error)
        };
      }
      const cli = options.cli ?? new CodexMcpCliAdapter({ ...(options.codexPath ? { codexPath: options.codexPath } : {}) });
      const inventory = await listMcpInventory(scope, { ...options, cli });
      return {
        schema: MCP_MUTATION_SCHEMA,
        ok: true,
        action: 'restore',
        name: backup.metadata.server,
        scope,
        changed: write.changed,
        official_cli_used: false,
        fallback_used: true,
        backup_id: finalized.id,
        restart_required: write.changed,
        servers: inventory.servers,
        blockers: [],
        warnings: ['changes_apply_to_new_codex_sessions', 'guarded_restore_used'],
        attempts: 1,
        public_error: null
      };
    });
  } catch (error) {
    return failure(scope, [messageOf(error).startsWith('file_lock_timeout:') ? 'mcp_config_busy' : 'mcp_restore_failed'], redactMcpError(error));
  }
}

function failure(scope: McpWritableScope, blockers: string[], publicError: string | null = null): McpMutationResultV2 {
  return {
    schema: MCP_MUTATION_SCHEMA,
    ok: false,
    action: 'restore',
    name: null,
    scope,
    changed: false,
    official_cli_used: false,
    fallback_used: false,
    backup_id: null,
    restart_required: false,
    servers: [],
    blockers,
    warnings: [],
    attempts: 0,
    public_error: publicError
  };
}
