import { createHash } from 'node:crypto';
import type { BridgeProviderId, ProviderSessionPin } from '../../codex-lb/bridge-contracts.js';
import { BRIDGE_PROVIDER_IDS } from '../../codex-lb/bridge-contracts.js';
import { canonicalizeBridgeModelId, normalizeBridgeUpstreamModelId } from '../../codex-lb/route-index.js';
import { canonicalJson } from '../../json/canonical.js';

export const ARCHITECTURE_HARDENING_CONTRACT_VERSION = 'sks.architecture-hardening.contracts.v2' as const;
export const MAX_AUDIT_PROJECTION_DEPTH = 32;

export type AuditJsonValue =
  | null
  | boolean
  | number
  | string
  | AuditJsonValue[]
  | { [key: string]: AuditJsonValue };

export interface HistoricalSessionPinV1 {
  readonly schema: 'sks.session-pin.v1';
  readonly session_id: string;
  readonly mode: 'chatgpt-oauth' | 'codex-lb' | 'openrouter';
  readonly model: string;
  readonly credential_class: 'codex-native-oauth' | 'codex-lb-api-key' | 'openrouter-api-key';
  readonly allowed_models: readonly string[];
  readonly lb_affinity_token_hash: string | null;
  readonly child_policy_hash: string;
  readonly catalog_version: string;
  readonly parent_session_id: string | null;
}

export interface HistoricalSessionPinDecodeContext {
  readonly current_provider_id: BridgeProviderId;
  readonly current_upstream_model: string;
  readonly current_catalog_generation: string;
  readonly current_route_policy_generation: string;
  readonly expected_child_policy_hash: string;
  readonly created_at: string;
}

export type HistoricalSessionPinDecodeBlocker =
  | 'historical_session_pin_invalid'
  | 'historical_session_pin_unknown_field'
  | 'historical_session_pin_mode_unsupported'
  | 'historical_session_pin_credential_mismatch'
  | 'historical_session_pin_model_invalid'
  | 'historical_session_pin_model_not_allowed'
  | 'historical_session_pin_hash_invalid'
  | 'historical_session_pin_semantics_unrepresentable'
  | 'historical_session_pin_provider_mismatch'
  | 'historical_session_pin_catalog_stale'
  | 'historical_session_pin_child_policy_mismatch'
  | 'historical_session_pin_context_invalid'
  | 'current_session_pin_invalid';

export type HistoricalSessionPinDecodeResult =
  | { readonly ok: true; readonly pin: ProviderSessionPin; readonly blocker: null }
  | { readonly ok: false; readonly pin: null; readonly blocker: HistoricalSessionPinDecodeBlocker };

export class ArchitectureContractError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'ArchitectureContractError';
    this.code = code;
  }
}

const HISTORICAL_SESSION_PIN_KEYS = [
  'schema',
  'session_id',
  'mode',
  'model',
  'credential_class',
  'allowed_models',
  'lb_affinity_token_hash',
  'child_policy_hash',
  'catalog_version',
  'parent_session_id'
] as const;
const CURRENT_SESSION_PIN_KEYS = [
  'thread_id',
  'provider_id',
  'public_model',
  'upstream_model',
  'catalog_generation',
  'route_policy_generation',
  'created_at'
] as const;
const PROVIDERS = new Set<string>(BRIDGE_PROVIDER_IDS);
const PROHIBITED_AUDIT_FIELDS = new Set([
  'account_id',
  'api_key',
  'authorization',
  'client_secret',
  'cookie',
  'credential_fingerprint',
  'password',
  'refresh_token',
  'request_body',
  'secret',
  'set_cookie',
  'access_token'
]);

/**
 * Convert a historical pin only when the caller supplies matching, current
 * bridge routing facts. Unsupported or lossy historical semantics fail closed.
 * This function does not select a provider or mutate runtime routing state.
 */
export function decodeHistoricalSessionPinV1(
  value: unknown,
  context: HistoricalSessionPinDecodeContext
): HistoricalSessionPinDecodeResult {
  const row = record(value);
  if (!row || row.schema !== 'sks.session-pin.v1') return decodeFailure('historical_session_pin_invalid');
  if (!hasExactKeys(row, HISTORICAL_SESSION_PIN_KEYS)) return decodeFailure('historical_session_pin_unknown_field');

  const provider = historicalProvider(row.mode);
  if (!provider) return decodeFailure('historical_session_pin_mode_unsupported');
  if (row.credential_class !== credentialClassForProvider(provider)) {
    return decodeFailure('historical_session_pin_credential_mismatch');
  }
  const sessionId = safeIdentifier(row.session_id);
  const publicModel = canonicalizeBridgeModelId(row.model);
  if (!sessionId || !publicModel) return decodeFailure('historical_session_pin_model_invalid');
  const allowedModels = canonicalModelArray(row.allowed_models);
  if (!allowedModels || !allowedModels.includes(publicModel)) {
    return decodeFailure('historical_session_pin_model_not_allowed');
  }
  if (!safeHash(row.child_policy_hash)
    || (row.lb_affinity_token_hash !== null && !safeHash(row.lb_affinity_token_hash))) {
    return decodeFailure('historical_session_pin_hash_invalid');
  }
  if (row.lb_affinity_token_hash !== null || row.parent_session_id !== null) {
    return decodeFailure('historical_session_pin_semantics_unrepresentable');
  }

  if (!validDecodeContext(context)) return decodeFailure('historical_session_pin_context_invalid');
  if (provider !== context.current_provider_id) return decodeFailure('historical_session_pin_provider_mismatch');
  if (row.catalog_version !== context.current_catalog_generation) {
    return decodeFailure('historical_session_pin_catalog_stale');
  }
  if (row.child_policy_hash !== context.expected_child_policy_hash) {
    return decodeFailure('historical_session_pin_child_policy_mismatch');
  }

  const pin: ProviderSessionPin = {
    thread_id: sessionId,
    provider_id: provider,
    public_model: publicModel,
    upstream_model: context.current_upstream_model,
    catalog_generation: context.current_catalog_generation,
    route_policy_generation: context.current_route_policy_generation,
    created_at: context.created_at
  };
  return validateCurrentProviderSessionPin(pin)
    ? { ok: true, pin, blocker: null }
    : decodeFailure('current_session_pin_invalid');
}

