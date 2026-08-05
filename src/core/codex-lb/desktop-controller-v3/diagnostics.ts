import fs from 'node:fs/promises';
import { writeJsonAtomic } from '../../fsx.js';
import type { DesktopCapabilityReportV3, HttpProbeResult, WebSocketProbeResult } from '../bridge-contracts.js';
import { validateDesktopCapabilityReportV3 } from '../bridge-runtime-validation.js';

const LAST_DIAGNOSTIC_SCHEMA = 'sks.desktop-bridge-last-diagnostic.v1' as const;
const MAX_DIAGNOSTIC_BYTES = 4 * 1024 * 1024;

export type LastDiagnostic = {
  schema: typeof LAST_DIAGNOSTIC_SCHEMA;
  checked_at: string;
  catalog_generation: string | null;
  process_generation: string | null;
  report: DesktopCapabilityReportV3;
  http_probe: HttpProbeResult | null;
  websocket_probe: WebSocketProbeResult | null;
};

export async function writeLastDiagnostic(file: string, value: LastDiagnostic): Promise<void> {
  await writeJsonAtomic(file, value, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

export async function readLastDiagnostic(
  file: string,
  currentCatalogGeneration: string | null,
  currentProcessGeneration: string | null,
  lastVerifiedProbeIds: readonly string[]
): Promise<LastDiagnostic | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isFile() || stat.isSymbolicLink()
    || stat.size > MAX_DIAGNOSTIC_BYTES
    || (expectedUid !== null && stat.uid !== expectedUid)
    || (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600)) return null;
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8')) as LastDiagnostic;
    const validation = validateDesktopCapabilityReportV3(value.report);
    if (value.schema !== LAST_DIAGNOSTIC_SCHEMA
      || !validation.ok
      || !desktopBridgeDiagnosticBindingCurrentV3(
        value,
        currentCatalogGeneration,
        currentProcessGeneration,
        lastVerifiedProbeIds
      )) return null;
    return value;
  } catch {
    return null;
  }
}

export function desktopBridgeReportReadinessV3(report: DesktopCapabilityReportV3 | null): {
  bridge_ready: boolean;
  active_routes_ready: boolean;
} {
  const transportVerified = report?.summary.transport_level_satisfied === true
    && (report.requested_level === 'transport' || report.requested_level === 'deep');
  return {
    bridge_ready: transportVerified && report?.summary.bridge_ready === true,
    active_routes_ready: transportVerified && report?.summary.active_routes_ready === true
  };
}

export function desktopBridgeDiagnosticBindingCurrentV3(
  value: Pick<LastDiagnostic, 'catalog_generation' | 'process_generation' | 'report'>,
  currentCatalogGeneration: string | null,
  currentProcessGeneration: string | null,
  lastVerifiedProbeIds: readonly string[]
): boolean {
  const hasVerifiedProbeBinding = value.report.summary.transport_level_satisfied !== true
    || lastVerifiedProbeIds.some((probeId) => probeId.startsWith(`${value.report.report_id}:`));
  return Boolean(currentProcessGeneration
    && value.catalog_generation === currentCatalogGeneration
    && value.process_generation === currentProcessGeneration
    && hasVerifiedProbeBinding);
}

export function verifiedLiveProbeIds(report: DesktopCapabilityReportV3): string[] {
  const scopes = [
    report.bridge,
    report.native_identity,
    report.providers['codex-lb'],
    report.providers.openrouter,
    report.combined_catalog
  ];
  return scopes.flatMap((scope) => Object.values(scope.capabilities))
    .filter((probe) => probe.state === 'verified'
      && ['transport', 'deep_probe', 'artifact'].includes(probe.source))
    .map((probe) => `${report.report_id}:${probe.scope}:${probe.capability}`)
    .sort();
}
