/**
 * Fingerprint-keyed reuse for the whole-tree content digests the release path
 * recomputes constantly.
 *
 * `releaseAuthorizationSnapshot` reads and hashes every source, packaged, and
 * dist file — about six thousand files, six seconds — and a full release check
 * calls it five times (twice inside the canonical test runner alone) while the
 * tree is provably identical. Nothing about that repetition adds proof.
 *
 * The cache key is a stat fingerprint of the exact same file list the digest
 * covers: path, size, nanosecond mtime, and inode. Any edit, replacement, or
 * added/removed file changes the fingerprint and forces a real rehash, so the
 * digest a caller receives is always one that was computed from these bytes.
 * The stored value is a digest, never a verdict.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const CONTENT_DIGEST_CACHE_SCHEMA = 'sks.content-digest-cache.v1'
export const CONTENT_DIGEST_CACHE_ENV = 'SKS_RELEASE_CONTENT_DIGEST_CACHE'

interface ContentDigestCacheDocument {
  schema: typeof CONTENT_DIGEST_CACHE_SCHEMA
  entries: Record<string, { fingerprint: string; value: unknown; recorded_at: string }>
}

const processMemo = new Map<string, { fingerprint: string; value: unknown }>()

export function contentDigestCacheEnabled(): boolean {
  return process.env[CONTENT_DIGEST_CACHE_ENV] !== '0'
}

export function contentDigestCachePath(root: string): string {
  return path.join(root, '.sneakoscope', 'cache', 'release-digests.json')
}

/** Identity of a file list's bytes, derived without reading any of them. */
export function statFingerprint(root: string, files: readonly string[]): string {
  const hash = crypto.createHash('sha256')
  for (const file of files) {
    let stat: fs.BigIntStats
    try {
      stat = fs.statSync(path.isAbsolute(file) ? file : path.join(root, file), { bigint: true })
    } catch {
      hash.update(`${file}\0missing\0`)
      continue
    }
    hash.update(`${file}\0${stat.size}\0${stat.mtimeNs}\0${stat.ino}\0`)
  }
  return hash.digest('hex')
}

export function cachedByFingerprint<T>(root: string, bucket: string, fingerprint: string, compute: () => T): T {
  if (!contentDigestCacheEnabled()) return compute()
  const memoKey = `${path.resolve(root)}\0${bucket}`
  const memo = processMemo.get(memoKey)
  if (memo?.fingerprint === fingerprint) return structuredClone(memo.value) as T
  const document = readCache(root)
  const stored = document.entries[bucket]
  if (stored && stored.fingerprint === fingerprint) {
    processMemo.set(memoKey, { fingerprint, value: stored.value })
    return structuredClone(stored.value) as T
  }
  const value = compute()
  processMemo.set(memoKey, { fingerprint, value })
  writeCache(root, bucket, fingerprint, value)
  return value
}

export function clearContentDigestProcessMemo(): void {
  processMemo.clear()
}

function readCache(root: string): ContentDigestCacheDocument {
  try {
    const parsed = JSON.parse(fs.readFileSync(contentDigestCachePath(root), 'utf8')) as ContentDigestCacheDocument
    if (parsed?.schema === CONTENT_DIGEST_CACHE_SCHEMA && parsed.entries && typeof parsed.entries === 'object') return parsed
  } catch {}
  return { schema: CONTENT_DIGEST_CACHE_SCHEMA, entries: {} }
}

function writeCache(root: string, bucket: string, fingerprint: string, value: unknown): void {
  const file = contentDigestCachePath(root)
  try {
    const document = readCache(root)
    document.entries[bucket] = { fingerprint, value, recorded_at: new Date().toISOString() }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`)
    fs.renameSync(temp, file)
  } catch {
    // A read-only or racing workspace only costs the next caller a real rehash.
  }
}
