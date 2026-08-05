import type {
  BridgeProviderId,
  CatalogSyncState,
  CombinedCatalogSyncStatus,
  DesktopBridgeStatusV3,
  DesktopCapabilityReportV3,
  HttpProbeResult,
  ScopeCapabilitySummary,
  WebSocketProbeResult
} from './bridge-contracts.js';

export interface BridgeRuntimeValidationResult {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

const PROVIDERS = ['codex-lb', 'openrouter'] as const;
const LEVELS = new Set(['shallow', 'transport', 'deep']);
const SCOPES = new Set(['bridge', 'native-identity', 'provider:codex-lb', 'provider:openrouter', 'catalog:combined']);
const PROBE_STATES = new Set(['not_attempted', 'running', 'verified', 'degraded', 'blocked', 'failed', 'unsupported', 'stale']);
const PROBE_STAGES = new Set([
  'preflight', 'process', 'tcp_connect', 'http_health', 'websocket_upgrade',
  'websocket_protocol', 'frame_round_trip', 'clean_close', 'provider_auth',
  'catalog_sync', 'model_route', 'feature_request', 'feature_response',
  'artifact_validation', 'complete'
]);
const EVIDENCE_SOURCES = new Set(['config', 'manifest', 'transport', 'desktop_ui', 'deep_probe', 'artifact']);
const CATALOG_STATES = new Set(['not_started', 'syncing', 'verified', 'degraded', 'failed', 'stale']);
const FORBIDDEN_SECRET_KEY = /^(?:api_?key|secret|token|authorization|cookie|set_cookie|password|bearer|headers?|env)$/i;

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
    'capabilities', 'readiness', 'recovery_actions'
  ], issues);
  literal(status.schema, 'sks.desktop-bridge-status.v3', '$.schema', issues);
  iso(status.checked_at, '$.checked_at', issues);
  nonEmptyString(status.correlation_id, '$.correlation_id', issues);
  validateManagement(status.management, '$.management', issues);
  validateService(status.service, '$.service', issues);
  if (status.http_probe !== null) validateHttpProbeResult(status.http_probe, '$.http_probe', issues);
  if (status.websocket_probe !== null) validateWebSocketProbeResult(status.websocket_probe, '$.websocket_probe', issues);
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
  if (!validation.ok) throw new Error(`capability_schema_invalid:${validation.issues[0] || 'unknown'}`);
}

export function assertDesktopBridgeStatusV3(value: unknown): asserts value is DesktopBridgeStatusV3 {
  const validation = validateDesktopBridgeStatusV3(value);
  if (!validation.ok) throw new Error(`desktop_bridge_status_schema_invalid:${validation.issues[0] || 'unknown'}`);
}

function validateExecution(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['ok', 'status', 'blockers'], issues);
  booleanValue(row.ok, `${path}.ok`, issues);
  enumValue(row.status, new Set(['completed', 'partial', 'failed']), `${path}.status`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  if (row.ok === true && row.status === 'failed') issues.push(`${path}:execution_state_inconsistent`);
  if (row.ok === false && row.status !== 'failed') issues.push(`${path}:execution_state_inconsistent`);
}

function validateScope(
  value: unknown,
  expectedScope: string,
  report: Record<string, unknown> | null,
  path: string,
  issues: string[]
): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['schema', 'scope', 'state', 'checked_at', 'capabilities', 'blockers', 'warnings'], issues);
  literal(row.schema, 'sks.scope-capability-summary.v1', `${path}.schema`, issues);
  literal(row.scope, expectedScope, `${path}.scope`, issues);
  enumValue(row.state, PROBE_STATES, `${path}.state`, issues);
  iso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  const capabilities = object(row.capabilities, `${path}.capabilities`, issues);
  if (!capabilities) return;
  for (const [name, probe] of Object.entries(capabilities)) {
    validateProbe(probe, name, expectedScope, report, `${path}.capabilities.${escapePath(name)}`, issues);
  }
}

