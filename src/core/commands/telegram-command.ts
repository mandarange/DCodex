import { commandContract, outputCapFor, timeoutFor } from '../safety/command-contract/contracts.js';
import { validateJsonSchema } from '../safety/command-contract/json-schema.js';
import type { CommandContractV3 } from '../safety/command-contract/types.js';
import { probeTelegram, telegramSelfHealAction } from '../telegram/doctor.js';
import { readTelegramLivenessReceipt, telegramLivenessPath } from '../telegram/liveness.js';
import { TELEGRAM_TOKEN_ENV_NAMES, issueTelegramPairingCode, storeTelegramToken } from '../telegram/keychain.js';
import { spawn } from 'node:child_process';
import { TelegramClient } from '../telegram/client.js';

export const TELEGRAM_COMMAND_WHITELIST = new Set([
  'gates', 'paths', 'pipeline', 'proof', 'search', 'stats', 'status',
  'stop-gate', 'trust', 'update-check', 'validate-artifacts'
]);

// These operations can alter route/gate state or trigger project checks. They
// are intentionally a stricter subset of the remote-capable registry.
export const TELEGRAM_CONFIRMATION_REQUIRED = new Set([
  'gates', 'stop-gate', 'validate-artifacts'
]);

export interface TelegramCommandRequest {
  name: string;
  input: Record<string, unknown>;
}

export type TelegramCommandPreparation =
  | { ok: true; confirmation_required: false; execute(): Promise<unknown> }
  | { ok: true; confirmation_required: true }
  | { ok: false; error: string };

export interface TelegramCommandDispatcher {
  prepare(request: TelegramCommandRequest): TelegramCommandPreparation;
  executeConfirmed(request: TelegramCommandRequest): Promise<unknown>;
}

export interface TelegramCommandExecutionAdapter {
  executeArgv(argv: readonly string[], contract: CommandContractV3): Promise<unknown>;
}

export interface TelegramCliDependencies {
  receiptPath?: string;
  readTokenStdin?: () => Promise<string>;
  storeToken?: typeof storeTelegramToken;
  issuePairingCode?: typeof issueTelegramPairingCode;
  readCommandStdin?: () => Promise<TelegramCommandRequest>;
  executionAdapter?: TelegramCommandExecutionAdapter;
  verifyToken?: (token: string) => Promise<void>;
}

export function createTelegramCommandDispatcher(
  adapter: TelegramCommandExecutionAdapter,
  lookup: (name: string) => CommandContractV3 | null = commandContract
): TelegramCommandDispatcher {
  const resolve = (request: TelegramCommandRequest): { contract: CommandContractV3; argv: string[] } | { error: string } => {
    if (!TELEGRAM_COMMAND_WHITELIST.has(request.name)) return { error: 'telegram_command_not_whitelisted' };
    const contract = lookup(request.name);
    if (!contract || !contract.remote_allowed || contract.risk === 'R3') return { error: 'telegram_command_not_remote_allowed' };
    const validation = validateJsonSchema(request.input, contract.input_schema);
    if (!validation.ok) return { error: `telegram_command_input_invalid:${validation.issues[0]?.code ?? 'schema'}` };
    return { contract, argv: contract.argv_builder(validation.value) };
  };

  return {
    prepare(request): TelegramCommandPreparation {
      const resolved = resolve(request);
      if ('error' in resolved) return { ok: false, error: resolved.error };
      if (requiresConfirmation(resolved.contract)) return { ok: true, confirmation_required: true };
      return {
        ok: true,
        confirmation_required: false,
        execute: () => adapter.executeArgv(resolved.argv, resolved.contract)
      };
    },
    async executeConfirmed(request) {
      const resolved = resolve(request);
      if ('error' in resolved) throw new Error(resolved.error);
      if (!requiresConfirmation(resolved.contract)) throw new Error('telegram_confirmation_not_required');
      return adapter.executeArgv(resolved.argv, resolved.contract);
    }
  };
}

function requiresConfirmation(contract: CommandContractV3): boolean {
  return TELEGRAM_CONFIRMATION_REQUIRED.has(contract.name) || !contract.read_only || contract.risk !== 'R0';
}

export function usage(): string {
  return [
    'Usage: sks telegram status|doctor|pair|setup [--json]',
    '',
    '  status               Read the secret-free resident poller liveness receipt.',
    '  doctor               Evaluate getMe, pairing, poller, and liveness evidence.',
    '  pair                 Issue a short-lived code in the private Telegram state file.',
    '  setup --token-stdin   Read a bot token only from stdin and store it in the user secret file.',
    '  prepare --stdin-json  Validate an authorized native request through the typed contract.',
    '  execute --stdin-json  Execute a prepared request; destructive requests also need --confirmed.',
    '',
    'The bot token is never accepted in argv, printed, or written to a config file.'
  ].join('\n');
}

