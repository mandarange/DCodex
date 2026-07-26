import fs from 'node:fs/promises'
import path from 'node:path'
import { exists, nowIso, runProcess, sha256, writeJsonAtomic } from '../fsx.js'
import { messageOf } from '../errors/message.js'

export interface CodexNativeReferenceCacheReport {
  schema: 'sks.codex-native-reference-cache.v1'
  generated_at: string
  ok: boolean
  cache_dir: string
  source_url_hash: string | null
  source_ref: string
  source_sha: string | null
  refreshed: boolean
  offline: boolean
  blockers: string[]
  warnings: string[]
}

export async function ensureCodexNativeReferenceSnapshot(input: {
  root: string
  sourceUrl?: string | null
  ref?: string
  refresh?: boolean
  offline?: boolean
  timeoutMs?: number
}): Promise<CodexNativeReferenceCacheReport> {
  const root = path.resolve(input.root)
  const cacheDir = path.join(root, '.sneakoscope', 'cache', 'codex-native-reference')
  const reportPath = path.join(root, '.sneakoscope', 'reports', 'codex-native-reference-cache.json')
  const sourceUrl = input.sourceUrl ?? process.env.SKS_CODEX_NATIVE_REFERENCE_SOURCE_URL ?? null
  const sourceRef = input.ref || process.env.SKS_CODEX_NATIVE_REFERENCE_REF || 'HEAD'
  const offline = input.offline === true || process.env.SKS_CODEX_NATIVE_REFERENCE_OFFLINE === '1' || !sourceUrl
  const blockers: string[] = []
  const warnings: string[] = []
  let refreshed = false

  if (!offline && sourceUrl) {
    const parent = path.dirname(cacheDir)
    await fs.mkdir(parent, { recursive: true })
    const gitDir = path.join(cacheDir, '.git')
    const timeoutMs = input.timeoutMs || 60_000
    if (!(await exists(gitDir))) {
      if (await exists(cacheDir)) await fs.rm(cacheDir, { recursive: true, force: true })
      const cloneArgs = [
        'clone',
        '--depth',
        '1',
        '--filter=blob:none',
        ...(sourceRef === 'HEAD' ? [] : ['--branch', sourceRef]),
        sourceUrl,
        cacheDir
      ]
      const cloned = await runProcess('git', cloneArgs, {
        timeoutMs,
        maxOutputBytes: 128 * 1024
      }).catch((err: unknown) => ({ code: 1, stderr: messageOf(err), stdout: '' }))
      if (cloned.code === 0) refreshed = true
      else blockers.push('source_snapshot_fetch_failed')
    } else if (input.refresh === true) {
      const fetched = await runProcess('git', ['fetch', '--depth', '1', 'origin', sourceRef], {
        cwd: cacheDir,
        timeoutMs,
        maxOutputBytes: 128 * 1024
      }).catch((err: unknown) => ({ code: 1, stderr: messageOf(err), stdout: '' }))
      if (fetched.code === 0) {
        await runProcess('git', ['checkout', 'FETCH_HEAD'], { cwd: cacheDir, timeoutMs, maxOutputBytes: 64 * 1024 }).catch(() => null)
        refreshed = true
      } else {
        blockers.push('source_snapshot_refresh_failed')
      }
    }
  } else {
    warnings.push(sourceUrl ? 'reference_cache_offline_mode' : 'reference_source_url_missing_offline_cache_only')
  }

  const cacheExists = await hasTextFiles(cacheDir)
  if (!cacheExists) blockers.push('source_snapshot_missing')
  const report: CodexNativeReferenceCacheReport = {
    schema: 'sks.codex-native-reference-cache.v1',
    generated_at: nowIso(),
    ok: blockers.length === 0,
    cache_dir: path.relative(root, cacheDir),
    source_url_hash: sourceUrl ? sha256(sourceUrl) : null,
    source_ref: sourceRef,
    source_sha: await gitSha(cacheDir),
    refreshed,
    offline,
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)]
  }
  await writeJsonAtomic(reportPath, report).catch(() => undefined)
  return report
}

async function hasTextFiles(dir: string): Promise<boolean> {
  const rows = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const row of rows) {
    if (row.name === '.git' || row.name === 'node_modules' || row.name === 'dist') continue
    const full = path.join(dir, row.name)
    if (row.isFile() && /\.(md|txt|json|toml|ya?ml|js|ts|mjs|cjs)$/i.test(row.name)) return true
    if (row.isDirectory() && await hasTextFiles(full)) return true
  }
  return false
}

async function gitSha(sourceDir: string): Promise<string | null> {
  const run = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: sourceDir, timeoutMs: 5000, maxOutputBytes: 4096 }).catch(() => null)
  const sha = run?.code === 0 ? `${run.stdout || ''}`.trim() : ''
  return /^[0-9a-f]{40}$/i.test(sha) ? sha : null
}
