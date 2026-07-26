import path from 'node:path';
import { isHelpRequest } from '../../cli/help.js';
import { globalSksRoot, projectRoot, readJson, readStdin } from '../fsx.js';
import {
  RemoteCodexSessionBindingStore,
  loadRemoteMachineRegistry,
  loadRemoteSessionIndex,
  remoteCodexSessionBindingsPath,
  remoteMachineRegistryPath,
  remoteSessionIndexPath,
  validateRemoteMachineRegistry,
  validateRemoteSessionIndex
} from '../remote/index.js';
import {
  loadTelegramConfig,
  probeTelegramBotReadiness,
  resolveTelegramBotToken,
  TelegramActionBroker,
  TelegramAuditLedger,
  TelegramBotApiClient,
  TelegramBotApiError,
  TelegramHubRouter,
  TelegramHubRuntime,
  TelegramIdempotencyLedger,
  TelegramOwnerLock,
  TelegramMessageProjector,
  TelegramPollingHub,
  TelegramTopicRegistry,
  installAndStartTelegramHubService,
  restartTelegramHubService,
  setupTelegramLocalCoding,
  stopTelegramHubService,
  telegramHubPaths,
  telegramHubServiceStatus,
  telegramTokenFingerprint,
  validateTelegramConfig,
  validateTelegramPrivatePairing,
  type TelegramBotReadiness,
  type TelegramHubConfigV1,
  type TelegramOwnerV1
} from '../telegram/index.js';

export interface TelegramPairingReadiness {
  readonly pairing_valid: boolean;
  readonly pairing_issues: Array<'paired_chat_ids' | 'paired_user_ids'>;
  readonly blocker: string | null;
}

export interface TelegramLiveProbeStatus {
  readonly bot_verified: boolean;
  readonly bot: TelegramBotReadiness['bot'] | null;
  readonly webhook_configured: boolean;
  readonly pending_update_count: number;
  readonly long_poll_ready: boolean;
  readonly telegram_probe_error: 'telegram_bot_auth_failed' | 'telegram_bot_probe_failed' | null;
  readonly blocker: 'telegram_bot_auth_failed' | 'telegram_bot_probe_failed' | 'telegram_webhook_conflict' | null;
}

export const TELEGRAM_STATUS_NATIVE_DEADLINE_MS = 8_000;
export const TELEGRAM_STATUS_TOKEN_LOOKUP_TIMEOUT_MS = 1_000;
export const TELEGRAM_STATUS_BOT_REQUEST_TIMEOUT_MS = 1_500;
export const TELEGRAM_STATUS_BOT_MAX_RETRIES = 0;
export const TELEGRAM_STATUS_LIVE_PROBE_BUDGET_MS = TELEGRAM_STATUS_TOKEN_LOOKUP_TIMEOUT_MS
  + TELEGRAM_STATUS_BOT_REQUEST_TIMEOUT_MS * 2;

