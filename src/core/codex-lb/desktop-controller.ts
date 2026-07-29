import { createHash, randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  configureCodexLbCliProvider,
  configureCodexLbDesktopRouting
} from '../../cli/install-helpers.js';
import {
  CODEX_LB_DESKTOP_BRIDGE_MARKER,
  CODEX_LB_DESKTOP_COMPAT_MARKER,
  CODEX_LB_MODEL_CATALOG_MARKER
} from '../../cli/install-helpers-codex-lb-config.js';
import {
  codexAuthPath,
  codexLbConfigPath
} from '../../cli/install-helpers-codex-lb-shared.js';
import {
  codexLbResponseChainCapabilityEvidence,
  checkCodexLbResponseChain
} from '../../cli/install-helpers-codex-lb-chain.js';
import { probeCodexLbCliImageGeneration } from './probes/cli-image-tool-probe.js';
import { quitCodexApp, restartCodexApp } from '../codex-app/codex-app-restart.js';
import { readJson, readText } from '../fsx.js';
import {
  assertDesktopOAuthSemanticIdentity,
  captureCodexAuthSnapshot
} from './desktop-auth-invariant.js';
import {
  runCodexLbDesktopCapabilityReport,
  shapeCodexLbDesktopCapabilityStatus
} from './capability-runner.js';
import type {
  CapabilityEvidence,
  CapabilityProbeLevel,
  CapabilitySignal,
  CodexLbDesktopCapabilityReport
} from './capability-types.js';
import {
  codexLbEnvPath,
  codexLbMetadataPath,
  loadCodexLbEnv,
  normalizeCodexLbBaseUrl
} from './codex-lb-env.js';
import { normalizeCodexLbToolCatalog } from './codex-lb-tool-catalog.js';
import {
  bootstrapExistingDesktopBridgeService,
  desktopBridgeServicePaths,
  desktopBridgeServiceStatus,
  installAndStartDesktopBridgeService,
  resolveDesktopBridgeActivationSettings,
  stopDesktopBridgeService,
  type DesktopBridgeServiceOptions,
  type DesktopBridgeServiceStatus
} from './desktop-service.js';
import {
  DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT,
  modeRequiresChatGptOAuth,
  parseCodexLbGatewayAuthTransport,
  type CodexLbDesktopMode,
  type CodexLbGatewayAuthTransport
} from './desktop-mode.js';
import {
  detectLegacyCodexLbDesktopState,
  migrateLegacyCodexLbDesktop
} from './legacy-migration.js';
import {
  syncDesktopCenterLaunchCredentials,
  type DesktopCenterCredentialSyncResult
} from './desktop-center-credentials.js';
import {
  backupCodexLbMigrationFile,
  codexLbMigrationReceiptDir,
  createCodexLbMigrationReceiptId,
  fileSha256OrMissing,
  finalizeCodexLbMigrationReceiptFiles,
  readCodexLbMigrationReceipt,
  rollbackCodexLbMigrationReceipt,
  writeCodexLbMigrationReceipt,
  type CodexLbMigrationFileBackup,
  type CodexLbMigrationReceipt
} from './migration-receipt.js';
import {
  CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
  parseCodexLbDeepEvidenceTrustAnchorSet,
  validateCodexLbDesktopDeepEvidence,
  type CodexLbDeepEvidenceTrustAnchor,
  type CodexLbDeepEvidenceValidation
} from './trusted-deep-evidence.js';

export const CODEX_LB_STATUS_SCHEMA_V2 = 'sks.codex-lb-status.v2' as const;
export const CODEX_LB_ACTIVATION_SCHEMA_V2 = 'sks.codex-lb-desktop-activation.v2' as const;

export interface CodexLbDesktopDeepEvidence {
  schema?: string;
  fixture?: boolean;
  provider_identity_verified?: boolean;
  picker_control_visible?: boolean;
  picker_selected_model?: string | null;
  configured_service_tier?: string | null;
  request_service_tier?: string | null;
  response_actual_service_tier?: string | null;
  bridge_websocket_round_trip?: boolean;
  image_route?: 'responses_tool' | 'images_api' | null;
  image_request_tools_present?: boolean;
  image_events?: unknown[];
  image_artifact_materialized?: boolean;
  computer_events?: unknown[];
  computer_executor_completed?: boolean;
  computer_output_submitted?: boolean;
  computer_follow_up_completed?: boolean;
  computer_session_affinity_preserved?: boolean;
  browser_use_verified?: boolean;
  voice_create_verified?: boolean;
  voice_location_received?: boolean;
  voice_location_rewritten?: boolean;
  voice_websocket_upgraded?: boolean;
  voice_server_event_seen?: boolean;
  voice_clean_close?: boolean;
  voice_owner_binding_verified?: boolean;
  plugins_verified?: boolean;
  auxiliary_routes_observed?: string[];
  auxiliary_events?: unknown[];
  auxiliary_output_events?: unknown[];
  auxiliary_request_body_hash_preserved?: boolean;
  auxiliary_owner_affinity_verified?: boolean;
  desktop_adoption_verified?: boolean;
  desktop_adoption_source?: string | null;
}

type DesktopWebSocketProbeResult = {
  ok: boolean;
  blocker: string | null;
  status_code: number | null;
};

export interface CodexLbDesktopControllerOptions extends DesktopBridgeServiceOptions {
  configPath?: string;
  authPath?: string;
  receiptDir?: string;
  gatewayAuthTransport?: CodexLbGatewayAuthTransport;
  /** Optional Desktop routing target for migrate-legacy-desktop / activation helpers. */
  mode?: Extract<CodexLbDesktopMode, 'desktop-native-bridge' | 'desktop-dual-auth-compat'>;
  restartApp?: boolean;
  quitAppImpl?: typeof quitCodexApp;
  restartAppImpl?: typeof restartCodexApp;
  fetchImpl?: typeof fetch;
  capabilityTimeoutMs?: number;
  deepEvidence?: unknown;
  deepEvidenceTrustAnchors?: readonly CodexLbDeepEvidenceTrustAnchor[];
  networkProbes?: boolean;
  installBridgeImpl?: typeof installAndStartDesktopBridgeService;
  stopBridgeImpl?: typeof stopDesktopBridgeService;
  bridgeStatusImpl?: typeof desktopBridgeServiceStatus;
  bootstrapBridgeImpl?: typeof bootstrapExistingDesktopBridgeService;
  webSocketProbeImpl?: (
    baseUrl: string,
    timeoutMs: number
  ) => Promise<DesktopWebSocketProbeResult>;
  cliImageProbeImpl?: typeof probeCodexLbCliImageGeneration;
}

export function inferCodexLbDesktopModeFromConfig(text: string): CodexLbDesktopMode {
  const config = String(text || '');
  const selected = topLevelTomlString(config, 'model_provider');
  const openAiBaseUrl = topLevelTomlString(config, 'openai_base_url');
  if (
    hasTopLevelLine(config, CODEX_LB_DESKTOP_BRIDGE_MARKER)
    && isLoopbackCodexBaseUrl(openAiBaseUrl)
  ) {
    return 'desktop-native-bridge';
  }
  if (
    hasTopLevelLine(config, CODEX_LB_DESKTOP_COMPAT_MARKER)
    && selected === 'codex-lb'
  ) {
    return 'desktop-dual-auth-compat';
  }
  if (tomlTable(config, 'model_providers.codex-lb').trim()) return 'cli-provider';
  return 'disabled';
}

