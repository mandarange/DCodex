import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  resolveTelegramBotToken,
  telegramTokenFingerprint,
  validateTelegramConfig,
  validateTelegramPrivatePairing
} from '../config.js';
import { TelegramOwnerConflictError, TelegramOwnerLock } from '../owner-lock.js';

async function tempRoot(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'sks-telegram-owner-'));
}

test('config forbids raw tokens and accepts only external/keychain references', () => {
  const invalid = validateTelegramConfig({
    schema: 'sks.telegram-config.v1',
    bot_token: '12345:secret',
    bot_token_ref: { type: 'external_file', path: 'relative' },
    paired_chat_ids: ['1'],
    paired_user_ids: ['2']
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.issues.includes('raw_bot_token_forbidden'));
  assert.ok(invalid.issues.includes('external_secret_path_must_be_absolute'));
});

test('Mini App configuration is excluded from the 6.3 package', () => {
  const validation = validateTelegramConfig({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['1'],
    paired_user_ids: ['2'],
    mini_app: { enabled: true, default_on: true, url: 'https://cockpit.example.test/app' }
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('mini_app_excluded_from_6_3_package'));
});

test('persisted pairing accepts only positive private chat and user IDs', () => {
  const groupPairing = validateTelegramConfig({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['-1001234567890'],
    paired_user_ids: ['456']
  });
  assert.equal(groupPairing.ok, false);
  assert.ok(groupPairing.issues.includes('paired_chat_ids'));

  const privatePairing = validateTelegramPrivatePairing({
    paired_chat_ids: ['123'],
    paired_user_ids: ['456']
  });
  assert.deepEqual(privatePairing, { ok: true, missing: false, issues: [] });
});

test('persisted pairing rejects multiple chat or user IDs to avoid Cartesian authorization', () => {
  const validation = validateTelegramConfig({
    schema: 'sks.telegram-config.v1',
    bot_token_ref: { type: 'external_file', path: '/tmp/telegram-token' },
    paired_chat_ids: ['123', '789'],
    paired_user_ids: ['456', '101112']
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.includes('paired_chat_ids'));
  assert.ok(validation.issues.includes('paired_user_ids'));

  assert.deepEqual(validateTelegramPrivatePairing({
    paired_chat_ids: ['123', '789'],
    paired_user_ids: ['456']
  }), {
    ok: false,
    missing: false,
    issues: ['paired_chat_ids']
  });
  assert.deepEqual(validateTelegramPrivatePairing({
    paired_chat_ids: ['123'],
    paired_user_ids: ['456', '101112']
  }), {
    ok: false,
    missing: false,
    issues: ['paired_user_ids']
  });
});

test('owner-only external secret resolves without persisting the raw token', async () => {
  const root = await tempRoot();
  const file = path.join(root, 'token');
  const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWX';
  await fsp.writeFile(file, `${token}\n`, { mode: 0o600 });
  assert.equal(await resolveTelegramBotToken({ type: 'external_file', path: file }), token);
  const fingerprint = telegramTokenFingerprint(token);
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.ok(!fingerprint.includes(token));
  await fsp.chmod(file, 0o644);
  await assert.rejects(resolveTelegramBotToken({ type: 'external_file', path: file }), /permissions_must_be_0600/);
  const target = path.join(root, 'target');
  const link = path.join(root, 'link');
  await fsp.writeFile(target, '123456789:ABCDEFGHIJKLMNOPQRSTUVWX', { mode: 0o600 });
  await fsp.symlink(target, link);
  await assert.rejects(resolveTelegramBotToken({ type: 'external_file', path: link }), /symlink_forbidden/);
});

test('one token has one live owner and a stale dead owner is reclaimed', async () => {
  const root = await tempRoot();
  const lockPath = path.join(root, 'owner.lock');
  const now = Date.now();
  const first = new TelegramOwnerLock({ lockPath, tokenFingerprint: 'sha256:one', now: () => now, pid: 101, host: 'host', isPidAlive: () => true });
  const owner = await first.acquire();
  assert.equal(owner.schema, 'sks.telegram-owner.v1');
  const second = new TelegramOwnerLock({ lockPath, tokenFingerprint: 'sha256:one', now: () => now + 100, pid: 202, host: 'host', isPidAlive: () => true });
  await assert.rejects(second.acquire(), TelegramOwnerConflictError);
  await fsp.writeFile(lockPath, JSON.stringify({ ...owner, pid: 999, heartbeat_at: new Date(now - 60_000).toISOString() }));
  const reclaim = new TelegramOwnerLock({ lockPath, tokenFingerprint: 'sha256:one', now: () => now, staleMs: 5_000, pid: 303, host: 'host', isPidAlive: () => false });
  const reclaimed = await reclaim.acquire();
  assert.equal(reclaimed.pid, 303);
  await reclaim.release();
});
