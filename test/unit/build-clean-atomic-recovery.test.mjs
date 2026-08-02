import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acquireAtomicBuildLock,
  recoverInterruptedAtomicBuild,
  restorePreviousDistAfterFailedPromotion
} from '../../scripts/build-clean-atomic.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('atomic clean build surfaces restore failure and preserves its recovery path', async () => {
  const backupDist = '/tmp/sks-atomic-build-test/previous-dist';
  const promotionError = new Error('promotion failed');
  const restoreError = new Error('restore denied');
  const calls = [];

  await assert.rejects(
    restorePreviousDistAfterFailedPromotion({
      backupDist,
      liveDist: '/tmp/sks-atomic-build-test/dist',
      promotionError,
      fsApi: {
        async rename(from, to) {
          calls.push([from, to]);
          throw restoreError;
        }
      }
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [promotionError, restoreError]);
      assert.match(error.message, /recovery_preserved/);
      assert.match(error.message, /previous-dist/);
      return true;
    }
  );
  assert.deepEqual(calls, [[
    backupDist,
    '/tmp/sks-atomic-build-test/dist'
  ]]);
});

test('next atomic build restores the newest preserved previous dist after a hard interruption', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-atomic-build-recover-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const cacheRoot = path.join(fixture, 'cache');
  const liveDist = path.join(fixture, 'dist');
  const oldBackup = path.join(cacheRoot, 'old', 'previous-dist');
  const newBackup = path.join(cacheRoot, 'new', 'previous-dist');
  await fs.mkdir(oldBackup, { recursive: true });
  await fs.mkdir(newBackup, { recursive: true });
  await fs.writeFile(path.join(oldBackup, 'generation.txt'), 'old');
  await fs.writeFile(path.join(newBackup, 'generation.txt'), 'new');
  const oldTime = new Date(Date.now() - 10_000);
  await fs.utimes(oldBackup, oldTime, oldTime);

  const result = await recoverInterruptedAtomicBuild({ cacheRoot, liveDist });

  assert.equal(result.recovered, true);
  assert.equal(result.source, newBackup);
  assert.equal(await fs.readFile(path.join(liveDist, 'generation.txt'), 'utf8'), 'new');
  await assert.rejects(fs.access(newBackup), { code: 'ENOENT' });
});

test('atomic build lock permits only one writer and releases by owner token', async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-atomic-build-lock-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const cacheRoot = path.join(fixture, 'cache');
  const owner = await acquireAtomicBuildLock({ cacheRoot, heartbeatMs: 50 });

  await assert.rejects(
    acquireAtomicBuildLock({ cacheRoot, heartbeatMs: 50 }),
    /atomic_build_already_running/
  );
  await owner.release();

  const successor = await acquireAtomicBuildLock({ cacheRoot, heartbeatMs: 50 });
  assert.notEqual(successor.token, owner.token);
  await successor.release();
});
