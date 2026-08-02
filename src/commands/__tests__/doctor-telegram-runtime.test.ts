import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectTelegramRemote, telegramDoctorCheckedLine } from '../doctor.js';
import type { TelegramClient } from '../../core/telegram/client.js';
import type { TelegramDoctorProbe } from '../../core/telegram/doctor.js';
import { probeTelegram, telegramSelfHealAction } from '../../core/telegram/doctor.js';
import { createTelegramLivenessReceipt, writeTelegramLivenessReceipt } from '../../core/telegram/liveness.js';

test('live getMe merges fake client result with resident receipt state', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-telegram-live-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const receiptPath = path.join(home, 'telegram-liveness.json');
  const now = Date.now();
  await writeTelegramLivenessReceipt(receiptPath, createTelegramLivenessReceipt({
    generation: 'doctor-live-fixture',
    running: false,
    tokenConfigured: true,
    botIdentityValid: true,
    getMeCheckedAt: new Date(now - 60_000).toISOString(),
    getMeLatencyMs: 42,
    pairedChatCount: 1,
    startedAt: new Date(now - 120_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    poller: pollerState(false)
  }));
  let getMeCalls = 0;
  const client = {
    async getMe() {
      getMeCalls += 1;
      return { id: 1, is_bot: true, first_name: 'fixture' };
    }
  } as unknown as TelegramClient;
  const probe = await probeTelegram({
    client,
    tokenProvider: { loadToken: async () => '123456:synthetic-token-value' },
    receiptPath,
    now
  });

  assert.equal(getMeCalls, 1);
  assert.equal(probe.getme_check_kind, 'live');
  assert.equal(probe.bot_identity_valid, true);
  assert.equal(probe.paired_chat_count, 1);
  assert.equal(probe.poller.running, false);
  assert.equal(telegramSelfHealAction(probe), 'restart_poll');
  assert.equal(telegramSelfHealAction({
    ...doctorProbe(true),
    ok: false,
    status: 'degraded',
    blockers: ['telegram_liveness_stale']
  }), 'restart_poll');
  const liveCheckedLine = telegramDoctorCheckedLine(probe) || '';
  assert.match(liveCheckedLine, /^checked: .* \(\d+ ms, live\)$/);
  t.diagnostic(liveCheckedLine);
});

test('live getMe network failure degrades without escaping the probe', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-doctor-telegram-error-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const receiptPath = path.join(home, 'telegram-liveness.json');
  const now = Date.now();
  await writeTelegramLivenessReceipt(receiptPath, createTelegramLivenessReceipt({
    generation: 'doctor-error-fixture',
    running: true,
    tokenConfigured: true,
    botIdentityValid: true,
    pairedChatCount: 1,
    startedAt: new Date(now - 1_000).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    poller: pollerState(true)
  }));
  const client = {
    async getMe() { throw new Error('synthetic_network_unavailable'); }
  } as unknown as TelegramClient;

  const probe = await probeTelegram({
    client,
    tokenProvider: { loadToken: async () => '123456:synthetic-token-value' },
    receiptPath,
    now
  });
  assert.equal(probe.status, 'degraded');
  assert.equal(probe.getme_check_kind, 'live');
  assert.equal(probe.bot_identity_valid, false);
  assert.ok(probe.blockers.some((blocker) => blocker.startsWith('telegram_getme_failed:')));
});

test('doctor --fix restart_poll uses the injected menubar relaunch and re-probes', async () => {
  const before = doctorProbe(false);
  const after = doctorProbe(true);
  let probeCalls = 0;
  let restartCalls = 0;
  let sleeps = 0;
  const result: any = await inspectTelegramRemote({
    live: true,
    fix: true,
    root: '/fixture/project',
    home: '/fixture/home',
    env: { HOME: '/fixture/home' }
  }, {
    telegramClient: {} as TelegramClient,
    telegramTokenProvider: { loadToken: async () => '123456:synthetic-token-value' },
    probeTelegramImpl: async () => (++probeCalls < 3 ? before : after),
    restartLaunchAgentImpl: (async (paths: any) => {
      restartCalls += 1;
      assert.equal(paths.home, '/fixture/home');
      return { ok: true, error: null };
    }) as any,
    telegramReprobeAttempts: 2,
    telegramReprobeDelayMs: 0,
    telegramSleepImpl: async () => { sleeps += 1; }
  });

  assert.equal(probeCalls, 3);
  assert.equal(restartCalls, 1);
  assert.equal(sleeps, 1);
  assert.equal(result.self_heal_action, 'none');
  assert.equal(result.self_heal_attempted_action, 'restart_poll');
  assert.equal(result.self_heal_outcome.attempted, true);
  assert.equal(result.self_heal_outcome.reprobe_attempts, 2);
  assert.equal(result.self_heal_outcome.recovered, true);
});

test('plain doctor remains receipt-only and report-only', async (t) => {
  const receipt = doctorProbe(true, 'receipt');
  let restartCalls = 0;
  const result = await inspectTelegramRemote({ live: false, fix: false }, {
    probeTelegramImpl: async (input) => {
      assert.equal(input.client, undefined);
      return receipt;
    },
    restartLaunchAgentImpl: (async () => {
      restartCalls += 1;
      return { ok: true };
    }) as any
  });

  assert.equal(restartCalls, 0);
  assert.equal(result.getme_check_kind, 'receipt');
  assert.equal(result.self_heal_outcome.attempted, false);
  assert.equal(result.self_heal_outcome.reason, 'report_only');
  const receiptCheckedLine = telegramDoctorCheckedLine(result);
  assert.equal(receiptCheckedLine, 'checked: 2026-08-01T00:00:00.000Z (7 ms, receipt)');
  t.diagnostic(receiptCheckedLine || 'checked: unavailable');
});

function pollerState(running: boolean) {
  return {
    schema: 'sks.telegram-poller-state.v1' as const,
    running,
    offset: 0,
    consecutive_failures: 0,
    last_poll_at: null,
    last_success_at: null,
    last_update_at: null,
    last_error: null
  };
}

function doctorProbe(running: boolean, kind: 'live' | 'receipt' = 'live'): TelegramDoctorProbe {
  return {
    schema: 'sks.telegram-doctor-probe.v1',
    ok: running,
    status: running ? 'ready' : 'degraded',
    token_configured: true,
    bot_identity_valid: true,
    getme_checked_at: '2026-08-01T00:00:00.000Z',
    getme_latency_ms: 7,
    getme_check_kind: kind,
    paired_chat_count: 1,
    audit_healthy: true,
    audit_last_error: null,
    poller: pollerState(running),
    blockers: running ? [] : ['telegram_poller_not_running'],
    checked_at: '2026-08-01T00:00:00.000Z'
  };
}
