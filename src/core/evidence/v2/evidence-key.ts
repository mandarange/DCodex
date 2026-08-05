import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { BridgeProviderId } from '../../codex-lb/bridge-contracts.js';
import { sha256 } from '../../fsx.js';
import { canonicalJson } from '../../json/canonical.js';

/**
 * Evidence-only snapshot of the route that produced a receipt.
 *
 * This is deliberately data, not a runtime selector: it carries no endpoint,
 * credential, fallback, or transport configuration.
 */
export interface EvidenceRouteContextV2 {
  readonly provider_id: BridgeProviderId;
  readonly public_model: string;
  readonly upstream_model: string;
  readonly catalog_generation: string;
  readonly route_policy_generation: string;
}

export interface EvidenceKeyV2Input {
  readonly project_id: string;
  readonly criterion: string;
  readonly check: string;
  readonly direct_target_hashes: readonly string[];
  readonly direct_dependency_hashes: readonly string[];
  readonly provider_route_context: EvidenceRouteContextV2;
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
  readonly provider_route_context: EvidenceRouteContextV2;
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
  readonly provider_route_context?: EvidenceRouteContextV2;
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
  const routeContext = normalizeRouteContext(input.provider_route_context);
  const base = {
    schema: 'sks.evidence-key.v2' as const,
    project_id: projectId,
    criterion: safeId(input.criterion, 'evidence_criterion_invalid'),
    check: safeId(input.check, 'evidence_check_invalid'),
    direct_target_hashes: directTargets,
    direct_dependency_merkle: merkle(directDependencies),
    provider_route_context: routeContext,
    model_policy_hash: hashValue(input.model_policy_hash, 'evidence_model_policy_hash_invalid'),
    validator_rule: safeId(input.validator_rule, 'evidence_validator_rule_invalid'),
    validator_version: safeId(input.validator_version, 'evidence_validator_version_invalid'),
    environment_hash: hashValue(input.environment_hash, 'evidence_environment_hash_invalid'),
    toolchain_hash: hashValue(input.toolchain_hash, 'evidence_toolchain_hash_invalid')
  };

  return Object.freeze({
    ...base,
    direct_target_hashes: Object.freeze(base.direct_target_hashes),
    provider_route_context: Object.freeze(base.provider_route_context),
    key: sha256(canonicalJson(base))
  });
}

export function selectAffectedReceipts(
  receipts: readonly EvidenceReceiptV2[],
  change: EvidenceInvalidationChange
): readonly EvidenceReceiptV2[] {
  const changedTargets = new Set(change.target_hashes || []);
  const changedDependencies = new Set(change.dependency_hashes || []);
  const changedRouteContext = change.provider_route_context === undefined
    ? undefined
    : canonicalJson(normalizeRouteContext(change.provider_route_context));

  return receipts.filter((receipt) => {
    const evidence = receipt.evidence;
    return evidence.direct_target_hashes.some((value) => changedTargets.has(value))
      || receipt.direct_dependency_hashes.some((value) => changedDependencies.has(value))
      || (changedRouteContext !== undefined
        && changedRouteContext !== canonicalJson(evidence.provider_route_context))
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

function normalizeRouteContext(value: EvidenceRouteContextV2): EvidenceRouteContextV2 {
  if (!value || !['codex-lb', 'openrouter'].includes(value.provider_id)) {
    throw new Error('evidence_route_provider_invalid');
  }
  return {
    provider_id: value.provider_id,
    public_model: safeModelId(value.public_model, 'evidence_route_public_model_invalid'),
    upstream_model: safeModelId(value.upstream_model, 'evidence_route_upstream_model_invalid'),
    catalog_generation: safeId(value.catalog_generation, 'evidence_route_catalog_generation_invalid'),
    route_policy_generation: safeId(value.route_policy_generation, 'evidence_route_policy_generation_invalid')
  };
}

function merkle(values: readonly string[]): string {
  let layer = values.map((value) => sha256(`leaf:${value}`));
  while (layer.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index];
      if (!left) throw new Error('evidence_merkle_invalid');
      next.push(sha256(`node:${left}:${layer[index + 1] || left}`));
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

function safeModelId(value: string, code: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(String(value || ''))) throw new Error(code);
  return value;
}

function hashValue(value: string, code: string): string {
  if (!/^[a-f0-9]{64}$/.test(String(value || ''))) throw new Error(code);
  return value;
}
