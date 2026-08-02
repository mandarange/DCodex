import type { TelegramClient, TelegramTokenProvider } from './client.js';
import type { TelegramAccessStore } from './access.js';
import type { TelegramPoller } from './poller.js';
import { redactTelegramError } from './redaction.js';
import { readTelegramLivenessReceipt, telegramLivenessPath } from './liveness.js';
import type { TelegramTokenSource } from './types.js';

export interface TelegramDoctorProbe {
  schema: 'sks.telegram-doctor-probe.v1';
  ok: boolean;
  status: 'ready' | 'degraded' | 'not_configured';
  token_configured: boolean;
  token_source?: TelegramTokenSource;
  bot_identity_valid: boolean;
  getme_checked_at: string | null;
  getme_latency_ms: number | null;
  getme_check_kind: 'live' | 'receipt';
  paired_chat_count: number;
  audit_healthy: boolean;
  audit_last_error: string | null;
  poller: ReturnType<TelegramPoller['snapshot']>;
  blockers: string[];
  checked_at: string;
}

export async function probeTelegram(input: {
  client?: TelegramClient;
  tokenProvider?: TelegramTokenProvider;
  access?: TelegramAccessStore;
  poller?: TelegramPoller;
  receiptPath?: string;
  now?: number;
}): Promise<TelegramDoctorProbe> {
  const now = input.now ?? Date.now();
  if (!input.client || !input.tokenProvider) {
    return probeTelegramReceipt(input.receiptPath, now);
  }

  const receiptProbe = !input.access || !input.poller
    ? await probeTelegramReceipt(input.receiptPath, now)
    : null;
  const blockers = receiptProbe
    ? receiptProbe.blockers.filter((blocker) => ![
        'telegram_token_missing',
        'telegram_getme_not_valid',
        'telegram_getme_stale'
      ].includes(blocker))
    : [];
  let tokenConfigured = false;
  try {
    tokenConfigured = Boolean(String(await input.tokenProvider.loadToken() ?? '').trim());
  } catch (error) {
    blockers.push(`telegram_token_load_failed:${redactTelegramError(error)}`);
  }
  let identityValid = false;
  let getMeCheckedAt: string | null = null;
  let getMeLatencyMs: number | null = null;
  if (!tokenConfigured) blockers.push('telegram_token_missing');
  else {
    const started = Date.now();
    try {
      identityValid = (await input.client.getMe()).is_bot === true;
      if (!identityValid) blockers.push('telegram_getme_not_bot');
    }
    catch (error) { blockers.push(`telegram_getme_failed:${redactTelegramError(error)}`); }
    finally {
      getMeLatencyMs = Date.now() - started;
      getMeCheckedAt = new Date().toISOString();
    }
  }
  let pairedChatCount = receiptProbe?.paired_chat_count ?? 0;
  if (input.access) {
    try { pairedChatCount = await input.access.authorizedCount(); }
    catch (error) { blockers.push(`telegram_access_state_failed:${redactTelegramError(error)}`); }
  }
  if (pairedChatCount === 0 && !blockers.includes('telegram_private_chat_not_paired')) {
    blockers.push('telegram_private_chat_not_paired');
  }
  let poller = receiptProbe?.poller ?? emptyPoller();
  if (input.poller) {
    try { poller = input.poller.snapshot(); }
    catch (error) { blockers.push(`telegram_poller_state_failed:${redactTelegramError(error)}`); }
  }
  if (!poller.running && !blockers.includes('telegram_poller_not_running')) {
    blockers.push('telegram_poller_not_running');
  }
  return {
    schema: 'sks.telegram-doctor-probe.v1',
    ok: blockers.length === 0,
    status: !tokenConfigured ? 'not_configured' : blockers.length ? 'degraded' : 'ready',
    token_configured: tokenConfigured,
    token_source: tokenConfigured ? (receiptProbe?.token_source ?? 'unknown') : 'none',
    bot_identity_valid: identityValid,
    getme_checked_at: getMeCheckedAt,
    getme_latency_ms: getMeLatencyMs,
    getme_check_kind: 'live',
    paired_chat_count: pairedChatCount,
    audit_healthy: receiptProbe?.audit_healthy ?? true,
    audit_last_error: receiptProbe?.audit_last_error ?? null,
    poller,
    blockers: [...new Set(blockers)],
    checked_at: new Date().toISOString()
  };
}

