import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import {
  CodexAppServerRequestError,
  CodexAppServerV2Client
} from '../codex-app-server-v2-client.js';
import type { CodexAppServerV2ClientOptions } from '../codex-app-server-v2-client.js';

function dynamicToolClient(t: TestContext, options: Partial<CodexAppServerV2ClientOptions> = {}) {
  const client = new CodexAppServerV2Client({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    ...options
  });
  client.start();
  const responses: Record<string, unknown>[] = [];
  t.mock.method(client.child!.stdin, 'write', (chunk: string) => {
    responses.push(JSON.parse(chunk) as Record<string, unknown>);
    return true;
  });
  t.after(() => client.close());
  return { client, responses };
}

function toolRequest(id: number | string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method: 'item/tool/call', params };
}

function deferredToolResult() {
  let resolve!: (value: Record<string, unknown>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Record<string, unknown>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('dynamic tool calls deny by default and serialize synchronous and promised handler results', async (t) => {
  const denied = dynamicToolClient(t);
  await denied.client.respondToServerRequest(toolRequest('denied'));
  assert.deepEqual(denied.responses, [{ jsonrpc: '2.0', id: 'denied', result: { contentItems: [], success: false } }]);

  const expected = { contentItems: [{ type: 'inputText', text: 'tool result' }], success: true };
  const enabled = dynamicToolClient(t, {
    approvalPolicy: { dynamicToolCall: (params) => params.async ? Promise.resolve(expected) : expected }
  });
  await enabled.client.respondToServerRequest(toolRequest(0));
  await enabled.client.respondToServerRequest(toolRequest('async', { async: true }));
  assert.deepEqual(enabled.responses, [
    { jsonrpc: '2.0', id: 0, result: expected },
    { jsonrpc: '2.0', id: 'async', result: expected }
  ]);
});

test('dynamic tools finish out of order while notifications and overlapping bidirectional IDs progress', async (t) => {
  const first = deferredToolResult();
  const second = deferredToolResult();
  const { client, responses } = dynamicToolClient(t, {
    approvalPolicy: { dynamicToolCall: (params) => params.first ? first.promise : second.promise }
  });
  const outgoing = client.request('thread/read', {});
  const outgoingId = client.nextId - 1;
  responses.length = 0;
  const received: unknown[] = [];
  client.onEvent((event) => received.push(event.method));
  const frames = [
    toolRequest(outgoingId, { first: true }),
    toolRequest('second'),
    { method: 'item/updated', params: { text: 'still streaming' } },
    { id: 'clock', method: 'currentTime/read', params: {} },
    { id: outgoingId, result: { thread: 'read result' } }
  ];
  client.handleStdout(Buffer.from(frames.map((frame) => JSON.stringify(frame)).join('\n') + '\n'));
  assert.deepEqual(await outgoing, { thread: 'read result' });
  assert.deepEqual(received, ['item/updated']);
  assert.deepEqual(responses.map((response) => response.id), ['clock']);

  second.resolve({ contentItems: [], success: true });
  await Promise.resolve();
  first.resolve({ contentItems: [], success: false });
  await Promise.resolve();
  assert.deepEqual(responses.map((response) => response.id), ['clock', 'second', outgoingId]);
  assert.deepEqual(responses[1]?.result, { contentItems: [], success: true });
  assert.deepEqual(responses[2]?.result, { contentItems: [], success: false });
});

test('dynamic tool rejection returns a correlated error and releases capacity', async (t) => {
  const { client, responses } = dynamicToolClient(t, {
    maxPendingDynamicToolCalls: 1,
    approvalPolicy: { dynamicToolCall: async () => { throw new Error('handler failed'); } }
  });
  await client.respondToServerRequest(toolRequest('rejected'));
  await client.respondToServerRequest(toolRequest('next'));
  assert.deepEqual(responses, ['rejected', 'next'].map((id) => ({
    jsonrpc: '2.0', id, error: { code: -32603, message: 'handler failed' }
  })));
});

test('dynamic tool timeout aborts the handler and retains its slot until the ignored cancellation settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const deferred = deferredToolResult();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const { client, responses } = dynamicToolClient(t, {
    maxPendingDynamicToolCalls: 1,
    dynamicToolCallTimeoutMs: 25,
    approvalPolicy: { dynamicToolCall: (_params, context) => {
      calls += 1;
      signal = context.signal;
      return deferred.promise;
    } }
  });
  const pending = client.respondToServerRequest(toolRequest('timeout'));
  await client.respondToServerRequest(toolRequest('full'));
  assert.equal(calls, 1);
  assert.match(String((responses[0]?.error as { message: string }).message), /capacity exceeded/);
  t.mock.timers.tick(25);
  await pending;
  assert.equal(signal?.aborted, true);
  assert.deepEqual(responses[1], { jsonrpc: '2.0', id: 'timeout', error: { code: -32603, message: 'Codex dynamic tool call timed out' } });
  await client.respondToServerRequest(toolRequest('still-full'));
  assert.equal(calls, 1);
  deferred.resolve({ contentItems: [], success: true });
  await Promise.resolve();
  assert.equal(responses.length, 3, 'late completion must not send a second response');
  await client.respondToServerRequest(toolRequest('available'));
  assert.equal(calls, 2);
  assert.equal(responses[3]?.id, 'available');
});

