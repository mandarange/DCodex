import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import { assertTestHomeWriteAllowed } from '../fsx.js';
import {
  ensureConfinedDirectory,
  inspectConfinedPath,
  isLexicallyConfined
} from '../managed-path-safety.js';

export type PrivateCredentialFileSnapshot = {
  bytes: Buffer;
  sha256: string;
};

export type PrivateCredentialFileErrorCode =
  | 'missing'
  | 'outside_boundary'
  | 'not_regular'
  | 'mode_not_0600'
  | 'owner_mismatch'
  | 'too_large'
  | 'identity_mismatch'
  | 'changed_during_verification';

export class PrivateCredentialFileError extends Error {
  readonly code: PrivateCredentialFileErrorCode;
  readonly file: string;
  readonly label: string;

  constructor(code: PrivateCredentialFileErrorCode, file: string, label: string) {
    super(`${label}_${code}:${file}`);
    this.name = 'PrivateCredentialFileError';
    this.code = code;
    this.file = file;
    this.label = label;
  }
}

export async function readPrivateCredentialFile(
  boundary: string,
  file: string,
  label: string,
  opts: { maxBytes?: number } = {}
): Promise<PrivateCredentialFileSnapshot> {
  if (opts.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0)) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  if (!isLexicallyConfined(boundary, file)) throw new PrivateCredentialFileError('outside_boundary', file, label);
  const inspected = await inspectConfinedPath(boundary, file);
  if (!inspected.exists) throw new PrivateCredentialFileError('missing', file, label);
  if (inspected.leafSymlink || !inspected.stat?.isFile()) {
    throw new PrivateCredentialFileError('not_regular', file, label);
  }
  if ((inspected.stat.mode & 0o777) !== 0o600) {
    throw new PrivateCredentialFileError('mode_not_0600', file, label);
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && inspected.stat.uid !== expectedUid) {
    throw new PrivateCredentialFileError('owner_mismatch', file, label);
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()
      || before.dev !== inspected.stat.dev
      || before.ino !== inspected.stat.ino
      || (before.mode & 0o777) !== 0o600
      || (expectedUid !== null && before.uid !== expectedUid)) {
      throw new PrivateCredentialFileError('identity_mismatch', file, label);
    }
    if (opts.maxBytes !== undefined && before.size > opts.maxBytes) {
      throw new PrivateCredentialFileError('too_large', file, label);
    }
    const bytes = opts.maxBytes === undefined
      ? await handle.readFile()
      : await readBounded(handle, opts.maxBytes, file, label);
    const after = await handle.stat();
    const pathAfter = await inspectConfinedPath(boundary, file);
    if (!pathAfter.exists
      || pathAfter.leafSymlink
      || !pathAfter.stat?.isFile()
      || (after.mode & 0o777) !== 0o600
      || (pathAfter.stat.mode & 0o777) !== 0o600
      || (expectedUid !== null && (after.uid !== expectedUid || pathAfter.stat.uid !== expectedUid))
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || after.dev !== pathAfter.stat.dev
      || after.ino !== pathAfter.stat.ino) {
      throw new PrivateCredentialFileError('changed_during_verification', file, label);
    }
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(
  handle: Awaited<ReturnType<typeof fsp.open>>,
  maxBytes: number,
  file: string,
  label: string
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > maxBytes) throw new PrivateCredentialFileError('too_large', file, label);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, total);
}

export async function hardenPrivateCredentialFileMode(
  boundary: string,
  file: string,
  label: string
): Promise<void> {
  if (!isLexicallyConfined(boundary, file)) throw new PrivateCredentialFileError('outside_boundary', file, label);
  const inspected = await inspectConfinedPath(boundary, file);
  if (!inspected.exists) throw new PrivateCredentialFileError('missing', file, label);
  if (inspected.leafSymlink || !inspected.stat?.isFile()) {
    throw new PrivateCredentialFileError('not_regular', file, label);
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && inspected.stat.uid !== expectedUid) {
    throw new PrivateCredentialFileError('owner_mismatch', file, label);
  }
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile()
      || before.dev !== inspected.stat.dev
      || before.ino !== inspected.stat.ino
      || (expectedUid !== null && before.uid !== expectedUid)) {
      throw new PrivateCredentialFileError('identity_mismatch', file, label);
    }
    await handle.chmod(0o600);
    const after = await handle.stat();
    if ((after.mode & 0o777) !== 0o600 || after.dev !== before.dev || after.ino !== before.ino) {
      throw new PrivateCredentialFileError('identity_mismatch', file, label);
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writePrivateTextAtomic(
  boundary: string,
  file: string,
  text: string,
  label: string
): Promise<void> {
  if (!isLexicallyConfined(boundary, file)) throw new PrivateCredentialFileError('outside_boundary', file, label);
  assertTestHomeWriteAllowed(file);
  await ensureConfinedDirectory(boundary, path.dirname(file));
  const before = await inspectConfinedPath(boundary, file);
  if (before.exists && (before.leafSymlink || !before.stat?.isFile())) {
    throw new PrivateCredentialFileError('not_regular', file, label);
  }
  if (before.stat && (before.stat.mode & 0o777) !== 0o600) {
    throw new PrivateCredentialFileError('mode_not_0600', file, label);
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (before.stat && expectedUid !== null && before.stat.uid !== expectedUid) {
    throw new PrivateCredentialFileError('owner_mismatch', file, label);
  }
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  );
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.chmod(0o600);
    const tempStat = await handle.stat();
    if (!tempStat.isFile()
      || (tempStat.mode & 0o777) !== 0o600
      || (expectedUid !== null && tempStat.uid !== expectedUid)) {
      throw new PrivateCredentialFileError('identity_mismatch', temp, label);
    }
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const current = await inspectConfinedPath(boundary, file);
    const unchanged = before.exists === current.exists
      && (!before.exists || (
        !current.leafSymlink
        && current.stat?.isFile() === true
        && before.stat?.dev === current.stat.dev
        && before.stat?.ino === current.stat.ino
      ));
    if (!unchanged) throw new PrivateCredentialFileError('changed_during_verification', file, label);
    await fsp.rename(temp, file);
    const parentHandle = await fsp.open(path.dirname(file), fsConstants.O_RDONLY);
    try {
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    await readPrivateCredentialFile(boundary, file, label);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}

export async function createPrivateTextExclusive(
  boundary: string,
  file: string,
  text: string,
  label: string,
  opts: { beforePublish?: (tempPath: string) => void | Promise<void> } = {}
): Promise<boolean> {
  if (!isLexicallyConfined(boundary, file)) throw new PrivateCredentialFileError('outside_boundary', file, label);
  assertTestHomeWriteAllowed(file);
  await ensureConfinedDirectory(boundary, path.dirname(file));
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString('hex')}.claim`
  );
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
  try {
    handle = await fsp.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await opts.beforePublish?.(temp);
    await fsp.link(temp, file);
    await readPrivateCredentialFile(boundary, file, label);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'EEXIST') return false;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.rm(temp, { force: true }).catch(() => undefined);
  }
}
