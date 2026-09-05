import { isDeepStrictEqual } from 'node:util';
import type { ResponsesContinuation } from './responses-transport.js';

export interface ResponsesAsyncTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Must honor cancellation and settle promptly after signal.abort. */
  execute: (args: unknown, context: { signal: AbortSignal }) => Promise<unknown>;
}

export interface ResponsesAsyncResult {
  ok: boolean;
  status: 'completed' | 'blocked';
  model: string;
  final_text: string;
  model_async_observed: boolean;
  /** Measures text delivery before result submission, not CPU overlap. */
  continued_before_tool_output: boolean;
  rounds: number;
  tool_calls: Array<{ call_id: string; name: string; async: boolean; completed: boolean; output_submitted: boolean }>;
  blockers: string[];
}

type Item = Record<string, unknown>;
const BODY_LIMIT = 4 * 1024 * 1024;
const CONTEXT_LIMIT = 8 * 1024 * 1024;

function record(value: unknown): value is Item {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

class RunnerBlock extends Error {}
function block(reason: string): never { throw new RunnerBlock(reason); }

/** An abort race for transport operations; tool promises themselves are always drained. */
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) block('timeout');
  let onAbort!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new RunnerBlock('timeout'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([operation, aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}

/** Bounded, stateless Responses SSE loop. No provider-stored response IDs are required. */
export async function runResponsesAsync(options: {
  request: (body: Record<string, unknown>, signal: AbortSignal, continuation?: ResponsesContinuation) => Promise<Response>;
  model: string;
  prompt: string;
  tools: ResponsesAsyncTool[];
  effort?: string;
  timeoutMs?: number;
}): Promise<ResponsesAsyncResult> {
  const result: ResponsesAsyncResult = {
    ok: false, status: 'blocked', model: options.model, final_text: '',
    model_async_observed: false, continued_before_tool_output: false,
    rounds: 0, tool_calls: [], blockers: [],
  };
  const controller = new AbortController();
  const { signal } = controller;
  const timeout = options.timeoutMs ?? 120_000;
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeout) ? Math.min(180_000, Math.max(1, timeout)) : 120_000);
  const promises: Promise<void>[] = [];
  const calls = new Map<string, { item: Item; audit: ResponsesAsyncResult['tool_calls'][number]; output?: string }>();
  let active = 0;
  let toolFailed = false;
  let contextBytes = 2;
  const history: Item[] = [];
  let previousResponseId: string | undefined;
  let newInputStart = 0;
  const append = (item: Item) => {
    contextBytes += Buffer.byteLength(JSON.stringify(item)) + 1;
    if (contextBytes > CONTEXT_LIMIT) block('context_limit');
    history.push(item);
  };
  const noteContinuation = () => {
    if ([...calls.values()].some(call => call.audit.async && !call.audit.output_submitted)) {
      result.continued_before_tool_output = true;
    }
  };
  const dispatch = (item: Item) => {
    if (signal.aborted) block('timeout');
    if (typeof item.call_id !== 'string' || !item.call_id || typeof item.name !== 'string' || typeof item.arguments !== 'string') block('invalid_function_call');
    const prior = calls.get(item.call_id);
    if (prior) {
      if (!isDeepStrictEqual(prior.item, item)) block('conflicting_call_id');
      return;
    }
    if (calls.size >= 16) block('tool_call_limit');
    if (active >= 4) block('tool_concurrency_limit');
    const audit = { call_id: item.call_id, name: item.name, async: item.async === true, completed: false, output_submitted: false };
    result.tool_calls.push(audit);
    result.model_async_observed ||= audit.async;
    if (!audit.async && !result.blockers.includes('model_async_not_enabled')) result.blockers.push('model_async_not_enabled');
    const call: { item: Item; audit: typeof audit; output?: string } = { item, audit };
    calls.set(audit.call_id, call);
    const tool = options.tools.find(candidate => candidate.name === audit.name);
    if (!tool) block('unknown_tool');
    let args: unknown;
    try { args = JSON.parse(item.arguments); } catch { block('invalid_tool_arguments'); }
    active++;
    const pending = (async () => {
      try {
        // Do not defer invocation beyond a cancellation boundary.
        if (signal.aborted) return;
        const value = await tool.execute(args, { signal });
        if (signal.aborted) return;
        const output = typeof value === 'string' ? value : JSON.stringify(value);
        if (typeof output !== 'string' || Buffer.byteLength(output) > BODY_LIMIT) {
          toolFailed = true;
          result.blockers.push('invalid_or_oversized_tool_output');
          return;
        }
        call.output = output;
        audit.completed = true;
      } catch {
        if (!signal.aborted) {
          toolFailed = true;
          result.blockers.push('tool_execution_failed');
        }
      } finally { active--; }
    })();
    promises.push(pending);
  };

  try {
    if (new Set(options.tools.map(tool => tool.name)).size !== options.tools.length) block('duplicate_tool_name');
    append({ role: 'user', content: options.prompt });
    for (let round = 0; round < 6; round++) {
      if (signal.aborted) block('timeout');
      const awaitingSubmission = [...calls.values()].filter(call => call.audit.completed && !call.audit.output_submitted);
      const body: Item = {
        model: options.model, stream: true, store: false, parallel_tool_calls: false,
        include: ['reasoning.encrypted_content'],
        instructions: 'Launch useful async tools early, then continue independent work while they run. Use actual tool results when available; do not invent results. Finish with an answer incorporating all requested tool results.',
        input: [...history],
        tools: options.tools.map(tool => ({ type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, async: true, strict: false })),
        ...(options.effort ? { reasoning: { effort: options.effort } } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(body)) > BODY_LIMIT) block('request_body_limit');
      result.rounds++;
      const transport = options.request(body, signal, { previousResponseId, newInputStart });
      // Dispose late transport responses without reading their output.
      void transport.then(response => { if (signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = await cancellable(transport, signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        block(`http_${response.status}`);
      }
      for (const call of awaitingSubmission) call.audit.output_submitted = true;
      if (!response.body) block('missing_response_body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      let terminal = false;
      const items = new Map<number, Item>();
      const accept = (item: unknown, index: unknown, streamed: boolean) => {
        if (!record(item) || !Number.isInteger(index) || (index as number) < 0) block('invalid_output_item');
        if ((item.type === 'function_call' || item.type === 'message') && item.status !== undefined && item.status !== 'completed') {
          block('output_item_not_completed');
        }
        const prior = items.get(index as number);
        if (prior) {
          if (!isDeepStrictEqual(prior, item)) block('conflicting_output_item');
          return;
        }
        if (item.type === 'function_call') {
          if (!streamed) block('function_call_missing_done_event');
          dispatch(item);
        } else if (typeof item.type === 'string' && item.type.endsWith('_call')) {
          block('unknown_tool');
        } else if (item.type === 'message' && item.role === 'assistant' && streamed) noteContinuation();
        items.set(index as number, item);
      };
      const event = (frame: string) => {
        if (signal.aborted) block('timeout');
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data || data === '[DONE]') return;
        let payload: unknown;
        try { payload = JSON.parse(data); } catch { block('invalid_sse_json'); }
        if (!record(payload)) block('invalid_sse_event');
        if (terminal) block('event_after_terminal');
        if (payload.type === 'response.output_item.done') accept(payload.item, payload.output_index, true);
        if (payload.type === 'response.output_text.delta' && typeof payload.delta === 'string' && payload.delta.length > 0) noteContinuation();
        if (payload.type === 'response.failed' || payload.type === 'response.incomplete' || payload.type === 'error') block('response_failed_or_incomplete');
        if (payload.type === 'response.completed') {
          if (!record(payload.response) || payload.response.status !== 'completed' || !Array.isArray(payload.response.output)) block('invalid_completed_response');
          payload.response.output.forEach((item, index) => accept(item, index, false));
          previousResponseId = typeof payload.response.id === 'string' ? payload.response.id : undefined;
          terminal = true;
        }
      };
      try {
        while (true) {
          const chunk = await cancellable(reader.read(), signal);
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > BODY_LIMIT) block('response_body_limit');
          buffer += decoder.decode(chunk.value, { stream: true });
          let boundary: RegExpExecArray | null;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            event(buffer.slice(0, boundary.index));
            buffer = buffer.slice(boundary.index + boundary[0].length);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) event(buffer);
        if (!terminal) block('missing_completed_response');
      } finally {
        void reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (signal.aborted) block('timeout');
      const ordered = [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
      for (const item of ordered) {
        // Repeated identical calls must not be replayed as a second call.
        if (item.type === 'function_call' && history.some(previous => previous.type === 'function_call' && previous.call_id === item.call_id)) continue;
        append(item);
      }
      await cancellable(Promise.all(promises), signal);
      if (toolFailed) block('tool_results_unavailable');
      newInputStart = history.length;
      const pendingOutputs = [...calls.values()].filter(call => !call.audit.output_submitted);
      if (pendingOutputs.length) {
        for (const call of pendingOutputs) {
          if (!call.audit.completed || call.output === undefined) block('tool_results_unavailable');
          append({ type: 'function_call_output', call_id: call.audit.call_id, output: call.output });
        }
        if (round === 5) block('round_limit');
        continue;
      }
      result.final_text = ordered.filter(item => item.type === 'message' && item.role === 'assistant').flatMap(item => Array.isArray(item.content) ? item.content : []).filter((part): part is Item => record(part) && part.type === 'output_text' && typeof part.text === 'string').map(part => part.text as string).join('');
      if (!result.final_text.trim()) block('missing_final_text');
      if (!result.model_async_observed) block('model_async_not_observed');
      result.ok = result.blockers.length === 0;
      result.status = result.ok ? 'completed' : 'blocked';
      break;
    }
  } catch (error) {
    result.blockers.push(error instanceof RunnerBlock ? error.message : 'transport_or_protocol_error');
  } finally {
    controller.abort();
    clearTimeout(timer);
    // Integrations must honor the signal; never return while a callback is still running.
    await Promise.allSettled(promises);
  }
  result.blockers = [...new Set(result.blockers)];
  return result;
}
