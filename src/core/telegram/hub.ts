import crypto from 'node:crypto';
import path from 'node:path';
import { globalSksRoot, nowIso } from '../fsx.js';
import { TelegramBotApiClient, TelegramBotApiError } from './bot-api.js';
import { TelegramActionBroker, TelegramAuditLedger, TelegramIdempotencyLedger, TelegramTopicRegistry } from './ledgers.js';
import { TelegramOwnerLock } from './owner-lock.js';
import type {
  RemoteActionV1,
  TelegramActionKind,
  TelegramHubConfigV1,
  TelegramMessage,
  TelegramRisk,
  TelegramUpdate
} from './types.js';

const COMMAND_POLICY: Record<string, { kind: TelegramActionKind; risk: TelegramRisk }> = {
  '/status': { kind: 'read', risk: 'R0' },
  '/tail': { kind: 'read', risk: 'R0' },
  '/diff': { kind: 'read', risk: 'R0' },
  '/gates': { kind: 'read', risk: 'R0' },
  '/trust': { kind: 'read', risk: 'R0' },
  '/proof': { kind: 'read', risk: 'R0' },
  '/artifacts': { kind: 'read', risk: 'R0' },
  '/input': { kind: 'input', risk: 'R1' },
  '/verify': { kind: 'verify', risk: 'R1' },
  '/cancel': { kind: 'cancel', risk: 'R2' },
  '/refresh': { kind: 'read', risk: 'R0' },
  '/open': { kind: 'read', risk: 'R0' }
};

const UI_POLICY: Record<string, { command: string; kind: TelegramActionKind; risk: TelegramRisk }> = {
  open: { command: '/open', kind: 'read', risk: 'R0' },
  diff: { command: '/diff', kind: 'read', risk: 'R0' },
  proof: { command: '/proof', kind: 'read', risk: 'R0' },
  gates: { command: '/gates', kind: 'read', risk: 'R0' },
  trust: { command: '/trust', kind: 'read', risk: 'R0' },
  input: { command: '/input', kind: 'input', risk: 'R1' },
  verify: { command: '/verify', kind: 'verify', risk: 'R1' },
  cancel: { command: '/cancel', kind: 'cancel', risk: 'R2' }
};

export interface TelegramHubRouteResult {
  schema: 'sks.telegram-route-result.v1';
  ok: boolean;
  status: string;
  action: RemoteActionV1 | null;
  callback_data?: string;
  session_picker: boolean;
}

export interface TelegramUpdateProcessor {
  processUpdate(update: TelegramUpdate): Promise<TelegramHubRouteResult>;
  tick?(): Promise<void>;
}

export interface TelegramHubOptions {
  config: TelegramHubConfigV1;
  topics: TelegramTopicRegistry;
  idempotency: TelegramIdempotencyLedger;
  actions: TelegramActionBroker;
  audit: TelegramAuditLedger;
  commandRevision?: number;
  now?: () => number;
}

export class TelegramHubRouter {
  private readonly commandRevision: number;
  private readonly now: () => number;

  constructor(private readonly options: TelegramHubOptions) {
    this.commandRevision = options.commandRevision ?? 1;
    this.now = options.now ?? Date.now;
  }

