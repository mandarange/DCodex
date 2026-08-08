import type {
  BridgeProviderId,
  CapabilityProbeResultV3,
  CapabilityRequestedLevel,
  DesktopCapabilityReportV3,
  HttpProbeResult,
  WebSocketProbeResult
} from '../bridge-contracts.js';
import { refreshDesktopBridgeState } from '../desktop-bridge/index.js';
import { runDesktopCapabilityReportV3 } from '../capability-runner.js';
import { assertDesktopCapabilityReportV3 } from '../bridge-runtime-validation.js';
import { runBridgeProbeV3 } from '../probes/bridge-probe.js';
import { verifiedLiveProbeIds, writeLastDiagnostic } from './diagnostics.js';
import { probeBridgeHttp, probeBridgeWebSocket, probeProviderDeep, probeProviderText } from './live-probes.js';
import {
  combinedModelRouteProbe,
  combinedRoutePolicyProbe,
  nativeIdentityProbe,
  providerAuthProbe,
  providerCredentialProbe,
  providerModelRouteProbe
} from './preflight-probes.js';
import { activeProviderIds, makeId, nowIso } from './shared.js';
import { loadCore, statusFromCore } from './status.js';
import type { DesktopBridgeControllerV3Options } from './types.js';

export async function verifyDesktopBridgeV3(
  requestedLevel: CapabilityRequestedLevel,
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopCapabilityReportV3> {
  const core = await loadCore(options);
  const status = statusFromCore(core, options);
  const reportId = makeId('report', options);
  const correlationId = makeId('correlation', options);
  const sessionId = makeId('session', options);
  const checkedAt = nowIso(options);
  let httpProbe: HttpProbeResult | undefined;
  let websocketProbe: WebSocketProbeResult | undefined;
  if (requestedLevel !== 'shallow') {
    [httpProbe, websocketProbe] = await Promise.all([
      probeBridgeHttp(status.service.loopback_origin, options),
      probeBridgeWebSocket(status.service.loopback_origin, requestedLevel, options)
    ]);
  }
  const probeContext = {
    requestedLevel,
    checkedAt,
    reportId,
    correlationId,
    sessionId,
    attemptId: 1
  } as const;
  const activeProviders = activeProviderIds(core);
  const enabledProviders = (['codex-lb', 'openrouter'] as const)
    .filter((providerId) => core.registry.profiles[providerId].enabled);
  // Live text probes run first: they exercise the exact model route through
  // the bridge, so their verified results are the transport-level route proof.
  const textResults = requestedLevel !== 'shallow'
    ? await Promise.all(activeProviders.map((providerId) =>
      probeProviderText(core, providerId, status.service.loopback_origin, probeContext, options)))
    : [];
  const results: CapabilityProbeResultV3[] = [
    ...runBridgeProbeV3({
      ...probeContext,
      configured: status.management.managed,
      processRunning: status.service.running,
      ...(httpProbe ? { httpProbe } : {}),
      ...(websocketProbe ? { websocketProbe } : {})
    }),
    nativeIdentityProbe(core, probeContext),
    combinedRoutePolicyProbe(core, probeContext),
    combinedModelRouteProbe(core, status, probeContext, textResults)
  ];
  for (const providerId of ['codex-lb', 'openrouter'] as const) {
    const liveText = textResults.find((result) => result.scope === `provider:${providerId}`) || null;
    results.push(
      providerCredentialProbe(core, providerId, probeContext),
      providerAuthProbe(core, providerId, probeContext),
      providerModelRouteProbe(core, providerId, probeContext, liveText)
    );
  }
  results.push(...textResults);
  if (requestedLevel === 'deep') {
    const deepResults = await Promise.all(activeProviders.map((providerId) =>
      probeProviderDeep(core, providerId, probeContext, options)));
    results.push(...deepResults.flat());
  }
  const report = runDesktopCapabilityReportV3({
    requestedLevel,
    reportId,
    correlationId,
    sessionId,
    checkedAt,
    activeProviderIds: activeProviders,
    enabledProviderIds: enabledProviders as BridgeProviderId[],
    catalogSync: core.catalogSync,
    results,
    executionBlockers: [],
    executionWarnings: status.service.running ? [] : ['bridge_service_not_running']
  });
  assertDesktopCapabilityReportV3(report);
  const processGeneration = core.service.state?.process_generation || null;
  if (processGeneration) {
    const stateUpdated = await refreshDesktopBridgeState(
      core.service.paths.state_path,
      { ...core.service.state!, last_verified_probe_ids: verifiedLiveProbeIds(report) },
      options.now ? options.now() : new Date()
    );
    if (!stateUpdated) return report;
  }
  await writeLastDiagnostic(core.paths.diagnosticPath, {
    schema: 'sks.desktop-bridge-last-diagnostic.v1',
    checked_at: checkedAt,
    catalog_generation: report.catalog_generation,
    process_generation: processGeneration,
    report,
    http_probe: httpProbe || null,
    websocket_probe: websocketProbe || null
  });
  return report;
}