function validateProbe(
  value: unknown,
  capability: string,
  scope: string,
  report: Record<string, unknown> | null,
  path: string,
  issues: string[]
): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'capability', 'scope', 'requested_level', 'stage', 'state',
    'checked_at', 'report_id', 'correlation_id', 'session_id', 'attempt_id',
    'terminal', 'root_cause', 'blockers', 'warnings', 'retryable',
    'recovery_action', 'source', 'evidence'
  ], issues);
  literal(row.schema, 'sks.capability-probe.v3', `${path}.schema`, issues);
  literal(row.capability, capability, `${path}.capability`, issues);
  literal(row.scope, scope, `${path}.scope`, issues);
  enumValue(row.requested_level, LEVELS, `${path}.requested_level`, issues);
  if (report) literal(row.requested_level, report.requested_level, `${path}.requested_level`, issues);
  enumValue(row.stage, PROBE_STAGES, `${path}.stage`, issues);
  enumValue(row.state, PROBE_STATES, `${path}.state`, issues);
  iso(row.checked_at, `${path}.checked_at`, issues);
  nonEmptyString(row.report_id, `${path}.report_id`, issues);
  nonEmptyString(row.correlation_id, `${path}.correlation_id`, issues);
  nonEmptyString(row.session_id, `${path}.session_id`, issues);
  if (report) {
    literal(row.report_id, report.report_id, `${path}.report_id`, issues);
    literal(row.correlation_id, report.correlation_id, `${path}.correlation_id`, issues);
    literal(row.session_id, report.session_id, `${path}.session_id`, issues);
  }
  integer(row.attempt_id, `${path}.attempt_id`, issues, 0);
  booleanValue(row.terminal, `${path}.terminal`, issues);
  nullableString(row.root_cause, `${path}.root_cause`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  booleanValue(row.retryable, `${path}.retryable`, issues);
  nullableString(row.recovery_action, `${path}.recovery_action`, issues);
  enumValue(row.source, EVIDENCE_SOURCES, `${path}.source`, issues);
  object(row.evidence, `${path}.evidence`, issues);
  const blockers = Array.isArray(row.blockers) ? row.blockers : [];
  if (row.terminal === true && typeof row.root_cause !== 'string') issues.push(`${path}:terminal_root_cause_missing`);
  if (typeof row.root_cause === 'string' && !blockers.includes(row.root_cause)) issues.push(`${path}:root_cause_not_in_blockers`);
  if (row.state === 'verified' && (row.root_cause !== null || blockers.length > 0)) issues.push(`${path}:verified_with_failure`);
  if (row.state === 'not_attempted' && (row.root_cause !== null || blockers.length > 0 || row.terminal !== false)) {
    issues.push(`${path}:not_attempted_with_failure`);
  }
}

function validateCapabilitySummary(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'bridge_ready', 'active_routes_ready', 'level_satisfied',
    'transport_level_satisfied', 'deep_level_satisfied', 'full_feature_verified',
    'inactive_provider_failures', 'blockers', 'warnings'
  ], issues);
  for (const key of [
    'bridge_ready', 'active_routes_ready', 'level_satisfied',
    'transport_level_satisfied', 'deep_level_satisfied', 'full_feature_verified'
  ]) booleanValue(row[key], `${path}.${key}`, issues);
  stringArray(row.inactive_provider_failures, `${path}.inactive_provider_failures`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.full_feature_verified === true && row.deep_level_satisfied !== true) {
    issues.push(`${path}:full_feature_without_deep`);
  }
}

function validateCombinedCatalog(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'state', 'generation', 'digest', 'model_count', 'route_count',
    'conflict_count', 'checked_at', 'providers', 'blockers', 'warnings',
    'recovery_action'
  ], issues);
  literal(row.schema, 'sks.combined-catalog-sync.v1', `${path}.schema`, issues);
  enumValue(row.state, CATALOG_STATES, `${path}.state`, issues);
  nullableString(row.generation, `${path}.generation`, issues);
  nullableString(row.digest, `${path}.digest`, issues);
  nullableInteger(row.model_count, `${path}.model_count`, issues);
  nullableInteger(row.route_count, `${path}.route_count`, issues);
  integer(row.conflict_count, `${path}.conflict_count`, issues, 0);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  const providers = object(row.providers, `${path}.providers`, issues);
  if (providers) {
    exact(providers, `${path}.providers`, [...PROVIDERS], issues);
    validateCatalogState(providers['codex-lb'], 'codex-lb', `${path}.providers.codex-lb`, issues);
    validateCatalogState(providers.openrouter, 'openrouter', `${path}.providers.openrouter`, issues);
  }
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  nullableString(row.recovery_action, `${path}.recovery_action`, issues);
}

