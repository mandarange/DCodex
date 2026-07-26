import fsp from 'node:fs/promises';
import path from 'node:path';
import { runProcess, sha256 } from '../fsx.js';
import type { TelegramHubConfigV1, TelegramSecretRef } from './types.js';
import { isRecord } from '../json/records.js';

export interface TelegramConfigValidation {
  ok: boolean;
  issues: string[];
  config: TelegramHubConfigV1 | null;
}

export interface TelegramPrivatePairingValidation {
  ok: boolean;
  missing: boolean;
  issues: Array<'paired_chat_ids' | 'paired_user_ids'>;
}

export function validateTelegramConfig(value: unknown): TelegramConfigValidation {
  const issues: string[] = [];
  if (!isRecord(value)) return { ok: false, issues: ['config_not_object'], config: null };
  if (value.schema !== 'sks.telegram-config.v1') issues.push('schema');
  if ('bot_token' in value || 'token' in value) issues.push('raw_bot_token_forbidden');
  const secret = value.bot_token_ref;
  if (!isRecord(secret) || !['keychain', 'external_file'].includes(String(secret.type || ''))) {
    issues.push('bot_token_ref');
  } else if (secret.type === 'keychain') {
    if (!nonEmpty(secret.service) || !nonEmpty(secret.account)) issues.push('keychain_reference_incomplete');
  } else if (secret.type === 'external_file') {
    if (!nonEmpty(secret.path) || !path.isAbsolute(String(secret.path))) issues.push('external_secret_path_must_be_absolute');
  }
  issues.push(...validateTelegramPrivatePairing(value).issues);
  if (typeof value.long_poll_timeout_sec === 'number' && (value.long_poll_timeout_sec < 1 || value.long_poll_timeout_sec > 50)) issues.push('long_poll_timeout_sec');
  if (typeof value.owner_stale_ms === 'number' && value.owner_stale_ms < 5_000) issues.push('owner_stale_ms');
  if ('mini_app' in value) issues.push('mini_app_excluded_from_6_3_package');
  return {
    ok: issues.length === 0,
    issues,
    config: issues.length === 0 ? value as unknown as TelegramHubConfigV1 : null
  };
}

export async function loadTelegramConfig(file: string): Promise<TelegramHubConfigV1> {
  const parsed = JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
  const validation = validateTelegramConfig(parsed);
  if (!validation.ok || !validation.config) throw new Error(`telegram_config_invalid:${validation.issues.join(',')}`);
  return validation.config;
}

export async function resolveTelegramBotToken(
  ref: TelegramSecretRef,
  options: { run?: typeof runProcess } = {}
): Promise<string> {
  if (ref.type === 'keychain') {
    if (!ref.service || !ref.account) throw new Error('telegram_keychain_reference_incomplete');
    if (process.platform !== 'darwin') throw new Error('telegram_keychain_requires_macos');
    const run = options.run ?? runProcess;
    const result = await run('/usr/bin/security', [
      'find-generic-password', '-w', '-s', ref.service, '-a', ref.account
    ], { timeoutMs: 5_000, maxOutputBytes: 8 * 1024 });
    if (result.code !== 0 || result.timedOut) throw new Error('telegram_keychain_lookup_failed');
    return validateTelegramBotToken(result.stdout.trim());
  }
  if (!ref.path || !path.isAbsolute(ref.path)) throw new Error('telegram_external_secret_path_invalid');
  const stat = await fsp.lstat(ref.path);
  if (stat.isSymbolicLink()) throw new Error('telegram_external_secret_symlink_forbidden');
  if (!stat.isFile()) throw new Error('telegram_external_secret_not_file');
  if ((stat.mode & 0o077) !== 0) throw new Error('telegram_external_secret_permissions_must_be_0600');
  return validateTelegramBotToken((await fsp.readFile(ref.path, 'utf8')).trim());
}

export function telegramTokenFingerprint(token: string): string {
  return `sha256:${sha256(token)}`;
}

export function validateTelegramBotToken(token: string): string {
  if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token)) throw new Error('telegram_bot_token_format_invalid');
  return token;
}

export function isPositiveTelegramId(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value);
}

export function validateTelegramPrivatePairing(value: unknown): TelegramPrivatePairingValidation {
  if (!isRecord(value)) {
    return {
      ok: false,
      missing: true,
      issues: ['paired_chat_ids', 'paired_user_ids']
    };
  }
  const issues: TelegramPrivatePairingValidation['issues'] = [];
  if (!positiveStringIdArray(value.paired_chat_ids)) issues.push('paired_chat_ids');
  if (!positiveStringIdArray(value.paired_user_ids)) issues.push('paired_user_ids');
  const missing = pairingFieldMissing(value, 'paired_chat_ids') || pairingFieldMissing(value, 'paired_user_ids');
  return { ok: issues.length === 0, missing, issues };
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveStringIdArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isPositiveTelegramId);
}

function pairingFieldMissing(value: Record<string, unknown>, field: 'paired_chat_ids' | 'paired_user_ids'): boolean {
  return !(field in value) || (Array.isArray(value[field]) && value[field].length === 0);
}
