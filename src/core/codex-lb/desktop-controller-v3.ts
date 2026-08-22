import type {
  DesktopBridgeCommandOperation,
  DesktopBridgeCommandResult,
  DesktopBridgeStatusV3,
  DesktopCapabilityReportV3
} from './bridge-contracts.js';
import { listSelectableModels, selectExposedModels, syncCatalog } from './desktop-controller-v3/catalog.js';
import {
  explainRoute,
  ensureDesktopBridge,
  repairDesktopBridge,
  rollbackDesktopBridge,
  setDefaultProvider,
  setOfficialModelsMode,
  unmanageDesktopBridge
} from './desktop-controller-v3/lifecycle-commands.js';
import {
  configureProvider,
  removeCredential,
  setProviderState,
  validateProvider
} from './desktop-controller-v3/provider-commands.js';
import { commandResult, safeCode } from './desktop-controller-v3/shared.js';
import { desktopBridgeStatusV3 } from './desktop-controller-v3/status.js';
import type {
  DesktopBridgeControllerRequestV3,
  DesktopBridgeControllerV3Options
} from './desktop-controller-v3/types.js';
import { verifyDesktopBridgeV3 } from './desktop-controller-v3/verification.js';
import { withFileLock } from '../locks/file-lock.js';
import path from 'node:path';

export type {
  DesktopBridgeControllerRequestV3,
  DesktopBridgeControllerV3Options,
  DesktopBridgeDeepProbeEvidenceV3,
  DesktopBridgeDeepProbeRequestV3,
  ProbeContext
} from './desktop-controller-v3/types.js';
export type { LastDiagnostic } from './desktop-controller-v3/diagnostics.js';
export {
  desktopBridgeDiagnosticBindingCurrentV3,
  desktopBridgeReportReadinessV3
} from './desktop-controller-v3/diagnostics.js';
export { runDesktopBridgeDeepProviderProbesV3 } from './desktop-controller-v3/live-probes.js';
export { desktopBridgeCatalogStatusV3, desktopBridgeStatusV3 } from './desktop-controller-v3/status.js';
export { verifyDesktopBridgeV3 } from './desktop-controller-v3/verification.js';

export async function executeDesktopBridgeCommandV3(
  request: DesktopBridgeControllerRequestV3,
  options: DesktopBridgeControllerV3Options = {}
): Promise<DesktopBridgeStatusV3 | DesktopCapabilityReportV3 | DesktopBridgeCommandResult> {
  if (request.operation === 'status') return desktopBridgeStatusV3(options);
  if (request.operation === 'verify') return verifyDesktopBridgeV3(request.level, options);

  try {
    const home = path.resolve(options.home || process.env.HOME || '.');
    return await withFileLock({
      lockPath: path.join(home, '.codex', 'sks', 'locks', 'desktop-bridge-controller.lock'),
      timeoutMs: 30_000,
      staleMs: 120_000
    }, async () => {
      if (request.operation === 'ensure') return ensureDesktopBridge(options, 'ensure');
      if (request.operation === 'repair') return repairDesktopBridge(options);
      if (request.operation === 'provider.list') {
        const status = await desktopBridgeStatusV3(options);
        return commandResult('provider.list', true, status, { providers: status.providers }, [], options);
      }
      if (request.operation === 'provider.configure') return configureProvider(request, options);
      if (request.operation === 'provider.validate') return validateProvider(request.provider_id, options);
      if (request.operation === 'provider.enable' || request.operation === 'provider.disable') {
        return setProviderState(
          request.provider_id,
          request.operation === 'provider.enable',
          request.operation,
          options
        );
      }
      if (request.operation === 'provider.remove-credential') {
        return removeCredential(request.provider_id, options);
      }
      if (request.operation === 'models.list') return listSelectableModels(options);
      if (request.operation === 'models.select') return selectExposedModels(request.public_ids, options);
      if (request.operation === 'catalog.sync') return syncCatalog(options);
      if (request.operation === 'catalog.status') {
        const status = await desktopBridgeStatusV3(options);
        return commandResult('catalog.status', true, status, { catalog_sync: status.catalog_sync }, [], options);
      }
      if (request.operation === 'route.list') {
        const status = await desktopBridgeStatusV3(options);
        return commandResult('route.list', true, status, { routing: status.routing }, [], options);
      }
      if (request.operation === 'route.set-default') return setDefaultProvider(request.provider_id, options);
      if (request.operation === 'route.official-models') return setOfficialModelsMode(request.mode, options);
      if (request.operation === 'route.explain') return explainRoute(request.model, options);
      if (request.operation === 'unmanage') return unmanageDesktopBridge(options);
      return rollbackDesktopBridge(request.receipt_id, options);
    });
  } catch (error) {
    const blocker = safeCode(error, 'desktop_bridge_command_failed');
    const status = await desktopBridgeStatusV3(options).catch(() => null);
    return commandResult(
      request.operation as DesktopBridgeCommandOperation,
      false,
      status,
      {},
      [blocker],
      options
    ) as DesktopBridgeCommandResult;
  }
}
