import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { canonicalFilesystemPath, randomId, sameFilesystemPath, writeJsonAtomic } from '../fsx.js';
import { publicUpdateError } from './update-diagnostics.js';

export const UPDATE_OPERATION_SCHEMA = 'sks.update-operation.v1' as const;

export type UpdateOperationState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'terminal_uncertain'
  | 'rolled_back';

export interface UpdateOperationStageReceipt {
  id: string;
  ok: boolean;
  status: string;
  updated_at: string;
  detail: Record<string, unknown>;
}

export interface UpdateOperationReceipt {
  schema: typeof UPDATE_OPERATION_SCHEMA;
  id: string;
  kind: 'update' | 'rollback' | 'update_dry_run';
  state: UpdateOperationState;
  current_stage: string | null;
  started_at: string;
  updated_at: string;
  from_version: string;
  target_version: string | null;
  previous_version: string;
  project_root: string;
  registry: string;
  rollback_command: string;
  side_effects_started: boolean;
  stages: UpdateOperationStageReceipt[];
  result_status: string | null;
  public_error: string | null;
  receipt_path: string;
}

export type UpdateRollbackAuthorization =
  | { ok: true; receipt: UpdateOperationReceipt; receiptPath: string }
  | { ok: false; blocker: string; receiptPath: string | null };

export type UpdateOperationLock =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; blocker: 'update_operation_lock_held' | 'update_operation_lock_unavailable' };

const ROLLBACK_RECEIPT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const ROLLBACK_RECEIPT_SCAN_MAX_DIRECTORY_ENTRIES = 4096;
const ROLLBACK_RECEIPT_SCAN_MAX_CANDIDATES = 256;
const UPDATE_OPERATION_LOCK_SCHEMA = 'sks.update-operation-lock.v1';
const DEFAULT_UPDATE_REGISTRY = 'https://registry.npmjs.org/';
const UPDATE_OPERATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,159}$/;

interface OwnedUpdateLock {
  schema: string;
  id: string;
  pid: number;
  created_at: string;
  process_start: string | null;
}

export class UpdateOperationRecorder {
  readonly receiptPath: string;
  private receipt: UpdateOperationReceipt;
  private writes: Promise<void> = Promise.resolve();
  private readonly env: NodeJS.ProcessEnv;
  private readonly publishLatest: boolean;
  private finalized = false;

  private constructor(input: {
    env: NodeJS.ProcessEnv;
    kind: 'update' | 'rollback' | 'update_dry_run';
    fromVersion: string;
    targetVersion: string | null;
    projectRoot: string;
    registry?: string;
    publishLatest: boolean;
    now: Date;
  }) {
    this.env = input.env;
    this.publishLatest = input.publishLatest;
    const requestedId = String(input.env.SKS_UPDATE_OPERATION_ID || '').trim();
    if (requestedId && !UPDATE_OPERATION_ID_PATTERN.test(requestedId)) {
      throw new Error('update_operation_id_invalid');
    }
    const id = requestedId || `update-${input.now.toISOString().replace(/[:.]/g, '-')}-${randomId(8)}`;
    const registry = canonicalUpdateRegistry(input.registry || DEFAULT_UPDATE_REGISTRY);
    this.receiptPath = updateOperationReceiptPath(id, input.env);
    this.receipt = {
      schema: UPDATE_OPERATION_SCHEMA,
      id,
      kind: input.kind,
      state: 'queued',
      current_stage: null,
      started_at: input.now.toISOString(),
      updated_at: input.now.toISOString(),
      from_version: input.fromVersion,
      target_version: input.targetVersion,
      previous_version: input.fromVersion,
      project_root: input.projectRoot,
      registry,
      rollback_command: buildUpdateRollbackCommand(
        input.fromVersion,
        input.projectRoot,
        registry
      ),
      side_effects_started: false,
      stages: [],
      result_status: null,
      public_error: null,
      receipt_path: this.receiptPath
    };
  }

