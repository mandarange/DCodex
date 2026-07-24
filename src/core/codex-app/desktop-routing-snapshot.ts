import fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { nowIso, writeTextAtomic } from '../fsx.js'
import { codexHomePath, readTopLevelTomlString } from './codex-model-catalog.js'
import {
  ensureTrailingNewline,
  removeTopLevelTomlKeyIfValue,
  safeWriteCodexConfigToml,
  upsertTopLevelTomlString
} from '../codex-runtime/codex-desktop-config-policy.js'
import { invalidateCodexModelsCache } from './codex-models-cache.js'

export const DESKTOP_ROUTING_SNAPSHOT_SCHEMA = 'sks.codex-desktop-routing-snapshot.v1'
export const DESKTOP_ROUTING_SNAPSHOT_FILENAME = 'sks-previous-desktop-routing.json'

export interface DesktopRoutingSnapshot {
  readonly schema: typeof DESKTOP_ROUTING_SNAPSHOT_SCHEMA
  readonly captured_at: string
  readonly reason: string
  readonly model_provider: string | null
  readonly model: string | null
  readonly model_catalog_json: string | null
  readonly openai_base_url: string | null
  readonly thread_sidebar?: {
    readonly remapped: boolean
    readonly from_provider: string
    readonly to_provider: string
    readonly thread_ids: readonly string[]
    readonly catalog_db: string
  }
}

export interface ThreadVisibilityImpact {
  readonly schema: 'sks.codex-desktop-thread-visibility.v1'
  readonly checked: boolean
  readonly catalog_db: string | null
  readonly current_provider: string | null
  readonly target_provider: string
  readonly counts_by_provider: Readonly<Record<string, number>>
  readonly hidden_if_switched: number
  readonly warnings: readonly string[]
}

function snapshotPath(input: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(codexHomePath(input), DESKTOP_ROUTING_SNAPSHOT_FILENAME)
}

export function desktopRoutingSnapshotPath(
  input: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}
): string {
  return snapshotPath(input)
}

function threadCatalogDbPath(input: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}): string {
  return path.join(codexHomePath(input), 'sqlite', 'codex-dev.db')
}

function sqlQuote(value: string): string {
  return `'${String(value).replace(/'/g, "''")}'`
}

/** Prefer system sqlite3 so Center JSON (stdout+stderr merged) is not poisoned by node:sqlite ExperimentalWarning. */
function runSqlite3(dbPath: string, sql: string): string {
  return execFileSync('sqlite3', ['-batch', '-noheader', dbPath, sql], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024
  })
}

export function captureDesktopRoutingSnapshot(
  configText: string,
  input: {
    readonly reason: string
    readonly threadSidebar?: DesktopRoutingSnapshot['thread_sidebar']
  }
): DesktopRoutingSnapshot {
  return {
    schema: DESKTOP_ROUTING_SNAPSHOT_SCHEMA,
    captured_at: nowIso(),
    reason: input.reason,
    model_provider: readTopLevelTomlString(configText, 'model_provider'),
    model: readTopLevelTomlString(configText, 'model'),
    model_catalog_json: readTopLevelTomlString(configText, 'model_catalog_json'),
    openai_base_url: readTopLevelTomlString(configText, 'openai_base_url'),
    ...(input.threadSidebar ? { thread_sidebar: input.threadSidebar } : {})
  }
}

export async function writeDesktopRoutingSnapshot(
  snapshot: DesktopRoutingSnapshot,
  input: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<{ readonly ok: boolean; readonly path: string; readonly error?: string }> {
  const filePath = snapshotPath(input)
  try {
    await writeTextAtomic(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
    return { ok: true, path: filePath }
  } catch (err: any) {
    return { ok: false, path: filePath, error: err?.message || String(err) }
  }
}

export async function readDesktopRoutingSnapshot(
  input: { readonly home?: string; readonly env?: NodeJS.ProcessEnv } = {}
): Promise<DesktopRoutingSnapshot | null> {
  const filePath = snapshotPath(input)
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || parsed.schema !== DESKTOP_ROUTING_SNAPSHOT_SCHEMA) return null
    return parsed as DesktopRoutingSnapshot
  } catch {
    return null
  }
}

