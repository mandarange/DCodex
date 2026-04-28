import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const PACKAGE_VERSION = '0.6.52';
export const DEFAULT_PROCESS_TAIL_BYTES = 256 * 1024;
export const DEFAULT_PROCESS_TIMEOUT_MS = 30 * 60 * 1000;

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function randomId(len = 6) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

export async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

export async function ensureDir(p) {
  await fsp.mkdir(p, { recursive: true });
}

export async function readText(p, fallback = undefined) {
  try { return await fsp.readFile(p, 'utf8'); }
  catch (err) { if (fallback !== undefined) return fallback; throw err; }
}

export async function writeTextAtomic(p, text) {
  await ensureDir(path.dirname(p));
  try {
    if (await fsp.readFile(p, 'utf8') === text) return;
  } catch {}
  const tmp = `${p}.${process.pid}.${randomId(6)}.tmp`;
  try {
    const handle = await fsp.open(tmp, 'w');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync().catch(() => {});
    } finally {
      await handle.close().catch(() => {});
    }
    await fsp.rename(tmp, p);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (!canFallbackToDirectWrite(err)) throw err;
    try {
      await fsp.writeFile(p, text, 'utf8');
    } catch (fallbackErr) {
      fallbackErr.message = `Atomic write failed (${err.code || err.message}); direct write fallback failed: ${fallbackErr.message}`;
      throw fallbackErr;
    }
  }
}

function canFallbackToDirectWrite(err) {
  return ['EACCES', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EXDEV'].includes(err?.code);
}

export async function readJson(p, fallback = undefined) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); }
  catch (err) { if (fallback !== undefined) return fallback; throw err; }
}

export async function writeJsonAtomic(p, data) {
  await writeTextAtomic(p, `${JSON.stringify(data, null, 2)}\n`);
}

export async function appendJsonl(p, obj) {
  await ensureDir(path.dirname(p));
  await fsp.appendFile(p, `${JSON.stringify(obj)}\n`, 'utf8');
}

export async function appendJsonlBounded(p, obj, maxBytes = 5 * 1024 * 1024) {
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
      const marker = Buffer.from(JSON.stringify({ ts: nowIso(), type: 'log.rotated', kept_tail_bytes: buf.length }) + '\n');
      await writeTextAtomic(p, `${marker.toString('utf8')}${buf.toString('utf8').replace(/^.*?\n/, '')}`);
    } finally {
      await handle.close().catch(() => {});
    }
  } catch {}
}

export async function copyFileIfMissing(src, dest) {
  if (await exists(dest)) return false;
  await ensureDir(path.dirname(dest));
  await fsp.copyFile(src, dest);
  return true;
}

export async function mergeManagedBlock(file, markerName, content) {
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

export function packageRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
}

export function cwd() { return process.cwd(); }

export async function findUp(start, names) {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    if (dir === root) return null;
    dir = path.dirname(dir);
  }
}

export async function projectRoot(start = process.cwd()) {
  const resolved = path.resolve(start);
  const sine = await findUp(resolved, ['.sneakoscope', '.dcodex']);
  if (sine) {
    const root = path.dirname(sine);
    if (root !== path.parse(root).root) return root;
  }
  const git = await findUp(resolved, ['.git']);
  if (git) {
    const root = path.dirname(git);
    if (root !== path.parse(root).root) return root;
  }
  return resolved;
}

export async function isGitRepo(root = process.cwd()) {
  return exists(path.join(root, '.git'));
}

export function rel(root, p) {
  return path.relative(root, p).split(path.sep).join('/');
}

export async function listFilesRecursive(dir, opts = {}) {
  const {
    ignore = ['.git', 'node_modules', '.sneakoscope/arenas', '.sneakoscope/tmp'],
    maxFiles = 50000,
    maxDepth = 40
  } = opts;
  const out = [];
  async function walk(d, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries = [];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const p = path.join(d, e.name);
      const rp = rel(dir, p);
      if (ignore.some((ig) => rp === ig || rp.startsWith(`${ig}/`))) continue;
      if (e.isSymbolicLink?.()) continue;
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) out.push(p);
    }
  }
  await walk(dir, 0);
  return out;
}

export async function which(cmd) {
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

class TailBuffer {
  constructor(limitBytes) {
    this.limit = Math.max(1024, limitBytes || DEFAULT_PROCESS_TAIL_BYTES);
    this.parts = [];
    this.bytes = 0;
    this.totalBytes = 0;
    this.truncated = false;
  }
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this.parts.push(buf);
    this.bytes += buf.length;
    this.totalBytes += buf.length;
    while (this.bytes > this.limit && this.parts.length) {
      const first = this.parts[0];
      const excess = this.bytes - this.limit;
      this.truncated = true;
      if (first.length <= excess) {
        this.parts.shift();
        this.bytes -= first.length;
      } else {
        this.parts[0] = first.subarray(excess);
        this.bytes -= excess;
      }
    }
  }
  text() { return Buffer.concat(this.parts, this.bytes).toString('utf8'); }
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const tailBytes = options.maxOutputBytes ?? DEFAULT_PROCESS_TAIL_BYTES;
    const stdoutTail = new TailBuffer(tailBytes);
    const stderrTail = new TailBuffer(tailBytes);
    const timeoutMs = options.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS;
    let killedByTimeout = false;
    let settled = false;
    let stdoutStream = null;
    let stderrStream = null;

    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      shell: false,
      stdio: [options.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe']
    });
    if (options.input !== undefined && child.stdin) { child.stdin.end(options.input); }

    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { await stdoutStream?.end?.(); } catch {}
      try { await stderrStream?.end?.(); } catch {}
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
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (d) => {
      stdoutTail.push(d);
      stdoutStream?.write(d);
      options.onStdout?.(d.toString());
    });
    child.stderr.on('data', (d) => {
      stderrTail.push(d);
      stderrStream?.write(d);
      options.onStderr?.(d.toString());
    });
    child.on('error', (err) => finish({
      code: -1,
      stdout: stdoutTail.text(),
      stderr: `${stderrTail.text()}${err.message}`,
      stdoutBytes: stdoutTail.totalBytes,
      stderrBytes: stderrTail.totalBytes,
      truncated: stdoutTail.truncated || stderrTail.truncated,
      timedOut: killedByTimeout
    }));
    child.on('close', (code) => finish({
      code: killedByTimeout ? 124 : code,
      stdout: stdoutTail.text(),
      stderr: stderrTail.text(),
      stdoutBytes: stdoutTail.totalBytes,
      stderrBytes: stderrTail.totalBytes,
      truncated: stdoutTail.truncated || stderrTail.truncated,
      timedOut: killedByTimeout
    }));
  });
}

export async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

export function tmpdir(prefix = 'sks-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export async function fileSize(p) {
  try { return (await fsp.stat(p)).size; } catch { return 0; }
}

export async function dirSize(dir, opts = {}) {
  let total = 0;
  const files = await listFilesRecursive(dir, opts);
  for (const f of files) total += await fileSize(f);
  return total;
}

export function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = Number(bytes) || 0;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

export async function rmrf(p) {
  await fsp.rm(p, { recursive: true, force: true });
}
