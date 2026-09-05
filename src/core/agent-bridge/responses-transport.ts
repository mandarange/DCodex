import WebSocket from 'ws';

export interface ResponsesContinuation {
  previousResponseId: string | undefined;
  newInputStart: number;
}

const MAX_BYTES = 4 * 1024 * 1024;

/** One run owns one socket. Only unsent requests can move to HTTP. */
export function createResponsesTransport(options: {
  endpoint: string;
  headers: Record<string, string>;
  upstreamModel: string;
  handshakeTimeoutMs?: number;
}) {
  const report = {
    preferred: 'websocket' as const,
    websocket_connections: 0,
    websocket_requests: 0,
    http_requests: 0,
    incremental_continuations: 0,
    fallback_reason: null as string | null,
    failure: null as string | null,
  };
  let socket: WebSocket | null = null;
  let httpOnly = false;
  let closed = false;
  let active: { controller: ReadableStreamDefaultController<Uint8Array>; cleanup: () => void; bytes: number } | null = null;
  let lastResponseId: string | undefined;
  const encoder = new TextEncoder();
  const fail = (reason: string) => {
    report.failure = reason;
    const pending = active;
    active = null;
    pending?.cleanup();
    pending?.controller.error(new Error(reason));
    socket?.terminate();
  };

  async function connect(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || closed) throw new Error('transport_cancelled');
    if (httpOnly) return false;
    if (socket?.readyState === WebSocket.OPEN) return true;
    // Once a completed socket closes, recover from the caller's full history.
    if (socket) {
      httpOnly = true;
      report.fallback_reason = 'websocket_closed_between_responses';
      return false;
    }
    const url = new URL(options.endpoint);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return new Promise<boolean>((resolve, reject) => {
      // ws 8.21 supports closeTimeout; @types/ws 8.18 has not added it yet.
      const wsOptions: WebSocket.ClientOptions & { closeTimeout: number } = {
        headers: options.headers,
        followRedirects: false,
        perMessageDeflate: false,
        maxPayload: MAX_BYTES,
        handshakeTimeout: options.handshakeTimeoutMs ?? 5_000,
        closeTimeout: 500,
      };
      const ws = new WebSocket(url, wsOptions);
      socket = ws;
      let connected = false;
      let settled = false;
      const finish = (reason?: string, denyFallback = false) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        if (!reason) { resolve(true); return; }
        ws.terminate();
        if (signal.aborted || closed || denyFallback) {
          report.failure = reason;
          reject(new Error(reason));
        } else {
          httpOnly = true;
          report.fallback_reason = reason;
          resolve(false);
        }
      };
      const abort = () => finish('transport_cancelled', true);
      signal.addEventListener('abort', abort, { once: true });
      ws.once('open', () => {
        if (signal.aborted || closed) { abort(); return; }
        connected = true;
        report.websocket_connections++;
        finish();
      });
      ws.on('error', () => {
        if (!connected) finish('websocket_connect_failed');
        else if (active) fail('websocket_interrupted_after_send');
      });
      ws.on('close', () => {
        if (!connected) finish('websocket_connect_failed');
        else if (active) fail('websocket_interrupted_after_send');
      });
      ws.once('unexpected-response', (_request, response) => {
        response.destroy();
        const status = response.statusCode ?? 0;
        finish(`websocket_upgrade_${status}`, status === 401 || status === 403);
      });
      ws.on('message', (data, binary) => {
        if (!active) return; // Connection metadata can arrive between responses.
        if (binary) { fail('websocket_binary_event'); return; }
        const raw = data.toString();
        active.bytes += Buffer.byteLength(raw);
        if (active.bytes > MAX_BYTES) { fail('websocket_response_limit'); return; }
        let event: Record<string, unknown>;
        try { event = JSON.parse(raw); }
        catch { fail('websocket_invalid_json'); return; }
        if (!event || typeof event !== 'object' || Array.isArray(event)) { fail('websocket_invalid_event'); return; }
        active.controller.enqueue(encoder.encode(`data: ${raw}\n\n`));
        if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(String(event.type))) {
          const response = event.response as Record<string, unknown> | undefined;
          lastResponseId = event.type === 'response.completed' && typeof response?.id === 'string' ? response.id : undefined;
          const pending = active;
          active = null;
          pending.cleanup();
          pending.controller.close();
        }
      });
      if (signal.aborted) abort();
    });
  }

  async function request(body: Record<string, unknown>, signal: AbortSignal, continuation?: ResponsesContinuation): Promise<Response> {
    if (closed || signal.aborted) throw new Error('transport_cancelled');
    if (active) throw new Error('transport_response_already_active');
    const connected = await connect(signal);
    if (signal.aborted || closed) throw new Error('transport_cancelled');
    const ws = socket;
    if (!connected || !ws || ws.readyState !== WebSocket.OPEN) {
      httpOnly = true;
      report.fallback_reason ??= 'websocket_closed_before_send';
      report.http_requests++;
      return fetch(options.endpoint, {
        method: 'POST', redirect: 'error', signal,
        headers: { ...options.headers, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify(body),
      });
    }
    const payload = { ...body, type: 'response.create', model: options.upstreamModel };
    delete (payload as Record<string, unknown>).stream;
    delete (payload as Record<string, unknown>).background;
    if (continuation?.previousResponseId && continuation.previousResponseId === lastResponseId && Array.isArray(body.input)) {
      Object.assign(payload, { previous_response_id: lastResponseId, input: body.input.slice(continuation.newInputStart) });
      report.incremental_continuations++;
    }
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('websocket_request_limit');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => fail('transport_cancelled');
        active = { controller, bytes: 0, cleanup: () => signal.removeEventListener('abort', abort) };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) { abort(); return; }
        // Once send is attempted, delivery is uncertain: never replay this request.
        report.websocket_requests++;
        try { ws.send(encoded, error => { if (error) fail('websocket_interrupted_after_send'); }); }
        catch { fail('websocket_interrupted_after_send'); }
      },
      cancel() {
        if (active) {
          active.cleanup();
          active = null;
          socket?.terminate();
        }
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }

  function close(): void {
    closed = true;
    if (active) fail('transport_cancelled');
    else if (socket?.readyState === WebSocket.OPEN) socket.close();
    else if (socket?.readyState === WebSocket.CONNECTING) socket.terminate();
  }
  return { request, close, report };
}
