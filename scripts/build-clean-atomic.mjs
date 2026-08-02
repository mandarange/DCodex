#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(modulePath), '..');
const ATOMIC_BUILD_LOCK_SCHEMA = 'sks.atomic-build-lock.v1';
const CORRUPT_LOCK_GRACE_MS = 120_000;

export async function buildCleanAtomic() {
  const cacheRoot = path.join(root, '.sneakoscope', 'cache', 'atomic-build');
  const liveDist = path.join(root, 'dist');
  const lock = await acquireAtomicBuildLock({ cacheRoot });
  try {
    await recoverInterruptedAtomicBuild({ cacheRoot, liveDist });
    const buildId = `${Date.now()}-${process.pid}-${randomBytes(4).toString('hex')}`;
    const stageParent = path.join(cacheRoot, buildId);
    const stageDist = path.join(stageParent, 'dist');
    const backupDist = path.join(stageParent, 'previous-dist');
    const buildInfo = path.join(stageParent, 'tsconfig.build.tsbuildinfo');
    const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    const buildEnvironment = {
      ...process.env,
      SKS_BUILD_SOURCE_ROOT: root,
      SKS_BUILD_OUTPUT_DIR: stageDist
    };

    let liveMoved = false;
    let preserveRecovery = false;
    try {
      await fsp.mkdir(stageParent, { recursive: true });
      await run(process.execPath, [
        tsc,
        '-p',
        path.join(root, 'tsconfig.build.json'),
        '--outDir',
        stageDist,
        '--tsBuildInfoFile',
        buildInfo
      ], process.env);
      await run(
        process.execPath,
        [path.join(stageDist, 'scripts', 'ensure-bin-executable.js')],
        buildEnvironment
      );
      await run(
        process.execPath,
        [path.join(stageDist, 'scripts', 'build-dist.js')],
        buildEnvironment
      );
      await Promise.all([
        fsp.access(path.join(stageDist, 'bin', 'sks.js')),
        fsp.access(path.join(stageDist, 'config', 'skills-manifest.json')),
        fsp.access(path.join(stageDist, '.sks-build-stamp.json'))
      ]);

      try {
        await fsp.rename(liveDist, backupDist);
        liveMoved = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        await fsp.rename(stageDist, liveDist);
      } catch (error) {
        if (liveMoved) {
          try {
            await restorePreviousDistAfterFailedPromotion({
              backupDist,
              liveDist,
              promotionError: error
            });
            liveMoved = false;
          } catch (combinedError) {
            preserveRecovery = true;
            throw combinedError;
          }
        }
        throw error;
      }
      const reportStamp = path.join(root, '.sneakoscope', 'reports', 'dist-build-stamp.json');
      await fsp.mkdir(path.dirname(reportStamp), { recursive: true });
      await fsp.copyFile(path.join(liveDist, '.sks-build-stamp.json'), reportStamp);
      if (liveMoved) {
        await fsp.rm(backupDist, { recursive: true, force: true });
        liveMoved = false;
      }
    } finally {
      if (liveMoved && !preserveRecovery) {
        const liveExists = await pathExists(liveDist);
        if (!liveExists) {
          try {
            await fsp.rename(backupDist, liveDist);
            liveMoved = false;
          } catch (restoreError) {
            preserveRecovery = true;
            console.error(
              `atomic_build_restore_failed:recovery_preserved:${backupDist}:${
                String(restoreError?.message || restoreError)
              }`
            );
          }
        } else {
          // A post-promotion step failed. Keep the previous generation
          // available for explicit or next-start recovery.
          preserveRecovery = true;
        }
      }
      if (!preserveRecovery) {
        await fsp.rm(stageParent, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } finally {
    await lock.release();
  }
}

export async function recoverInterruptedAtomicBuild({
  cacheRoot,
  liveDist,
  fsApi = fsp
}) {
  if (await pathExists(liveDist, fsApi)) return { recovered: false, source: null };
  let entries;
  try {
    entries = await fsApi.readdir(cacheRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { recovered: false, source: null };
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const candidate = path.join(cacheRoot, entry.name, 'previous-dist');
    try {
      const stat = await fsApi.lstat(candidate);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        candidates.push({ candidate, mtimeMs: stat.mtimeMs });
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const selected = candidates[0]?.candidate || null;
  if (!selected) return { recovered: false, source: null };
  await fsApi.rename(selected, liveDist);
  return { recovered: true, source: selected };
}

export async function acquireAtomicBuildLock({
  cacheRoot,
  fsApi = fsp,
  heartbeatMs = 5_000
}) {
  const lockPath = path.join(path.resolve(cacheRoot), '.build.lock');
  await fsApi.mkdir(path.dirname(lockPath), { recursive: true });
  const token = `${process.pid}-${Date.now()}-${randomBytes(8).toString('hex')}`;
  const owner = {
    schema: ATOMIC_BUILD_LOCK_SCHEMA,
    token,
    pid: process.pid,
    process_start: processStartIdentity(process.pid),
    acquired_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString()
  };
  let acquired = false;
  for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
    let createdLock = false;
    try {
      await fsApi.mkdir(lockPath);
      createdLock = true;
      await writeAtomicBuildLockOwner(lockPath, owner, fsApi);
      acquired = true;
    } catch (error) {
      if (createdLock) {
        await fsApi.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error?.code !== 'EEXIST') throw error;
      if (attempt > 0 || !await reclaimStaleAtomicBuildLock(lockPath, fsApi)) {
        throw new Error(`atomic_build_already_running:${lockPath}`);
      }
    }
  }
  if (!acquired) throw new Error(`atomic_build_already_running:${lockPath}`);
  const heartbeat = setInterval(() => {
    owner.heartbeat_at = new Date().toISOString();
    writeAtomicBuildLockOwner(lockPath, owner, fsApi).catch(() => undefined);
  }, Math.max(250, heartbeatMs));
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  let released = false;
  return {
    lockPath,
    token,
    async release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      const current = await readAtomicBuildLockOwner(lockPath, fsApi);
      if (current?.token !== token) return;
      const claimed = `${lockPath}.release-${token}`;
      try {
        await fsApi.rename(lockPath, claimed);
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
      await fsApi.rm(claimed, { recursive: true, force: true });
    }
  };
}

async function reclaimStaleAtomicBuildLock(lockPath, fsApi) {
  const current = await readAtomicBuildLockOwner(lockPath, fsApi);
  let stale = false;
  if (current?.schema === ATOMIC_BUILD_LOCK_SCHEMA
    && Number.isSafeInteger(current.pid)
    && current.pid > 0) {
    stale = !processIdentityAlive(current.pid, current.process_start);
  } else {
    try {
      const stat = await fsApi.stat(lockPath);
      stale = Date.now() - stat.mtimeMs > CORRUPT_LOCK_GRACE_MS;
    } catch {
      return true;
    }
  }
  if (!stale) return false;
  const claimed = `${lockPath}.stale-${Date.now()}-${randomBytes(4).toString('hex')}`;
  try {
    await fsApi.rename(lockPath, claimed);
  } catch {
    return false;
  }
  await fsApi.rm(claimed, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

async function writeAtomicBuildLockOwner(lockPath, owner, fsApi) {
  const file = path.join(lockPath, 'owner.json');
  const tmp = `${file}.${owner.token}.tmp`;
  try {
    await fsApi.writeFile(tmp, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    await fsApi.rename(tmp, file);
  } finally {
    await fsApi.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function readAtomicBuildLockOwner(lockPath, fsApi) {
  try {
    return JSON.parse(await fsApi.readFile(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return null;
  }
}

function processIdentityAlive(pid, expectedStart) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
  if (!expectedStart) return true;
  const observed = processStartIdentity(pid);
  return observed === null || observed === expectedStart;
}

function processStartIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  });
  if (result.status !== 0) return null;
  return String(result.stdout || '').trim() || null;
}

async function pathExists(target, fsApi = fsp) {
  try {
    await fsApi.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function restorePreviousDistAfterFailedPromotion({
  backupDist,
  liveDist,
  promotionError,
  fsApi = fsp
}) {
  try {
    await fsApi.rename(backupDist, liveDist);
  } catch (restoreError) {
    throw new AggregateError(
      [promotionError, restoreError],
      `atomic_build_promotion_and_restore_failed:recovery_preserved:${backupDist}`
    );
  }
}

async function run(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`atomic_build_step_failed:${path.basename(args[0] || command)}:${code ?? signal}`));
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === modulePath) {
  await buildCleanAtomic();
}