export function assessThreadVisibilityImpact(
  input: {
    readonly home?: string
    readonly env?: NodeJS.ProcessEnv
    readonly currentProvider: string | null
    readonly targetProvider: string
  }
): ThreadVisibilityImpact {
  const catalogDb = threadCatalogDbPath(input)
  const warnings: string[] = []
  const counts: Record<string, number> = {}
  let checked = false
  try {
    const raw = runSqlite3(
      catalogDb,
      'SELECT model_provider, COUNT(*) FROM local_thread_catalog GROUP BY model_provider;'
    )
    for (const line of raw.split(/\n/).map((entry) => entry.trim()).filter(Boolean)) {
      const sep = line.includes('|') ? '|' : '\t'
      const [provider, count] = line.split(sep)
      counts[String(provider || 'unknown')] = Number(count || 0)
    }
    checked = true
  } catch (err: any) {
    warnings.push(`thread_catalog_unreadable:${err?.code || err?.message || 'unknown'}`)
  }
  const target = String(input.targetProvider || '').trim()
  const hidden = Object.entries(counts)
    .filter(([provider]) => provider !== target)
    .reduce((sum, [, count]) => sum + count, 0)
  if (checked && hidden > 0) {
    warnings.push('desktop_hides_other_provider_threads_until_restore')
  }
  return {
    schema: 'sks.codex-desktop-thread-visibility.v1',
    checked,
    catalog_db: checked ? catalogDb : null,
    current_provider: input.currentProvider,
    target_provider: target,
    counts_by_provider: counts,
    hidden_if_switched: hidden,
    warnings
  }
}

/**
 * Remap local_thread_catalog display tags so Desktop sidebar keeps showing
 * prior-provider threads after a provider switch. Does not mutate
 * state_5.sqlite `threads.model_provider` (resume identity stays original).
 */
export function remapThreadCatalogProvider(input: {
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
  readonly fromProvider: string
  readonly toProvider: string
}): {
  readonly ok: boolean
  readonly remapped: number
  readonly thread_ids: readonly string[]
  readonly catalog_db: string
  readonly error?: string
} {
  const catalogDb = threadCatalogDbPath(input)
  const fromProvider = String(input.fromProvider || '').trim()
  const toProvider = String(input.toProvider || '').trim()
  if (!fromProvider || !toProvider || fromProvider === toProvider) {
    return { ok: true, remapped: 0, thread_ids: [], catalog_db: catalogDb }
  }
  try {
    const idRaw = runSqlite3(
      catalogDb,
      `SELECT thread_id FROM local_thread_catalog WHERE model_provider = ${sqlQuote(fromProvider)};`
    )
    const ids = idRaw.split(/\n/).map((entry) => entry.trim()).filter(Boolean)
    if (ids.length === 0) {
      return { ok: true, remapped: 0, thread_ids: [], catalog_db: catalogDb }
    }
    runSqlite3(
      catalogDb,
      `UPDATE local_thread_catalog SET model_provider = ${sqlQuote(toProvider)} WHERE model_provider = ${sqlQuote(fromProvider)};`
    )
    return {
      ok: true,
      remapped: ids.length,
      thread_ids: ids,
      catalog_db: catalogDb
    }
  } catch (err: any) {
    return {
      ok: false,
      remapped: 0,
      thread_ids: [],
      catalog_db: catalogDb,
      error: err?.message || String(err)
    }
  }
}

