import { createHash } from 'node:crypto';
import { canonicalJson } from '../../json/canonical.js';

export const ARCHITECTURE_HARDENING_CONTRACT_VERSION = 'sks.architecture-hardening.v1' as const;

export type ProviderMode = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';
export type CredentialClass = 'codex-native-oauth' | 'codex-lb-api-key' | 'openrouter-api-key';
export type CredentialReadinessCode =
  | 'ready'
  | 'not_found'
  | 'locked'
  | 'access_denied'
  | 'signing_mismatch'
  | 'damaged'
  | 'unavailable';

export interface CredentialReadiness {
  readonly status: CredentialReadinessCode;
  readonly reason_code: string | null;
}

export interface ProviderPolicySnapshot {
  readonly schema: 'sks.provider-policy-snapshot.v1';
  readonly contract_version: typeof ARCHITECTURE_HARDENING_CONTRACT_VERSION;
  readonly mode: ProviderMode;
  readonly credential_class: CredentialClass;
  readonly allowed_models: readonly string[];
  readonly child_policy_hash: string;
  readonly catalog_version: string;
}

export interface SessionPin {
  readonly schema: 'sks.session-pin.v1';
  readonly session_id: string;
  readonly mode: ProviderMode;
  readonly model: string;
  readonly credential_class: CredentialClass;
  readonly allowed_models: readonly string[];
  readonly lb_affinity_token_hash: string | null;
  readonly child_policy_hash: string;
  readonly catalog_version: string;
  readonly parent_session_id: string | null;
}

export interface ChildPolicySnapshot {
  readonly schema: 'sks.child-policy-snapshot.v1';
  readonly mode: ProviderMode;
  readonly owner: 'codex-native' | 'codex-lb' | 'sks-center';
  readonly allowed_models: readonly string[];
  readonly policy_hash: string;
}

export interface CatalogSnapshot {
  readonly schema: 'sks.catalog-snapshot.v1';
  readonly version: string;
  readonly models: readonly string[];
  readonly checked_at: string;
}

export interface FeatureCompatibility {
  readonly schema: 'sks.feature-compatibility.v1';
  readonly feature: string;
  readonly route: 'direct-proxy' | 'oauth-auxiliary' | 'unavailable';
  readonly oauth_required: boolean;
  readonly reason_code: string | null;
}

export type ApplyStageName = 'config_saved' | 'proxy_applied' | 'catalog_refreshed' | 'new_session_ready';
export type ApplyStageStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export interface ApplyStageReceipt {
  readonly schema: 'sks.apply-stage-receipt.v1';
  readonly stage: ApplyStageName;
  readonly status: ApplyStageStatus;
  readonly reason_code: string | null;
  readonly updated_at: string;
}

export interface RecoveryState {
  readonly schema: 'sks.recovery-state.v1';
  readonly status: 'running' | 'paused' | 'completed' | 'failed';
  readonly cause: string | null;
  readonly retry_count: number;
  readonly integrity_snapshot_hash: string;
  readonly resume_token_hash: string | null;
}

export interface IntentContractRef {
  readonly schema: 'sks.intent-contract-ref.v1';
  readonly contract_hash: string;
}

export interface EvidenceKeyRef {
  readonly schema: 'sks.evidence-key-ref.v2';
  readonly evidence_key: string;
}

export interface ArchitectureConfiguration {
  readonly schema: 'sks.architecture-configuration.v1';
  readonly policy: ProviderPolicySnapshot;
  readonly credential: CredentialReadiness;
  readonly catalog: CatalogSnapshot | null;
  readonly features: readonly FeatureCompatibility[];
}

export class ArchitectureContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ArchitectureContractError';
    this.code = code;
  }
}

const PROVIDER_MODES = new Set<ProviderMode>(['chatgpt-oauth', 'codex-lb', 'openrouter']);
const CREDENTIAL_CLASSES = new Set<CredentialClass>(['codex-native-oauth', 'codex-lb-api-key', 'openrouter-api-key']);
const PROHIBITED_AUDIT_FIELDS = new Set([
  'api_key',
  'secret',
  'authorization',
  'account_id',
  'request_body',
  'credential_fingerprint',
  'refresh_token',
  'access_token'
]);
const MAX_AUDIT_PROJECTION_DEPTH = 64;

export function credentialClassForMode(mode: ProviderMode): CredentialClass {
  if (mode === 'chatgpt-oauth') return 'codex-native-oauth';
  if (mode === 'codex-lb') return 'codex-lb-api-key';
  return 'openrouter-api-key';
}

export function stableArchitectureHash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function parseProviderPolicySnapshot(value: unknown): ProviderPolicySnapshot {
  const row = objectRecord(value, 'provider_policy_invalid');
  exactKeys(row, [
    'schema', 'contract_version', 'mode', 'credential_class', 'allowed_models', 'child_policy_hash', 'catalog_version'
  ], 'provider_policy_unknown_field');
  if (row.schema !== 'sks.provider-policy-snapshot.v1') fail('provider_policy_schema_invalid');
  if (row.contract_version !== ARCHITECTURE_HARDENING_CONTRACT_VERSION) fail('provider_policy_version_mismatch');
  if (!PROVIDER_MODES.has(row.mode as ProviderMode)) fail('provider_policy_mode_invalid');
  if (!CREDENTIAL_CLASSES.has(row.credential_class as CredentialClass)) fail('provider_policy_credential_class_invalid');
  if (credentialClassForMode(row.mode as ProviderMode) !== row.credential_class) fail('provider_policy_credential_class_mismatch');
  const models = stringArray(row.allowed_models, 'provider_policy_allowed_models_invalid');
  if (models.length !== new Set(models).size || models.some((model) => !model.trim())) fail('provider_policy_allowed_models_invalid');
  if (!safeHash(row.child_policy_hash)) fail('provider_policy_child_hash_invalid');
  if (!safeVersion(row.catalog_version)) fail('provider_policy_catalog_version_invalid');
  return value as ProviderPolicySnapshot;
}