export async function codexLbDesktopStatusV2(
  options: CodexLbDesktopControllerOptions = {}
): Promise<Record<string, unknown>> {
  const context = await loadDesktopContext(options);
  const capabilityReport = await buildCodexLbDesktopCapabilities({
    ...options,
    home: context.home,
    configPath: context.configPath,
    authPath: context.authPath,
    networkProbes: false,
    deepEvidence: null,
    level: 'shallow'
  });
  const capabilityStatus = shapeCodexLbDesktopCapabilityStatus(capabilityReport);
  const provider = providerStatus(context.config, context.mode);
  const blockers = [
    ...context.modeBlockers,
    ...(modeRequiresChatGptOAuth(context.mode) && !context.oauthPresent
      ? ['chatgpt_oauth_required_for_desktop']
      : []),
    ...(context.loadedEnv.configured ? [] : context.loadedEnv.missing.map((entry) => `codex_lb_missing:${entry}`)),
    ...(context.mode === 'desktop-native-bridge' && !context.bridge.ok
      ? context.bridge.blockers
      : []),
    ...Object.values(capabilityStatus.blocked).flat()
  ];
  const uniqueBlockers = uniqueStrings(blockers);
  const overallBlocked = capabilityReport.overall === 'blocked'
    || capabilityReport.overall === 'unsupported';
  const selectedProvider = topLevelTomlString(context.config, 'model_provider');
  const legacyCodexLbSelected = selectedProvider === 'codex-lb';
  return {
    schema: CODEX_LB_STATUS_SCHEMA_V2,
    ok: uniqueBlockers.length === 0 && !overallBlocked,
    configured: context.loadedEnv.configured,
    setup_needed: !context.loadedEnv.configured,
    mode: context.mode,
    // Explicit Center aliases: never confuse provider.selected (builtin OpenAI
    // selected for the active mode) with legacy global model_provider=codex-lb.
    desktop_mode: context.mode,
    chatgpt_oauth_present: context.oauthPresent,
    legacy_codex_lb_selected: legacyCodexLbSelected,
    oauth: {
      present: context.oauthPresent,
      preserved: context.oauthPresent,
      mode: context.auth.mode,
      sha256: context.auth.sha256,
      sha256_changed: null,
      baseline_available: false
    },
    provider,
    bridge: {
      supported: context.bridge.supported,
      installed: context.bridge.installed,
      loaded: context.bridge.loaded,
      running: context.bridge.running,
      status: context.bridge.status,
      listen_origin: context.bridge.state?.listen_origin || null,
      remote_origin_redacted: redactRemoteOrigin(context.loadedEnv.base_url),
      key_fingerprint: context.loadedEnv.api_key.fingerprint
        ? `sha256:${context.loadedEnv.api_key.fingerprint}`
        : null,
      gateway_auth_transport: context.gatewayAuthTransport,
      blockers: context.bridge.blockers
    },
    capabilities: capabilityStatus,
    deep_evidence_validation: capabilityReport.deep_evidence_validation,
    overall: capabilityReport.overall,
    full_capability_verified: capabilityReport.overall === 'verified',
    blockers: uniqueBlockers,
    guidance: statusGuidance(context.mode, context.loadedEnv.configured, uniqueBlockers)
  };
}

export async function activateCodexLbDesktopMode(
  input: CodexLbDesktopControllerOptions & {
    mode: 'desktop-native-bridge' | 'desktop-dual-auth-compat';
  }
): Promise<Record<string, unknown>> {
  const context = await loadDesktopContext(input);
  const gatewayAuthTransport = input.mode === 'desktop-dual-auth-compat'
    ? 'x-codex-lb-api-key'
    : parseCodexLbGatewayAuthTransport(
        input.gatewayAuthTransport || context.gatewayAuthTransport
      );
  if (context.modeBlockers.includes('legacy_codex_lb_desktop_config_requires_migration')) {
    return {
      schema: CODEX_LB_ACTIVATION_SCHEMA_V2,
      ok: false,
      status: 'legacy_migration_required',
      mode: input.mode,
      identity_plane: 'unavailable',
      routing_plane: 'unchanged',
      gateway_auth_transport: gatewayAuthTransport,
      oauth_preserved: false,
      bridge_started: false,
      config_committed: false,
      restart_requested: input.restartApp === true,
      restart_performed: false,
      routing: null,
      bridge: null,
      restart_app: null,
      blockers: ['legacy_codex_lb_desktop_config_requires_migration'],
      guidance: ['Run: sks codex-lb migrate-legacy-desktop --restart-app']
    };
  }
  const receipt = await beginDesktopTransaction(context, input.receiptDir);
  const previousBridgeRunning = context.bridge.running;
  let bridge: DesktopBridgeServiceStatus | null = null;
  let routing: Awaited<ReturnType<typeof configureCodexLbDesktopRouting>> | null = null;
  let restart: Awaited<ReturnType<typeof restartCodexApp>> | null = null;
  let centerCredentials: DesktopCenterCredentialSyncResult | null = null;
  let transportWarnings: string[] = [];
  try {
    if (!context.loadedEnv.base_url || !context.loadedEnv.secret_api_key || !context.loadedEnv.configured) {
      throw new Error(
        context.loadedEnv.credential_binding.blockers[0]
        || context.loadedEnv.missing[0]
        || 'codex_lb_credentials_unavailable'
      );
    }
    if (!context.oauthPresent) throw new Error('chatgpt_oauth_required_for_desktop');

    if (input.mode === 'desktop-native-bridge') {
      bridge = await (input.installBridgeImpl || installAndStartDesktopBridgeService)({
        ...input,
        home: context.home,
        settings: {
          gateway_auth_transport: gatewayAuthTransport
        }
      });
      if (!bridge.ok || !bridge.state) {
        throw new Error(bridge.blockers[0] || 'desktop_bridge_start_failed');
      }
      routing = await configureCodexLbDesktopRouting({
        mode: 'desktop-native-bridge',
        home: context.home,
        configPath: context.configPath,
        authPath: context.authPath,
        bridgeBaseUrl: bridge.state.codex_base_url,
        remoteBaseUrl: context.loadedEnv.base_url,
        gatewayAuthTransport
      });
    } else {
      routing = await configureCodexLbDesktopRouting({
        mode: 'desktop-dual-auth-compat',
        home: context.home,
        configPath: context.configPath,
        authPath: context.authPath,
        remoteBaseUrl: context.loadedEnv.base_url,
        gatewayAuthTransport
      });
    }
    if (!routing.ok) throw new Error(routing.error || routing.blockers[0] || routing.status);

    if (input.mode === 'desktop-dual-auth-compat' && previousBridgeRunning) {
      bridge = await (input.stopBridgeImpl || stopDesktopBridgeService)({
        ...input,
        home: context.home,
        removePlist: true,
        removeSettings: true
      });
      if (bridge.running) throw new Error('desktop_bridge_stop_failed_during_compat_switch');
    }

    const centerCredentialsSynced = await syncDesktopCenterLaunchCredentials({
      mode: input.mode,
      home: context.home,
      loadedEnv: context.loadedEnv,
      ...(input.platform ? { platform: input.platform } : {})
    });
    centerCredentials = centerCredentialsSynced;
    if (!centerCredentialsSynced.ok) {
      throw new Error(centerCredentialsSynced.blockers[0] || centerCredentialsSynced.status);
    }

    const report = await buildCodexLbDesktopCapabilities({
      ...input,
      home: context.home,
      configPath: context.configPath,
      authPath: context.authPath,
      level: 'transport',
      networkProbes: true,
      deepEvidence: null
    });
    // Routing only requires a proven HTTP round trip through the bridge: that is
    // what every Codex Desktop request uses, and it also proves the gateway
    // accepted the configured auth transport. A gateway that does not proxy
    // `/realtime` WebSockets leaves voice/realtime unverified, which the report
    // still records — it must not roll back working HTTP routing.
    if (input.mode === 'desktop-native-bridge') {
      const authRejected = report.gateway_auth_transport.blockers.find((blocker) => (
        blocker.startsWith('codex_lb_gateway_auth_rejected_for_transport:')
      ));
      if (authRejected) throw new Error(authRejected);
      if (report.bridge.evidence.http_round_trip !== true) {
        throw new Error(
          report.bridge.blockers.find((blocker) => blocker !== 'desktop_bridge_websocket_transport_failed')
          || 'desktop_bridge_http_transport_failed'
        );
      }
      transportWarnings = uniqueStrings([
        ...report.bridge.blockers,
        ...report.bridge.warnings
      ]);
    }

    restart = await performOptionalRestart({
      ...input,
      home: context.home,
      authPath: context.authPath
    }, context.auth);
    if (restart.ok === false) throw new Error(restart.blockers[0] || restart.status);

    const finalizedReceipt = await finishDesktopTransaction(receipt, {
      fromMode: context.mode,
      toMode: input.mode,
      oauthPreserved: true,
      capabilitySummary: {
        overall: report.overall,
        gateway_auth_transport: gatewayAuthTransport,
        identity_plane: 'chatgpt_oauth',
        routing_plane: input.mode === 'desktop-native-bridge'
          ? 'desktop_native_bridge'
          : 'desktop_compat_provider'
      }
    });
    return {
      schema: CODEX_LB_ACTIVATION_SCHEMA_V2,
      ok: true,
      status: routing.status,
      mode: input.mode,
      identity_plane: 'chatgpt_oauth',
      routing_plane: routing.routing_plane,
      gateway_auth_transport: gatewayAuthTransport,
      oauth_preserved: true,
      bridge_started: input.mode === 'desktop-native-bridge' ? bridge?.ok === true : false,
      config_committed: true,
      restart_requested: input.restartApp === true,
      restart_performed: restart.status === 'restarted',
      transport_capabilities_verified: report.bridge.state === 'verified',
      transport_warnings: transportWarnings,
      capabilities: report,
      rollback_receipt: finalizedReceipt.path,
      rollback_receipt_id: finalizedReceipt.receipt.id,
      routing,
      bridge,
      restart_app: restart,
      center_credentials: centerCredentials,
      blockers: []
    };
  } catch (error: unknown) {
    if (input.mode === 'desktop-native-bridge') {
      await (input.stopBridgeImpl || stopDesktopBridgeService)({
        ...input,
        home: context.home,
        removePlist: true,
        removeSettings: true
      }).catch(() => undefined);
    }
    const rollback = await rollbackDesktopTransaction(receipt, {
      ...input,
      home: context.home,
      restartPreviousBridge: previousBridgeRunning,
      restartAppAfterRollback: restart !== null && input.restartApp === true,
      authBefore: context.auth
    });
    return {
      schema: CODEX_LB_ACTIVATION_SCHEMA_V2,
      ok: false,
      status: 'activation_failed',
      mode: input.mode,
      identity_plane: context.oauthPresent ? 'chatgpt_oauth' : 'unavailable',
      routing_plane: 'unchanged',
      gateway_auth_transport: gatewayAuthTransport,
      oauth_preserved: true,
      bridge_started: bridge?.ok === true,
      config_committed: false,
      restart_requested: input.restartApp === true,
      restart_performed: restart?.status === 'restarted',
      routing,
      bridge,
      restart_app: restart,
      rollback,
      blockers: uniqueStrings([
        safeControllerError(error),
        ...(rollback.ok ? [] : ['desktop_activation_rollback_failed']),
        ...(rollback.bridge_restart && !rollback.bridge_restart.ok
          ? rollback.bridge_restart.blockers
          : []),
        ...(rollback.app_restart && rollback.app_restart.ok === false
          ? rollback.app_restart.blockers
          : [])
      ])
    };
  }
}

