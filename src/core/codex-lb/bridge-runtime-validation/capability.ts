import {
  EVIDENCE_SOURCES,
  LEVELS,
  PROBE_STAGES,
  PROBE_STATES,
  booleanValue,
  enumValue,
  escapePath,
  exact,
  integer,
  iso,
  literal,
  nonEmptyString,
  nullableString,
  object,
  stringArray
} from './shared.js';

export function validateExecution(value: unknown, path: string, issues: string[]): void {
  const row = object(value, path, issues);
  if (!row) return;
  exact(row, path, ['ok', 'status', 'blockers'], issues);
  booleanValue(row.ok, `${path}.ok`, issues);
  enumValue(row.status, new Set(['completed', 'partial', 'failed']), `${path}.status`, issues);
  stringArray(row.blockers, `${path}.blockers`, issues);
  if (row.ok === true && row.status === 'failed') issues.push(`${path}:execution_state_inconsistent`);
  if (row.ok === false && row.status !== 'failed') issues.push(`${path}:execution_state_inconsistent`);
}

export function validateScope(
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
  if (row.terminal === true && typeof row.root_cause !== 'string') {
    issues.push(`${path}:terminal_root_cause_missing`);
  }
  if (typeof row.root_cause === 'string' && !blockers.includes(row.root_cause)) {
    issues.push(`${path}:root_cause_not_in_blockers`);
  }
  if (row.state === 'verified' && (row.root_cause !== null || blockers.length > 0)) {
    issues.push(`${path}:verified_with_failure`);
  }
  if (row.state === 'not_attempted' && (
    row.root_cause !== null
    || blockers.length > 0
    || row.terminal !== false
  )) issues.push(`${path}:not_attempted_with_failure`);
}

export function validateCapabilitySummary(value: unknown, path: string, issues: string[]): void {
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