function validateCatalogState(value: unknown, provider: BridgeProviderId, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'provider_id', 'state', 'source', 'generation', 'digest',
    'model_count', 'checked_at', 'expires_at', 'blockers', 'warnings',
    'recovery_action'
  ], issues);
  literal(row.schema, 'sks.catalog-sync-state.v2', `${path}.schema`, issues);
  literal(row.provider_id, provider, `${path}.provider_id`, issues);
  enumValue(row.state, CATALOG_STATES, `${path}.state`, issues);
  if (row.source !== null) literal(row.source, provider === 'codex-lb' ? 'gateway' : 'openrouter', `${path}.source`, issues);
  nullableString(row.generation, `${path}.generation`, issues);
  nullableString(row.digest, `${path}.digest`, issues);
  nullableInteger(row.model_count, `${path}.model_count`, issues);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  nullableIso(row.expires_at, `${path}.expires_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  nullableString(row.recovery_action, `${path}.recovery_action`, issues);
}

function validateManagement(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['managed', 'runtime', 'state', 'reason'], issues);
  booleanValue(row.managed, `${path}.managed`, issues);
  if (row.managed === true) {
    literal(row.runtime, 'desktop-bridge', `${path}.runtime`, issues);
    literal(row.reason, null, `${path}.reason`, issues);
    enumValue(row.state, new Set(['not_installed', 'starting', 'ready', 'degraded', 'blocked', 'stopped', 'stale']), `${path}.state`, issues);
  } else if (row.managed === false) {
    literal(row.runtime, null, `${path}.runtime`, issues);
    enumValue(row.state, new Set(['not_installed', 'stopped']), `${path}.state`, issues);
    enumValue(row.reason, new Set(['uninstalled', 'rollback_complete', 'never_configured']), `${path}.reason`, issues);
  }
}

function validateService(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['state', 'installed', 'loaded', 'running', 'loopback_origin', 'pid', 'checked_at', 'blockers', 'warnings'], issues);
  enumValue(row.state, new Set(['not_installed', 'starting', 'ready', 'degraded', 'blocked', 'stopped', 'stale']), `${path}.state`, issues);
  booleanValue(row.installed, `${path}.installed`, issues);
  booleanValue(row.loaded, `${path}.loaded`, issues);
  booleanValue(row.running, `${path}.running`, issues);
  nullableString(row.loopback_origin, `${path}.loopback_origin`, issues);
  nullableInteger(row.pid, `${path}.pid`, issues);
  iso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

function validateHttpProbeResult(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['schema', 'state', 'terminal_stage', 'root_cause', 'status_code', 'latency_ms', 'blockers', 'warnings'], issues);
  literal(row.schema, 'sks.desktop-bridge-http-probe.v1', `${path}.schema`, issues);
  enumValue(row.state, new Set(['verified', 'blocked', 'failed', 'unsupported']), `${path}.state`, issues);
  enumValue(row.terminal_stage, new Set(['tcp_connect', 'http_health', 'complete']), `${path}.terminal_stage`, issues);
  nullableString(row.root_cause, `${path}.root_cause`, issues);
  nullableInteger(row.status_code, `${path}.status_code`, issues);
  nullableNumber(row.latency_ms, `${path}.latency_ms`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.state === 'verified' && (row.terminal_stage !== 'complete' || row.root_cause !== null)) {
    issues.push(`${path}:verified_http_incomplete`);
  }
}

function validateWebSocketProbeResult(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'state', 'terminal_stage', 'root_cause', 'status_code',
    'negotiated_protocol', 'upgrade_verified', 'protocol_verified',
    'frame_round_trip_verified', 'clean_close_verified', 'latency_ms',
    'blockers', 'warnings'
  ], issues);
  literal(row.schema, 'sks.desktop-bridge-websocket-probe.v2', `${path}.schema`, issues);
  enumValue(row.state, new Set(['not_attempted', 'verified', 'degraded', 'blocked', 'failed', 'unsupported']), `${path}.state`, issues);
  enumValue(row.terminal_stage, new Set(['tcp_connect', 'websocket_upgrade', 'websocket_protocol', 'frame_round_trip', 'clean_close', 'complete']), `${path}.terminal_stage`, issues);
  nullableString(row.root_cause, `${path}.root_cause`, issues);
  nullableInteger(row.status_code, `${path}.status_code`, issues);
  nullableString(row.negotiated_protocol, `${path}.negotiated_protocol`, issues);
  for (const key of ['upgrade_verified', 'protocol_verified', 'frame_round_trip_verified', 'clean_close_verified']) {
    booleanValue(row[key], `${path}.${key}`, issues);
  }
  nullableNumber(row.latency_ms, `${path}.latency_ms`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.state === 'verified' && (
    row.terminal_stage !== 'complete'
    || row.root_cause !== null
    || row.upgrade_verified !== true
    || row.protocol_verified !== true
    || row.frame_round_trip_verified !== true
    || row.clean_close_verified !== true
  )) issues.push(`${path}:verified_websocket_incomplete`);
  if (row.state === 'not_attempted' && (row.root_cause !== null || (Array.isArray(row.blockers) && row.blockers.length > 0))) {
    issues.push(`${path}:not_attempted_websocket_with_failure`);
  }
}

function validateNativeIdentity(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['state', 'configured', 'semantic_identity_preserved', 'checked_at', 'blockers', 'warnings'], issues);
  enumValue(row.state, PROBE_STATES, `${path}.state`, issues);
  booleanValue(row.configured, `${path}.configured`, issues);
  if (row.semantic_identity_preserved !== null) booleanValue(row.semantic_identity_preserved, `${path}.semantic_identity_preserved`, issues);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

function validateProviderProfile(value: unknown, provider: BridgeProviderId, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['schema', 'provider_id', 'enabled', 'credential', 'endpoint', 'catalog', 'capabilities'], issues);
  literal(row.schema, 'sks.bridge-provider-profile-status.v1', `${path}.schema`, issues);
  literal(row.provider_id, provider, `${path}.provider_id`, issues);
  booleanValue(row.enabled, `${path}.enabled`, issues);
  const credential = object(row.credential, `${path}.credential`, issues);
  if (credential) {
    exact(credential, `${path}.credential`, ['state', 'source', 'fingerprint', 'checked_at', 'blockers', 'warnings'], issues);
    enumValue(credential.state, new Set(['not_configured', 'configured_unverified', 'validating', 'ready', 'rejected', 'unavailable', 'stale']), `${path}.credential.state`, issues);
    nullableString(credential.source, `${path}.credential.source`, issues);
    nullableString(credential.fingerprint, `${path}.credential.fingerprint`, issues);
    nullableIso(credential.checked_at, `${path}.credential.checked_at`, issues);
    stringArray(credential.blockers, `${path}.credential.blockers`, issues);
    stringArray(credential.warnings, `${path}.credential.warnings`, issues);
  }
  const endpoint = object(row.endpoint, `${path}.endpoint`, issues);
  if (endpoint) {
    exact(endpoint, `${path}.endpoint`, ['configured', 'origin_redacted', 'auth_transport'], issues);
    booleanValue(endpoint.configured, `${path}.endpoint.configured`, issues);
    nullableString(endpoint.origin_redacted, `${path}.endpoint.origin_redacted`, issues);
    if (endpoint.auth_transport !== null) enumValue(endpoint.auth_transport, new Set(['authorization-bearer', 'x-codex-lb-api-key', 'openrouter-bearer']), `${path}.endpoint.auth_transport`, issues);
  }
  validateCatalogState(row.catalog, provider, `${path}.catalog`, issues);
  validateScope(row.capabilities, `provider:${provider}`, null, `${path}.capabilities`, issues);
}

function validateRouting(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['policy', 'selected_model', 'selected_route', 'session_pin', 'fallback', 'blockers', 'warnings'], issues);
  if (row.policy !== null) validatePolicy(row.policy, `${path}.policy`, issues);
  nullableString(row.selected_model, `${path}.selected_model`, issues);
  if (row.selected_route !== null) validateRouteTarget(row.selected_route, `${path}.selected_route`, issues);
  if (row.session_pin !== null) {
    const pin = object(row.session_pin, `${path}.session_pin`, issues);
    if (pin) {
      exact(pin, `${path}.session_pin`, ['thread_id', 'provider_id', 'public_model', 'upstream_model', 'catalog_generation', 'route_policy_generation', 'created_at'], issues);
      for (const key of ['thread_id', 'public_model', 'upstream_model', 'catalog_generation', 'route_policy_generation']) nonEmptyString(pin[key], `${path}.session_pin.${key}`, issues);
      enumValue(pin.provider_id, new Set(PROVIDERS), `${path}.session_pin.provider_id`, issues);
      iso(pin.created_at, `${path}.session_pin.created_at`, issues);
    }
  }
  literal(row.fallback, 'none', `${path}.fallback`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

function validatePolicy(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['schema', 'default_provider_id', 'fallback', 'model_routes', 'catalog_generation', 'policy_generation', 'changed_at'], issues);
  literal(row.schema, 'sks.bridge-routing-policy.v1', `${path}.schema`, issues);
  if (row.default_provider_id !== null) enumValue(row.default_provider_id, new Set(PROVIDERS), `${path}.default_provider_id`, issues);
  literal(row.fallback, 'none', `${path}.fallback`, issues);
  const routes = object(row.model_routes, `${path}.model_routes`, issues);
  if (routes) for (const [model, target] of Object.entries(routes)) validateRouteTarget(target, `${path}.model_routes.${escapePath(model)}`, issues);
  nonEmptyString(row.catalog_generation, `${path}.catalog_generation`, issues);
  nonEmptyString(row.policy_generation, `${path}.policy_generation`, issues);
  iso(row.changed_at, `${path}.changed_at`, issues);
}

function validateRouteTarget(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['provider_id', 'upstream_model'], issues);
  enumValue(row.provider_id, new Set(PROVIDERS), `${path}.provider_id`, issues);
  nonEmptyString(row.upstream_model, `${path}.upstream_model`, issues);
}

function validateReadiness(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['ready', 'state', 'bridge_ready', 'active_routes_ready', 'combined_catalog_ready', 'blockers', 'warnings'], issues);
  for (const key of ['ready', 'bridge_ready', 'active_routes_ready', 'combined_catalog_ready']) booleanValue(row[key], `${path}.${key}`, issues);
  enumValue(row.state, new Set(['ready', 'awaiting_provider', 'degraded', 'blocked', 'unmanaged']), `${path}.state`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.ready === true && row.state !== 'ready') issues.push(`${path}:ready_state_inconsistent`);
}

function object(value: unknown, path: string, issues: string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push(`${path}:object_required`);
    return null;
  }
  return value as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exact(row: Record<string, unknown>, path: string, expected: readonly string[], issues: string[]): void {
  const allowed = new Set(expected);
  for (const key of expected) if (!Object.hasOwn(row, key)) issues.push(`${path}.${escapePath(key)}:required`);
  for (const key of Object.keys(row)) if (!allowed.has(key)) issues.push(`${path}.${escapePath(key)}:unexpected`);
}

function literal(value: unknown, expected: unknown, path: string, issues: string[]): void {
  if (value !== expected) issues.push(`${path}:expected_${String(expected)}`);
}

function enumValue(value: unknown, allowed: ReadonlySet<string>, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !allowed.has(value)) issues.push(`${path}:enum`);
}

function nonEmptyString(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${path}:non_empty_string_required`);
}

