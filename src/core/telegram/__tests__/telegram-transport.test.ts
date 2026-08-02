import { ISOLATED_TEST_HOME } from '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TelegramClient, TelegramApiError } from '../client.js';
import { TelegramPoller } from '../poller.js';
import { InMemoryTelegramAccessStore } from '../access.js';
import { TelegramConfirmationStore } from '../confirmation.js';
import { createTelegramCommandDispatcher, telegramCommand } from '../../commands/telegram-command.js';
import { createTelegramLivenessReceipt, readTelegramLivenessReceipt, writeTelegramLivenessReceipt } from '../liveness.js';
import { readTelegramState, telegramPrivatePaths, updateTelegramState } from '../keychain.js';
import { probeTelegram, telegramSelfHealAction } from '../doctor.js';
import { redactedChatActor } from '../redaction.js';
import type { CommandContractV3 } from '../../safety/command-contract/types.js';

const SYNTHETIC_TOKEN = '123456:telegram_test_secret_abcdefghijklmnop';

test('Bot API fixture validates getMe, polling shape, offset and sendMessage without exposing token', async () => {
  const requests: Array<{ method: string; httpMethod: string | undefined; body: Record<string, unknown> }> = [];
  const fixtureFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = url.pathname.split('/').at(-1) ?? '';
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    requests.push({ method, httpMethod: init?.method, body });
    if (method === 'getMe') {
      return new Response(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, first_name: 'SKS' } }));
    }
    if (method === 'getUpdates') {
      return new Response(JSON.stringify({ ok: true, result: [{ update_id: 41 }, { update_id: 42 }] }));
    }
    if (method === 'sendMessage') {
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: 1, date: 1, chat: { id: 9, type: 'private' }, text: body.text }
      }));
    }
    throw new Error(`unexpected Telegram fixture method:${method}`);
  };
  const client = new TelegramClient({
    tokenProvider: { loadToken: async () => SYNTHETIC_TOKEN },
    fetch: fixtureFetch
  });
  assert.equal((await client.getMe()).is_bot, true);
  assert.equal((await client.getUpdates({ offset: 40, timeoutSeconds: 30 })).length, 2);
  assert.equal((await client.sendMessage(9, 'hello')).text, 'hello');
  assert.deepEqual(requests, [
    { method: 'getMe', httpMethod: 'POST', body: {} },
    { method: 'getUpdates', httpMethod: 'POST', body: { offset: 40, timeout: 30, allowed_updates: ['message'] } },
    { method: 'sendMessage', httpMethod: 'POST', body: { chat_id: 9, text: 'hello' } }
  ]);
  assert.equal(JSON.stringify(requests).includes(SYNTHETIC_TOKEN), false);
});

test('API failure preserves Telegram fields but redacts token', async () => {
  const client = new TelegramClient({
    tokenProvider: { loadToken: async () => '123:super-secret' },
    fetch: async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict at /bot123:super-secret/getUpdates' }), { status: 409 })
  });
  await assert.rejects(client.getUpdates({ offset: 0, timeoutSeconds: 1 }), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.equal(error.code, 409);
    assert.doesNotMatch(error.message, /super-secret/);
    return true;
  });
});

test('poller advances offset monotonically and cancellation stops bounded retries', async () => {
  const offsets: number[] = [];
  let calls = 0;
  const fake = {
    async getUpdates(input: { offset: number }) {
      offsets.push(input.offset);
      calls += 1;
      if (calls === 1) return [{ update_id: 7 }, { update_id: 6 }];
      throw new TelegramApiError('temporary');
    }
  } as unknown as TelegramClient;
  const handled: number[] = [];
  let poller: TelegramPoller;
  poller = new TelegramPoller({
    client: fake,
    handleUpdate: async (update) => { handled.push(update.update_id); },
    minBackoffMs: 100,
    maxBackoffMs: 100,
    sleep: async () => poller.stop()
  });
  await poller.start();
  assert.deepEqual(handled, [6, 7]);
  assert.deepEqual(offsets, [0, 8]);
  assert.equal(poller.snapshot().offset, 8);
  assert.equal(poller.snapshot().running, false);
});

