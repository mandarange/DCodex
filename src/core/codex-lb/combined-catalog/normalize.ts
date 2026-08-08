import type { BridgeCatalogModel, BridgeProviderId, CatalogSyncState, CodexModelInfoRequiredFields } from '../bridge-contracts.js';
import type { BridgeProviderRegistry } from '../provider-registry.js';
import {
  canonicalizeBridgeModelId,
  normalizeBridgeUpstreamModelId,
  sha256Stable
} from '../route-index.js';
import type { ProviderCatalogBuildInput } from './contracts.js';
import { unique } from './shared.js';

export interface NormalizedProviderCatalog {
  readonly state: CatalogSyncState['state'];
  readonly models: BridgeCatalogModel[];
  readonly blockers: string[];
  readonly warnings: string[];
}

export function normalizeProviderCatalog(input: ProviderCatalogBuildInput): NormalizedProviderCatalog {
  if (input.state !== 'verified') {
    return {
      state: input.state,
      models: [],
      blockers: unique([
        ...(input.blockers || []),
        ...(input.state === 'not_started' ? [] : [`${providerCode(input.provider_id)}_catalog_not_verified`])
      ]),
      warnings: unique(input.warnings || [])
    };
  }
  if (input.provider_id === 'codex-lb') {
    const normalized = normalizeCodexLbBridgeCatalogModels(
      normalizeCodexLbCatalogRows(input.models),
      input.generation || 'unknown'
    );
    return {
      state: input.state,
      models: normalized.models.map(canonicalModel).filter(isModel),
      blockers: unique([...(input.blockers || []), ...normalized.blockers]),
      warnings: unique(input.warnings || [])
    };
  }
  const rows = catalogRows(input.models);
  const blockers = [...(input.blockers || [])];
  const models = rows.map((row: any) => {
    const sourceId = row?.id || row?.model || row?.slug || row?.name;
    const publicId = canonicalizeBridgeModelId(sourceId);
    const upstreamModel = normalizeBridgeUpstreamModelId(sourceId);
    if (!publicId || !upstreamModel) return null;
    const features = row?.features && typeof row.features === 'object' ? row.features : {};
    const reasoning = features.reasoning === true;
    const capabilities = [
      ...(features.tools === true ? ['tools'] : []),
      ...(reasoning ? ['reasoning'] : []),
      ...(features.vision === true ? ['vision'] : []),
      ...(features.audio === true ? ['audio'] : [])
    ];
    return canonicalModel({
      public_id: publicId,
      provider_id: 'openrouter',
      upstream_model: upstreamModel,
      display_name: String(row?.name || publicId).trim(),
      supported_in_api: row?.supported_in_api !== false,
      capabilities,
      source_catalog_generation: input.generation || 'unknown',
      route_key: `openrouter:${publicId}`,
      ...(reasoning ? { default_reasoning_level: OPENROUTER_DEFAULT_REASONING_LEVEL } : {}),
      // OpenRouter never serves Codex ModelInfo, so the reasoning ladder is
      // synthesized from its own capability flag rather than passed through.
      ...codexModelInfoFields(publicId, {
        supported_reasoning_levels: reasoning ? openRouterReasoningLevels() : [],
        supports_reasoning_summary_parameter: reasoning
      }, { tools: capabilities.includes('tools') })
    });
  }).filter(isModel);
  if (models.length === 0) blockers.push('openrouter_model_catalog_empty');
  return {
    state: input.state,
    models,
    blockers: unique(blockers),
    warnings: unique(input.warnings || [])
  };
}

export function routeProviderState(
  registry: BridgeProviderRegistry,
  catalog: ProviderCatalogBuildInput
): string {
  const profile = registry.profiles[catalog.provider_id];
  return profile.state === 'ready' && catalog.state === 'verified' ? 'ready' : catalog.state;
}

export function providerCatalogStatus(
  input: ProviderCatalogBuildInput,
  normalized: NormalizedProviderCatalog
): CatalogSyncState {
  const semantic = { provider_id: input.provider_id, models: normalized.models };
  return {
    schema: 'sks.catalog-sync-state.v2',
    provider_id: input.provider_id,
    state: input.state,
    source: input.provider_id === 'codex-lb' ? 'gateway' : 'openrouter',
    generation: input.generation,
    digest: normalized.models.length > 0 ? sha256Stable(semantic) : null,
    model_count: normalized.models.length,
    checked_at: input.checked_at || null,
    expires_at: input.expires_at || null,
    blockers: normalized.blockers,
    warnings: normalized.warnings,
    recovery_action: normalized.blockers.length > 0 ? 'retry_catalog_sync' : null
  };
}

