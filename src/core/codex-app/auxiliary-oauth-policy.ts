import type { CodexProxyProviderMode } from './provider-mode.js';

export interface AuxiliaryOAuthFeatureContract {
  readonly feature: string;
  readonly request_path: string;
  readonly protocol_verified: boolean;
  readonly proxy_supported: boolean;
}

export function decideAuxiliaryOAuthRoute(input: {
  mode: CodexProxyProviderMode;
  contract: AuxiliaryOAuthFeatureContract;
  oauthConnected: boolean;
  userAllowed: boolean;
}) {
  const base = {
    schema: 'sks.auxiliary-oauth-route-decision.v1' as const,
    session_mode: input.mode,
    feature: input.contract.feature,
    request_path: input.contract.request_path,
    session_mode_changed: false as const
  };
  if (input.contract.proxy_supported) {
    return { ...base, route: input.mode, auxiliary_oauth_used: false, status: 'proxy_supported' as const, blockers: [] };
  }
  if (!input.contract.protocol_verified) {
    return { ...base, route: null, auxiliary_oauth_used: false, status: 'blocked' as const, blockers: ['auxiliary_oauth_feature_protocol_unverified'] };
  }
  if (!input.userAllowed) {
    return { ...base, route: null, auxiliary_oauth_used: false, status: 'permission_required' as const, blockers: ['auxiliary_oauth_user_permission_required'] };
  }
  if (!input.oauthConnected) {
    return { ...base, route: null, auxiliary_oauth_used: false, status: 'oauth_required' as const, blockers: ['auxiliary_oauth_connection_required'] };
  }
  return {
    ...base,
    route: 'chatgpt-oauth' as const,
    auxiliary_oauth_used: true,
    status: 'auxiliary_oauth' as const,
    blockers: [],
    audit_event: {
      schema: 'sks.auxiliary-oauth-event.v1' as const,
      event: 'feature_request_routed_via_auxiliary_oauth' as const,
      feature: input.contract.feature,
      reason: `${input.mode}_proxy_does_not_support_feature`,
      credential_path: 'chatgpt-oauth' as const,
      session_mode: input.mode
    }
  };
}
