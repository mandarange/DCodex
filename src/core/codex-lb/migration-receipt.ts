import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { messageOf as errorMessage } from '../errors/message.js';
import { ensureDir, exists, writeTextAtomic } from '../fsx.js';
import { withFileLock } from '../locks/file-lock.js';
import type { DesktopBridgeUnificationReceipt } from './bridge-contracts.js';

export interface DesktopBridgeMigrationReceiptFile {
  path: string;
  before_sha256: string | null;
  after_sha256: string | null;
  backup_path: string | null;
  owned_by_sks: boolean;
}

export interface DesktopBridgeMigrationFileBackup {
  path: string;
  before_sha256: string | null;
  backup_path: string | null;
  owned_by_sks: boolean;
}

export type DesktopBridgeRollbackMetadataKind =
  | 'config'
  | 'bridge_settings'
  | 'provider_registry'
  | 'catalog_binding'
  | 'route_policy'
  | 'launchd_state';

export interface DesktopBridgeRollbackMetadataFile extends DesktopBridgeMigrationReceiptFile {
  kind: DesktopBridgeRollbackMetadataKind;
}

export interface DesktopBridgeUnificationRollbackMetadata {
  schema: 'sks.desktop-bridge-unification-rollback-metadata.v1';
  files: DesktopBridgeRollbackMetadataFile[];
}

export type MigratedDesktopBridgeUnificationReceipt = DesktopBridgeUnificationReceipt & {
  migration_status: 'migrated';
  rollback_supported: true;
  rollback_metadata: DesktopBridgeUnificationRollbackMetadata;
};

export type AlreadyMigratedDesktopBridgeUnificationReceipt = DesktopBridgeUnificationReceipt & {
  migration_status: 'already_migrated';
  rollback_supported: false;
  backup_paths: [];
  rollback_metadata: DesktopBridgeUnificationRollbackMetadata & { files: [] };
};

export type StoredDesktopBridgeUnificationReceipt =
  | MigratedDesktopBridgeUnificationReceipt
  | AlreadyMigratedDesktopBridgeUnificationReceipt;

export interface DesktopBridgeUnificationRollbackResult {
  schema: 'sks.desktop-bridge-unification-rollback.v1';
  ok: boolean;
  status:
    | 'rolled_back'
    | 'nothing_to_rollback'
    | 'rollback_conflict'
    | 'invalid_receipt'
    | 'rollback_failed';
  receipt_id: string | null;
  restored_files: string[];
  credentials_overwritten: false;
  auth_overwritten: false;
  conflicts: DesktopBridgeRollbackConflict[];
  error?: string;
}

export interface DesktopBridgeRollbackConflict {
  path: string;
  expected_after_sha256: string | null;
  current_sha256: string | null;
  reason: string;
}

export function desktopBridgeUnificationReceiptDir(
  home: string = process.env.HOME || os.homedir()
): string {
  return path.join(home, '.codex', 'sks-desktop-bridge-migrations');
}

export function desktopBridgeMigrationTransactionLockPath(home: string): string {
  return path.join(path.resolve(home), '.codex', 'sks', 'locks', 'desktop-bridge-migration.lock');
}

export function createDesktopBridgeUnificationReceiptId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
}

export async function backupDesktopBridgeMigrationFile(
  filePath: string,
  backupDir: string,
  ownedBySks: boolean
): Promise<DesktopBridgeMigrationFileBackup> {
  const before = await readRegularFileOrMissing(filePath);
  if (!before) {
    return {
      path: filePath,
      before_sha256: null,
      backup_path: null,
      owned_by_sks: ownedBySks
    };
  }
  await ensurePrivateDirectory(backupDir);
  const backupPath = path.join(
    backupDir,
    `${createHash('sha256').update(path.resolve(filePath)).digest('hex').slice(0, 16)}.before`
  );
  await writeBufferAtomic(backupPath, before, 0o600);
  return {
    path: filePath,
    before_sha256: sha256(before),
    backup_path: backupPath,
    owned_by_sks: ownedBySks
  };
}

