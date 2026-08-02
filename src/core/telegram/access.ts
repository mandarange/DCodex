import { randomInt, randomUUID } from 'node:crypto';
import type { TelegramClock } from './types.js';
import { SYSTEM_TELEGRAM_CLOCK } from './types.js';

interface PairingRecord {
  code: string;
  expiresAt: number;
  used: boolean;
}

export interface TelegramAuthorizedChat {
  chatId: number;
  senderId: number;
  pairedAt: string;
}

export interface TelegramAccessStore {
  issuePairingCode(ttlMs?: number): Promise<{ code: string; expires_at: string }>;
  pairAtomically(input: { code: string; chatId: number; senderId: number; chatType: string }): Promise<boolean>;
  authorized(chatId: number, senderId: number): Promise<boolean>;
  authorizedCount(): Promise<number>;
}

/** In-memory reference store. Production injects the resident app's private-file store. */
export class InMemoryTelegramAccessStore implements TelegramAccessStore {
  private readonly clock: TelegramClock;
  private readonly pairings = new Map<string, PairingRecord>();
  private readonly chats = new Map<number, TelegramAuthorizedChat>();
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(clock: TelegramClock = SYSTEM_TELEGRAM_CLOCK) {
    this.clock = clock;
  }

  async issuePairingCode(ttlMs = 5 * 60_000): Promise<{ code: string; expires_at: string }> {
    return this.transaction(async () => {
      this.expireCodes();
      const code = `${randomInt(100_000, 1_000_000)}-${randomUUID().slice(0, 4).toUpperCase()}`;
      const expiresAt = this.clock.now() + Math.max(30_000, Math.min(ttlMs, 15 * 60_000));
      this.pairings.set(code, { code, expiresAt, used: false });
      return { code, expires_at: new Date(expiresAt).toISOString() };
    });
  }

  async pairAtomically(input: { code: string; chatId: number; senderId: number; chatType: string }): Promise<boolean> {
    return this.transaction(async () => {
      const record = this.pairings.get(input.code);
      if (input.chatType !== 'private'
        || !Number.isSafeInteger(input.chatId) || input.chatId <= 0
        || !Number.isSafeInteger(input.senderId) || input.senderId <= 0
        || !record || record.used || record.expiresAt <= this.clock.now()) return false;
      record.used = true;
      this.chats.clear();
      this.chats.set(input.chatId, {
        chatId: input.chatId,
        senderId: input.senderId,
        pairedAt: new Date(this.clock.now()).toISOString()
      });
      return true;
    });
  }

  async authorized(chatId: number, senderId: number): Promise<boolean> {
    return this.transaction(async () => {
      const chat = this.chats.get(chatId);
      return chat?.senderId === senderId;
    });
  }

  async authorizedCount(): Promise<number> {
    return this.transaction(async () => this.chats.size);
  }

  private expireCodes(): void {
    for (const [code, record] of this.pairings) {
      if (record.used || record.expiresAt <= this.clock.now()) this.pairings.delete(code);
    }
  }

  private transaction<T>(operation: () => Promise<T> | T): Promise<T> {
    const next = this.transactionTail.then(operation, operation);
    this.transactionTail = next.then(() => undefined, () => undefined);
    return next;
  }
}
