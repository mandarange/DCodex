import path from 'node:path'
import type { BridgeProviderId, DesktopBridgeStatusV3 } from '../codex-lb/bridge-contracts.js'
import { exists, nowIso, readJson, writeJsonAtomic } from '../fsx.js'

export const PROVIDER_CONTEXT_SCHEMA = 'sks.provider-context.v2'

export type ProviderId = 'openai' | 'desktop-bridge' | 'codex-app' | 'unknown'
export type ProviderAuthMode = 'api_key' | 'chatgpt_oauth' | 'unknown'
export type ProviderContextSource = 'env' | 'desktop_bridge' | 'codex_app' | 'unknown'

export interface ProviderContext {
  schema: typeof PROVIDER_CONTEXT_SCHEMA
  generated_at: string
  provider: ProviderId
  auth_mode: ProviderAuthMode
  route: string
  service_tier: 'fast' | 'standard' | 'unknown'
  source: ProviderContextSource
  confidence: 'high' | 'medium' | 'low'
  conflict: false
  warnings: string[]
  signals: {
    openai_api_key_present: boolean
    codex_app_auth_present: boolean
    desktop_bridge_status_available: boolean
    desktop_bridge_managed: boolean
    desktop_bridge_ready: boolean
    desktop_bridge_provider: BridgeProviderId | null
    desktop_bridge_native_identity_configured: boolean
    desktop_bridge_credential_state: string | null
  }
}

export async function resolveProviderContext(input: {
  root?: string
  route?: string | null
  serviceTier?: string | null
  env?: NodeJS.ProcessEnv
  codexHome?: string | null
  desktopBridgeStatus?: DesktopBridgeStatusV3 | null
  desktopBridgeStatusImpl?: (options?: Record<string, unknown>) => Promise<DesktopBridgeStatusV3>
  desktopBridgeStatusOptions?: Record<string, unknown>
} = {}): Promise<ProviderContext> {
  const env = input.env || process.env
  const root = path.resolve(input.root || process.cwd())
  const codexHome = path.resolve(String(input.codexHome || env.CODEX_HOME || path.join(env.HOME || root, '.codex')))
  const auth = await readJson<unknown>(path.join(codexHome, 'auth.json'), null).catch(() => null)
  const appAuthPresent = Boolean(auth) || await exists(path.join(codexHome, 'auth.json'))
  const openaiKeyPresent = Boolean(String(env.OPENAI_API_KEY || '').trim())

  let bridgeStatus: DesktopBridgeStatusV3 | null = null
  let bridgeStatusAvailable = false
  try {
    bridgeStatus = Object.prototype.hasOwnProperty.call(input, 'desktopBridgeStatus')
      ? input.desktopBridgeStatus || null
      : await (input.desktopBridgeStatusImpl || currentDesktopBridgeStatus)(input.desktopBridgeStatusOptions || {})
    bridgeStatusAvailable = bridgeStatus?.schema === 'sks.desktop-bridge-status.v3'
    if (!bridgeStatusAvailable) bridgeStatus = null
  } catch {
    bridgeStatus = null
  }

  const bridgeManaged = bridgeStatus?.management.managed === true
  const bridgeReady = bridgeStatus?.readiness.ready === true
  const bridgeProvider = selectedBridgeProvider(bridgeStatus)
  const nativeIdentityConfigured = bridgeStatus?.native_identity.configured === true || appAuthPresent
  const credentialState = bridgeProvider && bridgeStatus
    ? bridgeStatus.providers[bridgeProvider].credential.state
    : null

  let provider: ProviderId = 'unknown'
  let authMode: ProviderAuthMode = 'unknown'
  let source: ProviderContextSource = 'unknown'
  let confidence: ProviderContext['confidence'] = 'low'
  if (bridgeManaged) {
    provider = 'desktop-bridge'
    authMode = nativeIdentityConfigured ? 'chatgpt_oauth' : 'unknown'
    source = 'desktop_bridge'
    confidence = bridgeReady && nativeIdentityConfigured ? 'high' : 'medium'
  } else if (openaiKeyPresent) {
    provider = 'openai'
    authMode = 'api_key'
    source = 'env'
    confidence = 'high'
  } else if (appAuthPresent) {
    provider = 'codex-app'
    authMode = 'chatgpt_oauth'
    source = 'codex_app'
    confidence = 'medium'
  }

  const warnings = unique([
    ...(!bridgeStatusAvailable ? ['desktop_bridge_status_unavailable'] : []),
    ...(bridgeManaged ? bridgeStatus?.readiness.blockers || [] : []),
    ...(bridgeManaged ? bridgeStatus?.routing.blockers || [] : []),
    ...(bridgeManaged && !nativeIdentityConfigured ? ['desktop_bridge_native_identity_required'] : [])
  ])
  return {
    schema: PROVIDER_CONTEXT_SCHEMA,
    generated_at: nowIso(),
    provider,
    auth_mode: authMode,
    route: String(input.route || env.SKS_ROUTE || '$Naruto'),
    service_tier: normalizeServiceTier(input.serviceTier || env.SKS_SERVICE_TIER),
    source,
    confidence,
    conflict: false,
    warnings,
    signals: {
      openai_api_key_present: openaiKeyPresent,
      codex_app_auth_present: appAuthPresent,
      desktop_bridge_status_available: bridgeStatusAvailable,
      desktop_bridge_managed: bridgeManaged,
      desktop_bridge_ready: bridgeReady,
      desktop_bridge_provider: bridgeProvider,
      desktop_bridge_native_identity_configured: nativeIdentityConfigured,
      desktop_bridge_credential_state: credentialState
    }
  }
}

export async function writeProviderContextReport(root: string = process.cwd(), input: Parameters<typeof resolveProviderContext>[0] = {}) {
  const report = await resolveProviderContext({ ...input, root })
  const reportPath = path.join(path.resolve(root), '.sneakoscope', 'reports', 'provider-context.json')
  await writeJsonAtomic(reportPath, report)
  return { ...report, report_path: reportPath }
}

function selectedBridgeProvider(status: DesktopBridgeStatusV3 | null): BridgeProviderId | null {
  const selected = status?.routing.selected_route?.provider_id
  // Official passthrough is not a provider identity: fall through to the
  // policy default or session pin for provider-context classification.
  return (selected === 'codex-lb' || selected === 'openrouter' ? selected : null)
    || status?.routing.policy?.default_provider_id
    || status?.routing.session_pin?.provider_id
    || null
}

async function currentDesktopBridgeStatus(options: Record<string, unknown>): Promise<DesktopBridgeStatusV3> {
  const controller = await import('../codex-lb/desktop-controller.js')
  return controller.desktopBridgeStatusV3(options)
}

function normalizeServiceTier(value: unknown): ProviderContext['service_tier'] {
  const text = String(value || '').toLowerCase()
  if (text === 'fast' || text === 'priority') return 'fast'
  if (text === 'standard' || text === 'default') return 'standard'
  return 'unknown'
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))]
}
