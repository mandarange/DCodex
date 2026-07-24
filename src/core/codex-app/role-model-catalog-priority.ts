import { normalizeCodexModelId } from './codex-model-catalog.js'
import type { RoleModelPreferenceStore } from '../subagents/role-model-preferences.js'

/** Codex spawn_agent advertises at most this many picker-visible models. */
export const CODEX_SUBAGENT_PICKER_PRIORITY_SLOTS = 5

export interface RoleModelCatalogPriorityStampResult {
  readonly schema: 'sks.role-model-catalog-priority-stamp.v1'
  readonly stamped: boolean
  readonly preferred_models: readonly string[]
  readonly stamped_models: readonly string[]
  readonly missing_from_catalog: readonly string[]
  readonly rows: Record<string, unknown>[]
}

/**
 * Raise priority for role-preferred models so Desktop / spawn_agent surfaces
 * them in the first picker slots (0..N-1). Non-preferred rows keep relative
 * order but shift to priority >= N.
 */
export function stampRoleModelCatalogPriorities(
  rows: readonly Record<string, unknown>[],
  store: RoleModelPreferenceStore | null | undefined
): RoleModelCatalogPriorityStampResult {
  const preferred: string[] = []
  const seen = new Set<string>()
  for (const preference of Object.values(store?.roles || {})) {
    const model = normalizeCodexModelId(preference?.model)
    if (!model || seen.has(model)) continue
    seen.add(model)
    preferred.push(model)
  }
  const preferredLimited = preferred.slice(0, CODEX_SUBAGENT_PICKER_PRIORITY_SLOTS)
  const preferredSet = new Set(preferredLimited)
  const stampedModels: string[] = []
  const missing = preferredLimited.filter((model) => !rows.some((row) => normalizeCodexModelId(row.slug) === model))

  const preferredRows: Record<string, unknown>[] = []
  const otherRows: Record<string, unknown>[] = []
  for (const row of rows) {
    const slug = normalizeCodexModelId(row.slug)
    if (slug && preferredSet.has(slug)) preferredRows.push({ ...row })
    else otherRows.push({ ...row })
  }
  preferredRows.sort((a, b) => {
    const am = normalizeCodexModelId(a.slug) || ''
    const bm = normalizeCodexModelId(b.slug) || ''
    return preferredLimited.indexOf(am) - preferredLimited.indexOf(bm)
  })

  const next: Record<string, unknown>[] = []
  preferredRows.forEach((row, index) => {
    const slug = normalizeCodexModelId(row.slug)
    if (slug) stampedModels.push(slug)
    next.push({
      ...row,
      visibility: row.visibility === 'hide' ? 'list' : (row.visibility || 'list'),
      supported_in_api: true,
      multi_agent_version: row.multi_agent_version || 'v2',
      priority: index
    })
  })
  otherRows.forEach((row, index) => {
    const previous = typeof row.priority === 'number' && Number.isFinite(row.priority)
      ? Number(row.priority)
      : CODEX_SUBAGENT_PICKER_PRIORITY_SLOTS + index
    next.push({
      ...row,
      priority: Math.max(CODEX_SUBAGENT_PICKER_PRIORITY_SLOTS, previous)
    })
  })

  return {
    schema: 'sks.role-model-catalog-priority-stamp.v1',
    stamped: stampedModels.length > 0,
    preferred_models: preferredLimited,
    stamped_models: stampedModels,
    missing_from_catalog: missing,
    rows: next
  }
}
