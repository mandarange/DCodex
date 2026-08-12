import fs from 'node:fs';
import type { WriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gunzip as gunzipCallback } from 'node:zlib';
import { promisify } from 'node:util';
import { PACKAGE_VERSION } from './version.js';

export { PACKAGE_VERSION };
export const DEFAULT_PROCESS_TAIL_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;
export const SKS_TEMP_LEASE_FILE = '.sks-temp-lease.json';
const gunzipAsync = promisify(gunzipCallback);

export interface RunProcessOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  envMode?: 'merge' | 'replace';
  input?: string | Buffer;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stdoutFile?: string;
  stderrFile?: string;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onSpawn?: (pid: number) => void | Promise<void>;
}

export interface RunProcessResult {
  code: number | null;
  pid?: number | undefined;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  timedOut: boolean;
  spawnRegistrationFailed?: boolean;
}

export interface ListFilesOptions {
  ignore?: string[];
  maxFiles?: number;
  maxDepth?: number;
}

export interface TailBufferSnapshot {
  text: string;
  bytes: number;
  totalBytes: number;
  truncated: boolean;
}

export type JsonData = ReturnType<typeof JSON.parse>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function lastLine(chunk: string): string {
  const lines = String(chunk || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || '';
}

export function throttleLines(fn: (line: string) => void, ms = 500): (chunk: string) => void {
  let lastAt = 0;
  let pending: string | null = null;
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    if (!pending) return;
    lastAt = Date.now();
    const line = pending;
    pending = null;
    fn(line);
  };
  return (chunk: string) => {
    const line = lastLine(chunk);
    if (!line) return;
    pending = line;
    const now = Date.now();
    const wait = Math.max(0, ms - (now - lastAt));
    if (wait === 0) flush();
    else if (!timer) timer = setTimeout(flush, wait);
  };
}

