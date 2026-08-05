import type { BridgeProviderId, CapabilityProbeResultV3, DesktopBridgeStatusV3 } from '../bridge-contracts.js';
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js';
import { activeProviderIds, providerCode } from './shared.js';
import type { ControllerCore, ProbeContext } from './types.js';

export function nativeIdentityProbe(core: ControllerCore, context: ProbeContext): CapabilityProbeResultV3 {
  const oauth = core.auth.mode === 'chatgpt_oauth' || core.auth.mode === 'mixed';
  return capabilityProbeResultV3({
    ...context,
    capability: 'oauth_identity',
    scope: 'native-identity',
    stage: 'preflight',
    state: oauth ? 'verified' : 'blocked',
    terminal: !oauth,
    rootCause: oauth ? null : 'chatgpt_oauth_required_for_desktop',
    blockers: oauth ? [] : ['chatgpt_oauth_required_for_desktop'],
    retryable: false,
    recoveryAction: oauth ? null : 'review_desktop_authentication',
    source: 'config',
    evidence: {
      oauth_present: oauth,
      semantic_identity_available: Boolean(core.auth.semantic_fingerprint),
      oauth_requirement: 'required'
    }
  });
}

export function combinedRoutePolicyProbe(core: ControllerCore, context: ProbeContext): CapabilityProbeResultV3 {
  const verified = Boolean(core.policy && core.activeCatalog.ok
    && core.policy.catalog_generation === core.activeCatalog.catalog.generation
    && core.policyBlockers.length === 0);
  return capabilityProbeResultV3({
    ...context,
    capability: 'route_policy',
    scope: 'catalog:combined',
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'blocked',
    terminal: !verified,
    rootCause: verified ? null : String(core.policyBlockers[0] || 'bridge_route_policy_missing'),
    blockers: verified ? [] : [...core.policyBlockers],
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      catalog_generation: core.activeCatalog.ok ? core.activeCatalog.catalog.generation : null,
      route_policy_generation: core.policy?.policy_generation || null,
      fallback: 'none'
    }
  });
}

export function combinedModelRouteProbe(
  core: ControllerCore,
  status: DesktopBridgeStatusV3,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const active = activeProviderIds(core);
  const verified = active.length > 0 && active.every((providerId) =>
    Boolean(core.policy && Object.values(core.policy.model_routes).some((route) => route.provider_id === providerId)));
  return capabilityProbeResultV3({
    ...context,
    capability: 'model_route',
    scope: 'catalog:combined',
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'blocked',
    terminal: !verified,
    rootCause: verified ? null : 'catalog_model_route_missing',
    blockers: verified ? [] : ['catalog_model_route_missing'],
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      active_provider_ids: active,
      route_count: status.catalog_sync.route_count,
      fallback: 'none'
    }
  });
}

export function providerCredentialProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const profile = core.registry.profiles[providerId];
  const ready = profile.credential.state === 'ready';
  const blocked = ['rejected', 'unavailable', 'stale'].includes(profile.credential.state);
  const root = blocked ? profile.credential.blockers[0] || `${providerCode(providerId)}_credential_unavailable` : null;
  return capabilityProbeResultV3({
    ...context,
    capability: 'credential',
    scope: `provider:${providerId}`,
    stage: 'preflight',
    state: ready ? 'verified' : blocked ? 'blocked' : 'not_attempted',
    terminal: blocked,
    rootCause: root,
    blockers: root ? [root] : [],
    warnings: profile.credential.warnings,
    retryable: blocked,
    recoveryAction: ready ? null : providerId === 'codex-lb'
      ? 'configure_codex_lb_credential' : 'configure_openrouter_credential',
    source: ready ? 'transport' : 'config',
    evidence: {
      provider_id: providerId,
      credential_state: profile.credential.state,
      credential_fingerprint: profile.credential.fingerprint,
      route: providerId
    }
  });
}

export function providerAuthProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const profile = core.registry.profiles[providerId];
  const verified = profile.credential.state === 'ready' && core.catalogSync.providers[providerId].state === 'verified';
  const blocked = profile.enabled && ['rejected', 'unavailable', 'stale'].includes(profile.credential.state);
  const root = blocked ? profile.credential.blockers[0] || `${providerCode(providerId)}_auth_rejected` : null;
  return capabilityProbeResultV3({
    ...context,
    capability: 'provider_auth',
    scope: `provider:${providerId}`,
    stage: verified ? 'complete' : 'provider_auth',
    state: verified ? 'verified' : blocked ? 'blocked' : 'not_attempted',
    terminal: blocked,
    rootCause: root,
    blockers: root ? [root] : [],
    retryable: blocked,
    recoveryAction: verified ? null : providerId === 'codex-lb'
      ? 'configure_codex_lb_credential' : 'configure_openrouter_credential',
    source: verified || blocked ? 'transport' : 'config',
    evidence: {
      provider_id: providerId,
      auth_transport: profile.endpoint.auth_transport,
      credential_fingerprint: profile.credential.fingerprint,
      oauth_forwarded: false
    }
  });
}

export function providerModelRouteProbe(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext
): CapabilityProbeResultV3 {
  const route = core.policy
    ? Object.entries(core.policy.model_routes).find(([, target]) => target.provider_id === providerId)
    : null;
  const verified = Boolean(route && core.catalogSync.providers[providerId].state === 'verified');
  return capabilityProbeResultV3({
    ...context,
    capability: 'model_route',
    scope: `provider:${providerId}`,
    stage: verified ? 'complete' : 'model_route',
    state: verified ? 'verified' : 'not_attempted',
    retryable: !verified,
    recoveryAction: verified ? null : 'refresh_catalog_or_select_supported_model',
    source: 'config',
    evidence: {
      provider_id: providerId,
      public_model: route?.[0] || null,
      upstream_model: route?.[1].upstream_model || null,
      catalog_generation: core.policy?.catalog_generation || null,
      fallback: 'none'
    }
  });
}
