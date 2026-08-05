import { redactString, REDACTION_MARKER } from '../core/secret-redaction.js';
import type { CapabilityRequestedLevel } from '../core/codex-lb/bridge-contracts.js';
import { validateDesktopCapabilityReportV3 } from '../core/codex-lb/bridge-runtime-validation.js';

const COMMAND_SCHEMA = 'sks.bridge-command.v1' as const;
const ERROR_SCHEMA = 'sks.bridge-command-error.v1' as const;

export class BridgeCliError extends Error {
  constructor(
    readonly code: string,
    readonly recoveryAction: string | null = 'review_bridge_command_help'
  ) {
    super(code);
  }
}

export function verificationOutput(
  value: unknown,
  level: CapabilityRequestedLevel,
  strict: boolean
): Record<string, unknown> {
  const report = record(value);
  const reportGenerated = validateDesktopCapabilityReportV3(value).ok;
  if (!reportGenerated) {
    return errorOutput('capability_schema_invalid', 'update_sks_and_rebuild_menubar');
  }
  const executionOk = record(report.execution).ok === true;
  const summary = record(report.summary);
  const levelSatisfied = summary.level_satisfied === true;
  const fullFeatureVerified = summary.full_feature_verified === true;
  return {
    ...report,
    ok: executionOk && (!strict || levelSatisfied),
    execution_ok: executionOk,
    report_generated: true,
    requested_level: level,
    level_satisfied: levelSatisfied,
    full_feature_verified: fullFeatureVerified,
    strict
  };
}

export function ordinaryOutput(value: unknown, label: string): Record<string, unknown> {
  const result = record(value);
  if (Object.keys(result).length === 0 || typeof result.schema !== 'string') {
    return errorOutput('bridge_controller_response_invalid', 'update_sks_and_rebuild_bridge_controller');
  }
  const executionOk = result.execution_ok === false
    ? false
    : result.ok === false
      ? false
      : record(result.execution).ok === false
        ? false
        : true;
  return {
    ...result,
    schema: typeof result.schema === 'string' ? result.schema : COMMAND_SCHEMA,
    ok: executionOk,
    execution_ok: executionOk,
    command_summary: label
  };
}

export function errorOutput(
  blocker: string,
  recoveryAction: string | null,
  error?: unknown
): Record<string, unknown> {
  return {
    schema: ERROR_SCHEMA,
    ok: false,
    execution_ok: false,
    status: 'failed',
    blockers: [blocker],
    recovery_action: recoveryAction,
    ...(error instanceof BridgeCliError
      ? {}
      : error instanceof Error
        ? { error: redactString(error.message) }
        : {})
  };
}

export function sanitizeBridgeValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let text = redactString(value);
    for (const secret of secrets) text = text.split(secret).join(REDACTION_MARKER);
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizeBridgeValue(entry, secrets));
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = isSecretValueKey(key)
      ? REDACTION_MARKER
      : sanitizeBridgeValue(entry, secrets);
  }
  return output;
}

function isSecretValueKey(key: string): boolean {
  return /^(?:api_key|secret|token|password|authorization|bearer|cookie|set_cookie)$/i.test(key)
    || /(?:^|_)(?:api_key|secret|token|password|authorization)$/i.test(key)
    || /^(?:headers?|env)$/i.test(key);
}

export function mergeMetadata(
  output: Record<string, unknown>,
  metadata: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  return metadata ? { ...output, ...metadata } : output;
}

export function textSummary(output: Record<string, unknown>): string {
  const status = output.ok === false ? 'failed' : 'completed';
  const summary = typeof output.command_summary === 'string'
    ? output.command_summary
    : 'Desktop Bridge command';
  const blockers = Array.isArray(output.blockers)
    ? output.blockers.map(String).filter(Boolean).join(', ')
    : '';
  return blockers ? `${summary}: ${status} (${blockers})` : `${summary}: ${status}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