export async function finalizeDesktopBridgeMigrationReceiptFiles(
  backups: DesktopBridgeMigrationFileBackup[]
): Promise<DesktopBridgeMigrationReceiptFile[]> {
  return Promise.all(backups.map(async (backup) => ({
    ...backup,
    after_sha256: await fileSha256OrMissing(backup.path)
  })));
}

export async function writeDesktopBridgeUnificationReceipt(
  receipt: StoredDesktopBridgeUnificationReceipt,
  input: { receiptDir?: string; receiptPath?: string } = {}
): Promise<string> {
  normalizeHistoricalSelectionCompatibility(receipt);
  validateDesktopBridgeUnificationReceipt(receipt);
  const receiptDir = input.receiptDir || desktopBridgeUnificationReceiptDir();
  const receiptPath = input.receiptPath || path.join(receiptDir, `${receipt.receipt_id}.json`);
  await ensurePrivateDirectory(path.dirname(receiptPath));
  await writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(receiptPath, 0o600).catch(() => {});
  return receiptPath;
}

export async function readDesktopBridgeUnificationReceipt(
  receiptPath: string
): Promise<StoredDesktopBridgeUnificationReceipt> {
  const text = (await readSecureOwnerFile(receiptPath, 1024 * 1024, 'desktop_bridge_receipt')).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid_desktop_bridge_unification_receipt');
  }
  normalizeHistoricalSelectionCompatibility(parsed);
  validateDesktopBridgeUnificationReceipt(parsed);
  return parsed;
}

