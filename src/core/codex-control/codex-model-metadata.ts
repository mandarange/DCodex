import {
  normalizeCodexReasoningEffort,
  readConfiguredCodexModelRoutingContext,
  type CodexCatalogModel
} from '../codex-app/codex-model-catalog.js'
import type { CodexAppServerV2Client } from './codex-app-server-v2-client.js'

export interface CodexModelMetadata {
  schema: 'sks.codex-model-metadata.v1'
  model: string
  advertised_efforts: string[]
  default_effort: string
  source: 'app-server' | 'codex-catalog' | 'env' | 'unavailable'
  blockers: string[]
}

export interface CollectCodexModelMetadataInput {
  model?: string | null
  env?: NodeJS.ProcessEnv
  home?: string
  configPath?: string
  codexBin?: string | null
}

export async function collectCodexModelMetadata(
  input: CollectCodexModelMetadataInput = {}
): Promise<CodexModelMetadata> {
  const env = input.env || process.env
  const routing = await readConfiguredCodexModelRoutingContext({
    env,
    ...(input.home ? { home: input.home } : {}),
    ...(input.configPath ? { configPath: input.configPath } : {})
  })
  const model = String(
    input.model
      || env.SKS_CODEX_MODEL
      || env.CODEX_MODEL
      || routing.selected_model
      || ''
  ).trim()

  const configured = routing.catalog.ok
    ? metadataFromCatalog(routing.catalog.models, model)
    : null
  if (configured?.advertised_efforts.length) return configured

  const appServer = await readAppServerMetadata({
    model,
    env,
    ...(input.codexBin !== undefined ? { codexBin: input.codexBin } : {})
  })
  if (appServer.metadata?.advertised_efforts.length) return appServer.metadata

  const envEfforts = normalizeAdvertisedEfforts(env.SKS_CODEX_MODEL_EFFORTS || '')
  if (model && envEfforts.length) {
    const envDefault = normalizeCodexReasoningEffort(env.SKS_CODEX_MODEL_DEFAULT_EFFORT)
    return metadata(
      model,
      envEfforts,
      envDefault || '',
      'env',
      envDefault && envEfforts.includes(envDefault)
        ? []
        : ['codex_model_metadata_default_effort_missing']
    )
  }

  return metadata(model, [], '', 'unavailable', uniqueStrings([
    'codex_model_metadata_unavailable',
    ...(!model ? ['codex_model_selection_unknown'] : []),
    ...(routing.catalog.configured ? routing.catalog.blockers : []),
    ...(configured?.blockers || []),
    appServer.blocker,
    ...(appServer.metadata?.blockers || [])
  ]))
}

async function readAppServerMetadata(input: {
  model: string
  env: NodeJS.ProcessEnv
  codexBin?: string | null
}): Promise<{ metadata: CodexModelMetadata | null; blocker: string | null }> {
  let client: CodexAppServerV2Client | null = null
  try {
    const { createCodexAppServerV2Client } = await import('./codex-app-server-v2-client.js')
    const created = await createCodexAppServerV2Client({
      env: input.env,
      codexBin: input.codexBin || null,
      requestedBy: 'codex-model-metadata',
      timeoutMs: 5_000
    })
    client = created.client
    await client.initialize()
    const payload = await client.request('model/list', { includeHidden: true, limit: 512 })
    return { metadata: metadataFromModelList(payload, input.model), blocker: null }
  } catch {
    return { metadata: null, blocker: 'codex_app_server_model_list_unavailable' }
  } finally {
    await client?.close()
  }
}

function metadataFromCatalog(
  models: readonly CodexCatalogModel[],
  requestedModel: string
): CodexModelMetadata | null {
  if (!requestedModel || models.length === 0) return null
  const row = models.find((candidate) => candidate.model === requestedModel)
  if (!row) {
    return metadata(
      requestedModel,
      [],
      '',
      'codex-catalog',
      ['codex_model_not_found_in_advertised_catalog']
    )
  }
  return metadata(
    requestedModel,
    [...row.reasoning_efforts],
    row.default_reasoning_effort || '',
    'codex-catalog',
    row.default_reasoning_effort
      ? []
      : ['codex_model_metadata_default_effort_missing']
  )
}

function metadataFromModelList(payload: unknown, requestedModel: string): CodexModelMetadata {
  const root = asRecord(payload)
  const rows = Array.isArray(root?.data) ? root.data.map(asRecord) : []
  if (!requestedModel) {
    return metadata('', [], '', 'app-server', ['codex_model_selection_unknown'])
  }
  const row = rows.find((candidate) => modelId(candidate) === requestedModel) || null
  if (!row) {
    return metadata(
      requestedModel,
      [],
      '',
      'app-server',
      ['codex_model_not_found_in_advertised_catalog']
    )
  }
  const efforts = normalizeAdvertisedEfforts(row.supportedReasoningEfforts)
  const defaultEffort = String(row.defaultReasoningEffort || '')
  return metadata(
    requestedModel,
    efforts,
    defaultEffort,
    'app-server',
    efforts.length
      ? defaultEffort
        ? []
        : ['codex_model_metadata_default_effort_missing']
      : ['codex_model_metadata_efforts_missing']
  )
}

function metadata(
  model: string,
  efforts: unknown,
  defaultEffort: unknown,
  source: CodexModelMetadata['source'],
  blockers: string[]
): CodexModelMetadata {
  const advertised = normalizeAdvertisedEfforts(efforts)
  const normalizedDefault = normalizeCodexReasoningEffort(defaultEffort)
  const suppliedDefault = String(defaultEffort || '').trim()
  return {
    schema: 'sks.codex-model-metadata.v1',
    model,
    advertised_efforts: advertised,
    default_effort: normalizedDefault && advertised.includes(normalizedDefault) ? normalizedDefault : '',
    source,
    blockers: uniqueStrings([
      ...blockers,
      ...(advertised.length && suppliedDefault && !normalizedDefault
        ? ['codex_model_metadata_default_effort_invalid']
        : []),
      ...(advertised.length && normalizedDefault && !advertised.includes(normalizedDefault)
        ? ['codex_model_metadata_default_effort_not_advertised']
        : [])
    ])
  }
}

export function normalizeAdvertisedEfforts(value: unknown): string[] {
  const rows = Array.isArray(value) ? value : String(value || '').split(',')
  const seen = new Set<string>()
  const out: string[] = []
  for (const row of rows) {
    const record = asRecord(row)
    const effort = normalizeCodexReasoningEffort(
      record?.reasoningEffort
        || row
    )
    if (!effort || seen.has(effort)) continue
    seen.add(effort)
    out.push(effort)
  }
  return out
}

function modelId(value: Record<string, unknown> | null): string {
  return String(value?.id || value?.model || value?.slug || value?.name || '').trim()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}
