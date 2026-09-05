import fsp from 'node:fs/promises'
import path from 'node:path'
import { readJson, runProcess, writeJsonAtomic } from '../fsx.js'

const CODE_PACK_METADATA_PATHS = new Set([
  '.sneakoscope/wiki/code-pack.json',
  '.sneakoscope/wiki/code-pack.prev.json',
  '.sneakoscope/wiki/code-navigation-manifest.json'
])
const COMMIT_MARKER = '@SKS-CODE-PACK'
const ADVISORY_CACHE_SCHEMA = 'sks.code-pack-head-freshness-cache.v1'
const ADVISORY_CACHE_PATH = path.join('.sneakoscope', 'cache', 'code-pack-head-freshness.json')

export type CodePackHeadFreshnessReason =
  | 'exact_head'
  | 'advisory_cache'
  | 'metadata_only_history'
  | 'source_change_history'
  | 'pack_not_ancestor'
  | 'invalid_pack_sha'
  | 'git_failed'
  | 'git_timeout'
  | 'history_truncated'
  | 'history_parse_invalid'

export interface CodePackHeadFreshness {
  fresh: boolean
  conclusive: boolean
  reason: CodePackHeadFreshnessReason
  current_sha: string | null
  pack_sha: string | null
  metadata_only_drift: boolean
  changed_paths: string[]
}

export async function inspectCodePackHeadFreshness(
  root: string,
  packShaInput: unknown,
  opts: { timeoutMs?: number; advisoryCache?: boolean } = {}
): Promise<CodePackHeadFreshness> {
  const timeoutMs = Math.max(1, Math.floor(opts.timeoutMs ?? 5_000))
  const startedAt = Date.now()
  const packSha = normalizeGitSha(packShaInput)
  const fastHead = await readGitHeadFromAdminFiles(root)
  if (!packSha) return staleWithCurrentHead(root, null, timeoutMs, fastHead, false, 'invalid_pack_sha')
  if (fastHead === packSha) return freshness(true, true, 'exact_head', fastHead, packSha, false, [])

  // Only the non-blocking hook consumes this cache. Authoritative wiki
  // validation always replays Git history and never trusts advisory state.
  if (opts.advisoryCache && fastHead) {
    const cached = await readAdvisoryCache(root, packSha, fastHead)
    if (cached) return cached
  }

  // One common-path Git process returns HEAD plus every committed path after
  // the pack was generated. Excluding all parents of packSha keeps packSha in
  // the walk (including a root commit), so its presence proves ancestry. We
  // keep scanning after the pack marker because a later merge can introduce
  // sibling-branch commits that Git orders after packSha. `-m` exposes merge
  // resolution paths and `--no-renames` makes touched paths auditable.
  const history = await runProcess('git', [
    '-c',
    'core.quotepath=true',
    'log',
    '--topo-order',
    '-m',
    '--no-ext-diff',
    `--format=${COMMIT_MARKER}%x09%H`,
    '--name-status',
    '--no-renames',
    'HEAD',
    '--not',
    `${packSha}^@`,
    '--'
  ], {
    cwd: root,
    timeoutMs,
    maxOutputBytes: 64 * 1024,
    env: gitEnvironment({
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C'
    })
  }).catch(() => null)

  if (!history || history.code !== 0 || history.timedOut) {
    return staleWithCurrentHead(
      root,
      packSha,
      remainingMs(startedAt, timeoutMs),
      fastHead,
      false,
      history?.timedOut ? 'git_timeout' : 'git_failed'
    )
  }

  const parsed = parseHistory(history.stdout, packSha)
  if (history.truncated || !parsed.currentSha || parsed.invalid) {
    const currentSha = parsed.currentSha
      || fastHead
      || await readCurrentHead(root, remainingMs(startedAt, timeoutMs))
    return freshness(
      false,
      false,
      history.truncated ? 'history_truncated' : 'history_parse_invalid',
      currentSha,
      packSha,
      false,
      parsed.changedPaths
    )
  }
  if (!parsed.sawPack) {
    return freshness(false, true, 'pack_not_ancestor', parsed.currentSha, packSha, false, parsed.changedPaths)
  }

  const metadataOnly = parsed.changedPaths.every((value) => CODE_PACK_METADATA_PATHS.has(value))
  const exactHead = parsed.currentSha === packSha
  const result = freshness(
    metadataOnly,
    true,
    metadataOnly ? 'metadata_only_history' : 'source_change_history',
    parsed.currentSha,
    packSha,
    metadataOnly && !exactHead,
    parsed.changedPaths
  )
  if (opts.advisoryCache && fastHead === parsed.currentSha) {
    await writeAdvisoryCache(root, result).catch(() => undefined)
  }
  return result
}

