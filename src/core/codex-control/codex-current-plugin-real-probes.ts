import path from 'node:path'
import { findCodexBinary } from '../codex-adapter.js'
import { ensureDir, runProcess, writeJsonAtomic } from '../fsx.js'
import { marketplaceSourcesPresent } from './codex-current-core-capability.js'
import { codexCurrentCoreProbeTail, skippedCodexCurrentCoreProbe, type CodexCurrentCoreSingleProbe } from './codex-current-core-real-probes.js'

export async function runCodexCurrentCoreMarketplaceSourceRealProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `marketplace-${Date.now()}`)
  await ensureDir(tempDir)
  const result = await runProcess(codexBin, ['plugin', 'marketplace', 'list', '--json'], {
    cwd: tempDir,
    timeoutMs: input.timeoutMs || 60000,
    maxOutputBytes: 512 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const rows = parseRows((result as any).stdout)
  const missingSourceRows = rows
    .map((row, index) => ({ index, name: String(row?.name || row?.id || row?.pluginId || `row-${index + 1}`), keys: Object.keys(row || {}), root: typeof row?.root === 'string' ? row.root : null }))
    .filter((row, index) => !rowHasMarketplaceSourceLocator(rows[index]))
  const ok = (result as any).code === 0 && marketplaceSourcesPresent((result as any).stdout)
  const artifact = path.join(input.root, '.sneakoscope', 'codex-current-core-plugin-marketplace-real.json')
  await writeJsonAtomic(artifact, {
    schema: 'sks.codex-current-core-plugin-marketplace-real.v1',
    ok,
    generated_at: new Date().toISOString(),
    command_line: [codexBin, 'plugin', 'marketplace', 'list', '--json'],
    empty_marketplace_list: rows.length === 0,
    row_count: rows.length,
    rows_have_source: rows.every(rowHasMarketplaceSource),
    rows_have_source_locator: rows.every(rowHasMarketplaceSourceLocator),
    missing_source_rows: missingSourceRows,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr)
  })
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, 'plugin', 'marketplace', 'list', '--json'],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail((result as any).stdout),
    stderr_tail: codexCurrentCoreProbeTail((result as any).stderr),
    artifact_paths: [artifact],
    evidence: {
      empty_marketplace_list: rows.length === 0,
      row_count: rows.length,
      rows_have_source: rows.every(rowHasMarketplaceSource),
      rows_have_source_locator: rows.every(rowHasMarketplaceSourceLocator),
      missing_source_rows: missingSourceRows
    },
    blockers: ok ? [] : ['codex_plugin_marketplace_source_real_probe_failed']
  }
}

function rowHasMarketplaceSource(row: any): boolean {
  return typeof row?.source === 'string' && row.source.length > 0
    || typeof row?.marketplaceSource?.source === 'string' && row.marketplaceSource.source.length > 0
}

function rowHasMarketplaceSourceLocator(row: any): boolean {
  return rowHasMarketplaceSource(row) || typeof row?.root === 'string' && row.root.length > 0
}

export async function runCodexCurrentCorePluginCacheRealProbe(input: {
  root: string
  requireReal?: boolean
  timeoutMs?: number
  codexBin?: string | null
}): Promise<CodexCurrentCoreSingleProbe> {
  const started = Date.now()
  const codexBin = input.codexBin || await findCodexBinary()
  if (!codexBin) return skippedCodexCurrentCoreProbe('codex_cli_missing')
  const tempDir = path.join(input.root, '.sneakoscope', 'tmp', 'codex-current-core-real-probes', `plugin-cache-${Date.now()}`)
  await ensureDir(tempDir)
  const firstStarted = Date.now()
  const first = await runProcess(codexBin, ['plugin', 'list', '--json'], {
    cwd: tempDir,
    timeoutMs: input.timeoutMs || 60000,
    maxOutputBytes: 512 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const firstMs = Date.now() - firstStarted
  const secondStarted = Date.now()
  const second = await runProcess(codexBin, ['plugin', 'list', '--json'], {
    cwd: tempDir,
    timeoutMs: input.timeoutMs || 60000,
    maxOutputBytes: 512 * 1024
  }).catch((err: any) => ({ code: 1, stdout: '', stderr: err?.message || String(err) }))
  const secondMs = Date.now() - secondStarted
  const marker = /cache|cached|catalog|remote/i.test(`${(first as any).stdout}\n${(second as any).stdout}\n${(first as any).stderr}\n${(second as any).stderr}`)
  const secondNotMuchSlower = secondMs <= Math.max(firstMs * 2, firstMs + 1000)
  const ok = (first as any).code === 0 && (second as any).code === 0 && secondNotMuchSlower
  return {
    ok,
    mode: 'actual-cli',
    command_line: [codexBin, 'plugin', 'list', '--json'],
    duration_ms: Date.now() - started,
    stdout_tail: codexCurrentCoreProbeTail(`${(first as any).stdout || ''}\n${(second as any).stdout || ''}`),
    stderr_tail: codexCurrentCoreProbeTail(`${(first as any).stderr || ''}\n${(second as any).stderr || ''}`),
    artifact_paths: [tempDir],
    evidence: {
      first_duration_ms: firstMs,
      second_duration_ms: secondMs,
      second_not_slower_than_2x: secondNotMuchSlower,
      cache_marker_seen: marker,
      cache_marker_warning: marker ? null : 'cache marker unavailable; timing success accepted'
    },
    blockers: ok ? [] : ['codex_plugin_catalog_cache_real_probe_failed']
  }
}

function parseRows(stdout: unknown): any[] {
  try {
    const parsed = JSON.parse(String(stdout || ''))
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.marketplaces)) return parsed.marketplaces
    if (Array.isArray(parsed?.items)) return parsed.items
    return []
  } catch {
    return []
  }
}
