import { commandContract, outputCapFor, timeoutFor } from '../safety/command-contract/contracts.js';
import { validateJsonSchema } from '../safety/command-contract/json-schema.js';
import type { CommandContractV3 } from '../safety/command-contract/types.js';
import { probeTelegram, telegramSelfHealAction } from '../telegram/doctor.js';
import { readTelegramLivenessReceipt, telegramLivenessPath } from '../telegram/liveness.js';
import {
  TELEGRAM_TOKEN_ENV_NAMES,
  bindTelegramBotIdentity,
  issueTelegramPairingCode,
  preflightTelegramTokenStorage,
  storeTelegramToken,
  type TelegramBotBindingResult
} from '../telegram/keychain.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { TelegramApiError, TelegramClient } from '../telegram/client.js';
import { redactTelegramError } from '../telegram/redaction.js';
import type { TelegramUser } from '../telegram/types.js';
import { projectRoot } from '../fsx.js';
import { projectRootRealpath } from '../session/project-namespace.js';

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
  executeArgv(argv: readonly string[], contract: CommandContractV3, cwd?: string): Promise<unknown>;
}

export interface TelegramCliDependencies {
  receiptPath?: string;
  readTokenStdin?: () => Promise<string>;
  storeToken?: typeof storeTelegramToken;
  issuePairingCode?: typeof issueTelegramPairingCode;
  readCommandStdin?: () => Promise<TelegramCommandRequest>;
  executionAdapter?: TelegramCommandExecutionAdapter;
  verifyToken?: (token: string) => Promise<TelegramUser | void>;
  inspectWebhook?: (token: string) => Promise<{ url: string }>;
  removeWebhook?: (token: string) => Promise<void>;
  preflightTokenStorage?: (token: string) => Promise<void>;
  bindBotIdentity?: (botId: number) => Promise<TelegramBotBindingResult>;
  resolveProjectRoot?: (root: string) => Promise<string>;
  environment?: NodeJS.ProcessEnv;
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
    '  pair                 Issue a short-lived code for the intended private Telegram chat.',
    '  setup --token-stdin [--remove-webhook]',
    '                       Verify and store the token for any @BotFather bot you own; an existing webhook requires explicit removal consent.',
    '  prepare --stdin-json  Validate an authorized native request through the typed contract.',
    '  execute --stdin-json  Execute a prepared request; destructive requests also need --confirmed.',
    '',
    'After pairing, send /sks status {}. Confirm prompted actions with /confirm <nonce>.',
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
        instruction: `Send /start ${issued.code} to the configured bot from the intended private chat. Then send /sks status {}.`,
        post_pair_command: '/sks status {}',
        confirmation_grammar: '/confirm <nonce>'
      }, json);
    }
    if (action === 'setup') {
      if (!args.includes('--token-stdin')) return telegramSetupFailure('telegram_token_stdin_required', json);
      if (args.includes('--drop-pending-updates')) return telegramSetupFailure('telegram_drop_pending_updates_unsupported', json);
      const environment = dependencies.environment ?? process.env;
      const envOverrideActive = args.includes('--operator-env-override-active')
        || TELEGRAM_TOKEN_ENV_NAMES.some((name) => String(environment[name] ?? '').trim().length > 0);
      if (envOverrideActive) return telegramSetupEnvOverrideBlocked(json);
      const token = await (dependencies.readTokenStdin ?? readBoundedTokenStdin)();
      let identity: TelegramUser | void;
      try {
        identity = await (dependencies.verifyToken ?? verifyTelegramToken)(token);
      } catch (error) {
        return telegramSetupFailure(telegramIdentityFailure(error), json, 'getme');
      }
      const removeWebhook = args.includes('--remove-webhook');
      let webhook: { url: string };
      try {
        webhook = await (dependencies.inspectWebhook ?? inspectTelegramWebhook)(token);
      } catch (error) {
        throw new Error(`telegram_webhook_inspection_failed:${redactTelegramError(error, token)}`);
      }
      const webhookConfigured = webhook.url.trim().length > 0;
      if (webhookConfigured && !removeWebhook) {
        throw new Error('telegram_webhook_configured_remove_consent_required');
      }
      await (dependencies.preflightTokenStorage ?? preflightTelegramTokenStorage)(token);
      let webhookRemoved = false;
      if (webhookConfigured) {
        try {
          await (dependencies.removeWebhook ?? removeTelegramWebhook)(token);
          webhookRemoved = true;
        } catch (error) {
          throw new Error(`telegram_webhook_remove_failed:${redactTelegramError(error, token)}`);
        }
      }
      let binding: TelegramBotBindingResult | null = null;
      if (identity) {
        try {
          binding = await (dependencies.bindBotIdentity ?? bindTelegramBotIdentity)(identity.id);
        } catch (error) {
          if (webhookRemoved) {
            return telegramSetupPartialFailure({
              error: 'telegram_bot_state_bind_failed_after_webhook_removed',
              detail: redactTelegramError(error, token),
              webhookRemoved,
              botId: identity.id
            }, json);
          }
          throw error;
        }
      }
      try {
        await (dependencies.storeToken ?? storeTelegramToken)(token);
      } catch (error) {
        if (webhookRemoved || binding) {
          return telegramSetupPartialFailure({
            error: webhookRemoved
              ? 'telegram_token_store_failed_after_webhook_removed'
              : 'telegram_token_store_failed_after_bot_state_binding',
            detail: redactTelegramError(error, token),
            webhookRemoved,
            botId: identity?.id ?? null,
            binding
          }, json);
        }
        throw error;
      }
      return emit({
        schema: 'sks.telegram-setup-command.v1', ok: true,
        getme_verified: true, token_stored: true, storage: 'user_secret_file',
        token_source: 'user_secret_file',
        webhook_configured_before: webhookConfigured,
        webhook_removed: webhookRemoved, pending_updates_dropped: false,
        bot_id: identity?.id ?? null,
        bot_username: publicBotUsername(identity?.username),
        bot_rotated: binding?.rotated ?? false,
        bot_state_reset: binding?.state_reset ?? false,
        restart_required: true
      }, json);
    }
    if (action === 'prepare' || action === 'execute') {
      if (!args.includes('--stdin-json')) return fail('telegram_command_stdin_json_required', json);
      const commandRoot = await resolveTelegramCommandRoot(args, dependencies.resolveProjectRoot);
      const request = await (dependencies.readCommandStdin ?? readBoundedCommandStdin)();
      const executionAdapter = dependencies.executionAdapter ?? { executeArgv: executeTypedArgv };
      const dispatcher = createTelegramCommandDispatcher({
        executeArgv: (argv, contract) => executionAdapter.executeArgv(argv, contract, commandRoot)
      });
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
    const message = error instanceof Error ? error.message : String(error);
    return action === 'setup'
      ? telegramSetupFailure(redactTelegramError(error), json)
      : fail(message, json);
  }
}

