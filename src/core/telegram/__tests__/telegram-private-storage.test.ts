import { ISOLATED_TEST_HOME } from '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  TELEGRAM_STATE_SCHEMA,
  emptyTelegramState,
  issueTelegramPairingCode,
  readStoredTelegramToken,
  readTelegramState,
  resolveTelegramBotToken,
  storeTelegramToken,
  telegramPrivatePaths,
  updateTelegramState,
  writeTelegramState,
  type TelegramPrivatePaths
} from '../keychain.js';

const FILE_TOKEN = '100001:file_token_abcdefghijklmnopqrstuvwxyz';
const REPLACEMENT_TOKEN = '100002:replacement_token_abcdefghijklmnop';
const PRIMARY_ENV_TOKEN = '100003:primary_env_token_abcdefghijklmnop';
const SECONDARY_ENV_TOKEN = '100004:secondary_env_token_abcdefghijklmnop';

test('token replacement is atomic and 0600, with primary env then secondary env then file resolution', async (t) => {
  const { home, paths } = await privateFixture(t, 'telegram-token-');

  await storeTelegramToken(FILE_TOKEN, { paths });
  const first = await fs.stat(paths.tokenPath);
  assert.equal(paths.tokenPath, path.join(home, '.sneakoscope', 'secrets', 'telegram-bot-token'));
  assert.equal(first.mode & 0o777, 0o600);

  await storeTelegramToken(REPLACEMENT_TOKEN, { paths });
  const second = await fs.stat(paths.tokenPath);
  assert.equal(second.mode & 0o777, 0o600);
  assert.notEqual(second.ino, first.ino, 'replacement must publish a new inode instead of truncating in place');
  assert.equal(await fs.readFile(paths.tokenPath, 'utf8'), `${REPLACEMENT_TOKEN}\n`);
  assert.deepEqual(await fs.readdir(paths.secretDir), ['telegram-bot-token']);

  assert.deepEqual(await resolveTelegramBotToken({
    env: {
      TELEGRAM_BOT_TOKEN: PRIMARY_ENV_TOKEN,
      SKS_TELEGRAM_BOT_TOKEN: SECONDARY_ENV_TOKEN
    },
    paths
  }), { token: PRIMARY_ENV_TOKEN, source: 'env', env_var: 'TELEGRAM_BOT_TOKEN' });
  assert.deepEqual(await resolveTelegramBotToken({
    env: { SKS_TELEGRAM_BOT_TOKEN: SECONDARY_ENV_TOKEN },
    paths
  }), { token: SECONDARY_ENV_TOKEN, source: 'env', env_var: 'SKS_TELEGRAM_BOT_TOKEN' });
  assert.deepEqual(await resolveTelegramBotToken({ env: {}, paths }), {
    token: REPLACEMENT_TOKEN,
    source: 'user_secret_file'
  });
  await assert.rejects(resolveTelegramBotToken({
    env: { TELEGRAM_BOT_TOKEN: 'invalid-primary', SKS_TELEGRAM_BOT_TOKEN: SECONDARY_ENV_TOKEN },
    paths
  }), /telegram_token_invalid/);
});

