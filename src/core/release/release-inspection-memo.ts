/**
 * Process-local memo for the expensive, *pure* release inspections.
 *
 * The release proof path re-derives the same facts many times inside one
 * process: `inspectMainPushGuard` runs the whole pack/physical inspection on
 * every call, the push receipt revalidates the guard it just ran, and the
 * canonical tests drive both dozens of times to exercise blocker branches.
 * Each of those derivations is a `git`/`tar`/`npm` spawn, and spawn latency —
 * not CPU — is what makes the release test corpus slow.
 *
 * Two rules keep this a speedup and never a weakened proof:
 *
 *  1. **Content-addressed keys only.** A key carries the identity of the bytes
 *     it describes: `dev:ino:size:mtime:ctime` for a file, a commit SHA for a
 *     git tree (git objects are immutable), a digest of the command inputs for
 *     a process result. Changed input bytes can never reuse a memoized value.
 *  2. **Never persisted.** The memo lives in one process's heap. A fresh
 *     release run always recomputes from real bytes; nothing on disk can make a
 *     later run trust an earlier one's conclusion.
 *
 * Set `SKS_RELEASE_INSPECTION_MEMO=0` to disable it entirely and prove that a
 * gate's verdict is identical with and without reuse.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { SksLruCache } from '../perf/lru-cache.js'

export const RELEASE_INSPECTION_MEMO_ENV = 'SKS_RELEASE_INSPECTION_MEMO'
const MAX_ENTRIES_PER_BUCKET = 64

const buckets = new Map<string, SksLruCache<unknown>>()

export function releaseInspectionMemoEnabled(): boolean {
  return process.env[RELEASE_INSPECTION_MEMO_ENV] !== '0'
}

/**
 * Identity of the exact bytes at `file`, or null when it is not a regular file
 * (a missing or replaced path must always recompute rather than reuse).
 */
export function fileIdentity(file: string): string | null {
  try {
    // Nanosecond stamps: a same-size rewrite inside one millisecond must still
    // read as different bytes, or a memo could answer for the previous content.
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
  } catch {
    return null
  }
}

/**
 * Identity of the executable `command` resolves to on the current PATH.
 *
 * A spawn's result is a function of the tool as much as of its inputs — a gate
 * test can put a different `gh` or `tar` in front on PATH and must observe the
 * new verdict. Returns null when the tool cannot be resolved to a regular file,
 * which poisons the key and forces a real spawn.
 */
export function toolIdentity(command: string): string | null {
  const searchPath = String(process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of searchPath) {
    const candidate = path.join(dir, command)
    // Follow links: what a spawn actually runs is the link target, and `npm`
    // on a version-managed toolchain is always a symlink. The resolved path is
    // part of the key, so a retargeted link still reads as a different tool.
    let resolved: string
    try {
      resolved = fs.realpathSync(candidate)
    } catch {
      continue
    }
    const identity = fileIdentity(resolved)
    if (identity) return `${candidate}>${resolved}#${identity}`
  }
  return null
}

/** Stable digest of arbitrary key parts. `null` parts poison the key. */
export function inspectionKey(...parts: Array<string | number | null | undefined>): string | null {
  if (parts.some((part) => part === null || part === undefined)) return null
  return crypto.createHash('sha256').update(parts.map(String).join('\0')).digest('hex')
}

/**
 * Return the memoized value for `key`, computing it once per process.
 * A null key means "not addressable" and always recomputes.
 */
export function memoizeReleaseInspection<T>(
  bucket: string,
  key: string | null,
  compute: () => T,
  clone: (value: T) => T = defaultClone
): T {
  if (!key || !releaseInspectionMemoEnabled()) return compute()
  let cache = buckets.get(bucket) as SksLruCache<T> | undefined
  if (!cache) {
    cache = new SksLruCache<T>(MAX_ENTRIES_PER_BUCKET)
    buckets.set(bucket, cache as SksLruCache<unknown>)
  }
  const hit = cache.get(key)
  if (hit !== null) return clone(hit)
  const value = compute()
  cache.set(key, value)
  return clone(value)
}

/** Callers must never observe a shared mutable value from the memo. */
function defaultClone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

/** Buffers survive `structuredClone` as plain Uint8Array; keep them Buffers. */
export function cloneBuffer<T extends Uint8Array>(value: T): T {
  return Buffer.from(value) as unknown as T
}

export function clearReleaseInspectionMemo(): void {
  buckets.clear()
}
