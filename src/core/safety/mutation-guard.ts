import fsp from 'node:fs/promises'
import path from 'node:path'
import { runProcess, writeTextAtomic } from '../fsx.js'
import { isMutationAllowed, isPathAllowed, type MutationKind, type RequestedScopeContract } from './requested-scope-contract.js'
import { evaluateMutation, recordMutation, type MutationLedgerKind } from './mutation-ledger.js'

// Mutation Guard Adapter (1.20.2 Area 1a).
//
// Thin wrappers that force every genuinely-risky mutation through the existing
// Requested-Scope-Contract + Mutation-Ledger before it touches the filesystem or
// spawns a process. This layer adds NO new IO primitives and NO new scope/ledger
// logic — it composes `isMutationAllowed`/`evaluateMutation`/`recordMutation` from
// requested-scope-contract.ts + mutation-ledger.ts and delegates the actual op to
// fsx/fsp/runProcess. A scope violation throws BEFORE the mutation is applied; a
// config/skill mutation lacking a backup or no-op reason throws; every applied
// mutation is recorded to the ledger.

export const MUTATION_GUARD_SCHEMA = 'sks.mutation-guard.v1'

export class MutationGuardViolationError extends Error {
  readonly kind: MutationLedgerKind
  readonly target: string
  readonly reason: string
  constructor(kind: MutationLedgerKind, target: string, reason: string) {
    super(`mutation_guard_violation:${kind}:${reason}:${target}`)
    this.name = 'MutationGuardViolationError'
    this.kind = kind
    this.target = target
    this.reason = reason
  }
}

export interface GuardContext {
  root: string
  contract: RequestedScopeContract
  reason?: string
}

export interface GuardOptions {
  confirmed?: boolean
  backupPath?: string | null
  noOpReason?: string | null
  pathTargets?: string[]
}

// Config/skill mutations that must carry a backup or a no-op reason (mirrors the
// `needsBackup` rule inside evaluateMutation so the guard can pre-validate).
const NEEDS_BACKUP: ReadonlySet<MutationLedgerKind> = new Set([
  'global_config_write',
  'codex_app_flag_change',
  'codex_lb_auth_change',
  'skill_snapshot_promotion'
])

/**
 * Core guard: validate scope + backup BEFORE applying, run `apply`, then record
 * the mutation to the ledger. Throws MutationGuardViolationError without applying
 * when the mutation is out of scope or a backup-requiring mutation has neither a
 * backup nor a no-op reason. On apply failure, records `applied:false` + reason
 * and rethrows the underlying error.
 */
async function guard<T>(
  ctx: GuardContext,
  kind: MutationLedgerKind,
  target: string,
  opts: GuardOptions,
  apply: () => Promise<T>
): Promise<T> {
  const evalOpts = buildEvalOpts(target, opts, false)
  // Pre-apply scope check (applied:false → violation reflects scope only).
  const scope = isMutationAllowed(ctx.contract, scopeForKind(kind), { confirmed: opts.confirmed === true })
  if (!scope.allowed) throw new MutationGuardViolationError(kind, target, scope.reason)
  for (const pathTarget of pathTargetsFor(kind, target, opts)) {
    const pathDecision = isPathAllowed(ctx.contract, pathTarget)
    if (!pathDecision.allowed) throw new MutationGuardViolationError(kind, pathTarget, pathDecision.reason)
  }
  if (NEEDS_BACKUP.has(kind) && !opts.backupPath && !opts.noOpReason) {
    throw new MutationGuardViolationError(kind, target, 'backup_or_no_op_reason_required')
  }
  void evalOpts
  try {
    const result = await apply()
    const entry = evaluateMutation(ctx.contract, kind, buildEvalOpts(target, opts, true))
    await recordMutation(ctx.root, entry)
    if (entry.violation) throw new MutationGuardViolationError(kind, target, entry.reason || 'post_apply_violation')
    return result
  } catch (err) {
    if (err instanceof MutationGuardViolationError) throw err
    const failed = evaluateMutation(ctx.contract, kind, { ...buildEvalOpts(target, opts, false), noOpReason: `apply_failed:${(err as Error)?.message || String(err)}` })
    await recordMutation(ctx.root, failed).catch(() => {})
    throw err
  }
}

function scopeForKind(kind: MutationLedgerKind): MutationKind {
  // Reuse the ledger's KIND_TO_SCOPE indirectly: evaluateMutation already maps it,
  // but the pre-apply scope check needs the contract scope directly. Mirror the map.
  switch (kind) {
    case 'global_config_write':
    case 'codex_app_flag_change':
      return 'global_codex_config'
    case 'package_install':
      return 'package_install'
    case 'process_kill':
      return 'codex_app_process'
    case 'codex_lb_auth_change':
      return 'codex_lb_auth'
    case 'skill_snapshot_promotion':
      return 'skill_snapshot_promotion'
    default:
      return 'project_files'
  }
}