export async function rollbackDesktopBridgeUnificationReceipt(input: {
  receipt?: StoredDesktopBridgeUnificationReceipt;
  receiptPath?: string;
  beforeTargetLocks?: () => Promise<void>;
  transactionLockHeld?: boolean;
}): Promise<DesktopBridgeUnificationRollbackResult> {
  let receipt: StoredDesktopBridgeUnificationReceipt;
  try {
    if (input.receipt) {
      normalizeHistoricalSelectionCompatibility(input.receipt);
      validateDesktopBridgeUnificationReceipt(input.receipt);
      receipt = input.receipt;
    } else if (input.receiptPath) {
      receipt = await readDesktopBridgeUnificationReceipt(input.receiptPath);
    } else {
      throw new Error('missing_desktop_bridge_unification_receipt');
    }
  } catch (error: unknown) {
    return {
      schema: 'sks.desktop-bridge-unification-rollback.v1',
      ok: false,
      status: 'invalid_receipt',
      receipt_id: null,
      restored_files: [],
      credentials_overwritten: false,
      auth_overwritten: false,
      conflicts: [],
      error: errorMessage(error)
    };
  }

  if (receipt.migration_status === 'already_migrated') {
    return {
      schema: 'sks.desktop-bridge-unification-rollback.v1',
      ok: true,
      status: 'nothing_to_rollback',
      receipt_id: receipt.receipt_id,
      restored_files: [],
      credentials_overwritten: false,
      auth_overwritten: false,
      conflicts: []
    };
  }

  if (input.transactionLockHeld !== true) {
    const configTarget = receipt.rollback_metadata.files.find((file) => file.kind === 'config');
    if (!configTarget) {
      return {
        schema: 'sks.desktop-bridge-unification-rollback.v1',
        ok: false,
        status: 'invalid_receipt',
        receipt_id: receipt.receipt_id,
        restored_files: [],
        credentials_overwritten: false,
        auth_overwritten: false,
        conflicts: [],
        error: 'desktop_bridge_rollback_config_target_missing'
      };
    }
    const home = path.dirname(path.dirname(path.resolve(configTarget.path)));
    return withFileLock({
      lockPath: desktopBridgeMigrationTransactionLockPath(home),
      timeoutMs: 30_000,
      staleMs: 120_000
    }, () => rollbackDesktopBridgeUnificationReceipt({
      receipt,
      ...(input.beforeTargetLocks ? { beforeTargetLocks: input.beforeTargetLocks } : {}),
      transactionLockHeld: true
    }));
  }

  const files = receipt.rollback_metadata.files;
  const initial = await inspectRollbackFiles(files);
  if (initial.conflicts.length) return rollbackConflict(receipt.receipt_id, initial.conflicts);
  try {
    await input.beforeTargetLocks?.();
    return await withRollbackTargetLocks(files, async () => {
      // This is the all-target CAS boundary: backups are secured first, then
      // every target is re-opened without following symlinks after every lock
      // is held. No target is mutated until the complete pass succeeds.
      const locked = await inspectRollbackFiles(files, initial.snapshots);
      if (locked.conflicts.length) return rollbackConflict(receipt.receipt_id, locked.conflicts);

      const restoredFiles: string[] = [];
      try {
        for (const file of files) {
          if (file.before_sha256 === null) {
            await fsp.rm(file.path, { force: true });
          } else {
            if (!file.backup_path) throw new Error(`before_backup_missing:${file.path}`);
            const backup = locked.backupBytes.get(path.resolve(file.path));
            if (!backup) throw new Error(`before_backup_unavailable:${file.path}`);
            await writeBufferAtomic(file.path, backup, 0o600);
          }
          if ((await fileSha256OrMissing(file.path)) !== file.before_sha256) {
            throw new Error(`rollback_readback_failed:${file.path}`);
          }
          restoredFiles.push(file.path);
        }
      } catch (error: unknown) {
        for (const file of files) {
          const snapshot = locked.snapshots.get(path.resolve(file.path));
          try {
            if (!snapshot || snapshot.bytes === null) await fsp.rm(file.path, { force: true });
            else await writeBufferAtomic(file.path, snapshot.bytes, 0o600);
          } catch {}
        }
        return {
          schema: 'sks.desktop-bridge-unification-rollback.v1',
          ok: false,
          status: 'rollback_failed',
          receipt_id: receipt.receipt_id,
          restored_files: [],
          credentials_overwritten: false,
          auth_overwritten: false,
          conflicts: [],
          error: errorMessage(error)
        };
      }

      return {
        schema: 'sks.desktop-bridge-unification-rollback.v1',
        ok: true,
        status: 'rolled_back',
        receipt_id: receipt.receipt_id,
        restored_files: restoredFiles,
        credentials_overwritten: false,
        auth_overwritten: false,
        conflicts: []
      };
    });
  } catch (error: unknown) {
    return {
      schema: 'sks.desktop-bridge-unification-rollback.v1',
      ok: false,
      status: 'rollback_failed',
      receipt_id: receipt.receipt_id,
      restored_files: [],
      credentials_overwritten: false,
      auth_overwritten: false,
      conflicts: [],
      error: errorMessage(error)
    };
  }
}

type RollbackTargetSnapshot = {
  bytes: Buffer | null;
  sha256: string | null;
  identity: string | null;
  parent_identity: string;
};

type RollbackInspection = {
  snapshots: Map<string, RollbackTargetSnapshot>;
  backupBytes: Map<string, Buffer>;
  conflicts: DesktopBridgeRollbackConflict[];
};

async function inspectRollbackFiles(
  files: readonly DesktopBridgeRollbackMetadataFile[],
  expectedSnapshots?: ReadonlyMap<string, RollbackTargetSnapshot>
): Promise<RollbackInspection> {
  const backups = await inspectRollbackBackups(files);
  const targets = await inspectRollbackTargets(files, expectedSnapshots);
  return {
    snapshots: targets.snapshots,
    backupBytes: backups.backupBytes,
    conflicts: [...backups.conflicts, ...targets.conflicts]
  };
}

