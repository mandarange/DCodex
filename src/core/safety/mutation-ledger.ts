import path from 'node:path'
import { appendJsonl, ensureDir, nowIso } from '../fsx.js'
import { isMutationAllowed, type MutationKind, type RequestedScopeContract } from './requested-scope-contract.js'

export const MUTATION_LEDGER_SCHEMA = 'sks.mutation-ledger.v1'

// Every kind of mutation SKS can perform. Anything here must be recorded.
export const MUTATION_KINDS = [
  'file_write',
  'file_delete',
  'file_rename',
  'chmod',
  'chflags',
  'xattr',
  'global_config_write',
  'package_install',
  'process_kill',
  'codex_app_flag_change',
  'codex_lb_auth_change',
  'database_write',
  'skill_snapshot_promotion'
] as const

export type MutationLedgerKind = (typeof MUTATION_KINDS)[number]

// Which contract scope each ledger kind maps to.
const KIND_TO_SCOPE: Record<MutationLedgerKind, MutationKind> = {
  file_write: 'project_files',
  file_delete: 'project_files',
  file_rename: 'project_files',
  chmod: 'project_files',
  chflags: 'project_files',
  xattr: 'project_files',
  global_config_write: 'global_codex_config',
  package_install: 'package_install',
  process_kill: 'codex_app_process',
  codex_app_flag_change: 'global_codex_config',
  codex_lb_auth_change: 'codex_lb_auth',
  database_write: 'project_files',
  skill_snapshot_promotion: 'skill_snapshot_promotion'
}

export interface MutationLedgerEntry {
  schema: string
  ts: string
  route: string
  kind: MutationLedgerKind
  target: string
  requested_scope_allowed: boolean
  applied: boolean
  backup_path?: string | null
  no_op_reason?: string | null
  reason?: string
}

export function mutationLedgerPath(root: string): string {
  return path.join(path.resolve(root), '.sneakoscope', 'reports', 'mutation-ledger.jsonl')
}

/**
 * Evaluate a mutation against the contract WITHOUT applying it. A mutation that is
 * out of scope, or a config/skill mutation lacking a backup or no-op reason, is a
 * violation that callers must not apply.
 */
export function evaluateMutation(
  contract: RequestedScopeContract,
  kind: MutationLedgerKind,
  opts: { target: string; confirmed?: boolean; backupPath?: string | null; noOpReason?: string | null; applied: boolean }
): MutationLedgerEntry & { violation: boolean } {
  const scope = KIND_TO_SCOPE[kind]
  const decision = isMutationAllowed(contract, scope, { confirmed: opts.confirmed === true })
  const needsBackup = kind === 'global_config_write' || kind === 'codex_app_flag_change' || kind === 'codex_lb_auth_change' || kind === 'skill_snapshot_promotion'
  const hasBackupOrNoop = Boolean(opts.backupPath) || Boolean(opts.noOpReason)
  // Violations: applied without scope permission, or a config/skill mutation applied
  // without a backup/no-op reason.
  const violation = (opts.applied && !decision.allowed) || (opts.applied && needsBackup && !hasBackupOrNoop)
  return {
    schema: MUTATION_LEDGER_SCHEMA,
    ts: nowIso(),
    route: contract.route,
    kind,
    target: opts.target,
    requested_scope_allowed: decision.allowed,
    applied: opts.applied,
    backup_path: opts.backupPath ?? null,
    no_op_reason: opts.noOpReason ?? null,
    reason: decision.reason,
    violation
  }
}

export async function recordMutation(root: string, entry: MutationLedgerEntry): Promise<string> {
  const file = mutationLedgerPath(root)
  if (entry.route === 'internal:file-lock') return file
  await ensureDir(path.dirname(file))
  await appendJsonl(file, entry)
  return file
}
