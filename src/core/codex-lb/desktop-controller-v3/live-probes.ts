import type {
  BridgeProviderId,
  CapabilityProbeResultV3,
  CapabilityRequestedLevel,
  HttpProbeResult,
  WebSocketProbeResult
} from '../bridge-contracts.js';
import {
  DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH,
  DESKTOP_BRIDGE_DIAGNOSTIC_PATH,
  probeDesktopBridgeWebSocket
} from '../desktop-bridge/index.js';
import { runImageGenerationProbeV3 } from '../probes/image-generation-probe.js';
import { runComputerUseProbeV3 } from '../probes/computer-use-probe.js';
import { runVoiceRealtimeProbeV3 } from '../probes/voice-realtime-probe.js';
import { runAuxiliarySurfacesProbeV3 } from '../probes/auxiliary-surfaces-probe.js';
import { capabilityProbeResultV3 } from '../probes/probe-evidence.js';
import { validateCapabilityDeepEvidenceV2 } from '../trusted-deep-evidence.js';
import { providerCode, safeCode, timeoutMs, unique } from './shared.js';
import type { ControllerCore, DesktopBridgeControllerV3Options, ProbeContext } from './types.js';

export async function probeProviderText(
  core: ControllerCore,
  providerId: BridgeProviderId,
  loopbackOrigin: string | null,
  context: ProbeContext,
  options: DesktopBridgeControllerV3Options
): Promise<CapabilityProbeResultV3> {
  const route = core.policy
    ? Object.entries(core.policy.model_routes).find(([, target]) => target.provider_id === providerId)
    : null;
  if (!loopbackOrigin || !route) {
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: 'feature_request',
      state: 'not_attempted',
      retryable: true,
      recoveryAction: 'repair_bridge_service',
      source: 'transport',
      evidence: { provider_id: providerId, reason: 'bridge_or_route_unavailable' }
    });
  }
  const publicModel = route[0];
  const request = options.fetchImpl || globalThis.fetch;
  const endpoint = providerId === 'codex-lb'
    ? `${loopbackOrigin}/backend-api/codex/responses`
    : `${loopbackOrigin}/api/v1/chat/completions`;
  const body = providerId === 'codex-lb'
    ? { model: publicModel, input: 'Reply with OK.', max_output_tokens: 1, store: false }
    : {
        model: publicModel,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 1,
        provider: { allow_fallbacks: false }
      };
  try {
    const response = await request(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        origin: 'app://codex',
        'x-sks-model': publicModel
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs(options))
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('provider_text_response_too_large');
    let payload: unknown = null;
    try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
    const valid = response.ok && payload !== null && typeof payload === 'object';
    const root = valid ? null : `${providerCode(providerId)}_text_response_failed`;
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: valid ? 'complete' : 'feature_response',
      state: valid ? 'verified' : 'blocked',
      terminal: !valid,
      rootCause: root,
      blockers: root ? [root] : [],
      retryable: !valid,
      recoveryAction: valid ? null : 'retry_provider_transport_probe',
      source: 'transport',
      evidence: {
        provider_id: providerId,
        public_model: publicModel,
        http_status: response.status,
        response_object: valid,
        fallback: 'none'
      }
    });
  } catch (error) {
    const root = safeCode(error, `${providerCode(providerId)}_text_response_failed`);
    return capabilityProbeResultV3({
      ...context,
      capability: 'text_responses',
      scope: `provider:${providerId}`,
      stage: 'feature_request',
      state: 'failed',
      terminal: true,
      rootCause: root,
      blockers: [root],
      retryable: true,
      recoveryAction: 'retry_provider_transport_probe',
      source: 'transport',
      evidence: { provider_id: providerId, public_model: publicModel, fallback: 'none' }
    });
  }
}

export async function probeProviderDeep(
  core: ControllerCore,
  providerId: BridgeProviderId,
  context: ProbeContext,
  options: DesktopBridgeControllerV3Options
): Promise<CapabilityProbeResultV3[]> {
  const endpoint = core.registry.profiles[providerId].endpoint.url || '';
  const catalogGeneration = core.activeCatalog.ok ? core.activeCatalog.catalog.generation : '';
  return runDesktopBridgeDeepProviderProbesV3(providerId, context, endpoint, catalogGeneration, options.deepProbeImpl);
}

