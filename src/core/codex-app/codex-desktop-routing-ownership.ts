import path from 'node:path'
import { isLoopbackHostname, resolveCatalogPath } from './multi-provider-router-support.js'
import { defaultOpenCodexCatalogPath, readTopLevelTomlString } from './codex-model-catalog.js'

const SKS_ROUTER_PROVIDER_ID = 'sks-router'
const OPENROUTER_PROVIDER_ID = 'openrouter'

export type CodexDesktopRoutingClass =
  | 'native_openai'
  | 'sks_router'
  | 'openrouter'
  | 'opencodex_design_b'
  | 'codex_lb'
  | 'external_conflict'
  | 'unconfigured'

export const OPENCODEX_INJECT_MARKER = 'Auto-injected by opencodex'
export const OPENCODEX_DESIGN_B_FORCE_HINT =
  'OpenCodex Design B currently owns openai_base_url loopback routing. Stop OpenCodex inject or re-run with --force-routing-override only if replacing that owner is intentional.'

export interface CodexDesktopRoutingOwnership {
  readonly schema: 'sks.codex-desktop-routing-ownership.v1'
  readonly classification: CodexDesktopRoutingClass
  readonly selected_provider: string | null
  readonly selected_model: string | null
  readonly openai_base_url: string | null
  readonly openai_base_url_loopback: boolean
  readonly opencodex_design_b: boolean
  readonly opencodex_marker_present: boolean
  readonly catalog_path: string | null
  readonly catalog_is_opencodex_default: boolean
  readonly sks_router_may_activate: boolean
  readonly blockers: readonly string[]
  readonly warnings: readonly string[]
}

/**
 * Classify who currently owns Desktop model routing in user-level config.toml.
 * OpenCodex Design B keeps model_provider=openai and redirects via openai_base_url.
 */
export function classifyCodexDesktopRouting(configText: string, input: {
  readonly home?: string
  readonly env?: NodeJS.ProcessEnv
  readonly configPath?: string
} = {}): CodexDesktopRoutingOwnership {
  const text = String(configText || '')
  const selectedProvider = readTopLevelTomlString(text, 'model_provider')
  const selectedModel = readTopLevelTomlString(text, 'model')
  const openaiBaseUrl = readTopLevelTomlString(text, 'openai_base_url')
  const catalogPathRaw = readTopLevelTomlString(text, 'model_catalog_json')
  const catalogResolved = catalogPathRaw
    ? resolveCatalogPath(catalogPathRaw, input)
    : null
  const defaultOpenCodexCatalog = path.resolve(defaultOpenCodexCatalogPath(input))
  const catalogIsOpenCodexDefault = Boolean(
    catalogResolved && catalogResolved === defaultOpenCodexCatalog
  )
  const markerPresent = text.includes(OPENCODEX_INJECT_MARKER)
  const loopbackBase = openaiBaseUrl ? normalizeLoopbackOpenaiBaseUrl(openaiBaseUrl) : null
  const openaiBaseUrlLoopback = Boolean(loopbackBase)
  const designB = Boolean(
    openaiBaseUrlLoopback
    && (markerPresent || catalogIsOpenCodexDefault)
    && (!selectedProvider || selectedProvider === 'openai')
  )

  const blockers: string[] = []
  const warnings: string[] = []
  let classification: CodexDesktopRoutingClass = 'unconfigured'

  if (selectedProvider === SKS_ROUTER_PROVIDER_ID) classification = 'sks_router'
  else if (selectedProvider === OPENROUTER_PROVIDER_ID) classification = 'openrouter'
  else if (selectedProvider === 'codex-lb') classification = 'codex_lb'
  else if (designB) classification = 'opencodex_design_b'
  else if (!selectedProvider || selectedProvider === 'openai') classification = 'native_openai'
  else classification = 'external_conflict'

  if (designB && selectedProvider && selectedProvider !== 'openai') {
    classification = 'external_conflict'
    blockers.push('opencodex_design_b_provider_conflict')
  }
  if (openaiBaseUrl && !openaiBaseUrlLoopback && selectedProvider === SKS_ROUTER_PROVIDER_ID) {
    warnings.push('openai_base_url_present_with_sks_router')
  }
  if (designB) {
    warnings.push('opencodex_design_b_routing_owner')
  }

  const sksRouterMayActivate = classification !== 'opencodex_design_b'
    && classification !== 'external_conflict'

  return {
    schema: 'sks.codex-desktop-routing-ownership.v1',
    classification,
    selected_provider: selectedProvider,
    selected_model: selectedModel,
    openai_base_url: openaiBaseUrl,
    openai_base_url_loopback: openaiBaseUrlLoopback,
    opencodex_design_b: designB,
    opencodex_marker_present: markerPresent,
    catalog_path: catalogResolved,
    catalog_is_opencodex_default: catalogIsOpenCodexDefault,
    sks_router_may_activate: sksRouterMayActivate,
    blockers,
    warnings
  }
}

export function opencodexDesignBBlocksRouterActivation(
  ownership: CodexDesktopRoutingOwnership,
  opts: { readonly forceRoutingOverride?: boolean } = {}
): string | null {
  if (opts.forceRoutingOverride === true) return null
  if (ownership.classification === 'opencodex_design_b' || ownership.opencodex_design_b) {
    return 'opencodex_design_b_routing_owner'
  }
  return null
}

function normalizeLoopbackOpenaiBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(String(value || '').trim())
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    if (!isLoopbackHostname(parsed.hostname)) return null
    const normalizedPath = parsed.pathname.replace(/\/+$/, '') || ''
    if (normalizedPath && normalizedPath !== '/v1') return null
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}
