import { normalizeCodexLbToolCatalog, shouldBindLocalModelCatalog } from '../codex-lb-tool-catalog.js'
import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  CodexLbDesktopMode
} from '../capability-types.js'
import { uniqueValues as unique } from '../../text/strings.js'
import { probeEvidence } from './probe-evidence.js'

export interface CatalogProbeInput {
  mode: CodexLbDesktopMode
  level: CapabilityProbeLevel
  checkedAt: string
  manifest?: Record<string, unknown> | null
  catalog?: unknown
  localCatalogBound?: boolean
  configuredServiceTier?: string | null
  pickerControlVisible?: boolean | null
  pickerSelectedModel?: string | null
  requestServiceTier?: string | null
  responseActualServiceTier?: string | null
  fixture?: boolean
  blockers?: string[]
}

export interface CatalogProbeResult {
  catalog: CapabilityEvidence
  model_picker: CapabilityEvidence
  fast_mode: CapabilityEvidence
}

export function runCatalogProbe(input: CatalogProbeInput): CatalogProbeResult {
  const manifestModels = manifestFlag(input.manifest, 'routes', 'models')
  const hasCatalogPayload = Boolean(input.catalog)
  const normalized = hasCatalogPayload ? normalizeCodexLbToolCatalog(input.catalog) : null
  const rows = normalized?.catalog?.models || []
  const advertisedSpeedTiers = unique(rows.flatMap((row: any) => tierNames(row?.additional_speed_tiers)))
  const advertisedServiceTiers = unique(rows.flatMap((row: any) => tierNames(row?.service_tiers)))
  const fastAdvertised = advertisedSpeedTiers.some((tier) => tier === 'fast' || tier === 'priority')
    || advertisedServiceTiers.includes('priority')
  const nativeReplacementBound = input.mode === 'desktop-native-bridge' && input.localCatalogBound === true
  const catalogBlockers = [
    ...(input.blockers || []),
    ...(nativeReplacementBound ? ['native_bridge_local_catalog_replacement_forbidden'] : []),
    ...(normalized && !normalized.ok ? normalized.blockers : []),
    ...(input.level !== 'shallow' && !hasCatalogPayload && manifestModels !== true
      ? ['codex_lb_model_catalog_unavailable']
      : [])
  ]
  const catalog = probeEvidence({
    configured: input.localCatalogBound === true,
    advertised: manifestModels === true,
    attempted: hasCatalogPayload,
    verified: normalized?.ok === true,
    fixture: input.fixture,
    source: hasCatalogPayload ? 'transport' : manifestModels === true ? 'manifest' : 'config',
    blockers: catalogBlockers,
    evidence: {
      contract: normalized?.contract || null,
      model_count: normalized?.model_count || 0,
      unknown_fields_preserved: normalized?.contract === 'codex-model-catalog-pass-through.v2',
      local_catalog_binding_allowed: shouldBindLocalModelCatalog(input.mode),
      local_catalog_bound: input.localCatalogBound === true,
      manifest_models_route: manifestModels
    }
  }, input.checkedAt)

  const cliPlane = input.mode === 'cli-provider'
  // CLI plane: the picker is `codex --model` against the live catalog, so a
  // transport-fetched, normalized catalog with models is the verification.
  const cliPickerVerified = cliPlane
    && input.level !== 'shallow'
    && normalized?.ok === true
    && rows.length > 0
  const pickerVerified = cliPickerVerified || (input.level === 'deep'
    && input.pickerControlVisible === true
    && Boolean(input.pickerSelectedModel))
  const modelPicker = probeEvidence({
    advertised: Boolean(normalized?.ok),
    attempted: input.level === 'deep' || cliPickerVerified,
    verified: pickerVerified,
    fixture: input.fixture,
    source: cliPlane
      ? hasCatalogPayload ? 'transport' : 'manifest'
      : input.level === 'deep' ? 'desktop_ui' : hasCatalogPayload ? 'transport' : 'manifest',
    blockers: [
      ...(input.blockers || []),
      ...(!cliPlane && input.level === 'deep' && input.pickerControlVisible === false
        ? ['codex_desktop_model_picker_not_visible']
        : [])
    ],
    warnings: !cliPlane && input.level !== 'deep' && normalized?.ok
      ? ['desktop_model_picker_not_deep_verified']
      : [],
    evidence: {
      catalog_advertised: normalized?.ok === true,
      desktop_picker_verified: pickerVerified,
      picker_control_visible: input.pickerControlVisible ?? null,
      picker_selected_model: input.pickerSelectedModel || null
    }
  }, input.checkedAt)

  const configuredTier = normalizeTier(input.configuredServiceTier)
  const requestTier = normalizeTier(input.requestServiceTier)
  const responseTier = normalizeTier(input.responseActualServiceTier)
  const fastConfigured = configuredTier === 'fast'
  const fastRequested = requestTier === 'fast' || requestTier === 'priority'
  const fastEffective = responseTier === 'priority' || responseTier === 'fast'
  const fastVerified = (cliPlane ? cliPickerVerified : pickerVerified)
    && fastAdvertised && fastRequested && fastEffective
  const fastBlockers = [
    ...(input.blockers || []),
    ...(!cliPlane && input.level === 'deep' && input.pickerControlVisible === false ? ['fast_picker_control_not_visible'] : []),
    ...(input.level === 'deep' && fastRequested && !fastEffective ? ['fast_service_tier_not_effective'] : []),
    ...(cliPlane && input.level !== 'shallow' && fastRequested && hasCatalogPayload && !fastEffective
      ? ['fast_service_tier_not_effective']
      : [])
  ]
  const fastMode = probeEvidence({
    configured: fastConfigured,
    advertised: fastAdvertised,
    attempted: Boolean(input.requestServiceTier || input.responseActualServiceTier),
    verified: fastVerified,
    fixture: input.fixture,
    unsupported: Boolean(hasCatalogPayload && normalized?.ok && !fastAdvertised),
    source: fastVerified
      ? cliPlane ? 'transport' : 'deep_probe'
      : input.requestServiceTier || input.responseActualServiceTier
        ? 'transport'
        : fastAdvertised
          ? 'manifest'
          : 'config',
    blockers: fastBlockers,
    warnings: fastConfigured && !fastAdvertised ? ['fast_configured_but_not_catalog_advertised'] : [],
    evidence: {
      configured_service_tier: configuredTier,
      advertised_additional_speed_tiers: advertisedSpeedTiers,
      advertised_service_tiers: advertisedServiceTiers,
      picker_control_visible: input.pickerControlVisible ?? null,
      request_service_tier: requestTier,
      request_priority_mapping: fastRequested ? 'priority' : null,
      response_actual_service_tier: responseTier,
      configured: fastConfigured,
      advertised: fastAdvertised,
      effective: fastEffective
    }
  }, input.checkedAt)

  return { catalog, model_picker: modelPicker, fast_mode: fastMode }
}

function manifestFlag(manifest: Record<string, unknown> | null | undefined, section: string, key: string): boolean | null {
  const row = manifest?.[section]
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const value = (row as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : null
}

function tierNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((entry) => normalizeTier(typeof entry === 'string'
    ? entry
    : entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).id ?? (entry as Record<string, unknown>).name
        ?? (entry as Record<string, unknown>).service_tier
        ?? (entry as Record<string, unknown>).tier
      : null)).filter((entry): entry is string => Boolean(entry))
}

function normalizeTier(value: unknown): string | null {
  const tier = String(value || '').trim().toLowerCase()
  return tier || null
}
