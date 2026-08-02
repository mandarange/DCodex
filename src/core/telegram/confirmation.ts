import { randomBytes } from 'node:crypto';
import type { TelegramClock } from './types.js';
import { SYSTEM_TELEGRAM_CLOCK } from './types.js';

export interface PendingTelegramCommand {
  chatId: number;
  senderId: number;
  command: string;
  input: Record<string, unknown>;
}

interface PendingConfirmation extends PendingTelegramCommand {
  nonce: string;
  expiresAt: number;
  consumed: boolean;
}

export class TelegramConfirmationStore {
  private readonly clock: TelegramClock;
  private readonly ttlMs: number;
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(options: { clock?: TelegramClock; ttlMs?: number } = {}) {
    this.clock = options.clock ?? SYSTEM_TELEGRAM_CLOCK;
    this.ttlMs = Math.max(15_000, Math.min(options.ttlMs ?? 2 * 60_000, 10 * 60_000));
  }

  issue(command: PendingTelegramCommand): { nonce: string; expires_at: string } {
    this.expire();
    const nonce = randomBytes(12).toString('base64url');
    const expiresAt = this.clock.now() + this.ttlMs;
    this.pending.set(nonce, { ...command, input: structuredClone(command.input), nonce, expiresAt, consumed: false });
    return { nonce, expires_at: new Date(expiresAt).toISOString() };
  }

  consume(nonce: string, chatId: number, senderId: number): PendingTelegramCommand | null {
    const item = this.pending.get(nonce);
    if (!item || item.consumed || item.expiresAt <= this.clock.now()) {
      if (item) this.pending.delete(nonce);
      return null;
    }
    if (item.chatId !== chatId || item.senderId !== senderId) return null;
    item.consumed = true;
    this.pending.delete(nonce);
    return { chatId: item.chatId, senderId: item.senderId, command: item.command, input: structuredClone(item.input) };
  }

  private expire(): void {
    for (const [nonce, item] of this.pending) {
      if (item.consumed || item.expiresAt <= this.clock.now()) this.pending.delete(nonce);
    }
  }
}
