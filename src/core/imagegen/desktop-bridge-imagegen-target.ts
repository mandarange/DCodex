import { desktopBridgeStatusV3 } from '../codex-lb/desktop-controller-v3.js';
import type {
  BridgeProviderId,
  BridgeRouteTarget,
  DesktopBridgeStatusV3
} from '../codex-lb/bridge-contracts.js';

export const DESKTOP_BRIDGE_IMAGEGEN_TARGET_SCHEMA = 'sks.desktop-bridge-imagegen-target.v1';
export const DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE =
  'Run `sks bridge status --json` to inspect Desktop Bridge provider readiness.';

export interface DesktopBridgeImagegenTarget {
  readonly schema: typeof DESKTOP_BRIDGE_IMAGEGEN_TARGET_SCHEMA;
  /** True only when SKS currently owns routing through Desktop Bridge. */
  readonly selected: boolean;
  readonly bridge_verified: boolean;
  readonly endpoint: string | null;
  readonly model: string | null;
  readonly model_source: 'explicit' | null;
  readonly route: BridgeRouteTarget | null;
  readonly provider_id: BridgeProviderId | null;
  readonly status_source: 'runtime' | 'injected_fixture';
  readonly live_evidence_allowed: boolean;
  readonly blocker: string | null;
  readonly setup_guidance: typeof DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE;
}

/**
 * Resolve managed ImageGen only through the active Desktop Bridge route.
 *
 * Provider endpoints and credentials are intentionally absent from this
 * contract. The bridge resolves both after it validates the exact public model
 * against its current route index.
 */
export async function resolveDesktopBridgeImagegenTarget(opts: {
  home?: string;
  env?: NodeJS.ProcessEnv;
  explicitModel?: string | null;
  desktopBridgeStatus?: DesktopBridgeStatusV3 | null;
  desktopBridgeStatusImpl?: (input: { home?: string; env?: NodeJS.ProcessEnv }) => Promise<DesktopBridgeStatusV3>;
} = {}): Promise<DesktopBridgeImagegenTarget> {
  const env = opts.env || process.env;
  const injected = opts.desktopBridgeStatus !== undefined || opts.desktopBridgeStatusImpl !== undefined;
  const status = opts.desktopBridgeStatus !== undefined
    ? opts.desktopBridgeStatus
    : await (opts.desktopBridgeStatusImpl || desktopBridgeStatusV3)({
        ...(opts.home ? { home: opts.home } : {}),
        env
      }).catch(() => null);
  const model = String(opts.explicitModel ?? env.SKS_IMAGEGEN_RESPONSES_MODEL ?? '').trim() || null;
  const selected = status?.schema === 'sks.desktop-bridge-status.v3'
    && status.management?.managed === true;
  const loopbackOrigin = verifiedLoopbackOrigin(status);
  const policy = status?.routing?.policy || null;
  const route = model && policy?.fallback === 'none'
    ? policy.model_routes?.[model] || null
    : null;
  // Official passthrough routes have no provider profile; bridge imagegen
  // evidence stays a provider-routed feature.
  const provider = route && route.provider_id !== 'openai' ? status?.providers?.[route.provider_id] || null : null;
  const providerImagegen = provider?.capabilities?.capabilities?.image_generation || null;
  const blocker = !status || status.schema !== 'sks.desktop-bridge-status.v3'
    ? 'desktop_bridge_status_unavailable'
    : !selected
      ? 'desktop_bridge_not_managed'
      : status.service?.running !== true || status.service?.state !== 'ready'
        ? 'desktop_bridge_not_running'
        : !loopbackOrigin
          ? 'desktop_bridge_loopback_unverified'
          : status.readiness?.bridge_ready !== true || status.catalog_sync?.state !== 'verified'
            ? status.readiness?.blockers?.[0] || status.catalog_sync?.blockers?.[0] || 'desktop_bridge_state_unverified'
            : !model
              ? 'desktop_bridge_imagegen_model_missing'
              : !policy || policy.fallback !== 'none' || !route
                ? 'catalog_model_route_missing'
                : provider?.enabled !== true
                  ? 'bridge_route_provider_disabled'
                  : provider.credential?.state !== 'ready'
                    ? provider.credential?.blockers?.[0] || 'bridge_route_provider_credential_unverified'
                    : providerImagegen?.state !== 'verified'
                      ? providerImagegen?.blockers?.[0] || 'bridge_route_imagegen_capability_unverified'
                      : null;
  const bridgeVerified = blocker === null;
  return {
    schema: DESKTOP_BRIDGE_IMAGEGEN_TARGET_SCHEMA,
    selected,
    bridge_verified: bridgeVerified,
    endpoint: bridgeVerified ? `${loopbackOrigin}/backend-api/codex/responses` : null,
    model,
    model_source: model ? 'explicit' : null,
    route: route || null,
    provider_id: route && route.provider_id !== 'openai' ? route.provider_id : null,
    status_source: injected ? 'injected_fixture' : 'runtime',
    live_evidence_allowed: bridgeVerified && !injected,
    blocker,
    setup_guidance: DESKTOP_BRIDGE_IMAGEGEN_RECOVERY_GUIDANCE
  };
}

function verifiedLoopbackOrigin(status: DesktopBridgeStatusV3 | null | undefined): string | null {
  const raw = String(status?.service?.loopback_origin || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const loopback = parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]';
    if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.port) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}