export async function telegramCommand(args: string[] = []): Promise<unknown> {
  if (isHelpRequest(args)) {
    printTelegramUsage();
    return { schema: 'sks.telegram-command.v1', ok: true, action: 'help' };
  }
  const action = args[0] ?? 'status';
  const root = globalSksRoot();
  const paths = telegramHubPaths(root);
  const configPath = readOption(args, '--config') ?? paths.config;
  const json = args.includes('--json');

  try {
    if (action === 'status') {
      return print(await telegramStatus(args, root, paths, configPath), json);
    }

    if (action === 'setup') {
      if (!args.includes('--bot-token-stdin')) return fail('bot_token_stdin_required', ['setup --bot-token-stdin --project-root <path>'], json);
      const token = (await readStdin()).trim();
      const controllingRoot = path.resolve(readOption(args, '--project-root') ?? await projectRoot());
      const result = await setupTelegramLocalCoding({
        token,
        projectRoot: controllingRoot,
        pairedChatId: readOption(args, '--paired-chat-id'),
        pairedUserId: readOption(args, '--paired-user-id'),
        resetSession: args.includes('--new-session'),
        globalRoot: root
      });
      return print(result, json);
    }

    if (action === 'validate-config') {
      const validation = validateTelegramConfig(await readJson<unknown>(configPath, null));
      return print({ schema: 'sks.telegram-config-validation.v1', ...validation, config: validation.config ? redactConfig(validation.config) : null }, json);
    }

    if (action === 'hub') {
      const hubAction = args[1] && !String(args[1]).startsWith('-') ? String(args[1]) : 'run';
      const controllingRoot = path.resolve(readOption(args, '--project-root') ?? await projectRoot());
      if (hubAction === 'start') {
        await assertHubSetupReady(controllingRoot, root, configPath);
        return print(await installAndStartTelegramHubService({ projectRoot: controllingRoot, globalRoot: root }), json);
      }
      if (hubAction === 'stop') {
        return print(await stopTelegramHubService({ projectRoot: controllingRoot, globalRoot: root }), json);
      }
      if (hubAction === 'restart') {
        await assertHubSetupReady(controllingRoot, root, configPath);
        return print(await restartTelegramHubService({ projectRoot: controllingRoot, globalRoot: root }), json);
      }
      if (hubAction === 'status') {
        return print(await telegramHubServiceStatus({ projectRoot: controllingRoot, globalRoot: root }), json);
      }
      if (hubAction !== 'run') return fail('unknown_hub_action', ['hub run', 'hub start', 'hub stop', 'hub restart', 'hub status'], json);
      return runHub(args, root, paths, configPath, json);
    }
  } catch (err: unknown) {
    process.exitCode = 1;
    return print({
      schema: 'sks.telegram-command-error.v1',
      ok: false,
      error: publicError(err)
    }, json);
  }

  return fail('unknown_action', [
    'status',
    'setup --bot-token-stdin --project-root <path>',
    'validate-config',
    'hub run|start|stop|restart|status'
  ], json);
}