export function sha256(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomId(len = 6): string {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function canonicalFilesystemPath(p: string): Promise<string> {
  const resolved = path.resolve(p);
  return fsp.realpath(resolved).catch(() => resolved);
}

/**
 * Synchronous path canonicalization for comparing paths that may no longer
 * exist — recorded evidence, read back after the directory it described was
 * removed. `realpath` cannot help there, so on macOS the `/var` → `/private/var`
 * firmlink is applied by hand: a proof that recorded `/var/folders/…` and a
 * tool that resolved the same directory to `/private/var/folders/…` are naming
 * one directory, and a raw string compare would call them different.
 */
export function canonicalFilesystemPathSync(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    if (process.platform === 'darwin' && resolved.startsWith('/var/')) return `/private${resolved}`;
    return resolved;
  }
}

export function sameFilesystemPathSync(left: string | undefined | null, right: string | undefined | null): boolean {
  return Boolean(left && right && canonicalFilesystemPathSync(left) === canonicalFilesystemPathSync(right));
}

export async function sameFilesystemPath(left: string, right: string): Promise<boolean> {
  const [leftCanonical, rightCanonical] = await Promise.all([
    canonicalFilesystemPath(left),
    canonicalFilesystemPath(right)
  ]);
  return leftCanonical === rightCanonical;
}

export async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

export async function readText(p: string): Promise<string>;
export async function readText<T>(p: string, fallback: T): Promise<string | T>;
export async function readText<T>(p: string, fallback?: T): Promise<string | T> {
  try {
    return await fsp.readFile(p, 'utf8');
  } catch (err: unknown) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

// Set by the canonical test runner alongside its HOME redirect: if a test still
// resolves the operator's real Codex home (hardcoded path, restored env), fail
// the write loudly instead of mutating the operator's ~/.codex.
export function assertTestHomeWriteAllowed(p: string): void {
  if (process.env.SKS_TEST_FORBID_REAL_HOME !== '1') return;
  const realHome = process.env.SKS_TEST_REAL_HOME;
  if (!realHome) return;
  const forbidden = path.join(path.resolve(realHome), '.codex');
  const target = path.resolve(p);
  if (target === forbidden || target.startsWith(`${forbidden}${path.sep}`)) {
    throw new Error(`sks_test_forbid_real_home_write: refusing to write ${target} while SKS_TEST_FORBID_REAL_HOME=1`);
  }
}

export async function writeTextAtomic(p: string, text: string, opts: { mode?: number } = {}): Promise<void> {
  assertTestHomeWriteAllowed(p);
  await ensureDir(path.dirname(p));
  if (opts.mode === undefined) {
    try {
      if ((await fsp.readFile(p, 'utf8')) === text) return;
    } catch {}
  }
  const tmp = `${p}.${process.pid}.${randomId(6)}.tmp`;
  const existingMode = await fsp.lstat(p).then((stat) => stat.isFile() && !stat.isSymbolicLink() ? stat.mode & 0o777 : null).catch(() => null);
  const requestedMode = opts.mode === undefined ? existingMode : opts.mode & 0o777;
  try {
    const handle = await fsp.open(tmp, 'w', requestedMode ?? 0o666);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    if (requestedMode !== null) await fsp.chmod(tmp, requestedMode);
    await fsp.rename(tmp, p);
  } catch (err: unknown) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    // A caller that requests a mode is relying on the temporary inode being
    // private before it becomes visible. Never downgrade that contract to a
    // direct write of an existing, potentially broader-mode path.
    if (opts.mode !== undefined || !canFallbackToDirectWrite(err)) throw err;
    try {
      await ensureDir(path.dirname(p));
      await fsp.writeFile(p, text, { encoding: 'utf8', ...(requestedMode === null ? {} : { mode: requestedMode }) });
      if (requestedMode !== null) await fsp.chmod(p, requestedMode);
    } catch (fallbackErr: unknown) {
      const error = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
      error.message = `Atomic write failed (${errorMessage(err)}); direct write fallback failed: ${error.message}`;
      throw error;
    }
  }
}

// A non-atomic direct write is only justified when the atomic rename itself
// is physically impossible (EXDEV: tmp and target span different devices,
// e.g. an unusual bind-mount) — the rename already fsync'd the tmp file's
// contents, so a direct write there just relocates already-durable bytes.
// The other codes previously here (EACCES/EEXIST/ENOENT/ENOTEMPTY/EPERM)
// have nothing to do with cross-device limits and used to quietly downgrade
// every one of those failures to a non-atomic write, risking a partially
// written file on crash (20차 P1-6) — they now propagate instead.
function canFallbackToDirectWrite(err: unknown): boolean {
  return errorCode(err) === 'EXDEV';
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String(err.code);
  return '';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) return String(err.message);
  return String(err);
}

export async function readJson<T = unknown>(p: string): Promise<T>;
export async function readJson(p: string, fallback: null): Promise<JsonData | null>;
export async function readJson(p: string, fallback: readonly unknown[]): Promise<JsonData>;
export async function readJson(p: string, fallback: object): Promise<JsonData>;
export async function readJson<T>(p: string, fallback: T): Promise<T>;
export async function readJson<T = unknown>(p: string, fallback?: T): Promise<T> {
  try {
    const parsed = JSON.parse(await fsp.readFile(p, 'utf8'));
    if (parsed?.retention_archived === true) {
      return await hydrateRetentionArchivedJson(p, parsed) as T;
    }
    return parsed as T;
  } catch (err: unknown) {
    if (fallback !== undefined) return fallback;
    throw err;
  }
}

