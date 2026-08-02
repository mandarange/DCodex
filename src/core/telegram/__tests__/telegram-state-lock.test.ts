import { ISOLATED_TEST_HOME } from '../../__tests__/helpers/isolated-test-home.js';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  issueTelegramPairingCode,
  telegramPrivatePaths,
  type TelegramPrivatePaths
} from '../keychain.js';

test('a live same-process state lock is never reaped', async (t) => {
  const { paths } = await privateFixture(t, 'telegram-live-lock-');
  await writeStateLockFixture(paths, process.pid, '11111111-1111-4111-8111-111111111111');

  await assert.rejects(
    issueTelegramPairingCode({ paths, now: 1_000_000 }),
    /telegram_state_lock_timeout/
  );
  const owner = JSON.parse(await fs.readFile(paths.stateLockPath, 'utf8')) as { pid: number };
  assert.equal(owner.pid, process.pid);
});

test('a state lock whose recorded process is demonstrably dead is recovered', async (t) => {
  const { paths } = await privateFixture(t, 'telegram-dead-lock-');
  await writeStateLockFixture(paths, 2_147_483_647, '22222222-2222-4222-8222-222222222222');

  const pairing = await issueTelegramPairingCode({ paths, now: 1_000_000 });
  assert.match(pairing.code, /^\d{6}-[0-9A-F]{4}$/);
  await assert.rejects(fs.access(paths.stateLockPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${paths.stateLockPath}.reclaim`), { code: 'ENOENT' });
});

test('a reused live PID with a different process start identity is recovered', async (t) => {
  if (process.platform === 'win32') return t.skip('process start identity requires POSIX ps');
  const { paths } = await privateFixture(t, 'telegram-reused-pid-lock-');
  await writeStateLockFixture(
    paths,
    process.pid,
    '44444444-4444-4444-8444-444444444444',
    1
  );
  const pairing = await issueTelegramPairingCode({ paths, now: 1_000_000 });
  assert.match(pairing.code, /^\d{6}-[0-9A-F]{4}$/);
});

test('unsafe or malformed state locks are refused without replacement', async (t) => {
  if (process.platform === 'win32') return t.skip('lock safety fixture requires POSIX permissions and symlinks');
  const { home, paths } = await privateFixture(t, 'telegram-unsafe-lock-');
  await fs.mkdir(paths.sksHome, { mode: 0o700 });
  await fs.mkdir(paths.stateDir, { mode: 0o700 });
  const decoy = path.join(home, 'lock-decoy');
  await fs.writeFile(decoy, '{}\n', { mode: 0o600 });
  await fs.symlink(decoy, paths.stateLockPath);
  await assert.rejects(issueTelegramPairingCode({ paths, now: 1_000_000 }), /telegram_state_lock_unsafe_type/);
  assert.equal((await fs.lstat(paths.stateLockPath)).isSymbolicLink(), true);

  await fs.unlink(paths.stateLockPath);
  await writeStateLockFixture(paths, 2_147_483_647, '33333333-3333-4333-8333-333333333333');
  await fs.chmod(paths.stateLockPath, 0o644);
  await assert.rejects(issueTelegramPairingCode({ paths, now: 1_000_000 }), /telegram_state_lock_mode_not_0600/);
  assert.equal((await fs.stat(paths.stateLockPath)).mode & 0o777, 0o644);

  await fs.unlink(paths.stateLockPath);
  await fs.writeFile(paths.stateLockPath, '{malformed\n', { mode: 0o600 });
  await assert.rejects(issueTelegramPairingCode({ paths, now: 1_000_000 }), /telegram_state_lock_owner_record_invalid/);
  assert.equal(await fs.readFile(paths.stateLockPath, 'utf8'), '{malformed\n');
});

async function writeStateLockFixture(
  paths: TelegramPrivatePaths,
  pid: number,
  token: string,
  processStartSeconds?: number
): Promise<void> {
  await fs.mkdir(paths.sksHome, { recursive: true, mode: 0o700 });
  await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(paths.stateDir, 0o700);
  await fs.writeFile(paths.stateLockPath, `${JSON.stringify({
    schema: 'sks.telegram-lock.v1',
    pid,
    token,
    ...(processStartSeconds === undefined ? {} : { process_start_seconds: processStartSeconds })
  })}\n`, { mode: 0o600 });
  await fs.chmod(paths.stateLockPath, 0o600);
}

async function privateFixture(
  t: TestContext,
  prefix: string
): Promise<{ home: string; paths: TelegramPrivatePaths }> {
  const home = await fs.mkdtemp(path.join(ISOLATED_TEST_HOME, prefix));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  return { home, paths: telegramPrivatePaths({ HOME: home }) };
}
