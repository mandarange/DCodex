import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';
import { callSksdHookDaemon, sksdSocketPath, startSksdHookDaemon } from '../sksd-hook-daemon.js';

async function tempRoot(t: TestContext) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sksd-hook-test-'));
  const socketPath = sksdSocketPath(root);
  const pidFilePath = socketPath.replace(/\.sock$/, '.pid.json');
  t.after(async () => {
    await fsp.rm(socketPath, { force: true }).catch(() => undefined);
    await fsp.rm(pidFilePath, { force: true }).catch(() => undefined);
    await fsp.rm(root, { recursive: true, force: true });
    await fsp.rmdir(path.dirname(socketPath)).catch(() => undefined);
  });
  return root;
}

test('callSksdHookDaemon: returns null (fail open) when no daemon is listening', async (t) => {
  const root = await tempRoot(t);
  const response = await callSksdHookDaemon(root, 'pre-tool', { cwd: root });
  assert.equal(response, null);
});

test('sksd hook daemon: real socket round-trip returns the handler result', async (t) => {
  const root = await tempRoot(t);
  const calls: Array<{ name: string; payload: unknown }> = [];
  const daemon = await startSksdHookDaemon(root, async (name, payload) => {
    calls.push({ name, payload });
    return { continue: true, echoed: payload };
  });
  assert.ok(daemon, 'daemon should have started (nothing else bound to this fresh root)');
  try {
    const response = await callSksdHookDaemon(root, 'pre-tool', { cwd: root, tool_name: 'Read' });
    assert.ok(response, 'daemon should have responded');
    assert.equal(response.ok, true);
    assert.deepEqual(response.result, { continue: true, echoed: { cwd: root, tool_name: 'Read' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.name, 'pre-tool');
  } finally {
    await daemon!.close();
  }
});

test('sksd hook daemon: multiple sequential requests over the same warm daemon', async (t) => {
  const root = await tempRoot(t);
  let count = 0;
  const daemon = await startSksdHookDaemon(root, async () => {
    count += 1;
    return { continue: true, call_index: count };
  });
  assert.ok(daemon);
  try {
    const first = await callSksdHookDaemon(root, 'pre-tool', {});
    const second = await callSksdHookDaemon(root, 'post-tool', {});
    assert.deepEqual(first?.result, { continue: true, call_index: 1 });
    assert.deepEqual(second?.result, { continue: true, call_index: 2 });
  } finally {
    await daemon!.close();
  }
});

test('sksd hook daemon: a second startSksdHookDaemon for the same root is a no-op while the first is alive', async (t) => {
  const root = await tempRoot(t);
  const first = await startSksdHookDaemon(root, async () => ({ continue: true, who: 'first' }));
  assert.ok(first);
  try {
    const second = await startSksdHookDaemon(root, async () => ({ continue: true, who: 'second' }));
    assert.equal(second, null, 'must not start a duplicate daemon for a root that already has a live one');
    const response = await callSksdHookDaemon(root, 'pre-tool', {});
    assert.deepEqual(response?.result, { continue: true, who: 'first' }, 'the original daemon must still be the one serving requests');
  } finally {
    await first!.close();
  }
});

test('callSksdHookDaemon: a stale socket file with nothing listening fails open, not hangs', async (t) => {
  const root = await tempRoot(t);
  const socketPath = sksdSocketPath(root);
  await fsp.mkdir(path.dirname(socketPath), { recursive: true });
  // A leftover socket path with no listener behind it (simulating a daemon
  // that crashed without cleaning up) — connecting to it must fail fast.
  await fsp.writeFile(socketPath, '');
  const started = Date.now();
  const response = await callSksdHookDaemon(root, 'pre-tool', {});
  const elapsedMs = Date.now() - started;
  assert.equal(response, null);
  assert.ok(elapsedMs < 2000, `expected fast fail-open, took ${elapsedMs}ms`);
  await fsp.rm(socketPath, { force: true });
});

test('callSksdHookDaemon: refuses a symlinked socket path without touching its target', async (t) => {
  const root = await tempRoot(t);
  const socketPath = sksdSocketPath(root);
  const victim = path.join(root, 'socket-victim.txt');
  await fsp.mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(victim, 'preserve\n');
  await fsp.symlink(victim, socketPath);

  assert.equal(await callSksdHookDaemon(root, 'pre-tool', {}), null);
  assert.equal(await fsp.readFile(victim, 'utf8'), 'preserve\n');
  assert.equal((await fsp.lstat(socketPath)).isSymbolicLink(), true);
});

test('sksd hook daemon: after close(), a fresh daemon can start again for the same root', async (t) => {
  const root = await tempRoot(t);
  const first = await startSksdHookDaemon(root, async () => ({ continue: true, who: 'first' }));
  assert.ok(first);
  await first!.close();
  const second = await startSksdHookDaemon(root, async () => ({ continue: true, who: 'second' }));
  assert.ok(second, 'a new daemon should be able to bind the same socket once the old one is closed');
  try {
    const response = await callSksdHookDaemon(root, 'pre-tool', {});
    assert.deepEqual(response?.result, { continue: true, who: 'second' });
  } finally {
    await second!.close();
  }
});

test('sksd hook daemon: long hermetic TMPDIR still uses a short private socket path and cleans endpoints', async (t) => {
  const outer = await fsp.mkdtemp(path.join(os.tmpdir(), 'sksd-long-tmp-'));
  const longTmp = path.join(outer, ...Array.from({ length: 6 }, (_, index) => `nested-${index}-${'x'.repeat(32)}`));
  await fsp.mkdir(longTmp, { recursive: true });
  t.after(() => fsp.rm(outer, { recursive: true, force: true }));
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = longTmp;
  try {
    const root = await tempRoot(t);
    const socketPath = sksdSocketPath(root);
    const pidFilePath = socketPath.replace(/\.sock$/, '.pid.json');
    assert.ok(Buffer.byteLength(socketPath) < 100, `socket path is too long: ${socketPath}`);
    assert.equal(socketPath.startsWith(longTmp), false);

    const daemon = await startSksdHookDaemon(root, async () => ({ continue: true }));
    assert.ok(daemon);
    try {
      const response = await callSksdHookDaemon(root, 'pre-tool', {});
      assert.deepEqual(response?.result, { continue: true });
      assert.equal((await fsp.lstat(path.dirname(socketPath))).mode & 0o777, 0o700);
      assert.equal((await fsp.lstat(socketPath)).mode & 0o777, 0o600);
      assert.equal((await fsp.lstat(pidFilePath)).mode & 0o777, 0o600);
    } finally {
      await daemon!.close();
    }
    assert.equal(await fsp.access(socketPath).then(() => true, () => false), false);
    assert.equal(await fsp.access(pidFilePath).then(() => true, () => false), false);
  } finally {
    if (previousTmpdir === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmpdir;
  }
});

test('sksd hook daemon: refuses a symlinked PID claim without touching its target', async (t) => {
  const root = await tempRoot(t);
  const socketPath = sksdSocketPath(root);
  const pidFilePath = socketPath.replace(/\.sock$/, '.pid.json');
  const victim = path.join(root, 'victim.json');
  const original = '{"preserve":true}\n';
  await fsp.mkdir(path.dirname(pidFilePath), { recursive: true, mode: 0o700 });
  await fsp.writeFile(victim, original);
  await fsp.symlink(victim, pidFilePath);

  await assert.rejects(
    startSksdHookDaemon(root, async () => ({ continue: true })),
    /unsafe_sksd_pid_file/
  );
  assert.equal(await fsp.readFile(victim, 'utf8'), original);
  assert.equal((await fsp.lstat(pidFilePath)).isSymbolicLink(), true);
});

test('sksd hook daemon: a request from a different SKS version is refused and retires the daemon', async (t) => {
  const net = await import('node:net');
  const { SKSD_VERSION_MISMATCH_ERROR } = await import('../sksd-hook-daemon.js');
  const root = await tempRoot(t);
  let handled = 0;
  const daemon = await startSksdHookDaemon(root, async () => { handled += 1; return { continue: true }; });
  assert.ok(daemon);
  try {
    const raw = await new Promise<any>((resolve, reject) => {
      const socket = net.createConnection(sksdSocketPath(root));
      let buffer = '';
      socket.on('connect', () => socket.write(`${JSON.stringify({ schema: 'sks.sksd-hook-request.v1', name: 'pre-tool', payload: {}, sks_version: '0.0.0-stale-client' })}\n`));
      socket.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
      socket.on('close', () => { try { resolve(JSON.parse(buffer.trim())); } catch (error) { reject(error); } });
      socket.on('error', reject);
    });
    assert.equal(raw.ok, false);
    assert.equal(raw.error, SKSD_VERSION_MISMATCH_ERROR);
    assert.equal(handled, 0, 'a stale-version request must never reach the handler');
    // The daemon has retired: the next same-version call falls open so the
    // caller evaluates inline and spawns a daemon on the new code.
    for (let attempt = 0; attempt < 20 && (await callSksdHookDaemon(root, 'pre-tool', {})) !== null; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(await callSksdHookDaemon(root, 'pre-tool', {}), null);
  } finally {
    await daemon.close();
  }
});