/** Stable CLI boundary imported by the shared command registry. */
export async function telegramCommand(
  args: string[] = [],
  dependencies: TelegramCliDependencies = {}
): Promise<unknown> {
  if (args.some((value) => ['help', '--help', '-h'].includes(value.toLowerCase()))) {
    console.log(usage());
    return { schema: 'sks.telegram-command.v1', ok: true, action: 'help' };
  }
  const action = args[0] && !args[0]!.startsWith('-') ? args[0]!.toLowerCase() : 'status';
  const json = args.includes('--json');
  const receiptPath = dependencies.receiptPath ?? telegramLivenessPath();
  try {
    if (action === 'status') {
      const state = await readTelegramLivenessReceipt(receiptPath);
      const result = state.ok
        ? { schema: 'sks.telegram-status.v1', ok: !state.stale && state.receipt.running, stale: state.stale, age_ms: state.age_ms, receipt: state.receipt }
        : { schema: 'sks.telegram-status.v1', ok: false, blocker: state.blocker };
      if (!result.ok) process.exitCode = 1;
      return emit(result, json);
    }
    if (action === 'doctor') {
      const probe = await probeTelegram({ receiptPath });
      const result = { ...probe, self_heal_action: telegramSelfHealAction(probe) };
      if (!result.ok) process.exitCode = 1;
      return emit(result, json);
    }
    if (action === 'pair') {
      const issued = await (dependencies.issuePairingCode ?? issueTelegramPairingCode)();
      return emit({
        schema: 'sks.telegram-pair-command.v1', ok: true,
        code: issued.code, expires_at: issued.expires_at,
        instruction: `Send /start ${issued.code} to the configured bot from the intended private chat.`
      }, json);
    }
    if (action === 'setup') {
      if (!args.includes('--token-stdin')) return fail('telegram_token_stdin_required', json);
      const token = await (dependencies.readTokenStdin ?? readBoundedTokenStdin)();
      await (dependencies.verifyToken ?? verifyTelegramToken)(token);
      await (dependencies.storeToken ?? storeTelegramToken)(token);
      return emit({
        schema: 'sks.telegram-setup-command.v1', ok: true,
        getme_verified: true, token_stored: true, storage: 'user_secret_file', restart_required: true
      }, json);
    }
    if (action === 'prepare' || action === 'execute') {
      if (!args.includes('--stdin-json')) return fail('telegram_command_stdin_json_required', json);
      const request = await (dependencies.readCommandStdin ?? readBoundedCommandStdin)();
      const dispatcher = createTelegramCommandDispatcher(dependencies.executionAdapter ?? { executeArgv: executeTypedArgv });
      const prepared = dispatcher.prepare(request);
      if (action === 'prepare') {
        return emit(prepared.ok
          ? { schema: 'sks.telegram-command-preparation.v1', ok: true, allowed: true, confirmation_required: prepared.confirmation_required, public_error: null }
          : { schema: 'sks.telegram-command-preparation.v1', ok: false, allowed: false, confirmation_required: false, public_error: prepared.error }, json);
      }
      if (!prepared.ok) return fail(prepared.error, json);
      if (prepared.confirmation_required && !args.includes('--confirmed')) return fail('telegram_confirmation_required', json);
      const output = prepared.confirmation_required
        ? await dispatcher.executeConfirmed(request)
        : await prepared.execute();
      return emit({ schema: 'sks.telegram-command-execution.v1', ok: true, output }, json);
    }
    return fail('telegram_unknown_action', json, ['status', 'doctor', 'pair', 'setup', 'prepare', 'execute']);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error), json);
  }
}

async function verifyTelegramToken(token: string): Promise<void> {
  const client = new TelegramClient({ tokenProvider: { loadToken: async () => token } });
  const identity = await client.getMe();
  if (!identity.is_bot) throw new Error('telegram_getme_not_bot');
}

async function readBoundedCommandStdin(): Promise<TelegramCommandRequest> {
  if (process.stdin.isTTY) throw new Error('telegram_command_stdin_json_required');
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value, 'utf8') > 32 * 1024) throw new Error('telegram_command_stdin_json_too_large');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('telegram_command_stdin_json_invalid'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('telegram_command_stdin_json_invalid');
  const row = parsed as Record<string, unknown>;
  if (typeof row.name !== 'string' || !row.input || typeof row.input !== 'object' || Array.isArray(row.input)) {
    throw new Error('telegram_command_stdin_json_invalid');
  }
  return { name: row.name, input: row.input as Record<string, unknown> };
}

async function executeTypedArgv(argv: readonly string[], contract: CommandContractV3): Promise<unknown> {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('telegram_cli_entrypoint_unavailable');
  const timeoutMs = timeoutFor(contract.latency);
  const outputLimit = outputCapFor(contract.latency);
  const childEnv = { ...process.env };
  for (const name of TELEGRAM_TOKEN_ENV_NAMES) delete childEnv[name];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], {
      cwd: process.cwd(), env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false
    });
    let output = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => finish(new Error('telegram_command_timeout')), timeoutMs);
    const append = (chunk: Buffer) => {
      if (settled) return;
      output = Buffer.concat([output, chunk]);
      if (output.length > outputLimit) finish(new Error('telegram_command_output_limit'));
    };
    const finish = (error?: Error, code?: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill('SIGKILL');
      if (error) return reject(error);
      const text = output.toString('utf8').trim();
      if (code !== 0) return reject(new Error(`telegram_command_failed:exit_${code ?? 'signal'}`));
      try { resolve(JSON.parse(text)); }
      catch { resolve(text); }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', (error) => finish(new Error(`telegram_command_spawn_failed:${error.message}`)));
    child.once('close', (code) => finish(undefined, code));
  });
}

async function readBoundedTokenStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('telegram_token_stdin_required');
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) {
    value += String(chunk);
    if (Buffer.byteLength(value, 'utf8') > 1024) throw new Error('telegram_token_stdin_too_large');
  }
  const token = value.trim();
  if (!token) throw new Error('telegram_token_stdin_empty');
  return token;
}

function fail(error: string, json: boolean, supported?: string[]): unknown {
  process.exitCode = 1;
  return emit({
    schema: 'sks.telegram-command.v1', ok: false, error,
    ...(supported ? { supported } : {})
  }, json);
}

function emit(value: unknown, _json: boolean): unknown {
  console.log(JSON.stringify(value, null, 2));
  return value;
}