export async function disableCodexLbDesktopRouting(
  input: CodexLbDesktopControllerOptions = {}
): Promise<Record<string, unknown>> {
  const context = await loadDesktopContext(input);
  const receipt = await beginDesktopTransaction(context, input.receiptDir);
  let routing: Awaited<ReturnType<typeof configureCodexLbDesktopRouting>> | null = null;
  let bridge: DesktopBridgeServiceStatus | null = null;
  let restart: Awaited<ReturnType<typeof restartCodexApp>> | null = null;
  try {
    routing = await configureCodexLbDesktopRouting({
      mode: 'disabled',
      home: context.home,
      configPath: context.configPath,
      authPath: context.authPath,
      gatewayAuthTransport: context.gatewayAuthTransport
    });
    if (!routing.ok) throw new Error(routing.error || routing.blockers[0] || routing.status);

    bridge = await (input.stopBridgeImpl || stopDesktopBridgeService)({
      ...input,
      home: context.home,
      removePlist: true,
      removeSettings: true
    });
    if (bridge.running || !bridge.ok) {
      throw new Error(bridge.blockers[0] || 'desktop_bridge_cleanup_failed');
    }
    const centerCredentials = await syncDesktopCenterLaunchCredentials({
      mode: 'disabled',
      home: context.home,
      loadedEnv: context.loadedEnv,
      ...(input.platform ? { platform: input.platform } : {})
    });
    if (!centerCredentials.ok) {
      throw new Error(centerCredentials.blockers[0] || centerCredentials.status);
    }
    restart = await performOptionalRestart({
      ...input,
      home: context.home,
      authPath: context.authPath
    }, context.auth);
    if (restart.ok === false) throw new Error(restart.blockers[0] || restart.status);
    const afterAuth = await captureCodexAuthSnapshot({
      home: context.home,
      authPath: context.authPath
    });
    assertDesktopOAuthSemanticIdentity(context.auth, afterAuth);
    const finalizedReceipt = await finishDesktopTransaction(receipt, {
      fromMode: context.mode,
      toMode: 'disabled',
      oauthPreserved: true,
      capabilitySummary: {
        identity_plane: context.oauthPresent ? 'chatgpt_oauth' : 'unchanged',
        routing_plane: 'disabled'
      }
    });
    return {
      schema: 'sks.codex-lb-desktop-disable.v2',
      ok: true,
      status: 'desktop_routing_disabled',
      mode: 'disabled',
      oauth_preserved: true,
      config_committed: true,
      bridge_stopped: true,
      restart_requested: input.restartApp === true,
      restart_performed: restart.status === 'restarted',
      rollback_receipt: finalizedReceipt.path,
      rollback_receipt_id: finalizedReceipt.receipt.id,
      routing,
      bridge,
      restart_app: restart,
      center_credentials: centerCredentials,
      blockers: []
    };
  } catch (error: unknown) {
    const rollback = await rollbackDesktopTransaction(receipt, {
      ...input,
      home: context.home,
      restartPreviousBridge: context.bridge.running,
      restartAppAfterRollback: restart !== null && input.restartApp === true,
      authBefore: context.auth
    });
    return {
      schema: 'sks.codex-lb-desktop-disable.v2',
      ok: false,
      status: 'desktop_routing_disable_failed',
      mode: context.mode,
      oauth_preserved: true,
      config_committed: false,
      bridge_stopped: false,
      restart_requested: input.restartApp === true,
      restart_performed: restart?.status === 'restarted',
      routing,
      bridge,
      restart_app: restart,
      rollback,
      blockers: uniqueStrings([
        safeControllerError(error),
        ...(rollback.ok ? [] : ['desktop_disable_rollback_failed']),
        ...(rollback.bridge_restart && !rollback.bridge_restart.ok
          ? rollback.bridge_restart.blockers
          : []),
        ...(rollback.app_restart && rollback.app_restart.ok === false
          ? rollback.app_restart.blockers
          : [])
      ])
    };
  }
}

export async function configureCodexLbCliMode(
  input: CodexLbDesktopControllerOptions = {}
): Promise<Record<string, unknown>> {
  const context = await loadDesktopContext(input);
  if (!context.loadedEnv.base_url) {
    return {
      schema: 'sks.codex-lb-cli-mode.v2',
      ok: false,
      status: 'missing_remote_base_url',
      mode: 'cli-provider',
      oauth_preserved: true,
      blockers: ['codex_lb_missing:CODEX_LB_BASE_URL']
    };
  }
  const result = await configureCodexLbCliProvider({
    home: context.home,
    configPath: context.configPath,
    authPath: context.authPath,
    remoteBaseUrl: context.loadedEnv.base_url,
    selectGlobally: false
  });
  return {
    ...result,
    schema: 'sks.codex-lb-cli-mode.v2',
    command: `codex --config model_provider='"codex-lb"'`,
    global_desktop_selection_changed: false
  };
}

