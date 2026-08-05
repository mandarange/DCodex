import path from 'node:path'
import { exists, nowIso, readJson, readText, writeJsonAtomic } from '../fsx.js'
import { escapeRegExp } from '../text/regex.js'

export const PROVIDER_CONTEXT_SCHEMA = 'sks.provider-context.v1'

export type ProviderId = 'openai' | 'codex-lb' | 'codex-app' | 'unknown'
export type ProviderAuthMode = 'api_key' | 'chatgpt_oauth' | 'codex_lb_key' | 'unknown'
export type ProviderContextSource = 'env' | 'config' | 'codex_app' | 'codex_lb' | 'unknown'

export interface ProviderContext {
  schema: typeof PROVIDER_CONTEXT_SCHEMA
  generated_at: string
  provider: ProviderId
  auth_mode: ProviderAuthMode
  route: string
  service_tier: 'fast' | 'standard' | 'unknown'
  source: ProviderContextSource
  confidence: 'high' | 'medium' | 'low'
  conflict: boolean
  warnings: string[]
  signals: {
    openai_api_key_present: boolean
    codex_lb_key_present: boolean
    codex_lb_explicit: boolean
    codex_app_auth_present: boolean
    model_provider: string | null
    codex_lb_provider_block_present?: boolean
    codex_lb_env_key?: string | null
    codex_lb_gateway_header_env_key?: string | null
    codex_lb_requires_openai_auth?: boolean | null
    codex_lb_available?: boolean
  }
}

export async function resolveProviderContext(input: {
  root?: string
  route?: string | null
  serviceTier?: string | null
  modelProvider?: string | null
  env?: NodeJS.ProcessEnv
  codexHome?: string | null
} = {}): Promise<ProviderContext> {
  const env = input.env || process.env
  const root = path.resolve(input.root || process.cwd())
  const codexHome = path.resolve(String(input.codexHome || env.CODEX_HOME || path.join(env.HOME || '', '.codex')))
  const configText = await readText(path.join(codexHome, 'config.toml'), '').catch(() => '')
  const configModelProvider = readTopLevelTomlString(configText, 'model_provider')
  const codexLbProviderBlockPresent = hasCodexLbProviderBlock(configText)
  const codexLbBearerEnvKey = codexLbProviderBearerEnvKey(configText)
  const codexLbGatewayHeaderEnvKey = codexLbProviderGatewayHeaderEnvKey(configText)
  const codexLbEnvKey = codexLbGatewayHeaderEnvKey || codexLbBearerEnvKey
  const codexLbRequiresOpenAiAuth = codexLbProviderRequiresOpenAiAuth(configText)
  const codexLbProviderValid = codexLbProviderBlockPresent
    && codexLbBearerEnvKey === 'CODEX_LB_API_KEY'
    && codexLbGatewayHeaderEnvKey === null
    && codexLbRequiresOpenAiAuth === false
  const openaiKey = Boolean(String(env.OPENAI_API_KEY || '').trim())
  const lbKey = Boolean(String((codexLbEnvKey ? env[codexLbEnvKey] : env.CODEX_LB_API_KEY) || env.CODEX_LB_API_KEY || '').trim())
  const envProvider = String(env.SKS_MODEL_PROVIDER || env.CODEX_MODEL_PROVIDER || env.OPENAI_MODEL_PROVIDER || '').trim()
  const modelProvider = String(input.modelProvider || envProvider || configModelProvider || '').trim() || null
  const envLbExplicit = env.SKS_PROVIDER === 'codex-lb' || env.SKS_USE_CODEX_LB === '1'
  const lbExplicit = modelProvider === 'codex-lb' || envLbExplicit
  const auth = await readJson<any>(path.join(codexHome, 'auth.json'), null).catch(() => null)
  const appAuthPresent = Boolean(auth) || await exists(path.join(codexHome, 'auth.json'))
  const conflict = (lbKey && openaiKey && !lbExplicit && !modelProvider) || (modelProvider === 'codex-lb' && !lbKey && openaiKey)
  let provider: ProviderId = 'unknown'
  let authMode: ProviderAuthMode = 'unknown'
  let source: ProviderContextSource = 'unknown'
  let confidence: ProviderContext['confidence'] = 'low'
  if (envLbExplicit && lbKey) {
    provider = 'codex-lb'
    authMode = 'codex_lb_key'
    source = 'codex_lb'
    confidence = 'high'
  } else if (modelProvider === 'codex-lb' && codexLbProviderValid && lbKey) {
    provider = 'codex-lb'
    authMode = 'codex_lb_key'
    source = 'config'
    confidence = 'high'
  } else if (modelProvider === 'codex-lb' && codexLbProviderValid) {
    provider = 'codex-lb'
    authMode = 'unknown'
    source = 'config'
    confidence = 'low'
  } else if (openaiKey) {
    provider = 'openai'
    authMode = 'api_key'
    source = 'env'
    confidence = conflict ? 'medium' : 'high'
  } else if (appAuthPresent) {
    provider = 'codex-app'
    authMode = 'chatgpt_oauth'
    source = 'codex_app'
    confidence = 'medium'
  }
  const warnings = [
    ...(conflict ? ['provider_conflict'] : []),
    ...(modelProvider === 'codex-lb' && !codexLbProviderValid && !envLbExplicit ? ['codex_lb_provider_config_missing_or_invalid'] : []),
    ...(provider === 'codex-lb' && !lbKey ? ['codex_lb_selected_without_key'] : [])
  ]
  return {
    schema: PROVIDER_CONTEXT_SCHEMA,
    generated_at: nowIso(),
    provider,
    auth_mode: authMode,
    route: String(input.route || env.SKS_ROUTE || '$Naruto'),
    service_tier: normalizeServiceTier(input.serviceTier || env.SKS_SERVICE_TIER),
    source,
    confidence,
    conflict,
    warnings,
    signals: {
      openai_api_key_present: openaiKey,
      codex_lb_key_present: lbKey,
      codex_lb_explicit: lbExplicit,
      codex_app_auth_present: appAuthPresent,
      model_provider: modelProvider,
      codex_lb_provider_block_present: codexLbProviderBlockPresent,
      codex_lb_env_key: codexLbEnvKey,
      codex_lb_gateway_header_env_key: codexLbGatewayHeaderEnvKey,
      codex_lb_requires_openai_auth: codexLbRequiresOpenAiAuth,
      codex_lb_available: codexLbProviderValid && lbKey
    }
  }
}