async function hydrateRetentionArchivedJson(p: string, stub: any): Promise<unknown> {
  const archive = stub?.retention_archive;
  const sourceRel = String(archive?.source_path || '').split(path.sep).join('/');
  const gzipRel = String(archive?.gzip_path || '').split(path.sep).join('/');
  if (!sourceRel || sourceRel.startsWith('../') || path.posix.isAbsolute(sourceRel) || path.posix.normalize(sourceRel) !== sourceRel) {
    throw new Error('retention_archive_invalid_source_path');
  }
  if (gzipRel !== `${sourceRel}.gz`) throw new Error('retention_archive_invalid_gzip_path');
  const sourceParts = sourceRel.split('/').filter(Boolean);
  const archiveRoot = path.resolve(path.dirname(p), ...Array(Math.max(0, sourceParts.length - 1)).fill('..'));
  const resolvedSource = path.resolve(p);
  const resolvedGzip = path.resolve(archiveRoot, ...gzipRel.split('/'));
  if (path.resolve(archiveRoot, ...sourceParts) !== resolvedSource || resolvedGzip !== `${resolvedSource}.gz`) {
    throw new Error('retention_archive_path_escape');
  }
  const compressed = await fsp.readFile(resolvedGzip);
  const original = await gunzipAsync(compressed);
  const expectedSha = String(archive?.original_sha256 || '');
  if (!/^[a-f0-9]{64}$/i.test(expectedSha) || sha256(original) !== expectedSha) {
    throw new Error('retention_archive_sha256_mismatch');
  }
  return JSON.parse(original.toString('utf8'));
}

export async function writeJsonAtomic<T>(p: string, data: T, opts: { mode?: number } = {}): Promise<void> {
  await writeTextAtomic(p, `${JSON.stringify(data, null, 2)}\n`, opts);
}