function catalogRows(value: unknown): any[] {
  return Array.isArray(value)
    ? value
    : Array.isArray((value as any)?.models)
      ? (value as any).models
      : Array.isArray((value as any)?.data)
        ? (value as any).data
        : [];
}

function normalizeCodexLbCatalogRows(value: unknown): unknown {
  return {
    models: catalogRows(value).map((row: unknown) => typeof row === 'string'
      ? { id: row, slug: row, display_name: row, supported_in_api: true }
      : row)
  };
}

function normalizeCodexLbBridgeCatalogModels(
  payload: unknown,
  sourceCatalogGeneration: string
): { models: BridgeCatalogModel[]; blockers: string[] } {
  const rows = catalogRows(payload);
  const models: BridgeCatalogModel[] = [];
  const blockers: string[] = [];
  for (const [index, value] of rows.entries()) {
    if (!isPlainObject(value)) {
      blockers.push(`codex_lb_model_catalog_row_invalid:${index}:object`);
      continue;
    }
    try {
      const row = sanitizeCodexLbModelRow(value, index);
      const publicId = String(row.slug || '').trim();
      const capabilities = [
        ...(Array.isArray(row.supported_reasoning_levels) && row.supported_reasoning_levels.length > 0 ? ['reasoning'] : []),
        ...(row.supports_tools === true || row.supports_tool_choice === true ? ['tools'] : []),
        ...(row.supports_vision === true || row.vision === true ? ['vision'] : []),
        ...(row.supports_audio === true || row.audio === true ? ['audio'] : [])
      ];
      models.push({
        // The gateway already serves a complete Codex ModelInfo row (reasoning
        // levels, service tiers, multi-agent version, tool mode, context
        // window...). Rebuilding only the required subset silently dropped
        // every optional field, which is what emptied the Desktop reasoning
        // selector and hid Fast mode. Preserve the sanitized upstream row and
        // layer SKS routing identity on top.
        ...row,
        public_id: publicId,
        provider_id: 'codex-lb',
        upstream_model: publicId,
        display_name: String(row.display_name || publicId).trim(),
        supported_in_api: row.supported_in_api !== false,
        capabilities: unique(capabilities).sort(),
        source_catalog_generation: sourceCatalogGeneration,
        route_key: `codex-lb:${publicId.toLowerCase()}`,
        ...codexModelInfoFields(publicId, row, {
          tools: row.supports_tools === true || row.supports_tool_choice === true
        }),
        // Authenticated gateway models outrank third-party catalog rows in the
        // Desktop picker regardless of its sort direction on ties.
        ...(typeof row.priority === 'number' ? {} : { priority: 100 })
      } as BridgeCatalogModel);
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : `codex_lb_model_catalog_row_invalid:${index}`);
    }
  }
  if (models.length === 0) blockers.push('codex_lb_model_catalog_empty');
  return { models, blockers: unique(blockers) };
}