async function telegramStatus(
  args: readonly string[],
  root: string,
  paths: ReturnType<typeof telegramHubPaths>,
  configPath: string
): Promise<Record<string, unknown>> {
    const rawConfig = await readJson<unknown>(configPath, null);
    const validation = validateTelegramConfig(rawConfig);
    const owner = await readJson<TelegramOwnerV1 | null>(paths.owner, null);
    const topics = await new TelegramTopicRegistry(paths.topics).list();
    const controllingRoot = path.resolve(readOption(args, '--project-root') ?? await projectRoot());
    const servicePromise = telegramHubServiceStatus({ projectRoot: controllingRoot, globalRoot: root });
    const machineRegistryRaw = await readJson<unknown>(readOption(args, '--machines') ?? remoteMachineRegistryPath(root), null);
    const machineValidation = validateRemoteMachineRegistry(machineRegistryRaw);
    const sessionIndexRaw = await readJson<unknown>(readOption(args, '--session-index') ?? remoteSessionIndexPath(controllingRoot), null);
    const sessionValidation = machineValidation.registry
      ? validateRemoteSessionIndex(sessionIndexRaw, machineValidation.registry)
      : { ok: false, issues: ['remote_machine_registry_invalid'], index: null };
    const bindings = await new RemoteCodexSessionBindingStore(remoteCodexSessionBindingsPath(controllingRoot)).list().catch(() => []);
    const targets = sessionValidation.index?.targets ?? [];
    const registered = bindings.filter((binding) => targets.some((target) => (
      binding.machine_id === target.machine_id
      && binding.project_id === target.project_id
      && path.resolve(binding.project_root) === path.resolve(target.project_root)
    )));
    let tokenConfigured = false;
    let liveProbe = telegramLiveProbeStatus(null);
    const probeConfig = validation.config ?? telegramConfigForStatusProbe(rawConfig);
    if (probeConfig) {
      const token = await resolveTelegramBotToken(probeConfig.bot_token_ref, {
        timeoutMs: TELEGRAM_STATUS_TOKEN_LOOKUP_TIMEOUT_MS
      }).catch(() => null);
      tokenConfigured = token !== null;
      if (token) {
        try {
          liveProbe = telegramLiveProbeStatus(await probeTelegramBotReadiness(new TelegramBotApiClient(token, {
            timeoutMs: TELEGRAM_STATUS_BOT_REQUEST_TIMEOUT_MS,
            maxRetries: TELEGRAM_STATUS_BOT_MAX_RETRIES
          })));
        } catch (error: unknown) {
          liveProbe = telegramLiveProbeStatus(null, error);
        }
      }
    }
    const service = await servicePromise;
    const pairing = telegramPairingReadiness(rawConfig);
    const blockers = [
      ...validation.issues.map((issue) => `config:${issue}`),
      ...machineValidation.issues.map((issue) => `machine:${issue}`),
      ...sessionValidation.issues.map((issue) => `target:${issue}`),
      ...(tokenConfigured ? [] : ['telegram_token_not_available']),
      ...(liveProbe.blocker ? [liveProbe.blocker] : []),
      ...(pairing.blocker ? [pairing.blocker] : []),
      ...(registered.length ? [] : ['no_registered_codex_session']),
      ...(service.running ? [] : ['telegram_hub_not_running'])
    ];
    return {
      schema: 'sks.telegram-status.v1',
      ok: blockers.length === 0,
      configured: rawConfig !== null,
      token_configured: tokenConfigured,
      bot_verified: liveProbe.bot_verified,
      bot: liveProbe.bot,
      webhook_configured: liveProbe.webhook_configured,
      pending_update_count: liveProbe.pending_update_count,
      long_poll_ready: liveProbe.long_poll_ready,
      telegram_probe_error: liveProbe.telegram_probe_error,
      pairing_valid: pairing.pairing_valid,
      pairing_issues: pairing.pairing_issues,
      hub_running: service.running,
      service,
      config_issues: validation.issues,
      owner: owner ? {
        pid: owner.pid,
        host: owner.host,
        process_start_time: owner.process_start_time,
        bot_token_fingerprint: owner.bot_token_fingerprint,
        heartbeat_at: owner.heartbeat_at
      } : null,
      topic_count: topics.length,
      machine_count: machineValidation.registry?.machines.length ?? 0,
      target_count: sessionValidation.index?.targets.length ?? 0,
      registered_session_count: registered.length,
      registered_sessions: registered.map((binding) => ({
        session_id: binding.session_id,
        machine_id: binding.machine_id,
        project_id: binding.project_id,
        codex_thread_id: binding.codex_thread_id,
        last_turn_status: binding.last_turn_status ?? null,
        updated_at: binding.updated_at
      })),
      remote_config_issues: [...machineValidation.issues, ...sessionValidation.issues],
      blockers,
      next_actions: telegramNextActions(blockers)
    };
}

function printTelegramUsage(): void {
  console.log(`SKS Telegram Hub — private, local, single-operator remote coding

Usage:
  sks telegram status [--project-root <path>] [--json]
  sks telegram setup --bot-token-stdin --project-root <path> [--paired-chat-id <id>]
                     [--paired-user-id <id>] [--new-session] [--json]
  sks telegram validate-config [--config <path>] [--json]
  sks telegram hub start|stop|restart|status [--project-root <path>] [--json]
  sks telegram hub run [--project-root <path>] [--json]

Pairing (do these first):
  1. Open @BotFather, send /newbot, choose a name and a unique username ending in "bot",
     then copy the HTTP API token BotFather returns.
  2. Send /start to that bot from the Telegram account you want to pair.
  3. printf '%s' "<token>" | sks telegram setup --bot-token-stdin --project-root "$PWD" --json
     The token is read from stdin only and stored in the macOS Keychain.
  4. sks telegram hub start --project-root "$PWD" --json

If status reports telegram_webhook_conflict, remove the webhook in the service
that configured it, then retry. SKS does not delete external webhook state implicitly.
If setup or the hub reports telegram_409_conflict, stop the other poller using
this bot token before retrying.
Stop the SKS Telegram hub before rerunning setup or rotating its BotFather token.

The same flow is available in SKS Center → Remote & Telegram.
See docs/telegram-and-center.md for the full guide and troubleshooting.
`);
}

