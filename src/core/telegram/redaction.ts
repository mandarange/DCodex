import { createHash } from 'node:crypto';

const BOT_URL = /\/bot[^/\s]+\//gi;
const TOKEN_ASSIGNMENT = /((?:bot[_-]?token|token)\s*[:=]\s*)[^\s,"'}]+/gi;

export function redactTelegramError(value: unknown, token?: string): string {
  let text = value instanceof Error ? value.message : String(value ?? 'telegram_error');
  if (token) text = text.split(token).join('[redacted]');
  return text
    .replace(BOT_URL, '/bot[redacted]/')
    .replace(TOKEN_ASSIGNMENT, '$1[redacted]')
    .slice(0, 512);
}

export function redactedChatActor(chatId: number, senderId: number = chatId): string {
  return `actor:${createHash('sha256').update(`${chatId}:${senderId}`).digest('hex').slice(0, 12)}`;
}