async function inspectRollbackBackups(
  files: readonly DesktopBridgeRollbackMetadataFile[]
): Promise<Pick<RollbackInspection, 'backupBytes' | 'conflicts'>> {
  const backupBytes = new Map<string, Buffer>();
  const conflicts: DesktopBridgeRollbackConflict[] = [];
  for (const file of files) {
    if (file.before_sha256 === null) continue;
    const resolved = path.resolve(file.path);
    if (!file.backup_path || !(await exists(file.backup_path))) {
      conflicts.push(rollbackFileConflict(file, null, 'before_backup_missing'));
      continue;
    }
    let backup: Buffer;
    try {
      backup = await readSecureOwnerFile(file.backup_path, 16 * 1024 * 1024, 'desktop_bridge_backup');
    } catch {
      conflicts.push(rollbackFileConflict(file, null, 'before_backup_unsafe'));
      continue;
    }
    if (sha256(backup) !== file.before_sha256) {
      conflicts.push(rollbackFileConflict(file, null, 'before_backup_hash_mismatch'));
      continue;
    }
    backupBytes.set(resolved, backup);
  }
  return { backupBytes, conflicts };
}

async function inspectRollbackTargets(
  files: readonly DesktopBridgeRollbackMetadataFile[],
  expectedSnapshots?: ReadonlyMap<string, RollbackTargetSnapshot>
): Promise<Pick<RollbackInspection, 'snapshots' | 'conflicts'>> {
  const snapshots = new Map<string, RollbackTargetSnapshot>();
  const conflicts: DesktopBridgeRollbackConflict[] = [];
  for (const file of files) {
    const resolved = path.resolve(file.path);
    let snapshot: RollbackTargetSnapshot;
    try {
      snapshot = await readSecureRollbackTarget(resolved);
      snapshots.set(resolved, snapshot);
    } catch {
      conflicts.push(rollbackFileConflict(file, null, 'current_file_unsafe'));
      continue;
    }
    if (snapshot.sha256 !== file.after_sha256) {
      conflicts.push(rollbackFileConflict(file, snapshot.sha256, 'current_file_changed_after_migration'));
      continue;
    }
    const expected = expectedSnapshots?.get(resolved);
    if (expected && !sameRollbackTargetIdentity(expected, snapshot)) {
      conflicts.push(rollbackFileConflict(file, snapshot.sha256, 'current_file_identity_changed_during_rollback'));
    }
  }
  return { snapshots, conflicts };
}

async function readSecureRollbackTarget(filePath: string): Promise<RollbackTargetSnapshot> {
  const parent = await fsp.lstat(path.dirname(filePath));
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!parent.isDirectory() || parent.isSymbolicLink() || (expectedUid !== null && parent.uid !== expectedUid)) {
    throw new Error(`desktop_bridge_rollback_parent_unsafe:${filePath}`);
  }
  const parentIdentity = parentStatIdentity(parent);
  let entry;
  try {
    entry = await fsp.lstat(filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) {
      return { bytes: null, sha256: null, identity: null, parent_identity: parentIdentity };
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`desktop_bridge_rollback_target_unsafe:${filePath}`);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()
      || stat.dev !== entry.dev
      || stat.ino !== entry.ino
      || (expectedUid !== null && stat.uid !== expectedUid)
      || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error(`desktop_bridge_rollback_target_unsafe:${filePath}`);
    }
    const bytes = await handle.readFile();
    return {
      bytes,
      sha256: sha256(bytes),
      identity: statIdentity(stat),
      parent_identity: parentIdentity
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function statIdentity(stat: { dev: number; ino: number; uid: number; mode: number; size: number; mtimeMs: number; ctimeMs: number }): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode & 0o777, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}

function parentStatIdentity(stat: { dev: number; ino: number; uid: number; mode: number }): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode & 0o777].join(':');
}

function sameRollbackTargetIdentity(before: RollbackTargetSnapshot, after: RollbackTargetSnapshot): boolean {
  return before.identity === after.identity && before.parent_identity === after.parent_identity;
}

function rollbackFileConflict(
  file: DesktopBridgeRollbackMetadataFile,
  currentSha: string | null,
  reason: string
): DesktopBridgeRollbackConflict {
  return {
    path: file.path,
    expected_after_sha256: file.after_sha256,
    current_sha256: currentSha,
    reason
  };
}