export async function buildCodexLbDesktopCapabilities(
  input: CodexLbDesktopControllerOptions & {
    level?: CapabilityProbeLevel;
  } = {}
): Promise<CodexLbDesktopCapabilityReport> {
  const level = input.level || 'shallow';
  const context = await loadDesktopContext(input);
  const target = capabilityTarget(context);
  const deepEvidenceValidation = input.deepEvidence == null || target
    ? validateCodexLbDesktopDeepEvidence(input.deepEvidence ?? null, {
        expectedMode: context.mode,
        expectedEndpoint: target?.baseUrl || 'http://127.0.0.1/',
        trustAnchors: input.deepEvidenceTrustAnchors || []
      })
    : blockedDeepEvidenceValidation('codex_lb_deep_evidence_target_unavailable');
  const deep = level === 'deep' && deepEvidenceValidation.evidence
    ? deepEvidenceValidation.evidence as CodexLbDesktopDeepEvidence
    : {};
  const deepEvidenceBlockers = level === 'deep' && deepEvidenceValidation.state === 'blocked'
    ? deepEvidenceValidation.blockers
    : [];
  const fixture = deep.fixture === true;
  const networkProbes = input.networkProbes !== false;
  const transportRequested = level === 'transport' || level === 'deep';
  let manifest: Record<string, unknown> | null = null;
  let catalogPayload: unknown = null;
  let manifestResult: GatewayFetchResult | null = null;
  let catalogResult: GatewayFetchResult | null = null;
  let webSocketResult: DesktopWebSocketProbeResult | null = null;
  if (networkProbes && target) {
    manifestResult = await fetchGatewayJson(
      `${target.baseUrl}/capabilities`,
      target.headers,
      input.fetchImpl,
      input.capabilityTimeoutMs
    );
    if (manifestResult.ok && isRecord(manifestResult.payload)) manifest = manifestResult.payload;
    if (transportRequested) {
      catalogResult = await fetchGatewayJson(
        `${target.baseUrl}/models`,
        target.headers,
        input.fetchImpl,
        input.capabilityTimeoutMs
      );
      if (catalogResult.ok) catalogPayload = catalogResult.payload;
    }
    if (transportRequested && context.mode === 'desktop-native-bridge') {
      webSocketResult = await (
        input.webSocketProbeImpl
        || probeLoopbackWebSocketTransport
      )(target.baseUrl, input.capabilityTimeoutMs || 8_000);
    }
  }
  const transportObserved = Boolean(manifestResult?.ok || catalogResult?.ok);
  // A gateway that answers 401/403 to the configured transport is not "unreachable";
  // it rejected the credential shape SKS chose. Name that explicitly so Center can
  // tell the operator to switch transports instead of showing a generic failure.
  const gatewayAuthRejected = !transportObserved
    && [manifestResult, catalogResult].some((result) => (
      result?.httpStatus === 401 || result?.httpStatus === 403
    ));
  const normalizedCatalog = catalogPayload ? normalizeCodexLbToolCatalog(catalogPayload) : null;
  const model = normalizedCatalog?.catalog.models.find((row: any) => row.supported_in_api === true)?.slug || null;
  const cliPlane = context.mode === 'cli-provider';
  const configuredServiceTier = deep.configured_service_tier
    || topLevelTomlString(context.config, 'service_tier')
    || null;
  let textResponses: CapabilitySignal = {
    skipped: true,
    source: 'config',
    evidence: { reason: transportRequested ? 'text_responses_model_unavailable' : 'transport_probe_not_requested' }
  };
  let textChainServiceTier: {
    requested_service_tier?: string | null;
    actual_service_tier?: string | null;
    effective_service_tier?: string | null;
  } | null = null;
  if (transportRequested && target && model) {
    if (context.mode !== 'desktop-native-bridge' && target.effectiveTransport === 'x-codex-lb-api-key') {
      textResponses = {
        configured: true,
        blockers: ['text_responses_custom_header_adapter_required'],
        evidence: { gateway_auth_transport: target.effectiveTransport }
      };
    } else {
      const chain = await checkCodexLbResponseChain({
        base_url: target.baseUrl,
        provider_base_url_matches_credential: true
      }, {
        force: true,
        cache: false,
        recordCircuit: false,
        baseUrl: target.baseUrl,
        apiKey: context.loadedEnv.secret_api_key,
        model,
        fastMode: configuredServiceTier === 'fast',
        fetch: input.fetchImpl || globalThis.fetch,
        timeoutMs: input.capabilityTimeoutMs || 8_000
      });
      textChainServiceTier = chain?.service_tier_evidence || null;
      textResponses = capabilityEvidenceToSignal(codexLbResponseChainCapabilityEvidence(chain));
    }
  }
  // CLI-plane image verification: one real, minimal generation through the
  // gateway proves the image_generation tool round-trips on the CLI routing
  // plane; manifest/deep evidence (Desktop plane) still wins when present.
  let cliImageProbe: Awaited<ReturnType<typeof probeCodexLbCliImageGeneration>> | null = null;
  if (transportRequested && networkProbes && cliPlane && target && model) {
    const envTimeout = Number(
      input.env?.SKS_CODEX_LB_IMAGE_PROBE_TIMEOUT_MS
      || process.env.SKS_CODEX_LB_IMAGE_PROBE_TIMEOUT_MS
      || 0
    );
    cliImageProbe = await (input.cliImageProbeImpl || probeCodexLbCliImageGeneration)({
      baseUrl: target.baseUrl,
      apiKey: context.loadedEnv.secret_api_key || '',
      model,
      fetchImpl: input.fetchImpl || globalThis.fetch,
      ...(envTimeout > 0 ? { timeoutMs: envTimeout } : {})
    });
  }

  const providerContract = providerStatus(context.config, context.mode);
  const providerBlockers = [
    ...(providerContract.contract_ok ? [] : ['codex_lb_provider_contract_drift']),
    ...(modeRequiresChatGptOAuth(context.mode) && !context.oauthPresent
      ? ['chatgpt_oauth_identity_not_preserved']
      : []),
    ...deepEvidenceBlockers
  ];
  const localCatalogBound = hasTopLevelLine(context.config, CODEX_LB_MODEL_CATALOG_MARKER)
    && Boolean(topLevelTomlString(context.config, 'model_catalog_json'));
  const bridgeTransportAttempted = transportRequested
    && networkProbes
    && context.mode === 'desktop-native-bridge';
  const bridgeHttpRoundTrip = context.mode === 'desktop-native-bridge' && transportObserved;
  const bridgeWebSocketRoundTrip = webSocketResult?.ok === true;
  const gatewayObserved = transportObserved;

  return runCodexLbDesktopCapabilityReport({
    mode: context.mode,
    level,
    configured: context.loadedEnv.configured && context.mode !== 'disabled',
    oauthPreserved: context.oauthPresent,
    manifest,
    gatewayAuth: {
      transport: cliPlane ? 'authorization-bearer' : context.gatewayAuthTransport,
      configured: context.loadedEnv.configured,
      observed: gatewayObserved,
      fixture,
      legacyCompatibilityExplicit: context.gatewayAuthTransport === 'authorization-bearer-compat',
      blockers: [
        ...(gatewayAuthRejected
          ? [`codex_lb_gateway_auth_rejected_for_transport:${target?.effectiveTransport || context.gatewayAuthTransport}`]
          : []),
        ...(manifestResult && !manifestResult.ok && manifestResult.httpStatus !== 404
          ? [manifestResult.blocker || 'capability_manifest_unavailable']
          : [])
      ]
    },
    providerIdentity: {
      configured: providerContract.contract_ok,
      attempted: cliPlane ? transportObserved : level === 'deep',
      verified: cliPlane
        ? providerContract.contract_ok && transportObserved
        : level === 'deep' && deep.provider_identity_verified === true,
      fixture,
      source: cliPlane
        ? transportObserved ? 'transport' : 'config'
        : level === 'deep' && deep.provider_identity_verified === true ? 'deep_probe' : 'config',
      requiresOauth: modeRequiresChatGptOAuth(context.mode),
      blockers: providerBlockers,
      evidence: {
        provider_id: providerContract.id,
        built_in: providerContract.built_in,
        contract_ok: providerContract.contract_ok,
        auth_mode: context.auth.mode,
        cli_plane: cliPlane
      }
    },
    bridge: {
      configured: context.mode === 'desktop-native-bridge',
      processRunning: context.bridge.running,
      transportAttempted: bridgeTransportAttempted,
      httpRoundTrip: bridgeHttpRoundTrip,
      websocketRoundTrip: bridgeWebSocketRoundTrip,
      fixture,
      blockers: context.mode === 'desktop-native-bridge'
        ? [
            ...context.bridge.blockers,
            ...(webSocketResult && !webSocketResult.ok && webSocketResult.blocker
              ? [webSocketResult.blocker]
              : [])
          ]
        : []
    },
    catalog: {
      catalog: catalogPayload,
      localCatalogBound,
      configuredServiceTier,
      pickerControlVisible: deep.picker_control_visible ?? null,
      pickerSelectedModel: deep.picker_selected_model || null,
      requestServiceTier: deep.request_service_tier
        || (cliPlane ? textChainServiceTier?.requested_service_tier || null : null),
      responseActualServiceTier: deep.response_actual_service_tier
        || (cliPlane
          ? textChainServiceTier?.actual_service_tier
            || textChainServiceTier?.effective_service_tier
            || null
          : null),
      fixture,
      blockers: deepEvidenceBlockers
    },
    textResponses,
    imageGeneration: {
      route: deep.image_route || (cliImageProbe ? 'responses_tool' : null),
      toolAdvertised: cliImageProbe ? cliImageProbe.tool_accepted : undefined,
      requestToolsPresent: deep.image_request_tools_present
        ?? (cliImageProbe ? cliImageProbe.tool_accepted : undefined),
      events: deep.image_events?.length ? deep.image_events : cliImageProbe?.events || [],
      artifactMaterialized: deep.image_artifact_materialized
        ?? cliImageProbe?.artifact_materialized,
      attempted: (level === 'deep' && Boolean(deep.image_events?.length))
        || cliImageProbe !== null,
      cliTransportAccepted: cliImageProbe?.tool_accepted,
      fixture,
      blockers: [...deepEvidenceBlockers, ...(cliImageProbe?.blockers || [])]
    },
    computerUse: {
      events: deep.computer_events || [],
      localExecutorCompleted: deep.computer_executor_completed,
      outputSubmitted: deep.computer_output_submitted,
      followUpCompleted: deep.computer_follow_up_completed,
      sessionAffinityPreserved: deep.computer_session_affinity_preserved,
      attempted: level === 'deep' && Boolean(deep.computer_events?.length),
      fixture,
      blockers: deepEvidenceBlockers
    },
    browserUse: {
      configured: true,
      attempted: level === 'deep',
      verified: level === 'deep' && deep.browser_use_verified === true,
      fixture,
      source: level === 'deep' && deep.browser_use_verified === true ? 'deep_probe' : 'config',
      blockers: deepEvidenceBlockers,
      evidence: {
        independent_from_auth_mode: true,
        independent_from_computer_use: true,
        live_regression_verified: deep.browser_use_verified === true
      }
    },
    voiceMode: {
      createRouteVerified: deep.voice_create_verified,
      locationReceived: deep.voice_location_received,
      locationRewritten: deep.voice_location_rewritten,
      websocketUpgraded: deep.voice_websocket_upgraded,
      serverEventSeen: deep.voice_server_event_seen,
      cleanClose: deep.voice_clean_close,
      ownerBindingVerified: deep.voice_owner_binding_verified,
      attempted: level === 'deep' && (
        deep.voice_create_verified !== undefined
        || deep.voice_websocket_upgraded !== undefined
      ),
      fixture,
      blockers: deepEvidenceBlockers
    },
    plugins: {
      configured: true,
      attempted: level === 'deep',
      verified: level === 'deep' && deep.plugins_verified === true,
      fixture,
      source: level === 'deep' && deep.plugins_verified === true ? 'deep_probe' : 'config',
      blockers: deepEvidenceBlockers,
      evidence: {
        independent_from_auth_mode: true,
        discovery_verified: deep.plugins_verified === true
      }
    },
    auxiliarySurfaces: {
      inputEvents: deep.auxiliary_events || [],
      outputEvents: deep.auxiliary_output_events || deep.auxiliary_events || [],
      requestBodyHashPreserved: deep.auxiliary_request_body_hash_preserved,
      sessionAffinityPreserved: deep.auxiliary_owner_affinity_verified,
      attempted: level === 'deep' && Boolean(
        deep.auxiliary_routes_observed?.length || deep.auxiliary_events?.length
      ),
      fixture,
      blockers: deepEvidenceBlockers
    },
    deepEvidenceValidation
  });
}