  static async create(input: {
    env?: NodeJS.ProcessEnv;
    kind?: 'update' | 'rollback' | 'update_dry_run';
    fromVersion: string;
    targetVersion: string | null;
    projectRoot: string;
    registry?: string;
    publishLatest?: boolean;
    now?: Date;
  }): Promise<UpdateOperationRecorder> {
    const projectRoot = await canonicalFilesystemPath(input.projectRoot);
    const recorder = new UpdateOperationRecorder({
      env: input.env || process.env,
      kind: input.kind || 'update',
      fromVersion: input.fromVersion,
      targetVersion: input.targetVersion,
      projectRoot,
      registry: input.registry || DEFAULT_UPDATE_REGISTRY,
      publishLatest: input.publishLatest !== false,
      now: input.now || new Date()
    });
    recorder.enqueueWrite();
    await recorder.flush();
    return recorder;
  }

  recordStage(id: string, ok: boolean, status: string, detail: Record<string, unknown> = {}): void {
    if (this.finalized) throw new Error('update_operation_receipt_finalized');
    const now = new Date().toISOString();
    const stage: UpdateOperationStageReceipt = {
      id,
      ok,
      status: String(status || (ok ? 'completed' : 'failed')).slice(0, 120),
      updated_at: now,
      detail: publicDetail(detail, this.env)
    };
    const existing = this.receipt.stages.findIndex((entry) => entry.id === id);
    if (existing >= 0) this.receipt.stages[existing] = stage;
    else this.receipt.stages.push(stage);
    this.receipt.state = 'running';
    this.receipt.current_stage = id;
    this.receipt.updated_at = now;
    const skippedSideEffect = /^(dry_run|skipped(?:_|$)|already_current)/.test(stage.status);
    if (['global_install', 'menubar_rebuild'].includes(id) && !skippedSideEffect) {
      this.receipt.side_effects_started = true;
    }
    this.enqueueWrite();
  }

  async finish(input: {
    state: Exclude<UpdateOperationState, 'queued' | 'running'>;
    resultStatus: string;
    error?: unknown;
  }): Promise<UpdateOperationReceipt> {
    if (this.finalized) throw new Error('update_operation_receipt_finalized');
    this.finalized = true;
    await this.flush();
    this.receipt.state = input.state;
    this.receipt.result_status = input.resultStatus;
    this.receipt.public_error = input.error ? publicUpdateError(input.error, this.env, 500) : null;
    this.receipt.updated_at = new Date().toISOString();
    await writePrivateJson(this.receiptPath, this.receipt);
    const confirmedInstall =
      this.receipt.kind === 'update'
      && isTerminalUpdateReceipt(this.receipt)
      && this.receipt.side_effects_started === true
      && updateReceiptHasConfirmedGlobalInstall(this.receipt);
    if (confirmedInstall) {
      const snapshot = structuredClone(this.receipt);
      const lastInstallPath = updateOperationLastInstallPath(snapshot.project_root, this.env);
      try {
        await writePrivateJson(lastInstallPath, snapshot);
      } catch {
        this.receipt.state = 'terminal_uncertain';
        this.receipt.result_status = 'terminal_uncertain';
        this.receipt.public_error = 'rollback_authorization_commit_failed';
        this.receipt.updated_at = new Date().toISOString();
        await writePrivateJson(this.receiptPath, this.receipt);
      }
    }
    if (this.publishLatest) {
      await writePrivateJson(updateOperationLatestPath(this.env), this.receipt);
    }
    return structuredClone(this.receipt);
  }

  async flush(): Promise<void> {
    await this.writes;
  }

  snapshot(): UpdateOperationReceipt {
    return structuredClone(this.receipt);
  }

  private enqueueWrite(): void {
    const snapshot = structuredClone(this.receipt);
    const latestPath = updateOperationLatestPath(this.env);
    this.writes = this.writes.then(async () => {
      await writePrivateJson(this.receiptPath, snapshot);
      if (this.publishLatest) {
        await writePrivateJson(latestPath, snapshot);
      }
    });
  }
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await writeJsonAtomic(file, value, { mode: 0o600 });
}

export function updateOperationReceiptPath(id: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = String(env.SKS_UPDATE_OPERATION_RECEIPT_PATH || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(updateGlobalRoot(env), 'operations', `${id}.json`);
}

export function updateOperationLatestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(updateGlobalRoot(env), 'operations', 'update-latest.json');
}