test('pairing and destructive confirmation are atomic, expiring, actor-bound and single-use', async () => {
  let now = 1_000_000;
  const clock = { now: () => now };
  const access = new InMemoryTelegramAccessStore(clock);
  const pair = await access.issuePairingCode(30_000);
  assert.equal(await access.pairAtomically({ code: pair.code, chatId: 10, senderId: 20, chatType: 'private' }), true);
  assert.equal(await access.pairAtomically({ code: pair.code, chatId: 11, senderId: 21, chatType: 'private' }), false);
  assert.equal(await access.authorized(10, 20), true);
  const confirmations = new TelegramConfirmationStore({ clock, ttlMs: 15_000 });
  const issued = confirmations.issue({ chatId: 10, senderId: 20, command: 'gates', input: { target: 'affected' } });
  assert.equal(confirmations.consume(issued.nonce, 10, 21), null);
  assert.equal(confirmations.consume(issued.nonce, 10, 20)?.command, 'gates');
  assert.equal(confirmations.consume(issued.nonce, 10, 20), null);
  const expired = confirmations.issue({ chatId: 10, senderId: 20, command: 'gates', input: {} });
  now += 16_000;
  assert.equal(confirmations.consume(expired.nonce, 10, 20), null);
  assert.notEqual(redactedChatActor(10, 20), redactedChatActor(10, 21));
  assert.notEqual(redactedChatActor(10, 20), '10:20');
});

test('dispatcher uses injected typed contract and never accepts shell strings or R3', async () => {
  const calls: string[][] = [];
  const contract: CommandContractV3 = {
    schema: 'sks.command-contract.v3', name: 'status', description: 'status', maturity: 'stable',
    read_only: true, risk: 'R0', latency: 'fast', supports_json: true, remote_allowed: true,
    input_schema: { type: 'object', properties: { json: { type: 'boolean' } }, additionalProperties: false },
    argv_builder: (input: any) => ['status', ...(input.json ? ['--json'] : [])], required_capabilities: []
  };
  const dispatcher = createTelegramCommandDispatcher({ executeArgv: async (argv) => { calls.push([...argv]); return { ok: true }; } }, name => name === 'status' ? contract : null);
  const prepared = dispatcher.prepare({ name: 'status', input: { json: true } });
  assert.equal(prepared.ok && prepared.confirmation_required, false);
  if (prepared.ok && !prepared.confirmation_required) await prepared.execute();
  assert.deepEqual(calls, [['status', '--json']]);
  assert.deepEqual(dispatcher.prepare({ name: 'status; rm -rf /', input: {} }), { ok: false, error: 'telegram_command_not_whitelisted' });
});

test('effectful handler failure does not replay a claimed update', async () => {
  const offsets: number[] = [];
  let poller: TelegramPoller;
  const fake = {
    async getUpdates(input: { offset: number }) {
      offsets.push(input.offset);
      if (offsets.length === 1) return [{ update_id: 5 }];
      throw new TelegramApiError('temporary');
    }
  } as unknown as TelegramClient;
  poller = new TelegramPoller({
    client: fake,
    handleUpdate: async () => { throw new Error('reply_failed_after_effect'); },
    sleep: async () => poller.stop()
  });
  await poller.start();
  assert.deepEqual(offsets, [0]);
  assert.equal(poller.snapshot().offset, 6);
});

test('liveness receipt is owner-only, doctor-readable and contains no token', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-telegram-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'liveness.json');
  const now = Date.now();
  const receipt = createTelegramLivenessReceipt({
    generation: 'generation-1234', running: true, tokenConfigured: true,
    botIdentityValid: true, pairedChatCount: 1, startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    poller: {
      schema: 'sks.telegram-poller-state.v1', running: true, offset: 9,
      consecutive_failures: 0, last_poll_at: new Date(now).toISOString(),
      last_success_at: new Date(now).toISOString(), last_update_at: null, last_error: null
    }
  });
  await writeTelegramLivenessReceipt(file, receipt);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(file, 'utf8')).includes(SYNTHETIC_TOKEN), false);
  const read = await readTelegramLivenessReceipt(file, now);
  assert.equal(read.ok && read.receipt.poller.offset, 9);
  assert.equal(read.ok && read.receipt.getme_checked_at, new Date(now).toISOString());
  assert.equal(read.ok && read.receipt.getme_latency_ms, 0);
  const doctor = await probeTelegram({ receiptPath: file, now });
  assert.equal(doctor.ok, true);
});

