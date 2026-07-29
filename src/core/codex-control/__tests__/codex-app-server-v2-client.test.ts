import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodexAppServerRequestError,
  CodexAppServerV2Client
} from '../codex-app-server-v2-client.js';

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