export async function migrateLegacyCodexLbDesktopMode(
  input: CodexLbDesktopControllerOptions = {}
): Promise<Record<string, unknown>> {
  const context = await loadDesktopContext(input);
  if (!context.loadedEnv.base_url) {
    return {
      schema: 'sks.codex-lb-legacy-migration-command.v2',
      ok: false,
      status: 'missing_remote_base_url',
      blockers: ['codex_lb_missing:CODEX_LB_BASE_URL']
    };
  }
  const targetMode = input.mode === 'desktop-dual-auth-compat'
    ? 'desktop-dual-auth-compat' as const
    : 'desktop-native-bridge' as const;
  const settings = await resolveDesktopBridgeActivationSettings({
    ...input,
    home: context.home,
    settings: {
      ...(input.settings || {}),
      gateway_auth_transport: input.gatewayAuthTransport || context.gatewayAuthTransport
    }
  });
  const bridgeBaseUrl = `http://${settings.listen_host === '::1' ? '[::1]' : settings.listen_host}:${settings.listen_port}/backend-api/codex`;
  const servicePaths = desktopBridgeServicePaths(context.home);
  const result = await migrateLegacyCodexLbDesktop({
    home: context.home,
    configPath: context.configPath,
    authPath: context.authPath,
    ...(input.receiptDir ? { receiptDir: input.receiptDir } : {}),
    bridgeBaseUrl,
    bridgeStatePath: servicePaths.state_path,
    bridgeSettingsPath: servicePaths.settings_path,
    bridgeLaunchAgentPath: servicePaths.launch_agent_path,
    remoteBaseUrl: context.loadedEnv.base_url,
    targetMode,
    ...(context.loadedEnv.secret_api_key
      ? { gatewayApiKey: context.loadedEnv.secret_api_key }
      : {}),
    gatewayAuthTransport: targetMode === 'desktop-dual-auth-compat'
      ? 'x-codex-lb-api-key'
      : settings.gateway_auth_transport,
    quitApp: async () => {
      const quit = await (input.quitAppImpl || quitCodexApp)({
        enabled: true,
        ...(input.platform ? { platform: input.platform } : {}),
        ...(input.env ? { env: input.env } : {})
      });
      return { ...quit };
    },
    startBridge: async () => {
      const status = await (input.installBridgeImpl || installAndStartDesktopBridgeService)({
        ...input,
        home: context.home,
        settings
      });
      return { ...status };
    },
    stopBridge: async () => {
      const status = await (input.stopBridgeImpl || stopDesktopBridgeService)({
        ...input,
        home: context.home,
        removePlist: true,
        removeSettings: true
      });
      return { ...status };
    },
    ...(input.restartApp === true
      ? {
          restartApp: async () => {
            const restart = await (input.restartAppImpl || restartCodexApp)({
              enabled: true,
              ...(input.platform ? { platform: input.platform } : {}),
              ...(input.env ? { env: input.env } : {})
            });
            return {
              ok: restart.ok,
              status: restart.status,
              blockers: restart.blockers,
              ...(restart.reason ? { reason: restart.reason } : {})
            };
          }
        }
      : {}),
    verifyCapabilities: async () => {
      const report = await buildCodexLbDesktopCapabilities({
        ...input,
        home: context.home,
        configPath: context.configPath,
        authPath: context.authPath,
        level: targetMode === 'desktop-dual-auth-compat' ? 'shallow' : 'transport',
        networkProbes: targetMode === 'desktop-native-bridge',
        deepEvidence: null
      });
      if (targetMode === 'desktop-dual-auth-compat') {
        const provider = providerStatus(
          await readText(context.configPath, ''),
          'desktop-dual-auth-compat'
        );
        const ok = provider.contract_ok && provider.selected;
        return {
          ok,
          summary: {
            desktop_mode: 'desktop-dual-auth-compat',
            provider_contract: provider.contract_ok ? 'ok' : 'failed',
            gateway_auth_transport: 'x-codex-lb-api-key'
          },
          blockers: ok ? [] : ['desktop_compat_provider_contract_failed']
        };
      }
      const ok = report.bridge.state === 'verified';
      const adoption = desktopAdoptionEvidence(
        report.deep_evidence_validation.evidence as CodexLbDesktopDeepEvidence | null
      );
      return {
        ok,
        summary: {
          bridge_http: report.bridge.evidence.http_round_trip === true ? 'verified' : 'unverified',
          bridge_websocket: report.bridge.evidence.websocket_round_trip === true ? 'verified' : 'unverified',
          desktop_adoption: adoption.ok ? 'verified' : 'unverified',
          gateway_auth_transport: settings.gateway_auth_transport
        },
        blockers: uniqueStrings([
          ...(report.bridge.state === 'verified' ? [] : report.bridge.blockers)
        ])
      };
    }
  });
  return {
    ...result,
    schema: 'sks.codex-lb-legacy-migration-command.v2'
  };
}

