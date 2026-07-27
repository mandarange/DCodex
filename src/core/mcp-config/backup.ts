import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { errorCodeOf } from '../errors/message.js';
import { nowIso, sha256, writeTextAtomic } from '../fsx.js';
import type { ResolvedMcpScope } from './scope.js';
import { MCP_BACKUP_SCHEMA, type McpBackupMetadataV1 } from './types.js';

export interface PendingMcpBackup {
  readonly metadata: McpBackupMetadataV1;
  readonly metadataPath: string;
}

export async function createMcpBackup(
  ref: ResolvedMcpScope,
  before: string,
  operation: McpBackupMetadataV1['operation'],
  server: string
): Promise<PendingMcpBackup> {
  const directory = backupDirectory(ref);
  await assertSafeBackupDirectory(directory, ref.codexHome);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.chmod(directory, 0o700).catch(() => undefined);
  const id = `mcp-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  const contentFile = `${id}.toml`;
  const contentPath = path.join(directory, contentFile);
  const metadataPath = path.join(directory, `${id}.json`);
  await writeTextAtomic(contentPath, before, { mode: 0o600 });
  const metadata: McpBackupMetadataV1 = {
    schema: MCP_BACKUP_SCHEMA,
    id,
    scope: ref.scope,
    source_path: ref.configPath,
    sha256_before: sha256(before),
    sha256_after: null,
    created_at: nowIso(),
    operation,
    server,
    content_file: contentFile
  };
  await writeTextAtomic(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return { metadata, metadataPath };
}

export async function finalizeMcpBackup(pending: PendingMcpBackup, after: string): Promise<McpBackupMetadataV1> {
  const metadata: McpBackupMetadataV1 = { ...pending.metadata, sha256_after: sha256(after) };
  await writeTextAtomic(pending.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  return metadata;
}

export async function listMcpBackups(ref: ResolvedMcpScope): Promise<McpBackupMetadataV1[]> {
  const directory = backupDirectory(ref);
  await assertSafeBackupDirectory(directory, ref.codexHome);
  const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
  const backups: McpBackupMetadataV1[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^mcp-[A-Za-z0-9-]+\.json$/.test(entry.name)) continue;
    const metadata = await readMetadata(path.join(directory, entry.name)).catch(() => null);
    if (metadata && metadata.scope === ref.scope && path.resolve(metadata.source_path) === ref.configPath) backups.push(metadata);
  }
  return backups.sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export async function loadMcpBackup(ref: ResolvedMcpScope, id: string): Promise<{ metadata: McpBackupMetadataV1; text: string }> {
  if (!/^mcp-[A-Za-z0-9-]+$/.test(id)) throw new Error('mcp_backup_id_invalid');
  const directory = backupDirectory(ref);
  await assertSafeBackupDirectory(directory, ref.codexHome);
  const metadata = await readMetadata(path.join(directory, `${id}.json`));
  if (metadata.id !== id || metadata.scope !== ref.scope || path.resolve(metadata.source_path) !== ref.configPath) {
    throw new Error('mcp_backup_scope_mismatch');
  }
  if (metadata.content_file !== `${id}.toml`) throw new Error('mcp_backup_content_name_invalid');
  const contentPath = path.join(directory, metadata.content_file);
  const stat = await fsp.lstat(contentPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('mcp_backup_content_invalid');
  if ((stat.mode & 0o077) !== 0) throw new Error('mcp_backup_permissions_invalid');
  const text = await fsp.readFile(contentPath, 'utf8');
  if (sha256(text) !== metadata.sha256_before) throw new Error('mcp_backup_sha256_mismatch');
  return { metadata, text };
}

export function backupDirectory(ref: ResolvedMcpScope): string {
  return path.join(ref.codexHome, 'backups', 'sks-mcp');
}

async function readMetadata(file: string): Promise<McpBackupMetadataV1> {
  const stat = await fsp.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('mcp_backup_metadata_invalid');
  const value = JSON.parse(await fsp.readFile(file, 'utf8')) as McpBackupMetadataV1;
  if (value.schema !== MCP_BACKUP_SCHEMA || !value.id || !value.sha256_before) throw new Error('mcp_backup_schema_invalid');
  return value;
}

async function assertSafeBackupDirectory(directory: string, codexHome: string): Promise<void> {
  const relative = path.relative(path.resolve(codexHome), path.resolve(directory));
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('mcp_backup_path_escape');
  for (const candidate of [path.join(codexHome, 'backups'), directory]) {
    const stat = await fsp.lstat(candidate).catch((error: unknown) => errorCodeOf(error) === 'ENOENT' ? null : Promise.reject(error));
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) throw new Error('mcp_backup_directory_invalid');
    if (stat) {
      const resolved = await fsp.realpath(candidate);
      const candidateRelative = path.relative(path.resolve(codexHome), resolved);
      if (candidateRelative.startsWith('..') || path.isAbsolute(candidateRelative)) throw new Error('mcp_backup_path_escape');
    }
  }
}
