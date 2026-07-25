import fsp from 'node:fs/promises';
import { GIT_POLICY_SCHEMA, SHARED_MEMORY_MANIFEST_SCHEMA, type SksGitPolicy, type SharedMemoryManifest } from './git-policy.js';
import { isMockPositiveSharedClaim, sharedRecordHasSecret } from './shared-memory-security.js';
import { asRecordOrEmpty as asRecord } from '../json/records.js';

export interface ValidationResult {
  ok: boolean;
  checked: number;
  issues: string[];
}

export function validateGitPolicy(policy: unknown): ValidationResult {
  const issues: string[] = [];
  const row = asRecord(policy);
  if (row.schema !== GIT_POLICY_SCHEMA) issues.push('schema');
  if (!['solo', 'work', 'strict-work', 'ci'].includes(String(row.mode || ''))) issues.push('mode');
  if (!Array.isArray(asRecord(row.shared_memory).track)) issues.push('shared_memory.track');
  if (!Array.isArray(asRecord(row.local_runtime).ignore)) issues.push('local_runtime.ignore');
  if (!Number.isFinite(Number(asRecord(row.large_artifacts).max_tracked_file_bytes))) issues.push('large_artifacts.max_tracked_file_bytes');
  return { ok: issues.length === 0, checked: 1, issues };
}

export function validateSharedMemoryManifest(manifest: unknown): ValidationResult {
  const issues: string[] = [];
  const row = asRecord(manifest) as Partial<SharedMemoryManifest>;
  if (row.schema !== SHARED_MEMORY_MANIFEST_SCHEMA) issues.push('schema');
  if (!Array.isArray(row.shared_memory_plane)) issues.push('shared_memory_plane');
  if (!Array.isArray(row.local_runtime_plane)) issues.push('local_runtime_plane');
  return { ok: issues.length === 0, checked: 1, issues };
}

export function validateSharedRecord(record: unknown, policy?: SksGitPolicy): ValidationResult {
  const issues: string[] = [];
  const row = asRecord(record);
  const schema = String(row.schema || '');
  if (![
    'sks.triwiki-claim-record.v1',
    'sks.triwiki-wrongness-record.v1',
    'sks.triwiki-wrongness.v1',
    'sks.image-voxel-record.v1',
    'sks.avoidance-rule-record.v1'
  ].includes(schema)) issues.push(`schema:${schema || 'missing'}`);
  if (!String(row.id || '').trim()) issues.push('id');
  if (policy?.security?.block_secret_patterns && sharedRecordHasSecret(record)) issues.push('secret');
  if (policy?.security?.block_mock_real_confusion && isMockPositiveSharedClaim(record)) issues.push('mock_positive_claim');
  return { ok: issues.length === 0, checked: 1, issues };
}

export async function validateSharedRecordFile(file: string, policy?: SksGitPolicy): Promise<ValidationResult> {
  try {
    const record = JSON.parse(await fsp.readFile(file, 'utf8'));
    return validateSharedRecord(record, policy);
  } catch (err) {
    return { ok: false, checked: 1, issues: [`invalid_json:${err instanceof Error ? err.message : String(err)}`] };
  }
}