for (const shutdown of ['close', 'process-exit', 'protocol-abort'] as const) {
  test(`${shutdown} cancels dynamic handlers, suppresses late results and prevents restart`, async (t) => {
    const deferred = deferredToolResult();
    let signal: AbortSignal | undefined;
    const { client, responses } = dynamicToolClient(t, {
      maxFrameBytes: 1_024,
      approvalPolicy: { dynamicToolCall: (_params, context) => {
        signal = context.signal;
        return deferred.promise;
      } }
    });
    const pending = client.respondToServerRequest(toolRequest('late'));
    if (shutdown === 'close') await client.close();
    else if (shutdown === 'protocol-abort') client.handleStdout(Buffer.alloc(1_025, 0x78));
    else {
      const exited = once(client.child!, 'exit');
      client.child!.kill('SIGTERM');
      await exited;
    }
    await pending;
    assert.equal(signal?.aborted, true);
    if (shutdown === 'process-exit') deferred.reject(new Error('late failure'));
    else deferred.resolve({ contentItems: [], success: true });
    await Promise.resolve();
    await client.respondToServerRequest(toolRequest('after-shutdown'));
    assert.deepEqual(responses, []);
    assert.throws(() => client.start(), /client is closed/);
    await assert.rejects(client.request('thread/read', {}), /client is closed/);
  });
}

test('process exit still allows final buffered outbound responses to drain before stdio closes', async (t) => {
  const { client } = dynamicToolClient(t);
  const request = client.request('thread/read', {});
  const id = client.nextId - 1;
  // Node can emit exit before its stdout stream emits the final buffered data.
  client.child!.emit('exit', 0, null);
  client.handleStdout(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: { thread: 'final' } }) + '\n'));
  client.child!.emit('close', 0, null);
  assert.deepEqual(await request, { thread: 'final' });
});

