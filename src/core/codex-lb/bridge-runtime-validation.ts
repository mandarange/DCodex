import type {
  CatalogSyncState,
  CombinedCatalogSyncStatus,
  DesktopBridgeStatusV3,
  DesktopCapabilityReportV3,
  HttpProbeResult,
  ScopeCapabilitySummary,
  WebSocketProbeResult
} from './bridge-contracts.js';
import {
  validateCapabilitySummary,
  validateExecution,
  validateScope
} from './bridge-runtime-validation/capability.js';
import { validateCombinedCatalog } from './bridge-runtime-validation/catalog.js';
import {
  booleanValue,
  LEVELS,
  PROVIDERS,
  enumValue,
  exact,
  iso,
  literal,
  nonEmptyString,
  nullableString,
  object,
  record,
  scanForbiddenKeys,
  stringArray
} from './bridge-runtime-validation/shared.js';
import {
  validateHttpProbeResult,
  validateManagement,
  validateNativeIdentity,
  validateProviderProfile,
  validateReadiness,
  validateRouting,
  validateService,
  validateWebSocketProbeResult
} from './bridge-runtime-validation/status.js';

export interface BridgeRuntimeValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

export function validateDesktopCapabilityReportV3(value: unknown): BridgeRuntimeValidationResult {
  const issues: string[] = [];
  const report = object(value, '$', issues);
  if (!report) return result(issues);
  exact(report, '$', [
    'schema', 'report_id', 'correlation_id', 'session_id', 'requested_level',
    'checked_at', 'catalog_generation', 'execution', 'bridge', 'native_identity',
    'providers', 'combined_catalog', 'summary', 'catalog_sync'
  ], issues);
  literal(report.schema, 'sks.desktop-capabilities.v3', '$.schema', issues);
  nonEmptyString(report.report_id, '$.report_id', issues);
  nonEmptyString(report.correlation_id, '$.correlation_id', issues);
  nonEmptyString(report.session_id, '$.session_id', issues);
  enumValue(report.requested_level, LEVELS, '$.requested_level', issues);
  iso(report.checked_at, '$.checked_at', issues);
  nullableString(report.catalog_generation, '$.catalog_generation', issues);
  validateExecution(report.execution, '$.execution', issues);

  validateScope(report.bridge, 'bridge', report, '$.bridge', issues);
  validateScope(report.native_identity, 'native-identity', report, '$.native_identity', issues);
  const providers = object(report.providers, '$.providers', issues);
  if (providers) {
    exact(providers, '$.providers', [...PROVIDERS], issues);
    validateScope(providers['codex-lb'], 'provider:codex-lb', report, '$.providers.codex-lb', issues);
    validateScope(providers.openrouter, 'provider:openrouter', report, '$.providers.openrouter', issues);
  }
  validateScope(report.combined_catalog, 'catalog:combined', report, '$.combined_catalog', issues);
  validateCapabilitySummary(report.summary, '$.summary', issues);
  validateCombinedCatalog(report.catalog_sync, '$.catalog_sync', issues);

  const catalog = record(report.catalog_sync);
  if (catalog && report.catalog_generation !== catalog.generation) {
    issues.push('$.catalog_generation:catalog_generation_mismatch');
  }
  scanForbiddenKeys(value, '$', issues);
  return result(issues);
}

export function validateDesktopBridgeStatusV3(value: unknown): BridgeRuntimeValidationResult {
  const issues: string[] = [];
  const status = object(value, '$', issues);
  if (!status) return result(issues);
  exact(status, '$', [
    'schema', 'checked_at', 'correlation_id', 'management', 'service', 'http_probe',
    'websocket_probe', 'native_identity', 'providers', 'routing', 'catalog_sync',
    'capabilities', 'readiness', 'recovery_actions',
    ...(Object.hasOwn(status, 'auth_priority') ? ['auth_priority'] : [])
  ], issues);
  if (status.auth_priority !== undefined) {
    const priority = object(status.auth_priority, '$.auth_priority', issues);
    if (priority) {
      exact(priority, '$.auth_priority', ['enabled', 'state', 'error'], issues);
      booleanValue(priority.enabled, '$.auth_priority.enabled', issues);
      enumValue(priority.state, new Set(['off', 'active', 'unavailable']), '$.auth_priority.state', issues);
      nullableString(priority.error, '$.auth_priority.error', issues);
    }
  }
  literal(status.schema, 'sks.desktop-bridge-status.v3', '$.schema', issues);
  iso(status.checked_at, '$.checked_at', issues);
  nonEmptyString(status.correlation_id, '$.correlation_id', issues);
  validateManagement(status.management, '$.management', issues);
  validateService(status.service, '$.service', issues);
  if (status.http_probe !== null) {
    validateHttpProbeResult(status.http_probe, '$.http_probe', issues);
  }
  if (status.websocket_probe !== null) {
    validateWebSocketProbeResult(status.websocket_probe, '$.websocket_probe', issues);
  }
  validateNativeIdentity(status.native_identity, '$.native_identity', issues);

  const providers = object(status.providers, '$.providers', issues);
  if (providers) {
    exact(providers, '$.providers', [...PROVIDERS], issues);
    validateProviderProfile(providers['codex-lb'], 'codex-lb', '$.providers.codex-lb', issues);
    validateProviderProfile(providers.openrouter, 'openrouter', '$.providers.openrouter', issues);
  }
  validateRouting(status.routing, '$.routing', issues);
  validateCombinedCatalog(status.catalog_sync, '$.catalog_sync', issues);
  if (status.capabilities !== null) {
    const reportValidation = validateDesktopCapabilityReportV3(status.capabilities);
    issues.push(...reportValidation.issues.map((issue) => `$.capabilities${issue.slice(1)}`));
    const capability = record(status.capabilities);
    const catalog = record(status.catalog_sync);
    if (capability && catalog && capability.catalog_generation !== catalog.generation) {
      issues.push('$.capabilities.catalog_generation:status_catalog_generation_mismatch');
    }
  }
  validateReadiness(status.readiness, '$.readiness', issues);
  stringArray(status.recovery_actions, '$.recovery_actions', issues);
  scanForbiddenKeys(value, '$', issues);
  return result(issues);
}

export function assertDesktopCapabilityReportV3(value: unknown): asserts value is DesktopCapabilityReportV3 {
  const validation = validateDesktopCapabilityReportV3(value);
  if (!validation.ok) {
    throw new Error(`capability_schema_invalid:${validation.issues[0] || 'unknown'}`);
  }
}

export function assertDesktopBridgeStatusV3(value: unknown): asserts value is DesktopBridgeStatusV3 {
  const validation = validateDesktopBridgeStatusV3(value);
  if (!validation.ok) {
    throw new Error(`desktop_bridge_status_schema_invalid:${validation.issues[0] || 'unknown'}`);
  }
}

function result(issues: string[]): BridgeRuntimeValidationResult {
  return { ok: issues.length === 0, issues: [...new Set(issues)] };
}

// Compile-time anchors keep the validator aligned with the frozen public facade.
void ({} as DesktopCapabilityReportV3);
void ({} as DesktopBridgeStatusV3);
void ({} as ScopeCapabilitySummary);
void ({} as CombinedCatalogSyncStatus);
void ({} as CatalogSyncState);
void ({} as HttpProbeResult);
void ({} as WebSocketProbeResult);
