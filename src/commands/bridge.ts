import { readStdin } from '../core/fsx.js';
import { redactString, REDACTION_MARKER } from '../core/secret-redaction.js';
import type {
  BridgeProviderId,
  CapabilityRequestedLevel
} from '../core/codex-lb/bridge-contracts.js';

const COMMAND_SCHEMA = 'sks.bridge-command.v1' as const;
const ERROR_SCHEMA = 'sks.bridge-command-error.v1' as const;
const CONTROLLER_FACADE_EXPORT = 'executeDesktopBridgeCommand' as const;
const MAX_STDIN_SECRET_BYTES = 64 * 1024;

export type BridgeCommandRequest =
  | { operation: 'status' }
  | { operation: 'ensure' }
  | { operation: 'repair' }
  | { operation: 'verify'; level: CapabilityRequestedLevel }
  | { operation: 'provider.list' }
  | { operation: 'provider.configure'; provider_id: BridgeProviderId; api_key: string; host?: string }
  | { operation: 'provider.validate'; provider_id: BridgeProviderId }
  | { operation: 'provider.enable'; provider_id: BridgeProviderId }
  | { operation: 'provider.disable'; provider_id: BridgeProviderId }
  | { operation: 'provider.remove-credential'; provider_id: BridgeProviderId; confirmed: true }
  | { operation: 'catalog.sync' }
  | { operation: 'catalog.status' }
  | { operation: 'route.list' }
  | { operation: 'route.set-default'; provider_id: BridgeProviderId }
  | { operation: 'route.explain'; model: string }
  | { operation: 'unmanage'; confirmed: true }
  | { operation: 'rollback'; receipt_id: string; confirmed: true };

export interface BridgeCommandFacade {
  execute(request: BridgeCommandRequest): Promise<unknown>;
}

export interface BridgeCommandIo {
  readStdin(): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  setExitCode(code: number): void;
}