export async function acquireUpdateOperationLock(
  env: NodeJS.ProcessEnv = process.env
): Promise<UpdateOperationLock> {
  const operationsDir = path.join(updateGlobalRoot(env), 'operations');
  const lockPath = path.join(operationsDir, 'update.lock');
  const recoveryPath = path.join(operationsDir, 'update.lock.recovery');
  await fs.mkdir(operationsDir, { recursive: true });

  if (await ownedLockIsLive(recoveryPath)) {
    return { ok: false, blocker: 'update_operation_lock_held' };
  }
  await removeDeadOrMalformedOwnedLock(recoveryPath);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const owner = {
      schema: UPDATE_OPERATION_LOCK_SCHEMA,
      id: randomId(24),
      pid: process.pid,
      created_at: new Date().toISOString(),
      process_start: readProcessStartIdentity(process.pid)
    };
    try {
      const acquired = await createOwnedLockAtomically(lockPath, owner);
      if (!acquired) {
        if (attempt === 0 && await recoverDeadUpdateOperationLock(lockPath, recoveryPath)) continue;
        return { ok: false, blocker: 'update_operation_lock_held' };
      }
      if (await ownedLockIsLive(recoveryPath)) {
        if (!await removeOwnedLock(lockPath, owner.id)) {
          return { ok: false, blocker: 'update_operation_lock_unavailable' };
        }
        return { ok: false, blocker: 'update_operation_lock_held' };
      }
      let released = false;
      return {
        ok: true,
        release: async () => {
          if (released) return;
          if (!await removeOwnedLock(lockPath, owner.id)) {
            throw new Error('update_operation_lock_release_failed');
          }
          released = true;
        }
      };
    } catch (error: any) {
      return { ok: false, blocker: 'update_operation_lock_unavailable' };
    }
  }
  return { ok: false, blocker: 'update_operation_lock_held' };
}

export function updateOperationLastInstallPath(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const canonicalKey = path.resolve(projectRoot);
  const projectHash = createHash('sha256').update(canonicalKey).digest('hex').slice(0, 24);
  return path.join(updateGlobalRoot(env), 'operations', `update-last-install-${projectHash}.json`);
}