export async function writeProviderContextReport(root: string = process.cwd(), input: Parameters<typeof resolveProviderContext>[0] = {}) {
  const report = await resolveProviderContext({ ...input, root })
  const reportPath = path.join(path.resolve(root), '.sneakoscope', 'reports', 'provider-context.json')
  await writeJsonAtomic(reportPath, report)
  return { ...report, report_path: reportPath }
}

function normalizeServiceTier(value: unknown): ProviderContext['service_tier'] {
  const text = String(value || '').toLowerCase()
  if (text === 'fast' || text === 'priority') return 'fast'
  if (text === 'standard' || text === 'default') return 'standard'
  return 'unknown'
}

export function readTopLevelTomlString(text: string, key: string): string | null {
  const lines = String(text || '').split(/\r?\n/)
  for (const line of lines) {
    if (/^\s*\[/.test(line)) break
    const match = line.match(new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]*)"\\s*(?:#.*)?$`))
    if (match?.[1] != null) return match[1]
  }
  return null
}

export function hasCodexLbProviderBlock(text: string): boolean {
  return codexLbProviderBody(text) != null
}

export function codexLbProviderEnvKey(text: string): string | null {
  return codexLbProviderGatewayHeaderEnvKey(text) || codexLbProviderBearerEnvKey(text)
}

export function codexLbProviderGatewayHeaderEnvKey(text: string): string | null {
  const body = codexLbProviderBody(text)
  if (body == null) return null
  const inline = body.match(/(?:^|\n)\s*env_http_headers\s*=\s*\{([^}]*)\}/)?.[1] || ''
  return inline.match(/"X-Codex-LB-API-Key"\s*=\s*"([^"]+)"/)?.[1] || null
}

function codexLbProviderBearerEnvKey(text: string): string | null {
  const body = codexLbProviderBody(text)
  return body == null ? null : readTopLevelTomlString(body, 'env_key')
}

export function codexLbProviderRequiresOpenAiAuth(text: string): boolean | null {
  const body = codexLbProviderBody(text)
  if (body == null) return null
  const match = body.match(/^\s*requires_openai_auth\s*=\s*(true|false)\s*(?:#.*)?$/m)
  return match?.[1] === 'true' ? true : match?.[1] === 'false' ? false : null
}

function codexLbProviderBody(text: string): string | null {
  const lines = String(text || '').split(/\r?\n/)
  const out: string[] = []
  let inTable = false
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1]?.trim()
    if (table) {
      if (inTable) break
      inTable = table === 'model_providers.codex-lb' || table === 'model_providers."codex-lb"' || table === '"model_providers"."codex-lb"'
      continue
    }
    if (inTable) out.push(line)
  }
  return inTable ? out.join('\n') : null
}