export function telegramPairingReadiness(value: unknown): TelegramPairingReadiness {
  const pairing = validateTelegramPrivatePairing(value);
  const multipleIds = hasMultipleTelegramPairingIds(value);
  return {
    pairing_valid: pairing.ok,
    pairing_issues: pairing.issues,
    blocker: pairing.ok
      ? null
      : multipleIds
        ? 'telegram_pairing_multiple_ids_requires_setup'
      : pairing.missing
        ? 'telegram_pairing_missing'
        : `telegram_pairing_invalid:${pairing.issues.join(',')}`
  };
}

export function telegramLiveProbeStatus(
  readiness: TelegramBotReadiness | null,
  error: unknown = null
): TelegramLiveProbeStatus {
  const probeError = error === null ? null : telegramProbeFailure(error);
  const webhookConfigured = readiness?.webhook_configured === true;
  return {
    bot_verified: readiness !== null,
    bot: readiness?.bot ?? null,
    webhook_configured: webhookConfigured,
    pending_update_count: readiness?.pending_update_count ?? 0,
    long_poll_ready: readiness !== null && !webhookConfigured,
    telegram_probe_error: probeError,
    blocker: probeError ?? (webhookConfigured ? 'telegram_webhook_conflict' : null)
  };
}

async function runHub(
  args: readonly string[],
  root: string,
  paths: ReturnType<typeof telegramHubPaths>,
  configPath: string,
  json: boolean
): Promise<unknown> {
    const config = await loadTelegramConfig(configPath);
    const controllingRoot = path.resolve(readOption(args, '--project-root') ?? await projectRoot());
    const machineRegistry = await loadRemoteMachineRegistry(readOption(args, '--machines') ?? remoteMachineRegistryPath(root));
    const sessionIndex = await loadRemoteSessionIndex(readOption(args, '--session-index') ?? remoteSessionIndexPath(controllingRoot), machineRegistry);
    const token = await resolveTelegramBotToken(config.bot_token_ref);
    const fingerprint = telegramTokenFingerprint(token);
    const owner = new TelegramOwnerLock({
      lockPath: paths.owner,
      tokenFingerprint: fingerprint,
      ...(config.owner_stale_ms === undefined ? {} : { staleMs: config.owner_stale_ms })
    });
    await owner.acquire();
    const topics = new TelegramTopicRegistry(paths.topics);
    const actions = new TelegramActionBroker(paths.actions);
    const audit = new TelegramAuditLedger(paths.audit, fingerprint);
    const router = new TelegramHubRouter({
      config,
      topics,
      idempotency: new TelegramIdempotencyLedger(paths.idempotency),
      actions,
      audit
    });
    const api = new TelegramBotApiClient(token, { timeoutMs: (config.long_poll_timeout_sec ?? 25) * 1000 + 5_000 });
    const runtime = new TelegramHubRuntime({
      config,
      router,
      topics,
      actions,
      audit,
      projector: new TelegramMessageProjector(api, {
        rich_message: true,
        rich_draft: true,
        plain_draft: true,
        reactions: true
      }, {
        protectContent: config.protect_content !== false,
        silent: config.silent_notifications === true
      }),
      machineRegistry,
      sessionIndex,
      projectionStatePath: paths.projection
    });
    const polling = new TelegramPollingHub(
      api,
      runtime,
      owner,
      config.long_poll_timeout_sec ?? 25
    );
    try {
      await polling.ensureLongPollingAllowed();
      const sync = await runtime.initialize();
      if (args.includes('--once')) {
        const result = await polling.pollOnce();
        return print({ schema: 'sks.telegram-hub-run.v1', ...result, sync }, json);
      }
      const controller = new AbortController();
      const stop = () => controller.abort();
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      try {
        const result = await polling.run(controller.signal);
        return print({ schema: 'sks.telegram-hub-run.v1', ...result, sync }, json);
      } finally {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
      }
    } finally {
      await runtime.close();
      await owner.release();
    }
}