export async function authorizeUpdateRollback(input: {
  targetVersion: string;
  currentVersion: string;
  projectRoot: string;
  registry?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  repairMissingPointer?: boolean;
}): Promise<UpdateRollbackAuthorization> {
  const env = input.env || process.env;
  const canonicalProjectRoot = await canonicalFilesystemPath(input.projectRoot);
  const lastInstallPath = updateOperationLastInstallPath(canonicalProjectRoot, env);
  const operationsDir = path.dirname(lastInstallPath);
  const pointerStat = await fs.lstat(lastInstallPath).catch(() => null);
  let recoveredFromScan = false;
  let lastInstall = pointerStat
    ? await readRollbackReceipt(lastInstallPath, operationsDir).catch(() => null)
    : null;
  if (!pointerStat) {
    lastInstall = await findRecoverableConfirmedInstallReceipt({
      operationsDir,
      projectRoot: canonicalProjectRoot,
      registry: input.registry || DEFAULT_UPDATE_REGISTRY,
      targetVersion: input.targetVersion,
      currentVersion: input.currentVersion,
      now: input.now || new Date()
    });
    recoveredFromScan = Boolean(lastInstall);
  }
  if (!lastInstall) return { ok: false, blocker: 'rollback_receipt_required', receiptPath: null };
  const receiptPath = path.resolve(lastInstall.receipt_path || '');
  const source = await readRollbackReceipt(receiptPath, operationsDir).catch(() => null);
  if (!source) return { ok: false, blocker: 'rollback_receipt_invalid', receiptPath };
  if (!sameRollbackReceipt(lastInstall, source)) {
    return { ok: false, blocker: 'rollback_receipt_changed', receiptPath };
  }
  const bindingBlocker = await confirmedInstallReceiptBindingBlocker(source, {
    projectRoot: canonicalProjectRoot,
    registry: input.registry || DEFAULT_UPDATE_REGISTRY
  });
  if (bindingBlocker) return { ok: false, blocker: bindingBlocker, receiptPath };
  const updatedAt = Date.parse(source.updated_at);
  const now = (input.now || new Date()).getTime();
  const versionBlocker = source.previous_version !== input.targetVersion
    ? 'rollback_target_not_previous_version'
    : source.target_version !== input.currentVersion
      ? 'rollback_receipt_not_current_install'
      : null;
  const stale = !Number.isFinite(updatedAt)
    || updatedAt > now + 60_000
    || now - updatedAt > ROLLBACK_RECEIPT_MAX_AGE_MS;
  if (versionBlocker || stale) {
    // A crash can leave a fully valid immutable receipt while the older,
    // integrity-valid project pointer survives. Only after the pointer and its
    // source pass every trust-boundary check above may an exact bounded scan
    // recover that newer install. Pointer/source tampering never reaches this
    // fallback.
    const recovered = await findRecoverableConfirmedInstallReceipt({
      operationsDir,
      projectRoot: canonicalProjectRoot,
      registry: input.registry || DEFAULT_UPDATE_REGISTRY,
      targetVersion: input.targetVersion,
      currentVersion: input.currentVersion,
      now: input.now || new Date()
    });
    if (!recovered) {
      return {
        ok: false,
        blocker: versionBlocker || 'rollback_receipt_stale',
        receiptPath
      };
    }
    lastInstall = recovered;
    recoveredFromScan = true;
  }
  const authorizedReceipt = recoveredFromScan ? lastInstall : source;
  const authorizedReceiptPath = path.resolve(authorizedReceipt.receipt_path);
  if (recoveredFromScan && input.repairMissingPointer === true) {
    try {
      await writePrivateJson(lastInstallPath, authorizedReceipt);
    } catch {
      return { ok: false, blocker: 'rollback_receipt_repair_failed', receiptPath: authorizedReceiptPath };
    }
  }
  return { ok: true, receipt: authorizedReceipt, receiptPath: authorizedReceiptPath };
}

async function findRecoverableConfirmedInstallReceipt(input: {
  operationsDir: string;
  projectRoot: string;
  registry: string;
  targetVersion: string;
  currentVersion: string;
  now: Date;
}): Promise<UpdateOperationReceipt | null> {
  const candidateEntries: Array<{ name: string }> = [];
  try {
    let observedEntries = 0;
    const directory = await fs.opendir(input.operationsDir);
    for await (const entry of directory) {
      observedEntries += 1;
      if (observedEntries > ROLLBACK_RECEIPT_SCAN_MAX_DIRECTORY_ENTRIES) return null;
      if (
        entry.isFile()
        && (
          /^update-[A-Za-z0-9._-]+\.json$/.test(entry.name)
          || /^[0-9a-f]{8}-[0-9a-f-]{27}\.json$/i.test(entry.name)
        )
        && entry.name !== 'update-latest.json'
      ) {
        candidateEntries.push({ name: entry.name });
      }
    }
  } catch {
    return null;
  }
  const candidates = await Promise.all(candidateEntries
    .map(async (entry) => {
      const file = path.join(input.operationsDir, entry.name);
      const stat = await fs.lstat(file).catch(() => null);
      return stat?.isFile() && !stat.isSymbolicLink() ? { file, mtimeMs: stat.mtimeMs } : null;
    }));
  const now = input.now.getTime();
  for (const candidate of candidates
    .filter((row): row is { file: string; mtimeMs: number } => Boolean(row))
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, ROLLBACK_RECEIPT_SCAN_MAX_CANDIDATES)) {
    const receipt = await readRollbackReceipt(candidate.file, input.operationsDir).catch(() => null);
    const bindingBlocker = receipt
      ? await confirmedInstallReceiptBindingBlocker(receipt, {
          projectRoot: input.projectRoot,
          registry: input.registry
        })
      : 'rollback_receipt_invalid';
    if (
      !receipt
      || receipt.receipt_path !== candidate.file
      || bindingBlocker
      || receipt.previous_version !== input.targetVersion
      || receipt.target_version !== input.currentVersion
    ) continue;
    const updatedAt = Date.parse(receipt.updated_at);
    if (
      Number.isFinite(updatedAt)
      && updatedAt <= now + 60_000
      && now - updatedAt <= ROLLBACK_RECEIPT_MAX_AGE_MS
    ) return receipt;
  }
  return null;
}