  async handleUpdate(update: TelegramUpdate): Promise<TelegramHubRouteResult> {
    const actor = actorFromUpdate(update);
    if (!actor || !this.isPaired(actor.chatId, actor.userId, actor.chatType)) {
      await this.audit(update, actor?.chatId ?? 'unknown', actor?.topicId ?? null, null, 'unpaired', 'rejected', 'not_paired');
      return result(false, 'not_paired');
    }
    if (!await this.options.idempotency.claim(update.update_id)) {
      await this.audit(update, actor.chatId, actor.topicId, null, 'duplicate', 'rejected', 'duplicate_update_id');
      return result(false, 'duplicate_update_id');
    }

    const callback = update.callback_query;
    if (callback?.data?.startsWith('cb:')) {
      const resolution = await this.options.actions.resolve({
        callback_data: callback.data,
        chat_id: actor.chatId,
        message_thread_id: actor.topicId ?? 0,
        revision: this.commandRevision,
        now: this.now()
      });
      await this.audit(update, actor.chatId, actor.topicId, callback.data.slice(3), 'callback', resolution.ok ? 'accepted' : 'rejected', resolution.status);
      return {
        schema: 'sks.telegram-route-result.v1',
        ok: resolution.ok,
        status: resolution.status,
        action: resolution.action,
        session_picker: false
      };
    }

    const message = actor.message;
    const staticUiAction = callback?.data?.startsWith('ui:') ? UI_POLICY[callback.data.slice(3)] : undefined;
    const text = staticUiAction?.command ?? message?.text?.trim() ?? '';
    const command = text.startsWith('/') ? text.split(/\s+/, 1)[0]?.toLowerCase() ?? '' : '';
    const policy = staticUiAction ?? COMMAND_POLICY[command];

    const route = actor.topicId === null
      ? await this.onlyRouteForPrivateChat(actor.chatId)
      : await this.options.topics.findByTopic(actor.chatId, actor.topicId);
    if (actor.topicId === null && !route) {
      await this.audit(update, actor.chatId, null, null, command || 'free_text', 'rejected', 'session_picker_required');
      return { ...result(false, 'session_picker_required'), session_picker: true };
    }
    if (!route) return this.reject(update, actor, command || 'free_text', 'wrong_topic');

    if (policy) {
      const prompt = policy.kind === 'input'
        ? inputText(text, command, Boolean(staticUiAction))
        : command || staticUiAction?.command || '';
      const action = makeAction(route, policy.kind, policy.risk, prompt, this.commandRevision, this.now());
      if (action.risk === 'R2') {
        const created = await this.options.actions.create(action, { chat_id: route.chat_id, message_thread_id: route.message_thread_id });
        await this.audit(update, actor.chatId, actor.topicId, created.callback_data.slice(3), command, 'accepted', 'approval_required');
        return { schema: 'sks.telegram-route-result.v1', ok: true, status: 'approval_required', action, callback_data: created.callback_data, session_picker: false };
      }
      const authorization = authorizeTelegramAction(action.risk, { exactTopic: true, explicitUserMessage: Boolean(message?.text) || Boolean(callback) });
      if (!authorization.ok) return this.reject(update, actor, command, authorization.reason);
      await this.audit(update, actor.chatId, actor.topicId, null, command, 'accepted', 'typed_command');
      return { schema: 'sks.telegram-route-result.v1', ok: true, status: 'accepted', action, session_picker: false };
    }

    if (!text) return this.reject(update, actor, 'empty', 'unsupported_update');
    const forceReply = message?.reply_to_message?.message_id;
    const action = makeAction(route, 'input', 'R1', text, this.commandRevision, this.now());
    const authorization = authorizeTelegramAction(action.risk, { exactTopic: true, explicitUserMessage: true });
    if (!authorization.ok) return this.reject(update, actor, 'input', authorization.reason);
    await this.audit(update, actor.chatId, actor.topicId, null, 'input', 'accepted', forceReply ? 'force_reply_routed' : 'topic_follow_up');
    return { schema: 'sks.telegram-route-result.v1', ok: true, status: 'accepted', action, session_picker: false };
  }

  private isPaired(chatId: string, userId: string, chatType: string): boolean {
    return chatType === 'private'
      && this.options.config.paired_chat_ids.includes(chatId)
      && this.options.config.paired_user_ids.includes(userId);
  }

  private async onlyRouteForPrivateChat(chatId: string) {
    const routes = (await this.options.topics.list()).filter((route) => route.chat_id === chatId);
    return routes.length === 1 && routes[0]?.message_thread_id === 0 ? routes[0] : null;
  }

  private async reject(update: TelegramUpdate, actor: UpdateActor, command: string, reason: string): Promise<TelegramHubRouteResult> {
    await this.audit(update, actor.chatId, actor.topicId, null, command, 'rejected', reason);
    return result(false, reason);
  }

  private async audit(
    update: TelegramUpdate,
    chatId: string,
    topicId: number | null,
    actionAlias: string | null,
    commandKind: string,
    decision: 'accepted' | 'rejected',
    policyReason: string
  ): Promise<void> {
    await this.options.audit.record({
      update_id: update.update_id,
      chat_id: chatId,
      topic_id: topicId,
      action_alias: actionAlias,
      command_kind: commandKind,
      decision,
      policy_reason: policyReason,
      effect_receipt: null
    });
  }
}

export function authorizeTelegramAction(
  risk: TelegramRisk,
  context: { exactTopic: boolean; explicitUserMessage: boolean; oneTimeApproval?: boolean }
): { ok: boolean; reason: string } {
  if (risk === 'R3') return { ok: false, reason: 'r3_always_denied' };
  if (!context.exactTopic) return { ok: false, reason: 'exact_topic_required' };
  if (risk === 'R0') return { ok: true, reason: 'r0_default' };
  if (risk === 'R1') return context.explicitUserMessage
    ? { ok: true, reason: 'r1_explicit_message' }
    : { ok: false, reason: 'r1_explicit_message_required' };
  return context.oneTimeApproval
    ? { ok: true, reason: 'r2_one_time_approval' }
    : { ok: false, reason: 'r2_approval_required' };
}