export function validateCurrentProviderSessionPin(value: unknown): value is ProviderSessionPin {
  const row = record(value);
  if (!row || !hasExactKeys(row, CURRENT_SESSION_PIN_KEYS)) return false;
  const publicModel = canonicalizeBridgeModelId(row.public_model);
  const upstreamModel = normalizeBridgeUpstreamModelId(row.upstream_model);
  return Boolean(
    safeIdentifier(row.thread_id)
    && PROVIDERS.has(String(row.provider_id))
    && publicModel
    && publicModel === row.public_model
    && upstreamModel
    && upstreamModel === row.upstream_model
    && safeGeneration(row.catalog_generation)
    && safeGeneration(row.route_policy_generation)
    && validIso(row.created_at)
  );
}

/** Build a deterministic, JSON-only audit value or throw a stable error code. */
export function createSafeAuditProjection(value: unknown): AuditJsonValue {
  const ancestors = new WeakSet<object>();
  return projectAuditValue(value, 0, ancestors);
}

export function assertSafeAuditProjection(value: unknown): void {
  createSafeAuditProjection(value);
}

export function stableArchitectureHash(value: unknown): string {
  const projection = createSafeAuditProjection(value);
  return createHash('sha256').update(canonicalJson(projection)).digest('hex');
}

export function jsonRoundTrip<T extends AuditJsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(createSafeAuditProjection(value))) as T;
}

function projectAuditValue(value: unknown, depth: number, ancestors: WeakSet<object>): AuditJsonValue {
  if (depth > MAX_AUDIT_PROJECTION_DEPTH) fail('audit_projection_depth_exceeded');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('audit_projection_number_invalid');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('audit_projection_value_unsupported');
  if (ancestors.has(value)) fail('audit_projection_cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key === 'symbol'
        || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) {
        fail('audit_projection_array_property_unsupported');
      }
      const projected: AuditJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) fail('audit_projection_sparse_array');
        projected.push(projectAuditValue(value[index], depth + 1, ancestors));
      }
      return projected;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('audit_projection_object_unsupported');
    if (Object.getOwnPropertySymbols(value).length > 0) fail('audit_projection_symbol_key');
    const projected: Record<string, AuditJsonValue> = {};
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key]!;
      if (!descriptor.enumerable) continue;
      if (!('value' in descriptor)) fail('audit_projection_accessor_unsupported');
      if (isSensitiveAuditField(key)) fail('audit_projection_prohibited_field');
      projected[key] = projectAuditValue(descriptor.value, depth + 1, ancestors);
    }
    return projected;
  } finally {
    ancestors.delete(value);
  }
}

function isSensitiveAuditField(key: string): boolean {
  const normalized = key.trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (PROHIBITED_AUDIT_FIELDS.has(normalized)) return true;
  return [...PROHIBITED_AUDIT_FIELDS].some((field) => normalized.endsWith(`_${field}`));
}

function validDecodeContext(context: HistoricalSessionPinDecodeContext): boolean {
  return PROVIDERS.has(String(context.current_provider_id))
    && normalizeBridgeUpstreamModelId(context.current_upstream_model) === context.current_upstream_model
    && safeGeneration(context.current_catalog_generation)
    && safeGeneration(context.current_route_policy_generation)
    && safeHash(context.expected_child_policy_hash)
    && validIso(context.created_at);
}

function historicalProvider(value: unknown): BridgeProviderId | null {
  return value === 'codex-lb' || value === 'openrouter' ? value : null;
}

function credentialClassForProvider(provider: BridgeProviderId): HistoricalSessionPinV1['credential_class'] {
  return provider === 'codex-lb' ? 'codex-lb-api-key' : 'openrouter-api-key';
}

function canonicalModelArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 10_000) return null;
  const models: string[] = [];
  for (const entry of value) {
    const model = canonicalizeBridgeModelId(entry);
    if (!model || model !== entry || models.includes(model)) return null;
    models.push(model);
  }
  return models;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasExactKeys(row: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(row);
  const allowed = new Set(expected);
  return keys.length === expected.length
    && keys.every((key) => allowed.has(key))
    && expected.every((key) => Object.prototype.hasOwnProperty.call(row, key));
}

function safeIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 240 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) ? text : null;
}

function safeGeneration(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 240
    && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

function safeHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === 'string'
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
}

function decodeFailure(blocker: HistoricalSessionPinDecodeBlocker): HistoricalSessionPinDecodeResult {
  return { ok: false, pin: null, blocker };
}

function fail(code: string): never {
  throw new ArchitectureContractError(code);
}
