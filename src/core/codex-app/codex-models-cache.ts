import fs from 'node:fs/promises'
import path from 'node:path'
import { writeTextAtomic } from '../fsx.js'
import { codexHomePath } from './codex-model-catalog.js'
import { CURRENT_CODEX_RUNTIME_CONTRACT } from '../codex-compat/codex-runtime-contract.js'

/** Far-past timestamp that forces Codex OnlineIfUncached to treat the cache as stale. */
export const CODEX_MODELS_CACHE_STALE_FETCHED_AT = '2000-01-01T00:00:00Z'
export const CODEX_MODELS_CACHE_FILENAME = 'models_cache.json'

export interface InvalidateCodexModelsCacheResult {
  readonly schema: 'sks.codex-models-cache-invalidate.v1'
  readonly ok: boolean
  readonly status: 'invalidated' | 'seeded_from_catalog' | 'missing' | 'malformed_preserved' | 'failed'
  readonly path: string
  readonly models_cache_invalidated: boolean
  readonly restart_recommended: true
  readonly model_count: number
  readonly warnings: readonly string[]
  readonly blockers: readonly string[]
}

export function codexModelsCachePath(input: {
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
} = {}): string {
  return path.join(codexHomePath(input), CODEX_MODELS_CACHE_FILENAME)
}

export type CodexModelsCacheSeedMode = 'merge' | 'replace' | 'none'

function modelSlug(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ''
  const row = value as Record<string, unknown>
  for (const key of ['slug', 'model', 'id'] as const) {
    const raw = row[key]
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return ''
}

function mergeModelsBySlug(existingModels: unknown[], catalogModels: unknown[]): unknown[] {
  const bySlug = new Map<string, unknown>()
  const unkeyed: unknown[] = []
  for (const row of existingModels) {
    const slug = modelSlug(row)
    if (slug) bySlug.set(slug, row)
    else unkeyed.push(row)
  }
  for (const row of catalogModels) {
    const slug = modelSlug(row)
    if (slug) bySlug.set(slug, row)
    else unkeyed.push(row)
  }
  return [...bySlug.values(), ...unkeyed]
}

/**
 * Force Codex Desktop / app-server to refresh models after SKS catalog or
 * provider activation. Preserves the Codex wrapper shape
 * `{ fetched_at, client_version, models }` — never write a raw catalog file
 * as the cache (that breaks app-server refresh).
 *
 * `seedMode`:
 * - `merge` (default): union catalog rows into the existing cache by slug so
 *   OpenRouter activation cannot wipe the prior Desktop list.
 * - `replace`: catalog becomes the sole models array (legacy / explicit).
 * - `none`: only stale `fetched_at`; keep existing models.
 */
export async function invalidateCodexModelsCache(input: {
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
  readonly catalogPath?: string | null
  readonly seedMode?: CodexModelsCacheSeedMode
} = {}): Promise<InvalidateCodexModelsCacheResult> {
  const cachePath = codexModelsCachePath(input)
  const warnings: string[] = []
  const blockers: string[] = []
  const seedMode: CodexModelsCacheSeedMode = input.seedMode || 'merge'
  let existing: Record<string, unknown> | null = null
  try {
    const raw = await fs.readFile(cachePath, 'utf8')
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>
      else warnings.push('codex_models_cache_previous_shape_invalid')
    } catch {
      warnings.push('codex_models_cache_previous_invalid_json')
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      return {
        schema: 'sks.codex-models-cache-invalidate.v1',
        ok: false,
        status: 'failed',
        path: cachePath,
        models_cache_invalidated: false,
        restart_recommended: true,
        model_count: 0,
        warnings,
        blockers: [`codex_models_cache_unreadable:${(err as NodeJS.ErrnoException)?.code || 'unknown'}`]
      }
    }
  }

  let models: unknown[] = Array.isArray(existing?.models) ? [...(existing!.models as unknown[])] : []
  let seededFromCatalog = false
  const catalogPath = String(input.catalogPath || '').trim()
  if (catalogPath && seedMode !== 'none') {
    try {
      const catalogRaw = await fs.readFile(catalogPath, 'utf8')
      const catalog = JSON.parse(catalogRaw)
      const catalogModels = Array.isArray(catalog?.models)
        ? catalog.models
        : Array.isArray(catalog)
          ? catalog
          : null
      if (Array.isArray(catalogModels)) {
        models = seedMode === 'replace'
          ? catalogModels
          : mergeModelsBySlug(models, catalogModels)
        seededFromCatalog = true
      } else {
        warnings.push('codex_models_cache_catalog_shape_invalid')
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') warnings.push('codex_models_cache_catalog_missing')
      else warnings.push('codex_models_cache_catalog_unreadable')
    }
  }

  if (!existing && models.length === 0) {
    return {
      schema: 'sks.codex-models-cache-invalidate.v1',
      ok: true,
      status: 'missing',
      path: cachePath,
      models_cache_invalidated: false,
      restart_recommended: true,
      model_count: 0,
      warnings,
      blockers
    }
  }

  const existingClient = typeof existing?.client_version === 'string' ? existing.client_version.trim() : ''
  const clientVersion = existingClient && existingClient !== '0.0.0'
    ? existingClient
    : CURRENT_CODEX_RUNTIME_CONTRACT.requiredCliVersion
  const wrapper = {
    fetched_at: CODEX_MODELS_CACHE_STALE_FETCHED_AT,
    client_version: clientVersion,
    models
  }
  try {
    await writeTextAtomic(cachePath, `${JSON.stringify(wrapper, null, 2)}\n`, { mode: 0o600 })
  } catch (err: any) {
    return {
      schema: 'sks.codex-models-cache-invalidate.v1',
      ok: false,
      status: existing ? 'malformed_preserved' : 'failed',
      path: cachePath,
      models_cache_invalidated: false,
      restart_recommended: true,
      model_count: models.length,
      warnings,
      blockers: [`codex_models_cache_write_failed:${err?.code || err?.message || 'unknown'}`]
    }
  }
  return {
    schema: 'sks.codex-models-cache-invalidate.v1',
    ok: true,
    status: seededFromCatalog ? 'seeded_from_catalog' : 'invalidated',
    path: cachePath,
    models_cache_invalidated: true,
    restart_recommended: true,
    model_count: models.length,
    warnings,
    blockers
  }
}

export function desktopPickerStatusFromCache(input: {
  readonly catalogOk: boolean
  readonly cache: InvalidateCodexModelsCacheResult | null
  readonly restartAppRequested?: boolean
}): {
  readonly catalog_ok: boolean
  readonly models_cache_invalidated: boolean
  readonly restart_recommended: boolean
} {
  const cache = input.cache
  return {
    catalog_ok: input.catalogOk,
    models_cache_invalidated: cache?.models_cache_invalidated === true,
    restart_recommended: cache?.restart_recommended === true || input.restartAppRequested === true
  }
}
