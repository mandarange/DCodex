import net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../fsx.js';
import { PACKAGE_VERSION } from '../version.js';

// 20차 P2-1: hook round-trip daemon. `.codex/hooks.json` fires PreToolUse/
// PostToolUse for every tool call, each spawning a fresh `sks hook <event>`
// process that cold-imports the CLI and re-does all hook setup work — the
// audited raw cost was ~171ms/call. This daemon keeps that work warm in a
// long-lived process reachable over a Unix domain socket, so a hook call
// only pays for a short-lived client process's own boot plus a small
// socket round-trip.
//
// Opt-in only for now via SKS_HOOK_DAEMON=1 (see sks-dispatch.ts) — the
// default `sks hook <event>` path is unchanged until this has been proven
// safe and .codex/hooks.json is deliberately updated to depend on it.

const IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
const CONNECT_TIMEOUT_MS = 150;
const REQUEST_TIMEOUT_MS = 5_000;

export interface SksdHookRequest {
  schema: 'sks.sksd-hook-request.v1';
  name: string;
  payload: unknown;
  /**
   * The caller's package version. A daemon outlives `sks update` (it idles
   * for 30 min and every hook keeps it alive), so without this a freshly
   * installed SKS would keep evaluating hooks with the old code — the same
   * stale-long-lived-process failure the Desktop Bridge had. A mismatch makes
   * the daemon refuse and retire itself; the caller falls back inline and
   * spawns a daemon on the new code.
   */
  sks_version?: string;
}

export interface SksdHookResponse {
  schema: 'sks.sksd-hook-response.v1';
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const SKSD_VERSION_MISMATCH_ERROR = 'sksd_version_mismatch';

// Unix domain socket paths have a ~100 byte limit on macOS/Linux. TMPDIR can
// itself be a deeply nested hermetic test root, so sockets use a short,
// per-user SKS-owned runtime directory under the platform's real /tmp. The
// project hash keeps independent repositories collision-free.
export function sksdSocketPath(root: string): string {
  return path.join(sksdRuntimeDir(), `sksd-${projectKey(root)}.sock`);
}

function sksdPidFilePath(root: string): string {
  return path.join(sksdRuntimeDir(), `sksd-${projectKey(root)}.pid.json`);
}

function projectKey(root: string): string {
  return sha256(path.resolve(root)).slice(0, 16);
}

function sksdRuntimeDir(): string {
  const owner = typeof process.getuid === 'function'
    ? String(process.getuid())
    : sha256(os.userInfo().username).slice(0, 8);
  const base = process.platform === 'win32'
    ? os.tmpdir()
    : fs.realpathSync.native('/tmp');
  return path.join(base, `sksd-${owner}`);
}

async function ensureSafeRuntimeDir(runtimeDir: string): Promise<void> {
  await fsp.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(runtimeDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_sksd_runtime_dir_type');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('unsafe_sksd_runtime_dir_owner');
  if ((stat.mode & 0o077) !== 0) await fsp.chmod(runtimeDir, 0o700);
  const real = await fsp.realpath(runtimeDir);
  if (real !== path.resolve(runtimeDir)) throw new Error('unsafe_sksd_runtime_dir_symlink');
}

async function hardenSocketPermissions(socketPath: string): Promise<void> {
  await fsp.chmod(socketPath, 0o600);
}

function safeRuntimeDirPresent(runtimeDir: string): boolean {
  try {
    const stat = fs.lstatSync(runtimeDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return false;
    if ((stat.mode & 0o077) !== 0) return false;
    return fs.realpathSync(runtimeDir) === path.resolve(runtimeDir);
  } catch {
    return false;
  }
}

async function safeExistingPid(pidFilePath: string): Promise<number | null | undefined> {
  const stat = await fsp.lstat(pidFilePath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe_sksd_pid_file');
  const record = await fsp.readFile(pidFilePath, 'utf8').then((raw) => JSON.parse(raw), () => null);
  return Number.isInteger(record?.pid) ? Number(record.pid) : null;
}

async function claimPidFile(pidFilePath: string, root: string): Promise<boolean> {
  const existingPid = await safeExistingPid(pidFilePath);
  if (existingPid && pidAlive(existingPid)) return false;
  if (existingPid !== undefined) await fsp.rm(pidFilePath, { force: true });
  try {
    const handle = await fsp.open(pidFilePath, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify({
        pid: process.pid,
        started_at: new Date().toISOString(),
        root,
        project_hash: projectKey(root)
      }));
      await handle.sync().catch(() => undefined);
    } finally {
      await handle.close();
    }
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') {
      const racedPid = await safeExistingPid(pidFilePath);
      if (racedPid && pidAlive(racedPid)) return false;
    }
    throw err;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface SksdHookDaemonHandle {
  close: () => Promise<void>;
}

async function removeStaleSocketPath(socketPath: string): Promise<void> {
  const stat = await fsp.lstat(socketPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) throw new Error('unsafe_sksd_socket_path_directory');
  // rm() unlinks a symlink itself; it never follows it to the target.
  await fsp.rm(socketPath, { force: true });
}

// Called by the daemon entrypoint (registers real process signal handlers
// and exits the process on shutdown) and directly by tests (which own the
// returned handle's close() instead and must not have this call
// process.exit — that would kill the test runner).
export async function startSksdHookDaemon(
  root: string,
  handleHook: (name: string, payload: unknown) => Promise<unknown>,
  options: { exitOnRetire?: boolean } = {},
): Promise<SksdHookDaemonHandle | null> {
  const socketPath = sksdSocketPath(root);
  const pidFilePath = sksdPidFilePath(root);
  const runtimeDir = path.dirname(socketPath);

  await ensureSafeRuntimeDir(runtimeDir);
  if (!(await claimPidFile(pidFilePath, root))) {
    return null; // Another daemon for this root owns the live PID claim.
  }
  try {
    await removeStaleSocketPath(socketPath);
  } catch (err) {
    await fsp.rm(pidFilePath, { force: true }).catch(() => undefined);
    throw err;
  }

  let idleTimer: NodeJS.Timeout | null = null;
  let closePromise: Promise<void> | null = null;
  let signalHandlersRegistered = false;
  const server = net.createServer((socket) => {
    resetIdleTimer();
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      const line = buffer.slice(0, newlineIdx);
      buffer = '';
      void respond(line);
    });
    async function respond(line: string) {
      let response: SksdHookResponse;
      let retire = false;
      try {
        const request = JSON.parse(line) as SksdHookRequest;
        if (request.sks_version && request.sks_version !== PACKAGE_VERSION) {
          retire = true;
          throw new Error(SKSD_VERSION_MISMATCH_ERROR);
        }
        const result = await handleHook(request.name, request.payload);
        response = { schema: 'sks.sksd-hook-response.v1', ok: true, result };
      } catch (err: unknown) {
        response = { schema: 'sks.sksd-hook-response.v1', ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      try {
        socket.write(`${JSON.stringify(response)}\n`);
      } catch {}
      socket.end();
      if (retire) {
        // The installed package moved past this process; make room for a
        // daemon running the new code instead of serving stale decisions.
        // In-process callers (tests) own process exit, so only the detached
        // entrypoint asks to exit.
        void close().then(() => { if (options.exitOnRetire) process.exit(0); });
        return;
      }
      resetIdleTimer();
    }
    socket.on('error', () => undefined);
  });

  function resetIdleTimer() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void idleShutdown(), IDLE_SHUTDOWN_MS);
    idleTimer.unref();
  }

  const onSigterm = () => void idleShutdown();
  const onSigint = () => void idleShutdown();

  function removeSignalHandlers() {
    if (!signalHandlersRegistered) return;
    signalHandlersRegistered = false;
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
  }

  async function cleanupRuntimeArtifacts(): Promise<void> {
    await fsp.rm(socketPath, { force: true }).catch(() => undefined);
    const claimedPid = await safeExistingPid(pidFilePath).catch(() => null);
    if (claimedPid === process.pid) await fsp.rm(pidFilePath, { force: true }).catch(() => undefined);
    await fsp.rmdir(runtimeDir).catch((err: NodeJS.ErrnoException) => {
      if (!['ENOENT', 'ENOTEMPTY'].includes(String(err.code))) throw err;
    });
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (idleTimer) clearTimeout(idleTimer);
      removeSignalHandlers();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      await cleanupRuntimeArtifacts();
    })();
    return closePromise;
  }