export class TelegramPollingHub {
  private offset = 0;

  constructor(
    private readonly client: TelegramBotApiClient,
    private readonly processor: TelegramUpdateProcessor,
    private readonly ownerLock: TelegramOwnerLock,
    private readonly longPollTimeoutSeconds = 25
  ) {}

  async ensureLongPollingAllowed(): Promise<void> {
    const info = await this.client.call<{ url?: string }>('getWebhookInfo', {});
    if (typeof info?.url === 'string' && info.url.trim()) {
      throw new Error('telegram_webhook_conflict:remove_webhook_before_long_polling');
    }
  }

  async pollOnce(): Promise<{ ok: boolean; processed: number; stopped_reason: string | null }> {
    try {
      const updates = await this.client.getUpdates({ offset: this.offset, timeout: this.longPollTimeoutSeconds });
      for (const update of updates) {
        await this.processor.processUpdate(update);
        this.offset = Math.max(this.offset, update.update_id + 1);
      }
      await this.processor.tick?.();
      await this.ownerLock.heartbeat();
      return { ok: true, processed: updates.length, stopped_reason: null };
    } catch (error: unknown) {
      if (error instanceof TelegramBotApiError && error.errorCode === 409) {
        await this.ownerLock.release();
        return { ok: false, processed: 0, stopped_reason: 'telegram_409_conflict' };
      }
      throw error;
    }
  }

  async run(signal: AbortSignal): Promise<{ ok: boolean; stopped_reason: string }> {
    await this.ensureLongPollingAllowed();
    while (!signal.aborted) {
      const result = await this.pollOnce();
      if (!result.ok) return { ok: false, stopped_reason: result.stopped_reason ?? 'poll_failed' };
    }
    await this.ownerLock.release();
    return { ok: true, stopped_reason: 'aborted' };
  }
}

export function telegramHubPaths(root = globalSksRoot()): {
  config: string;
  owner: string;
  idempotency: string;
  topics: string;
  actions: string;
  audit: string;
  projection: string;
} {
  const base = path.join(root, 'telegram');
  return {
    config: path.join(base, 'config.json'),
    owner: path.join(base, 'owner.lock'),
    idempotency: path.join(base, 'idempotency.jsonl'),
    topics: path.join(base, 'topic-registry.json'),
    actions: path.join(base, 'actions.json'),
    audit: path.join(base, 'audit.jsonl'),
    projection: path.join(base, 'projection-state.json')
  };
}

interface UpdateActor {
  chatId: string;
  userId: string;
  chatType: string;
  topicId: number | null;
  message: TelegramMessage | null;
}

function actorFromUpdate(update: TelegramUpdate): UpdateActor | null {
  const message = update.message ?? update.callback_query?.message;
  const from = update.message?.from ?? update.callback_query?.from;
  if (!message || !from) return null;
  return {
    chatId: String(message.chat.id),
    userId: String(from.id),
    chatType: message.chat.type,
    topicId: Number.isInteger(message.message_thread_id) ? message.message_thread_id ?? null : null,
    message: update.message ?? null
  };
}

function makeAction(
  route: { machine_id: string; project_id: string; session_id: string },
  kind: TelegramActionKind,
  risk: TelegramRisk,
  prompt: string,
  revision: number,
  now: number
): RemoteActionV1 {
  return {
    schema: 'sks.remote-action.v1',
    action_id: crypto.randomUUID(),
    machine_id: route.machine_id,
    project_id: route.project_id,
    session_id: route.session_id,
    kind,
    risk,
    prompt: prompt.slice(0, kind === 'input' ? 16 * 1024 : 120),
    exact_scope: [route.machine_id, route.project_id, route.session_id],
    expires_at: new Date(now + (risk === 'R2' ? 2 * 60_000 : 10 * 60_000)).toISOString(),
    revision,
    status: 'open'
  };
}

function inputText(text: string, command: string, staticAction: boolean): string {
  if (staticAction) return '/input';
  if (command !== '/input') return text;
  const value = text.slice(command.length).trim();
  return value || '/input';
}

function result(ok: boolean, status: string): TelegramHubRouteResult {
  return { schema: 'sks.telegram-route-result.v1', ok, status, action: null, session_picker: false };
}
