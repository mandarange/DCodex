import type {
  BridgeProviderId,
  BridgeRoutingPolicy,
  CapabilityRequestedLevel,
  CombinedCatalogSyncStatus
} from '../bridge-contracts.js';
import type {
  DesktopBridgeServiceOptions,
  DesktopBridgeServiceStatus
} from '../desktop-service.js';
import type { ImageGenerationProbeInputV3 } from '../probes/image-generation-probe.js';
import type { ComputerUseProbeInputV3 } from '../probes/computer-use-probe.js';
import type { VoiceRealtimeProbeInputV3 } from '../probes/voice-realtime-probe.js';
import type { AuxiliarySurfacesProbeInputV3 } from '../probes/auxiliary-surfaces-probe.js';
import type { CapabilityDeepEvidenceTrustAnchorV2 } from '../trusted-deep-evidence.js';
import type { ResolvedProviderCredential } from '../provider-credentials.js';
import type { BridgeProviderRegistry } from '../provider-registry.js';
import type { readActiveCombinedBridgeCatalog } from '../combined-catalog.js';
import type { captureCodexAuthSnapshot } from '../desktop-auth-invariant.js';
import type { DesktopBridgeLookup } from '../desktop-bridge/security.js';
import type { LastDiagnostic } from './diagnostics.js';

export type DesktopBridgeControllerRequestV3 =
  | { operation: 'status' }
  | { operation: 'ensure' }
  | { operation: 'repair' }
  | { operation: 'verify'; level: CapabilityRequestedLevel }
  | { operation: 'provider.list' }
  | { operation: 'provider.configure'; provider_id: BridgeProviderId; api_key: string; host?: string }
  | { operation: 'provider.validate'; provider_id: BridgeProviderId }
  | { operation: 'provider.enable'; provider_id: BridgeProviderId }
  | { operation: 'provider.disable'; provider_id: BridgeProviderId }
  | { operation: 'provider.remove-credential'; provider_id: BridgeProviderId; confirmed: true }
  | { operation: 'catalog.sync' }
  | { operation: 'catalog.status' }
  | { operation: 'route.list' }
  | { operation: 'route.set-default'; provider_id: BridgeProviderId }
  | { operation: 'route.explain'; model: string }
  | { operation: 'unmanage'; confirmed: true }
  | { operation: 'rollback'; receipt_id: string; confirmed: true };

export interface DesktopBridgeControllerV3Options extends DesktopBridgeServiceOptions {
  configPath?: string;
  authPath?: string;
  receiptDir?: string;
  catalogPath?: string;
  routeIndexPath?: string;
  routePolicyPath?: string;
  validationPath?: string;
  diagnosticPath?: string;
  fetchImpl?: typeof fetch;
  codexLbLookup?: DesktopBridgeLookup;
  timeoutMs?: number;
  now?: () => Date;
  id?: () => string;
  serviceStatusImpl?: typeof import('../desktop-service.js').desktopBridgeServiceStatus;
  installServiceImpl?: typeof import('../desktop-service.js').installAndStartDesktopBridgeService;
  bootstrapServiceImpl?: typeof import('../desktop-service.js').bootstrapExistingDesktopBridgeService;
  stopServiceImpl?: typeof import('../desktop-service.js').stopDesktopBridgeService;
  safeWriteConfigImpl?: typeof import('../../codex-runtime/codex-desktop-config-policy.js').safeWriteCodexConfigToml;
  rollbackReceiptImpl?: typeof import('../migration-receipt.js').rollbackDesktopBridgeUnificationReceipt;
  deepProbeImpl?: (input: DesktopBridgeDeepProbeRequestV3) => Promise<DesktopBridgeDeepProbeEvidenceV3 | null>;
}

export interface DesktopBridgeDeepProbeRequestV3 {
  provider_id: BridgeProviderId;
  report_id: string;
  correlation_id: string;
  session_id: string;
  checked_at: string;
  catalog_generation: string;
  endpoint: string;
}

type DeepInput<T> = Omit<T, 'providerId' | 'requestedLevel' | 'checkedAt' | 'reportId' | 'correlationId' | 'sessionId'>;

export interface DesktopBridgeDeepProbeEvidenceV3 {
  image_generation?: DeepInput<ImageGenerationProbeInputV3>;
  computer_use?: DeepInput<ComputerUseProbeInputV3>;
  voice_mode?: DeepInput<VoiceRealtimeProbeInputV3>;
  auxiliary_surfaces?: DeepInput<AuxiliarySurfacesProbeInputV3>;
  trusted?: Partial<Record<string, {
    envelope: unknown;
    trust_anchors: readonly CapabilityDeepEvidenceTrustAnchorV2[];
  }>>;
}

export type ControllerPaths = {
  home: string;
  codexHome: string;
  configPath: string;
  authPath: string;
  receiptDir: string;
  catalogPath: string;
  routeIndexPath: string;
  routePolicyPath: string;
  validationPath: string;
  diagnosticPath: string;
};

export type ControllerCore = {
  paths: ControllerPaths;
  checkedAt: string;
  config: string;
  credentials: Record<BridgeProviderId, ResolvedProviderCredential>;
  registry: BridgeProviderRegistry;
  activeCatalog: Awaited<ReturnType<typeof readActiveCombinedBridgeCatalog>>;
  policy: BridgeRoutingPolicy | null;
  policyBlockers: readonly string[];
  service: DesktopBridgeServiceStatus;
  auth: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>;
  catalogSync: CombinedCatalogSyncStatus;
  diagnostic: LastDiagnostic | null;
};

export type ProbeContext = {
  requestedLevel: CapabilityRequestedLevel;
  checkedAt: string;
  reportId: string;
  correlationId: string;
  sessionId: string;
  attemptId: number;
};
