import { TelegramApiError, type TelegramClient } from './client.js';
import { redactTelegramError } from './redaction.js';
import type { TelegramPollSnapshot, TelegramUpdate } from './types.js';

export interface TelegramPollerOptions {
  client: TelegramClient;
  handleUpdate(update: TelegramUpdate): Promise<void>;
  timeoutSeconds?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  initialOffset?: number;
  checkpoint?: (snapshot: TelegramPollSnapshot) => Promise<void>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class TelegramPoller {
  private readonly options: Required<Omit<TelegramPollerOptions, 'client' | 'handleUpdate' | 'checkpoint'>>
    & Pick<TelegramPollerOptions, 'client' | 'handleUpdate' | 'checkpoint'>;
  private controller: AbortController | null = null;
  private state: TelegramPollSnapshot = {
    schema: 'sks.telegram-poller-state.v1', running: false, offset: 0,
    consecutive_failures: 0, last_poll_at: null, last_success_at: null,
    last_update_at: null, last_error: null
  };

  constructor(options: TelegramPollerOptions) {
    this.options = {
      ...options,
      timeoutSeconds: Math.max(1, Math.min(options.timeoutSeconds ?? 30, 50)),
      minBackoffMs: Math.max(100, options.minBackoffMs ?? 500),
      maxBackoffMs: Math.max(options.minBackoffMs ?? 500, Math.min(options.maxBackoffMs ?? 30_000, 60_000)),
      initialOffset: Number.isSafeInteger(options.initialOffset) && Number(options.initialOffset) >= 0
        ? Number(options.initialOffset)
        : 0,
      sleep: options.sleep ?? abortableSleep
    };
    this.state = { ...this.state, offset: this.options.initialOffset };
  }

  snapshot(): TelegramPollSnapshot { return { ...this.state }; }

  start(): Promise<void> {
    if (this.controller) throw new Error('telegram_poller_already_running');
    this.controller = new AbortController();
    this.state = { ...this.state, running: true, last_error: null };
    return this.run(this.controller.signal).finally(() => {
      this.controller = null;
      this.state = { ...this.state, running: false };
    });
  }

  stop(): void { this.controller?.abort(); }

  private async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.state = { ...this.state, last_poll_at: new Date().toISOString() };
      try {
        const updates = await this.options.client.getUpdates({
          offset: this.state.offset,
          timeoutSeconds: this.options.timeoutSeconds,
          allowedUpdates: ['message'],
          signal
        });
        for (const update of [...updates].sort((a, b) => a.update_id - b.update_id)) {
          if (signal.aborted) return;
          if (!Number.isSafeInteger(update.update_id) || update.update_id < this.state.offset) continue;
          // Claim and durably checkpoint the update before invoking a handler
          // that may cause an external effect. A reply failure or process crash
          // must not replay a destructive command.
          const claimed = {
            ...this.state,
            offset: Math.max(this.state.offset, update.update_id + 1),
            last_update_at: new Date().toISOString()
          };
          if (this.options.checkpoint) await this.options.checkpoint(claimed);
          this.state = claimed;
          await this.options.handleUpdate(update);
        }
        this.state = {
          ...this.state,
          consecutive_failures: 0,
          last_success_at: new Date().toISOString(),
          last_error: null
        };
      } catch (error) {
        if (signal.aborted) return;
        const failures = this.state.consecutive_failures + 1;
        this.state = { ...this.state, consecutive_failures: failures, last_error: redactTelegramError(error) };
        const retryAfter = error instanceof TelegramApiError ? error.retryAfterSeconds : null;
        const exponential = Math.min(this.options.maxBackoffMs, this.options.minBackoffMs * (2 ** Math.min(failures - 1, 8)));
        const delay = retryAfter == null ? exponential : Math.min(this.options.maxBackoffMs, Math.max(exponential, retryAfter * 1_000));
        await this.options.sleep(delay, signal).catch(() => undefined);
      }
    }
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', aborted, { once: true });
    function done() { signal.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); reject(signal.reason); }
  });
}
