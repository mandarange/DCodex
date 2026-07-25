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
  resolveTelegramBotToken,
  TelegramActionBroker,
  TelegramAuditLedger,
  TelegramBotApiClient,
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
  type TelegramOwnerV1
} from '../telegram/index.js';

export interface TelegramPairingReadiness {
  readonly pairing_valid: boolean;
  readonly pairing_issues: Array<'paired_chat_ids' | 'paired_user_ids'>;
  readonly blocker: string | null;
}

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
    const service = await telegramHubServiceStatus({ projectRoot: controllingRoot, globalRoot: root });
    let tokenConfigured = false;
    if (validation.config) {
      tokenConfigured = await resolveTelegramBotToken(validation.config.bot_token_ref).then(() => true).catch(() => false);
    }
    const pairing = telegramPairingReadiness(rawConfig);
    const blockers = [
      ...validation.issues.map((issue) => `config:${issue}`),
      ...machineValidation.issues.map((issue) => `machine:${issue}`),
      ...sessionValidation.issues.map((issue) => `target:${issue}`),
      ...(tokenConfigured ? [] : ['telegram_token_not_available']),
      ...(pairing.blocker ? [pairing.blocker] : []),
      ...(registered.length ? [] : ['no_registered_codex_session']),
      ...(service.running ? [] : ['telegram_hub_not_running'])
    ];
    return {
      schema: 'sks.telegram-status.v1',
      ok: blockers.length === 0,
      configured: rawConfig !== null,
      token_configured: tokenConfigured,
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
      blockers
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
  1. Create a private bot with @BotFather in Telegram and copy its token.
  2. Send /start to that bot from the Telegram account you want to pair.
  3. printf '%s' "<token>" | sks telegram setup --bot-token-stdin --project-root "$PWD" --json
     The token is read from stdin only and stored in the macOS Keychain.
  4. sks telegram hub start --project-root "$PWD" --json

The same flow is available in SKS Center → Remote & Telegram.
See docs/telegram-and-center.md for the full guide and troubleshooting.
`);
}

export function telegramPairingReadiness(value: unknown): TelegramPairingReadiness {
  const pairing = validateTelegramPrivatePairing(value);
  return {
    pairing_valid: pairing.ok,
    pairing_issues: pairing.issues,
    blocker: pairing.ok
      ? null
      : pairing.missing
        ? 'telegram_pairing_missing'
        : `telegram_pairing_invalid:${pairing.issues.join(',')}`
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
  await resolveTelegramBotToken(config.bot_token_ref);
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