async function probeTelegramReceipt(receiptPath: string | undefined, now: number): Promise<TelegramDoctorProbe> {
  const liveness = await readTelegramLivenessReceipt(receiptPath ?? telegramLivenessPath(), now);
  if (!liveness.ok) {
    return {
      schema: 'sks.telegram-doctor-probe.v1', ok: false, status: 'not_configured',
      token_configured: false, bot_identity_valid: false, paired_chat_count: 0,
      token_source: 'none',
      audit_healthy: false, audit_last_error: null,
      getme_checked_at: null, getme_latency_ms: null,
      getme_check_kind: 'receipt',
      poller: emptyPoller(), blockers: [liveness.blocker], checked_at: new Date(now).toISOString()
    };
  }
  const receipt = liveness.receipt;
  const blockers: string[] = [];
  if (!receipt.token_configured) blockers.push('telegram_token_missing');
  if (receipt.token_configured && !receipt.bot_identity_valid) blockers.push('telegram_getme_not_valid');
  const getMeAge = receipt.getme_checked_at ? now - Date.parse(receipt.getme_checked_at) : Number.POSITIVE_INFINITY;
  if (receipt.bot_identity_valid && getMeAge > 10 * 60_000) blockers.push('telegram_getme_stale');
  if (receipt.paired_chat_count === 0) blockers.push('telegram_private_chat_not_paired');
  if (receipt.audit_healthy === false) blockers.push('telegram_audit_unavailable');
  if (!receipt.running || !receipt.poller.running) blockers.push('telegram_poller_not_running');
  if (liveness.stale) blockers.push('telegram_liveness_stale');
  if (receipt.poller.consecutive_failures > 0) blockers.push('telegram_poller_degraded');
  return {
    schema: 'sks.telegram-doctor-probe.v1',
    ok: blockers.length === 0,
    status: !receipt.token_configured ? 'not_configured' : blockers.length ? 'degraded' : 'ready',
    token_configured: receipt.token_configured,
    token_source: receipt.token_source ?? (receipt.token_configured ? 'unknown' : 'none'),
    bot_identity_valid: receipt.bot_identity_valid,
    getme_checked_at: receipt.getme_checked_at,
    getme_latency_ms: receipt.getme_latency_ms,
    getme_check_kind: 'receipt',
    paired_chat_count: receipt.paired_chat_count,
    audit_healthy: receipt.audit_healthy !== false,
    audit_last_error: receipt.audit_last_error ?? null,
    poller: receipt.poller,
    blockers,
    checked_at: new Date(now).toISOString()
  };
}

function emptyPoller(): ReturnType<TelegramPoller['snapshot']> {
  return {
    schema: 'sks.telegram-poller-state.v1', running: false, offset: 0,
    consecutive_failures: 0, last_poll_at: null, last_success_at: null,
    last_update_at: null, last_error: null
  };
}

export type TelegramSelfHealAction = 'restart_poll' | 'revalidate_token' | 'operator_remove_webhook' | 'operator_repair_audit' | 'none';

export function telegramSelfHealAction(probe: TelegramDoctorProbe): TelegramSelfHealAction {
  if (!probe.audit_healthy || probe.blockers.includes('telegram_audit_unavailable')) return 'operator_repair_audit';
  if (!probe.token_configured || !probe.bot_identity_valid || probe.blockers.includes('telegram_getme_stale')) return 'revalidate_token';
  if (/409|webhook/i.test(probe.poller.last_error ?? '')) return 'operator_remove_webhook';
  if (probe.blockers.includes('telegram_liveness_stale') || !probe.poller.running || probe.poller.consecutive_failures > 0) return 'restart_poll';
  return 'none';
}
