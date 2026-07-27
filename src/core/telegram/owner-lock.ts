import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { errorCodeOf } from '../errors/message.js';
import { ensureDir, nowIso } from '../fsx.js';
import type { TelegramOwnerV1 } from './types.js';

export interface TelegramOwnerLockOptions {
  lockPath: string;
  tokenFingerprint: string;
  staleMs?: number;
  pid?: number;
  host?: string;
  processStartTime?: string;
  now?: () => number;
  isPidAlive?: (pid: number, host: string) => boolean;
}

export class TelegramOwnerConflictError extends Error {
  constructor(readonly owner: TelegramOwnerV1 | null) {
    super('telegram_owner_conflict');
    this.name = 'TelegramOwnerConflictError';
  }
}

export class TelegramOwnerLock {
  private readonly staleMs: number;
  private readonly pid: number;
  private readonly host: string;
  private readonly processStartTime: string;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number, host: string) => boolean;
  private owner: TelegramOwnerV1 | null = null;

  constructor(private readonly options: TelegramOwnerLockOptions) {
    this.staleMs = Math.max(5_000, options.staleMs ?? 30_000);
    this.pid = options.pid ?? process.pid;
    this.host = options.host ?? os.hostname();
    this.processStartTime = options.processStartTime ?? new Date(Date.now() - process.uptime() * 1000).toISOString();
    this.now = options.now ?? Date.now;
    this.isPidAlive = options.isPidAlive ?? localPidAlive;
  }

  async acquire(): Promise<TelegramOwnerV1> {
    await ensureDir(path.dirname(this.options.lockPath));
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const owner = this.buildOwner();
      try {
        const handle = await fsp.open(this.options.lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner, null, 2)}\n`, 'utf8');
          await handle.sync();
        } finally {
          await handle.close();
        }
        this.owner = owner;
        return owner;
      } catch (error: unknown) {
        if (errorCodeOf(error) !== 'EEXIST') throw error;
        const existing = await this.readOwner();
        if (!this.isStale(existing)) throw new TelegramOwnerConflictError(existing);
        const quarantine = `${this.options.lockPath}.stale-${this.now()}-${crypto.randomBytes(4).toString('hex')}`;
        try {
          await fsp.rename(this.options.lockPath, quarantine);
          await fsp.unlink(quarantine).catch(() => undefined);
        } catch (renameError: unknown) {
          if (!['ENOENT', 'EEXIST'].includes(errorCodeOf(renameError))) throw renameError;
        }
      }
    }
    throw new TelegramOwnerConflictError(await this.readOwner());
  }

  async heartbeat(): Promise<TelegramOwnerV1> {
    if (!this.owner) throw new Error('telegram_owner_not_acquired');
    const current = await this.readOwner();
    if (!sameOwner(current, this.owner)) throw new TelegramOwnerConflictError(current);
    const next = { ...this.owner, heartbeat_at: new Date(this.now()).toISOString() };
    await fsp.writeFile(this.options.lockPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    this.owner = next;
    return next;
  }

  async release(): Promise<void> {
    if (!this.owner) return;
    const current = await this.readOwner();
    if (sameOwner(current, this.owner)) await fsp.unlink(this.options.lockPath).catch(() => undefined);
    this.owner = null;
  }

  private buildOwner(): TelegramOwnerV1 {
    const at = new Date(this.now()).toISOString();
    return {
      schema: 'sks.telegram-owner.v1',
      pid: this.pid,
      process_start_time: this.processStartTime,
      host: this.host,
      bot_token_fingerprint: this.options.tokenFingerprint,
      owner_nonce: crypto.randomBytes(16).toString('base64url'),
      started_at: at,
      heartbeat_at: at
    };
  }

  private async readOwner(): Promise<TelegramOwnerV1 | null> {
    try {
      return JSON.parse(await fsp.readFile(this.options.lockPath, 'utf8')) as TelegramOwnerV1;
    } catch {
      return null;
    }
  }

  private isStale(owner: TelegramOwnerV1 | null): boolean {
    if (!owner) return true;
    const age = this.now() - Date.parse(owner.heartbeat_at);
    return Number.isFinite(age) && age > this.staleMs && !this.isPidAlive(owner.pid, owner.host);
  }
}

function sameOwner(left: TelegramOwnerV1 | null, right: TelegramOwnerV1): boolean {
  return Boolean(left
    && left.pid === right.pid
    && left.process_start_time === right.process_start_time
    && left.owner_nonce === right.owner_nonce
    && left.bot_token_fingerprint === right.bot_token_fingerprint);
}

function localPidAlive(pid: number, host: string): boolean {
  if (host !== os.hostname()) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return errorCodeOf(error) !== 'ESRCH';
  }
}