test('an existing owner-owned 0755 sks home is accepted while private children stay strict', async (t) => {
  const { paths } = await privateFixture(t, 'telegram-root-mode-');
  await fs.mkdir(paths.sksHome, { mode: 0o755 });
  await fs.chmod(paths.sksHome, 0o755);
  const rootBefore = await fs.stat(paths.sksHome);
  assert.equal(rootBefore.mode & 0o777, 0o755);
  if (typeof process.getuid === 'function') assert.equal(rootBefore.uid, process.getuid());

  await storeTelegramToken(FILE_TOKEN, { paths });
  await issueTelegramPairingCode({ paths, now: 1_000_000 });

  assert.equal((await fs.stat(paths.secretDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(paths.stateDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(paths.tokenPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.statePath)).mode & 0o777, 0o600);
});

test('a group- or other-writable sks home is rejected', async (t) => {
  const { paths } = await privateFixture(t, 'telegram-root-writable-');
  await fs.mkdir(paths.sksHome, { mode: 0o700 });
  await fs.chmod(paths.sksHome, 0o777);
  await assert.rejects(storeTelegramToken(FILE_TOKEN, { paths }), /telegram_sks_home_group_or_other_writable/);
  await assert.rejects(issueTelegramPairingCode({ paths, now: 1_000_000 }), /telegram_sks_home_group_or_other_writable/);
});

test('token and pairing-state writes reject symlink leaves without changing their targets', async (t) => {
  if (process.platform === 'win32') {
    t.skip('symlink fixture requires POSIX test permissions');
    return;
  }
  const { home, paths } = await privateFixture(t, 'telegram-symlink-');
  await fs.mkdir(paths.sksHome, { mode: 0o700 });
  await fs.mkdir(paths.secretDir, { mode: 0o700 });
  await fs.mkdir(paths.stateDir, { mode: 0o700 });

  const tokenTarget = path.join(home, 'outside-token');
  const stateTarget = path.join(home, 'outside-state');
  await fs.writeFile(tokenTarget, 'unchanged-token-target\n', { mode: 0o600 });
  await fs.writeFile(stateTarget, 'unchanged-state-target\n', { mode: 0o600 });
  await fs.symlink(tokenTarget, paths.tokenPath);
  await fs.symlink(stateTarget, paths.statePath);

  await assert.rejects(storeTelegramToken(FILE_TOKEN, { paths }), /telegram_bot_token_not_regular/);
  await assert.rejects(issueTelegramPairingCode({ paths, now: 1_000_000 }), /telegram_state_not_regular/);
  assert.equal(await fs.readFile(tokenTarget, 'utf8'), 'unchanged-token-target\n');
  assert.equal(await fs.readFile(stateTarget, 'utf8'), 'unchanged-state-target\n');
});

test('token and state reads reject a safely simulated owner mismatch', async (t) => {
  if (typeof process.getuid !== 'function') {
    t.skip('owner checks require a POSIX uid');
    return;
  }
  const { paths } = await privateFixture(t, 'telegram-owner-');
  await storeTelegramToken(FILE_TOKEN, { paths });
  await issueTelegramPairingCode({ paths, now: 1_000_000 });

  const descriptor = Object.getOwnPropertyDescriptor(process, 'getuid');
  assert.ok(descriptor);
  const actualUid = process.getuid();
  Object.defineProperty(process, 'getuid', {
    ...descriptor,
    value: () => actualUid + 1
  });
  try {
    await assert.rejects(readStoredTelegramToken(paths), /owner_mismatch/);
    await assert.rejects(readTelegramState(paths), /owner_mismatch/);
  } finally {
    Object.defineProperty(process, 'getuid', descriptor);
  }

  assert.equal(await readStoredTelegramToken(paths), FILE_TOKEN);
  assert.equal((await readTelegramState(paths)).schema, TELEGRAM_STATE_SCHEMA);
});

test('pairing state round-trips through the shared private root schema and canonical path', async (t) => {
  const { home, paths } = await privateFixture(t, 'telegram-state-');
  const fixture = {
    ...emptyTelegramState(),
    chats: [{ chat_id: 7, sender_id: 8, paired_at: '2026-08-01T00:00:00.000Z' }]
  };
  await writeTelegramState(fixture, paths);
  assert.deepEqual(await readTelegramState(paths), fixture);

  const issued = await issueTelegramPairingCode({ paths, now: 1_000_000, ttlMs: 30_000 });
  const updated = await updateTelegramState((state) => ({
    ...state,
    confirmations: [{
      nonce: 'fixture-confirmation-nonce',
      chat_id: 7,
      sender_id: 8,
      command: 'status',
      input_json: '{}',
      expires_at: '2026-08-01T00:01:00.000Z'
    }]
  }), paths);
  const roundTripped = await readTelegramState(paths);
  const rawText = await fs.readFile(paths.statePath, 'utf8');

  assert.equal(paths.statePath, path.join(home, '.sneakoscope', 'state', 'telegram.json'));
  assert.equal((await fs.stat(paths.statePath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(paths.stateDir)).mode & 0o777, 0o700);
  assert.equal(roundTripped.schema, 'sks.telegram-state.v1');
  assert.deepEqual(roundTripped, updated);
  assert.deepEqual(JSON.parse(rawText), roundTripped);
  assert.equal(roundTripped.pairing?.code, issued.code);
  assert.equal(roundTripped.pairing?.used, false);
  assert.equal(rawText.includes(FILE_TOKEN), false);
  await assert.rejects(fs.access(paths.stateLockPath), { code: 'ENOENT' });
});

async function privateFixture(
  t: TestContext,
  prefix: string
): Promise<{ home: string; paths: TelegramPrivatePaths }> {
  const home = await fs.mkdtemp(path.join(ISOLATED_TEST_HOME, prefix));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, paths: telegramPrivatePaths({ HOME: home }) };
}
