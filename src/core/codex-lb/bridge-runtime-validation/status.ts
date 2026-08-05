import type { BridgeProviderId } from '../bridge-contracts.js';
import { validateScope } from './capability.js';
import { validateCatalogState } from './catalog.js';
import {
  PROBE_STATES,
  PROVIDERS,
  booleanValue,
  enumValue,
  escapePath,
  exact,
  iso,
  literal,
  nonEmptyString,
  nullableInteger,
  nullableIso,
  nullableNumber,
  nullableString,
  object,
  stringArray
} from './shared.js';

export function validateManagement(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['managed', 'runtime', 'state', 'reason'], issues);
  booleanValue(row.managed, `${path}.managed`, issues);
  if (row.managed === true) {
    literal(row.runtime, 'desktop-bridge', `${path}.runtime`, issues);
    literal(row.reason, null, `${path}.reason`, issues);
    enumValue(row.state, new Set([
      'not_installed', 'starting', 'ready', 'degraded', 'blocked', 'stopped', 'stale'
    ]), `${path}.state`, issues);
  } else if (row.managed === false) {
    literal(row.runtime, null, `${path}.runtime`, issues);
    enumValue(row.state, new Set(['not_installed', 'stopped']), `${path}.state`, issues);
    enumValue(row.reason, new Set([
      'uninstalled', 'rollback_complete', 'never_configured'
    ]), `${path}.reason`, issues);
  }
}

export function validateService(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'state', 'installed', 'loaded', 'running', 'loopback_origin', 'pid',
    'checked_at', 'blockers', 'warnings'
  ], issues);
  enumValue(row.state, new Set([
    'not_installed', 'starting', 'ready', 'degraded', 'blocked', 'stopped', 'stale'
  ]), `${path}.state`, issues);
  booleanValue(row.installed, `${path}.installed`, issues);
  booleanValue(row.loaded, `${path}.loaded`, issues);
  booleanValue(row.running, `${path}.running`, issues);
  nullableString(row.loopback_origin, `${path}.loopback_origin`, issues);
  nullableInteger(row.pid, `${path}.pid`, issues);
  iso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

export function validateHttpProbeResult(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'state', 'terminal_stage', 'root_cause', 'status_code',
    'latency_ms', 'blockers', 'warnings'
  ], issues);
  literal(row.schema, 'sks.desktop-bridge-http-probe.v1', `${path}.schema`, issues);
  enumValue(row.state, new Set(['verified', 'blocked', 'failed', 'unsupported']), `${path}.state`, issues);
  enumValue(row.terminal_stage, new Set([
    'tcp_connect', 'http_health', 'complete'
  ]), `${path}.terminal_stage`, issues);
  nullableString(row.root_cause, `${path}.root_cause`, issues);
  nullableInteger(row.status_code, `${path}.status_code`, issues);
  nullableNumber(row.latency_ms, `${path}.latency_ms`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.state === 'verified' && (row.terminal_stage !== 'complete' || row.root_cause !== null)) {
    issues.push(`${path}:verified_http_incomplete`);
  }
}

export function validateWebSocketProbeResult(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'state', 'terminal_stage', 'root_cause', 'status_code',
    'negotiated_protocol', 'upgrade_verified', 'protocol_verified',
    'frame_round_trip_verified', 'clean_close_verified', 'latency_ms',
    'blockers', 'warnings'
  ], issues);
  literal(row.schema, 'sks.desktop-bridge-websocket-probe.v2', `${path}.schema`, issues);
  enumValue(row.state, new Set([
    'not_attempted', 'verified', 'degraded', 'blocked', 'failed', 'unsupported'
  ]), `${path}.state`, issues);
  enumValue(row.terminal_stage, new Set([
    'tcp_connect', 'websocket_upgrade', 'websocket_protocol', 'frame_round_trip',
    'clean_close', 'complete'
  ]), `${path}.terminal_stage`, issues);
  nullableString(row.root_cause, `${path}.root_cause`, issues);
  nullableInteger(row.status_code, `${path}.status_code`, issues);
  nullableString(row.negotiated_protocol, `${path}.negotiated_protocol`, issues);
  for (const key of [
    'upgrade_verified', 'protocol_verified', 'frame_round_trip_verified', 'clean_close_verified'
  ]) booleanValue(row[key], `${path}.${key}`, issues);
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
  if (row.state === 'not_attempted' && (
    row.root_cause !== null
    || (Array.isArray(row.blockers) && row.blockers.length > 0)
  )) issues.push(`${path}:not_attempted_websocket_with_failure`);
}