function parseHistory(stdout: string, packSha: string): {
  currentSha: string | null
  sawPack: boolean
  invalid: boolean
  changedPaths: string[]
} {
  let currentSha: string | null = null
  let activeCommit: string | null = null
  let sawPack = false
  let invalid = false
  const changedPaths: string[] = []
  const seenPaths = new Set<string>()

  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (line === '') continue
    const marker = line.match(/^@SKS-CODE-PACK\t([0-9a-f]{40,64})$/i)
    if (marker) {
      activeCommit = String(marker[1]).toLowerCase()
      currentSha ||= activeCommit
      if (activeCommit === packSha) sawPack = true
      continue
    }

    if (!activeCommit) {
      invalid = true
      break
    }
    const separator = line.indexOf('\t')
    const status = separator > 0 ? line.slice(0, separator) : ''
    const pathText = separator > 0 ? line.slice(separator + 1) : ''
    if (!/^[A-Z][0-9]*$/.test(status) || !pathText) {
      invalid = true
      break
    }
    if (activeCommit === packSha) continue
    // Do not trim Git paths: leading/trailing whitespace is meaningful and
    // must never be normalized into an allowlisted metadata path.
    for (const changedPath of pathText.split('\t')) {
      if (!changedPath || seenPaths.has(changedPath)) continue
      seenPaths.add(changedPath)
      changedPaths.push(changedPath)
    }
  }

  return { currentSha, sawPack, invalid, changedPaths }
}

async function readAdvisoryCache(
  root: string,
  packSha: string,
  currentSha: string
): Promise<CodePackHeadFreshness | null> {
  const cached: any = await readJson(path.join(root, ADVISORY_CACHE_PATH), null).catch(() => null)
  if (cached?.schema !== ADVISORY_CACHE_SCHEMA) return null
  if (normalizeGitSha(cached.pack_sha) !== packSha || normalizeGitSha(cached.current_sha) !== currentSha) return null
  const changedPaths = Array.isArray(cached.changed_paths)
    ? cached.changed_paths.filter((value: unknown): value is string => typeof value === 'string').slice(0, 64)
    : []
  const fresh = cached.fresh === true
  if (fresh && (cached.metadata_only_drift !== true || changedPaths.some((value: string) => !CODE_PACK_METADATA_PATHS.has(value)))) {
    return null
  }
  return freshness(fresh, true, 'advisory_cache', currentSha, packSha, fresh, changedPaths)
}

async function writeAdvisoryCache(root: string, result: CodePackHeadFreshness): Promise<void> {
  if (!result.pack_sha || !result.current_sha) return
  await writeJsonAtomic(path.join(root, ADVISORY_CACHE_PATH), {
    schema: ADVISORY_CACHE_SCHEMA,
    pack_sha: result.pack_sha,
    current_sha: result.current_sha,
    fresh: result.fresh,
    reason: result.reason,
    metadata_only_drift: result.metadata_only_drift,
    changed_paths: result.changed_paths.slice(0, 64),
    checked_at: new Date().toISOString()
  })
}

async function staleWithCurrentHead(
  root: string,
  packSha: string | null,
  timeoutMs: number,
  knownCurrentSha: string | null = null,
  conclusive = true,
  reason: CodePackHeadFreshnessReason = 'git_failed'
): Promise<CodePackHeadFreshness> {
  const currentSha = knownCurrentSha || await readCurrentHead(root, timeoutMs)
  return freshness(false, conclusive, reason, currentSha, packSha, false, [])
}

async function readCurrentHead(root: string, timeoutMs: number): Promise<string | null> {
  if (timeoutMs <= 0) return null
  const head = await runProcess('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    timeoutMs,
    maxOutputBytes: 4 * 1024,
    env: gitEnvironment({
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C'
    })
  }).catch(() => null)
  return head && head.code === 0 && !head.truncated ? normalizeGitSha(head.stdout) : null
}