export interface BridgeCommandRunOptions {
  facade?: BridgeCommandFacade;
  io?: BridgeCommandIo;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface BridgeCommandExecution {
  output: Record<string, unknown>;
  json: boolean;
  exit_code: number;
}

interface ParsedInvocation {
  request: BridgeCommandRequest;
  json: boolean;
  strict: boolean;
  secrets: string[];
  label: string;
}

interface ParsedArgs {
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

class BridgeCliError extends Error {
  constructor(
    readonly code: string,
    readonly recoveryAction: string | null = 'review_bridge_command_help'
  ) {
    super(code);
  }
}

const DEFAULT_IO: BridgeCommandIo = {
  readStdin,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  setExitCode: (code) => {
    process.exitCode = code;
  }
};

export function usage(command = 'bridge'): string {
  return [
    `Usage: sks ${command} status [--json]`,
    `       sks ${command} ensure|repair [--json]`,
    `       sks ${command} verify --level shallow|transport|deep [--strict|--require-ready] [--json]`,
    `       sks ${command} provider list [--json]`,
    `       sks ${command} provider configure codex-lb --host <host> --api-key-stdin [--json]`,
    `       sks ${command} provider configure openrouter --api-key-stdin [--json]`,
    `       sks ${command} provider validate|enable|disable <codex-lb|openrouter> [--json]`,
    `       sks ${command} provider remove-credential <codex-lb|openrouter> --confirm [--json]`,
    `       sks ${command} catalog sync|status [--json]`,
    `       sks ${command} route list [--json]`,
    `       sks ${command} route set-default <codex-lb|openrouter> [--json]`,
    `       sks ${command} route explain <model> [--json]`,
    `       sks ${command} unmanage --confirm [--json]`,
    `       sks ${command} rollback <receipt-id> --confirm [--json]`,
    '',
    'Provider secrets are accepted only through --api-key-stdin. Readiness changes the exit code only with --strict or --require-ready.'
  ].join('\n');
}

export async function run(_command: unknown, args: string[] = []): Promise<Record<string, unknown>> {
  return runBridgeCommand(args);
}

export async function runBridgeCommand(
  args: string[] = [],
  options: BridgeCommandRunOptions = {}
): Promise<Record<string, unknown>> {
  const io = options.io || DEFAULT_IO;
  const execution = await executeBridgeCommand(args, options);
  if (execution.json) {
    io.stdout(`${JSON.stringify(execution.output, null, 2)}\n`);
  } else if (execution.exit_code === 0) {
    io.stdout(`${textSummary(execution.output)}\n`);
  } else {
    io.stderr(`${textSummary(execution.output)}\n`);
  }
  if (execution.exit_code !== 0) io.setExitCode(execution.exit_code);
  return execution.output;
}

export async function executeBridgeCommand(
  args: string[] = [],
  options: BridgeCommandRunOptions = {}
): Promise<BridgeCommandExecution> {
  const io = options.io || DEFAULT_IO;
  let parsed: ParsedInvocation;
  try {
    parsed = await parseInvocation(args, io);
  } catch (error) {
    const bridgeError = error instanceof BridgeCliError
      ? error
      : new BridgeCliError('bridge_command_parse_failed');
    const output = errorOutput(bridgeError.code, bridgeError.recoveryAction, error);
    return {
      output: mergeMetadata(output, options.metadata),
      json: args.includes('--json'),
      exit_code: 1
    };
  }

  try {
    const facade = options.facade || await loadBridgeCommandFacade();
    const raw = await facade.execute(parsed.request);
    const output = parsed.request.operation === 'verify'
      ? verificationOutput(raw, parsed.request.level, parsed.strict)
      : ordinaryOutput(raw, parsed.label);
    const sanitized = sanitizeBridgeValue(output, parsed.secrets) as Record<string, unknown>;
    const decorated = mergeMetadata(sanitized, options.metadata);
    return {
      output: decorated,
      json: parsed.json,
      exit_code: decorated.ok === false ? 1 : 0
    };
  } catch (error) {
    const output = sanitizeBridgeValue(errorOutput(
      error instanceof BridgeCliError ? error.code : 'bridge_command_internal_error',
      error instanceof BridgeCliError ? error.recoveryAction : 'retry_or_run_bridge_status',
      error
    ), parsed.secrets) as Record<string, unknown>;
    return {
      output: mergeMetadata(output, options.metadata),
      json: parsed.json,
      exit_code: 1
    };
  }
}

export async function loadBridgeCommandFacade(): Promise<BridgeCommandFacade> {
  const controller = await import('../core/codex-lb/desktop-controller.js') as Record<string, unknown>;
  const execute = controller[CONTROLLER_FACADE_EXPORT];
  if (typeof execute !== 'function') {
    throw new BridgeCliError(
      `bridge_controller_facade_unavailable:${CONTROLLER_FACADE_EXPORT}`,
      'update_sks_and_rebuild_bridge_controller'
    );
  }
  return {
    execute: (request) => Promise.resolve(
      (execute as (value: BridgeCommandRequest) => unknown)(request)
    )
  };
}

async function parseInvocation(args: string[], io: BridgeCommandIo): Promise<ParsedInvocation> {
  rejectSecretArgv(args);
  const parsed = parseArgs(args);
  const [area = 'status', action, target, extra] = parsed.positionals;
  const json = parsed.flags.has('--json');
  const strict = parsed.flags.has('--strict') || parsed.flags.has('--require-ready');
  const base = { json, strict, secrets: [] as string[] };

  if (area === 'status' && action === undefined) {
    allowOnly(parsed, ['--json'], []);
    return { ...base, request: { operation: 'status' }, label: 'Desktop Bridge status' };
  }
  if ((area === 'ensure' || area === 'repair') && action === undefined) {
    allowOnly(parsed, ['--json'], []);
    return { ...base, request: { operation: area }, label: `Desktop Bridge ${area}` };
  }
  if (area === 'verify' && action === undefined) {
    allowOnly(parsed, ['--json', '--strict', '--require-ready'], ['--level']);
    const level = capabilityLevel(parsed.values.get('--level') || 'shallow');
    return {
      ...base,
      request: { operation: 'verify', level },
      label: `Desktop Bridge ${level} verification`
    };
  }
  if (area === 'provider') {
    if (action === 'list' && target === undefined) {
      allowOnly(parsed, ['--json'], []);
      return { ...base, request: { operation: 'provider.list' }, label: 'Bridge provider list' };
    }
    if (action === 'configure' && target !== undefined && extra === undefined) {
      allowOnly(parsed, ['--json', '--api-key-stdin'], ['--host']);
      const providerId = provider(target);
      if (!parsed.flags.has('--api-key-stdin')) {
        throw new BridgeCliError('bridge_provider_api_key_stdin_required', 'retry_with_api_key_stdin');
      }
      const host = parsed.values.get('--host');
      if (providerId === 'codex-lb' && !host) {
        throw new BridgeCliError('codex_lb_host_required', 'retry_with_codex_lb_host');
      }
      const apiKey = (await io.readStdin()).trim();
      if (!apiKey) throw new BridgeCliError('bridge_provider_api_key_stdin_empty', 'retry_with_api_key_stdin');
      if (Buffer.byteLength(apiKey, 'utf8') > MAX_STDIN_SECRET_BYTES) {
        throw new BridgeCliError('bridge_provider_api_key_stdin_too_large', 'retry_with_valid_api_key');
      }
      return {
        ...base,
        secrets: [apiKey],
        request: {
          operation: 'provider.configure',
          provider_id: providerId,
          api_key: apiKey,
          ...(host ? { host } : {})
        },
        label: `${providerId} credential configuration`
      };
    }
    if (
      (action === 'validate' || action === 'enable' || action === 'disable')
      && target !== undefined
      && extra === undefined
    ) {
      allowOnly(parsed, ['--json'], []);
      const providerId = provider(target);
      return {
        ...base,
        request: { operation: `provider.${action}`, provider_id: providerId },
        label: `${providerId} ${action}`
      };
    }
    if (action === 'remove-credential' && target !== undefined && extra === undefined) {
      allowOnly(parsed, ['--json', '--confirm'], []);
      requireConfirmation(parsed);
      const providerId = provider(target);
      return {
        ...base,
        request: { operation: 'provider.remove-credential', provider_id: providerId, confirmed: true },
        label: `${providerId} credential removal`
      };
    }
  }
  if (area === 'catalog' && (action === 'sync' || action === 'status') && target === undefined) {
    allowOnly(parsed, ['--json'], []);
    return {
      ...base,
      request: { operation: `catalog.${action}` },
      label: `Combined catalog ${action}`
    };
  }
  if (area === 'route') {
    if (action === 'list' && target === undefined) {
      allowOnly(parsed, ['--json'], []);
      return { ...base, request: { operation: 'route.list' }, label: 'Bridge route list' };
    }
    if (action === 'set-default' && target !== undefined && extra === undefined) {
      allowOnly(parsed, ['--json'], []);
      const providerId = provider(target);
      return {
        ...base,
        request: { operation: 'route.set-default', provider_id: providerId },
        label: `Default bridge provider set to ${providerId}`
      };
    }
    if (action === 'explain' && target !== undefined && extra === undefined) {
      allowOnly(parsed, ['--json'], []);
      return {
        ...base,
        request: { operation: 'route.explain', model: target },
        label: `Bridge route explanation for ${target}`
      };
    }
  }
  if (area === 'unmanage' && action === undefined) {
    allowOnly(parsed, ['--json', '--confirm'], []);
    requireConfirmation(parsed);
    return {
      ...base,
      request: { operation: 'unmanage', confirmed: true },
      label: 'Desktop Bridge unmanage'
    };
  }
  if (area === 'rollback' && action !== undefined && target === undefined) {
    allowOnly(parsed, ['--json', '--confirm'], []);
    requireConfirmation(parsed);
    return {
      ...base,
      request: { operation: 'rollback', receipt_id: action, confirmed: true },
      label: `Desktop Bridge rollback ${action}`
    };
  }
  throw new BridgeCliError('bridge_command_invalid', 'review_bridge_command_help');
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const booleanOptions = new Set([
    '--json', '--strict', '--require-ready', '--api-key-stdin', '--confirm'
  ]);
  const valueOptions = new Set(['--level', '--host']);
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    if (value.includes('=')) throw new BridgeCliError('bridge_command_option_equals_syntax_unsupported');
    if (booleanOptions.has(value)) {
      if (flags.has(value)) throw new BridgeCliError('bridge_command_duplicate_option');
      flags.add(value);
      continue;
    }
    if (valueOptions.has(value)) {
      if (values.has(value)) throw new BridgeCliError('bridge_command_duplicate_option');
      const next = args[index + 1];
      if (!next || String(next).startsWith('--')) throw new BridgeCliError('bridge_command_option_value_missing');
      values.set(value, String(next));
      index += 1;
      continue;
    }
    throw new BridgeCliError('bridge_command_unknown_option');
  }
  return { positionals, flags, values };
}

function rejectSecretArgv(args: string[]): void {
  for (const arg of args) {
    const option = String(arg).split('=', 1)[0]?.toLowerCase() || '';
    if (option === '--api-key-stdin') continue;
    if (/^--(?:api[-_]?key|secret|token|authorization|bearer|password)(?:$|-)/.test(option)) {
      throw new BridgeCliError('bridge_secret_argv_forbidden', 'retry_with_api_key_stdin');
    }
  }
}

function allowOnly(parsed: ParsedArgs, allowedFlags: string[], allowedValues: string[]): void {
  const flags = new Set(allowedFlags);
  const values = new Set(allowedValues);
  if ([...parsed.flags].some((entry) => !flags.has(entry))) {
    throw new BridgeCliError('bridge_command_option_not_allowed');
  }
  if ([...parsed.values.keys()].some((entry) => !values.has(entry))) {
    throw new BridgeCliError('bridge_command_option_not_allowed');
  }
}

function requireConfirmation(parsed: ParsedArgs): void {
  if (!parsed.flags.has('--confirm')) {
    throw new BridgeCliError('bridge_explicit_confirmation_required', 'retry_with_confirm');
  }
}

function capabilityLevel(value: string): CapabilityRequestedLevel {
  if (value === 'shallow' || value === 'transport' || value === 'deep') return value;
  throw new BridgeCliError('capability_level_must_be_shallow_transport_or_deep');
}

function provider(value: string): BridgeProviderId {
  if (value === 'codex-lb' || value === 'openrouter') return value;
  throw new BridgeCliError('bridge_provider_must_be_codex_lb_or_openrouter');
}

function verificationOutput(
  value: unknown,
  level: CapabilityRequestedLevel,
  strict: boolean
): Record<string, unknown> {
  const report = record(value);
  const reportGenerated = report.schema === 'sks.desktop-capabilities.v3'
    && record(report.catalog_sync).schema === 'sks.combined-catalog-sync.v1';
  if (!reportGenerated) {
    return errorOutput('capability_schema_invalid', 'update_sks_and_rebuild_menubar');
  }
  const executionOk = record(report.execution).ok === true;
  const summary = record(report.summary);
  const levelSatisfied = level === 'transport'
    ? summary.transport_level_satisfied === true
    : level === 'deep'
      ? summary.deep_level_satisfied === true
      : summary.bridge_ready === true
        && summary.active_routes_ready === true
        && record(report.combined_catalog).state === 'verified';
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

function ordinaryOutput(value: unknown, label: string): Record<string, unknown> {
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

function errorOutput(
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

function sanitizeBridgeValue(value: unknown, secrets: readonly string[]): unknown {
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

function mergeMetadata(
  output: Record<string, unknown>,
  metadata: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  return metadata ? { ...output, ...metadata } : output;
}

function textSummary(output: Record<string, unknown>): string {
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