function sanitizeCodexLbModelRow(row: Record<string, unknown>, index: number): Record<string, unknown> {
  const cloned = structuredClone(row);
  for (const key of Object.keys(cloned)) {
    if (/(?:^|[_-])(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|cookie|set[_-]?cookie)(?:$|[_-])/i.test(key)) {
      delete cloned[key];
    }
  }
  const slug = String(cloned.slug ?? cloned.id ?? cloned.model ?? cloned.name ?? '').trim();
  if (!slug) throw new Error(`codex_lb_model_catalog_slug_missing:${index}`);
  cloned.slug = slug;
  return cloned;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/**
 * Reasoning ladder for OpenRouter models that advertise the `reasoning`
 * parameter. OpenRouter's Responses API accepts the OpenAI effort ladder and
 * normalizes it per upstream model, so the rungs are fixed rather than derived:
 * its `supported_parameters` listing reports only that `reasoning` is accepted,
 * never the available granularity. A live round trip through the desktop bridge
 * against `z-ai/glm-5.2` answered 200 for every rung, echoed the requested
 * effort back in `response.created`, and scaled `response.reasoning_text.delta`
 * with it (none 0, minimal 21, low 22, medium 42, xhigh 50), so the control is
 * wired end to end and not merely accepted.
 *
 * The object shape and descriptions mirror what the codex-lb gateway serves so
 * the Desktop selector renders both providers identically. Levels are cloned
 * per row because every catalog row owns its own ModelInfo array.
 */
export const OPENROUTER_REASONING_LEVELS: readonly { readonly effort: string; readonly description: string }[] = [
  { effort: 'low', description: 'Fast responses with lighter reasoning' },
  { effort: 'medium', description: 'Balances speed and reasoning depth for everyday tasks' },
  { effort: 'high', description: 'Greater reasoning depth for complex problems' },
  { effort: 'xhigh', description: 'Extra high reasoning depth for complex problems' }
];

export const OPENROUTER_DEFAULT_REASONING_LEVEL = 'medium';

function openRouterReasoningLevels(): Record<string, string>[] {
  return OPENROUTER_REASONING_LEVELS.map((level) => ({ ...level }));
}

// Codex serde requires these ModelInfo fields on every catalog row. Upstream
// values win when the source catalog carries them; otherwise use the defaults
// the codex-lb fixture environment has proven real Codex CLI parses.
export function codexModelInfoFields(
  slug: string,
  row: Record<string, unknown> | null,
  fallback: { tools: boolean }
): CodexModelInfoRequiredFields {
  const summaries = typeof row?.supports_reasoning_summary_parameter === 'boolean'
    ? row.supports_reasoning_summary_parameter
    : row?.supports_reasoning_summaries !== false;
  return {
    slug,
    // Codex serves reasoning levels either as plain strings or as objects
    // carrying the level plus display metadata; both shapes pass through
    // unchanged so the Desktop selector keeps its own rendering contract.
    supported_reasoning_levels: Array.isArray(row?.supported_reasoning_levels)
      ? row.supported_reasoning_levels.map((level) => (
        level && typeof level === 'object' ? level : String(level)
      )) as string[]
      : [],
    shell_type: typeof row?.shell_type === 'string' && row.shell_type ? row.shell_type : 'shell_command',
    visibility: typeof row?.visibility === 'string' && row.visibility ? row.visibility : 'list',
    priority: typeof row?.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 1,
    base_instructions: typeof row?.base_instructions === 'string' ? row.base_instructions : '',
    supports_reasoning_summary_parameter: summaries,
    support_verbosity: row?.support_verbosity === true,
    truncation_policy: isPlainObject(row?.truncation_policy)
      ? row.truncation_policy
      : { mode: 'tokens', limit: 10_000 },
    supports_parallel_tool_calls: typeof row?.supports_parallel_tool_calls === 'boolean'
      ? row.supports_parallel_tool_calls
      : fallback.tools,
    experimental_supported_tools: Array.isArray(row?.experimental_supported_tools)
      ? row.experimental_supported_tools.map(String)
      : []
  };
}

function providerCode(providerId: BridgeProviderId): string {
  return providerId === 'codex-lb' ? 'codex_lb' : 'openrouter';
}

function canonicalModel(model: BridgeCatalogModel): BridgeCatalogModel | null {
  const publicId = canonicalizeBridgeModelId(model.public_id);
  const upstream = normalizeBridgeUpstreamModelId(model.upstream_model);
  if (!publicId || !upstream) return null;
  return {
    // Preserve upstream Codex ModelInfo metadata; rebuilding only the required
    // subset here is what emptied the Desktop reasoning selector and hid Fast
    // mode for gateway models.
    ...model,
    public_id: publicId,
    provider_id: model.provider_id,
    upstream_model: upstream,
    display_name: String(model.display_name || publicId).trim().slice(0, 240),
    supported_in_api: model.supported_in_api !== false,
    capabilities: unique(model.capabilities).sort(),
    source_catalog_generation: String(model.source_catalog_generation || 'unknown'),
    route_key: `${model.provider_id}:${publicId}`,
    ...codexModelInfoFields(publicId, model as unknown as Record<string, unknown>, {
      tools: model.capabilities.includes('tools')
    })
  };
}

function isModel(value: BridgeCatalogModel | null): value is BridgeCatalogModel {
  return value !== null;
}
