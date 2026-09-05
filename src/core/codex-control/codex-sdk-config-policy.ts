import type { CodexTaskInput } from './codex-control-plane.js'
import { mapCodexSdkSandboxPolicy } from './codex-sdk-sandbox-policy.js'

export interface CodexExecutionPolicy {
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval: 'untrusted' | 'on-request' | 'never'
  network: 'disabled' | 'proxy-limited' | 'full'
  webSearch: 'disabled' | 'cached' | 'indexed' | 'live'
  gitRepoCheck: 'required' | 'allow-explicit-non-git'
  mutation: 'deny' | 'ledgered' | 'transactional'
}

export function buildCodexSdkConfig(input: CodexTaskInput) {
  const model = String(input.model || process.env.SKS_CODEX_MODEL || process.env.CODEX_MODEL || '').trim()
  const serviceTier = String(input.serviceTier || process.env.SKS_SERVICE_TIER || 'fast')
  const effort = String(input.modelReasoningEffort || input.reasoningEffort || process.env.SKS_CODEX_REASONING || process.env.CODEX_MODEL_REASONING_EFFORT || 'medium')
  const config: Record<string, unknown> = {
    // Internal control-plane work is always native Codex. Ambient proxy
    // credentials are not provider-selection consent.
    model_provider: 'openai',
    forced_login_method: 'chatgpt',
    service_tier: serviceTier === 'standard' ? 'standard' : 'fast',
    model_reasoning_effort: normalizeAstraSdkEffort(model, effort),
    mcp_servers: {},
    sks: {
      route: input.route,
      tier: input.tier || 'worker',
      mission_id: input.missionId,
      slot_id: input.slotId || '',
      generation_index: Number(input.generationIndex || 0)
    }
  }
  if (model) config.model = model
  if (input.requestedScopeContract?.no_mcp === true) {
    config.mcp_servers = {}
    config.sks = { ...(config.sks as Record<string, unknown>), no_mcp: true }
  }
  return config
}

/** Official Astra migration guidance maps the retired none/minimal settings to low. */
export function normalizeAstraSdkEffort(model: string, effort: string): string {
  return model.trim().toLowerCase() === 'gpt-6-astra' && ['none', 'minimal'].includes(effort.trim().toLowerCase())
    ? 'low' : effort
}

export function buildCodexExecutionPolicy(input: CodexTaskInput): CodexExecutionPolicy {
  const sandbox = mapCodexSdkSandboxPolicy(input).sandboxMode
  const approval = String(process.env.SKS_CODEX_APPROVAL || (String(input.tier || '') === 'verifier' ? 'never' : 'on-request')) as CodexExecutionPolicy['approval']
  const network = String(process.env.SKS_CODEX_NETWORK || 'disabled') as CodexExecutionPolicy['network']
  const webSearch = String(process.env.SKS_CODEX_WEB_SEARCH || 'cached') as CodexExecutionPolicy['webSearch']
  const gitRepoCheck = process.env.SKS_CODEX_ALLOW_NON_GIT === '1' ? 'allow-explicit-non-git' : 'required'
  const mutation = String(input.tier || '') === 'verifier' || sandbox === 'read-only' ? 'deny' : 'ledgered'
  return {
    sandbox,
    approval,
    network,
    webSearch,
    gitRepoCheck,
    mutation
  }
}

export function redactCodexSdkConfig(config: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(config, (_key, value) => {
    if (typeof value === 'string' && /(?:key|token|secret|password|credential|auth|cookie)/i.test(value)) return '<redacted>'
    return value
  }))
}