export async function rollbackCodexLbDesktopMode(
  receiptId: string,
  input: CodexLbDesktopControllerOptions = {}
): Promise<Record<string, unknown>> {
  const safeId = String(receiptId || '').trim();
  if (!/^[A-Za-z0-9_-]+$/.test(safeId)) {
    return {
      schema: 'sks.codex-lb-desktop-rollback-command.v2',
      ok: false,
      status: 'invalid_receipt_id',
      receipt_id: null,
      blockers: ['invalid_receipt_id']
    };
  }
  const home = input.home || input.env?.HOME || process.env.HOME || os.homedir();
  const receiptDir = input.receiptDir || codexLbMigrationReceiptDir(home);
  const receiptPath = path.join(receiptDir, `${safeId}.json`);
  const preflight = await preflightDesktopRollbackReceipt(receiptPath);
  if (!preflight.ok) {
    return {
      ...preflight,
      schema: 'sks.codex-lb-desktop-rollback-command.v2',
      bridge: null,
      blockers: uniqueStrings([
        ...preflight.conflicts.map((entry) => entry.reason),
        ...(preflight.status === 'invalid_receipt'
          ? [preflight.error || 'invalid_receipt']
          : [])
      ])
    };
  }
  await (input.stopBridgeImpl || stopDesktopBridgeService)({
    ...input,
    home,
    removePlist: false,
    removeSettings: false
  }).catch(() => undefined);
  const rollback = await rollbackCodexLbMigrationReceipt({ receiptPath });
  let bridge: DesktopBridgeServiceStatus | null = null;
  if (rollback.ok) {
    const configPath = input.configPath || codexLbConfigPath(home);
    const restoredConfig = await readText(configPath, '');
    if (inferCodexLbDesktopModeFromConfig(restoredConfig) === 'desktop-native-bridge') {
      bridge = await (input.bootstrapBridgeImpl || bootstrapExistingDesktopBridgeService)({
        ...input,
        home
      });
    }
  }
  return {
    ...rollback,
    schema: 'sks.codex-lb-desktop-rollback-command.v2',
    bridge,
    blockers: rollback.ok ? (bridge && !bridge.ok ? bridge.blockers : []) : rollback.conflicts.map((entry) => entry.reason)
  };
}

export async function readCodexLbDesktopDeepEvidence(
  file: string
): Promise<unknown> {
  const resolved = path.resolve(file);
  const value = await readJson<unknown>(resolved);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('codex_lb_deep_evidence_invalid');
  }
  return value;
}

export async function readCodexLbDesktopDeepEvidenceTrustAnchors(
  file: string
): Promise<CodexLbDeepEvidenceTrustAnchor[]> {
  const resolved = path.resolve(file);
  const value = await readJson<unknown>(resolved);
  const parsed = parseCodexLbDeepEvidenceTrustAnchorSet(value);
  if (!parsed.ok) {
    throw new Error(parsed.blockers[0] || 'codex_lb_deep_evidence_trust_anchor_set_invalid');
  }
  return parsed.anchors;
}

type DesktopContext = {
  home: string;
  configPath: string;
  authPath: string;
  config: string;
  mode: CodexLbDesktopMode;
  modeBlockers: string[];
  auth: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>;
  oauthPresent: boolean;
  loadedEnv: Awaited<ReturnType<typeof loadCodexLbEnv>>;
  bridge: DesktopBridgeServiceStatus;
  gatewayAuthTransport: CodexLbGatewayAuthTransport;
};

async function loadDesktopContext(
  options: CodexLbDesktopControllerOptions
): Promise<DesktopContext> {
  const home = options.home || options.env?.HOME || process.env.HOME || os.homedir();
  const configPath = options.configPath || codexLbConfigPath(home);
  const authPath = options.authPath || codexAuthPath(home);
  const config = await readText(configPath, '');
  const mode = inferCodexLbDesktopModeFromConfig(config);
  const auth = await captureCodexAuthSnapshot({ home, authPath });
  const loadedEnv = await loadCodexLbEnv({
    home,
    envPath: options.envPath || codexLbEnvPath(home),
    metadataPath: options.metadataPath || codexLbMetadataPath(home),
    ...(options.env ? { processEnv: options.env } : {})
  });
  const bridge = await (options.bridgeStatusImpl || desktopBridgeServiceStatus)({
    ...options,
    home
  });
  const legacy = await detectLegacyCodexLbDesktopState({
    home,
    configPath,
    authPath,
    ...(options.receiptDir ? { receiptDir: options.receiptDir } : {}),
    ...(loadedEnv.base_url ? { remoteBaseUrl: loadedEnv.base_url } : {}),
    ...(loadedEnv.secret_api_key ? { expectedGatewayApiKey: loadedEnv.secret_api_key } : {})
  });
  const metadata = await readJson<Record<string, unknown>>(
    options.metadataPath || codexLbMetadataPath(home),
    {}
  );
  const rawTransport = options.gatewayAuthTransport
    || bridge.state?.gateway_auth_transport
    || bridge.settings?.gateway_auth_transport
    || metadata.gateway_auth_transport
    || DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT;
  let gatewayAuthTransport: CodexLbGatewayAuthTransport;
  const modeBlockers: string[] = [];
  try {
    gatewayAuthTransport = parseCodexLbGatewayAuthTransport(rawTransport);
  } catch {
    gatewayAuthTransport = DEFAULT_CODEX_LB_GATEWAY_AUTH_TRANSPORT;
    modeBlockers.push('codex_lb_gateway_auth_transport_invalid');
  }
  if (
    topLevelTomlString(config, 'model_provider') === 'codex-lb'
    && !hasTopLevelLine(config, CODEX_LB_DESKTOP_COMPAT_MARKER)
  ) {
    modeBlockers.push('legacy_codex_lb_desktop_config_requires_migration');
  }
  if (legacy.legacy_destructive_mode) {
    modeBlockers.push('legacy_codex_lb_desktop_config_requires_migration');
  }
  return {
    home,
    configPath,
    authPath,
    config,
    mode,
    modeBlockers,
    auth,
    oauthPresent: auth.mode === 'chatgpt_oauth' || auth.mode === 'mixed',
    loadedEnv,
    bridge,
    gatewayAuthTransport
  };
}

function providerStatus(config: string, mode: CodexLbDesktopMode): {
  id: string;
  built_in: boolean;
  contract: 'builtin-openai' | 'codex-lb-cli' | 'codex-lb-compat' | 'missing';
  contract_ok: boolean;
  selected: boolean;
} {
  const selected = topLevelTomlString(config, 'model_provider');
  const provider = tomlTable(config, 'model_providers.codex-lb');
  if (mode === 'desktop-dual-auth-compat') {
    const contractOk = Boolean(provider)
      && hasTomlString(provider, 'name', 'OpenAI')
      && hasTomlString(provider, 'wire_api', 'responses')
      && hasTomlBoolean(provider, 'requires_openai_auth', true)
      && hasTomlBoolean(provider, 'supports_websockets', true)
      && /"X-Codex-LB-API-Key"\s*=\s*"CODEX_LB_API_KEY"/.test(provider)
      && !/(?:^|\n)\s*env_key\s*=/.test(provider);
    return {
      id: 'codex-lb',
      built_in: false,
      contract: 'codex-lb-compat',
      contract_ok: contractOk,
      selected: selected === 'codex-lb'
    };
  }
  const cliContractOk = Boolean(provider)
    && hasTomlString(provider, 'name', 'codex-lb')
    && hasTomlString(provider, 'wire_api', 'responses')
    && hasTomlString(provider, 'env_key', 'CODEX_LB_API_KEY')
    && hasTomlBoolean(provider, 'requires_openai_auth', false)
    && hasTomlBoolean(provider, 'supports_websockets', true);
  if (mode === 'cli-provider') {
    return {
      id: 'openai',
      built_in: true,
      contract: provider ? 'codex-lb-cli' : 'missing',
      contract_ok: cliContractOk,
      selected: selected !== 'codex-lb'
    };
  }
  return {
    id: 'openai',
    built_in: true,
    contract: 'builtin-openai',
    contract_ok: mode === 'disabled' ? true : cliContractOk,
    selected: selected !== 'codex-lb'
  };
}

type GatewayFetchResult = {
  ok: boolean;
  httpStatus: number | null;
  payload: unknown;
  blocker: string | null;
};