export async function restoreDesktopRoutingSnapshot(input: {
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
  readonly configPath?: string
  readonly restartApp?: boolean
  readonly restartImpl?: (input: { enabled: boolean }) => Promise<{ ok: boolean; blockers?: readonly string[] }>
}): Promise<Record<string, unknown>> {
  const home = input.home || input.env?.HOME || os.homedir()
  const env = { ...(input.env || process.env), HOME: home }
  const snapshot = await readDesktopRoutingSnapshot({ home, env })
  if (!snapshot) {
    return {
      schema: 'sks.codex-app-restore-desktop-routing.v1',
      ok: false,
      status: 'snapshot_missing',
      blockers: ['desktop_routing_snapshot_missing'],
      warnings: [],
      hint: 'No previous Desktop routing snapshot. Use sks codex-lb use-codex-lb or Restore Chat / Pro.'
    }
  }

  const configPath = input.configPath || path.join(codexHomePath({ home, env }), 'config.toml')
  const before = await fs.readFile(configPath, 'utf8').catch(() => '')
  let next = before
  if (snapshot.model_provider) next = upsertTopLevelTomlString(next, 'model_provider', snapshot.model_provider)
  else next = removeTopLevelTomlKeyIfValue(next, 'model_provider', readTopLevelTomlString(next, 'model_provider') || '')
  if (snapshot.model) next = upsertTopLevelTomlString(next, 'model', snapshot.model)
  else next = removeTopLevelTomlKeyIfValue(next, 'model', readTopLevelTomlString(next, 'model') || '')
  if (snapshot.model_catalog_json) {
    next = upsertTopLevelTomlString(next, 'model_catalog_json', snapshot.model_catalog_json)
  } else {
    next = removeTopLevelTomlKeyIfValue(
      next,
      'model_catalog_json',
      readTopLevelTomlString(next, 'model_catalog_json') || ''
    )
  }
  // Never restore openai_base_url from snapshot automatically — Design B ownership stays explicit.
  next = ensureTrailingNewline(next)
  const write = await safeWriteCodexConfigToml(
    configPath,
    before,
    next,
    'restore-desktop-routing',
    { verifyUnchangedBeforeWrite: true, expectedBeforeExists: Boolean(before) }
  )
  if (!write.ok) {
    return {
      schema: 'sks.codex-app-restore-desktop-routing.v1',
      ok: false,
      status: 'config_write_blocked',
      snapshot,
      write,
      blockers: [String((write as any).status || 'restore_config_write_blocked')],
      warnings: []
    }
  }

  let sidebarRestore: Record<string, unknown> | null = null
  if (snapshot.thread_sidebar?.remapped) {
    const remapped = remapThreadCatalogProvider({
      home,
      env,
      fromProvider: snapshot.thread_sidebar.to_provider,
      toProvider: snapshot.thread_sidebar.from_provider
    })
    sidebarRestore = { ...remapped, expected_ids: snapshot.thread_sidebar.thread_ids.length }
  }

  const cache = await invalidateCodexModelsCache({
    home,
    env,
    catalogPath: snapshot.model_catalog_json,
    seedMode: 'merge'
  })
  const restart = await (input.restartImpl
    ? input.restartImpl({ enabled: Boolean(input.restartApp) })
    : Promise.resolve({ ok: true, blockers: [] as string[] }))

  try {
    await fs.unlink(snapshotPath({ home, env }))
  } catch {
    // keep snapshot if delete fails; restore already applied
  }

  return {
    schema: 'sks.codex-app-restore-desktop-routing.v1',
    ok: Boolean(write.ok && restart.ok),
    status: write.ok ? (restart.ok ? 'restored' : 'restored_restart_blocked') : 'failed',
    snapshot,
    write,
    thread_sidebar_restore: sidebarRestore,
    models_cache: cache,
    restart_app: restart,
    blockers: [...(restart.ok ? [] : (restart.blockers || ['restore_restart_blocked']))],
    warnings: cache.warnings || [],
    hint: 'Codex Desktop may need a full quit/reopen for the sidebar and picker to refresh.'
  }
}