export function validateNativeIdentity(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'state', 'configured', 'semantic_identity_preserved', 'checked_at', 'blockers', 'warnings'
  ], issues);
  enumValue(row.state, PROBE_STATES, `${path}.state`, issues);
  booleanValue(row.configured, `${path}.configured`, issues);
  if (row.semantic_identity_preserved !== null) {
    booleanValue(row.semantic_identity_preserved, `${path}.semantic_identity_preserved`, issues);
  }
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

export function validateProviderProfile(
  value: unknown,
  provider: BridgeProviderId,
  path: string,
  issues: string[]
): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'provider_id', 'enabled', 'credential', 'endpoint', 'catalog', 'capabilities'
  ], issues);
  literal(row.schema, 'sks.bridge-provider-profile-status.v1', `${path}.schema`, issues);
  literal(row.provider_id, provider, `${path}.provider_id`, issues);
  booleanValue(row.enabled, `${path}.enabled`, issues);
  validateCredential(row.credential, `${path}.credential`, issues);
  validateEndpoint(row.endpoint, `${path}.endpoint`, issues);
  validateCatalogState(row.catalog, provider, `${path}.catalog`, issues);
  validateScope(row.capabilities, `provider:${provider}`, null, `${path}.capabilities`, issues);
}

function validateCredential(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['state', 'source', 'fingerprint', 'checked_at', 'blockers', 'warnings'], issues);
  enumValue(row.state, new Set([
    'not_configured', 'configured_unverified', 'validating', 'ready', 'rejected',
    'unavailable', 'stale'
  ]), `${path}.state`, issues);
  nullableString(row.source, `${path}.source`, issues);
  nullableString(row.fingerprint, `${path}.fingerprint`, issues);
  nullableIso(row.checked_at, `${path}.checked_at`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

function validateEndpoint(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['configured', 'origin_redacted', 'auth_transport'], issues);
  booleanValue(row.configured, `${path}.configured`, issues);
  nullableString(row.origin_redacted, `${path}.origin_redacted`, issues);
  if (row.auth_transport !== null) {
    enumValue(row.auth_transport, new Set([
      'authorization-bearer', 'x-codex-lb-api-key', 'openrouter-bearer'
    ]), `${path}.auth_transport`, issues);
  }
}

export function validateRouting(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'policy', 'selected_model', 'selected_route', 'session_pin', 'fallback',
    'blockers', 'warnings'
  ], issues);
  if (row.policy !== null) validatePolicy(row.policy, `${path}.policy`, issues);
  nullableString(row.selected_model, `${path}.selected_model`, issues);
  if (row.selected_route !== null) {
    validateRouteTarget(row.selected_route, `${path}.selected_route`, issues);
  }
  if (row.session_pin !== null) validateSessionPin(row.session_pin, `${path}.session_pin`, issues);
  literal(row.fallback, 'none', `${path}.fallback`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
}

function validateSessionPin(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'thread_id', 'provider_id', 'public_model', 'upstream_model',
    'catalog_generation', 'route_policy_generation', 'created_at'
  ], issues);
  for (const key of [
    'thread_id', 'public_model', 'upstream_model', 'catalog_generation', 'route_policy_generation'
  ]) nonEmptyString(row[key], `${path}.${key}`, issues);
  enumValue(row.provider_id, new Set(PROVIDERS), `${path}.provider_id`, issues);
  iso(row.created_at, `${path}.created_at`, issues);
}

function validatePolicy(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'schema', 'default_provider_id', 'fallback', 'model_routes',
    'catalog_generation', 'policy_generation', 'changed_at'
  ], issues);
  literal(row.schema, 'sks.bridge-routing-policy.v1', `${path}.schema`, issues);
  if (row.default_provider_id !== null) {
    enumValue(row.default_provider_id, new Set(PROVIDERS), `${path}.default_provider_id`, issues);
  }
  literal(row.fallback, 'none', `${path}.fallback`, issues);
  const routes = object(row.model_routes, `${path}.model_routes`, issues);
  if (routes) {
    for (const [model, target] of Object.entries(routes)) {
      validateRouteTarget(target, `${path}.model_routes.${escapePath(model)}`, issues);
    }
  }
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

export function validateReadiness(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, [
    'ready', 'state', 'bridge_ready', 'active_routes_ready',
    'combined_catalog_ready', 'blockers', 'warnings'
  ], issues);
  for (const key of [
    'ready', 'bridge_ready', 'active_routes_ready', 'combined_catalog_ready'
  ]) booleanValue(row[key], `${path}.${key}`, issues);
  enumValue(row.state, new Set([
    'ready', 'awaiting_provider', 'degraded', 'blocked', 'unmanaged'
  ]), `${path}.state`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  stringArray(row.warnings, `${path}.warnings`, issues);
  if (row.ready === true && row.state !== 'ready') issues.push(`${path}:ready_state_inconsistent`);
}