async function probeLoopbackWebSocketTransport(
  baseUrl: string,
  timeoutMs: number
): Promise<DesktopWebSocketProbeResult> {
  let target: URL;
  try {
    target = new URL(`${String(baseUrl).replace(/\/+$/, '')}/realtime/capability-probe`);
  } catch {
    return { ok: false, blocker: 'desktop_bridge_websocket_url_invalid', status_code: null };
  }
  if (
    target.protocol !== 'http:'
    || (target.hostname !== '127.0.0.1' && target.hostname !== '::1')
  ) {
    return {
      ok: false,
      blocker: 'desktop_bridge_websocket_target_not_loopback',
      status_code: null
    };
  }
  const key = randomBytes(16).toString('base64');
  const expectedAccept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const port = Number(target.port || 80);
  const hostHeader = target.hostname === '::1'
    ? `[::1]:${port}`
    : `${target.hostname}:${port}`;
  return new Promise((resolve) => {
    const socket = net.connect({ host: target.hostname, port });
    let settled = false;
    let responseHead = Buffer.alloc(0);
    const settle = (result: DesktopWebSocketProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => settle({
      ok: false,
      blocker: 'desktop_bridge_websocket_timeout',
      status_code: null
    }), Math.max(250, timeoutMs));
    timer.unref();
    socket.once('connect', () => {
      socket.write([
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Protocol: codex.realtime.v1',
        'Origin: app://codex',
        '',
        ''
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => {
      responseHead = Buffer.concat([responseHead, chunk]);
      if (responseHead.length > 64 * 1024) {
        settle({
          ok: false,
          blocker: 'desktop_bridge_websocket_response_too_large',
          status_code: null
        });
        return;
      }
      const boundary = responseHead.indexOf('\r\n\r\n');
      if (boundary < 0) return;
      const head = responseHead.subarray(0, boundary).toString('latin1');
      const statusCode = Number(head.match(/^HTTP\/1\.[01]\s+(\d{3})/i)?.[1] || 0) || null;
      const accept = head.match(/\r\nSec-WebSocket-Accept:\s*([^\r\n]+)/i)?.[1]?.trim() || '';
      const upgraded = statusCode === 101
        && /\r\nUpgrade:\s*websocket\s*\r\n/i.test(`\r\n${head}\r\n`)
        && accept === expectedAccept;
      settle({
        ok: upgraded,
        blocker: upgraded ? null : 'desktop_bridge_websocket_upgrade_failed',
        status_code: statusCode
      });
    });
    socket.once('error', () => settle({
      ok: false,
      blocker: 'desktop_bridge_websocket_unavailable',
      status_code: null
    }));
    socket.once('close', () => {
      if (!settled) {
        settle({
          ok: false,
          blocker: 'desktop_bridge_websocket_closed_before_upgrade',
          status_code: null
        });
      }
    });
  });
}

async function fetchGatewayJson(
  url: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch | undefined,
  timeoutMs = 5_000
): Promise<GatewayFetchResult> {
  const request = fetchImpl || globalThis.fetch;
  if (typeof request !== 'function') {
    return { ok: false, httpStatus: null, payload: null, blocker: 'fetch_unavailable' };
  }
  try {
    const response = await request(url, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(Math.max(250, timeoutMs))
    });
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
      return {
        ok: false,
        httpStatus: response.status,
        payload: null,
        blocker: 'codex_lb_capability_payload_too_large'
      };
    }
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      return {
        ok: false,
        httpStatus: response.status,
        payload: null,
        blocker: 'codex_lb_capability_payload_invalid_json'
      };
    }
    return {
      ok: response.ok,
      httpStatus: response.status,
      payload,
      blocker: response.ok ? null : `codex_lb_capability_http_${response.status}`
    };
  } catch (error: unknown) {
    return {
      ok: false,
      httpStatus: null,
      payload: null,
      blocker: error instanceof Error && error.name === 'TimeoutError'
        ? 'codex_lb_capability_timeout'
        : 'codex_lb_capability_unavailable'
    };
  }
}

function desktopAdoptionEvidence(
  evidence: CodexLbDesktopDeepEvidence | null | undefined
): { ok: boolean; blockers: string[] } {
  const fixture = evidence?.fixture === true;
  const verified = evidence?.desktop_adoption_verified === true
    && evidence?.desktop_adoption_source === 'codex_desktop_runtime'
    && !fixture;
  return {
    ok: verified,
    blockers: verified
      ? []
      : [
          fixture
            ? 'desktop_adoption_fixture_not_accepted'
            : 'desktop_adoption_evidence_required'
        ]
  };
}

function blockedDeepEvidenceValidation(blocker: string): CodexLbDeepEvidenceValidation {
  return {
    schema: CODEX_LB_DEEP_EVIDENCE_VALIDATION_SCHEMA,
    state: 'blocked',
    trusted: false,
    evidence: null,
    producer_id: null,
    created_at: null,
    content_sha256: null,
    trust_anchor_id: null,
    blockers: [blocker],
    warnings: []
  };
}

async function preflightDesktopRollbackReceipt(
  receiptPath: string
): Promise<Awaited<ReturnType<typeof rollbackCodexLbMigrationReceipt>>> {
  let receipt: CodexLbMigrationReceipt;
  try {
    receipt = await readCodexLbMigrationReceipt(receiptPath);
  } catch (error: unknown) {
    return {
      schema: 'sks.codex-lb-migration-rollback.v1',
      ok: false,
      status: 'invalid_receipt',
      receipt_id: null,
      restored_files: [],
      conflicts: [],
      error: safeControllerError(error)
    };
  }
  const conflicts: Awaited<ReturnType<typeof rollbackCodexLbMigrationReceipt>>['conflicts'] = [];
  for (const file of receipt.files) {
    const currentSha = await fileSha256OrMissing(file.path).catch(() => '__unreadable__');
    if (currentSha !== file.after_sha256) {
      conflicts.push({
        path: file.path,
        expected_after_sha256: file.after_sha256,
        current_sha256: currentSha === '__unreadable__' ? null : currentSha,
        reason: 'current_file_changed_after_migration'
      });
      continue;
    }
    if (file.before_sha256 === null) continue;
    if (!file.backup_path) {
      conflicts.push({
        path: file.path,
        expected_after_sha256: file.after_sha256,
        current_sha256: currentSha,
        reason: 'before_backup_missing'
      });
      continue;
    }
    let backupBytes: Buffer;
    try {
      backupBytes = await fsp.readFile(file.backup_path);
    } catch {
      conflicts.push({
        path: file.path,
        expected_after_sha256: file.after_sha256,
        current_sha256: currentSha,
        reason: 'before_backup_missing'
      });
      continue;
    }
    if (createHash('sha256').update(backupBytes).digest('hex') !== file.before_sha256) {
      conflicts.push({
        path: file.path,
        expected_after_sha256: file.after_sha256,
        current_sha256: currentSha,
        reason: 'before_backup_hash_mismatch'
      });
    }
  }
  return conflicts.length
    ? {
        schema: 'sks.codex-lb-migration-rollback.v1',
        ok: false,
        status: 'rollback_conflict',
        receipt_id: receipt.id,
        restored_files: [],
        conflicts
      }
    : {
        schema: 'sks.codex-lb-migration-rollback.v1',
        ok: true,
        status: 'rolled_back',
        receipt_id: receipt.id,
        restored_files: [],
        conflicts: []
      };
}

function capabilityTarget(context: DesktopContext): {
  baseUrl: string;
  headers: Record<string, string>;
  transport: CodexLbGatewayAuthTransport;
  effectiveTransport: CodexLbGatewayAuthTransport | 'authorization-bearer';
} | null {
  if (!context.loadedEnv.base_url || !context.loadedEnv.secret_api_key) return null;
  if (context.mode === 'desktop-native-bridge' && context.bridge.state?.codex_base_url) {
    return {
      baseUrl: context.bridge.state.codex_base_url.replace(/\/+$/, ''),
      headers: {},
      transport: context.gatewayAuthTransport,
      effectiveTransport: context.gatewayAuthTransport
    };
  }
  // cli-provider plane: the Codex CLI authenticates on the codex-lb provider
  // contract with env_key, which the CLI sends as Authorization: Bearer. Probes
  // that verify the CLI plane must authenticate exactly like the CLI does;
  // the configured desktop-plane gateway transport does not apply here.
  const effectiveTransport = context.mode === 'cli-provider'
    ? 'authorization-bearer' as const
    : context.gatewayAuthTransport;
  const headers = effectiveTransport === 'x-codex-lb-api-key'
    ? { 'X-Codex-LB-API-Key': context.loadedEnv.secret_api_key }
    : { Authorization: `Bearer ${context.loadedEnv.secret_api_key}` };
  return {
    baseUrl: normalizeCodexLbBaseUrl(context.loadedEnv.base_url).replace(/\/+$/, ''),
    headers,
    transport: context.gatewayAuthTransport,
    effectiveTransport
  };
}