async function confirmedInstallReceiptBindingBlocker(
  receipt: UpdateOperationReceipt,
  input: { projectRoot: string; registry: string }
): Promise<string | null> {
  if (receipt.kind !== 'update') return 'rollback_receipt_not_update';
  if (
    typeof receipt.project_root !== 'string'
    || !path.isAbsolute(receipt.project_root)
    || path.resolve(receipt.project_root) !== receipt.project_root
  ) {
    return 'rollback_receipt_project_unbound';
  }
  if (!(await sameFilesystemPath(receipt.project_root, input.projectRoot).catch(() => false))) {
    return 'rollback_receipt_project_mismatch';
  }
  if (
    typeof receipt.registry !== 'string'
    || !sameUpdateRegistry(receipt.registry, input.registry)
  ) {
    return 'rollback_receipt_registry_mismatch';
  }
  if (
    !isTerminalUpdateReceipt(receipt)
    || receipt.side_effects_started !== true
    || !updateReceiptHasConfirmedGlobalInstall(receipt)
  ) {
    return 'rollback_receipt_not_install';
  }
  return null;
}

export function buildUpdateRollbackCommand(version: string, projectRoot: string, registry?: string | null): string {
  const safeRegistry = registry ? canonicalUpdateRegistry(registry) : null;
  return [
    'sks update rollback --version',
    shellQuoteArg(version),
    '--project-root',
    shellQuoteArg(path.resolve(projectRoot)),
    ...(safeRegistry ? ['--registry', shellQuoteArg(safeRegistry)] : []),
    '--json'
  ].join(' ');
}

export function buildUpdateNowCommand(version: string, projectRoot?: string | null, registry?: string | null): string {
  const safeRegistry = registry ? canonicalUpdateRegistry(registry) : null;
  return [
    'sks update now --version',
    shellQuoteArg(version),
    ...(projectRoot ? ['--project-root', shellQuoteArg(path.resolve(projectRoot))] : []),
    ...(safeRegistry ? ['--registry', shellQuoteArg(safeRegistry)] : [])
  ].join(' ');
}

export function canonicalUpdateRegistry(registry: string): string {
  const value = String(registry || '').trim();
  if (!value) throw new Error('update_registry_url_invalid');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('update_registry_url_invalid');
  }
  if (parsed.protocol !== 'https:') throw new Error('update_registry_https_required');
  if (parsed.username || parsed.password || parsed.search) {
    throw new Error('update_registry_credentials_forbidden');
  }
  parsed.hash = '';
  return parsed.toString();
}

function sameUpdateRegistry(left: string, right: string): boolean {
  try {
    return canonicalUpdateRegistry(left) === canonicalUpdateRegistry(right);
  } catch {
    return false;
  }
}

function shellQuoteArg(value: string): string {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\"'\"'")}'`;
}

function isTerminalUpdateReceipt(receipt: UpdateOperationReceipt): boolean {
  return receipt.state === 'succeeded'
    || receipt.state === 'failed'
    || receipt.state === 'terminal_uncertain';
}

export function updateReceiptHasConfirmedGlobalInstall(receipt: UpdateOperationReceipt): boolean {
  if (!Array.isArray(receipt.stages)) return false;
  const installStages = receipt.stages.filter((stage) => stage?.id === 'global_install');
  if (installStages.length !== 1) return false;
  const install = installStages[0];
  if (!install || install.ok !== true || !['installed', 'fake_installed'].includes(install.status)) return false;
  if (!install.detail || typeof install.detail !== 'object') return false;
  return install.detail.code === 0 && install.detail.timed_out !== true;
}

function updateGlobalRoot(env: NodeJS.ProcessEnv): string {
  return env.SKS_GLOBAL_ROOT
    ? path.resolve(env.SKS_GLOBAL_ROOT)
    : path.join(env.HOME || os.homedir(), '.sneakoscope-global');
}

