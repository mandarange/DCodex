import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TelegramLivenessReceipt, TelegramPollSnapshot, TelegramTokenSource } from './types.js';

const MAX_RECEIPT_BYTES = 64 * 1024;

export function telegramLivenessPath(home = process.env.HOME || os.homedir()): string {
  return path.join(path.resolve(home), '.codex', 'sks-menubar', 'telegram-liveness.json');
}

export function createTelegramLivenessReceipt(input: {
  generation: string;
  pid?: number;
  running: boolean;
  tokenConfigured: boolean;
  tokenSource?: TelegramTokenSource;
  botId?: number | null;
  botIdentityValid: boolean;
  getMeCheckedAt?: string | null;
  getMeLatencyMs?: number | null;
  pairedChatCount: number;
  startedAt: string;
  heartbeatAt?: string;
  staleAfterSeconds?: number;
  auditHealthy?: boolean;
  auditLastError?: string | null;
  poller: TelegramPollSnapshot;
}): TelegramLivenessReceipt {
  if (!optionalPositiveSafeInteger(input.botId)) throw new Error('telegram_liveness_bot_id_invalid');
  return {
    schema: 'sks.telegram-liveness.v1',
    generation: input.generation,
    pid: input.pid ?? process.pid,
    running: input.running,
    token_configured: input.tokenConfigured,
    token_source: input.tokenSource ?? (input.tokenConfigured ? 'unknown' : 'none'),
    bot_id: input.botId ?? null,
    bot_identity_valid: input.botIdentityValid,
    getme_checked_at: input.getMeCheckedAt ?? (input.botIdentityValid ? (input.heartbeatAt ?? new Date().toISOString()) : null),
    getme_latency_ms: input.getMeLatencyMs ?? (input.botIdentityValid ? 0 : null),
    paired_chat_count: Math.max(0, Math.floor(input.pairedChatCount)),
    started_at: input.startedAt,
    heartbeat_at: input.heartbeatAt ?? new Date().toISOString(),
    stale_after_seconds: Math.max(15, Math.min(input.staleAfterSeconds ?? 120, 600)),
    audit_healthy: input.auditHealthy ?? true,
    audit_last_error: input.auditLastError ?? null,
    poller: { ...input.poller }
  };
}

export async function writeTelegramLivenessReceipt(
  file: string,
  receipt: TelegramLivenessReceipt
): Promise<void> {
  const target = path.resolve(file);
  const directory = path.dirname(target);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(target)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, target);
    await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export type TelegramLivenessRead =
  | { ok: true; receipt: TelegramLivenessReceipt; stale: boolean; age_ms: number }
  | { ok: false; receipt: null; blocker: string };

export async function readTelegramLivenessReceipt(
  file = telegramLivenessPath(),
  now = Date.now()
): Promise<TelegramLivenessRead> {
  const target = path.resolve(file);
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) return { ok: false, receipt: null, blocker: 'telegram_liveness_missing' };
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, receipt: null, blocker: 'telegram_liveness_unsafe_type' };
  if (stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) return { ok: false, receipt: null, blocker: 'telegram_liveness_invalid_size' };
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
    return { ok: false, receipt: null, blocker: 'telegram_liveness_insecure_mode' };
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    return { ok: false, receipt: null, blocker: 'telegram_liveness_wrong_owner' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(await fs.readFile(target, 'utf8')); }
  catch { return { ok: false, receipt: null, blocker: 'telegram_liveness_invalid_json' }; }
  if (!isTelegramLivenessReceipt(parsed)) {
    return { ok: false, receipt: null, blocker: 'telegram_liveness_invalid_schema' };
  }
  const heartbeat = Date.parse(parsed.heartbeat_at);
  const ageMs = Number.isFinite(heartbeat) ? Math.max(0, now - heartbeat) : Number.POSITIVE_INFINITY;
  return {
    ok: true,
    receipt: parsed,
    stale: ageMs > parsed.stale_after_seconds * 1_000,
    age_ms: ageMs
  };
}

function isTelegramLivenessReceipt(value: unknown): value is TelegramLivenessReceipt {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.schema === 'sks.telegram-liveness.v1'
    && typeof row.generation === 'string' && row.generation.length >= 8 && row.generation.length <= 128
    && Number.isSafeInteger(row.pid) && Number(row.pid) > 0
    && typeof row.running === 'boolean'
    && typeof row.token_configured === 'boolean'
    && (row.token_source === undefined || ['env', 'user_secret_file', 'none', 'unknown'].includes(String(row.token_source)))
    && optionalPositiveSafeInteger(row.bot_id)
    && typeof row.bot_identity_valid === 'boolean'
    && nullableIso(row.getme_checked_at)
    && (row.getme_latency_ms === null || (Number.isFinite(row.getme_latency_ms) && Number(row.getme_latency_ms) >= 0))
    && Number.isSafeInteger(row.paired_chat_count) && Number(row.paired_chat_count) >= 0
    && typeof row.started_at === 'string' && Number.isFinite(Date.parse(row.started_at))
    && typeof row.heartbeat_at === 'string' && Number.isFinite(Date.parse(row.heartbeat_at))
    && Number.isFinite(row.stale_after_seconds) && Number(row.stale_after_seconds) >= 15
    && (row.audit_healthy === undefined || typeof row.audit_healthy === 'boolean')
    && (row.audit_last_error === undefined || row.audit_last_error === null || typeof row.audit_last_error === 'string')
    && isPollSnapshot(row.poller);
}

function optionalPositiveSafeInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isPollSnapshot(value: unknown): value is TelegramPollSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return row.schema === 'sks.telegram-poller-state.v1'
    && typeof row.running === 'boolean'
    && Number.isSafeInteger(row.offset) && Number(row.offset) >= 0
    && Number.isSafeInteger(row.consecutive_failures) && Number(row.consecutive_failures) >= 0
    && nullableIso(row.last_poll_at) && nullableIso(row.last_success_at) && nullableIso(row.last_update_at)
    && (row.last_error === null || typeof row.last_error === 'string');
}

function nullableIso(value: unknown): boolean {
  return value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}