function rollbackConflict(
  receiptId: string,
  conflicts: DesktopBridgeRollbackConflict[]
): DesktopBridgeUnificationRollbackResult {
  return {
    schema: 'sks.desktop-bridge-unification-rollback.v1',
    ok: false,
    status: 'rollback_conflict',
    receipt_id: receiptId,
    restored_files: [],
    credentials_overwritten: false,
    auth_overwritten: false,
    conflicts
  };
}

export function desktopBridgeRollbackTargetLockPath(filePath: string): string {
  return `${path.resolve(filePath)}.lock`;
}

async function withRollbackTargetLocks<T>(
  files: readonly DesktopBridgeRollbackMetadataFile[],
  operation: () => Promise<T>
): Promise<T> {
  const targets = [...new Set(files.map((file) => path.resolve(file.path)))]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const acquire = async (index: number): Promise<T> => {
    const target = targets[index];
    if (!target) return operation();
    return withFileLock({
      lockPath: desktopBridgeRollbackTargetLockPath(target),
      timeoutMs: 10_000,
      staleMs: 60_000
    }, () => acquire(index + 1));
  };
  return acquire(0);
}

export async function fileSha256OrMissing(filePath: string): Promise<string | null> {
  const bytes = await readRegularFileOrMissing(filePath);
  return bytes === null ? null : sha256(bytes);
}