  async function idleShutdown() {
    await close();
    process.exit(0);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await hardenSocketPermissions(socketPath);
  } catch (err) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanupRuntimeArtifacts();
    throw err;
  }
  process.on('SIGTERM', onSigterm);
  process.on('SIGINT', onSigint);
  signalHandlersRegistered = true;
  resetIdleTimer();
  return { close };
}

// Spawns the daemon as a detached background process running this same
// module's entrypoint, then returns immediately — the caller (a hook
// client that couldn't connect) does not wait for it to finish warming up;
// it falls back to handling the current call itself and lets the daemon
// serve the *next* call.
export function spawnSksdHookDaemonDetached(root: string): void {
  const entrypoint = fileURLToPath(new URL('./sksd-hook-daemon-entrypoint.js', import.meta.url));
  const child = spawn(process.execPath, [entrypoint, root], {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

// Thin client used by `sks hook <event>`: attempt a fast socket round-trip;
// return null (never throws) if the daemon isn't reachable so the caller
// can fail open to the direct in-process path.
export async function callSksdHookDaemon(root: string, name: string, payload: unknown): Promise<{ ok: true; result: unknown } | null> {
  const socketPath = sksdSocketPath(root);
  if (!safeRuntimeDirPresent(path.dirname(socketPath))) return null;
  const socketStat = fs.lstatSync(socketPath, { throwIfNoEntry: false });
  if (!socketStat || socketStat.isSymbolicLink() || socketStat.isDirectory()) return null;
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (value: { ok: true; result: unknown } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(requestTimer);
      socket.destroy();
      resolve(value);
    };
    const connectTimer = setTimeout(() => finish(null), CONNECT_TIMEOUT_MS);
    const requestTimer = setTimeout(() => finish(null), REQUEST_TIMEOUT_MS);
    let buffer = '';
    socket.on('connect', () => {
      clearTimeout(connectTimer);
      const request: SksdHookRequest = { schema: 'sks.sksd-hook-request.v1', name, payload, sks_version: PACKAGE_VERSION };
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIdx = buffer.indexOf('\n');
      if (newlineIdx === -1) return;
      try {
        const response = JSON.parse(buffer.slice(0, newlineIdx)) as SksdHookResponse;
        finish(response.ok ? { ok: true, result: response.result } : null);
      } catch {
        finish(null);
      }
    });
    socket.on('error', () => finish(null));
    socket.on('close', () => finish(null));
  });
}