async function verifyTelegramToken(token: string): Promise<TelegramUser> {
  const client = new TelegramClient({ tokenProvider: { loadToken: async () => token } });
  const identity = await client.getMe();
  if (!identity.is_bot) throw new Error('telegram_getme_not_bot');
  if (!Number.isSafeInteger(identity.id) || identity.id <= 0) throw new Error('telegram_getme_bot_id_invalid');
  return identity;
}

async function inspectTelegramWebhook(token: string): Promise<{ url: string }> {
  const client = new TelegramClient({ tokenProvider: { loadToken: async () => token } });
  return client.getWebhookInfo();
}

async function removeTelegramWebhook(token: string): Promise<void> {
  const client = new TelegramClient({ tokenProvider: { loadToken: async () => token } });
  await client.deleteWebhook();
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

async function executeTypedArgv(
  argv: readonly string[],
  contract: CommandContractV3,
  cwd = process.cwd()
): Promise<unknown> {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error('telegram_cli_entrypoint_unavailable');
  const timeoutMs = timeoutFor(contract.latency);
  const outputLimit = outputCapFor(contract.latency);
  const childEnv = { ...process.env };
  for (const name of TELEGRAM_TOKEN_ENV_NAMES) delete childEnv[name];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...argv], {
      cwd, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], shell: false
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

async function resolveTelegramCommandRoot(
  args: readonly string[],
  resolveRoot: ((root: string) => Promise<string>) | undefined
): Promise<string> {
  const indexes = args.flatMap((value, index) => value === '--project-root' ? [index] : []);
  if (indexes.length === 0) return process.cwd();
  if (indexes.length !== 1) throw new Error('telegram_project_root_repeated');
  const value = args[indexes[0]! + 1];
  if (!value || value.startsWith('-')) throw new Error('telegram_project_root_required');
  if (!path.isAbsolute(value)) throw new Error('telegram_project_root_absolute_required');
  try {
    const canonical = resolveRoot ? await resolveRoot(value) : await projectRootRealpath(value);
    if (!path.isAbsolute(canonical) || path.normalize(canonical) !== canonical) {
      throw new Error('invalid_canonical_project_root');
    }
    if (resolveRoot) return canonical;
    if (canonical === path.parse(canonical).root || !(await fs.stat(canonical)).isDirectory()) {
      throw new Error('invalid_project_root_directory');
    }
    const detected = await projectRoot(canonical);
    const detectedCanonical = await projectRootRealpath(detected);
    if (detectedCanonical !== canonical) throw new Error('not_exact_project_root');
    return canonical;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('telegram_project_root_')) throw error;
    throw new Error('telegram_project_root_invalid');
  }
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

function telegramSetupFailure(error: string, json: boolean, failureStage?: 'getme'): unknown {
  process.exitCode = 1;
  return emit({
    schema: 'sks.telegram-setup-command.v1',
    ok: false,
    error,
    token_stored: false,
    ...(failureStage ? { failure_stage: failureStage } : {})
  }, json);
}

function telegramIdentityFailure(error: unknown): string {
  const message = redactTelegramError(error);
  const code = error instanceof TelegramApiError ? error.code : null;
  if (code === 401 || code === 404 || /\b(?:401|404|Unauthorized|Not Found)\b/i.test(message)) {
    return 'telegram_token_rejected';
  }
  if (/telegram_(?:request_)?timeout|timed?\s*out/i.test(message)) {
    return 'telegram_identity_verification_timeout';
  }
  if (/fetch failed|network|ENOTFOUND|ECONN|EAI_AGAIN|offline/i.test(message)) {
    return 'telegram_identity_verification_network_failed';
  }
  if (message === 'telegram_token_invalid') return message;
  return 'telegram_identity_verification_failed';
}

function publicBotUsername(value: string | undefined): string | null {
  const normalized = String(value ?? '').trim();
  return /^[A-Za-z0-9_]{5,64}$/.test(normalized) ? normalized : null;
}

function telegramSetupPartialFailure(input: {
  error: string;
  detail: string;
  webhookRemoved: boolean;
  botId: number | null;
  binding?: TelegramBotBindingResult | null;
}, json: boolean): unknown {
  process.exitCode = 1;
  return emit({
    schema: 'sks.telegram-setup-command.v1',
    ok: false,
    partial_success: true,
    error: input.error,
    detail: input.detail,
    getme_verified: true,
    token_stored: false,
    token_source: 'unchanged',
    webhook_removed: input.webhookRemoved,
    pending_updates_dropped: false,
    bot_id: input.botId,
    bot_rotated: input.binding?.rotated ?? false,
    bot_state_reset: input.binding?.state_reset ?? false,
    restart_required: false,
    recovery: {
      action: 'rerun_secure_setup',
      command: 'sks telegram setup --token-stdin',
      note: 'The token was not printed or stored. Supply it again through non-TTY standard input.'
    }
  }, json);
}

function telegramSetupEnvOverrideBlocked(json: boolean): unknown {
  process.exitCode = 1;
  return emit({
    schema: 'sks.telegram-setup-command.v1',
    ok: false,
    partial_success: false,
    error: 'telegram_operator_env_override_active',
    token_source: 'env',
    token_stored: false,
    storage_attempted: false,
    webhook_removed: false,
    pending_updates_dropped: false,
    operator_action: 'Remove the operator-managed Telegram token environment override before storing a file token, or keep managing the bot through that environment source.'
  }, json);
}

function emit(value: unknown, _json: boolean): unknown {
  console.log(JSON.stringify(value, null, 2));
  return value;
}