async function readGitHeadFromAdminFiles(root: string): Promise<string | null> {
  const gitDir = await resolveGitDir(root)
  if (!gitDir) return null
  const headText = await readSmallText(path.join(gitDir, 'HEAD'), 4 * 1024)
  if (!headText) return null
  const detached = normalizeGitSha(headText)
  if (detached) return detached
  const symbolic = headText.match(/^ref:\s*(refs\/[^\r\n]+)\s*$/)
  const ref = symbolic ? String(symbolic[1]) : ''
  if (!safeGitRef(ref)) return null
  const commonDir = await resolveCommonDir(gitDir)
  for (const base of [...new Set([gitDir, commonDir])]) {
    const loose = await readLooseRef(base, ref)
    if (loose) return loose
  }
  return readPackedRef(commonDir, ref)
}

async function resolveGitDir(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git')
  const stat = await fsp.stat(dotGit).catch(() => null)
  if (!stat) return null
  if (stat.isDirectory()) return dotGit
  if (!stat.isFile()) return null
  const text = await readSmallText(dotGit, 4 * 1024)
  const match = text?.match(/^gitdir:\s*(.+?)\s*$/m)
  return match ? path.resolve(path.dirname(dotGit), String(match[1])) : null
}

async function resolveCommonDir(gitDir: string): Promise<string> {
  const text = await readSmallText(path.join(gitDir, 'commondir'), 4 * 1024)
  return text?.trim() ? path.resolve(gitDir, text.trim()) : gitDir
}

async function readLooseRef(base: string, ref: string): Promise<string | null> {
  const file = safeRefPath(base, ref)
  if (!file) return null
  return normalizeGitSha(await readSmallText(file, 4 * 1024))
}

async function readPackedRef(commonDir: string, ref: string): Promise<string | null> {
  const text = await readSmallText(path.join(commonDir, 'packed-refs'), 4 * 1024 * 1024)
  if (!text) return null
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue
    const separator = line.indexOf(' ')
    if (separator <= 0 || line.slice(separator + 1) !== ref) continue
    return normalizeGitSha(line.slice(0, separator))
  }
  return null
}

async function readSmallText(file: string, maxBytes: number): Promise<string | null> {
  const stat = await fsp.stat(file).catch(() => null)
  if (!stat?.isFile() || stat.size > maxBytes) return null
  return fsp.readFile(file, 'utf8').catch(() => null)
}

function safeGitRef(ref: string): boolean {
  return /^refs\/[A-Za-z0-9._/-]+$/.test(ref)
    && !ref.includes('..')
    && !ref.includes('//')
    && !ref.includes('@{')
    && !ref.endsWith('/')
    && !ref.endsWith('.')
    && !ref.endsWith('.lock')
}

function safeRefPath(base: string, ref: string): string | null {
  if (!safeGitRef(ref)) return null
  const candidate = path.resolve(base, ...ref.split('/'))
  const relative = path.relative(path.resolve(base), candidate)
  return relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? candidate : null
}

function remainingMs(startedAt: number, timeoutMs: number): number {
  return Math.max(0, timeoutMs - (Date.now() - startedAt))
}

function gitEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
    GIT_COMMON_DIR: undefined,
    GIT_CONFIG: undefined,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_GLOBAL: undefined,
    GIT_CONFIG_NOSYSTEM: undefined,
    GIT_CONFIG_PARAMETERS: undefined,
    GIT_CONFIG_SYSTEM: undefined,
    GIT_DIR: undefined,
    GIT_DISCOVERY_ACROSS_FILESYSTEM: undefined,
    GIT_EXTERNAL_DIFF: undefined,
    GIT_GRAFT_FILE: undefined,
    GIT_INDEX_FILE: undefined,
    GIT_NAMESPACE: undefined,
    GIT_OBJECT_DIRECTORY: undefined,
    GIT_QUARANTINE_PATH: undefined,
    GIT_REPLACE_REF_BASE: undefined,
    GIT_SHALLOW_FILE: undefined,
    GIT_WORK_TREE: undefined,
    ...extra
  }
}

function freshness(
  fresh: boolean,
  conclusive: boolean,
  reason: CodePackHeadFreshnessReason,
  currentSha: string | null,
  packSha: string | null,
  metadataOnlyDrift: boolean,
  changedPaths: string[]
): CodePackHeadFreshness {
  return {
    fresh,
    conclusive,
    reason,
    current_sha: currentSha,
    pack_sha: packSha,
    metadata_only_drift: metadataOnlyDrift,
    changed_paths: changedPaths
  }
}

function normalizeGitSha(value: unknown): string | null {
  const text = String(value || '').trim()
  return /^[0-9a-f]{40,64}$/i.test(text) && !/^0+$/.test(text) ? text.toLowerCase() : null
}