export async function runDesktopBridgeDeepProviderProbesV3(
  providerId: BridgeProviderId,
  context: ProbeContext,
  endpoint: string,
  catalogGeneration: string,
  probeImpl?: DesktopBridgeControllerV3Options['deepProbeImpl']
): Promise<CapabilityProbeResultV3[]> {
  let evidence = null;
  let adapterFailed = false;
  if (probeImpl && endpoint && catalogGeneration) {
    try {
      evidence = await probeImpl({
        provider_id: providerId,
        report_id: context.reportId,
        correlation_id: context.correlationId,
        session_id: context.sessionId,
        checked_at: context.checkedAt,
        catalog_generation: catalogGeneration,
        endpoint
      });
    } catch {
      adapterFailed = true;
    }
  }
  const providerContext = { ...context, providerId };
  const results: CapabilityProbeResultV3[] = [
    runImageGenerationProbeV3({ ...providerContext, ...(evidence?.image_generation || {}) }),
    runComputerUseProbeV3({ ...providerContext, ...(evidence?.computer_use || {}) }),
    runVoiceRealtimeProbeV3({ ...providerContext, ...(evidence?.voice_mode || {}) }),
    runAuxiliarySurfacesProbeV3({ ...providerContext, ...(evidence?.auxiliary_surfaces || {}) })
  ];
  if (adapterFailed) {
    for (const result of results) result.warnings = unique([...result.warnings, 'deep_probe_adapter_failed']);
  }
  for (const [capability, trusted] of Object.entries(evidence?.trusted || {})) {
    if (!trusted || results.some((result) => result.capability === capability)) continue;
    const validation = validateCapabilityDeepEvidenceV2(trusted.envelope, {
      expectedProviderId: providerId,
      expectedScope: `provider:${providerId}`,
      expectedCapability: capability,
      expectedReportId: context.reportId,
      expectedCatalogGeneration: catalogGeneration,
      expectedEndpoint: endpoint,
      trustAnchors: trusted.trust_anchors,
      now: context.checkedAt
    });
    const rootCause = validation.state === 'blocked'
      ? validation.blockers[0] || 'capability_deep_evidence_invalid' : null;
    results.push(capabilityProbeResultV3({
      ...providerContext,
      capability,
      scope: `provider:${providerId}`,
      stage: validation.state === 'verified' ? 'complete' : 'artifact_validation',
      state: validation.state,
      terminal: validation.state === 'blocked',
      rootCause,
      blockers: validation.blockers,
      warnings: validation.warnings,
      retryable: validation.state === 'blocked' || validation.state === 'stale',
      recoveryAction: validation.state === 'verified' ? null : 'run_deep_verification',
      source: validation.state === 'verified' ? 'deep_probe' : 'artifact',
      evidence: {
        ...(validation.evidence || {}),
        producer_id: validation.producer_id,
        trust_anchor_id: validation.trust_anchor_id,
        content_sha256: validation.content_sha256
      }
    }));
  }
  return results;
}

export async function probeBridgeHttp(
  loopbackOrigin: string | null,
  options: DesktopBridgeControllerV3Options
): Promise<HttpProbeResult> {
  const started = Date.now();
  if (!loopbackOrigin) return httpFailure('desktop_bridge_tcp_connect_failed', 'tcp_connect', null, started);
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(
      `${loopbackOrigin}${DESKTOP_BRIDGE_DIAGNOSTIC_HEALTH_PATH}`,
      {
        method: 'GET',
        redirect: 'error',
        headers: { accept: 'application/json', origin: 'app://codex' },
        signal: AbortSignal.timeout(timeoutMs(options))
      }
    );
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) return httpFailure('desktop_bridge_http_health_failed', 'http_health', response.status, started);
    if (payload?.schema !== 'sks.desktop-bridge-health.v1' || payload.runtime !== 'desktop-bridge') {
      return httpFailure('desktop_bridge_http_health_invalid', 'http_health', response.status, started);
    }
    return {
      schema: 'sks.desktop-bridge-http-probe.v1',
      state: 'verified',
      terminal_stage: 'complete',
      root_cause: null,
      status_code: response.status,
      latency_ms: Date.now() - started,
      blockers: [],
      warnings: []
    };
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return httpFailure(
      timedOut ? 'desktop_bridge_http_health_timeout' : 'desktop_bridge_tcp_connect_failed',
      timedOut ? 'http_health' : 'tcp_connect',
      null,
      started
    );
  }
}

function httpFailure(
  rootCause: string,
  stage: HttpProbeResult['terminal_stage'],
  statusCode: number | null,
  started: number
): HttpProbeResult {
  return {
    schema: 'sks.desktop-bridge-http-probe.v1',
    state: 'failed',
    terminal_stage: stage,
    root_cause: rootCause,
    status_code: statusCode,
    latency_ms: Date.now() - started,
    blockers: [rootCause],
    warnings: []
  };
}

export async function probeBridgeWebSocket(
  loopbackOrigin: string | null,
  level: CapabilityRequestedLevel,
  options: DesktopBridgeControllerV3Options
): Promise<WebSocketProbeResult> {
  if (!loopbackOrigin) {
    return {
      schema: 'sks.desktop-bridge-websocket-probe.v2',
      state: 'failed',
      terminal_stage: 'tcp_connect',
      root_cause: 'desktop_bridge_tcp_connect_failed',
      status_code: null,
      negotiated_protocol: null,
      upgrade_verified: false,
      protocol_verified: false,
      frame_round_trip_verified: false,
      clean_close_verified: false,
      latency_ms: null,
      blockers: ['desktop_bridge_tcp_connect_failed'],
      warnings: []
    };
  }
  const websocketOrigin = loopbackOrigin.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
  return probeDesktopBridgeWebSocket({
    url: `${websocketOrigin}${DESKTOP_BRIDGE_DIAGNOSTIC_PATH}`,
    origin: 'app://codex',
    requestedLevel: level,
    maxRetries: 2,
    totalTimeoutMs: timeoutMs(options)
  });
}
