import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TELEGRAM_STATUS_BOT_MAX_RETRIES,
  TELEGRAM_STATUS_BOT_REQUEST_TIMEOUT_MS,
  TELEGRAM_STATUS_LIVE_PROBE_BUDGET_MS,
  TELEGRAM_STATUS_NATIVE_DEADLINE_MS,
  TELEGRAM_STATUS_TOKEN_LOOKUP_TIMEOUT_MS,
  telegramLiveProbeStatus,
  telegramPairingReadiness
} from '../../commands/telegram-command.js';
import { TelegramBotApiError } from '../bot-api.js';

test('status reports a persisted group pairing as invalid and not ready', () => {
  const readiness = telegramPairingReadiness({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['-1001234567890'],
    paired_user_ids: ['456']
  });

  assert.deepEqual(readiness, {
    pairing_valid: false,
    pairing_issues: ['paired_chat_ids'],
    blocker: 'telegram_pairing_invalid:paired_chat_ids'
  });
});

test('status keeps a positive private pairing ready', () => {
  const readiness = telegramPairingReadiness({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['123'],
    paired_user_ids: ['456']
  });

  assert.deepEqual(readiness, {
    pairing_valid: true,
    pairing_issues: [],
    blocker: null
  });
});

test('status exposes long-poll readiness and distinguishes webhook, auth, and probe blockers', () => {
  assert.deepEqual(telegramLiveProbeStatus({
    bot: { id: '99', username: 'sks_fixture_bot' },
    webhook_configured: false,
    pending_update_count: 2
  }), {
    bot_verified: true,
    bot: { id: '99', username: 'sks_fixture_bot' },
    webhook_configured: false,
    pending_update_count: 2,
    long_poll_ready: true,
    telegram_probe_error: null,
    blocker: null
  });

  const webhook = telegramLiveProbeStatus({
    bot: { id: '99', username: 'sks_fixture_bot' },
    webhook_configured: true,
    pending_update_count: 4
  });
  assert.equal(webhook.long_poll_ready, false);
  assert.equal(webhook.blocker, 'telegram_webhook_conflict');

  const auth = telegramLiveProbeStatus(null, new TelegramBotApiError('getMe', 401, 'Unauthorized'));
  assert.equal(auth.telegram_probe_error, 'telegram_bot_auth_failed');
  assert.equal(auth.blocker, 'telegram_bot_auth_failed');

  const transport = telegramLiveProbeStatus(null, new TelegramBotApiError('getMe', 0, 'telegram_api_transport_failed'));
  assert.equal(transport.telegram_probe_error, 'telegram_bot_probe_failed');
  assert.equal(transport.blocker, 'telegram_bot_probe_failed');
});

test('status live Bot API checks stay inside the native caller deadline without retries', () => {
  assert.equal(TELEGRAM_STATUS_BOT_MAX_RETRIES, 0);
  assert.equal(
    TELEGRAM_STATUS_LIVE_PROBE_BUDGET_MS,
    TELEGRAM_STATUS_TOKEN_LOOKUP_TIMEOUT_MS + TELEGRAM_STATUS_BOT_REQUEST_TIMEOUT_MS * 2
  );
  assert.ok(TELEGRAM_STATUS_LIVE_PROBE_BUDGET_MS < TELEGRAM_STATUS_NATIVE_DEADLINE_MS);
  assert.ok(TELEGRAM_STATUS_NATIVE_DEADLINE_MS - TELEGRAM_STATUS_LIVE_PROBE_BUDGET_MS >= 4_000);
});

test('status fails closed on legacy multi-ID pairing and directs setup repair', () => {
  const readiness = telegramPairingReadiness({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['123', '789'],
    paired_user_ids: ['456', '101112']
  });

  assert.deepEqual(readiness, {
    pairing_valid: false,
    pairing_issues: ['paired_chat_ids', 'paired_user_ids'],
    blocker: 'telegram_pairing_multiple_ids_requires_setup'
  });
});