test('audit failure in liveness is a Doctor blocker with operator repair guidance', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-telegram-audit-failure-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'liveness.json');
  const now = Date.now();
  await writeTelegramLivenessReceipt(file, createTelegramLivenessReceipt({
    generation: 'generation-audit-failure', running: false, tokenConfigured: true,
    botIdentityValid: true, pairedChatCount: 1, startedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(), auditHealthy: false,
    auditLastError: 'telegram_audit_unavailable',
    poller: {
      schema: 'sks.telegram-poller-state.v1', running: false, offset: 9,
      consecutive_failures: 0, last_poll_at: new Date(now).toISOString(),
      last_success_at: new Date(now).toISOString(), last_update_at: null,
      last_error: 'telegram_audit_unavailable'
    }
  }));
  const doctor = await probeTelegram({ receiptPath: file, now });
  assert.equal(doctor.ok, false);
  assert.equal(doctor.audit_healthy, false);
  assert.equal(doctor.audit_last_error, 'telegram_audit_unavailable');
  assert.ok(doctor.blockers.includes('telegram_audit_unavailable'));
  assert.equal(telegramSelfHealAction(doctor), 'operator_repair_audit');
});

test('CLI setup, pairing, and state bookkeeping never spawn PATH-shadowed security or expose the token', async (t) => {
  const home = await fs.mkdtemp(path.join(ISOLATED_TEST_HOME, 'telegram-cli-storage-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, 'bin');
  const invokedMarker = path.join(home, 'security-invoked');
  await fs.mkdir(bin, { mode: 0o700 });
  await fs.writeFile(
    path.join(bin, 'security'),
    `#!/bin/sh\nprintf invoked > ${JSON.stringify(invokedMarker)}\nexit 91\n`,
    { mode: 0o700 }
  );

  const priorEnvironment = {
    HOME: process.env.HOME,
    SKS_HOME: process.env.SKS_HOME,
    PATH: process.env.PATH,
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    SKS_TELEGRAM_BOT_TOKEN: process.env.SKS_TELEGRAM_BOT_TOKEN
  };
  const priorExitCode = process.exitCode;
  const priorLog = console.log;
  const logs: string[] = [];
  let setup: { ok: boolean; storage: string } | undefined;
  let pair: { ok: boolean; code: string } | undefined;
  process.exitCode = undefined;
  console.log = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
  try {
    process.env.HOME = home;
    delete process.env.SKS_HOME;
    process.env.PATH = `${bin}${path.delimiter}${priorEnvironment.PATH ?? ''}`;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.SKS_TELEGRAM_BOT_TOKEN;

    setup = await telegramCommand(['setup', '--token-stdin', '--json'], {
      readTokenStdin: async () => SYNTHETIC_TOKEN,
      verifyToken: async (token) => { assert.equal(token, SYNTHETIC_TOKEN); }
    }) as { ok: boolean; storage: string };
    pair = await telegramCommand(['pair', '--json']) as { ok: boolean; code: string };

    const paths = telegramPrivatePaths({ HOME: home });
    await updateTelegramState((state) => ({
      ...state,
      chats: [{ chat_id: 42, sender_id: 84, paired_at: '2026-08-01T00:00:00.000Z' }]
    }), paths);
  } finally {
    restoreEnvironment(priorEnvironment);
    console.log = priorLog;
    process.exitCode = priorExitCode;
  }

  assert.equal(setup?.ok, true);
  assert.equal(setup?.storage, 'user_secret_file');
  assert.equal(pair?.ok, true);
  assert.match(pair?.code ?? '', /^\d{6}-[A-F0-9]{4}$/);
  const state = await readTelegramState(telegramPrivatePaths({ HOME: home }));
  assert.equal(state.schema, 'sks.telegram-state.v1');
  assert.equal(state.chats.length, 1);
  assert.equal(JSON.stringify({ setup, pair, state, logs }).includes(SYNTHETIC_TOKEN), false);
  await assert.rejects(fs.access(invokedMarker), { code: 'ENOENT' });
});

test('native CLI gateway validates typed contracts and executes argv without a shell string', async () => {
  const calls: string[][] = [];
  const dependency = {
    readCommandStdin: async () => ({ name: 'status', input: { json: true } }),
    executionAdapter: {
      executeArgv: async (argv: readonly string[]) => {
        calls.push([...argv]);
        return { ok: true };
      }
    }
  };
  const prepared = await telegramCommand(['prepare', '--stdin-json', '--json'], dependency) as {
    allowed: boolean; confirmation_required: boolean;
  };
  assert.equal(prepared.allowed, true);
  assert.equal(prepared.confirmation_required, false);
  const executed = await telegramCommand(['execute', '--stdin-json', '--json'], dependency) as {
    ok: boolean; output: unknown;
  };
  assert.equal(executed.ok, true);
  assert.deepEqual(calls, [['status', '--json']]);
});

function restoreEnvironment(environment: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}
