import path from 'node:path';
import { readStdin } from '../core/fsx.js';
import type {
  BridgeProviderId,
  CapabilityRequestedLevel
} from '../core/codex-lb/bridge-contracts.js';
import { serveDesktopBridge } from '../core/codex-lb/desktop-service.js';
import {
  BridgeCliError,
  errorOutput,
  mergeMetadata,
  ordinaryOutput,
  sanitizeBridgeValue,
  textSummary,
  verificationOutput
} from './bridge-command-output.js';

const CONTROLLER_FACADE_EXPORT = 'executeDesktopBridgeCommand' as const;
const MAX_STDIN_SECRET_BYTES = 64 * 1024;

export type BridgeCommandRequest =
  | { operation: 'status' }
  | { operation: 'serve'; settings_path: string }
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
  serve?: typeof serveDesktopBridge;
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
    const raw = parsed.request.operation === 'serve'
      ? await (options.serve || serveDesktopBridge)({ settingsPath: parsed.request.settings_path })
      : await (options.facade || await loadBridgeCommandFacade()).execute(parsed.request);
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
  if (area === 'serve' && action === undefined) {
    allowOnly(parsed, ['--json'], ['--settings']);
    const settingsPath = parsed.values.get('--settings') || '';
    if (!path.isAbsolute(settingsPath)) {
      throw new BridgeCliError('desktop_bridge_settings_path_must_be_absolute');
    }
    if (path.basename(settingsPath) !== 'codex-lb-desktop-bridge-settings.json') {
      throw new BridgeCliError('desktop_bridge_settings_path_invalid');
    }
    return {
      ...base,
      request: { operation: 'serve', settings_path: settingsPath },
      label: 'Desktop Bridge service'
    };
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
  const valueOptions = new Set(['--level', '--host', '--settings']);
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
