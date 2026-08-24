import { BRIDGE_OFFICIAL_ROUTE_ID, BRIDGE_PROVIDER_IDS } from '../bridge-contracts.js';

export const PROVIDERS = BRIDGE_PROVIDER_IDS;
/** Registry providers plus the official `openai` identity route (OpenCodex OPENAI_CODEX_PROVIDER_ID). */
export const ROUTE_TARGET_IDS = [...BRIDGE_PROVIDER_IDS, BRIDGE_OFFICIAL_ROUTE_ID] as const;
export const LEVELS = new Set(['shallow', 'transport', 'deep']);
export const PROBE_STATES = new Set([
  'not_attempted', 'running', 'verified', 'degraded', 'blocked', 'failed',
  'unsupported', 'stale'
]);
export const PROBE_STAGES = new Set([
  'preflight', 'process', 'tcp_connect', 'http_health', 'websocket_upgrade',
  'websocket_protocol', 'frame_round_trip', 'clean_close', 'provider_auth',
  'catalog_sync', 'model_route', 'feature_request', 'feature_response',
  'artifact_validation', 'complete'
]);
export const EVIDENCE_SOURCES = new Set([
  'config', 'manifest', 'transport', 'desktop_ui', 'deep_probe', 'artifact'
]);
export const CATALOG_STATES = new Set([
  'not_started', 'syncing', 'verified', 'degraded', 'failed', 'stale'
]);

const FORBIDDEN_SECRET_KEY = /^(?:api_?key|secret|token|authorization|cookie|set_cookie|password|bearer|headers?|env)$/i;

export function object(value: unknown, path: string, issues: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path}:object_required`);
    return null;
  }
  return value as Record<string, unknown>;
}

export function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function exact(
  row: Record<string, unknown>,
  path: string,
  expected: readonly string[],
  issues: string[]
): void {
  const allowed = new Set(expected);
  for (const key of expected) {
    if (!Object.hasOwn(row, key)) issues.push(`${path}.${escapePath(key)}:required`);
  }
  for (const key of Object.keys(row)) {
    if (!allowed.has(key)) issues.push(`${path}.${escapePath(key)}:unexpected`);
  }
}

export function literal(value: unknown, expected: unknown, path: string, issues: string[]): void {
  if (value !== expected) issues.push(`${path}:expected_${String(expected)}`);
}

export function enumValue(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: string[]
): void {
  if (typeof value !== 'string' || !allowed.has(value)) issues.push(`${path}:enum`);
}

export function nonEmptyString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${path}:non_empty_string_required`);
}

export function nullableString(value: unknown, path: string, issues: string[]): void {
  if (value !== null && typeof value !== 'string') issues.push(`${path}:nullable_string_required`);
}

export function booleanValue(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'boolean') issues.push(`${path}:boolean_required`);
}

export function integer(value: unknown, path: string, issues: string[], minimum?: number): void {
  if (!Number.isInteger(value) || (minimum !== undefined && Number(value) < minimum)) {
    issues.push(`${path}:integer_required`);
  }
}

export function nullableInteger(value: unknown, path: string, issues: string[]): void {
  if (value !== null && (!Number.isInteger(value) || Number(value) < 0)) {
    issues.push(`${path}:nullable_integer_required`);
  }
}

export function nullableNumber(value: unknown, path: string, issues: string[]): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    issues.push(`${path}:nullable_number_required`);
  }
}

export function iso(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    issues.push(`${path}:iso_timestamp_required`);
  }
}

export function nullableIso(value: unknown, path: string, issues: string[]): void {
  if (value !== null) iso(value, path, issues);
}

export function stringArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    issues.push(`${path}:string_array_required`);
  }
}

export function scanForbiddenKeys(value: unknown, path: string, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForbiddenKeys(entry, `${path}[${index}]`, issues));
    return;
  }
  const row = record(value);
  if (!row) return;
  for (const [key, entry] of Object.entries(row)) {
    const nextPath = `${path}.${escapePath(key)}`;
    if (FORBIDDEN_SECRET_KEY.test(key)) issues.push(`${nextPath}:secret_field_forbidden`);
    scanForbiddenKeys(entry, nextPath, issues);
  }
}

export function escapePath(value: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(value) ? value : JSON.stringify(value);
}
