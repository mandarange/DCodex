export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramWebhookInfo {
  url: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramApiFailure {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

export interface TelegramApiSuccess<T> {
  ok: true;
  result: T;
}

export type TelegramApiResponse<T> = TelegramApiSuccess<T> | TelegramApiFailure;

export interface TelegramPollSnapshot {
  schema: 'sks.telegram-poller-state.v1';
  running: boolean;
  offset: number;
  consecutive_failures: number;
  last_poll_at: string | null;
  last_success_at: string | null;
  last_update_at: string | null;
  last_error: string | null;
}

export type TelegramTokenSource = 'env' | 'user_secret_file' | 'none' | 'unknown';

/** Secret-free state written by the single resident menu-bar poller. */
export interface TelegramLivenessReceipt {
  schema: 'sks.telegram-liveness.v1';
  generation: string;
  pid: number;
  running: boolean;
  token_configured: boolean;
  token_source?: TelegramTokenSource;
  /** Optional for backward compatibility with receipts from older menu-bar builds. */
  bot_id?: number | null;
  bot_identity_valid: boolean;
  getme_checked_at: string | null;
  getme_latency_ms: number | null;
  paired_chat_count: number;
  started_at: string;
  heartbeat_at: string;
  stale_after_seconds: number;
  /** Optional for backward compatibility with receipts from older menu-bar builds. */
  audit_healthy?: boolean;
  audit_last_error?: string | null;
  poller: TelegramPollSnapshot;
}

export interface TelegramAuditEvent {
  schema: 'sks.telegram-audit.v1';
  at: string;
  actor: string;
  action: string;
  command?: string;
  outcome: 'allowed' | 'denied' | 'confirmed' | 'failed';
  detail?: string;
}

export interface TelegramAuditSink {
  record(event: TelegramAuditEvent): void | Promise<void>;
}

export interface TelegramClock {
  now(): number;
}

export const SYSTEM_TELEGRAM_CLOCK: TelegramClock = { now: () => Date.now() };