async function readRegularFileOrMissing(filePath: string): Promise<Buffer | null> {
  try {
    return await readFileWithoutFollowingSymlinks(filePath, Number.MAX_SAFE_INTEGER, 'migration_file');
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

async function readSecureOwnerFile(filePath: string, maxBytes: number, prefix: string): Promise<Buffer> {
  return readFileWithoutFollowingSymlinks(filePath, maxBytes, prefix, true);
}

async function readFileWithoutFollowingSymlinks(
  filePath: string,
  maxBytes: number,
  prefix: string,
  ownerOnly = false
): Promise<Buffer> {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await fsp.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${prefix}_not_regular:${filePath}`);
    if (stat.size > maxBytes) throw new Error(`${prefix}_too_large:${filePath}`);
    if (ownerOnly) {
      const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (expectedUid !== null && stat.uid !== expectedUid) throw new Error(`${prefix}_owner_mismatch:${filePath}`);
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new Error(`${prefix}_permissions_unsafe:${filePath}`);
    }
    return await handle.readFile();
  } finally {
    await handle.close().catch(() => {});
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`desktop_bridge_private_directory_invalid:${directory}`);
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && stat.uid !== expectedUid) {
    throw new Error(`desktop_bridge_private_directory_owner_mismatch:${directory}`);
  }
  if (process.platform !== 'win32') await fsp.chmod(directory, 0o700);
}

async function writeBufferAtomic(filePath: string, bytes: Buffer, mode: number): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    const handle = await fsp.open(tempPath, 'wx', mode);
    try {
      await handle.writeFile(bytes);
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    await fsp.chmod(tempPath, mode);
    await fsp.rename(tempPath, filePath);
    await fsp.chmod(filePath, mode);
  } catch (error: unknown) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function validateDesktopBridgeUnificationReceipt(
  value: unknown
): asserts value is StoredDesktopBridgeUnificationReceipt {
  if (!value || typeof value !== 'object') {
    throw new Error('invalid_desktop_bridge_unification_receipt');
  }
  const receipt = value as Partial<DesktopBridgeUnificationReceipt> & {
    migration_status?: unknown;
    rollback_metadata?: Partial<DesktopBridgeUnificationRollbackMetadata>;
  };
  if (
    receipt.schema !== 'sks.desktop-bridge-unification-receipt.v1'
    || typeof receipt.receipt_id !== 'string'
    || !/^[A-Za-z0-9._-]{1,160}$/.test(receipt.receipt_id)
    || typeof receipt.created_at !== 'string'
    || receipt.baseline_version !== '8.1.2'
    || receipt.target_version !== '8.1.3'
    || typeof receipt.config_before_sha256 !== 'string'
    || typeof receipt.config_after_sha256 !== 'string'
    || typeof receipt.auth_before_sha256 !== 'string'
    || typeof receipt.auth_after_sha256 !== 'string'
    || typeof receipt.auth_semantic_identity_preserved !== 'boolean'
    || !receipt.historical_state
    || typeof receipt.historical_state !== 'object'
    || !Array.isArray(receipt.migrated_profiles)
    || receipt.credentials_deleted !== false
    || receipt.new_runtime !== 'desktop-bridge'
    || !Array.isArray(receipt.backup_paths)
    || typeof receipt.rollback_supported !== 'boolean'
    || !Array.isArray(receipt.blockers)
    || (receipt.migration_status !== 'migrated' && receipt.migration_status !== 'already_migrated')
    || receipt.rollback_metadata?.schema !== 'sks.desktop-bridge-unification-rollback-metadata.v1'
    || !Array.isArray(receipt.rollback_metadata.files)
  ) {
    throw new Error('invalid_desktop_bridge_unification_receipt');
  }
  for (const key of [
    'desktop_mode',
    'historical_provider_selection',
    'model_provider',
    'catalog_path'
  ] as const) {
    const entry = receipt.historical_state[key];
    if (entry !== null && typeof entry !== 'string') {
      throw new Error('invalid_desktop_bridge_unification_receipt_historical_state');
    }
  }
  if (receipt.migrated_profiles.some((entry) => entry !== 'codex-lb' && entry !== 'openrouter')) {
    throw new Error('invalid_desktop_bridge_unification_receipt_provider');
  }
  if (
    receipt.new_catalog_generation !== null
    && typeof receipt.new_catalog_generation !== 'string'
  ) {
    throw new Error('invalid_desktop_bridge_unification_receipt_catalog_generation');
  }
  const seenPaths = new Set<string>();
  const canonicalHomes = new Set<string>();
  for (const file of receipt.rollback_metadata.files) {
    validateDesktopBridgeRollbackFile(file);
    if (file.backup_path !== null) {
      validateDesktopBridgeBackupPath(file.backup_path, receipt.receipt_id);
    }
    const resolved = path.resolve(file.path);
    if (seenPaths.has(resolved)) {
      throw new Error('invalid_desktop_bridge_unification_receipt_duplicate_path');
    }
    seenPaths.add(resolved);
    canonicalHomes.add(canonicalHomeForRollbackFile(file));
  }
  if (canonicalHomes.size > 1) {
    throw new Error('desktop_bridge_rollback_metadata_home_mismatch');
  }
  const metadataBackupPaths = new Set(
    receipt.rollback_metadata.files
      .map((file) => file.backup_path)
      .filter((entry): entry is string => typeof entry === 'string')
  );
  if (
    receipt.backup_paths.some((entry) => typeof entry !== 'string' || !metadataBackupPaths.has(entry))
    || metadataBackupPaths.size !== receipt.backup_paths.length
  ) {
    throw new Error('invalid_desktop_bridge_unification_receipt_backup_paths');
  }
  if (receipt.blockers.some((entry) => typeof entry !== 'string')) {
    throw new Error('invalid_desktop_bridge_unification_receipt_blockers');
  }
  if (receipt.migration_status === 'already_migrated') {
    if (
      receipt.rollback_supported !== false
      || receipt.backup_paths.length !== 0
      || receipt.rollback_metadata.files.length !== 0
      || receipt.config_before_sha256 !== receipt.config_after_sha256
      || receipt.auth_before_sha256 !== receipt.auth_after_sha256
      || receipt.auth_semantic_identity_preserved !== true
    ) {
      throw new Error('invalid_desktop_bridge_unification_noop_receipt');
    }
  } else if (receipt.rollback_supported !== true) {
    throw new Error('invalid_desktop_bridge_unification_migrated_receipt');
  }
}

function normalizeHistoricalSelectionCompatibility(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const historicalState = (value as { historical_state?: unknown }).historical_state;
  if (!historicalState || typeof historicalState !== 'object') return;
  const state = historicalState as Record<string, unknown>;
  const compatibilityKey = ['provider', 'mode'].join('_');
  const compatibilityValue = state[compatibilityKey];
  if (compatibilityValue === undefined) return;
  const currentValue = state.historical_provider_selection;
  if (currentValue !== undefined && currentValue !== compatibilityValue) {
    throw new Error('invalid_desktop_bridge_unification_receipt_historical_selection_conflict');
  }
  if (currentValue === undefined) {
    state.historical_provider_selection = compatibilityValue;
  }
  delete state[compatibilityKey];
}

function validateDesktopBridgeBackupPath(backupPath: string, receiptId: string): void {
  const resolved = path.resolve(backupPath);
  const filesDir = path.dirname(resolved);
  const receiptDir = path.dirname(filesDir);
  if (
    path.basename(resolved).match(/^[a-f0-9]{16}\.before$/) === null
    || path.basename(filesDir) !== 'files'
    || path.basename(receiptDir) !== receiptId
  ) {
    throw new Error('desktop_bridge_rollback_backup_path_not_canonical');
  }
}

function validateDesktopBridgeRollbackFile(file: unknown): asserts file is DesktopBridgeRollbackMetadataFile {
  if (!file || typeof file !== 'object') {
    throw new Error('invalid_desktop_bridge_unification_rollback_file');
  }
  const entry = file as Partial<DesktopBridgeRollbackMetadataFile>;
  const kinds: DesktopBridgeRollbackMetadataKind[] = [
    'config',
    'bridge_settings',
    'provider_registry',
    'catalog_binding',
    'route_policy',
    'launchd_state'
  ];
  if (
    !entry.kind
    || !kinds.includes(entry.kind)
    || typeof entry.path !== 'string'
    || !entry.path
    || (entry.before_sha256 !== null && typeof entry.before_sha256 !== 'string')
    || (entry.after_sha256 !== null && typeof entry.after_sha256 !== 'string')
    || (entry.backup_path !== null && typeof entry.backup_path !== 'string')
    || typeof entry.owned_by_sks !== 'boolean'
  ) {
    throw new Error('invalid_desktop_bridge_unification_rollback_file');
  }
  const hashPattern = /^[a-f0-9]{64}$/;
  if (
    (entry.before_sha256 !== null && !hashPattern.test(entry.before_sha256))
    || (entry.after_sha256 !== null && !hashPattern.test(entry.after_sha256))
    || (entry.before_sha256 === null && entry.backup_path !== null)
    || (entry.before_sha256 !== null && entry.backup_path === null)
    || (entry.backup_path !== null && !path.isAbsolute(entry.backup_path))
  ) {
    throw new Error('invalid_desktop_bridge_unification_rollback_file');
  }
  const resolved = path.resolve(entry.path);
  const basename = path.basename(resolved).toLowerCase();
  const segments = resolved.toLowerCase().split(path.sep);
  const sensitiveBasenames = new Set([
    'auth.json',
    'sks-codex-lb.env',
    'openrouter-api-key',
    'openrouter-api-key.json'
  ]);
  if (
    sensitiveBasenames.has(basename)
    || segments.includes('secrets')
    || /(?:credential|api-key|secret)/i.test(basename)
  ) {
    throw new Error('desktop_bridge_rollback_secret_file_forbidden');
  }
  if (!path.isAbsolute(entry.path)) {
    throw new Error('desktop_bridge_rollback_metadata_path_not_canonical');
  }
  if (entry.kind === 'config' ? entry.owned_by_sks : !entry.owned_by_sks) {
    throw new Error('desktop_bridge_rollback_metadata_ownership_invalid');
  }
}

function canonicalHomeForRollbackFile(file: DesktopBridgeRollbackMetadataFile): string {
  const resolved = path.resolve(file.path);
  const retiredArtifact = retiredDesktopBridgeRuntimeArtifact(resolved);
  if (retiredArtifact !== null) {
    throw new Error(`desktop_bridge_rollback_retired_runtime_target_forbidden:${retiredArtifact}`);
  }
  if (file.kind === 'config') {
    const codexHome = path.dirname(resolved);
    const home = path.dirname(codexHome);
    if (
      path.basename(resolved) === 'config.toml'
      && path.basename(codexHome) === '.codex'
      && path.join(home, '.codex', 'config.toml') === resolved
    ) return home;
  } else if (file.kind === 'launchd_state') {
    const launchAgents = path.dirname(resolved);
    const library = path.dirname(launchAgents);
    const home = path.dirname(library);
    if (
      path.basename(resolved) === 'com.sneakoscope.desktop-bridge.plist'
      && path.basename(launchAgents) === 'LaunchAgents'
      && path.basename(library) === 'Library'
      && path.join(
        home,
        'Library',
        'LaunchAgents',
        path.basename(resolved)
      ) === resolved
    ) return home;
  } else {
    const expectedBasename: Record<Exclude<DesktopBridgeRollbackMetadataKind, 'config' | 'launchd_state'>, string> = {
      bridge_settings: 'desktop-bridge-settings.json',
      provider_registry: 'sks-bridge-provider-registry.json',
      catalog_binding: 'sks-bridge-active-generation.json',
      route_policy: 'sks-bridge-route-policy.json'
    };
    const sksDir = path.dirname(resolved);
    const codexHome = path.dirname(sksDir);
    const home = path.dirname(codexHome);
    if (
      path.basename(resolved) === expectedBasename[file.kind]
      && path.basename(sksDir) === 'sks'
      && path.basename(codexHome) === '.codex'
      && path.join(home, '.codex', 'sks', expectedBasename[file.kind]) === resolved
    ) return home;
  }
  throw new Error(`desktop_bridge_rollback_metadata_path_not_canonical:${file.kind}`);
}

function retiredDesktopBridgeRuntimeArtifact(resolvedPath: string):
  'settings' | 'state' | 'plist' | 'stdout_log' | 'stderr_log' | null {
  const basename = path.basename(resolvedPath);
  const runtimeDir = path.dirname(resolvedPath);
  const codexHome = path.dirname(runtimeDir);
  const home = path.dirname(codexHome);
  if (
    path.basename(runtimeDir) === 'sks'
    && path.basename(codexHome) === '.codex'
    && path.join(home, '.codex', 'sks', basename) === resolvedPath
  ) {
    if (basename === 'codex-lb-desktop-bridge-settings.json') return 'settings';
    if (basename === 'codex-lb-desktop-bridge.json') return 'state';
  }

  const logsDir = path.dirname(resolvedPath);
  const logsRuntimeDir = path.dirname(logsDir);
  const logsCodexHome = path.dirname(logsRuntimeDir);
  const logsHome = path.dirname(logsCodexHome);
  if (
    path.basename(logsDir) === 'logs'
    && path.basename(logsRuntimeDir) === 'sks'
    && path.basename(logsCodexHome) === '.codex'
    && path.join(logsHome, '.codex', 'sks', 'logs', basename) === resolvedPath
  ) {
    if (basename === 'codex-lb-desktop-bridge.out.log') return 'stdout_log';
    if (basename === 'codex-lb-desktop-bridge.err.log') return 'stderr_log';
  }

  const launchAgents = path.dirname(resolvedPath);
  const library = path.dirname(launchAgents);
  const launchdHome = path.dirname(library);
  if (
    basename === 'com.sneakoscope.codex-lb-desktop-bridge.plist'
    && path.basename(launchAgents) === 'LaunchAgents'
    && path.basename(library) === 'Library'
    && path.join(
      launchdHome,
      'Library',
      'LaunchAgents',
      'com.sneakoscope.codex-lb-desktop-bridge.plist'
    ) === resolvedPath
  ) return 'plist';

  return null;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