export async function writeReceiptRotated<T>(p: string, data: T, opts: { keep?: number } = {}): Promise<void> {
  await ensureDir(path.dirname(p));
  const keep = Math.max(1, opts.keep ?? 5);
  const prior = await fsp.readdir(path.dirname(p), { withFileTypes: true }).catch(() => []);
  const base = path.basename(p);
  const rotated = prior
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${base}.`) && entry.name.endsWith('.json'))
    .map((entry) => path.join(path.dirname(p), entry.name));
  const rotatedFiles = new Set(rotated);
  const existing = await fsp.stat(p).catch(() => null);
  if (existing) {
    const stamp = new Date(existing.mtimeMs).toISOString().replace(/[:.]/g, '-');
    const rotatedPath = path.join(path.dirname(p), `${base}.${stamp}.json`);
    await fsp.rename(p, rotatedPath).catch(() => undefined);
    rotatedFiles.add(rotatedPath);
  }
  await writeJsonAtomic(p, data);
  const rows = await Promise.all([...rotatedFiles].map(async (file) => ({ file, stat: await fsp.stat(file).catch(() => null) })));
  const removable = rows
    .filter((row): row is { file: string; stat: fs.Stats } => Boolean(row.stat))
    .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
    .slice(keep);
  await Promise.all(removable.map((row) => fsp.rm(row.file, { force: true }).catch(() => undefined)));
}

export async function writeBinaryAtomic(p: string, data: Buffer, options: { mode?: number } = {}): Promise<void> {
  await ensureDir(path.dirname(p));
  try {
    if (options.mode === undefined && (await fsp.readFile(p)).equals(data)) return;
  } catch {}
  const tmp = `${p}.${process.pid}.${randomId(6)}.tmp`;
  try {
    const handle = options.mode === undefined
      ? await fsp.open(tmp, 'w')
      : await fsp.open(tmp, 'w', options.mode);
    try {
      await handle.writeFile(data);
      if (options.mode !== undefined) await handle.chmod(options.mode);
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    await fsp.rename(tmp, p);
  } catch (err: unknown) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function appendJsonl(p: string, obj: unknown): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.appendFile(p, `${JSON.stringify(obj)}\n`, 'utf8');
}

export async function appendJsonlMany(p: string, rows: readonly unknown[]): Promise<void> {
  if (!rows.length) return;
  await ensureDir(path.dirname(p));
  await fsp.appendFile(p, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

export async function appendJsonlBounded(
  p: string,
  obj: unknown,
  maxBytes: number = 5 * 1024 * 1024
): Promise<void> {
  await appendJsonl(p, obj);
  try {
    const st = await fsp.stat(p);
    if (st.size <= maxBytes) return;
    const keep = Math.max(1024, Math.floor(maxBytes / 2));
    const handle = await fsp.open(p, 'r');
    try {
      const start = Math.max(0, st.size - keep);
      const buf = Buffer.alloc(st.size - start);
      await handle.read(buf, 0, buf.length, start);
      const marker = Buffer.from(
        `${JSON.stringify({ ts: nowIso(), type: 'log.rotated', kept_tail_bytes: buf.length })}\n`
      );
      await writeTextAtomic(
        p,
        `${marker.toString('utf8')}${buf.toString('utf8').replace(/^.*?\n/, '')}`
      );
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {}
}

export async function copyFileIfMissing(src: string, dest: string): Promise<boolean> {
  if (await exists(dest)) return false;
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  return true;
}

export async function mergeManagedBlock(
  file: string,
  markerName: string,
  content: string
): Promise<'created' | 'updated' | 'appended'> {
  const begin = `<!-- BEGIN ${markerName} -->`;
  const end = `<!-- END ${markerName} -->`;
  const block = `${begin}\n${content.trim()}\n${end}\n`;
  const current = await readText(file, '');
  if (!current.trim()) {
    await writeTextAtomic(file, `${block}\n`);
    return 'created';
  }
  const beginIdx = current.indexOf(begin);
  const endIdx = current.indexOf(end);
  if (beginIdx >= 0 && endIdx >= beginIdx) {
    const afterEnd = endIdx + end.length;
    const next = `${current.slice(0, beginIdx)}${block}${current.slice(afterEnd).replace(/^\n/, '')}`;
    await writeTextAtomic(file, next);
    return 'updated';
  }
  await writeTextAtomic(file, `${current.replace(/\s*$/, '\n\n')}${block}\n`);
  return 'appended';
}

export function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function cwd(): string {
  return process.cwd();
}

export async function findUp(start: string, names: string[]): Promise<string | null> {
  let dir = path.resolve(start);
  const fsRoot = path.parse(dir).root;
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    if (dir === fsRoot) return null;
    dir = path.dirname(dir);
  }
}

export async function findProjectRoot(start: string = process.cwd()): Promise<string | null> {
  const resolved = path.resolve(start);
  const sine = await findUp(resolved, ['.sneakoscope', '.dcodex']);
  if (sine) {
    const rootDir = path.dirname(sine);
    if (rootDir !== path.parse(rootDir).root) return rootDir;
  }
  const git = await findUp(resolved, ['.git']);
  if (git) {
    const rootDir = path.dirname(git);
    if (rootDir !== path.parse(rootDir).root) return rootDir;
  }
  return null;
}

export function globalSksRoot(): string {
  if (process.env.SKS_GLOBAL_ROOT) return path.resolve(process.env.SKS_GLOBAL_ROOT);
  return path.join(process.env.HOME || os.homedir(), '.sneakoscope-global');
}

export async function sksRoot(start: string = process.cwd()): Promise<string> {
  return (await findProjectRoot(start)) || globalSksRoot();
}

export async function projectRoot(start: string = process.cwd()): Promise<string> {
  const resolved = path.resolve(start);
  const root = await findProjectRoot(resolved);
  if (root) return root;
  return resolved;
}

export async function isGitRepo(root: string = process.cwd()): Promise<boolean> {
  return exists(path.join(root, '.git'));
}

export function rel(root: string, p: string): string {
  return path.relative(root, p).split(path.sep).join('/');
}

export async function listFilesRecursive(dir: string, opts: ListFilesOptions = {}): Promise<string[]> {
  const {
    ignore = ['.git', 'node_modules', '.sneakoscope/arenas', '.sneakoscope/tmp'],
    maxFiles = 50000,
    maxDepth = 40,
  } = opts;
  const out: string[] = [];
  async function walk(d: string, depth: number): Promise<void> {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const fp = path.join(d, e.name);
      const rp = rel(dir, fp);
      if (ignore.some((ig) => rp === ig || rp.startsWith(`${ig}/`))) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) await walk(fp, depth + 1);
      else if (e.isFile()) out.push(fp);
    }
  }
  await walk(dir, 0);
  return out;
}

export async function which(cmd: string): Promise<string | null> {
  const paths = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const p of paths) {
    for (const ext of exts) {
      const candidate = path.join(p, `${cmd}${ext}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

export class TailBuffer {
  private readonly limit: number;
  private parts: Buffer[];
  private bytes: number;
  private totalBytes: number;
  private truncatedFlag: boolean;

  constructor(limitBytes?: number) {
    this.limit = Math.max(1024, limitBytes ?? DEFAULT_PROCESS_TAIL_BYTES);
    this.parts = [];
    this.bytes = 0;
    this.totalBytes = 0;
    this.truncatedFlag = false;
  }

  push(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.parts.push(buf);
    this.bytes += buf.length;
    this.totalBytes += buf.length;
    while (this.bytes > this.limit && this.parts.length) {
      const first = this.parts[0];
      const excess = this.bytes - this.limit;
      this.truncatedFlag = true;
      if (!first || first.length <= excess) {
        const head = this.parts.shift();
        if (head) this.bytes -= head.length;
      } else {
        this.parts[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }

  text(): string {
    return Buffer.concat(this.parts, this.bytes).toString('utf8');
  }

  snapshot(): TailBufferSnapshot {
    return {
      text: this.text(),
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      truncated: this.truncatedFlag,
    };
  }

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  get totalBytesCounted(): number {
    return this.totalBytes;
  }
}

interface ActiveDetachedProcessGroup {
  pid: number;
  child: ReturnType<typeof spawn>;
}

const activeDetachedProcessGroups = new Map<number, ActiveDetachedProcessGroup>();
let processGroupLifecycleHandlersInstalled = false;
let relayingParentSignal = false;

export function registerDetachedProcessGroup(child: ReturnType<typeof spawn>): () => void {
  const pid = child.pid;
  if (process.platform === 'win32' || !pid) return () => {};
  const group = { pid, child };
  activeDetachedProcessGroups.set(pid, group);
  installProcessGroupLifecycleHandlers();
  return () => {
    if (activeDetachedProcessGroups.get(pid) !== group) return;
    activeDetachedProcessGroups.delete(pid);
    if (activeDetachedProcessGroups.size === 0) uninstallProcessGroupLifecycleHandlers();
  };
}

function installProcessGroupLifecycleHandlers(): void {
  if (processGroupLifecycleHandlersInstalled || process.platform === 'win32') return;
  processGroupLifecycleHandlersInstalled = true;
  process.on('exit', terminateRegisteredProcessGroups);
  // Run before existing once listeners remove themselves so rawListeners still
  // reflects whether Node's default signal termination was already suppressed.
  process.prependListener('SIGHUP', handleParentSighup);
  process.prependListener('SIGINT', handleParentSigint);
  process.prependListener('SIGTERM', handleParentSigterm);
}

function uninstallProcessGroupLifecycleHandlers(): void {
  if (!processGroupLifecycleHandlersInstalled) return;
  processGroupLifecycleHandlersInstalled = false;
  process.off('exit', terminateRegisteredProcessGroups);
  process.off('SIGHUP', handleParentSighup);
  process.off('SIGINT', handleParentSigint);
  process.off('SIGTERM', handleParentSigterm);
}

function handleParentSighup(): void {
  relayParentSignal('SIGHUP', handleParentSighup);
}

function handleParentSigint(): void {
  relayParentSignal('SIGINT', handleParentSigint);
}

function handleParentSigterm(): void {
  relayParentSignal('SIGTERM', handleParentSigterm);
}

function relayParentSignal(signal: 'SIGHUP' | 'SIGINT' | 'SIGTERM', ownHandler: () => void): void {
  if (relayingParentSignal) return;
  terminateRegisteredProcessGroups();
  if (process.rawListeners(signal).some((listener) => listener !== ownHandler)) return;
  relayingParentSignal = true;
  uninstallProcessGroupLifecycleHandlers();
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(signal === 'SIGHUP' ? 129 : signal === 'SIGINT' ? 130 : 143);
  }
  setImmediate(() => {
    relayingParentSignal = false;
    if (activeDetachedProcessGroups.size > 0) installProcessGroupLifecycleHandlers();
  });
}

function terminateRegisteredProcessGroups(): void {
  for (const group of [...activeDetachedProcessGroups.values()]) {
    if (activeDetachedProcessGroups.get(group.pid) !== group) continue;
    try {
      process.kill(-group.pid, 'SIGKILL');
      continue;
    } catch {}
    try {
      group.child.kill('SIGKILL');
    } catch {}
  }
}

export function runProcess(
  command: string,
  args: readonly string[],
  options: RunProcessOptions = {}
): Promise<RunProcessResult> {
  return new Promise<RunProcessResult>((resolve) => {
    const tailBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_TAIL_BYTES;
    const stdoutTail = new TailBuffer(tailBytes);
    const stderrTail = new TailBuffer(tailBytes);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    let killedByTimeout = false;
    let spawnRegistrationFailed = false;
    let settled = false;
    let processTreeCleanup: Promise<void> | null = null;
    let stdoutStream: WriteStream | null = null;
    let stderrStream: WriteStream | null = null;

    const spawnOptions: Parameters<typeof spawn>[2] = {
      cwd: options.cwd || process.cwd(),
      shell: false,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    };
    if (options.envMode === 'replace') {
      spawnOptions.env = { ...(options.env || {}) };
    } else if (options.env) {
      spawnOptions.env = { ...process.env, ...options.env };
    }

    const child = spawn(command, args, spawnOptions);
    const unregisterDetachedProcessGroup = registerDetachedProcessGroup(child);
    const pausedForSpawnRegistration = Boolean(
      options.onSpawn
        && child.pid
        && process.platform !== 'win32'
        && child.kill('SIGSTOP')
    );

    const finish = async (result: RunProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await processTreeCleanup;
      unregisterDetachedProcessGroup();
      try {
        await stdoutStream?.end?.();
      } catch {}
      try {
        await stderrStream?.end?.();
      } catch {}
      resolve(result);
    };

    if (options.stdoutFile) {
      fs.mkdirSync(path.dirname(options.stdoutFile), { recursive: true });
      stdoutStream = fs.createWriteStream(options.stdoutFile, { flags: 'a' });
    }
    if (options.stderrFile) {
      fs.mkdirSync(path.dirname(options.stderrFile), { recursive: true });
      stderrStream = fs.createWriteStream(options.stderrFile, { flags: 'a' });
    }

    const timer = setTimeout(() => {
      killedByTimeout = true;
      processTreeCleanup = terminateProcessTree(child.pid, child);
    }, timeoutMs);
    timer.unref?.();

    child.stdout?.on('data', (d: Buffer) => {
      stdoutTail.push(d);
      stdoutStream?.write(d);
      options.onStdout?.(d.toString());
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail.push(d);
      stderrStream?.write(d);
      options.onStderr?.(d.toString());
    });
    child.on('error', (err: Error) =>
      void finish({
        code: -1,
        pid: child.pid,
        stdout: stdoutTail.text(),
        stderr: `${stderrTail.text()}${err.message}`,
        stdoutBytes: stdoutTail.totalBytesCounted,
        stderrBytes: stderrTail.totalBytesCounted,
        truncated: stdoutTail.truncated || stderrTail.truncated,
        timedOut: killedByTimeout,
        ...(spawnRegistrationFailed ? { spawnRegistrationFailed: true } : {}),
      })
    );
    child.on('close', (code: number | null) =>
      void finish({
        code: killedByTimeout ? 124 : code,
        pid: child.pid,
        stdout: stdoutTail.text(),
        stderr: stderrTail.text(),
        stdoutBytes: stdoutTail.totalBytesCounted,
        stderrBytes: stderrTail.totalBytesCounted,
        truncated: stdoutTail.truncated || stderrTail.truncated,
        timedOut: killedByTimeout,
        ...(spawnRegistrationFailed ? { spawnRegistrationFailed: true } : {}),
      })
    );

    void (async () => {
      if (options.onSpawn) {
        const pid = child.pid;
        if (!pid) {
          spawnRegistrationFailed = true;
          child.kill('SIGKILL');
          return;
        }
        try {
          await options.onSpawn(pid);
        } catch {
          spawnRegistrationFailed = true;
          processTreeCleanup = terminateProcessTree(pid, child);
          await processTreeCleanup;
          return;
        }
        if (pausedForSpawnRegistration) child.kill('SIGCONT');
      }
      if (options.input !== undefined && child.stdin) child.stdin.end(options.input);
    })();
  });
}

/**
 * Escalating teardown for a spawned process *tree*, not a single pid.
 *
 * A worker that spawns its own children is only reapable through its process
 * group: signalling the leader alone leaves the grandchildren running, and on
 * this platform an orphaned `codex` holds hundreds of megabytes resident for as
 * long as the machine is up. Every long-lived spawner must route its teardown
 * here rather than calling `child.kill` directly.
 */
export async function terminateProcessTree(pid: number | undefined, child: ReturnType<typeof spawn>): Promise<void> {
  signalProcessTree(pid, 'SIGTERM', child);
  if (await waitForProcessTreeExit(pid, 1_000)) return;
  signalProcessTree(pid, 'SIGKILL', child);
  await waitForProcessTreeExit(pid, 1_500);
}

function signalProcessTree(pid: number | undefined, signal: NodeJS.Signals, child: ReturnType<typeof spawn>): void {
  if (pid && process.platform !== 'win32') {
    try {
      process.kill(-pid, signal);
      return;
    } catch {}
  }
  try {
    child.kill(signal);
  } catch {}
}

async function waitForProcessTreeExit(pid: number | undefined, timeoutMs: number): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processTreeIsAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return !processTreeIsAlive(pid);
}

function processTreeIsAlive(pid: number): boolean {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 0);
      return true;
    } catch {}
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readStdin(): Promise<string> {
  let data = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

export function managedSksTmpRoot(baseDir = os.tmpdir()): string {
  return path.join(baseDir, 'sks');
}

export function tmpdir(prefix = 'sks-'): string {
  const base = managedSksTmpRoot();
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, prefix));
}

export async function withScratchDir<T>(prefix = 'sks-', fn: (dir: string) => Promise<T>, opts: { baseDir?: string; keep?: boolean } = {}): Promise<T> {
  const base = opts.baseDir || managedSksTmpRoot();
  await fsp.mkdir(base, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(base, prefix));
  try {
    return await fn(dir);
  } finally {
    if (!opts.keep) await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function withScratchDirSync<T>(prefix = 'sks-', fn: (dir: string) => T, opts: { baseDir?: string; keep?: boolean } = {}): T {
  const base = opts.baseDir || managedSksTmpRoot();
  fs.mkdirSync(base, { recursive: true });
  const dir = fs.mkdtempSync(path.join(base, prefix));
  try {
    return fn(dir);
  } finally {
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function fileSize(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size;
  } catch {
    return 0;
  }
}

export async function dirSize(dir: string, opts: ListFilesOptions = {}): Promise<number> {
  let total = 0;
  const files = await listFilesRecursive(dir, opts);
  for (const f of files) total += await fileSize(f);
  return total;
}

export function formatBytes(bytes: unknown): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export async function rmrf(p: string): Promise<void> {
  await fsp.rm(p, { recursive: true, force: true });
}