function buildEvalOpts(target: string, opts: GuardOptions, applied: boolean): { target: string; confirmed?: boolean; backupPath?: string | null; noOpReason?: string | null; applied: boolean } {
  const out: { target: string; confirmed?: boolean; backupPath?: string | null; noOpReason?: string | null; applied: boolean } = { target, applied }
  if (opts.confirmed !== undefined) out.confirmed = opts.confirmed
  if (opts.backupPath !== undefined) out.backupPath = opts.backupPath
  if (opts.noOpReason !== undefined) out.noOpReason = opts.noOpReason
  return out
}

const PATH_SCOPED_KINDS: ReadonlySet<MutationLedgerKind> = new Set([
  'file_write',
  'file_delete',
  'file_rename',
  'chmod',
  'xattr',
  'chflags',
  'global_config_write'
])

function pathTargetsFor(kind: MutationLedgerKind, target: string, opts: GuardOptions): string[] {
  if (!PATH_SCOPED_KINDS.has(kind)) return []
  if (opts.pathTargets?.length) return opts.pathTargets
  if (kind === 'file_rename' && target.includes(' -> ')) return target.split(' -> ').map((s) => s.trim()).filter(Boolean)
  return [target]
}

// ---- Public guarded wrappers -------------------------------------------------

export async function guardedWriteFile(ctx: GuardContext, target: string, data: string, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'file_write', target, opts, () => writeTextAtomic(target, data))
}

export async function guardedGlobalCodexConfigWrite(ctx: GuardContext, target: string, data: string, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'global_config_write', target, opts, () => writeTextAtomic(target, data))
}

export async function guardedRm(ctx: GuardContext, target: string, opts: GuardOptions & { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  await guard(ctx, 'file_delete', target, opts, () => fsp.rm(target, { recursive: opts.recursive === true, force: opts.force !== false }))
}

export async function guardedRename(ctx: GuardContext, from: string, to: string, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'file_rename', `${from} -> ${to}`, { ...opts, pathTargets: [from, to] }, () => fsp.rename(from, to))
}

export async function guardedChmod(ctx: GuardContext, target: string, mode: number, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'chmod', target, opts, () => fsp.chmod(target, mode))
}

export async function guardedChflags(ctx: GuardContext, target: string, flag: string, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'chflags', target, opts, async () => {
    const result = await runProcess('chflags', [flag, target], { timeoutMs: 5000 })
    if (result.code !== 0) throw new Error(`chflags_failed:${result.stderr || result.code}`)
  })
}

export async function guardedXattr(ctx: GuardContext, target: string, action: { op: 'remove'; name: string } | { op: 'set'; name: string; value: string }, opts: GuardOptions = {}): Promise<void> {
  await guard(ctx, 'xattr', target, opts, async () => {
    const args = action.op === 'remove' ? ['-d', action.name, target] : ['-w', action.name, action.value, target]
    const result = await runProcess('xattr', args, { timeoutMs: 5000 })
    // xattr -d returns 1 when the attribute is already absent; treat as no-op.
    if (result.code !== 0 && !(action.op === 'remove' && result.code === 1)) {
      throw new Error(`xattr_failed:${result.stderr || result.code}`)
    }
  })
}

export async function guardedProcessKill(ctx: GuardContext, pid: number, opts: GuardOptions & { signal?: NodeJS.Signals | number } = {}): Promise<void> {
  await guard(ctx, 'process_kill', `pid:${pid}`, opts, async () => {
    process.kill(pid, opts.signal ?? 'SIGTERM')
  })
}

export async function guardedPackageInstall(
  ctx: GuardContext,
  spec: string,
  opts: GuardOptions & {
    command: string;
    args: string[];
    cwd?: string;
    timeoutMs?: number;
    maxOutputBytes?: number;
    env?: NodeJS.ProcessEnv;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  }
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return guard(ctx, 'package_install', spec, opts, async () => {
    const runOpts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes?: number; onStdout?: (chunk: string) => void; onStderr?: (chunk: string) => void } = { timeoutMs: opts.timeoutMs ?? 600000 }
    if (opts.cwd !== undefined) runOpts.cwd = opts.cwd
    if (opts.env !== undefined) runOpts.env = opts.env
    if (opts.maxOutputBytes !== undefined) runOpts.maxOutputBytes = opts.maxOutputBytes
    if (opts.onStdout !== undefined) runOpts.onStdout = opts.onStdout
    if (opts.onStderr !== undefined) runOpts.onStderr = opts.onStderr
    const result = await runProcess(opts.command, opts.args, runOpts)
    return { code: result.code, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut === true }
  })
}

export async function guardedSkillSnapshotPromotion<T>(ctx: GuardContext, skillTarget: string, opts: GuardOptions, apply: () => Promise<T>): Promise<T> {
  return guard(ctx, 'skill_snapshot_promotion', skillTarget, opts, apply)
}

// Escape hatch for callers that already have an atomic apply but want guarding:
export async function guardedApply<T>(ctx: GuardContext, kind: MutationLedgerKind, target: string, opts: GuardOptions, apply: () => Promise<T>): Promise<T> {
  return guard(ctx, kind, target, opts, apply)
}

export function guardContextForRoute(root: string, contract: RequestedScopeContract, reason?: string): GuardContext {
  const ctx: GuardContext = { root: path.resolve(root), contract }
  if (reason !== undefined) ctx.reason = reason
  return ctx
}