function nullableString(value: unknown, path: string, issues: string[]): void {
  if (value !== null && typeof value !== 'string') issues.push(`${path}:nullable_string_required`);
}

function booleanValue(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'boolean') issues.push(`${path}:boolean_required`);
}

function integer(value: unknown, path: string, issues: string[], minimum?: number): void {
  if (!Number.isInteger(value) || (minimum !== undefined && Number(value) < minimum)) issues.push(`${path}:integer_required`);
}

function nullableInteger(value: unknown, path: string, issues: string[]): void {
  if (value !== null && (!Number.isInteger(value) || Number(value) < 0)) issues.push(`${path}:nullable_integer_required`);
}

function nullableNumber(value: unknown, path: string, issues: string[]): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) issues.push(`${path}:nullable_number_required`);
}

function iso(value: unknown, path: string, issues: string[]): void {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) issues.push(`${path}:iso_timestamp_required`);
}

function nullableIso(value: unknown, path: string, issues: string[]): void {
  if (value !== null) iso(value, path, issues);
}

function stringArray(value: unknown, path: string, issues: string[]): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) issues.push(`${path}:string_array_required`);
}

function scanForbiddenKeys(value: unknown, path: string, issues: string[]): void {
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

function escapePath(value: string): string {
  return /^[A-Za-z_$][\w$-]*$/.test(value) ? value : JSON.stringify(value);
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
