import { createHash, randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeCodexConfigGuarded } from '../../codex/codex-config-guard.js';
import type { ProviderMode } from '../contracts/contracts.js';

export type MigrationFindingKind = 'custom_provider' | 'mixed_catalog' | 'missing_session_metadata' | 'obsolete_command';

export interface MigrationFinding {
  readonly kind: MigrationFindingKind;
  readonly code: string;
  readonly removable_path: string | null;
}

export interface ArchitectureMigrationPlan {
  readonly schema: 'sks.architecture-migration-plan.v1';
  readonly status: 'ready' | 'no_op' | 'migration_required';
  readonly source_hash: string;
  readonly findings: readonly MigrationFinding[];
  readonly removable_paths: readonly string[];
  readonly blockers: readonly string[];
}

export interface ArchitectureMigrationReceipt {
  readonly schema: 'sks.architecture-migration-receipt.v1';
  readonly status: 'applied' | 'rolled_back';
  readonly source_hash: string;
  readonly output_hash: string;
  readonly backup_hash: string;
  readonly backup_path_hash: string;
  readonly target_mode: ProviderMode;
}

export function inspectArchitectureMigration(input: {
  configText: string;
  sessionMetadataPresent: boolean;
  command?: string | null;
}): ArchitectureMigrationPlan {
  const findings: MigrationFinding[] = [];
  const providerSections = [...input.configText.matchAll(/^\s*\[model_providers\.([A-Za-z0-9_-]+)\]\s*$/gm)].map((match) => match[1]).filter((value): value is string => Boolean(value));
  for (const provider of providerSections) findings.push({ kind: 'custom_provider', code: 'legacy_custom_provider_injection', removable_path: `model_providers.${provider}` });
  if (providerSections.length > 1) findings.push({ kind: 'mixed_catalog', code: 'legacy_mixed_provider_catalog', removable_path: null });
  if (!input.sessionMetadataPresent) findings.push({ kind: 'missing_session_metadata', code: 'legacy_session_metadata_missing', removable_path: null });
  if (input.command && /(?:\bux-review\b|\bvisual-review\b|--skip-evidence|--force-fast)/i.test(input.command)) {
    findings.push({ kind: 'obsolete_command', code: 'legacy_command_or_option_obsolete', removable_path: null });
  }
  const ambiguous = findings.some((finding) => finding.kind === 'mixed_catalog' || finding.kind === 'missing_session_metadata');
  return {
    schema: 'sks.architecture-migration-plan.v1',
    status: !findings.length ? 'no_op' : ambiguous ? 'migration_required' : 'ready',
    source_hash: hash(input.configText), findings,
    removable_paths: findings.flatMap((finding) => finding.removable_path ? [finding.removable_path] : []),
    blockers: ambiguous ? findings.filter((finding) => finding.kind === 'mixed_catalog' || finding.kind === 'missing_session_metadata').map((finding) => finding.code) : []
  };
}

export async function applyArchitectureMigration(input: {
  configPath: string;
  plan: ArchitectureMigrationPlan;
  targetMode: ProviderMode;
  loopbackBaseUrl?: string | null;
  confirmedRemovablePaths: readonly string[];
  explicitApply: boolean;
}): Promise<ArchitectureMigrationReceipt> {
  if (!input.explicitApply) throw new Error('architecture_migration_explicit_apply_required');
  if (input.plan.status !== 'ready') throw new Error('architecture_migration_plan_not_ready');
  const current = await fsp.readFile(input.configPath, 'utf8');
  if (hash(current) !== input.plan.source_hash) throw new Error('architecture_migration_user_edit_conflict');
  const confirmed = new Set(input.confirmedRemovablePaths);
  if (input.plan.removable_paths.some((entry) => !confirmed.has(entry))) throw new Error('architecture_migration_reference_proof_required');
  const stat = await fsp.stat(input.configPath);
  const migrated = migrateConfigText(current, input.targetMode, input.loopbackBaseUrl || null, input.plan.removable_paths);
  const write = await writeCodexConfigGuarded({
    root: path.dirname(input.configPath),
    configPath: input.configPath,
    before: current,
    mutate: () => migrated,
    cause: 'architecture-migration',
    backupTag: 'architecture-backup',
    ownershipVerified: true,
    verifyUnchangedBeforeWrite: true,
    expectedBeforeExists: true,
    expectedBeforeMode: stat.mode & 0o777,
    preserveTextFormatting: true
  });
  if (!write.ok || !write.changed || !write.backup_path) throw new Error(`architecture_migration_${write.status}`);
  return {
    schema: 'sks.architecture-migration-receipt.v1', status: 'applied', source_hash: input.plan.source_hash,
    output_hash: hash(migrated), backup_hash: hash(current), backup_path_hash: hash(path.resolve(write.backup_path)), target_mode: input.targetMode
  };
}

export async function rollbackArchitectureMigration(input: {
  configPath: string;
  backupPath: string;
  receipt: ArchitectureMigrationReceipt;
  explicitRollback: boolean;
}): Promise<ArchitectureMigrationReceipt> {
  if (!input.explicitRollback) throw new Error('architecture_migration_explicit_rollback_required');
  const current = await fsp.readFile(input.configPath, 'utf8');
  if (hash(current) !== input.receipt.output_hash) throw new Error('architecture_migration_rollback_conflict');
  const backup = await fsp.readFile(input.backupPath, 'utf8');
  if (hash(backup) !== input.receipt.backup_hash || hash(path.resolve(input.backupPath)) !== input.receipt.backup_path_hash) {
    throw new Error('architecture_migration_backup_mismatch');
  }
  const stat = await fsp.stat(input.configPath);
  const write = await writeCodexConfigGuarded({
    root: path.dirname(input.configPath),
    configPath: input.configPath,
    before: current,
    mutate: () => backup,
    cause: 'architecture-migration-rollback',
    backupTag: `architecture-rollback-${randomUUID()}`,
    ownershipVerified: true,
    verifyUnchangedBeforeWrite: true,
    expectedBeforeExists: true,
    expectedBeforeMode: stat.mode & 0o777,
    preserveTextFormatting: true
  });
  if (!write.ok || !write.changed) throw new Error(`architecture_migration_${write.status}`);
  return { ...input.receipt, status: 'rolled_back', output_hash: hash(backup) };
}

function migrateConfigText(source: string, mode: ProviderMode, loopbackBaseUrl: string | null, removablePaths: readonly string[]): string {
  if (mode !== 'chatgpt-oauth') {
    const parsed = loopbackBaseUrl ? new URL(loopbackBaseUrl) : null;
    if (!parsed || parsed.protocol !== 'http:' || !['127.0.0.1', '::1', 'localhost'].includes(parsed.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error('architecture_migration_loopback_required');
    }
  }
  const removable = new Set(removablePaths);
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skip = false;
  for (const line of lines) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1] || null;
    if (section) skip = removable.has(section);
    if (!skip) kept.push(line);
  }
  let text = kept.join('\n').replace(/^\s*#\s*sks-managed-provider-mode:.*$/gm, '').replace(/^\s*model_provider\s*=.*$/gm, '').replace(/^\s*openai_base_url\s*=.*$/gm, '').trim();
  const header = [`# sks-managed-provider-mode:${mode}`, 'model_provider = "openai"'];
  if (mode !== 'chatgpt-oauth') header.push(`openai_base_url = ${JSON.stringify(loopbackBaseUrl)}`);
  return `${header.join('\n')}\n${text ? `${text}\n` : ''}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
