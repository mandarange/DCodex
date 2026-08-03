import {
  credentialClassForMode,
  parseProviderPolicySnapshot,
  type CredentialClass,
  type CredentialReadiness,
  type ProviderMode,
  type ProviderPolicySnapshot
} from '../../architecture-hardening/contracts/contracts.js';

export type ProviderUpstream = 'chatgpt-oauth' | 'codex-lb' | 'openrouter';

export interface ProviderRouteDecision {
  readonly schema: 'sks.provider-route-decision.v1';
  readonly ok: boolean;
  readonly mode: ProviderMode;
  readonly upstream: ProviderUpstream | null;
  readonly credential_class: CredentialClass;
  readonly model: string | null;
  readonly source_label: string | null;
  readonly blockers: readonly string[];
  readonly failover_allowed: false;
}

export interface ProviderCredentialPort {
  readCredential(credentialClass: CredentialClass): Promise<string | null>;
}

export function decideProviderRoute(input: {
  policy: ProviderPolicySnapshot;
  credential: CredentialReadiness;
  requestedMode: ProviderMode;
  model: string;
}): ProviderRouteDecision {
  const policy = parseProviderPolicySnapshot(input.policy);
  const base = {
    schema: 'sks.provider-route-decision.v1' as const,
    mode: policy.mode,
    credential_class: policy.credential_class,
    failover_allowed: false as const
  };
  if (input.requestedMode !== policy.mode) return blocked(base, 'provider_route_cross_mode_forbidden');
  if (input.credential.status !== 'ready') return blocked(base, `provider_route_credential_${input.credential.status}`);
  const model = String(input.model || '').trim();
  if (!model) return blocked(base, 'provider_route_model_invalid');
  const isOpenRouterModel = model.includes('/');
  if ((policy.mode === 'openrouter') !== isOpenRouterModel) return blocked(base, 'provider_route_model_family_mismatch');
  if (!policy.allowed_models.includes(model)) return blocked(base, 'provider_route_model_not_allowed');
  return {
    ...base,
    ok: true,
    upstream: policy.mode,
    model,
    source_label: policy.mode === 'chatgpt-oauth' ? 'ChatGPT OAuth' : policy.mode === 'codex-lb' ? 'Codex LB' : 'OpenRouter',
    blockers: []
  };
}

export async function resolveCredentialForRoute(
  decision: ProviderRouteDecision,
  port: ProviderCredentialPort
): Promise<string> {
  if (!decision.ok) throw new Error(decision.blockers[0] || 'provider_route_blocked');
  const credential = await port.readCredential(decision.credential_class);
  if (!credential) throw new Error('provider_route_credential_unavailable');
  return credential;
}

export function classifyProviderRouteFailure(status: number): {
  readonly retry_allowed: boolean;
  readonly failover_allowed: false;
  readonly reason_code: string;
} {
  if (status === 401 || status === 403) return { retry_allowed: false, failover_allowed: false, reason_code: 'provider_route_auth_failed' };
  if (status === 402 || status === 429) return { retry_allowed: false, failover_allowed: false, reason_code: 'provider_route_quota_or_rate_limit' };
  if (status >= 500) return { retry_allowed: false, failover_allowed: false, reason_code: 'provider_route_upstream_failed' };
  return { retry_allowed: true, failover_allowed: false, reason_code: 'provider_route_request_failed' };
}

export function emptyProviderCatalogForCredential(input: {
  mode: ProviderMode;
  credential: CredentialReadiness;
  models: readonly string[];
}): readonly string[] {
  if (input.credential.status !== 'ready') return [];
  return input.models.filter((model) => (input.mode === 'openrouter') === model.includes('/'));
}

function blocked(
  base: Pick<ProviderRouteDecision, 'schema' | 'mode' | 'credential_class' | 'failover_allowed'>,
  blocker: string
): ProviderRouteDecision {
  return { ...base, ok: false, upstream: null, model: null, source_label: null, blockers: [blocker] };
}

export function expectedCredentialClass(mode: ProviderMode): CredentialClass {
  return credentialClassForMode(mode);
}