async function recoverDeadUpdateOperationLock(lockPath: string, recoveryPath: string): Promise<boolean> {
  const recoveryOwner = {
    schema: UPDATE_OPERATION_LOCK_SCHEMA,
    id: randomId(24),
    pid: process.pid,
    created_at: new Date().toISOString(),
    process_start: readProcessStartIdentity(process.pid)
  };
  try {
    if (!(await createOwnedLockAtomically(recoveryPath, recoveryOwner))) return false;
  } catch (error: any) {
    return false;
  }
  try {
    const lockStat = await fs.lstat(lockPath).catch(() => null);
    if (!lockStat?.isFile() || lockStat.isSymbolicLink()) return false;
    const owner = await readOwnedLock(lockPath);
    if (owner && processIsOwnerAlive(owner)) return false;
    if (!owner && !ownedLockStatIsStale(lockStat)) return false;
    const claimPath = `${lockPath}.stale-${recoveryOwner.id}`;
    await fs.rename(lockPath, claimPath);
    const claimStat = await fs.lstat(claimPath).catch(() => null);
    const claimed = owner ? await readOwnedLock(claimPath) : null;
    const sameClaim = Boolean(
      claimStat
      && claimStat.dev === lockStat.dev
      && claimStat.ino === lockStat.ino
      && (owner ? claimed?.id === owner.id : ownedLockStatIsStale(claimStat))
    );
    if (!sameClaim) {
      await restoreClaimNoReplace(claimPath, lockPath);
      return false;
    }
    await fs.rm(claimPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    await removeOwnedLock(recoveryPath, recoveryOwner.id);
  }
}

async function createOwnedLockAtomically(
  file: string,
  owner: OwnedUpdateLock
): Promise<boolean> {
  const candidate = `${file}.owner-${owner.id}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    handle = await fs.open(candidate, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      await fs.link(candidate, file);
      return true;
    } catch (error: any) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function removeDeadOrMalformedOwnedLock(file: string): Promise<void> {
  const owner = await readOwnedLock(file);
  if (owner) {
    if (!processIsOwnerAlive(owner)) await removeOwnedLock(file, owner.id);
    return;
  }
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || !ownedLockStatIsStale(stat)) return;
  const claim = `${file}.malformed-${randomId(16)}`;
  await fs.rename(file, claim).catch(() => undefined);
  const claimed = await fs.lstat(claim).catch(() => null);
  if (claimed?.dev === stat.dev && claimed.ino === stat.ino) {
    await fs.rm(claim, { force: true }).catch(() => undefined);
  } else {
    await restoreClaimNoReplace(claim, file);
  }
}

function ownedLockStatIsStale(stat: { mtimeMs: number }, nowMs = Date.now()): boolean {
  return nowMs - stat.mtimeMs > 30_000;
}

async function ownedLockIsLive(file: string): Promise<boolean> {
  const owner = await readOwnedLock(file);
  return Boolean(owner && processIsOwnerAlive(owner));
}

async function readOwnedLock(file: string): Promise<OwnedUpdateLock | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 4096) return null;
  let value: {
    schema?: string;
    id?: string;
    pid?: number;
    created_at?: string;
    process_start?: string | null;
  } | null = null;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8')) as {
      schema?: string;
      id?: string;
      pid?: number;
      created_at?: string;
      process_start?: string | null;
    } | null;
  } catch {
    return null;
  }
  if (
    value?.schema !== UPDATE_OPERATION_LOCK_SCHEMA
    || typeof value.id !== 'string'
    || !Number.isInteger(value.pid)
    || Number(value.pid) <= 0
    || typeof value.created_at !== 'string'
    || !Number.isFinite(Date.parse(value.created_at))
    || !(
      value.process_start === undefined
      || value.process_start === null
      || typeof value.process_start === 'string'
    )
  ) return null;
  return {
    schema: UPDATE_OPERATION_LOCK_SCHEMA,
    id: value.id,
    pid: Number(value.pid),
    created_at: value.created_at,
    process_start: value.process_start || null
  };
}

async function removeOwnedLock(file: string, ownerId: string): Promise<boolean> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return true;
  if (!stat.isFile() || stat.isSymbolicLink()) return false;
  const owner = await readOwnedLock(file);
  if (owner?.id !== ownerId) return false;
  const claim = `${file}.release-${ownerId}-${randomId(8)}`;
  try {
    await fs.rename(file, claim);
  } catch {
    return !(await fs.lstat(file).catch(() => null));
  }
  const claimStat = await fs.lstat(claim).catch(() => null);
  const claimedOwner = await readOwnedLock(claim);
  if (
    claimStat?.dev === stat.dev
    && claimStat.ino === stat.ino
    && claimedOwner?.id === ownerId
  ) {
    await fs.rm(claim, { force: true });
    return true;
  }
  await restoreClaimNoReplace(claim, file);
  return false;
}

async function restoreClaimNoReplace(claim: string, destination: string): Promise<void> {
  const claimStat = await fs.lstat(claim).catch(() => null);
  if (!claimStat?.isFile() || claimStat.isSymbolicLink()) return;
  try {
    await fs.link(claim, destination);
    await fs.rm(claim, { force: true });
  } catch (error: any) {
    // A successor may already own the fixed path. Keep the randomized claim
    // rather than overwrite or delete an inode whose ownership is uncertain.
    if (error?.code !== 'EEXIST') throw error;
  }
}

function processIsOwnerAlive(owner: Pick<OwnedUpdateLock, 'pid' | 'process_start'>): boolean {
  try {
    process.kill(owner.pid, 0);
  } catch (error: any) {
    if (error?.code !== 'EPERM') return false;
  }
  if (!owner.process_start) return true;
  const observed = readProcessStartIdentity(owner.pid);
  // Failure to probe is treated conservatively as live; a positive mismatch
  // proves the PID has been reused since this lock was published.
  return observed === null || observed === owner.process_start;
}

function readProcessStartIdentity(pid: number): string | null {
  if (process.platform === 'win32') return null;
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
    maxBuffer: 4096
  });
  if (result.status !== 0) return null;
  const value = String(result.stdout || '').trim().replace(/\s+/g, ' ');
  return value || null;
}

async function readRollbackReceipt(file: string, operationsDir: string): Promise<UpdateOperationReceipt> {
  const resolved = path.resolve(file);
  const relative = path.relative(path.resolve(operationsDir), resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('rollback_receipt_path_invalid');
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('rollback_receipt_file_invalid');
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error('rollback_receipt_permissions_invalid');
  const value = JSON.parse(await fs.readFile(resolved, 'utf8')) as UpdateOperationReceipt;
  if (value?.schema !== UPDATE_OPERATION_SCHEMA || typeof value.id !== 'string' || typeof value.receipt_path !== 'string') {
    throw new Error('rollback_receipt_schema_invalid');
  }
  return value;
}

function sameRollbackReceipt(left: UpdateOperationReceipt, right: UpdateOperationReceipt): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined ? 'undefined' : encoded;
}

function publicDetail(value: Record<string, unknown>, env: NodeJS.ProcessEnv): Record<string, unknown> {
  return redactValue(value, env, 0) as Record<string, unknown>;
}

function redactValue(value: unknown, env: NodeJS.ProcessEnv, depth: number): unknown {
  if (depth > 5) return '[truncated]';
  if (typeof value === 'string') return publicString(value, env);
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, env, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value).slice(0, 80)) {
    output[key] = /secret|token|api[_-]?key|authorization/i.test(key)
      ? '[redacted]'
      : redactValue(entry, env, depth + 1);
  }
  return output;
}

function publicString(value: string, env: NodeJS.ProcessEnv): string {
  let text = String(value || '').replace(/[\r\n]+/g, ' ');
  const home = env.HOME || os.homedir();
  if (home) text = text.replaceAll(home, '~');
  return text
    .replace(/sk-(?:proj|or-v1|clb)?-?[A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/(api[_-]?key|secret|token|authorization)\s*[:=]\s*[^\s"',}]+/gi, '$1=[redacted]')
    .slice(0, 500);
}
