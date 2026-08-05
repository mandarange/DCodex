import type { ProviderContext } from './provider-context.js'

export const PROVIDER_BADGE_SCHEMA = 'sks.provider-badge.v1'

export function providerBadgeText(context: Pick<ProviderContext, 'provider' | 'service_tier' | 'signals'>) {
  const bridgeProvider = context.signals.desktop_bridge_provider
  const providerText = context.provider === 'openai'
    ? 'OpenAI API'
    : context.provider === 'desktop-bridge'
      ? `Desktop Bridge${bridgeProvider ? ` → ${bridgeProvider}` : ''}`
      : context.provider === 'codex-app'
        ? 'Codex App OAuth'
        : 'Unknown'
  const tierText = context.service_tier === 'fast'
    ? 'Fast'
    : context.service_tier === 'standard'
      ? 'Standard'
      : 'Check doctor'
  return `Provider: ${providerText} · ${tierText}`
}

export function providerPaneLabel(context: Pick<ProviderContext, 'provider' | 'service_tier' | 'signals'>) {
  const provider = context.provider === 'unknown'
    ? 'provider-unknown'
    : context.provider === 'desktop-bridge' && context.signals.desktop_bridge_provider
      ? `desktop-bridge/${context.signals.desktop_bridge_provider}`
      : context.provider
  const tier = context.service_tier === 'unknown' ? 'tier-unknown' : context.service_tier
  return `${tier} · ${provider}`
}

export function buildProviderBadge(context: ProviderContext) {
  return {
    schema: PROVIDER_BADGE_SCHEMA,
    ok: !context.conflict,
    text: providerBadgeText(context),
    pane_label: providerPaneLabel(context),
    provider_context: context,
    blockers: context.conflict ? ['provider_conflict'] : []
  }
}