type DesktopTransaction = {
  id: string;
  receiptDir: string;
  backups: CodexLbMigrationFileBackup[];
};

async function beginDesktopTransaction(
  context: DesktopContext,
  receiptDirOverride?: string
): Promise<DesktopTransaction> {
  const id = createCodexLbMigrationReceiptId();
  const receiptDir = receiptDirOverride || codexLbMigrationReceiptDir(context.home);
  const backupDir = path.join(receiptDir, id, 'files');
  const servicePaths = desktopBridgeServicePaths(context.home);
  const targets = [
    { path: context.configPath, owned: false },
    { path: servicePaths.settings_path, owned: true },
    { path: servicePaths.launch_agent_path, owned: true },
    { path: servicePaths.state_path, owned: true }
  ];
  const backups: CodexLbMigrationFileBackup[] = [];
  for (const target of targets) {
    backups.push(await backupCodexLbMigrationFile(target.path, backupDir, target.owned));
  }
  return { id, receiptDir, backups };
}

async function finishDesktopTransaction(
  transaction: DesktopTransaction,
  input: {
    fromMode: string;
    toMode: string;
    oauthPreserved: boolean;
    capabilitySummary: Record<string, string>;
  }
): Promise<{ receipt: CodexLbMigrationReceipt; path: string }> {
  const receipt: CodexLbMigrationReceipt = {
    schema: 'sks.codex-lb-migration-receipt.v1',
    id: transaction.id,
    created_at: new Date().toISOString(),
    from_mode: input.fromMode,
    to_mode: input.toMode,
    files: await finalizeCodexLbMigrationReceiptFiles(transaction.backups),
    bridge_state_path: transaction.backups.find((entry) => entry.path.endsWith('codex-lb-desktop-bridge.json'))?.path || null,
    oauth_preserved: input.oauthPreserved,
    capability_summary: input.capabilitySummary
  };
  const receiptPath = await writeCodexLbMigrationReceipt(receipt, { receiptDir: transaction.receiptDir });
  return { receipt, path: receiptPath };
}

async function rollbackDesktopTransaction(
  transaction: DesktopTransaction,
  options: CodexLbDesktopControllerOptions & {
    home: string;
    restartPreviousBridge: boolean;
    restartAppAfterRollback: boolean;
    authBefore: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>;
  }
): Promise<Awaited<ReturnType<typeof rollbackCodexLbMigrationReceipt>> & {
  bridge_restart?: DesktopBridgeServiceStatus;
  app_restart?: Awaited<ReturnType<typeof restartCodexApp>>;
}> {
  const receipt: CodexLbMigrationReceipt = {
    schema: 'sks.codex-lb-migration-receipt.v1',
    id: transaction.id,
    created_at: new Date().toISOString(),
    from_mode: 'activation-attempt',
    to_mode: 'rolled-back',
    files: await finalizeCodexLbMigrationReceiptFiles(transaction.backups),
    bridge_state_path: null,
    oauth_preserved: true,
    capability_summary: {}
  };
  const rollback = await rollbackCodexLbMigrationReceipt({ receipt });
  if (!rollback.ok) return rollback;
  const bridgeRestart = options.restartPreviousBridge
    ? await (options.bootstrapBridgeImpl || bootstrapExistingDesktopBridgeService)(options)
    : undefined;
  const appRestart = options.restartAppAfterRollback
    ? await performOptionalRestart({
        ...options,
        restartApp: true
      }, options.authBefore).catch((error: unknown) => ({
        schema: 'sks.codex-app-restart.v1' as const,
        ok: false,
        status: 'failed' as const,
        skipped: false,
        app_name: 'Codex',
        blockers: [safeControllerError(error)]
      }))
    : undefined;
  return {
    ...rollback,
    ...(bridgeRestart ? { bridge_restart: bridgeRestart } : {}),
    ...(appRestart ? { app_restart: appRestart } : {})
  };
}

async function performOptionalRestart(
  input: CodexLbDesktopControllerOptions,
  authBefore: Awaited<ReturnType<typeof captureCodexAuthSnapshot>>
): Promise<Awaited<ReturnType<typeof restartCodexApp>>> {
  if (input.restartApp !== true) {
    return {
      schema: 'sks.codex-app-restart.v1',
      ok: true,
      status: 'skipped',
      skipped: true,
      reason: 'not_requested',
      app_name: 'ChatGPT',
      blockers: []
    };
  }
  const restart = await (input.restartAppImpl || restartCodexApp)({ enabled: true });
  if (restart.ok) {
    const after = await captureCodexAuthSnapshot({
      ...(input.home ? { home: input.home } : {}),
      ...(input.authPath ? { authPath: input.authPath } : {})
    });
    assertDesktopOAuthSemanticIdentity(authBefore, after);
  }
  return restart;
}

function capabilityEvidenceToSignal(evidence: CapabilityEvidence): CapabilitySignal {
  return {
    configured: evidence.state !== 'skipped',
    attempted: evidence.source === 'transport' || evidence.source === 'deep_probe',
    verified: evidence.state === 'verified',
    source: evidence.source,
    blockers: evidence.blockers,
    warnings: evidence.warnings,
    evidence: evidence.evidence
  };
}

function topLevelTomlString(text: string, key: string): string {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.match(new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"([^"]+)"\\s*(?:#.*)?(?=\\n|$)`))?.[1] || '';
}

function tomlTable(text: string, table: string): string {
  return String(text || '').match(
    new RegExp(`(?:^|\\n)\\[${escapeRegExp(table)}\\]([\\s\\S]*?)(?=\\n\\[[^\\]]+\\]|\\s*$)`)
  )?.[1] || '';
}

function hasTomlString(text: string, key: string, value: string): boolean {
  return new RegExp(
    `(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*"${escapeRegExp(value)}"\\s*(?:#.*)?(?=\\n|$)`
  ).test(text);
}

function hasTomlBoolean(text: string, key: string, value: boolean): boolean {
  return new RegExp(
    `(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=\\s*${value ? 'true' : 'false'}\\s*(?:#.*)?(?=\\n|$)`
  ).test(text);
}

function hasTopLevelLine(text: string, line: string): boolean {
  const topLevel = String(text || '').split(/\n\s*\[/)[0] || '';
  return topLevel.split(/\r?\n/).some((entry) => entry.trim() === line);
}

function isLoopbackCodexBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && (url.hostname === '127.0.0.1' || url.hostname === '::1')
      && url.pathname.replace(/\/+$/, '') === '/backend-api/codex';
  } catch {
    return false;
  }
}

function redactRemoteOrigin(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//<redacted>${url.pathname}`;
  } catch {
    return null;
  }
}

function statusGuidance(
  mode: CodexLbDesktopMode,
  configured: boolean,
  blockers: string[]
): string[] {
  if (!configured) {
    return [
      'Run: sks codex-lb setup --host <domain> --api-key-stdin --yes --desktop-mode cli-provider',
      'Then choose Desktop routing explicitly with: sks codex-lb use-desktop-full'
    ];
  }
  if (blockers.includes('legacy_codex_lb_desktop_config_requires_migration')) {
    return ['Run: sks codex-lb migrate-legacy-desktop --restart-app'];
  }
  const rejectedTransport = blockers
    .find((blocker) => blocker.startsWith('codex_lb_gateway_auth_rejected_for_transport:'))
    ?.split(':')[1];
  if (rejectedTransport) {
    return [
      `The gateway rejected the configured auth transport (${rejectedTransport}).`,
      rejectedTransport === 'x-codex-lb-api-key'
        ? 'If the gateway expects an Authorization header, re-run setup with: --gateway-auth bearer-compat'
        : 'If the gateway expects the custom header, re-run setup with: --gateway-auth custom-header'
    ];
  }
  if (mode === 'desktop-native-bridge') {
    return ['Run: sks codex-lb capabilities --level transport'];
  }
  if (mode === 'desktop-dual-auth-compat') {
    return [
      'Compatibility mode is explicit and does not prove full Desktop capability.',
      'Run: sks codex-lb capabilities --level transport'
    ];
  }
  return [
    'Desktop remains on built-in OpenAI/ChatGPT OAuth.',
    'Enable routing explicitly with: sks codex-lb use-desktop-full'
  ];
}

function safeControllerError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:-]+$/i.test(message) ? message : 'codex_lb_desktop_controller_failed';
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