export function validateArchitectureConfiguration(value: unknown): ArchitectureConfiguration {
  const row = objectRecord(value, 'architecture_configuration_invalid');
  exactKeys(row, ['schema', 'policy', 'credential', 'catalog', 'features'], 'architecture_configuration_unknown_field');
  if (row.schema !== 'sks.architecture-configuration.v1') fail('architecture_configuration_schema_invalid');
  parseProviderPolicySnapshot(row.policy);
  validateCredentialReadiness(row.credential);
  if (row.catalog !== null) validateCatalogSnapshot(row.catalog);
  if (!Array.isArray(row.features)) fail('architecture_configuration_features_invalid');
  for (const feature of row.features) validateFeatureCompatibility(feature);
  assertSafeAuditProjection(value);
  return value as ArchitectureConfiguration;
}

export function assertProviderPolicyCompatible(expected: ProviderPolicySnapshot, actual: ProviderPolicySnapshot): void {
  parseProviderPolicySnapshot(expected);
  parseProviderPolicySnapshot(actual);
  if (expected.mode !== actual.mode) fail('provider_policy_mode_mismatch');
  if (expected.credential_class !== actual.credential_class) fail('provider_policy_credential_mismatch');
  if (expected.child_policy_hash !== actual.child_policy_hash) fail('provider_policy_child_mismatch');
  if (expected.catalog_version !== actual.catalog_version) fail('provider_policy_catalog_mismatch');
  if (canonicalJson([...expected.allowed_models].sort()) !== canonicalJson([...actual.allowed_models].sort())) {
    fail('provider_policy_model_allowlist_mismatch');
  }
}

export function assertSafeAuditProjection(value: unknown): void {
  const ancestors = new WeakSet<object>();
  const visit = (current: unknown, depth: number): void => {
    if (depth > MAX_AUDIT_PROJECTION_DEPTH) fail('audit_projection_depth_exceeded');
    if (Array.isArray(current)) {
      if (ancestors.has(current)) fail('audit_projection_cycle');
      ancestors.add(current);
      try {
        for (const item of current) visit(item, depth + 1);
      } finally {
        ancestors.delete(current);
      }
      return;
    }
    if (!current || typeof current !== 'object') return;
    if (ancestors.has(current)) fail('audit_projection_cycle');
    ancestors.add(current);
    try {
      for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
        if (PROHIBITED_AUDIT_FIELDS.has(key.toLowerCase())) fail('audit_projection_prohibited_field');
        visit(item, depth + 1);
      }
    } finally {
      ancestors.delete(current);
    }
  };
  visit(value, 0);
}

export function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function validateCredentialReadiness(value: unknown): void {
  const row = objectRecord(value, 'credential_readiness_invalid');
  exactKeys(row, ['status', 'reason_code'], 'credential_readiness_unknown_field');
  const statuses = new Set<CredentialReadinessCode>(['ready', 'not_found', 'locked', 'access_denied', 'signing_mismatch', 'damaged', 'unavailable']);
  if (!statuses.has(row.status as CredentialReadinessCode)) fail('credential_readiness_status_invalid');
  if (row.reason_code !== null && !safeReason(row.reason_code)) fail('credential_readiness_reason_invalid');
  if ((row.status === 'ready') !== (row.reason_code === null)) fail('credential_readiness_reason_mismatch');
}

function validateCatalogSnapshot(value: unknown): void {
  const row = objectRecord(value, 'catalog_snapshot_invalid');
  exactKeys(row, ['schema', 'version', 'models', 'checked_at'], 'catalog_snapshot_unknown_field');
  if (row.schema !== 'sks.catalog-snapshot.v1' || !safeVersion(row.version)) fail('catalog_snapshot_invalid');
  const models = stringArray(row.models, 'catalog_models_invalid');
  if (models.some((model) => !model.trim()) || models.length !== new Set(models).size) fail('catalog_models_invalid');
  if (typeof row.checked_at !== 'string' || !Number.isFinite(Date.parse(row.checked_at))) fail('catalog_checked_at_invalid');
}

function validateFeatureCompatibility(value: unknown): void {
  const row = objectRecord(value, 'feature_compatibility_invalid');
  exactKeys(row, ['schema', 'feature', 'route', 'oauth_required', 'reason_code'], 'feature_compatibility_unknown_field');
  if (row.schema !== 'sks.feature-compatibility.v1') fail('feature_compatibility_schema_invalid');
  if (!safeVersion(row.feature)) fail('feature_compatibility_feature_invalid');
  if (!new Set(['direct-proxy', 'oauth-auxiliary', 'unavailable']).has(String(row.route))) fail('feature_compatibility_route_invalid');
  if (typeof row.oauth_required !== 'boolean') fail('feature_compatibility_oauth_invalid');
  if (row.reason_code !== null && !safeReason(row.reason_code)) fail('feature_compatibility_reason_invalid');
}

function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], code: string): void {
  const known = new Set(allowed);
  if (Object.keys(row).some((key) => !known.has(key))) fail(code);
  if (allowed.some((key) => !(key in row))) fail(code);
}

function stringArray(value: unknown, code: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) fail(code);
  return value as string[];
}

function safeReason(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{2,99}$/.test(value);
}

function safeVersion(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function fail(code: string): never {
  throw new ArchitectureContractError(code);
}
