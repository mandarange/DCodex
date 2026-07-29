import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { messageOf as errorMessage } from '../errors/message.js';
import { ensureDir, exists, readText, writeTextAtomic } from '../fsx.js';

export interface CodexLbMigrationReceiptFile {
  path: string;
  before_sha256: string | null;
  after_sha256: string | null;
  backup_path: string | null;
  owned_by_sks: boolean;
}

export interface CodexLbMigrationReceipt {
  schema: 'sks.codex-lb-migration-receipt.v1';
  id: string;
  created_at: string;
  from_mode: string;
  to_mode: string;
  files: CodexLbMigrationReceiptFile[];
  bridge_state_path: string | null;
  oauth_preserved: boolean;
  capability_summary: Record<string, string>;
}

export interface CodexLbMigrationFileBackup {
  path: string;
  before_sha256: string | null;
  backup_path: string | null;
  owned_by_sks: boolean;
}

export interface CodexLbMigrationRollbackResult {
  schema: 'sks.codex-lb-migration-rollback.v1';
  ok: boolean;
  status: 'rolled_back' | 'rollback_conflict' | 'invalid_receipt' | 'rollback_failed';
  receipt_id: string | null;
  restored_files: string[];
  conflicts: Array<{
    path: string;
    expected_after_sha256: string | null;
    current_sha256: string | null;
    reason: string;
  }>;
  error?: string;
}

export function codexLbMigrationReceiptDir(home: string = process.env.HOME || os.homedir()): string {
  return path.join(home, '.codex', 'sks-codex-lb-migrations');
}

