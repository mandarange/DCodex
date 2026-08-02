import { redactTelegramError } from './redaction.js';
import type {
  TelegramApiResponse,
  TelegramMessage,
  TelegramUpdate,
  TelegramUser
} from './types.js';

export interface TelegramTokenProvider {
  loadToken(): Promise<string | null>;
}

export class TelegramApiError extends Error {
  readonly code: number | null;
  readonly retryAfterSeconds: number | null;

  constructor(message: string, code: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'TelegramApiError';
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface TelegramClientOptions {
  tokenProvider: TelegramTokenProvider;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  allowInsecureLocalhost?: boolean;
  requestTimeoutMs?: number;
}

export class TelegramClient {
  private readonly tokenProvider: TelegramTokenProvider;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly baseUrl: URL;
  private readonly requestTimeoutMs: number;

  constructor(options: TelegramClientOptions) {
    this.tokenProvider = options.tokenProvider;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.baseUrl = validatedBaseUrl(options.baseUrl ?? 'https://api.telegram.org', options.allowInsecureLocalhost === true);
    this.requestTimeoutMs = Math.max(1_000, Math.min(options.requestTimeoutMs ?? 20_000, 120_000));
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {}, signal);
  }

  getUpdates(input: {
    offset: number;
    timeoutSeconds: number;
    allowedUpdates?: readonly string[];
    signal?: AbortSignal;
  }): Promise<TelegramUpdate[]> {
    if (!Number.isSafeInteger(input.offset) || input.offset < 0) {
      return Promise.reject(new TelegramApiError('telegram_offset_invalid'));
    }
    const timeoutSeconds = Number.isFinite(input.timeoutSeconds)
      ? Math.max(0, Math.min(50, Math.floor(input.timeoutSeconds)))
      : 0;
    return this.call<TelegramUpdate[]>('getUpdates', {
      offset: input.offset,
      timeout: timeoutSeconds,
      allowed_updates: [...(input.allowedUpdates ?? ['message'])]
    }, input.signal, Math.max(this.requestTimeoutMs, Math.min(70_000, (timeoutSeconds * 1_000) + 10_000)));
  }

  sendMessage(chatId: number, text: string, signal?: AbortSignal): Promise<TelegramMessage> {
    if (!Number.isSafeInteger(chatId)) return Promise.reject(new TelegramApiError('telegram_chat_id_invalid'));
    const bounded = text.slice(0, 4_000);
    if (!bounded) return Promise.reject(new TelegramApiError('telegram_message_empty'));
    return this.call<TelegramMessage>('sendMessage', { chat_id: chatId, text: bounded }, signal);
  }

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const token = String(await this.tokenProvider.loadToken() ?? '').trim();
    if (!token) throw new TelegramApiError('telegram_token_unavailable');
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new TelegramApiError('telegram_token_invalid');
    const endpoint = new URL(`/bot${token}/${method}`, this.baseUrl);
    const requestController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      requestController.abort(new Error('telegram_request_timeout'));
    }, timeoutMs);
    const abort = () => requestController.abort(signal?.reason);
    if (signal?.aborted) requestController.abort(signal.reason);
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: requestController.signal
      });
      const decoded = await decodeBoundedJson<T>(response);
      if (!response.ok || !decoded.ok) {
        const failure = decoded.ok ? null : decoded;
        throw new TelegramApiError(
          redactTelegramError(failure?.description || `telegram_http_${response.status}`, token),
          failure?.error_code ?? response.status,
          failure?.parameters?.retry_after ?? null
        );
      }
      return decoded.result;
    } catch (error) {
      if (error instanceof TelegramApiError) throw error;
      if (timedOut) throw new TelegramApiError('telegram_request_timeout');
      if (signal?.aborted) throw error;
      throw new TelegramApiError(redactTelegramError(error, token));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }
}

async function decodeBoundedJson<T>(response: Response): Promise<TelegramApiResponse<T>> {
  const maximum = 2 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maximum) throw new TelegramApiError('telegram_response_too_large');
  const reader = response.body?.getReader();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new TelegramApiError('telegram_response_too_large');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maximum) throw new TelegramApiError('telegram_response_too_large');
  }
  try {
    const value = JSON.parse(text) as TelegramApiResponse<T>;
    if (!value || typeof value !== 'object' || typeof value.ok !== 'boolean'
      || (value.ok && !('result' in value))) {
      throw new Error('shape');
    }
    return value;
  } catch {
    throw new TelegramApiError('telegram_response_invalid');
  }
}

function validatedBaseUrl(raw: string, allowInsecureLocalhost: boolean): URL {
  const url = new URL(raw);
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.username || url.password || url.search || url.hash) throw new Error('telegram_base_url_invalid');
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && local && url.protocol === 'http:')) {
    throw new Error('telegram_base_url_https_required');
  }
  return url;
}
