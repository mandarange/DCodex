import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ProviderMode } from '../../architecture-hardening/contracts/contracts.js';

export interface EvidenceKeyV2Input {
  readonly project_id: string;
  readonly criterion: string;
  readonly check: string;
  readonly direct_target_hashes: readonly string[];
  readonly direct_dependency_hashes: readonly string[];
  readonly auth_mode: ProviderMode;
  readonly model_policy_hash: string;
  readonly validator_rule: string;
  readonly validator_version: string;
  readonly environment_hash: string;
  readonly toolchain_hash: string;
}

export interface EvidenceKeyV2 {
  readonly schema: 'sks.evidence-key.v2';
  readonly key: string;
  readonly project_id: string;
  readonly criterion: string;
  readonly check: string;
  readonly direct_target_hashes: readonly string[];
  readonly direct_dependency_merkle: string;
  readonly auth_mode: ProviderMode;
  readonly model_policy_hash: string;
  readonly validator_rule: string;
  readonly validator_version: string;
  readonly environment_hash: string;
  readonly toolchain_hash: string;
}

export interface EvidenceReceiptV2 {
  readonly id: string;
  readonly evidence: EvidenceKeyV2;
  readonly direct_dependency_hashes: readonly string[];
}

export interface EvidenceInvalidationChange {
  readonly target_hashes?: readonly string[];
  readonly dependency_hashes?: readonly string[];
  readonly auth_mode?: ProviderMode;
  readonly model_policy_hash?: string;
  readonly validator_rule?: string;
  readonly validator_version?: string;
  readonly environment_hash?: string;
  readonly toolchain_hash?: string;
}

export function createProjectId(): string {
  return `sksproj_${randomBytes(24).toString('hex')}`;
}

export async function ensureProjectId(file: string): Promise<string> {
  const resolved = path.resolve(file);
  try {
    return validateProjectId((await fsp.readFile(resolved, 'utf8')).trim());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await fsp.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const projectId = createProjectId();
  try {
    await fsp.writeFile(resolved, `${projectId}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return projectId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return validateProjectId((await fsp.readFile(resolved, 'utf8')).trim());
  }
}

export function buildEvidenceKeyV2(input: EvidenceKeyV2Input): EvidenceKeyV2 {
  const projectId = validateProjectId(input.project_id);
  const directTargets = normalizeHashes(input.direct_target_hashes, 'evidence_target_hash_invalid');
  const directDependencies = normalizeHashes(input.direct_dependency_hashes, 'evidence_dependency_hash_invalid');
  const base = {
    schema: 'sks.evidence-key.v2' as const,
    project_id: projectId,
    criterion: safeId(input.criterion, 'evidence_criterion_invalid'),
    check: safeId(input.check, 'evidence_check_invalid'),
    direct_target_hashes: directTargets,
    direct_dependency_merkle: merkle(directDependencies),
    auth_mode: input.auth_mode,
    model_policy_hash: hashValue(input.model_policy_hash, 'evidence_model_policy_hash_invalid'),
    validator_rule: safeId(input.validator_rule, 'evidence_validator_rule_invalid'),
    validator_version: safeId(input.validator_version, 'evidence_validator_version_invalid'),
    environment_hash: hashValue(input.environment_hash, 'evidence_environment_hash_invalid'),
    toolchain_hash: hashValue(input.toolchain_hash, 'evidence_toolchain_hash_invalid')
  };
  return Object.freeze({ ...base, direct_target_hashes: Object.freeze(base.direct_target_hashes), key: hash(stableJson(base)) });
}

export function selectAffectedReceipts(
  receipts: readonly EvidenceReceiptV2[],
  change: EvidenceInvalidationChange
): readonly EvidenceReceiptV2[] {
  const changedTargets = new Set(change.target_hashes || []);
  const changedDependencies = new Set(change.dependency_hashes || []);
  return receipts.filter((receipt) => {
    const evidence = receipt.evidence;
    return evidence.direct_target_hashes.some((value) => changedTargets.has(value))
      || receipt.direct_dependency_hashes.some((value) => changedDependencies.has(value))
      || (change.auth_mode !== undefined && change.auth_mode !== evidence.auth_mode)
      || (change.model_policy_hash !== undefined && change.model_policy_hash !== evidence.model_policy_hash)
      || (change.validator_rule !== undefined && change.validator_rule !== evidence.validator_rule)
      || (change.validator_version !== undefined && change.validator_version !== evidence.validator_version)
      || (change.environment_hash !== undefined && change.environment_hash !== evidence.environment_hash)
      || (change.toolchain_hash !== undefined && change.toolchain_hash !== evidence.toolchain_hash);
  });
}

export function safeEvidenceKeyProjection(evidence: EvidenceKeyV2): string {
  return JSON.stringify(evidence);
}

function validateProjectId(value: string): string {
  if (!/^sksproj_[a-f0-9]{48}$/.test(value)) throw new Error('evidence_project_id_invalid');
  return value;
}

function normalizeHashes(values: readonly string[], code: string): string[] {
  const normalized = [...new Set(values)].sort();
  if (!normalized.length || normalized.some((value) => !/^[a-f0-9]{64}$/.test(value))) throw new Error(code);
  return normalized;
}

function merkle(values: readonly string[]): string {
  let layer = values.map((value) => hash(`leaf:${value}`));
  while (layer.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index];
      if (!left) throw new Error('evidence_merkle_invalid');
      next.push(hash(`node:${left}:${layer[index + 1] || left}`));
    }
    layer = next;
  }
  const root = layer[0];
  if (!root) throw new Error('evidence_dependency_hash_invalid');
  return root;
}

function safeId(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(String(value || ''))) throw new Error(code);
  return value;
}

function hashValue(value: string, code: string): string {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(code);
  return value;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