export function createCodexLbMigrationReceiptId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:.TZ]/g, '')}-${randomUUID().slice(0, 8)}`;
}

export async function backupCodexLbMigrationFile(
  filePath: string,
  backupDir: string,
  ownedBySks: boolean
): Promise<CodexLbMigrationFileBackup> {
  const before = await readRegularFileOrMissing(filePath);
  if (!before) {
    return {
      path: filePath,
      before_sha256: null,
      backup_path: null,
      owned_by_sks: ownedBySks
    };
  }
  await ensureDir(backupDir);
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

export async function finalizeCodexLbMigrationReceiptFiles(
  backups: CodexLbMigrationFileBackup[]
): Promise<CodexLbMigrationReceiptFile[]> {
  return Promise.all(backups.map(async (backup) => ({
    ...backup,
    after_sha256: await fileSha256OrMissing(backup.path)
  })));
}

export async function writeCodexLbMigrationReceipt(
  receipt: CodexLbMigrationReceipt,
  input: { receiptDir?: string; receiptPath?: string } = {}
): Promise<string> {
  validateReceipt(receipt);
  const receiptDir = input.receiptDir || codexLbMigrationReceiptDir();
  const receiptPath = input.receiptPath || path.join(receiptDir, `${receipt.id}.json`);
  await writeTextAtomic(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await fsp.chmod(receiptPath, 0o600).catch(() => {});
  return receiptPath;
}

export async function readCodexLbMigrationReceipt(receiptPath: string): Promise<CodexLbMigrationReceipt> {
  const text = await readText(receiptPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('invalid_codex_lb_migration_receipt');
  }
  validateReceipt(parsed);
  return parsed;
}

export async function rollbackCodexLbMigrationReceipt(input: {
  receipt?: CodexLbMigrationReceipt;
  receiptPath?: string;
}): Promise<CodexLbMigrationRollbackResult> {
  let receipt: CodexLbMigrationReceipt;
  try {
    if (input.receipt) {
      validateReceipt(input.receipt);
      receipt = input.receipt;
    } else if (input.receiptPath) {
      receipt = await readCodexLbMigrationReceipt(input.receiptPath);
    } else {
      throw new Error('missing_codex_lb_migration_receipt');
    }
  } catch (error: unknown) {
    return {
      schema: 'sks.codex-lb-migration-rollback.v1',
      ok: false,
      status: 'invalid_receipt',
      receipt_id: null,
      restored_files: [],
      conflicts: [],
      error: errorMessage(error)
    };
  }

  const conflicts: CodexLbMigrationRollbackResult['conflicts'] = [];
  for (const file of receipt.files) {
    const currentSha = await fileSha256OrMissing(file.path);
    if (currentSha !== file.after_sha256) {
      conflicts.push({
        path: file.path,
        expected_after_sha256: file.after_sha256,
        current_sha256: currentSha,
        reason: 'current_file_changed_after_migration'
      });
      continue;
    }
    if (file.before_sha256 !== null) {
      if (!file.backup_path || !(await exists(file.backup_path))) {
        conflicts.push({
          path: file.path,
          expected_after_sha256: file.after_sha256,
          current_sha256: currentSha,
          reason: 'before_backup_missing'
        });
        continue;
      }
      const backupSha = await fileSha256OrMissing(file.backup_path);
      if (backupSha !== file.before_sha256) {
        conflicts.push({
          path: file.path,
          expected_after_sha256: file.after_sha256,
          current_sha256: currentSha,
          reason: 'before_backup_hash_mismatch'
        });
      }
    }
  }
  if (conflicts.length) {
    return {
      schema: 'sks.codex-lb-migration-rollback.v1',
      ok: false,
      status: 'rollback_conflict',
      receipt_id: receipt.id,
      restored_files: [],
      conflicts
    };
  }

  const currentBytes = new Map<string, Buffer | null>();
  for (const file of receipt.files) currentBytes.set(file.path, await readRegularFileOrMissing(file.path));
  const restoredFiles: string[] = [];
  try {
    for (const file of receipt.files) {
      if (file.before_sha256 === null) {
        await fsp.rm(file.path, { force: true });
      } else {
        const backupPath = file.backup_path;
        if (!backupPath) throw new Error(`before_backup_missing:${file.path}`);
        await writeBufferAtomic(file.path, await fsp.readFile(backupPath), 0o600);
      }
      if ((await fileSha256OrMissing(file.path)) !== file.before_sha256) {
        throw new Error(`rollback_readback_failed:${file.path}`);
      }
      restoredFiles.push(file.path);
    }
  } catch (error: unknown) {
    for (const [filePath, bytes] of currentBytes) {
      try {
        if (bytes === null) await fsp.rm(filePath, { force: true });
        else await writeBufferAtomic(filePath, bytes, 0o600);
      } catch {}
    }
    return {
      schema: 'sks.codex-lb-migration-rollback.v1',
      ok: false,
      status: 'rollback_failed',
      receipt_id: receipt.id,
      restored_files: [],
      conflicts: [],
      error: errorMessage(error)
    };
  }

  return {
    schema: 'sks.codex-lb-migration-rollback.v1',
    ok: true,
    status: 'rolled_back',
    receipt_id: receipt.id,
    restored_files: restoredFiles,
    conflicts: []
  };
}

export async function fileSha256OrMissing(filePath: string): Promise<string | null> {
  const bytes = await readRegularFileOrMissing(filePath);
  return bytes === null ? null : sha256(bytes);
}

async function readRegularFileOrMissing(filePath: string): Promise<Buffer | null> {
  try {
    const stat = await fsp.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`migration_file_not_regular:${filePath}`);
    return await fsp.readFile(filePath);
  } catch (error: unknown) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
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

function validateReceipt(value: unknown): asserts value is CodexLbMigrationReceipt {
  if (!value || typeof value !== 'object') throw new Error('invalid_codex_lb_migration_receipt');
  const receipt = value as Partial<CodexLbMigrationReceipt>;
  if (
    receipt.schema !== 'sks.codex-lb-migration-receipt.v1'
    || typeof receipt.id !== 'string'
    || !receipt.id
    || typeof receipt.created_at !== 'string'
    || typeof receipt.from_mode !== 'string'
    || typeof receipt.to_mode !== 'string'
    || !Array.isArray(receipt.files)
    || typeof receipt.oauth_preserved !== 'boolean'
  ) {
    throw new Error('invalid_codex_lb_migration_receipt');
  }
  for (const file of receipt.files) {
    if (
      !file
      || typeof file.path !== 'string'
      || !file.path
      || (file.before_sha256 !== null && typeof file.before_sha256 !== 'string')
      || (file.after_sha256 !== null && typeof file.after_sha256 !== 'string')
      || (file.backup_path !== null && typeof file.backup_path !== 'string')
      || typeof file.owned_by_sks !== 'boolean'
    ) {
      throw new Error('invalid_codex_lb_migration_receipt_file');
    }
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}
