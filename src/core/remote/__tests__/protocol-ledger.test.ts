import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  RemoteAuditLog,
  RemoteCommandLedger,
  RemoteEventJournal
} from '../audit-idempotency.js';
import {
  RemoteProtocolError,
  runRemoteWorkerJsonl,
  validateRemoteCommandEnvelope,
  validateWorkerRequest,
  workerSuccessResponse
} from '../protocol.js';
import type { RemoteCommandEnvelopeV1, RemoteCommandReceiptV1, WorkerRequestV1 } from '../types.js';

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sks-remote-ledger-'));
}

function envelope(overrides: Partial<RemoteCommandEnvelopeV1> = {}): RemoteCommandEnvelopeV1 {
  const now = Date.now();
  return {
    schema: 'sks.remote-command.v2',
    command_id: 'command-1',
    issued_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(),
    actor: 'remote-owner',
    machine_id: 'mac',
    project_id: 'project',
    session_id: 'session-1',
    kind: 'read',
    risk: 'R0',
    payload: {},
    idempotency_key: 'idem-1',
    ...overrides
  };
}

test('durable idempotency returns the original receipt and rejects key reuse with different input', async () => {
  const root = await tempRoot();
  const ledger = new RemoteCommandLedger(path.join(root, 'commands.json'));
  const command = envelope();
  assert.equal((await ledger.claim(command)).status, 'claimed');
  assert.equal((await ledger.claim(command)).status, 'duplicate_inflight');
  const receipt: RemoteCommandReceiptV1 = {
    schema: 'sks.remote-command-receipt.v1',
    command_id: command.command_id,
    idempotency_key: command.idempotency_key,
    machine_id: command.machine_id,
    project_id: command.project_id,
    session_id: command.session_id,
    kind: command.kind,
    status: 'completed',
    side_effect_applied: false,
    completed_at: new Date().toISOString(),
    result: { ok: true }
  };
  await ledger.complete(command, receipt);
  const duplicate = await ledger.claim(command);
  assert.equal(duplicate.status, 'duplicate_completed');
  if (duplicate.status === 'duplicate_completed') assert.deepEqual(duplicate.receipt.result, { ok: true });
  assert.equal((await ledger.claim(envelope({ command_id: 'command-2' }))).status, 'idempotency_conflict');
  assert.equal((await ledger.claim(envelope({ idempotency_key: 'idem-2' }))).status, 'idempotency_conflict');
});

test('bounded event cursor reports a retention gap instead of silently skipping events', async () => {
  const root = await tempRoot();
  const events = new RemoteEventJournal(path.join(root, 'events.json'), { maxEvents: 8 });
  for (let index = 0; index < 12; index += 1) {
    await events.append({ type: 'fixture', session_id: 'session-1', command_id: null, summary: { index } });
  }
  const gap = await events.watch(0);
  assert.equal(gap.cursor.gap, true);
  assert.equal(gap.events.length, 0);
  const current = await events.watch(gap.cursor.first_available_seq - 1, 'session-1');
  assert.equal(current.cursor.gap, false);
  assert.equal(current.events.length, 8);
});

test('recent event reads filter and bound retained events in one journal snapshot', async () => {
  const root = await tempRoot();
  const events = new RemoteEventJournal(path.join(root, 'events.json'), { maxEvents: 8 });
  for (let index = 0; index < 10; index += 1) {
    await events.append({
      type: 'fixture',
      session_id: index % 2 === 0 ? 'session-1' : 'session-2',
      command_id: null,
      summary: { index }
    });
  }

  const recent = await events.recent('session-1', 2);
  assert.deepEqual(recent.map((event) => event.summary.index), [6, 8]);
});

