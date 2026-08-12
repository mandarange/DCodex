/**
 * Filesystem primitives the commit ordering depends on.
 *
 * These are separated from the commit path because each one encodes a durability
 * fact that is easy to lose in a refactor: a rename is not durable until the
 * directory entry is flushed, and a cross-device rename is not atomic at all.
 */
import fsp from 'node:fs/promises';
import { writeBinaryAtomic } from '../../../fsx.js';

/**
 * A rename only becomes durable once the directory entry is flushed. Without
 * this, a power loss after the rename can leave the pointer naming a generation
 * path whose directory entry never reached the disk. Platforms that refuse to
 * open a directory are skipped rather than failing the compile.
 */
export async function syncDirectory(dir: string): Promise<void> {
  const handle = await fsp.open(dir, 'r').catch(() => null);
  if (!handle) return;
  try {
    await handle.sync();
  } catch {
    /* filesystem does not support directory fsync */
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A cross-device rename cannot be atomic, so on `EXDEV` the bytes are rewritten
 * through the atomic writer instead of being copied in place. Falling back to a
 * plain copy would put a partially written file at the generation path — exactly
 * the half-built artifact the ordering exists to prevent.
 */
export async function renameOrRewrite(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
    return;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code !== 'EXDEV') throw error;
  }
  const bytes = await fsp.readFile(from);
  await writeBinaryAtomic(to, bytes);
  await fsp.rm(from, { force: true });
}

/**
 * `null` means the file is absent. Unparseable bytes come back as a sentinel
 * object rather than `null` so callers cannot confuse "nothing is here" with
 * "something is here and it is corrupt" — those two states have opposite
 * consequences for the pointer.
 */
export async function readJsonFile(target: string): Promise<unknown | null> {
  let text: string;
  try {
    text = await fsp.readFile(target, 'utf8');
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { __unparseable: true };
  }
}
