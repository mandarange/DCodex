import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acquireUpdateMigrationLock,
  registerUpdateMigrationLockChild,
  releaseUpdateMigrationLock,
  removeStaleMigrationLock,
  updateMigrationLockIsStale
} from '../update/update-migration-state.js';

test('migration lock is fully populated before exclusive publication', async () => {
  const fixture = await lockFixture();
  try {
    const contenders = await Promise.all([
      acquireUpdateMigrationLock(fixture.lockPath),
      acquireUpdateMigrationLock(fixture.lockPath)
    ]);
    const owners = contenders.filter((owner) => owner !== null);
    assert.equal(owners.length, 1);
    const owner = owners[0];
    assert.ok(owner);
    const raw = await fs.readFile(fixture.lockPath, 'utf8');
    const record = JSON.parse(raw);
    const stat = await fs.stat(fixture.lockPath);
    assert.equal(record.schema, 'sks.update-migration-lock.v1');
    assert.equal(record.pid, process.pid);
    assert.equal(record.token, owner.token);
    assert.equal(stat.dev, owner.dev);
    assert.equal(stat.ino, owner.ino);
    if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(contenders.filter((candidate) => candidate === null).length, 1);
    assert.equal(await releaseUpdateMigrationLock(fixture.lockPath, owner), true);
  } finally {
    await fixture.cleanup();
  }
});

test('fresh empty and partial migration locks receive a stale-reap grace period', async (t) => {
  for (const [name, content] of [['empty', ''], ['partial', '{"pid":']] as const) {
    await t.test(name, async () => {
      const fixture = await lockFixture();
      try {
        await fs.writeFile(fixture.lockPath, content, { mode: 0o600 });
        assert.equal(await removeStaleMigrationLock(fixture.lockPath), false);
        assert.equal(await acquireUpdateMigrationLock(fixture.lockPath), null);
        const old = new Date(Date.now() - 121_000);
        await fs.utimes(fixture.lockPath, old, old);
        assert.equal(await removeStaleMigrationLock(fixture.lockPath), true);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test('a live migration owner is never reaped solely because its lock is old', async () => {
  const fixture = await lockFixture();
  try {
    await fs.writeFile(fixture.lockPath, `${JSON.stringify({
      schema: 'sks.update-migration-lock.v1',
      pid: process.pid,
      token: 'a'.repeat(48),
      created_at: '2020-01-01T00:00:00.000Z',
      version: 'fixture'
    })}\n`, { mode: 0o600 });
    const old = new Date('2020-01-01T00:00:00.000Z');
    await fs.utimes(fixture.lockPath, old, old);
    assert.equal(await removeStaleMigrationLock(fixture.lockPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test('an earlier owner cannot delete a successor lock', async () => {
  const fixture = await lockFixture();
  try {
    const first = await acquireUpdateMigrationLock(fixture.lockPath);
    assert.ok(first);
    await fs.unlink(fixture.lockPath);
    const successor = await acquireUpdateMigrationLock(fixture.lockPath);
    assert.ok(successor);
    assert.notEqual(successor.token, first.token);

    assert.equal(await releaseUpdateMigrationLock(fixture.lockPath, first), false);
    const current = JSON.parse(await fs.readFile(fixture.lockPath, 'utf8'));
    assert.equal(current.token, successor.token);
    assert.equal(await releaseUpdateMigrationLock(fixture.lockPath, successor), true);
  } finally {
    await fixture.cleanup();
  }
});

test('concurrent release attempts claim one lock without deleting a successor', async () => {
  const fixture = await lockFixture();
  try {
    const owner = await acquireUpdateMigrationLock(fixture.lockPath);
    assert.ok(owner);
    const releases = await Promise.all([
      releaseUpdateMigrationLock(fixture.lockPath, owner),
      releaseUpdateMigrationLock(fixture.lockPath, owner)
    ]);
    assert.equal(releases.filter(Boolean).length, 1);

    const successor = await acquireUpdateMigrationLock(fixture.lockPath);
    assert.ok(successor);
    await Promise.all([
      releaseUpdateMigrationLock(fixture.lockPath, owner),
      releaseUpdateMigrationLock(fixture.lockPath, owner)
    ]);
    const current = JSON.parse(await fs.readFile(fixture.lockPath, 'utf8'));
    assert.equal(current.token, successor.token);
    assert.equal(await releaseUpdateMigrationLock(fixture.lockPath, successor), true);
  } finally {
    await fixture.cleanup();
  }
});

test('a reused owner pid with a different process start identity is stale', () => {
  assert.equal(
    updateMigrationLockIsStale(
      process.pid,
      new Date().toISOString(),
      Date.now(),
      'Mon Jan 01 00:00:00 1900'
    ),
    true
  );
});

test('a registered live Doctor child keeps the migration lock after its owner identity is lost', async () => {
  const fixture = await lockFixture();
  try {
    const owner = await acquireUpdateMigrationLock(fixture.lockPath);
    assert.ok(owner);
    await registerUpdateMigrationLockChild(fixture.lockPath, owner, process.pid);
    await fs.writeFile(fixture.lockPath, `${JSON.stringify({
      schema: 'sks.update-migration-lock.v1',
      pid: process.pid,
      process_start: 'Mon Jan 01 00:00:00 1900',
      token: owner.token,
      created_at: '2020-01-01T00:00:00.000Z',
      version: 'fixture'
    })}\n`, { mode: 0o600 });

    assert.equal(await removeStaleMigrationLock(fixture.lockPath), false);
    assert.equal(await releaseUpdateMigrationLock(fixture.lockPath, owner), true);
    await assert.rejects(fs.access(`${fixture.lockPath}.child`), { code: 'ENOENT' });
  } finally {
    await fixture.cleanup();
  }
});

async function lockFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sks-migration-lock-'));
  const updateDir = path.join(root, '.sneakoscope', 'update');
  await fs.mkdir(updateDir, { recursive: true });
  return {
    lockPath: path.join(updateDir, 'migration.lock'),
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}