async function assertHubSetupReady(controllingRoot: string, globalRoot: string, configPath: string): Promise<void> {
  const config = await loadTelegramConfig(configPath);
  const token = await resolveTelegramBotToken(config.bot_token_ref);
  let readiness: TelegramBotReadiness;
  try {
    readiness = await probeTelegramBotReadiness(new TelegramBotApiClient(token, {
      timeoutMs: 8_000,
      maxRetries: 1
    }));
  } catch (error: unknown) {
    throw new Error(telegramProbeFailure(error));
  }
  if (readiness.webhook_configured) throw new Error('telegram_webhook_conflict');
  const registry = await loadRemoteMachineRegistry(remoteMachineRegistryPath(globalRoot));
  const index = await loadRemoteSessionIndex(remoteSessionIndexPath(controllingRoot), registry);
  const bindings = await new RemoteCodexSessionBindingStore(remoteCodexSessionBindingsPath(controllingRoot)).list();
  if (!bindings.some((binding) => index.targets.some((target) => (
    target.machine_id === binding.machine_id
    && target.project_id === binding.project_id
    && path.resolve(target.project_root) === path.resolve(binding.project_root)
  )))) {
    throw new Error('no_registered_codex_session');
  }
}

function readOption(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? String(args[index + 1]) : null;
}

function redactConfig(config: object): Record<string, unknown> {
  const record = config as Record<string, unknown>;
  return {
    ...record,
    bot_token_ref: record.bot_token_ref && typeof record.bot_token_ref === 'object'
      ? { type: (record.bot_token_ref as { type?: string }).type }
      : null
  };
}

function print(value: unknown, json: boolean): unknown {
  if (json) console.log(JSON.stringify(value, null, 2));
  else console.log(JSON.stringify(value, null, 2));
  return value;
}

function fail(error: string, supported: readonly string[], json: boolean): unknown {
  process.exitCode = 2;
  return print({ schema: 'sks.telegram-command.v1', ok: false, error, supported }, json);
}

function publicError(err: unknown): string {
  const value = err instanceof Error ? err.message : String(err);
  return value
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[redacted]')
    .replace(/(?:\/Users|\/home)\/[^\s]+/g, '[path-redacted]')
    .slice(0, 500);
}

function telegramProbeFailure(error: unknown): 'telegram_bot_auth_failed' | 'telegram_bot_probe_failed' {
  return error instanceof TelegramBotApiError && (error.errorCode === 401 || error.errorCode === 404)
    ? 'telegram_bot_auth_failed'
    : 'telegram_bot_probe_failed';
}

function telegramNextActions(blockers: readonly string[]): string[] {
  const actions: string[] = [];
  if (blockers.includes('telegram_token_not_available') || blockers.includes('telegram_bot_auth_failed')) {
    actions.push('Create or regenerate the bot token in @BotFather, then rerun setup with --bot-token-stdin.');
  }
  if (blockers.includes('telegram_webhook_conflict')) {
    actions.push('Remove the existing webhook in the service that configured it, then rerun telegram status.');
  }
  if (blockers.includes('telegram_bot_probe_failed')) {
    actions.push('Check network access to api.telegram.org, then rerun telegram status.');
  }
  if (blockers.includes('telegram_pairing_missing') || blockers.some((blocker) => blocker.startsWith('telegram_pairing_invalid:'))) {
    actions.push('Send /start to the bot in a private chat, then rerun telegram setup.');
  }
  if (blockers.includes('telegram_pairing_multiple_ids_requires_setup')) {
    actions.push('Stop the hub, then rerun telegram setup to replace the ambiguous multi-ID config with one verified private chat and user.');
  }
  if (blockers.includes('no_registered_codex_session')) {
    actions.push('Rerun telegram setup for this project root.');
  }
  if (blockers.includes('telegram_hub_not_running')) {
    actions.push('Run sks telegram hub start --project-root \"$PWD\" --json after other blockers are cleared.');
  }
  return actions;
}

function hasMultipleTelegramPairingIds(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (Array.isArray(record.paired_chat_ids) && record.paired_chat_ids.length > 1)
    || (Array.isArray(record.paired_user_ids) && record.paired_user_ids.length > 1);
}

function telegramConfigForStatusProbe(value: unknown): TelegramHubConfigV1 | null {
  if (!value || typeof value !== 'object') return null;
  const validation = validateTelegramConfig({
    ...(value as Record<string, unknown>),
    paired_chat_ids: ['1'],
    paired_user_ids: ['1']
  });
  return validation.config;
}