test('event journal appends a bounded batch with contiguous sequence ownership', async () => {
  const root = await tempRoot();
  const events = new RemoteEventJournal(path.join(root, 'events.json'), { maxEvents: 8 });
  const created = await events.appendMany(Array.from({ length: 10 }, (_, index) => ({
    type: 'fixture',
    session_id: 'session-1',
    command_id: null,
    summary: { index, secret: `token-${index}` }
  })));

  assert.deepEqual(created.map((event) => event.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const recent = await events.recent('session-1', 8);
  assert.deepEqual(recent.map((event) => event.seq), [3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(recent.map((event) => event.summary.index), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test('protocol enforces exact typed requests, risk-kind mapping, expiry, and R3 denial', () => {
  const now = Date.now();
  assert.throws(() => validateWorkerRequest({ schema: 'sks.remote-worker.request.v1', id: '1', type: 'hello', extra: true }), RemoteProtocolError);
  assert.deepEqual(validateWorkerRequest({
    schema: 'sks.remote-worker.request.v1', id: 'cancel-prepare', type: 'prepare_cancel', session_id: 'session-1', command_id: 'command-1'
  }), {
    schema: 'sks.remote-worker.request.v1', id: 'cancel-prepare', type: 'prepare_cancel', session_id: 'session-1', command_id: 'command-1'
  });
  assert.throws(() => validateRemoteCommandEnvelope(envelope({ kind: 'cancel', risk: 'R1' }), now), /command_risk_kind_mismatch/);
  assert.throws(() => validateRemoteCommandEnvelope({ ...envelope(), risk: 'R3' }, now), /command_risk_invalid_or_r3_denied/);
  assert.throws(() => validateRemoteCommandEnvelope({ ...envelope(), actor: 'legacy-owner' }, now), /command_actor_invalid/);
  assert.throws(() => validateRemoteCommandEnvelope(envelope({ payload: { view: 'arbitrary-shell' } }), now), /command_read_view_unsupported/);
  assert.equal(validateRemoteCommandEnvelope(envelope({ payload: { view: 'proof' } }), now).payload.view, 'proof');
  assert.throws(() => validateRemoteCommandEnvelope(envelope({ expires_at: new Date(now - 1).toISOString() }), now), /command_expired/);
  assert.throws(() => validateRemoteCommandEnvelope(envelope({
    issued_at: new Date(now + 20_000).toISOString(),
    expires_at: new Date(now + 10_000).toISOString()
  }), now), /command_expiry_precedes_issue/);
});

test('JSONL protocol processes requests sequentially and caps oversized responses', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString('utf8'); });
  const order: string[] = [];
  const run = runRemoteWorkerJsonl({
    input,
    output,
    maxResponseBytes: 4_096,
    handle: async (request) => {
      order.push(`start:${request.id}`);
      if (request.id === 'first') await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(`end:${request.id}`);
      return workerSuccessResponse(request, request.id === 'second' ? { huge: 'x'.repeat(8_000) } : { id: request.id });
    }
  });
  const requests: WorkerRequestV1[] = [
    { schema: 'sks.remote-worker.request.v1', id: 'first', type: 'hello' },
    { schema: 'sks.remote-worker.request.v1', id: 'second', type: 'list_sessions' }
  ];
  input.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  await run;
  assert.deepEqual(order, ['start:first', 'end:first', 'start:second', 'end:second']);
  const responses = text.trim().split('\n').map((line) => JSON.parse(line) as { id: string; ok: boolean; error?: { code?: string } });
  assert.equal(responses[0]?.ok, true);
  assert.equal(responses[1]?.error?.code, 'response_output_limit_exceeded');
});

test('audit redacts raw input, secrets, and owner nonces', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'audit.jsonl');
  await new RemoteAuditLog(file).append({
    raw_input: 'do something private',
    owner_nonce: 'nonce-value',
    token: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    safe: 'status'
  });
  const text = await fsp.readFile(file, 'utf8');
  assert.equal(text.includes('do something private'), false);
  assert.equal(text.includes('nonce-value'), false);
  assert.equal(text.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ'), false);
  assert.equal(text.includes('status'), true);
});