test('turn completion wait consumes a matching notification that arrived before the listener was attached', async () => {
  const client = new CodexAppServerV2Client({ command: '/usr/bin/false' });
  client.handleStdout(Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'turn/completed',
    params: {
      threadId: 'thread-1',
      turn: {
        id: 'turn-1',
        status: 'completed',
        items: []
      }
    }
  })}\n`));

  const event = await client.waitForTurnCompletion('thread-1', 'turn-1', 50);

  assert.equal(event.method, 'turn/completed');
  assert.equal((event.params as { threadId?: string }).threadId, 'thread-1');
});

test('thread turn pagination forwards the experimental full-items cursor contract exactly', async () => {
  const client = new CodexAppServerV2Client({ command: '/usr/bin/false' });
  let request: { method: string; params: Record<string, unknown> } | null = null;
  client.request = async (method, params) => {
    request = { method, params };
    return { data: [], nextCursor: null, backwardsCursor: null };
  };

  await client.listThreadTurns('thread-1', {
    cursor: 'opaque-cursor',
    itemsView: 'full',
    limit: 48,
    sortDirection: 'asc'
  });

  assert.deepEqual(request, {
    method: 'thread/turns/list',
    params: {
      threadId: 'thread-1',
      cursor: 'opaque-cursor',
      itemsView: 'full',
      limit: 48,
      sortDirection: 'asc'
    }
  });
});

test('request failures retain typed JSON-RPC, timeout, and process-exit evidence', async () => {
  const rejected = new CodexAppServerV2Client({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)']
  });
  const rejection = rejected.request('thread/start', {});
  rejected.handleStdout(Buffer.from(`${JSON.stringify({
    jsonrpc: '2.0',
    id: rejected.nextId - 1,
    error: { code: -32602, message: 'Invalid request' }
  })}\n`));
  await assert.rejects(rejection, (error: unknown) => (
    error instanceof CodexAppServerRequestError
    && error.method === 'thread/start'
    && error.kind === 'rpc_rejection'
    && error.rpcCode === -32602
  ));
  await rejected.close();

  const timedOut = new CodexAppServerV2Client({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 10
  });
  await assert.rejects(timedOut.request('turn/start', {}), (error: unknown) => (
    error instanceof CodexAppServerRequestError
    && error.method === 'turn/start'
    && error.kind === 'timeout'
  ));
  await timedOut.close();

  const exited = new CodexAppServerV2Client({
    command: process.execPath,
    args: ['-e', 'process.exit(2)'],
    timeoutMs: 1_000
  });
  await assert.rejects(exited.request('initialize', {}), (error: unknown) => (
    error instanceof CodexAppServerRequestError
    && error.method === 'initialize'
    && error.kind === 'process_exit'
  ));
  await exited.close();
});

test('oversized App Server frames fail before JSON parsing with typed overflow evidence', async () => {
  const client = new CodexAppServerV2Client({
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    timeoutMs: 5_000,
    maxFrameBytes: 1_024
  });
  const pending = client.request('thread/turns/list', {});

  client.handleStdout(Buffer.alloc(1_025, 0x78));

  await assert.rejects(pending, (error: unknown) => (
    error instanceof CodexAppServerRequestError
    && error.method === 'thread/turns/list'
    && error.kind === 'protocol_overflow'
    && error.message === 'codex_app_server_frame_too_large'
  ));
  await client.close();
});

test('App Server notifications are retained in a bounded newest-first window', () => {
  const client = new CodexAppServerV2Client({
    command: '/usr/bin/false',
    maxNotifications: 16
  });
  for (let index = 0; index < 24; index += 1) {
    client.handleStdout(Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/updated',
      params: { index }
    })}\n`));
  }

  assert.equal(client.notifications.length, 16);
  assert.equal((client.notifications[0]?.params as { index?: number }).index, 8);
  assert.equal((client.notifications.at(-1)?.params as { index?: number }).index, 23);
});

test('App Server notification retention also enforces an aggregate byte budget', () => {
  const client = new CodexAppServerV2Client({
    command: '/usr/bin/false',
    maxNotifications: 64,
    maxNotificationBytes: 2_048
  });
  for (let index = 0; index < 12; index += 1) {
    client.handleStdout(Buffer.from(`${JSON.stringify({
      jsonrpc: '2.0',
      method: 'item/updated',
      params: { index, detail: 'x'.repeat(640) }
    })}\n`));
  }

  assert.ok(client.notifications.length < 12);
  assert.ok(client.notificationBytes <= client.maxNotificationBytes);
  assert.equal((client.notifications.at(-1)?.params as { index?: number }).index, 11);
});
